/**
 * P11-T01 — Pure reducer for the approval-gate projection.
 *
 * The approval-gate reducer walks the append-only board event
 * log once and produces the frozen
 * `ApprovalGateProjectionState` for a single
 * `(projectId, changeId)` pair. It mirrors the P09-T02 /
 * P10-T01 reducer shape so the SQLite projector can wrap it
 * in the standard projection-store flow.
 *
 * Verdict reduction (fail-closed):
 *
 *  - `change.aggregated` with payload `status=accepted`
 *      → whole-change status `accepted`; do NOT yet emit
 *        `approved` verdict (release-observation has to
 *        land first).
 *  - `change.aggregated` with payload `status=rejected`
 *      → verdict `rejected` (terminal).
 *  - `change.aggregated` with payload `status=blocked`
 *      → verdict `blocked` (terminal).
 *  - `change.accepted` → verdict `approved` if
 *      release-observation has been `promoted`; otherwise
 *      verdict remains `pending` (the change is accepted at
 *      the gate level; release observation may still fail).
 *  - `change.rejected` → verdict `rejected` (terminal).
 *  - `change.blocked` / `change.escalated` → verdict
 *      `blocked` (terminal).
 *  - `release.observing` → release status `observing`;
 *      verdict remains `pending`.
 *  - `release.observed` → ignored for the verdict (timeline
 *      only).
 *  - `release.promoted` → release status `promoted`; if
 *      whole-change status is `accepted`, verdict becomes
 *      `approved` (terminal). Otherwise verdict remains
 *      `pending`.
 *  - `release.regressed` / `release.rolled_back` → verdict
 *      `rejected` (terminal) and release status reflects
 *      the regressed/rolled_back value.
 *
 * Foreign events (wrong `aggregateKind` / `eventType` /
 * missing payload fields / mismatching `projectId` /
 * `changeId`) are ignored silently so the reducer replays
 * an interleaved board event log without throwing.
 *
 * The reducer is pure: same event log ⇒ same state.
 */

import type { BoardEvent, BoardEventType } from "@legion/board-store";

import {
  APPROVAL_GATE_ADAPTER_KIND,
  APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
  makeInitialApprovalGateState,
  type ApprovalGateProjectionState,
  type ApprovalGateReducer,
  type ApprovalGateVerdict
} from "./contract.js";

