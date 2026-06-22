/**
 * P09-T01 — Ordered merge queue contract.
 *
 * Why this lives in its own module:
 *  - `dispatch/contract.ts` describes what a worker receives
 *    (WorkerContext). The merge queue is downstream of that surface.
 *  - `review/contract.ts` describes per-task acceptance. The merge
 *    queue aggregates accepted task runs into a sequenced integration
 *    pipeline.
 *  - This module describes what a merge-queue entry MUST carry so the
 *    conflict detector, rebase sequencer, and integration gate can
 *    reason over an ordered set of accepted task results without
 *    touching any provider-specific code paths.
 *
 * Merge-queue invariants (enforced by `MergeQueueOrchestrator`):
 *  1. A queue entry references a frozen `WorkerContext` and the
 *     `PerTaskReviewPipelineResult` that accepted it; the queue never
 *     accepts free-form review summaries.
 *  2. The queue is ordered: every entry carries an explicit
 *     `sequenceIndex` plus a `baseRef` pointing at the parent entry's
 *     `resultRef`. The sequencer refuses duplicate or out-of-order
 *     sequence indices.
 *  3. Conflict detection is deterministic: it is computed from the
 *     union of `TaskContract.scope.write` paths per entry plus a
 *     caller-supplied `pathOwnershipMap`. The detector never reads
 *     from disk; CLI adapters map filesystem conflicts into this
 *     shape.
 *  4. The rebase sequencer advances one entry at a time and refuses
 *     to advance past a `conflict` or `rejected` decision. Each step
 *     produces a frozen `MergeQueueStep` record that references the
 *     `entry` and the resulting `headRef`.
 *  5. The integration gate consumes the full step sequence and the
 *     per-entry `AcceptanceDecision.outcome` to produce a single
 *     whole-change `MergeIntegrationDecision`. The whole-change
 *     decision fails closed when ANY per-task decision is
 *     `rejected` and routes `escalated` decisions to explicit human
 *     approval.
 *  6. Every output shape is deeply frozen and carries a SHA-256
 *     `mergeQueueHash` so audit consumers can prove "same entry set
 *     + same conflicts + same steps ⇒ same decision".
 *  7. The merge queue module is provider-neutral: it never imports a
 *     runtime driver, board persistence, or reads node process
 *     environment. Rebase command execution is injected as a
 *     `RebaseRunner` so the CLI adapter can wrap git/Eve without
 *     dragging those into core.
 */

import type {
  Actor,
  ContentHash,
  GitSha,
  RiskTier,
  SchemaVersion,
  TaskContract,
  UtcTimestamp
} from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import type {
  AcceptanceDecision,
  PerTaskReviewPipelineResult,
  ReviewRecord,
  VerificationReport
} from "../review/contract.js";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const MERGE_QUEUE_SCHEMA_VERSION: SchemaVersion = "1.0.0" as SchemaVersion;
export const MERGE_QUEUE_KIND = "merge-queue" as const;

// ---------------------------------------------------------------------------
// Issue codes surfaced to the orchestrator and the board
// ---------------------------------------------------------------------------

export type MergeQueueIssueCode =
  | "entry_out_of_order"
  | "entry_duplicate_sequence"
  | "entry_base_ref_mismatch"
  | "entry_decision_rejected"
  | "entry_decision_escalated"
  | "path_conflict_detected"
  | "rebase_runner_unavailable"
  | "rebase_command_failed"
  | "rebase_head_drift"
  | "integration_outcome_rejected"
  | "integration_pending_escalation";

export interface MergeQueueIssue {
  readonly code: MergeQueueIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly entrySequenceIndex?: number;
}

// ---------------------------------------------------------------------------
// Path ownership / conflict detection surface
// ---------------------------------------------------------------------------

export interface PathOwnershipClaim {
  readonly path: string;
  readonly ownerEntrySequenceIndex: number;
  readonly kind: "write" | "sequential";
  readonly evidenceRefs?: readonly string[];
}

export interface PathOwnershipMap {
  forPath(path: string): readonly PathOwnershipClaim[];
}

export interface ConflictReport {
  readonly path: string;
  readonly conflictingEntrySequenceIndices: readonly number[];
  readonly reason: "overlapping_write" | "sequential_violation";
}

// ---------------------------------------------------------------------------
// Rebase sequencer surface (injected)
// ---------------------------------------------------------------------------

export interface RebaseCommandRequest {
  readonly entrySequenceIndex: number;
  readonly baseRef: string;
  readonly headRef: string;
  readonly targetRef: string;
  readonly context: WorkerContext;
}

export interface RebaseCommandResult {
  readonly entrySequenceIndex: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly expectedExitCode: number;
  readonly stdoutSha256: ContentHash;
  readonly stderrSha256: ContentHash;
  readonly combinedSha256: ContentHash;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly newHeadRef: string;
  readonly notes?: string;
}

export type RebaseRunner = (
  request: RebaseCommandRequest
) => Promise<RebaseCommandResult> | RebaseCommandResult;

// ---------------------------------------------------------------------------
// Merge queue entry — frozen, content-addressed handle
// ---------------------------------------------------------------------------

export interface MergeQueueEntryRefs {
  readonly workerContextHash: ContentHash;
  readonly isolationTag: string;
  readonly reviewPipelineHash: ContentHash;
  readonly verificationReportSha256: ContentHash;
  readonly reviewHash: ContentHash | null;
  readonly decisionSha256: ContentHash;
  readonly taskContractId: string;
  readonly contractRevision: number;
}

