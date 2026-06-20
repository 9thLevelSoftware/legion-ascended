import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  artifactPathSchema,
  artifactReferenceSchema,
  artifactRevisionSchema,
  contentHashSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ArtifactRole,
  type ContentHash,
  type GitSha
} from "@legion/protocol";

import {
  diagnosticForPath,
  resolveProjectArtifactPath,
  type ArtifactDiagnostic
} from "./paths.js";

export type ArtifactContent = string | Uint8Array;

export interface ProtocolSchema<T> {
  safeParse(input: unknown): { readonly success: true; readonly data: T } | {
    readonly success: false;
    readonly error: {
      readonly issues?: readonly {
        readonly path?: readonly PropertyKey[];
        readonly message: string;
      }[];
    };
  };
}

export interface ReadJsonArtifactInput<T> {
  readonly repositoryRoot: string;
  readonly artifactPath: unknown;
  readonly schema: ProtocolSchema<T>;
}

export interface ReadJsonArtifactSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly reference: ArtifactReference;
  readonly bytes: Uint8Array;
}

export interface ReadJsonArtifactFailure {
  readonly ok: false;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type ReadJsonArtifactResult<T> = ReadJsonArtifactSuccess<T> | ReadJsonArtifactFailure;

export interface ArtifactReferenceForContentInput {
  readonly path: ArtifactPath;
  readonly content: ArtifactContent;
  readonly mediaType?: string;
}

export interface ArtifactRevisionForContentInput extends ArtifactReferenceForContentInput {
  readonly role: ArtifactRole;
  readonly revision: number;
  readonly baseGitSha?: GitSha;
  readonly supersedes?: ArtifactReference;
}

export function contentBytes(content: ArtifactContent): Uint8Array {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortStable(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    sorted[key] = sortStable(entryValue);
  }
  return sorted;
}

export function stableProtocolJson(value: unknown): string {
  const serialized = JSON.stringify(sortStable(value));
  if (serialized === undefined) {
    throw new TypeError("stableProtocolJson requires a JSON-serializable value.");
  }
  return `${serialized}\n`;
}

export function hashContent(content: ArtifactContent): ContentHash {
  const hash = createHash("sha256").update(contentBytes(content)).digest("hex");
  return contentHashSchema.parse(`sha256:${hash}`);
}

export function mediaTypeForArtifactPath(path: ArtifactPath): string | undefined {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  return undefined;
}

export function artifactReferenceForContent(input: ArtifactReferenceForContentInput): ArtifactReference {
  const mediaType = input.mediaType ?? mediaTypeForArtifactPath(input.path);
  return artifactReferenceSchema.parse({
    path: input.path,
    sha256: hashContent(input.content),
    ...(mediaType === undefined ? {} : { mediaType })
  });
}

export function artifactRevisionForContent(input: ArtifactRevisionForContentInput): ArtifactRevision {
  if (!Number.isInteger(input.revision) || input.revision <= 0) {
    throw new RangeError("artifact revision must be a positive integer");
  }

  return artifactRevisionSchema.parse({
    role: input.role,
    artifact: artifactReferenceForContent(input),
    revision: input.revision,
    ...(input.baseGitSha === undefined ? {} : { baseGitSha: input.baseGitSha }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
  });
}

function offsetLocation(text: string, offset: number): { readonly line: number; readonly column: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1
  };
}

function jsonParseLocation(error: unknown, text: string): { readonly line?: number; readonly column?: number } {
  if (!(error instanceof SyntaxError)) return {};
  const match = /position\s+(\d+)/i.exec(error.message);
  if (!match?.[1]) return {};
  const offset = Number.parseInt(match[1], 10);
  if (!Number.isInteger(offset) || offset < 0) return {};
  return offsetLocation(text, offset);
}

function schemaDiagnostics(path: ArtifactPath, issues: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[] | undefined): readonly ArtifactDiagnostic[] {
  if (!issues || issues.length === 0) {
    return [diagnosticForPath({ code: "invalid_schema", message: "Artifact failed protocol schema validation.", path })];
  }

  return issues.map((issue) => {
    const suffix = issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return diagnosticForPath({
      code: "invalid_schema",
      message: `${issue.message}${suffix}`,
      path
    });
  });
}

export async function readJsonArtifact<T>(input: ReadJsonArtifactInput<T>): Promise<ReadJsonArtifactResult<T>> {
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath
    });
  } catch (error) {
    const fallbackPath = artifactPathSchema.parse(".legion/project/invalid-path");
    return {
      ok: false,
      diagnostics: [
        diagnosticForPath({
          code: "invalid_path",
          message: error instanceof Error ? error.message : String(error),
          path: fallbackPath
        })
      ]
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolved.absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        ok: false,
        diagnostics: [diagnosticForPath({ code: "not_found", message: "Artifact file does not exist.", path: resolved.repositoryPath })]
      };
    }
    throw error;
  }

  const text = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnosticForPath({
          code: "invalid_json",
          message: error instanceof Error ? error.message : "Artifact JSON could not be parsed.",
          path: resolved.repositoryPath,
          ...jsonParseLocation(error, text)
        })
      ]
    };
  }

  const validation = input.schema.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      diagnostics: schemaDiagnostics(resolved.repositoryPath, validation.error.issues)
    };
  }

  return {
    ok: true,
    value: validation.data,
    reference: artifactReferenceForContent({
      path: resolved.repositoryPath,
      content: bytes,
      mediaType: "application/json"
    }),
    bytes
  };
}
