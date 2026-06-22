/**
 * P11-T02 — Pure reducer for the portfolio projection.
 *
 * The portfolio reducer walks the append-only board event
 * log once and produces the frozen
 * `PortfolioProjectionState` (per-project rollups,
 * cross-project dependency edges, resource allocation
 * ledger). It mirrors the P11-T01 dashboard reducer shape so
 * the SQLite projector can wrap it in the standard
 * projection-store flow without any adapter tweaks.
 *
 * Reducer rules:
 *
 *  - Foreign events (wrong `aggregateKind` / `eventType` /
 *    aggregateId / missing payload fields) are ignored
 *    silently — the portfolio must replay an interleaved
 *    multi-project log without throwing.
 *  - `task.created` / `task.transitioned` /
 *    `task.priority_changed` / `task.deleted` /
 *    `task.superseded` events update the per-project
 *    rollup (status counts, terminal counts, active counts,
 *    blocked counts, total priority, max priority,
 *    claimed counts, last event timestamp, last event type,
 *    last global sequence).
 *  - `task.linked` events update the cross-project
 *    dependency edge map. Only edges that touch *two
 *    different projects* are surfaced in the public state;
 *    same-project edges are counted in
 *    `projectRollups.<projectId>.crossProjectDependencyCount`
 *    via the aggregator but the portfolio edges array
 *    itself stays cross-project-only.
 *  - `change.aggregated` / `change.accepted` /
 *    `change.rejected` / `change.blocked` /
 *    `change.escalated` events update the per-project
 *    `lastApprovalVerdict` field.
 *  - `release.observing` / `release.promoted` /
 *    `release.regressed` / `release.rolled_back` events
 *    update the per-project `lastReleaseObservationStatus`
 *    field. `release.observed` is a non-terminal
 *    observation log entry that does NOT move the verdict.
 *  - The portfolio resource ledger is recomputed from the
 *    live per-project counters after every event so the
 *    ledger stays consistent with the latest known task
 *    state without leaking private counters into the public
 *    shape.
 *  - The reducer is pure: same event log ⇒ same state. No
 *    IO, no clock reads.
 *  - `terminalProjectCount` counts projects whose
 *    `taskCount === terminalTaskCount` AND `taskCount > 0`
 *    — i.e. projects where every task has reached a
 *    terminal status. Projects with zero tasks are NOT
 *    counted as terminal.
 */

import type { BoardEvent, BoardEventType } from "@legion/board-store";

import {
  BOARD_TASK_STATUSES,
  type BoardTaskStatus
} from "@legion/board-store";

import {
  PORTFOLIO_ADAPTER_KIND,
  PORTFOLIO_ADAPTER_SCHEMA_VERSION,
  PORTFOLIO_DEPENDENCY_RELATIONS,
  PORTFOLIO_PROJECTION_KEY_PREFIX,
  portfolioEdgeKey,
  portfolioPriorityBand,
  portfolioProjectionKey,
  makeInitialPortfolioState,
  type PortfolioDependencyEdge,
  type PortfolioDependencyRelation,
  type PortfolioPriorityBand,
  type PortfolioProjectionDescriptor,
  type PortfolioProjectRollup,
  type PortfolioProjectionState,
  type PortfolioReducer,
  type PortfolioScope,
  type ReducePortfolioOptions,
  type TenantId
} from "./contract.js";

import type { ProjectId, UtcTimestamp } from "@legion/protocol";

// ---------------------------------------------------------------------------
// Reducer kind label (mirrors P11-T01 dashboard reducer kind)
// ---------------------------------------------------------------------------

export const PORTFOLIO_REDUCER_KIND = "portfolio-reducer" as const;
export const PORTFOLIO_REDUCER_KIND_LITERAL: typeof PORTFOLIO_REDUCER_KIND =
  PORTFOLIO_REDUCER_KIND;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MutableProjectRollup {
  projectId: ProjectId;
  taskStatusCounts: Record<string, number>;
  aggregateKindCounts: Record<string, number>;
  taskCount: number;
  terminalTaskCount: number;
  activeTaskCount: number;
  blockedTaskCount: number;
  totalPriority: number;
  maxPriority: number;
  priorityBands: Record<PortfolioPriorityBand, number>;
  claimedTaskCount: number;
  lastEventType: BoardEventType | null;
  lastGlobalSequence: number;
  lastOccurredAt: UtcTimestamp | null;
  lastReleaseObservationStatus: BoardEventType | null;
  lastApprovalVerdict: string | null;
}