export interface MergeQueueEntry {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof MERGE_QUEUE_KIND;
  readonly sequenceIndex: number;
  readonly taskContract: TaskContract;
  readonly workerContext: WorkerContext;
  readonly reviewResult: PerTaskReviewPipelineResult;
  readonly refs: MergeQueueEntryRefs;
  readonly baseRef: string;
  readonly headRef: string;
  readonly targetRef: string;
  readonly tier: RiskTier;
  readonly decision: AcceptanceDecision;
  readonly submittedBy: Actor;
  readonly submittedAt: UtcTimestamp;
}

// ---------------------------------------------------------------------------
// Sequencer step + outcome
// ---------------------------------------------------------------------------

export type MergeStepOutcome =
  | "queued"
  | "rebased"
  | "conflict"
  | "rejected"
  | "escalated"
  | "integrated";

export interface MergeQueueStep {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "merge-queue-step";
  readonly sequenceIndex: number;
  readonly entryRef: MergeQueueEntryRefs;
  readonly outcome: MergeStepOutcome;
  readonly headRefBefore: string;
  readonly headRefAfter: string;
  readonly conflicts: readonly ConflictReport[];
  readonly rebase: RebaseCommandResult | null;
  readonly verification: VerificationReport | null;
  readonly review: ReviewRecord | null;
  readonly issues: readonly MergeQueueIssue[];
  readonly stepSha256: ContentHash;
  readonly createdAt: UtcTimestamp;
}

export interface MergeQueueSnapshot {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof MERGE_QUEUE_KIND;
  readonly sequenceLength: number;
  readonly steps: readonly MergeQueueStep[];
  readonly orderedSequenceIndices: readonly number[];
  readonly mergeQueueHash: ContentHash;
  readonly createdAt: UtcTimestamp;
}

// ---------------------------------------------------------------------------
// Whole-change integration decision
// ---------------------------------------------------------------------------

export type MergeIntegrationOutcome =
  | "integrated"
  | "rejected"
  | "blocked"
  | "escalated";

export interface MergeIntegrationDecision {
  readonly schemaVersion: SchemaVersion;
  readonly kind: "merge-integration-decision";
  readonly mergeQueueHash: ContentHash;
  readonly finalHeadRef: string;
  readonly outcome: MergeIntegrationOutcome;
  readonly acceptedEntries: readonly number[];
  readonly rejectedEntries: readonly number[];
  readonly escalatedEntries: readonly number[];
  readonly conflictEntries: readonly number[];
  readonly decisionSha256: ContentHash;
  readonly createdAt: UtcTimestamp;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Board blocker projection
// ---------------------------------------------------------------------------

export interface MergeQueueBoardBlocker {
  readonly reason: string;
  readonly reportedBy?: string;
  readonly reportedAt?: UtcTimestamp;
  readonly code: MergeQueueIssueCode;
  readonly path: readonly (string | number)[];
  readonly entrySequenceIndex?: number;
}

// ---------------------------------------------------------------------------
// Pipeline input / output
// ---------------------------------------------------------------------------

export interface MergeQueueOrchestratorInput {
  readonly entries: readonly MergeQueueEntry[];
  readonly ownership?: PathOwnershipMap;
  readonly rebaseRunner?: RebaseRunner;
  readonly now?: () => UtcTimestamp;
  readonly reporter?: string;
  readonly initialHeadRef?: string;
}

export interface MergeQueueOrchestratorSuccess {
  readonly ok: true;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof MERGE_QUEUE_KIND;
  readonly snapshot: MergeQueueSnapshot;
  readonly decision: MergeIntegrationDecision;
  readonly blockers: readonly MergeQueueBoardBlocker[];
  readonly issues: readonly MergeQueueIssue[];
  readonly mergeQueueHash: ContentHash;
  readonly createdAt: UtcTimestamp;
}

export interface MergeQueueOrchestratorFailure {
  readonly ok: false;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof MERGE_QUEUE_KIND;
  readonly snapshot: MergeQueueSnapshot | null;
  readonly decision: MergeIntegrationDecision | null;
  readonly blockers: readonly MergeQueueBoardBlocker[];
  readonly issues: readonly MergeQueueIssue[];
  readonly mergeQueueHash: ContentHash | null;
  readonly createdAt: UtcTimestamp;
}

export type MergeQueueOrchestratorResult =
  | MergeQueueOrchestratorSuccess
  | MergeQueueOrchestratorFailure;

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation (mirrors P08-T01 contract)
// ---------------------------------------------------------------------------

export const MERGE_QUEUE_KEYS = [
  "ok",
  "schemaVersion",
  "kind",
  "snapshot",
  "decision",
  "blockers",
  "issues",
  "mergeQueueHash",
  "createdAt"
] as const;

export type MergeQueueKey = (typeof MERGE_QUEUE_KEYS)[number];

export const MERGE_QUEUE_ENTRY_KEYS = [
  "schemaVersion",
  "kind",
  "sequenceIndex",
  "taskContract",
  "workerContext",
  "reviewResult",
  "refs",
  "baseRef",
  "headRef",
  "targetRef",
  "tier",
  "decision",
  "submittedBy",
  "submittedAt"
] as const;

export type MergeQueueEntryKey = (typeof MERGE_QUEUE_ENTRY_KEYS)[number];
