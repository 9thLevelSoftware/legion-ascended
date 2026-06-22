/**
 * P09-T02 — Whole-change acceptance aggregator contract.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - `packages/core/src/merge/contract.ts` describes the merge queue
 *    itself — what a frozen `MergeQueueOrchestratorResult` carries
 *    and how per-task + per-step outcomes aggregate. It stays
 *    provider-neutral (no board persistence, no Eve, no git).
 *  - This module is the *adapter* layer between the merge queue
 *    output and the board's event log + projection store. It maps
 *    `MergeIntegrationDecision.outcome` to the protocol's
 *    `AcceptanceState`, appends the right board events, and
 *    reconstructs the whole-change acceptance state from the event
 *    log via a deterministic reducer.
 *  - It mirrors the P08-T02 layering: P08-T02 produced per-task
 *    acceptance results as plain core values; the board adapter
 *    surfaces them to operators. P09-T02 does the same for the
 *    whole-change aggregate.
 *
 * Whole-change acceptance invariants:
 *  1. A whole-change acceptance is keyed by `(changeId,
 *     mergeQueueHash)` so an orchestrator re-run on the same queue
 *     emits idempotent events.
 *  2. The aggregator translates `MergeIntegrationOutcome` into the
 *     protocol's `AcceptanceState.status` with the canonical map:
 *        integrated → accepted
 *        rejected   → rejected
 *        escalated  → blocked
 *        blocked    → blocked
 *     The map is non-invertible on purpose — a `blocked` whole-change
 *     may later resolve to `accepted` (runner becomes available),
 *     but the protocol's `accepted` is terminal; we surface that
 *     transition through a second event rather than mutating state.
 *  3. Every emitted event carries the content-addressed audit trail:
 *     `mergeQueueHash`, `decisionSha256`, originating
 *     `workerContextHash` (per task), and the originating
 *     `ChangeId`.
 *  4. The projection reducer is pure: it takes the current state
 *     and one event, returns the next state. No IO, no clock
 *     reads (clock is injected into the aggregator only).
 *  5. Every output is deeply frozen and content-addressed so audit
 *     consumers can prove "same orchestrator result ⇒ same
 *     events ⇒ same projection".
 *  6. The board adapter never imports a runtime driver, git, or
 *     node:sqlite — those belong to `@legion/store-sqlite` and the
 *     CLI adapter layer.
 */

