/**
 * P08-T01 Fresh-context execution — typed contract.
 *
 * Why this lives in its own module:
 *  - `runtime/contract.ts` describes what a runtime driver MUST
 *    implement (the seven lifecycle methods). That surface is
 *    provider-facing.
 *  - This module describes what the dispatcher MUST hand to a worker
 *    so the worker can execute a preflighted TaskContract without
 *    seeing any cross-task state.
 *
 * Freshness invariants (enforced by `freezeWorkerContext` in
 * `dispatcher.ts` and asserted by `isIsolatedWorkerContext`):
 *  1. The `WorkerContext` is deeply immutable (Object.freeze
 *     recursively over every property, including nested arrays and
 *     objects).
 *  2. The context carries ONLY fields listed in the
 *     `WORKER_CONTEXT_KEYS` allowlist. No scratch fields, no extras,
 *     no `parentRunIds`, no observable globals.
 *  3. The context references only artifacts explicitly listed in
 *     `TaskContract.context.{specRefs, designRefs, predecessorArtifacts}`
 *     and only file paths inside `TaskContract.scope.{read, write,
 *     forbidden}`. Caller-supplied paths outside the contract scope
 *     are rejected before construction.
 *  4. The `workerContextHash` is a deterministic SHA-256 over the
 *     contract id/revision, sorted artifact references, worker bundle
 *     id, and protocol version. Two contexts with identical inputs
 *     produce identical hashes — this lets downstream layers prove
 *     "same contract, same context" without leaking content.
 */

import type {
  ArtifactPath,
  ArtifactReference,
  ContentHash,
  SchemaVersion,
  TaskContract,
  UtcTimestamp,
  WorkerBundle
} from "@legion/protocol";

import type {
  TaskContractPreflightIssue,
  TaskContractPreflightIssueCode
} from "@legion/protocol";

import type { ModelManifest } from "@legion/protocol";

// ---------------------------------------------------------------------------
// Issue codes surfaced to the board
// ---------------------------------------------------------------------------

export type DispatchIssueCode =
  | TaskContractPreflightIssueCode
  | "context_reference_out_of_scope"
  | "worker_context_dispatcher_failure";

export interface DispatchIssue {
  readonly code: DispatchIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly source?: "preflight" | "dispatcher";
}

export type DispatchIssueInput =
  | TaskContractPreflightIssue
  | (Omit<DispatchIssue, "source"> & { readonly source?: "dispatcher" });

// ---------------------------------------------------------------------------
// Board blocker projection (kept here to avoid pulling the board
// persistence layer into core)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral blocker shape that downstream layers (board, CLI,
 * evidence indexer) can render or persist. The shape mirrors the
 * board's `BoardTaskBlocker` interface; we intentionally do NOT
 * import the board persistence package from core because core must
 * remain free of storage dependencies. Board adapters translate
 * this into their own blocker representation.
 */
export interface DispatchBoardBlocker {
  readonly reason: string;
  readonly reportedBy?: string;
  readonly reportedAt?: UtcTimestamp;
  readonly code: DispatchIssueCode;
  readonly path: readonly (string | number)[];
}

// ---------------------------------------------------------------------------
// Worker bundle registry inputs
// ---------------------------------------------------------------------------

export interface WorkerBundleRegistryEntry {
  readonly agentId: string;
  readonly bundle: WorkerBundle;
  readonly model: ModelManifest;
}

export interface WorkerBundleRegistry {
  /** All entries for an agent id, in registration order. */
  forAgent(agentId: string): readonly WorkerBundleRegistryEntry[];
}

// ---------------------------------------------------------------------------
// WorkerContext — the fresh, isolated worker input
// ---------------------------------------------------------------------------

/**
 * The frozen allowlist of fields on a `WorkerContext`. Any other field
 * breaks isolation; `isIsolatedWorkerContext` enforces this rule on
 * inputs handed to downstream consumers.
 */
export const WORKER_CONTEXT_KEYS = [
  "schemaVersion",
  "kind",
  "taskContract",
  "contextRefs",
  "scope",
  "workerBundle",
  "model",
  "workerContextHash",
  "isolationTag",
  "createdAt",
  "protocolVersion"
] as const;

