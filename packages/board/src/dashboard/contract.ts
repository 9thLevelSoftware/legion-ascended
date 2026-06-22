/**
 * P11-T01 — Dashboard projection contract.
 *
 * The dashboard projection is a *read* aggregation across the
 * board's append-only event log. It is the canonical operator
 * surface for the Phase 11 Kanban dashboard and multi-project
 * operator work promised in the kanban manifest:
 *
 *   - board visualization (status counts by `BoardTaskStatus`)
 *   - task status timeline (rolling event tail)
 *   - event timeline (rolling event tail by aggregate kind)
 *   - release-observation verdict (last known `ReleaseObservationStatus`
 *     per change that has release-observation evidence)
 *   - approval verdict (see `./approval-gate` for the per-change verdict)
 *
 * Why this lives in `@legion/board` (not `@legion/core`):
 *  - The dashboard is a *projection* over board events. It
 *    doesn't orchestrate anything; it derives read-only state
 *    from the same audit trail that the P09-T02 whole-change
 *    and P10-T01 release-observation adapters already consume.
 *  - This mirrors the P09-T02 / P10-T01 layering: core stays
 *    provider-neutral (no event log reads); board owns the
 *    logical aggregation/reduction over board events.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - The dashboard projection is a *cross-aggregate* projection:
 *    it consumes `task.*`, `change.*`, `release.*`, `task_link.*`,
 *    `claim.*`, and `approval.*` events for a single
 *    `(projectId)` slice. That is materially different from
 *    the P09-T02 (per changeId) and P10-T01 (per
 *    changeId+mergeQueueHash) projections, so the dashboard
 *    gets its own key namespace `dashboard:<projectId>`.
 *
 * Dashboard invariants:
 *  1. The dashboard projection is *global within a project*:
 *     one projection key per `projectId`. There is no
 *     changeId/mergeQueueHash split.
 *  2. Reducer is pure: same event log ⇒ same dashboard state.
 *     Foreign events (wrong aggregateKind / aggregateId /
 *     eventType) are ignored silently so an interleaved
 *     board event log never throws.
 *  3. The dashboard never mutates frozen whole-change or
 *     release-observation state. It derives counts, tail
 *     windows, and verdict pointers from the append-only log.
 *  4. The reducer exposes a content-addressed
 *     `DashboardProjectionStateHash` so the SQLite projector
 *     can detect drift without re-running the reducer.
 *  5. The dashboard module never imports a runtime driver,
 *     git, eve, board-store (only types), or `node:sqlite`.
 *     Those belong to `@legion/store-sqlite` and the CLI
 *     adapter layer.
 */