import type {
  ChangeId,
  ContentHash,
  ProjectId,
  UtcTimestamp
} from "@legion/protocol";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MutableApprovalGateWorkingState {
  schemaVersion: typeof APPROVAL_GATE_ADAPTER_SCHEMA_VERSION;
  kind: typeof APPROVAL_GATE_ADAPTER_KIND;
  projectId: ProjectId;
  changeId: ChangeId;
  verdict: ApprovalGateVerdict;
  mergeQueueHash: ContentHash | null;
  decisionSha256: ContentHash | null;
  aggregatorHash: ContentHash | null;
  releaseObservationReportSha256: ContentHash | null;
  releaseObservationStatus:
    | "observing"
    | "promoted"
    | "regressed"
    | "rolled_back"
    | "absent";
  lastEventType: BoardEventType | null;
  lastGlobalSequence: number;
  lastOccurredAt: UtcTimestamp | null;
  reason: string;
  eventCount: number;
  wholeChangeStatus: "accepted" | "rejected" | "blocked" | "absent";
  wholeChangeOutcome: "integrated" | "rejected" | "escalated" | "blocked" | "absent";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readProjectId(event: BoardEvent): string | null {
  if (!event.payload || typeof event.payload !== "object") return null;
  const projectId = (event.payload as Record<string, unknown>)["projectId"];
  return isString(projectId) && projectId.length > 0 ? projectId : null;
}

function readChangeId(event: BoardEvent): string | null {
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

function isWholeChangeEventType(eventType: BoardEventType): boolean {
  return (
    eventType === "change.aggregated" ||
    eventType === "change.accepted" ||
    eventType === "change.rejected" ||
    eventType === "change.blocked" ||
    eventType === "change.escalated"
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

function freezeState(
  working: MutableApprovalGateWorkingState
): ApprovalGateProjectionState {
  return {
    schemaVersion: working.schemaVersion,
    kind: working.kind,
    projectId: working.projectId,
    changeId: working.changeId,
    verdict: working.verdict,
    mergeQueueHash: working.mergeQueueHash,
    decisionSha256: working.decisionSha256,
    aggregatorHash: working.aggregatorHash,
    releaseObservationReportSha256: working.releaseObservationReportSha256,
    releaseObservationStatus: working.releaseObservationStatus,
    lastEventType: working.lastEventType,
    lastGlobalSequence: working.lastGlobalSequence,
    lastOccurredAt: working.lastOccurredAt,
    reason: working.reason,
    eventCount: working.eventCount,
    wholeChangeStatus: working.wholeChangeStatus,
    wholeChangeOutcome: working.wholeChangeOutcome
  };
}

/**
 * Promote the working state to `approved` if the whole-change
 * is accepted AND release observation has been promoted.
 * Terminal — once approved, only release.regressed /
 * release.rolled_back can move the verdict off `approved`
 * (handled in `applyReleaseObservationEvent`).
 */
function maybeApprove(working: MutableApprovalGateWorkingState): void {
  if (working.verdict === "approved") return;
  if (working.wholeChangeStatus === "accepted" && working.releaseObservationStatus === "promoted") {
    working.verdict = "approved";
    working.reason = "whole-change accepted and release promoted";
  }
}

function applyWholeChangeEvent(
  working: MutableApprovalGateWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown>;
  const mergeQueueHash = readContentHashField(payload, "mergeQueueHash");
  const decisionSha256 = readContentHashField(payload, "decisionSha256");
  const aggregatorHash = readContentHashField(payload, "aggregatorHash");
  const reason = readStringField(payload, "reason") ?? "";
  const outcome = readStringField(payload, "outcome");

  // Update trace-back handles (keep latest).
  if (mergeQueueHash !== null) working.mergeQueueHash = mergeQueueHash as ContentHash;
  if (decisionSha256 !== null) working.decisionSha256 = decisionSha256 as ContentHash;
  if (aggregatorHash !== null) working.aggregatorHash = aggregatorHash as ContentHash;
  if (outcome !== null && (
    outcome === "integrated" ||
    outcome === "rejected" ||
    outcome === "escalated" ||
    outcome === "blocked"
  )) {
    working.wholeChangeOutcome = outcome;
  }

  switch (event.eventType) {
    case "change.aggregated": {
      const status = readStringField(payload, "status");
      if (status === "accepted") {
        working.wholeChangeStatus = "accepted";
        // Don't promote to approved until release observation
        // lands. Verdict stays pending or current terminal value.
        maybeApprove(working);
      } else if (status === "rejected") {
        working.wholeChangeStatus = "rejected";
        working.verdict = "rejected";
      } else if (status === "blocked") {
        working.wholeChangeStatus = "blocked";
        working.verdict = "blocked";
      }
      if (reason.length > 0) working.reason = reason;
      break;
    }
    case "change.accepted": {
      working.wholeChangeStatus = "accepted";
      maybeApprove(working);
      if (reason.length > 0) working.reason = reason;
      break;
    }
    case "change.rejected": {
      working.wholeChangeStatus = "rejected";
      working.verdict = "rejected";
      if (reason.length > 0) working.reason = reason;
      break;
    }
    case "change.blocked":
    case "change.escalated": {
      working.wholeChangeStatus = "blocked";
      working.verdict = "blocked";
      if (reason.length > 0) working.reason = reason;
      break;
    }
    default:
      // Other event types are not whole-change — should not
      // reach this branch.
      break;
  }
}

function applyReleaseObservationEvent(
  working: MutableApprovalGateWorkingState,
  event: BoardEvent
): void {
  const payload = event.payload as Record<string, unknown>;
  const mergeQueueHash = readContentHashField(payload, "mergeQueueHash");
  const reportSha256 = readContentHashField(payload, "reportSha256");
  const reason = readStringField(payload, "reason") ?? "";
  const failureReason = readStringField(payload, "failureReason") ?? "";

  if (mergeQueueHash !== null) working.mergeQueueHash = mergeQueueHash as ContentHash;
  if (reportSha256 !== null)
    working.releaseObservationReportSha256 = reportSha256 as ContentHash;

  switch (event.eventType) {
    case "release.observing": {
      working.releaseObservationStatus = "observing";
      break;
    }
    case "release.observed": {
      // Non-terminal observation log entry: do not move the
      // verdict. Treat as a no-op for status purposes.
      break;
    }
    case "release.promoted": {
      working.releaseObservationStatus = "promoted";
      maybeApprove(working);
      if (reason.length > 0) working.reason = reason;
      break;
    }
    case "release.regressed": {
      working.releaseObservationStatus = "regressed";
      // Regression after promotion rolls the verdict back to
      // rejected so the operator sees the regression even if
      // the change had been approved moments before.
      working.verdict = "rejected";
      if (failureReason.length > 0) working.reason = failureReason;
      else if (reason.length > 0) working.reason = reason;
      break;
    }
    case "release.rolled_back": {
      working.releaseObservationStatus = "rolled_back";
      working.verdict = "rejected";
      if (failureReason.length > 0) working.reason = failureReason;
      else if (reason.length > 0) working.reason = reason;
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reduce a single board event into the approval-gate
 * projection. Pure: same state + same event ⇒ same next
 * state. Foreign events (wrong `aggregateKind` /
 * `eventType` / missing payload fields / mismatching
 * `projectId` / `changeId`) are ignored silently.
 */
export function reduceApprovalGate(
  state: ApprovalGateProjectionState | null,
  event: BoardEvent
): ApprovalGateProjectionState | null {
  if (!event || typeof event !== "object") return state;
  if (!event.payload || typeof event.payload !== "object") return state;

  const eventProjectId = readProjectId(event);
  const eventChangeId = readChangeId(event);
  if (eventProjectId === null || eventChangeId === null) return state;

  // Foreign event for a different project/change pair: do not
  // contaminate this approval-gate's state. The reducer is
  // strictly scoped to its (projectId, changeId) tuple.
  if (
    state !== null &&
    (state.projectId !== eventProjectId || state.changeId !== eventChangeId)
  ) {
    return state;
  }

  const projectId: ProjectId = (state?.projectId ?? eventProjectId) as ProjectId;
  const changeId: ChangeId = (state?.changeId ?? eventChangeId) as ChangeId;

  // Only whole-change + release-observation events move the
  // gate. Other event types are recorded in the timeline
  // upstream (the dashboard) but ignored here.
  if (
    !isWholeChangeEventType(event.eventType) &&
    !isReleaseObservationEventType(event.eventType)
  ) {
    return state;
  }

  // Also ignore whole-change / release-observation events
  // whose aggregateKind doesn't match the canonical surface
  // — same foreign-event safety as the dashboard.
  if (
    (isWholeChangeEventType(event.eventType) &&
      event.aggregateKind !== "whole_change") ||
    (isReleaseObservationEventType(event.eventType) &&
      event.aggregateKind !== "release_observation")
  ) {
    return state;
  }

  const working: MutableApprovalGateWorkingState = state
    ? {
        schemaVersion: state.schemaVersion,
        kind: state.kind,
        projectId: state.projectId,
        changeId: state.changeId,
        verdict: state.verdict,
        mergeQueueHash: state.mergeQueueHash,
        decisionSha256: state.decisionSha256,
        aggregatorHash: state.aggregatorHash,
        releaseObservationReportSha256: state.releaseObservationReportSha256,
        releaseObservationStatus: state.releaseObservationStatus,
        lastEventType: state.lastEventType,
        lastGlobalSequence: state.lastGlobalSequence,
        lastOccurredAt: state.lastOccurredAt,
        reason: state.reason,
        eventCount: state.eventCount,
        wholeChangeStatus: state.wholeChangeStatus,
        wholeChangeOutcome: state.wholeChangeOutcome
      }
    : {
        schemaVersion: APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
        kind: APPROVAL_GATE_ADAPTER_KIND,
        projectId,
        changeId,
        verdict: "pending",
        mergeQueueHash: null,
        decisionSha256: null,
        aggregatorHash: null,
        releaseObservationReportSha256: null,
        releaseObservationStatus: "absent",
        lastEventType: null,
        lastGlobalSequence: -1,
        lastOccurredAt: null,
        reason: "",
        eventCount: 0,
        wholeChangeStatus: "absent",
        wholeChangeOutcome: "absent"
      };

  working.eventCount += 1;
  working.lastEventType = event.eventType;
  working.lastGlobalSequence = event.globalSequence;
  working.lastOccurredAt = event.occurredAt as UtcTimestamp;

  if (isWholeChangeEventType(event.eventType)) {
    applyWholeChangeEvent(working, event);
  } else if (isReleaseObservationEventType(event.eventType)) {
    applyReleaseObservationEvent(working, event);
  }

  return freezeState(working);
}

/**
 * Replay a stream of board events into the final
 * approval-gate projection state. Pure, side-effect free.
 * Mirrors the `replayWholeChangeAcceptance` /
 * `replayReleaseObservation` helpers.
 */
export function replayApprovalGate(
  events: readonly BoardEvent[]
): ApprovalGateProjectionState | null {
  let state: ApprovalGateProjectionState | null = null;
  for (const event of events) {
    state = reduceApprovalGate(state, event);
  }
  return state;
}

/**
 * Adapter for `SqliteBoardProjectionRebuilder`. The
 * board-store surface types the reducer as `(state, event)
 * => state` (not nullable); we wrap the nullable reducer and
 * coerce the initial state back to the sentinel the
 * projector expects.
 */
export function makeApprovalGateReducer(): ApprovalGateReducer {
  return reduceApprovalGate;
}

/**
 * Pure decision helper: derive the verdict directly from a
 * board event stream without going through the reducer.
 * Exposed for unit tests and CLI side-checks.
 */
export function decideApprovalGateVerdict(
  events: readonly BoardEvent[]
): ApprovalGateVerdict {
  const final = replayApprovalGate(events);
  return final?.verdict ?? "pending";
}

// ---------------------------------------------------------------------------
// Sanity exports (for tests)
// ---------------------------------------------------------------------------

export const APPROVAL_GATE_REDUCER_KIND = APPROVAL_GATE_ADAPTER_KIND;
export const APPROVAL_GATE_REDUCER_KIND_LITERAL = APPROVAL_GATE_ADAPTER_KIND;

export type {
  ApprovalGateProjectionDescriptor,
  ApprovalGateProjectionState,
  ApprovalGateReducer,
  ApprovalGateVerdict
} from "./contract.js";
export {
  approvalGateProjectionKey,
  parseApprovalGateProjectionKey,
  makeInitialApprovalGateState,
  isApprovalGateProjectionState,
  APPROVAL_GATE_PROJECTION_KEY_PREFIX,
  APPROVAL_GATE_PROJECTION_VERSION,
  APPROVAL_GATE_VERDICTS,
  APPROVAL_GATE_ADAPTER_KIND,
  APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
  APPROVAL_GATE_ADAPTER_KEYS
} from "./contract.js";