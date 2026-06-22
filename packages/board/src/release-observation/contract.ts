/**
 * P10-T01 — Release observation board adapter contract.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - `packages/core/src/release-observation/contract.ts`
 *    describes the provider-neutral release observation
 *    orchestrator. It stays out of board persistence.
 *  - This module is the *adapter* layer between the
 *    release-observation orchestrator output and the board's
 *    event log + projection store. It maps
 *    `ReleaseObservationReport.status` to a board event type
 *    and reconstructs the release-observation state from the
 *    event log via a deterministic reducer.
 *  - It mirrors the P09-T02 layering: the orchestrator
 *    produces a frozen core result; the board adapter
 *    surfaces it to operators.
 *
 * Release-observation board invariants:
 *  1. A release-observation event is keyed by
 *     `(changeId, mergeQueueHash, reportSha256)` so an
 *     orchestrator re-run on the same merge queue + same
 *     probes emits idempotent events.
 *  2. The board event type is derived from
 *     `ReleaseObservationStatus` via a canonical map
 *     (observing → release.observing, promoted →
 *     release.promoted, regressed → release.regressed,
 *     rolled_back → release.rolled_back). The map is
 *     non-invertible: terminal statuses stay terminal;
 *     promotion requires a fresh `mergeQueueHash` /
 *     `reportSha256`.
 *  3. Every emitted event carries the content-addressed
 *     audit trail: `changeId`, `mergeQueueHash`,
 *     `decisionSha256`, `reportSha256`, and the originating
 *     `observedBy` actor. Downstream consumers can prove
 *     "same orchestrator result ⇒ same event ⇒ same
 *     projection state".
 *  4. The reducer is pure: it takes the current state and
 *     one event, returns the next state. No IO, no clock
 *     reads (clock is injected into the aggregator only).
 *  5. Every output is deeply frozen and content-addressed.
 *  6. The board adapter never imports a runtime driver, git,
 *     or `node:sqlite` — those belong to
 *     `@legion/store-sqlite` and the CLI adapter layer.
 */

