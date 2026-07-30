/**
 * Reading and writing a project's typed requirement set.
 *
 * Requirements are the first artifact in the chain that everything downstream
 * traces to, so this module's job is less about storage than about making the
 * set's identity checkable. `requirementSetHash` is computed over the ordered
 * requirement contents; every later command can recompute it and report drift
 * rather than discovering, three phases in, that the contract moved.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  contentHashSchema,
  requirementSchema,
  utcTimestampSchema,
  type ContentHash,
  type IntakeSessionId,
  type ProjectId,
  type Requirement,
  type UtcTimestamp
} from "@legion/protocol";

import { ArtifactPathError, PROJECT_ARTIFACT_PATHS, ensureProjectArtifactParent } from "../paths.js";
import {
  REQUIREMENT_SET_SCHEMA_VERSION,
  requirementSetSchema,
  type RequirementSet,
  type RequirementSetEntry
} from "./schema.js";

export const REQUIREMENT_SET_INDEX_FILE = "index.json";

export function requirementsRoot(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".legion", "project", "requirements");
}

export function requirementArtifactPath(requirementId: string): string {
  return `${PROJECT_ARTIFACT_PATHS.requirements}/${requirementId}.json`;
}

export function requirementSetIndexPath(): string {
  return `${PROJECT_ARTIFACT_PATHS.requirements}/${REQUIREMENT_SET_INDEX_FILE}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * Hash the ordered requirement set.
 *
 * Key order is canonicalized so that reserializing a requirement — which any
 * round-trip through a schema can do — is not mistaken for an edit. Array order
 * is preserved, because requirement order is a decision the interview recorded
 * and reordering the set really is a change.
 */
export function computeRequirementSetHash(requirements: readonly Requirement[]): ContentHash {
  const digest = createHash("sha256");
  digest.update(canonicalJson(requirements.map((requirement) => requirementSchema.parse(requirement))));
  return contentHashSchema.parse(`sha256:${digest.digest("hex")}`);
}

function hashBytes(bytes: string): ContentHash {
  return contentHashSchema.parse(`sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`);
}

/**
 * Write one artifact through the repository's own path guards.
 *
 * `ensureProjectArtifactParent` is what rejects a path that leaves the
 * repository, whether through a symlinked ancestor or a symlinked final
 * component. Joining a path by hand and writing to it skips all of that: a
 * symlinked `.legion/project/requirements` would send every predictably-named
 * `req_*.json` outside the repository, and the cleanup pass would then delete
 * unrelated files that happened to match the pattern.
 */