interface MutablePortfolioWorkingState {
  schemaVersion: typeof PORTFOLIO_ADAPTER_SCHEMA_VERSION;
  kind: typeof PORTFOLIO_ADAPTER_KIND;
  tenantId: TenantId;
  /**
   * Working scope — always a `ReadonlySet<ProjectId>` or
   * null. The public projection state freezes a sorted
   * snapshot under the `scope` key; the reducer keeps the
   * Set form internally so the membership check stays O(1).
   */
  scope: PortfolioScope;
  rebuiltThroughGlobalSequence: number;
  eventCount: number;
  projectRollups: Map<ProjectId, MutableProjectRollup>;
  dependencyEdges: Map<string, MutableDependencyEdge>;
  crossProjectDependencyCount: number;
  /** Internal — not part of the public projection state. */
  currentTaskStatusByAggregateId: Map<string, BoardTaskStatus | null>;
  currentPriorityByAggregateId: Map<string, number>;
  currentProjectIdByAggregateId: Map<string, ProjectId>;
}

interface MutableDependencyEdge {
  relation: PortfolioDependencyRelation;
  fromProjectId: ProjectId;
  fromTaskId: string;
  toProjectId: ProjectId;
  toTaskId: string;
  firstObservedAt: UtcTimestamp;
  lastObservedAt: UtcTimestamp;
  lastGlobalSequence: number;
  eventCount: number;
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

function isBoardTaskStatus(value: unknown): value is BoardTaskStatus {
  return (
    typeof value === "string" &&
    (BOARD_TASK_STATUSES as readonly string[]).includes(value)
  );
}

const TERMINAL_BOARD_TASK_STATUSES: ReadonlySet<BoardTaskStatus> = new Set([
  "completed",
  "failed",
  "canceled",
  "superseded"
]);

const ACTIVE_BOARD_TASK_STATUSES: ReadonlySet<BoardTaskStatus> = new Set([
  "ready",
  "claimed",
  "running",
  "blocked"
]);

function isDependencyRelation(
  value: unknown
): value is PortfolioDependencyRelation {
  return (
    value === "depends_on" || value === "blocks"
  );
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

function readProjectIdFromPayload(
  payload: Record<string, unknown>
): string | null {
  const value = payload["projectId"];
  return isString(value) && value.length > 0 ? value : null;
}

function readTaskIdFromPayload(
  payload: Record<string, unknown>
): string | null {
  const value = payload["taskId"];
  return isString(value) && value.length > 0 ? value : null;
}

function readDependsOnTaskIdFromPayload(
  payload: Record<string, unknown>
): string | null {
  const value = payload["dependsOnTaskId"];
  return isString(value) && value.length > 0 ? value : null;
}

function readFromStatusFromPayload(
  payload: Record<string, unknown>
): BoardTaskStatus | null {
  const value = payload["fromStatus"];
  return isBoardTaskStatus(value) ? value : null;
}

function readToStatusFromPayload(
  payload: Record<string, unknown>
): BoardTaskStatus | null {
  const value = payload["toStatus"];
  return isBoardTaskStatus(value) ? value : null;
}

function readPriorityFromPayload(payload: Record<string, unknown>): number | null {
  const value = payload["priority"];
  return isNumber(value) ? value : null;
}

function readRelationFromPayload(
  payload: Record<string, unknown>
): PortfolioDependencyRelation | null {
  const value = payload["relation"];
  return isDependencyRelation(value) ? value : null;
}

function readApprovalVerdictFromPayload(
  payload: Record<string, unknown>
): string | null {
  const value = payload["status"];
  return isString(value) && value.length > 0 ? value : null;
}

function readReleaseObservationStatusFromPayload(
  payload: Record<string, unknown>
): BoardEventType | null {
  const value = payload["status"];
  if (
    value === "observing" ||
    value === "promoted" ||
    value === "regressed" ||
    value === "rolled_back"
  ) {
    return `release.${value}` as BoardEventType;
  }
  return null;
}

function emptyMutableProjectRollup(projectId: ProjectId): MutableProjectRollup {
  return {
    projectId,
    taskStatusCounts: {},
    aggregateKindCounts: {},
    taskCount: 0,
    terminalTaskCount: 0,
    activeTaskCount: 0,
    blockedTaskCount: 0,
    totalPriority: 0,
    maxPriority: 0,
    priorityBands: { high: 0, mid: 0, low: 0 },
    claimedTaskCount: 0,
    lastEventType: null,
    lastGlobalSequence: -1,
    lastOccurredAt: null,
    lastReleaseObservationStatus: null,
    lastApprovalVerdict: null
  };
}

function cloneProjectRollup(rollup: MutableProjectRollup): PortfolioProjectRollup {
  return Object.freeze({
    projectId: rollup.projectId,
    taskStatusCounts: Object.freeze({ ...rollup.taskStatusCounts }),
    aggregateKindCounts: Object.freeze({ ...rollup.aggregateKindCounts }),
    taskCount: rollup.taskCount,
    terminalTaskCount: rollup.terminalTaskCount,
    activeTaskCount: rollup.activeTaskCount,
    blockedTaskCount: rollup.blockedTaskCount,
    totalPriority: rollup.totalPriority,
    maxPriority: rollup.maxPriority,
    priorityBands: Object.freeze({ ...rollup.priorityBands }),
    claimedTaskCount: rollup.claimedTaskCount,
    lastEventType: rollup.lastEventType,
    lastGlobalSequence: rollup.lastGlobalSequence,
    lastOccurredAt: rollup.lastOccurredAt,
    lastReleaseObservationStatus: rollup.lastReleaseObservationStatus,
    lastApprovalVerdict: rollup.lastApprovalVerdict
  }) as PortfolioProjectRollup;
}

function incrementAggregateKindCount(
  rollup: MutableProjectRollup,
  kind: string
): void {
  rollup.aggregateKindCounts[kind] = (rollup.aggregateKindCounts[kind] ?? 0) + 1;
}

function decrementStatusCount(
  rollup: MutableProjectRollup,
  status: BoardTaskStatus
): void {
  const current = rollup.taskStatusCounts[status] ?? 0;
  if (current <= 1) {
    delete rollup.taskStatusCounts[status];
  } else {
    rollup.taskStatusCounts[status] = current - 1;
  }
  if (TERMINAL_BOARD_TASK_STATUSES.has(status)) {
    rollup.terminalTaskCount = Math.max(0, rollup.terminalTaskCount - 1);
  }
  if (ACTIVE_BOARD_TASK_STATUSES.has(status)) {
    rollup.activeTaskCount = Math.max(0, rollup.activeTaskCount - 1);
  }
  if (status === "blocked") {
    rollup.blockedTaskCount = Math.max(0, rollup.blockedTaskCount - 1);
  }
  if (status === "claimed") {
    rollup.claimedTaskCount = Math.max(0, rollup.claimedTaskCount - 1);
  }
}

function incrementStatusCount(
  rollup: MutableProjectRollup,
  status: BoardTaskStatus
): void {
  rollup.taskStatusCounts[status] = (rollup.taskStatusCounts[status] ?? 0) + 1;
  if (TERMINAL_BOARD_TASK_STATUSES.has(status)) {
    rollup.terminalTaskCount += 1;
  }
  if (ACTIVE_BOARD_TASK_STATUSES.has(status)) {
    rollup.activeTaskCount += 1;
  }
  if (status === "blocked") {
    rollup.blockedTaskCount += 1;
  }
  if (status === "claimed") {
    rollup.claimedTaskCount += 1;
  }
}

function isInScope(
  scope: PortfolioScope,
  projectId: string
): boolean {
  if (scope === null) return true;
  return scope.has(projectId as ProjectId);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function incrementPriorityBand(
  rollup: MutableProjectRollup,
  band: PortfolioPriorityBand,
  delta: number
): void {
  rollup.priorityBands[band] = Math.max(0, (rollup.priorityBands[band] ?? 0) + delta);
}

function applyTaskCreated(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const taskId = readTaskIdFromPayload(payload);
  if (!taskId) return;
  const aggregateId =
    typeof payload["taskId"] === "string" ? `task:${projectId}:${taskId}` : null;
  if (!aggregateId) return;
  const fromStatus = readFromStatusFromPayload(payload) ?? "queued";
  const priority = readPriorityFromPayload(payload) ?? 0;

  let rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) {
    rollup = emptyMutableProjectRollup(projectId as ProjectId);
    working.projectRollups.set(projectId as ProjectId, rollup);
  }
  rollup.taskCount += 1;
  rollup.totalPriority += priority;
  if (priority > rollup.maxPriority) rollup.maxPriority = priority;
  incrementPriorityBand(rollup, portfolioPriorityBand(priority), 1);
  incrementStatusCount(rollup, fromStatus);
  incrementAggregateKindCount(rollup, "task");
  working.currentTaskStatusByAggregateId.set(aggregateId, fromStatus);
  working.currentPriorityByAggregateId.set(aggregateId, priority);
  working.currentProjectIdByAggregateId.set(
    aggregateId,
    projectId as ProjectId
  );
}

function applyTaskTransitioned(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const taskId = readTaskIdFromPayload(payload);
  if (!taskId) return;
  const aggregateId = `task:${projectId}:${taskId}`;
  const toStatus = readToStatusFromPayload(payload);
  if (!toStatus) return;
  const fromStatus =
    working.currentTaskStatusByAggregateId.get(aggregateId) ?? null;
  const rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) return;
  if (fromStatus && fromStatus !== toStatus) {
    decrementStatusCount(rollup, fromStatus);
  }
  if (fromStatus !== toStatus) {
    incrementStatusCount(rollup, toStatus);
  }
  working.currentTaskStatusByAggregateId.set(aggregateId, toStatus);
}

function applyTaskPriorityChanged(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const taskId = readTaskIdFromPayload(payload);
  if (!taskId) return;
  const aggregateId = `task:${projectId}:${taskId}`;
  const priority = readPriorityFromPayload(payload);
  if (priority === null) return;
  const rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) return;
  const previous =
    working.currentPriorityByAggregateId.get(aggregateId) ?? null;
  if (previous !== null) {
    rollup.totalPriority = rollup.totalPriority - previous + priority;
    if (priority > rollup.maxPriority) rollup.maxPriority = priority;
    const previousBand = portfolioPriorityBand(previous);
    const nextBand = portfolioPriorityBand(priority);
    if (previousBand !== nextBand) {
      incrementPriorityBand(rollup, previousBand, -1);
      incrementPriorityBand(rollup, nextBand, 1);
    }
  } else {
    rollup.totalPriority += priority;
    if (priority > rollup.maxPriority) rollup.maxPriority = priority;
    incrementPriorityBand(rollup, portfolioPriorityBand(priority), 1);
  }
  working.currentPriorityByAggregateId.set(aggregateId, priority);
}