import type {
  ChangeId,
  ContentHash,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type {
  ReleaseObservationEventPayload,
  ReleaseObservationEventType,
  ReleaseObservationReport
} from "@legion/core";

import type { BoardEvent, BoardEventType } from "@legion/board-store";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const RELEASE_OBSERVATION_ADAPTER_KIND = "release-observation-adapter" as const;

// ---------------------------------------------------------------------------
// Aggregate kinds + event types — extended surface
// ---------------------------------------------------------------------------

/**
 * Release-observation aggregate kinds. Extends the existing
 * `BOARD_EVENT_AGGREGATE_KINDS` allowlist at the board adapter
 * layer: core board-store stays untouched.
 */
export const RELEASE_OBSERVATION_AGGREGATE_KINDS = [
  "release_observation"
] as const;

export type ReleaseObservationAggregateKind =
  (typeof RELEASE_OBSERVATION_AGGREGATE_KINDS)[number];

/**
 * Board event types emitted by the release-observation
 * aggregator. These are distinct from the existing
 * `BOARD_EVENT_TYPES` (task.*, change.*) because they describe
 * release-observation lifecycle transitions rather than
 * per-task control-plane mutations or whole-change aggregates.
 */
export const RELEASE_OBSERVATION_BOARD_EVENT_TYPES: readonly BoardEventType[] =
  [
    "release.observing",
    "release.observed",
    "release.promoted",
    "release.regressed",
    "release.rolled_back"
  ] as const;

export type ReleaseObservationBoardEventType = Extract<
  BoardEventType,
  (typeof RELEASE_OBSERVATION_BOARD_EVENT_TYPES)[number]
> | ReleaseObservationEventType;

// ---------------------------------------------------------------------------
// Aggregate identity
// ---------------------------------------------------------------------------

export interface ReleaseObservationAggregateId {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly reportSha256: ContentHash;
}

// ---------------------------------------------------------------------------
// Release-observation projection state
// ---------------------------------------------------------------------------

export interface ReleaseObservationProjectionState {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_ADAPTER_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly reportSha256: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly report: ReleaseObservationReport;
  readonly lastEventType: ReleaseObservationEventType;
  readonly lastObservedAt: UtcTimestamp;
  readonly observedBy: string;
  readonly reportCount: number;
}

// ---------------------------------------------------------------------------
// Aggregator input/output
// ---------------------------------------------------------------------------

export interface ReleaseObservationBoardAggregatorInput {
  readonly changeId: ChangeId;
  readonly report: ReleaseObservationReport;
  readonly now?: () => UtcTimestamp;
  /**
   * Optional correlation id propagated to the emitted board
   * event so consumers can trace a release-observation report
   * back to the originating merge queue run.
   */
  readonly correlationId?: string | null;
  /**
   * Optional override for the board-actor label. Defaults to
   * `report.observedBy.id`.
   */
  readonly reporter?: string;
}

export interface ReleaseObservationBoardAggregatorSuccess {
  readonly ok: true;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_ADAPTER_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly reportSha256: ContentHash;
  readonly lastEventType: ReleaseObservationEventType;
  readonly state: ReleaseObservationProjectionState;
  readonly events: readonly BoardEvent[];
  readonly idempotencyKey: string;
  readonly observedAt: UtcTimestamp;
}

export interface ReleaseObservationBoardAggregatorFailure {
  readonly ok: false;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_ADAPTER_KIND;
  readonly changeId: ChangeId;
  readonly issues: readonly ReleaseObservationBoardIssue[];
}

export type ReleaseObservationBoardAggregatorResult =
  | ReleaseObservationBoardAggregatorSuccess
  | ReleaseObservationBoardAggregatorFailure;

export type ReleaseObservationBoardIssueCode =
  | "report_missing"
  | "report_sha_mismatch"
  | "change_id_mismatch"
  | "event_type_invalid";

export interface ReleaseObservationBoardIssue {
  readonly code: ReleaseObservationBoardIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

// ---------------------------------------------------------------------------
// Projection reducer surface
// ---------------------------------------------------------------------------

/**
 * Reducer signature for the release-observation projection.
 * Mirrors the `WholeChangeAcceptanceReducer` (P09-T02). The
 * reducer takes/returns `ReleaseObservationProjectionState |
 * null` so the descriptor stays decoupled from the SQLite
 * storage shape.
 */
export type ReleaseObservationReducer = (
  state: ReleaseObservationProjectionState | null,
  event: BoardEvent
) => ReleaseObservationProjectionState | null;

export interface ReleaseObservationProjectionDescriptor {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: ReleaseObservationProjectionState | null;
  readonly reduce: ReleaseObservationReducer;
}

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_ADAPTER_KEYS = [
  "ok",
  "schemaVersion",
  "kind",
  "changeId",
  "mergeQueueHash",
  "reportSha256",
  "lastEventType",
  "state",
  "events",
  "idempotencyKey",
  "observedAt",
  "issues"
] as const;

export type ReleaseObservationAdapterKey =
  (typeof RELEASE_OBSERVATION_ADAPTER_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper that picks the matching board event type for the
 * resolved release-observation status. Mirrors
 * `eventTypeForReleaseStatus` in core.
 */
export function eventTypeForReleaseObservationStatus(
  status: ReleaseObservationReport["status"]
): ReleaseObservationEventType {
  switch (status) {
    case "observing":
      return "release.observing";
    case "promoted":
      return "release.promoted";
    case "regressed":
      return "release.regressed";
    case "rolled_back":
      return "release.rolled_back";
  }
}

/**
 * Idempotency key for a release-observation event. Mirrors
 * the P09-T02 `<changeId>:<mergeQueueHash>:<eventType>`
 * pattern, extended with the reportSha256 so distinct reports
 * on the same merge queue (e.g. re-runs after probe
 * adjustments) are still individually addressable.
 */
export function releaseObservationIdempotencyKey(
  changeId: ChangeId,
  mergeQueueHash: ContentHash,
  reportSha256: ContentHash,
  eventType: ReleaseObservationEventType
): string {
  return `${changeId}:${mergeQueueHash}:${reportSha256}:${eventType}`;
}

// ---------------------------------------------------------------------------
// Re-exports for adapter consumers
// ---------------------------------------------------------------------------

export type {
  BoardEvent,
  BoardEventType,
  ReleaseObservationEventPayload,
  ReleaseObservationEventType,
  ReleaseObservationReport
};