import type {
  ChangeId,
  ContentHash,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type {
  MergeIntegrationDecision,
  MergeIntegrationOutcome,
  MergeQueueOrchestratorResult
} from "@legion/core";

import type { BoardEvent, BoardEventType } from "@legion/board-store";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const WHOLE_CHANGE_ACCEPTANCE_KIND = "whole-change-acceptance" as const;

// ---------------------------------------------------------------------------
// Aggregate kinds + event types — extended surface
// ---------------------------------------------------------------------------

/**
 * Whole-change acceptance aggregate kinds. Extends the existing
 * `BOARD_EVENT_AGGREGATE_KINDS` allowlist at the board adapter
 * layer: core board-store stays untouched.
 */
export const WHOLE_CHANGE_AGGREGATE_KINDS = ["whole_change"] as const;

export type WholeChangeAggregateKind = (typeof WHOLE_CHANGE_AGGREGATE_KINDS)[number];

/**
 * Board event types emitted by the whole-change acceptance
 * aggregator. These are distinct from the existing
 * `BOARD_EVENT_TYPES` (`task.created`, `task.transitioned`, ...)
 * because they describe whole-change lifecycle transitions rather
 * than per-task control-plane mutations.
 */
export const WHOLE_CHANGE_EVENT_TYPES = [
  "change.aggregated",
  "change.accepted",
  "change.rejected",
  "change.escalated",
  "change.blocked"
] as const;

export type WholeChangeEventType = (typeof WHOLE_CHANGE_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Aggregate identity — pairs a change with a specific merge queue run
// ---------------------------------------------------------------------------

export interface WholeChangeAggregateId {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
}

// ---------------------------------------------------------------------------
// Outcome → AcceptanceState mapping (the canonical, non-invertible map)
// ---------------------------------------------------------------------------

/**
 * The board adapter's stable mapping from
 * `MergeIntegrationOutcome` to a board-level acceptance state
 * discriminator. Mirrors the Phase 9 HANDOFF rule:
 *   integrated → accepted
 *   rejected   → rejected
 *   escalated  → blocked
 *   blocked    → blocked
 *
 * `accepted` is terminal at the board layer; `rejected` and
 * `blocked` are terminal too unless a follow-up merge queue
 * produces a different `mergeQueueHash`. This keeps the audit log
 * append-only.
 */
export type WholeChangeAcceptanceStatus =
  | "accepted"
  | "rejected"
  | "blocked";

export interface WholeChangeAcceptanceState {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof WHOLE_CHANGE_ACCEPTANCE_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly outcome: MergeIntegrationOutcome;
  readonly status: WholeChangeAcceptanceStatus;
  readonly acceptedEntries: readonly number[];
  readonly rejectedEntries: readonly number[];
  readonly escalatedEntries: readonly number[];
  readonly conflictEntries: readonly number[];
  readonly finalHeadRef: string;
  readonly acceptedAt: UtcTimestamp;
  readonly acceptedBy: string;
  readonly reason: string;
  readonly workerContextHashes: readonly ContentHash[];
  readonly aggregatorHash: ContentHash;
}

// ---------------------------------------------------------------------------
// Per-event payload shapes — these ride inside `BoardEvent.payload`
// ---------------------------------------------------------------------------

export interface WholeChangeAggregatedPayload {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly outcome: MergeIntegrationOutcome;
  readonly status: WholeChangeAcceptanceStatus;
  readonly acceptedEntries: readonly number[];
  readonly rejectedEntries: readonly number[];
  readonly escalatedEntries: readonly number[];
  readonly conflictEntries: readonly number[];
  readonly finalHeadRef: string;
  readonly workerContextHashes: readonly ContentHash[];
  readonly aggregatorHash: ContentHash;
  readonly acceptedAt: UtcTimestamp;
  readonly acceptedBy: string;
  readonly reason: string;
}

export type WholeChangeEventPayload =
  | WholeChangeAggregatedPayload
  | (Omit<WholeChangeAggregatedPayload, "status" | "reason"> & {
      readonly status: WholeChangeAcceptanceStatus;
      readonly reason: string;
    });

// ---------------------------------------------------------------------------
// Aggregator input/output
// ---------------------------------------------------------------------------

export interface WholeChangeAcceptanceAggregatorInput {
  readonly changeId: ChangeId;
  readonly orchestratorResult: MergeQueueOrchestratorResult;
  readonly acceptedBy: string;
  readonly reason?: string;
  readonly now?: () => UtcTimestamp;
  /**
   * Optional correlation id propagated to the emitted board
   * event so consumers can trace whole-change aggregates back
   * to the originating merge queue run.
   */
  readonly correlationId?: string | null;
  /**
   * Optional override for the worker-context hash chain. If
   * omitted, the aggregator harvests the hashes from each entry's
   * `refs.workerContextHash`.
   */
  readonly workerContextHashes?: readonly ContentHash[];
}

export interface WholeChangeAcceptanceAggregatorSuccess {
  readonly ok: true;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof WHOLE_CHANGE_ACCEPTANCE_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly outcome: MergeIntegrationOutcome;
  readonly status: WholeChangeAcceptanceStatus;
  readonly state: WholeChangeAcceptanceState;
  readonly events: readonly BoardEvent[];
  readonly aggregatorHash: ContentHash;
  readonly acceptedAt: UtcTimestamp;
}

export interface WholeChangeAcceptanceAggregatorFailure {
  readonly ok: false;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof WHOLE_CHANGE_ACCEPTANCE_KIND;
  readonly changeId: ChangeId;
  readonly issues: readonly WholeChangeAggregatorIssue[];
  readonly attemptedOutcome: MergeIntegrationOutcome | null;
  readonly attemptedMergeQueueHash: ContentHash | null;
}

export type WholeChangeAcceptanceAggregatorResult =
  | WholeChangeAcceptanceAggregatorSuccess
  | WholeChangeAcceptanceAggregatorFailure;

export type WholeChangeAggregatorIssueCode =
  | "orchestrator_result_invalid"
  | "decision_missing"
  | "snapshot_missing"
  | "merge_queue_hash_mismatch"
  | "empty_queue"
  | "accepted_by_invalid";

export interface WholeChangeAggregatorIssue {
  readonly code: WholeChangeAggregatorIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

// ---------------------------------------------------------------------------
// Projection reducer surface
// ---------------------------------------------------------------------------

/**
 * Reducer signature for the whole-change acceptance projection.
 * Mirrors `SqliteBoardProjectionRebuilder`'s reducer contract but
 * is expressed as a free function so the projection can be
 * replayed in tests without SQLite.
 *
 * The reducer takes the *raw* `WholeChangeAcceptanceState | null`
 * (the projection's logical state), not the `BoardProjectionState`
 * envelope that the SQLite rebuilder wraps it in. The projector
 * bridges the two shapes via `SqliteWholeChangeAcceptanceProjector`.
 */
export type WholeChangeAcceptanceReducer = (
  state: WholeChangeAcceptanceState | null,
  event: BoardEvent
) => WholeChangeAcceptanceState | null;

/**
 * A descriptor for the whole-change acceptance projection.
 *
 * `initialState` is `null` because no whole-change acceptance
 * has been observed yet for the bound `changeId`. The `reduce`
 * field takes/returns `WholeChangeAcceptanceState | null`
 * rather than the `BoardProjectionState` envelope so the
 * descriptor stays decoupled from the SQLite storage shape.
 */
export interface WholeChangeAcceptanceProjectionDescriptor {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: WholeChangeAcceptanceState | null;
  readonly reduce: WholeChangeAcceptanceReducer;
}

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation (mirrors P08 / P09 contract)
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_ACCEPTANCE_KEYS = [
  "ok",
  "schemaVersion",
  "kind",
  "changeId",
  "mergeQueueHash",
  "decisionSha256",
  "outcome",
  "status",
  "state",
  "events",
  "aggregatorHash",
  "acceptedAt",
  "issues",
  "attemptedOutcome",
  "attemptedMergeQueueHash"
] as const;

export type WholeChangeAcceptanceKey = (typeof WHOLE_CHANGE_ACCEPTANCE_KEYS)[number];

/**
 * Helper that picks the matching event type for the resolved
 * whole-change status. Used by the aggregator + tests.
 */
export function eventTypeForStatus(
  status: WholeChangeAcceptanceStatus
): WholeChangeEventType {
  switch (status) {
    case "accepted":
      return "change.accepted";
    case "rejected":
      return "change.rejected";
    case "blocked":
      return "change.blocked";
  }
}

/**
 * Re-export of the upstream decision type for adapter consumers.
 */
export type { MergeIntegrationDecision, MergeIntegrationOutcome };

/**
 * Re-export of the upstream BoardEvent type so the aggregator's
 * callers can build `correlationId`/`causationId` shapes without
 * importing `@legion/board-store` directly.
 */
export type { BoardEvent, BoardEventType };