function applyTaskDeleted(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const taskId = readTaskIdFromPayload(payload);
  if (!taskId) return;
  const aggregateId = `task:${projectId}:${taskId}`;
  const rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) return;
  const current =
    working.currentTaskStatusByAggregateId.get(aggregateId) ?? null;
  if (current) decrementStatusCount(rollup, current);
  rollup.taskCount = Math.max(0, rollup.taskCount - 1);
  working.currentTaskStatusByAggregateId.delete(aggregateId);
  const previousPriority =
    working.currentPriorityByAggregateId.get(aggregateId) ?? null;
  if (previousPriority !== null) {
    rollup.totalPriority = Math.max(0, rollup.totalPriority - previousPriority);
    incrementPriorityBand(
      rollup,
      portfolioPriorityBand(previousPriority),
      -1
    );
  }
  working.currentPriorityByAggregateId.delete(aggregateId);
}

function applyTaskSuperseded(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const taskId = readTaskIdFromPayload(payload);
  if (!taskId) return;
  const aggregateId = `task:${projectId}:${taskId}`;
  const rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) return;
  const current =
    working.currentTaskStatusByAggregateId.get(aggregateId) ?? null;
  if (current === "superseded") return;
  if (current) decrementStatusCount(rollup, current);
  incrementStatusCount(rollup, "superseded");
  working.currentTaskStatusByAggregateId.set(aggregateId, "superseded");
}

