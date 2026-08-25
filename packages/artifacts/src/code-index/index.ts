import { readFile } from "node:fs/promises";

import {
  artifactPathSchema,
  type ArtifactPath,
  type ArtifactReference,
  codeIndexSnapshotSchema,
  type CodeIndexSnapshot
} from "@legion/protocol";

import {
  diagnosticForPath,
  resolveProjectArtifactPath,
  type ArtifactDiagnostic
} from "../paths.js";
import {
  artifactReferenceForContent,
  hashContent,
  readJsonArtifact
} from "../revisions.js";

const INVALID_CODE_INDEX_PATH = ".legion/project/code-index/invalid-path" as ArtifactPath;

export interface ReadCodeIndexSnapshotInput {
  readonly repositoryRoot: string;
  readonly artifactPath: string;
}

export interface CodeIndexSnapshotReadSuccess {
  readonly ok: true;
  readonly snapshot: CodeIndexSnapshot;
  readonly reference: ArtifactReference;
  readonly diagnostics: readonly [];
}

export interface CodeIndexSnapshotReadFailure {
  readonly ok: false;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type CodeIndexSnapshotReadResult = CodeIndexSnapshotReadSuccess | CodeIndexSnapshotReadFailure;

export interface VerifyCodeIndexSqliteInput {
  readonly repositoryRoot: string;
  readonly snapshot: CodeIndexSnapshot;
}

export interface CodeIndexSqliteVerificationSuccess {
  readonly ok: true;
  readonly reference: ArtifactReference;
  readonly diagnostics: readonly [];
}

export interface CodeIndexSqliteVerificationFailure {
  readonly ok: false;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type CodeIndexSqliteVerificationResult =
  | CodeIndexSqliteVerificationSuccess
  | CodeIndexSqliteVerificationFailure;

function diagnosticPath(input: unknown): ArtifactPath {
  const parsed = artifactPathSchema.safeParse(input);
  return parsed.success ? parsed.data : INVALID_CODE_INDEX_PATH;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function filesystemDiagnostic(input: {
  readonly path: ArtifactPath;
  readonly error: unknown;
}): ArtifactDiagnostic {
  const code = errorCode(input.error) === "ENOENT" ? "not_found" : "unreadable";
  const message = code === "not_found" ? "Code index artifact does not exist." : `Code index artifact could not be read: ${errorMessage(input.error)}`;
  return diagnosticForPath({ code, message, path: input.path });
}

function invalidPathDiagnostic(input: unknown, error: unknown): ArtifactDiagnostic {
  return diagnosticForPath({
    code: "invalid_path",
    message: errorMessage(error),
    path: diagnosticPath(input)
  });
}

export async function readCodeIndexSnapshot(
  input: ReadCodeIndexSnapshotInput
): Promise<CodeIndexSnapshotReadResult> {
  let result;
  try {
    result = await readJsonArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath,
      schema: codeIndexSnapshotSchema
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        filesystemDiagnostic({
          path: diagnosticPath(input.artifactPath),
          error
        })
      ]
    };
  }

  if (!result.ok) return result;

  return {
    ok: true,
    snapshot: result.value,
    reference: result.reference,
    diagnostics: []
  };
}

export async function verifyCodeIndexSqlite(
  input: VerifyCodeIndexSqliteInput
): Promise<CodeIndexSqliteVerificationResult> {
  const sqlitePath = input.snapshot?.sqlite?.path;
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: sqlitePath
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [invalidPathDiagnostic(sqlitePath, error)]
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolved.absolutePath);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [filesystemDiagnostic({ path: resolved.repositoryPath, error })]
    };
  }

  const actualSha256 = hashContent(bytes).slice("sha256:".length);
  if (actualSha256 !== input.snapshot.sqlite.sha256) {
    return {
      ok: false,
      diagnostics: [
        diagnosticForPath({
          code: "hash_mismatch",
          message: `SQLite materialization hash does not match the snapshot: expected ${input.snapshot.sqlite.sha256}, got ${actualSha256}.`,
          path: resolved.repositoryPath
        })
      ]
    };
  }

  return {
    ok: true,
    reference: artifactReferenceForContent({
      path: resolved.repositoryPath,
      content: bytes
    }),
    diagnostics: []
  };
}