export type WorkerContextKey = (typeof WORKER_CONTEXT_KEYS)[number];

/**
 * Three reference buckets derived from `TaskContract.context`. Each
 * artifact reference is recorded exactly once — the dispatcher
 * de-duplicates references that appear in multiple buckets so the
 * worker does not see inconsistent copies.
 */
export interface WorkerContextRefs {
  readonly specRefs: readonly ArtifactReference[];
  readonly designRefs: readonly ArtifactReference[];
  readonly predecessorArtifacts: readonly ArtifactReference[];
  readonly all: readonly ArtifactReference[];
}

export interface WorkerContextScope {
  readonly read: readonly ArtifactPath[];
  readonly write: readonly ArtifactPath[];
  readonly forbidden: readonly ArtifactPath[];
  readonly sequentialFiles: readonly ArtifactPath[];
}

export interface WorkerContext {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "worker-context";
  readonly taskContract: TaskContract;
  readonly contextRefs: WorkerContextRefs;
  readonly scope: WorkerContextScope;
  readonly workerBundle: WorkerBundle;
  readonly model: ModelManifest;
  readonly workerContextHash: ContentHash;
  readonly isolationTag: string;
  readonly createdAt: UtcTimestamp;
  readonly protocolVersion: SchemaVersion;
}

// ---------------------------------------------------------------------------
// Dispatch input / output
// ---------------------------------------------------------------------------

export interface FreshContextDispatchInput {
  readonly taskContract: TaskContract;
  readonly bundleRegistry: WorkerBundleRegistry;
  readonly protocolVersion: SchemaVersion;
  readonly now?: () => UtcTimestamp;
  readonly reporter?: string;
  readonly availableContracts?: readonly { readonly contractId: string; readonly revision?: number }[];
  readonly availableAgents?: readonly string[];
  readonly availableArtifacts?: readonly ArtifactReference[];
}

export interface FreshContextDispatchSuccess {
  readonly ok: true;
  readonly workerContext: WorkerContext;
  readonly matchedAgentId: string;
  readonly preflightIssueCount: 0;
}

export interface FreshContextDispatchFailure {
  readonly ok: false;
  readonly taskContract: TaskContract;
  readonly issues: readonly DispatchIssue[];
  readonly blockers: readonly DispatchBoardBlocker[];
}

export type FreshContextDispatchResult =
  | FreshContextDispatchSuccess
  | FreshContextDispatchFailure;

// ---------------------------------------------------------------------------
// Worker bundle selection
// ---------------------------------------------------------------------------

export interface WorkerBundleSelectionSuccess {
  readonly ok: true;
  readonly agentId: string;
  readonly bundle: WorkerBundle;
  readonly model: ModelManifest;
}

export interface WorkerBundleSelectionFailure {
  readonly ok: false;
  readonly agentId: string;
  readonly reason: "agent_not_registered" | "agent_ambiguous";
  readonly candidates?: readonly string[];
}

export type WorkerBundleSelectionResult =
  | WorkerBundleSelectionSuccess
  | WorkerBundleSelectionFailure;

// ---------------------------------------------------------------------------
// Internal helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Build a stable, sorted list of artifact references from the three
 * contract context buckets. Duplicates are removed by `path|sha256`
 * key (preserving first occurrence).
 */
export function collectContextRefs(taskContract: TaskContract): WorkerContextRefs {
  const specRefs = taskContract.context.specRefs;
  const designRefs = taskContract.context.designRefs;
  const predecessorArtifacts = taskContract.context.predecessorArtifacts;

  const seen = new Set<string>();
  const all: ArtifactReference[] = [];
  for (const reference of [...specRefs, ...designRefs, ...predecessorArtifacts]) {
    const key = `${reference.path}|${reference.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(reference);
  }

  return { specRefs, designRefs, predecessorArtifacts, all };
}

/**
 * Project the contract's file scope into the immutable scope object
 * the worker is allowed to consult. The contract remains the source
 * of truth — this just freezes the references the worker can see.
 */
export function collectScope(taskContract: TaskContract): WorkerContextScope {
  return {
    read: taskContract.scope.read,
    write: taskContract.scope.write,
    forbidden: taskContract.scope.forbidden,
    sequentialFiles: taskContract.scope.sequentialFiles
  };
}