function applyTaskLinked(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const fromProjectId = readProjectIdFromPayload(payload);
  const fromTaskId = readTaskIdFromPayload(payload);
  const toTaskId = readDependsOnTaskIdFromPayload(payload);
  const relation = readRelationFromPayload(payload);
  if (!fromProjectId || !fromTaskId || !toTaskId || !relation) return;
  // The portfolio edges are cross-project only. The
  // destination task's projectId is read from a `toProjectId`
  // payload field if the writer supplied it; otherwise we
  // fall back to the source projectId (same-project edge,
  // which is dropped from the cross-project edges array).
  const rawToProjectId =
    typeof payload["toProjectId"] === "string"
      ? (payload["toProjectId"] as string)
      : null;
  if (!rawToProjectId) return;
  if (rawToProjectId === fromProjectId) return;
  if (!isInScope(working.scope, fromProjectId)) return;
  if (!isInScope(working.scope, rawToProjectId)) return;
  const edge: MutableDependencyEdge = {
    relation,
    fromProjectId: fromProjectId as ProjectId,
    fromTaskId,
    toProjectId: rawToProjectId as ProjectId,
    toTaskId,
    firstObservedAt:
      typeof payload["occurredAt"] === "string"
        ? (payload["occurredAt"] as UtcTimestamp)
        : ("1970-01-01T00:00:00.000Z" as UtcTimestamp),
    lastObservedAt:
      typeof payload["occurredAt"] === "string"
        ? (payload["occurredAt"] as UtcTimestamp)
        : ("1970-01-01T00:00:00.000Z" as UtcTimestamp),
    lastGlobalSequence: -1,
    eventCount: 1
  };
  const key = portfolioEdgeKey(edge);
  const existing = working.dependencyEdges.get(key);
  if (existing) {
    existing.eventCount += 1;
    existing.lastObservedAt = edge.lastObservedAt;
  } else {
    working.dependencyEdges.set(key, edge);
    working.crossProjectDependencyCount += 1;
  }
}