async function writeProjectArtifact(
  repositoryRoot: string,
  artifactPath: string,
  contents: string
): Promise<void> {
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath });
  const temporary = `${resolved.absolutePath}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, resolved.absolutePath);
}

/**
 * The requirements directory, refused unless it is a real directory inside the
 * repository.
 *
 * Checked before the cleanup pass as well as before writing, because deleting
 * through a symlink is the more damaging half.
 */
async function resolveRequirementsRoot(repositoryRoot: string): Promise<string> {
  const resolved = await ensureProjectArtifactParent({
    repositoryRoot,
    artifactPath: requirementSetIndexPath()
  });
  const root = path.dirname(resolved.absolutePath);
  const stats = await lstat(root);
  if (!stats.isDirectory()) {
    throw new ArtifactPathError(
      `${PROJECT_ARTIFACT_PATHS.requirements} is not a directory; refusing to write the requirement set through it.`
    );
  }
  return root;
}

export interface WriteRequirementSetInput {
  readonly repositoryRoot: string;
  readonly projectId: ProjectId;
  readonly requirements: readonly Requirement[];
  readonly intakeSessionId?: IntakeSessionId;
  readonly graphVersion?: string;
  readonly createdAt?: UtcTimestamp;
}

export interface WriteRequirementSetResult {
  readonly set: RequirementSet;
  readonly indexPath: string;
  readonly requirementPaths: readonly string[];
}

/**
 * Write the requirement set, replacing whatever was there.
 *
 * Requirement files removed from the set are deleted rather than left behind.
 * A stale `req_*.json` from a previous finalize would be picked up by anything
 * that globs the directory, and a requirement nobody agreed to is worse than a
 * missing one.
 */
export async function writeRequirementSet(
  input: WriteRequirementSetInput
): Promise<WriteRequirementSetResult> {
  const createdAt = input.createdAt ?? utcTimestampSchema.parse(new Date().toISOString());
  const root = await resolveRequirementsRoot(input.repositoryRoot);

  const entries: RequirementSetEntry[] = [];
  const written = new Set<string>();
  const requirementPaths: string[] = [];

  for (const requirement of input.requirements) {
    const parsed = requirementSchema.parse(requirement);
    const contents = `${JSON.stringify(parsed, undefined, 2)}\n`;
    const relative = requirementArtifactPath(parsed.id);
    await writeProjectArtifact(input.repositoryRoot, relative, contents);
    written.add(`${parsed.id}.json`);
    requirementPaths.push(relative);
    entries.push(
      requirementSetSchema.shape.entries.element.parse({
        requirementId: parsed.id,
        path: relative,
        sha256: hashBytes(contents)
      })
    );
  }

  const set = requirementSetSchema.parse({
    schemaVersion: REQUIREMENT_SET_SCHEMA_VERSION,
    kind: "requirement-set",
    createdAt,
    projectId: input.projectId,
    ...(input.intakeSessionId === undefined ? {} : { intakeSessionId: input.intakeSessionId }),
    ...(input.graphVersion === undefined ? {} : { graphVersion: input.graphVersion }),
    requirementSetHash: computeRequirementSetHash(input.requirements),
    entries
  });

  const indexRelative = requirementSetIndexPath();
  await writeProjectArtifact(
    input.repositoryRoot,
    indexRelative,
    `${JSON.stringify(set, undefined, 2)}\n`
  );

  for (const entry of await readdir(root, { withFileTypes: true })) {
    // `isFile` is false for a symlink, so a planted link is left alone rather
    // than followed and unlinked through.
    if (!entry.isFile()) continue;
    if (entry.name === REQUIREMENT_SET_INDEX_FILE) continue;
    if (written.has(entry.name)) continue;
    if (!entry.name.startsWith("req_") || !entry.name.endsWith(".json")) continue;
    await rm(path.join(root, entry.name), { force: true });
  }

  return { set, indexPath: indexRelative, requirementPaths };
}

export type ReadRequirementSetResult =
  | {
      readonly ok: true;
      readonly set: RequirementSet;
      readonly requirements: readonly Requirement[];
    }
  | { readonly ok: false; readonly status: "not_found" | "invalid"; readonly reason: string };

export async function readRequirementSet(
  repositoryRoot: string
): Promise<ReadRequirementSetResult> {
  const indexAbsolute = path.join(repositoryRoot, ...requirementSetIndexPath().split("/"));
  let raw: string;
  try {
    raw = await readFile(indexAbsolute, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { ok: false, status: "not_found", reason: "This project has no requirement set." };
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: "invalid", reason: `The requirement index is not valid JSON: ${message}` };
  }

  const parsed = requirementSetSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      status: "invalid",
      reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    };
  }

  const requirements: Requirement[] = [];
  for (const entry of parsed.data.entries) {
    const absolute = path.join(repositoryRoot, ...entry.path.split("/"));
    let contents: string;
    try {
      contents = await readFile(absolute, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return {
          ok: false,
          status: "invalid",
          reason: `The requirement index names ${entry.path}, which does not exist.`
        };
      }
      throw error;
    }

    // Unguarded, this threw instead of returning the advertised
    // `{ ok: false, status: "invalid" }`, so a malformed requirement rejected
    // out of `verifyRequirementSet` rather than being reported as drift — which
    // is precisely the condition drift detection exists to name.
    let parsedRequirement: unknown;
    try {
      parsedRequirement = JSON.parse(contents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: "invalid", reason: `${entry.path} is not valid JSON: ${message}` };
    }

    const requirement = requirementSchema.safeParse(parsedRequirement);
    if (!requirement.success) {
      return {
        ok: false,
        status: "invalid",
        reason: `${entry.path} is not a valid requirement: ${requirement.error.issues
          .map((issue) => issue.message)
          .join("; ")}`
      };
    }
    requirements.push(requirement.data);
  }

  return { ok: true, set: parsed.data, requirements };
}

export interface RequirementSetDrift {
  readonly code: "requirement_set_drift" | "requirement_content_drift";
  readonly message: string;
}

/**
 * Compare the recorded hash against the requirements actually on disk.
 *
 * Two independent checks, because they fail differently. A per-file hash
 * mismatch names the requirement that changed; the set hash catches reordering
 * and removal, which no per-file check can see.
 */
export async function verifyRequirementSet(
  repositoryRoot: string
): Promise<readonly RequirementSetDrift[]> {
  const read = await readRequirementSet(repositoryRoot);
  if (!read.ok) {
    if (read.status === "not_found") return [];
    return [{ code: "requirement_set_drift", message: read.reason }];
  }

  const drift: RequirementSetDrift[] = [];
  for (const entry of read.set.entries) {
    const absolute = path.join(repositoryRoot, ...entry.path.split("/"));
    const contents = await readFile(absolute, "utf8");
    if (hashBytes(contents) !== entry.sha256) {
      drift.push({
        code: "requirement_content_drift",
        message: `${entry.requirementId} has changed since the requirement set was written.`
      });
    }
  }

  const recomputed = computeRequirementSetHash(read.requirements);
  if (recomputed !== read.set.requirementSetHash) {
    drift.push({
      code: "requirement_set_drift",
      message:
        "The requirement set hash does not match the requirements on disk. Re-run legion start --finalize, or restore the set."
    });
  }

  return drift;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
