/**
 * Deterministic, content-addressed hash for a WorkerContext.
 *
 * Properties:
 *  - Same `TaskContract` + same `WorkerBundle` + same protocol version
 *    always yields the same `workerContextHash`.
 *  - Different revision, different references, different bundle, or
 *    different protocol version yields a different hash.
 *  - The hash does NOT include the `createdAt` timestamp — clock
 *    drift must not invalidate the context for replay.
 *  - The hash uses a stable key order so two implementations that
 *    serialize the same context differently still produce identical
 *    hashes.
 *
 * The string fed into SHA-256 is a canonical, sorted serialization:
 *
 *   v1|protocol=<protocolVersion>|
 *     contract=<id>@<revision>|
 *     wave=<wave>|
 *     agent=<agentId>|
 *     refs=<path|sha256;path|sha256;...>|
 *     scope_read=<path;path;...>|
 *     scope_write=<path;path;...>|
 *     scope_forbidden=<path;path;...>|
 *     scope_sequential=<path;path;...>|
 *     bundle=<bundleId>@<bundleVersion>|
 *     model=<provider>/<id>@<policyVersion>
 *
 * Any change to this serialization is a contract change for
 * downstream consumers (evidence indexers, replay tools). Keep it
 * stable and bump the prefix when the shape evolves.
 */

import * as crypto from "node:crypto";

import type { ContentHash, SchemaVersion, TaskContract, WorkerBundle, ModelManifest, ArtifactReference } from "@legion/protocol";

const HASH_PREFIX = "v1";

export interface WorkerContextHashInput {
  readonly taskContract: TaskContract;
  readonly contextRefs: readonly ArtifactReference[];
  readonly workerBundle: WorkerBundle;
  readonly model: ModelManifest;
  readonly protocolVersion: SchemaVersion;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function joinReferences(references: readonly ArtifactReference[]): string {
  const sorted = [...references]
    .map((reference) => `${reference.path}|${reference.sha256}`)
    .sort();
  return sorted.join(";");
}

function joinPaths(paths: readonly string[]): string {
  return [...paths].sort().join(";");
}

export function deriveWorkerContextHash(input: WorkerContextHashInput): ContentHash {
  const parts: string[] = [
    `${HASH_PREFIX}|protocol=${input.protocolVersion}`,
    `contract=${input.taskContract.id}@${input.taskContract.revision}`,
    `wave=${input.taskContract.wave}`,
    `agent=${input.taskContract.agents[0] ?? ""}`,
    `refs=${joinReferences(input.contextRefs)}`,
    `scope_read=${joinPaths(input.taskContract.scope.read)}`,
    `scope_write=${joinPaths(input.taskContract.scope.write)}`,
    `scope_forbidden=${joinPaths(input.taskContract.scope.forbidden)}`,
    `scope_sequential=${joinPaths(input.taskContract.scope.sequentialFiles)}`,
    `bundle=${input.workerBundle.id}@${input.workerBundle.version}`,
    `model=${input.model.provider}/${input.model.id}@${input.model.policyVersion}`
  ];

  const payload = parts.join("|");
  return `sha256:${sha256Hex(payload)}` as ContentHash;
}

/**
 * The isolation tag is a human-readable, deterministic string that
 * auditors can grep for to prove a context was produced by the
 * fresh-context dispatcher. It is intentionally NOT a hash (so it
 * stays inspectable in logs) and intentionally NOT a UUID (so it
 * stays stable across replays).
 *
 * Format: `fresh-context:v1:<workerContextHash prefix>`
 */
export function deriveIsolationTag(workerContextHash: ContentHash): string {
  // The full hash is 71 chars (`sha256:` + 64 hex). The first 12
  // hex characters after the prefix give 48 bits of entropy — plenty
  // for an audit tag without leaking the entire hash.
  const hashBody = workerContextHash.replace(/^sha256:/, "");
  return `fresh-context:v1:${hashBody.slice(0, 12)}`;
}