function applyChangeEvent(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  const verdict = readApprovalVerdictFromPayload(payload);
  if (!verdict) return;
  let rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) {
    rollup = emptyMutableProjectRollup(projectId as ProjectId);
    working.projectRollups.set(projectId as ProjectId, rollup);
  }
  rollup.lastApprovalVerdict = verdict;
}

function applyReleaseEvent(
  working: MutablePortfolioWorkingState,
  payload: Record<string, unknown>
): void {
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId || !isInScope(working.scope, projectId)) return;
  let rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) {
    rollup = emptyMutableProjectRollup(projectId as ProjectId);
    working.projectRollups.set(projectId as ProjectId, rollup);
  }
  const status = readReleaseObservationStatusFromPayload(payload);
  if (status) rollup.lastReleaseObservationStatus = status;
}

function applyEventToRollupHeader(
  working: MutablePortfolioWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || !isRecord(payload)) return;
  const projectId = readProjectIdFromPayload(payload);
  if (!projectId) return;
  if (!isInScope(working.scope, projectId)) return;
  let rollup = working.projectRollups.get(projectId as ProjectId);
  if (!rollup) {
    rollup = emptyMutableProjectRollup(projectId as ProjectId);
    working.projectRollups.set(projectId as ProjectId, rollup);
  }
  rollup.lastEventType = event.eventType;
  rollup.lastGlobalSequence = event.globalSequence;
  rollup.lastOccurredAt = event.occurredAt as UtcTimestamp;
  if (
    event.eventType !== "task.created" &&
    event.eventType !== "task.transitioned" &&
    event.eventType !== "task.priority_changed" &&
    event.eventType !== "task.deleted" &&
    event.eventType !== "task.superseded" &&
    event.eventType !== "task.linked"
  ) {
    incrementAggregateKindCount(rollup, event.aggregateKind);
  }
}

// ---------------------------------------------------------------------------
// Public reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for the portfolio projection. Mirrors the
 * P11-T01 dashboard reducer shape so the SQLite projector
 * can wrap it in the standard projection-store flow.
 *
 * The reducer accepts an optional `tenantId`, `scope`, and
 * `priorEvents` via the `ReducePortfolioOptions` argument
 * (declared in `./contract.ts`).
 *
 * On the first call (when `state` is null) the reducer
 * returns the prior state without applying the event (the
 * projector always seeds the initial state via
 * `makeInitialPortfolioState`). On subsequent calls the
 * reducer reuses the `tenantId` and `scope` from the
 * frozen state so incremental callers (tests, projector)
 * cannot accidentally change the slice mid-replay.
 */
export function reducePortfolio(
  state: PortfolioProjectionState | null,
  event: BoardEvent,
  options: ReducePortfolioOptions = {}
): PortfolioProjectionState | null {
  if (state === null) {
    return state;
  }

  // Build the mutable working copy. The reducer mutates
  // only this scratch object; the public projection state
  // is rebuilt and re-frozen at the end of every step.
  //
  // The public projection state stores the scope as a
  // frozen sorted array; the reducer's working state stores
  // it as a `ReadonlySet<ProjectId>` for O(1) membership
  // checks. We re-hydrate the Set from the public snapshot
  // here so incremental callers (tests) can re-enter the
  // reducer without losing scope context.
  const workingScope: PortfolioScope =
    state.scope.length === 0
      ? null
      : new Set<ProjectId>(state.scope as readonly ProjectId[]);
  const working: MutablePortfolioWorkingState = {
    schemaVersion: PORTFOLIO_ADAPTER_SCHEMA_VERSION,
    kind: PORTFOLIO_ADAPTER_KIND,
    tenantId: state.tenantId,
    scope: workingScope,
    rebuiltThroughGlobalSequence: state.rebuiltThroughGlobalSequence,
    eventCount: state.eventCount,
    projectRollups: new Map(),
    dependencyEdges: new Map(),
    crossProjectDependencyCount: state.crossProjectDependencyCount,
    currentTaskStatusByAggregateId: new Map(),
    currentPriorityByAggregateId: new Map(),
    currentProjectIdByAggregateId: new Map()
  };
  for (const [projectId, rollup] of Object.entries(state.projectRollups)) {
    working.projectRollups.set(
      projectId as ProjectId,
      cloneMutableRollup(rollup)
    );
  }
  for (const edge of state.dependencyEdges) {
    working.dependencyEdges.set(portfolioEdgeKey(edge), cloneMutableEdge(edge));
  }

  // Reconstruct the per-task live state from prior events
  // when supplied. This mirrors the P11-T01 dashboard
  // `priorEvents` hint and is the canonical way to use
  // `reducePortfolio` incrementally from a test or a
  // projection rebuild that wants to apply one event at a
  // time. When `priorEvents` is empty/missing and the
  // caller is iterating, the working state starts without
  // the priority cache — that's OK because the per-project
  // rollups already carry the *aggregate* priority totals
  // and band counts.
  const priorEvents = options.priorEvents ?? [];
  for (const prior of priorEvents) {
    replayOnePriorEvent(working, prior);
  }

  // Apply the new event.
  applyEvent(working, event);

  return finalizePortfolioState(
    working,
    state.tenantId,
    workingScope,
    state.scope
  );
}