import type {
  ChangeId,
  ContentHash,
  ProjectId,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type { BoardEvent, BoardEventType } from "@legion/board-store";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const DASHBOARD_ADAPTER_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const DASHBOARD_ADAPTER_KIND = "dashboard-adapter" as const;

// ---------------------------------------------------------------------------
// Projection identity + key
// ---------------------------------------------------------------------------

/**
 * Dashboard projection identity. One dashboard per projectId
 * — the projection is project-scoped, not change-scoped, so
 * multi-project boards can host multiple dashboards in
 * parallel without colliding.
 */
export interface DashboardAggregateId {
  readonly projectId: ProjectId;
}

export const DASHBOARD_PROJECTION_KEY_PREFIX = "dashboard" as const;

/**
 * Canonical projection key for the dashboard projection.
 * Mirrors the P09-T02 / P10-T01 key shape
 * (`<prefix>:<projectId>`) and conforms to
 * `BOARD_PROJECTION_KEY_PATTERN` (lowercase start/end,
 * `[a-z0-9._:-]` only).
 */
export function dashboardProjectionKey(projectId: ProjectId): string {
  const sanitized = projectId.replace(/[^a-z0-9._:-]/gi, "_");
  return `dashboard:${sanitized}` as string;
}

/**
 * Inverse of `dashboardProjectionKey`. Returns `null` if
 * the key does not match the canonical dashboard projection
 * shape.
 */
export function parseDashboardProjectionKey(
  projectionKey: string
): { readonly projectId: string } | null {
  if (!projectionKey.startsWith("dashboard:")) return null;
  const projectId = projectionKey.slice("dashboard:".length);
  if (projectId.length === 0) return null;
  return { projectId };
}

// ---------------------------------------------------------------------------
// Rolling event timeline
// ---------------------------------------------------------------------------

/**
 * The dashboard keeps a rolling tail of the most recent
 * board events for the project so the operator can see the
 * timeline without re-querying the full event log. The tail
 * is bounded — operators configure `limit` (default 25, max
 * 200) when invoking `legion next board dashboard status`.
 */
export const DASHBOARD_DEFAULT_TAIL_LIMIT = 25 as const;
export const DASHBOARD_MAX_TAIL_LIMIT = 200 as const;

export interface DashboardEventTailEntry {
  readonly eventId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly eventType: BoardEventType;
  readonly globalSequence: number;
  readonly occurredAt: UtcTimestamp;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Release-observation verdict pointer
// ---------------------------------------------------------------------------

export const DASHBOARD_RELEASE_STATUSES = [
  "observing",
  "promoted",
  "regressed",
  "rolled_back",
  "absent"
] as const;

export type DashboardReleaseStatus =
  (typeof DASHBOARD_RELEASE_STATUSES)[number];

export interface DashboardReleaseObservationPointer {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly reportSha256: ContentHash;
  readonly status: Exclude<DashboardReleaseStatus, "absent">;
  readonly observedAt: UtcTimestamp;
  readonly lastEventType: BoardEventType;
  readonly globalSequence: number;
}

// ---------------------------------------------------------------------------
// Approval verdict pointer
// ---------------------------------------------------------------------------

export const DASHBOARD_APPROVAL_VERDICTS = [
  "approved",
  "pending",
  "rejected",
  "blocked"
] as const;

export type DashboardApprovalVerdict =
  (typeof DASHBOARD_APPROVAL_VERDICTS)[number];

export interface DashboardApprovalPointer {
  readonly changeId: ChangeId;
  readonly verdict: DashboardApprovalVerdict;
  readonly mergeQueueHash: ContentHash | null;
  readonly lastEventType: BoardEventType;
  readonly lastGlobalSequence: number;
  readonly lastOccurredAt: UtcTimestamp;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Per-status task counter surface
// ---------------------------------------------------------------------------

/**
 * The full task-status counter surface. The reducer fills
 * every legal `BoardTaskStatus` (defaulting to 0) so the
 * operator sees every status slot even when there are zero
 * tasks in that state.
 */
export type DashboardTaskStatusCounts = Readonly<
  Record<string, number>
>;

// ---------------------------------------------------------------------------
// Aggregate kind counter surface
// ---------------------------------------------------------------------------

export type DashboardAggregateKindCounts = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// Dashboard projection state
// ---------------------------------------------------------------------------

/**
 * The frozen dashboard projection state for a single
 * `(projectId)`. Operators consume this through
 * `legion next board dashboard status` and the JSON output
 * surfaces the counts + timeline + verdict pointers.
 */
export interface DashboardProjectionState {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof DASHBOARD_ADAPTER_KIND;
  readonly projectId: ProjectId;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly taskStatusCounts: DashboardTaskStatusCounts;
  readonly aggregateKindCounts: DashboardAggregateKindCounts;
  readonly releaseObservationPointers: readonly DashboardReleaseObservationPointer[];
  readonly approvalPointers: readonly DashboardApprovalPointer[];
  readonly eventTimeline: readonly DashboardEventTailEntry[];
}

// ---------------------------------------------------------------------------
// Reducer surface
// ---------------------------------------------------------------------------

/**
 * Reducer signature for the dashboard projection. Mirrors
 * the P09-T02 / P10-T01 reducer shape so the descriptor can
 * drop into `SqliteBoardProjectionRebuilder` unchanged.
 */
export type DashboardReducer = (
  state: DashboardProjectionState | null,
  event: BoardEvent
) => DashboardProjectionState | null;

export interface DashboardProjectionDescriptor {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: DashboardProjectionState | null;
  readonly reduce: DashboardReducer;
}

export const DASHBOARD_PROJECTION_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation
// ---------------------------------------------------------------------------

export const DASHBOARD_ADAPTER_KEYS = [
  "schemaVersion",
  "kind",
  "projectId",
  "rebuiltThroughGlobalSequence",
  "eventCount",
  "taskStatusCounts",
  "aggregateKindCounts",
  "releaseObservationPointers",
  "approvalPointers",
  "eventTimeline",
  "stateHash"
] as const;

export type DashboardAdapterKey = (typeof DASHBOARD_ADAPTER_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Idempotency key for an event-derived timeline entry. The
 * reducer is allowed to emit at most one entry per
 * `(globalSequence, eventType)` pair so a duplicate replay
 * (idempotent re-run) does not double-count.
 */
export function dashboardTimelineEntryKey(
  globalSequence: number,
  eventType: BoardEventType
): string {
  return `${globalSequence}:${eventType}`;
}

/**
 * Allocate a fresh dashboard projection state for the given
 * project. Mirrors `buildStateFromPayload` (P09-T02) and the
 * release-observation state initializer (P10-T01).
 */
export function makeInitialDashboardState(
  projectId: ProjectId,
  rebuiltThroughGlobalSequence = -1
): DashboardProjectionState {
  return Object.freeze({
    schemaVersion: DASHBOARD_ADAPTER_SCHEMA_VERSION,
    kind: DASHBOARD_ADAPTER_KIND,
    projectId,
    rebuiltThroughGlobalSequence,
    eventCount: 0,
    taskStatusCounts: Object.freeze({}),
    aggregateKindCounts: Object.freeze({}),
    releaseObservationPointers: Object.freeze([]),
    approvalPointers: Object.freeze([]),
    eventTimeline: Object.freeze([])
  }) as DashboardProjectionState;
}

/**
 * Validate that an incoming state has the canonical dashboard
 * shape. Exposed so the projector can detect drift and so
 * callers (CLI, tests) can validate third-party projections.
 */
export function isDashboardProjectionState(
  value: unknown
): value is DashboardProjectionState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== DASHBOARD_ADAPTER_KIND) return false;
  if (typeof record["projectId"] !== "string") return false;
  if (typeof record["eventCount"] !== "number") return false;
  if (!record["taskStatusCounts"] || typeof record["taskStatusCounts"] !== "object")
    return false;
  if (!record["aggregateKindCounts"] || typeof record["aggregateKindCounts"] !== "object")
    return false;
  if (!Array.isArray(record["releaseObservationPointers"])) return false;
  if (!Array.isArray(record["approvalPointers"])) return false;
  if (!Array.isArray(record["eventTimeline"])) return false;
  return true;
}

// Re-export BoardEventType so reducer consumers don't need to
// import the board-store module separately when shaping input.
export type { BoardEventType };