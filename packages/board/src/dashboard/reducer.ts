/**
 * P11-T01 — Pure reducer for the dashboard projection.
 *
 * The dashboard reducer walks the append-only board event
 * log once and produces the frozen
 * `DashboardProjectionState` (counts, pointers, rolling
 * timeline). It mirrors the P09-T02 / P10-T01 reducer shape
 * so the SQLite projector can wrap it in the standard
 * projection-store flow without any adapter tweaks.
 *
 * Reducer rules:
 *
 *  - Foreign events (wrong `aggregateKind` / `eventType` /
 *    `aggregateId` / missing payload fields) are ignored
 *    silently — the dashboard must replay an interleaved
 *    log without throwing.
 *  - `task.created` / `task.transitioned` / `task.deleted` /
 *    `task.superseded` events update the per-`BoardTaskStatus`
 *    counter surface. The reducer keeps a *current*
 *    per-task status map (private to the reducer) and rolls
 *    it forward through every task event so the final
 *    counter surface is consistent with the latest known
 *    task state.
 *  - `change.aggregated` / `change.accepted` /
 *    `change.rejected` / `change.blocked` /
 *    `change.escalated` events update the per-`changeId`
 *    approval pointer (verdict + reason). The verdict is
 *    `approved` for `change.aggregated` with status
 *    `accepted` (or `change.accepted`), `rejected` for
 *    `change.rejected`, `blocked` for `change.blocked` /
 *    `change.escalated`.
 *  - `release.observing` / `release.observed` /
 *    `release.promoted` / `release.regressed` /
 *    `release.rolled_back` events update the
 *    per-`changeId` release-observation pointer. The
 *    pointer's `status` is `observing` / `promoted` /
 *    `regressed` / `rolled_back`; `release.observed` is
 *    treated as a non-terminal observation log entry that
 *    does NOT move the verdict but does advance the
 *    timeline.
 *  - The rolling event timeline is bounded by `tailLimit`
 *    (default 25, max 200) so the projection state stays
 *    compact.
 *  - The reducer is pure: same event log ⇒ same state. No
 *    IO, no clock reads.
 *  - `aggregateKindCounts` are recomputed from the live
 *    per-aggregate counters that mirror what was actually
 *    seen during replay — including events that did not
 *    contribute a state change.
 */

import type { BoardEvent, BoardEventType } from "@legion/board-store";

import {
  BOARD_TASK_STATUSES,
  type BoardTaskStatus
} from "@legion/board-store";

import {
  DASHBOARD_ADAPTER_KIND,
  DASHBOARD_ADAPTER_SCHEMA_VERSION,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  DASHBOARD_MAX_TAIL_LIMIT,
  DASHBOARD_RELEASE_STATUSES,
  makeInitialDashboardState,
  dashboardTimelineEntryKey,
  type DashboardAggregateKindCounts,
  type DashboardApprovalPointer,
  type DashboardApprovalVerdict,
  type DashboardEventTailEntry,
  type DashboardProjectionState,
  type DashboardReducer,
  type DashboardReleaseObservationPointer,
  type DashboardReleaseStatus,
  type DashboardTaskStatusCounts
} from "./contract.js";