/**
 * Apply a single prior event to a working state. The
 * reducer has already cloned the per-project rollups from
 * the prior public projection state, so `replayOnePriorEvent`
 * must NOT re-apply the task event handlers (those would
 * double-count totals). Instead, it only rebuilds the
 * per-task priority cache and the per-aggregate live state
 * map that is internal to the reducer and never persists
 * to the public state.
 */
function replayOnePriorEvent(
  working: MutablePortfolioWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || !isRecord(payload)) return;
  switch (event.eventType) {
    case "task.created": {
      const projectId = readProjectIdFromPayload(payload);
      const taskId = readTaskIdFromPayload(payload);
      if (!projectId || !taskId) return;
      const aggregateId = `task:${projectId}:${taskId}`;
      const fromStatus = readFromStatusFromPayload(payload) ?? "queued";
      const priority = readPriorityFromPayload(payload) ?? 0;
      working.currentTaskStatusByAggregateId.set(aggregateId, fromStatus);
      working.currentPriorityByAggregateId.set(aggregateId, priority);
      working.currentProjectIdByAggregateId.set(
        aggregateId,
        projectId as ProjectId
      );
      break;
    }
    case "task.transitioned": {
      const projectId = readProjectIdFromPayload(payload);
      const taskId = readTaskIdFromPayload(payload);
      if (!projectId || !taskId) return;
      const aggregateId = `task:${projectId}:${taskId}`;
      const toStatus = readToStatusFromPayload(payload);
      if (!toStatus) return;
      working.currentTaskStatusByAggregateId.set(aggregateId, toStatus);
      break;
    }
    case "task.priority_changed": {
      const projectId = readProjectIdFromPayload(payload);
      const taskId = readTaskIdFromPayload(payload);
      if (!projectId || !taskId) return;
      const aggregateId = `task:${projectId}:${taskId}`;
      const priority = readPriorityFromPayload(payload);
      if (priority === null) return;
      working.currentPriorityByAggregateId.set(aggregateId, priority);
      break;
    }
    case "task.deleted": {
      const projectId = readProjectIdFromPayload(payload);
      const taskId = readTaskIdFromPayload(payload);
      if (!projectId || !taskId) return;
      const aggregateId = `task:${projectId}:${taskId}`;
      working.currentTaskStatusByAggregateId.delete(aggregateId);
      working.currentPriorityByAggregateId.delete(aggregateId);
      working.currentProjectIdByAggregateId.delete(aggregateId);
      break;
    }
    case "task.superseded": {
      const projectId = readProjectIdFromPayload(payload);
      const taskId = readTaskIdFromPayload(payload);
      if (!projectId || !taskId) return;
      const aggregateId = `task:${projectId}:${taskId}`;
      working.currentTaskStatusByAggregateId.set(aggregateId, "superseded");
      working.currentProjectIdByAggregateId.set(
        aggregateId,
        projectId as ProjectId
      );
      break;
    }
    case "task.linked": {
      // Cross-project edges live in the prior public
      // state (`state.dependencyEdges`) and have already
      // been cloned into `working.dependencyEdges` by
      // `reducePortfolio`. Replaying them here would
      // double-count `crossProjectDependencyCount`.
      break;
    }
    default:
      // Non-task events do not affect the per-task live
      // cache; the dependency map is rebuilt by the new
      // event's handler when needed.
      break;
  }
}

function cloneMutableRollup(rollup: PortfolioProjectRollup): MutableProjectRollup {
  return {
    projectId: rollup.projectId,
    taskStatusCounts: { ...rollup.taskStatusCounts },
    aggregateKindCounts: { ...rollup.aggregateKindCounts },
    taskCount: rollup.taskCount,
    terminalTaskCount: rollup.terminalTaskCount,
    activeTaskCount: rollup.activeTaskCount,
    blockedTaskCount: rollup.blockedTaskCount,
    totalPriority: rollup.totalPriority,
    maxPriority: rollup.maxPriority,
    priorityBands: { ...rollup.priorityBands },
    claimedTaskCount: rollup.claimedTaskCount,
    lastEventType: rollup.lastEventType,
    lastGlobalSequence: rollup.lastGlobalSequence,
    lastOccurredAt: rollup.lastOccurredAt,
    lastReleaseObservationStatus: rollup.lastReleaseObservationStatus,
    lastApprovalVerdict: rollup.lastApprovalVerdict
  };
}

function cloneMutableEdge(edge: PortfolioDependencyEdge): MutableDependencyEdge {
  return {
    relation: edge.relation,
    fromProjectId: edge.fromProjectId,
    fromTaskId: edge.fromTaskId,
    toProjectId: edge.toProjectId,
    toTaskId: edge.toTaskId,
    firstObservedAt: edge.firstObservedAt,
    lastObservedAt: edge.lastObservedAt,
    lastGlobalSequence: edge.lastGlobalSequence,
    eventCount: edge.eventCount
  };
}

function applyEvent(
  working: MutablePortfolioWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || !isRecord(payload)) return;

  switch (event.eventType) {
    case "task.created":
      applyTaskCreated(working, payload);
      break;
    case "task.transitioned":
      applyTaskTransitioned(working, payload);
      break;
    case "task.priority_changed":
      applyTaskPriorityChanged(working, payload);
      break;
    case "task.deleted":
      applyTaskDeleted(working, payload);
      break;
    case "task.superseded":
      applyTaskSuperseded(working, payload);
      break;
    case "task.linked":
      applyTaskLinked(working, payload);
      break;
    default:
      if (isWholeChangeEventType(event.eventType)) {
        applyChangeEvent(working, payload);
      } else if (isReleaseObservationEventType(event.eventType)) {
        applyReleaseEvent(working, payload);
      }
      break;
  }
  applyEventToRollupHeader(working, event);

  working.rebuiltThroughGlobalSequence = event.globalSequence;
  working.eventCount += 1;
}

// ---------------------------------------------------------------------------
// Finalizer
// ---------------------------------------------------------------------------

function finalizePortfolioState(
  working: MutablePortfolioWorkingState,
  tenantId: TenantId,
  workingScope: PortfolioScope,
  publicScope: readonly ProjectId[]
): PortfolioProjectionState {
  const projectRollups: Record<ProjectId, PortfolioProjectRollup> = {};
  const priorityBandsByProject: Record<
    ProjectId,
    Record<PortfolioPriorityBand, number>
  > = {};
  const claimUtilizationByProject: Record<ProjectId, number> = {};
  const blockedPressureByProject: Record<ProjectId, number> = {};
  const aggregate: Record<PortfolioPriorityBand, number> = {
    high: 0,
    mid: 0,
    low: 0
  };

  let terminalProjectCount = 0;

  // Aggregate the per-project priority bands. We sum the
  // frozen band counts from each project rollup so the
  // cross-project ledger stays consistent with the
  // per-project rollup — no private counter cache leaks
  // into the public state. This means an incremental
  // reducer caller (one event at a time) still produces
  // the same aggregate the full-log caller would.
  for (const [projectId, rollup] of working.projectRollups.entries()) {
    projectRollups[projectId] = cloneProjectRollup(rollup);
    priorityBandsByProject[projectId] = { ...rollup.priorityBands };
    claimUtilizationByProject[projectId] = rollup.claimedTaskCount;
    blockedPressureByProject[projectId] = rollup.blockedTaskCount;
    if (
      rollup.taskCount > 0 &&
      rollup.terminalTaskCount === rollup.taskCount
    ) {
      terminalProjectCount += 1;
    }
  }
  for (const [projectId, bands] of Object.entries(priorityBandsByProject)) {
    aggregate.high += bands.high ?? 0;
    aggregate.mid += bands.mid ?? 0;
    aggregate.low += bands.low ?? 0;
  }

  const dependencyEdges: PortfolioDependencyEdge[] = [];
  for (const edge of working.dependencyEdges.values()) {
    dependencyEdges.push(
      Object.freeze({
        relation: edge.relation,
        fromProjectId: edge.fromProjectId,
        fromTaskId: edge.fromTaskId,
        toProjectId: edge.toProjectId,
        toTaskId: edge.toTaskId,
        firstObservedAt: edge.firstObservedAt,
        lastObservedAt: edge.lastObservedAt,
        lastGlobalSequence: edge.lastGlobalSequence,
        eventCount: edge.eventCount
      }) as PortfolioDependencyEdge
    );
  }

  // The public projection state freezes the scope as a
  // sorted array snapshot. We pull from the public scope
  // (the caller's source of truth) so the snapshot is
  // canonical regardless of the working state shape.
  const scopeSnapshot: readonly ProjectId[] =
    publicScope.length === 0
      ? Object.freeze([] as ProjectId[])
      : (Object.freeze(
          [...publicScope].sort() as ProjectId[]
        ) as readonly ProjectId[]);

  return Object.freeze({
    schemaVersion: PORTFOLIO_ADAPTER_SCHEMA_VERSION,
    kind: PORTFOLIO_ADAPTER_KIND,
    tenantId,
    scope: scopeSnapshot,
    rebuiltThroughGlobalSequence: working.rebuiltThroughGlobalSequence,
    eventCount: working.eventCount,
    projectRollups: Object.freeze(projectRollups),
    dependencyEdges: Object.freeze(dependencyEdges),
    resourceLedger: Object.freeze({
      priorityBands: Object.freeze(aggregate),
      priorityBandsByProject: Object.freeze(priorityBandsByProject),
      claimUtilizationByProject: Object.freeze(claimUtilizationByProject),
      blockedPressureByProject: Object.freeze(blockedPressureByProject)
    }),
    crossProjectDependencyCount: working.crossProjectDependencyCount,
    terminalProjectCount
  }) as PortfolioProjectionState;
}