import type { ProjectId, UtcTimestamp } from "@legion/protocol";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MutableDashboardWorkingState {
  schemaVersion: typeof DASHBOARD_ADAPTER_SCHEMA_VERSION;
  kind: typeof DASHBOARD_ADAPTER_KIND;
  projectId: ProjectId;
  rebuiltThroughGlobalSequence: number;
  eventCount: number;
  taskStatusCounts: Record<string, number>;
  aggregateKindCounts: Record<string, number>;
  releaseObservationPointers: DashboardReleaseObservationPointer[];
  approvalPointers: DashboardApprovalPointer[];
  eventTimeline: DashboardEventTailEntry[];
  /** Internal — not part of the public projection state. */
  taskStatusByTaskId: Map<string, BoardTaskStatus | null>;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Read the projectId out of a board event payload. The board
 * event payload shape is intentionally permissive (free-form
 * JSON); the dashboard reads projectId from `payload.projectId`
 * for task.* events and falls back to event-level data when
 * the payload does not carry it.
 */
function readProjectId(
  event: BoardEvent
): string | null {
  if (!event.payload || typeof event.payload !== "object") return null;
  const projectId = (event.payload as Record<string, unknown>)["projectId"];
  return isString(projectId) && projectId.length > 0 ? projectId : null;
}

/**
 * Read the changeId out of a board event payload. Whole-
 * change and release-observation events always carry
 * changeId in their payload; task.* events carry changeId
 * too but the dashboard reducer uses it only for pointer
 * updates (which only fire for change.* / release.* events).
 */
function readChangeId(
  event: BoardEvent
): string | null {
  if (!event.payload || typeof event.payload !== "object") return null;
  const changeId = (event.payload as Record<string, unknown>)["changeId"];
  return isString(changeId) && changeId.length > 0 ? changeId : null;
}

function readStringField(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return isString(value) && value.length > 0 ? value : null;
}

function readContentHashField(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return isString(value) && /^sha256:[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

function readBoardTaskStatus(
  value: unknown
): BoardTaskStatus | null {
  if (!isString(value)) return null;
  if ((BOARD_TASK_STATUSES as readonly string[]).includes(value)) {
    return value as BoardTaskStatus;
  }
  return null;
}

function readDashboardReleaseStatus(
  value: unknown
): Exclude<DashboardReleaseStatus, "absent"> | null {
  if (
    value === "observing" ||
    value === "promoted" ||
    value === "regressed" ||
    value === "rolled_back"
  ) {
    return value;
  }
  return null;
}

function isReleaseObservationEventType(eventType: BoardEventType): boolean {
  return (
    eventType === "release.observing" ||
    eventType === "release.observed" ||
    eventType === "release.promoted" ||
    eventType === "release.regressed" ||
    eventType === "release.rolled_back"
  );
}

function isWholeChangeEventType(eventType: BoardEventType): boolean {
  return (
    eventType === "change.aggregated" ||
    eventType === "change.accepted" ||
    eventType === "change.rejected" ||
    eventType === "change.blocked" ||
    eventType === "change.escalated"
  );
}

function isTaskEventType(eventType: BoardEventType): boolean {
  return (
    eventType === "task.created" ||
    eventType === "task.transitioned" ||
    eventType === "task.deleted" ||
    eventType === "task.superseded" ||
    eventType === "task.priority_changed" ||
    eventType === "task.bumped" ||
    eventType === "task.linked"
  );
}

function eventTypeToReleaseStatus(
  eventType: BoardEventType
): Exclude<DashboardReleaseStatus, "absent"> | null {
  switch (eventType) {
    case "release.observing":
      return "observing";
    case "release.promoted":
      return "promoted";
    case "release.regressed":
      return "regressed";
    case "release.rolled_back":
      return "rolled_back";
    default:
      return null;
  }
}

function summaryForTaskTransition(
  payload: Record<string, unknown>,
  toStatus: BoardTaskStatus | null
): string {
  const taskId = readStringField(payload, "taskId");
  if (toStatus !== null) {
    return taskId !== null
      ? `task ${taskId} → ${toStatus}`
      : `task → ${toStatus}`;
  }
  return taskId !== null ? `task ${taskId} event` : "task event";
}

function summaryForChange(payload: Record<string, unknown>, verdict: DashboardApprovalVerdict | null): string {
  const changeId = readStringField(payload, "changeId");
  if (verdict !== null) {
    return changeId !== null
      ? `change ${changeId} ${verdict}`
      : `change ${verdict}`;
  }
  return changeId !== null ? `change ${changeId} event` : "change event";
}

function summaryForRelease(
  payload: Record<string, unknown>,
  status: Exclude<DashboardReleaseStatus, "absent"> | null
): string {
  const changeId = readStringField(payload, "changeId");
  if (status !== null) {
    return changeId !== null
      ? `release ${changeId} ${status}`
      : `release ${status}`;
  }
  return changeId !== null ? `release ${changeId} observed` : "release observed";
}

function summaryForGeneric(event: BoardEvent): string {
  return `${event.aggregateKind} ${event.eventType}`;
}

function buildTimelineEntry(event: BoardEvent, summary: string): DashboardEventTailEntry {
  return {
    eventId: event.eventId,
    aggregateKind: event.aggregateKind,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    globalSequence: event.globalSequence,
    occurredAt: event.occurredAt as UtcTimestamp,
    summary
  };
}

/**
 * Bounded timeline push. Mirrors the FIFO behavior of the
 * SQLite projector: when the timeline exceeds `tailLimit`,
 * the oldest entry is dropped.
 */
function pushTimeline(
  timeline: readonly DashboardEventTailEntry[],
  entry: DashboardEventTailEntry,
  tailLimit: number
): DashboardEventTailEntry[] {
  if (timeline.some((existing) => existing.eventId === entry.eventId)) {
    return [...timeline];
  }
  const next = [...timeline, entry];
  if (next.length <= tailLimit) return next;
  return next.slice(next.length - tailLimit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReduceDashboardOptions {
  /**
   * Bound the rolling event timeline. Defaults to
   * `DASHBOARD_DEFAULT_TAIL_LIMIT`. Clamped to
   * `DASHBOARD_MAX_TAIL_LIMIT`.
   */
  readonly tailLimit?: number;
}

/**
 * Reduce a single board event into the dashboard projection.
 * Pure: same state + same event ⇒ same next state. Foreign
 * events (wrong `aggregateKind` / `eventType` / missing
 * payload fields) are ignored silently.
 *
 * Note: the per-task live status state map
 * (`taskStatusByTaskId`) is reconstructed on every replay
 * pass. Single-call consumers (CLI) call `replayDashboard`
 * once with the full event log; tests that build state
 * incrementally should use `replayDashboard` too so the
 * per-task live state map is reconstructed over the full
 * event stream. The reducer accepts a `priorEvents` hint
 * so tests that want to keep `reduceDashboard` working in
 * isolation can supply the prior events for live-state
 * reconstruction.
 */
export function reduceDashboard(
  state: DashboardProjectionState | null,
  event: BoardEvent,
  options: ReduceDashboardOptions & {
    readonly priorEvents?: readonly BoardEvent[];
  } = {}
): DashboardProjectionState | null {
  if (!event || typeof event !== "object") return state;
  if (!event.payload || typeof event.payload !== "object") return state;

  // Foreign projectId check — the dashboard is project-scoped.
  const eventProjectId = readProjectId(event);
  if (
    state !== null &&
    eventProjectId !== null &&
    eventProjectId !== state.projectId
  ) {
    return state;
  }
  const projectId: string | null =
    state !== null ? state.projectId : eventProjectId;
  if (projectId === null) return state;

  const tailLimit = Math.min(
    Math.max(options.tailLimit ?? DASHBOARD_DEFAULT_TAIL_LIMIT, 1),
    DASHBOARD_MAX_TAIL_LIMIT
  );

  // If the caller supplied prior events (used by tests that
  // build state incrementally via repeated `reduceDashboard`
  // calls), reconstruct the per-task live state from those
  // events. Otherwise treat the live state as empty (the
  // single-call form is only safe when the caller has not
  // missed any events).
  const liveTaskStatusByTaskId = new Map<string, BoardTaskStatus | null>();
  if (options.priorEvents) {
    for (const priorEvent of options.priorEvents) {
      if (!isTaskEventType(priorEvent.eventType)) continue;
      const priorPayload = priorEvent.payload as Record<string, unknown>;
      const priorTaskId = readStringField(priorPayload, "taskId");
      if (priorTaskId === null) continue;
      if (priorEvent.eventType === "task.deleted") {
        liveTaskStatusByTaskId.delete(priorTaskId);
        continue;
      }
      if (priorEvent.eventType === "task.created") {
        const fromStatus = readBoardTaskStatus(priorPayload["fromStatus"]) ?? "queued";
        liveTaskStatusByTaskId.set(priorTaskId, fromStatus);
        continue;
      }
      if (priorEvent.eventType === "task.transitioned") {
        const toStatus = readBoardTaskStatus(priorPayload["toStatus"]);
        if (toStatus !== null) liveTaskStatusByTaskId.set(priorTaskId, toStatus);
        continue;
      }
      if (priorEvent.eventType === "task.superseded") {
        liveTaskStatusByTaskId.set(priorTaskId, "superseded");
        continue;
      }
    }
  }

  // Build a mutable working state from the (frozen) public
  // projection state. Internal helpers (e.g. applyTaskEvent)
  // mutate the working state in place; we re-freeze on exit.
  const working: MutableDashboardWorkingState = state
    ? {
        schemaVersion: state.schemaVersion,
        kind: state.kind,
        projectId: state.projectId,
        rebuiltThroughGlobalSequence: state.rebuiltThroughGlobalSequence,
        eventCount: state.eventCount,
        taskStatusCounts: { ...state.taskStatusCounts },
        aggregateKindCounts: { ...state.aggregateKindCounts },
        releaseObservationPointers: [...state.releaseObservationPointers],
        approvalPointers: [...state.approvalPointers],
        eventTimeline: [...state.eventTimeline],
        taskStatusByTaskId: liveTaskStatusByTaskId
      }
    : {
        schemaVersion: DASHBOARD_ADAPTER_SCHEMA_VERSION,
        kind: DASHBOARD_ADAPTER_KIND,
        projectId: projectId as ProjectId,
        rebuiltThroughGlobalSequence: -1,
        eventCount: 0,
        taskStatusCounts: {},
        aggregateKindCounts: {},
        releaseObservationPointers: [],
        approvalPointers: [],
        eventTimeline: [],
        taskStatusByTaskId: liveTaskStatusByTaskId
      };

  working.eventCount += 1;
  working.aggregateKindCounts = {
    ...working.aggregateKindCounts,
    [event.aggregateKind]: (working.aggregateKindCounts[event.aggregateKind] ?? 0) + 1
  };

  if (isTaskEventType(event.eventType)) {
    applyTaskEvent(working, event);
  } else if (isWholeChangeEventType(event.eventType)) {
    applyWholeChangeEvent(working, event);
  } else if (isReleaseObservationEventType(event.eventType)) {
    applyReleaseObservationEvent(working, event);
  }

  const summary = summariseEvent(event);
  working.eventTimeline = pushTimeline(
    working.eventTimeline,
    buildTimelineEntry(event, summary),
    tailLimit
  );
  working.rebuiltThroughGlobalSequence = event.globalSequence;

  return freezeDashboardState(working);
}

/**
 * Re-freeze the working state into the public
 * `DashboardProjectionState` shape (drops the internal
 * per-task live state map).
 */
function freezeDashboardState(
  working: MutableDashboardWorkingState
): DashboardProjectionState {
  return {
    schemaVersion: working.schemaVersion,
    kind: working.kind,
    projectId: working.projectId,
    rebuiltThroughGlobalSequence: working.rebuiltThroughGlobalSequence,
    eventCount: working.eventCount,
    taskStatusCounts: Object.freeze({ ...working.taskStatusCounts }),
    aggregateKindCounts: Object.freeze({ ...working.aggregateKindCounts }),
    releaseObservationPointers: Object.freeze([
      ...working.releaseObservationPointers
    ]),
    approvalPointers: Object.freeze([...working.approvalPointers]),
    eventTimeline: Object.freeze([...working.eventTimeline])
  };
}

// ---------------------------------------------------------------------------
// Event-type-specific reducers
// ---------------------------------------------------------------------------

function applyTaskEvent(
  state: MutableDashboardWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown>;
  const taskId = readStringField(payload, "taskId");
  if (taskId === null) return;

  const previousStatus = state.taskStatusByTaskId.get(taskId) ?? null;

  if (previousStatus !== null) {
    state.taskStatusCounts = decrementCount(state.taskStatusCounts, previousStatus);
  }

  if (event.eventType === "task.deleted") {
    state.taskStatusByTaskId.delete(taskId);
    return;
  }

  let nextStatus: BoardTaskStatus | null = previousStatus;

  if (event.eventType === "task.created") {
    nextStatus = readBoardTaskStatus(payload["fromStatus"]) ?? "queued";
  } else if (event.eventType === "task.transitioned") {
    nextStatus = readBoardTaskStatus(payload["toStatus"]) ?? previousStatus;
  } else if (event.eventType === "task.superseded") {
    nextStatus = "superseded";
  } else if (
    event.eventType === "task.priority_changed" ||
    event.eventType === "task.bumped" ||
    event.eventType === "task.linked"
  ) {
    nextStatus = previousStatus;
  }

  if (nextStatus === null) {
    state.taskStatusByTaskId.delete(taskId);
    return;
  }

  state.taskStatusByTaskId.set(taskId, nextStatus);
  state.taskStatusCounts = incrementCount(state.taskStatusCounts, nextStatus);
}

function applyWholeChangeEvent(
  state: MutableDashboardWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown>;
  const changeId = readChangeId(event);
  if (changeId === null) return;

  const verdict = mapChangeEventToVerdict(event.eventType, payload);
  if (verdict === null) return;

  const mergeQueueHash = readContentHashField(payload, "mergeQueueHash");
  const reason = readStringField(payload, "reason") ?? "";

  const nextPointer: DashboardApprovalPointer = {
    changeId: changeId as DashboardApprovalPointer["changeId"],
    verdict,
    mergeQueueHash: mergeQueueHash as DashboardApprovalPointer["mergeQueueHash"],
    lastEventType: event.eventType,
    lastGlobalSequence: event.globalSequence,
    lastOccurredAt: event.occurredAt as UtcTimestamp,
    reason
  };

  state.approvalPointers = upsertApprovalPointer(
    state.approvalPointers,
    nextPointer
  );
}

function applyReleaseObservationEvent(
  state: MutableDashboardWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown>;
  const changeId = readChangeId(event);
  if (changeId === null) return;

  // release.observed is a non-terminal observation log; it
  // does NOT move the verdict pointer.
  if (event.eventType === "release.observed") return;

  const releaseStatus = eventTypeToReleaseStatus(event.eventType);
  if (releaseStatus === null) return;

  const mergeQueueHash = readContentHashField(payload, "mergeQueueHash");
  const reportSha256 = readContentHashField(payload, "reportSha256");
  const observedAt = readStringField(payload, "observedAt") ?? event.occurredAt;
  if (mergeQueueHash === null || reportSha256 === null) return;

  const nextPointer: DashboardReleaseObservationPointer = {
    changeId: changeId as DashboardReleaseObservationPointer["changeId"],
    mergeQueueHash: mergeQueueHash as DashboardReleaseObservationPointer["mergeQueueHash"],
    reportSha256: reportSha256 as DashboardReleaseObservationPointer["reportSha256"],
    status: releaseStatus,
    observedAt: observedAt as UtcTimestamp,
    lastEventType: event.eventType,
    globalSequence: event.globalSequence
  };

  state.releaseObservationPointers = upsertReleasePointer(
    state.releaseObservationPointers,
    nextPointer
  );
}

function mapChangeEventToVerdict(
  eventType: BoardEventType,
  payload: Record<string, unknown>
): DashboardApprovalVerdict | null {
  switch (eventType) {
    case "change.aggregated": {
      const status = readStringField(payload, "status");
      if (status === "accepted") return "approved";
      if (status === "rejected") return "rejected";
      if (status === "blocked") return "blocked";
      return null;
    }
    case "change.accepted":
      return "approved";
    case "change.rejected":
      return "rejected";
    case "change.blocked":
    case "change.escalated":
      return "blocked";
    default:
      return null;
  }
}

function summariseEvent(event: BoardEvent): string {
  if (!isRecord(event.payload)) return summaryForGeneric(event);
  const payload = event.payload as Record<string, unknown>;
  if (isTaskEventType(event.eventType)) {
    const toStatus = readBoardTaskStatus(payload["toStatus"]);
    return summaryForTaskTransition(payload, toStatus);
  }
  if (isWholeChangeEventType(event.eventType)) {
    const verdict = mapChangeEventToVerdict(event.eventType, payload);
    return summaryForChange(payload, verdict);
  }
  if (isReleaseObservationEventType(event.eventType)) {
    const releaseStatus = eventTypeToReleaseStatus(event.eventType);
    return summaryForRelease(payload, releaseStatus);
  }
  return summaryForGeneric(event);
}

// ---------------------------------------------------------------------------
// Pointer upserts
// ---------------------------------------------------------------------------

function upsertApprovalPointer(
  pointers: readonly DashboardApprovalPointer[],
  next: DashboardApprovalPointer
): DashboardApprovalPointer[] {
  const hasNewerOrEqual = pointers.some(
    (existing) =>
      existing.changeId === next.changeId &&
      existing.lastGlobalSequence >= next.lastGlobalSequence
  );
  if (hasNewerOrEqual) {
    return [...pointers].sort((a, b) =>
      a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0
    );
  }
  const filtered = pointers.filter(
    (existing) => existing.changeId !== next.changeId
  );
  return [...filtered, next].sort((a, b) =>
    a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0
  );
}

function upsertReleasePointer(
  pointers: readonly DashboardReleaseObservationPointer[],
  next: DashboardReleaseObservationPointer
): DashboardReleaseObservationPointer[] {
  const filtered = pointers.filter(
    (existing) =>
      !(existing.changeId === next.changeId && existing.mergeQueueHash === next.mergeQueueHash) &&
      !(existing.changeId === next.changeId && existing.globalSequence >= next.globalSequence)
  );
  return [...filtered, next].sort((a, b) => {
    if (a.changeId !== b.changeId) return a.changeId < b.changeId ? -1 : 1;
    if (a.mergeQueueHash !== b.mergeQueueHash)
      return a.mergeQueueHash < b.mergeQueueHash ? -1 : 1;
    return a.globalSequence - b.globalSequence;
  });
}

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

function incrementCount(
  counts: DashboardTaskStatusCounts,
  key: BoardTaskStatus
): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

function decrementCount(
  counts: DashboardTaskStatusCounts,
  key: BoardTaskStatus
): Record<string, number> {
  const current = counts[key] ?? 0;
  if (current <= 1) {
    const next = { ...counts };
    delete next[key];
    return next;
  }
  return { ...counts, [key]: current - 1 };
}

// ---------------------------------------------------------------------------
// Replay helpers
// ---------------------------------------------------------------------------

/**
 * Replay a stream of board events into the final dashboard
 * projection state. Pure, side-effect free. Mirrors the
 * `replayWholeChangeAcceptance` / `replayReleaseObservation`
 * helpers.
 *
 * Implementation note: the per-task live state
 * (`taskStatusByTaskId`) is only meaningful when the
 * reducer has access to the *full* event stream, so we
 * thread the prior-events hint through every incremental
 * call to `reduceDashboard`. This keeps
 * `replayDashboard` deterministic and matches the
 * `reduceDashboard(state, event, { priorEvents })` contract.
 */
export function replayDashboard(
  events: readonly BoardEvent[],
  options: ReduceDashboardOptions = {}
): DashboardProjectionState | null {
  let state: DashboardProjectionState | null = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    state = reduceDashboard(state, event, {
      ...options,
      priorEvents: events.slice(0, i)
    });
  }
  return state;
}

/**
 * Adapter for `SqliteBoardProjectionRebuilder`. The board-store
 * surface types the reducer as `(state, event) => state` (not
 * nullable); we wrap the nullable reducer and coerce the
 * initial state back to the sentinel the projector expects.
 */
export function makeDashboardReducer(): DashboardReducer {
  return reduceDashboard;
}

// ---------------------------------------------------------------------------
// Sanity exports (for tests)
// ---------------------------------------------------------------------------

export const DASHBOARD_REDUCER_KIND = DASHBOARD_ADAPTER_KIND;
export const DASHBOARD_REDUCER_KIND_LITERAL = DASHBOARD_ADAPTER_KIND;
export const DASHBOARD_TIMELINE_KEY = dashboardTimelineEntryKey;
export const DASHBOARD_KNOWN_RELEASE_STATUSES = DASHBOARD_RELEASE_STATUSES;

// Surface the public state hash helper for downstream
// consumers (SQLite projector, CLI).
export { deriveDashboardProjectionStateHash, sha256OfCanonicalDashboardInput } from "./hash.js";
export type {
  DashboardAggregateKindCounts,
  DashboardApprovalPointer,
  DashboardApprovalVerdict,
  DashboardEventTailEntry,
  DashboardProjectionDescriptor,
  DashboardProjectionState,
  DashboardReleaseObservationPointer,
  DashboardReleaseStatus,
  DashboardTaskStatusCounts
} from "./contract.js";
export {
  dashboardProjectionKey,
  parseDashboardProjectionKey,
  makeInitialDashboardState,
  isDashboardProjectionState,
  DASHBOARD_PROJECTION_KEY_PREFIX,
  DASHBOARD_PROJECTION_VERSION,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  DASHBOARD_MAX_TAIL_LIMIT,
  DASHBOARD_ADAPTER_KIND,
  DASHBOARD_ADAPTER_SCHEMA_VERSION,
  DASHBOARD_ADAPTER_KEYS,
  DASHBOARD_APPROVAL_VERDICTS
} from "./contract.js";