// ---------------------------------------------------------------------------
// Public replay helper (used by the SQLite projector)
// ---------------------------------------------------------------------------

export interface ReplayPortfolioOptions {
  readonly tenantId: TenantId;
  readonly scope?: PortfolioScope;
}

/**
 * Replay the full event log through the portfolio reducer.
 * Mirrors the P11-T01 `replayDashboard` / `replayApprovalGate`
 * shape so the SQLite projector can wrap it in the standard
 * projection-store flow.
 */
export function replayPortfolio(
  events: readonly BoardEvent[],
  options: ReplayPortfolioOptions
): PortfolioProjectionState {
  let state: PortfolioProjectionState | null = makeInitialPortfolioState(
    options.tenantId,
    options.scope ?? null
  );
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) continue;
    state = reducePortfolio(state, event, {
      tenantId: options.tenantId,
      scope: options.scope ?? null,
      priorEvents: events.slice(0, i)
    });
  }
  return state ?? makeInitialPortfolioState(options.tenantId, options.scope ?? null);
}

/**
 * Factory for the portfolio reducer descriptor. Mirrors
 * the P11-T01 dashboard reducer factory so the descriptor
 * can drop into `SqliteBoardProjectionRebuilder` unchanged.
 */
export function makePortfolioReducer(
  options: ReducePortfolioOptions
): PortfolioReducer {
  const tenantId = options.tenantId;
  const scope = options.scope ?? null;
  if (!tenantId) {
    throw new Error("makePortfolioReducer requires a tenantId");
  }
  return (state, event) => {
    if (state === null) {
      state = makeInitialPortfolioState(tenantId, scope);
    }
    return reducePortfolio(state, event);
  };
}

export interface PortfolioProjectionDescriptorOptions {
  readonly tenantId: TenantId;
  readonly scope?: PortfolioScope;
}

/**
 * Build a portfolio projection descriptor. Mirrors the
 * P11-T01 dashboard descriptor so the SQLite projector
 * can wrap the portfolio reducer in the standard
 * projection-store flow.
 */
export function portfolioProjectionDescriptor(
  options: PortfolioProjectionDescriptorOptions
): PortfolioProjectionDescriptor {
  const tenantId = options.tenantId;
  const scope = options.scope ?? null;
  const initial = makeInitialPortfolioState(tenantId, scope);
  return {
    projectionKey: portfolioProjectionKey(tenantId),
    projectionVersion: 1 as const,
    initialState: initial,
    reduce: makePortfolioReducer({ tenantId, scope })
  };
}

// ---------------------------------------------------------------------------
// Re-exports for barrel consumption
// ---------------------------------------------------------------------------

export {
  PORTFOLIO_ADAPTER_KIND,
  PORTFOLIO_ADAPTER_SCHEMA_VERSION,
  PORTFOLIO_DEPENDENCY_RELATIONS,
  PORTFOLIO_PROJECTION_KEY_PREFIX,
  PORTFOLIO_PROJECTION_VERSION,
  asTenantId,
  isPortfolioProjectionState,
  makeInitialPortfolioState,
  parsePortfolioProjectionKey,
  portfolioEdgeKey,
  portfolioPriorityBand,
  portfolioProjectionKey
} from "./contract.js";

// `ReducePortfolioOptions` is declared in `./contract.ts`
// so the reducer's type signature can reference it without
// a circular import on `./reducer.js`. Re-export it here
// for callers that import it from the reducer barrel.
export type { ReducePortfolioOptions } from "./contract.js";

export type {
  PortfolioAdapterKey,
  PortfolioAggregateId,
  PortfolioDependencyEdge,
  PortfolioDependencyRelation,
  PortfolioPriorityBand,
  PortfolioProjectionDescriptor,
  PortfolioProjectionState,
  PortfolioProjectRollup,
  PortfolioReducer,
  PortfolioResourceLedger,
  PortfolioRollupAggregateKind,
  PortfolioScope,
  TenantId
} from "./contract.js";
