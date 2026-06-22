/**
 * P11-T01 — Approval-gate projection reducer tests.
 *
 * Mirrors the P09-T02 / P10-T01 reducer test style: pure
 * node:test assertions over the frozen
 * `ApprovalGateProjectionState` shape produced by the
 * `reduceApprovalGate` / `replayApprovalGate` reducer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalGateProjectionKey,
  parseApprovalGateProjectionKey,
  APPROVAL_GATE_ADAPTER_KIND,
  APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
  APPROVAL_GATE_PROJECTION_KEY_PREFIX,
  APPROVAL_GATE_PROJECTION_VERSION,
  APPROVAL_GATE_VERDICTS,
  makeInitialApprovalGateState,
  isApprovalGateProjectionState,
  reduceApprovalGate,
  replayApprovalGate,
  makeApprovalGateReducer,
  decideApprovalGateVerdict,
  APPROVAL_GATE_REDUCER_KIND
} from "@legion/board";

import {
  APPROVAL_GATE_FIXTURE_CONSTANTS,
  makeAggregatedAcceptedEvent,
  makeAggregatedRejectedEvent,
  makeReleasePromotedEvent,
  makeReleaseRegressedEvent,
  makeChangeBlockedEvent,
  makeForeignChangeEvent
} from "./approval-gate-fixture.mjs";

test("approval-gate projection key has canonical shape", () => {
  const key = approvalGateProjectionKey("proj-foo-001", "chg-bar-002");
  assert.equal(key, "approval-gate:proj-foo-001:chg-bar-002");
  assert.ok(key.startsWith(`${APPROVAL_GATE_PROJECTION_KEY_PREFIX}:`));
  const parsed = parseApprovalGateProjectionKey(key);
  assert.equal(parsed?.projectId, "proj-foo-001");
  assert.equal(parsed?.changeId, "chg-bar-002");
  assert.equal(parseApprovalGateProjectionKey("not-a-gate-key"), null);
  assert.equal(parseApprovalGateProjectionKey("approval-gate:only"), null);
  assert.equal(parseApprovalGateProjectionKey("approval-gate:"), null);
});

test("approval-gate constants are stable", () => {
  assert.equal(APPROVAL_GATE_PROJECTION_VERSION, 1);
  assert.equal(APPROVAL_GATE_ADAPTER_KIND, "approval-gate-adapter");
  assert.equal(APPROVAL_GATE_ADAPTER_SCHEMA_VERSION, "1.0.0");
  assert.equal(APPROVAL_GATE_REDUCER_KIND, "approval-gate-adapter");
  assert.deepEqual(APPROVAL_GATE_VERDICTS, [
    "approved",
    "rejected",
    "blocked",
    "pending"
  ]);
});

test("makeInitialApprovalGateState seeds a frozen empty state", () => {
  const initial = makeInitialApprovalGateState("proj-x", "chg-x");
  assert.equal(initial.kind, APPROVAL_GATE_ADAPTER_KIND);
  assert.equal(initial.projectId, "proj-x");
  assert.equal(initial.changeId, "chg-x");
  assert.equal(initial.verdict, "pending");
  assert.equal(initial.eventCount, 0);
  assert.equal(initial.releaseObservationStatus, "absent");
  assert.equal(initial.wholeChangeStatus, "absent");
  assert.equal(initial.mergeQueueHash, null);
  assert.equal(initial.lastEventType, null);
  assert.ok(isApprovalGateProjectionState(initial));
});

test("isApprovalGateProjectionState rejects malformed input", () => {
  assert.equal(isApprovalGateProjectionState(null), false);
  assert.equal(isApprovalGateProjectionState({}), false);
  assert.equal(
    isApprovalGateProjectionState({ kind: "not-approval-gate" }),
    false
  );
  assert.equal(
    isApprovalGateProjectionState({
      kind: APPROVAL_GATE_ADAPTER_KIND,
      projectId: 42,
      changeId: "chg",
      verdict: "approved",
      eventCount: 0,
      lastGlobalSequence: 0
    }),
    false
  );
});

test("reduceApprovalGate: pending on no events", () => {
  assert.equal(reduceApprovalGate(null, {}), null);
});

test("reduceApprovalGate: change.aggregated(status=accepted) → pending until release", () => {
  const event = makeAggregatedAcceptedEvent({ globalSequence: 1 });
  const next = reduceApprovalGate(null, event);
  assert.ok(next !== null);
  assert.equal(next.wholeChangeStatus, "accepted");
  // Without a release.promoted event, the verdict stays pending.
  assert.equal(next.verdict, "pending");
  assert.equal(next.releaseObservationStatus, "absent");
});

test("reduceApprovalGate: change.aggregated + release.promoted → approved", () => {
  const aggregated = makeAggregatedAcceptedEvent({ globalSequence: 1 });
  const promoted = makeReleasePromotedEvent({ globalSequence: 2 });
  const stateA = reduceApprovalGate(null, aggregated);
  const stateB = reduceApprovalGate(stateA, promoted);
  assert.ok(stateB !== null);
  assert.equal(stateB.verdict, "approved");
  assert.equal(stateB.releaseObservationStatus, "promoted");
  assert.equal(stateB.mergeQueueHash, APPROVAL_GATE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(stateB.decisionSha256, APPROVAL_GATE_FIXTURE_CONSTANTS.decisionSha256);
  assert.equal(stateB.aggregatorHash, APPROVAL_GATE_FIXTURE_CONSTANTS.aggregatorHash);
});

test("reduceApprovalGate: change.aggregated(status=rejected) → rejected", () => {
  const event = makeAggregatedRejectedEvent({ globalSequence: 1 });
  const next = reduceApprovalGate(null, event);
  assert.ok(next !== null);
  assert.equal(next.verdict, "rejected");
  assert.equal(next.wholeChangeStatus, "rejected");
});

test("reduceApprovalGate: change.aggregated(status=blocked) → blocked", () => {
  const event = makeChangeBlockedEvent({ globalSequence: 1 });
  const next = reduceApprovalGate(null, event);
  assert.ok(next !== null);
  assert.equal(next.verdict, "blocked");
  assert.equal(next.wholeChangeStatus, "blocked");
});

test("reduceApprovalGate: release.regressed rolls back to rejected", () => {
  const aggregated = makeAggregatedAcceptedEvent({ globalSequence: 1 });
  const promoted = makeReleasePromotedEvent({ globalSequence: 2 });
  const regressed = makeReleaseRegressedEvent({ globalSequence: 3 });
  const stateA = reduceApprovalGate(null, aggregated);
  const stateB = reduceApprovalGate(stateA, promoted);
  const stateC = reduceApprovalGate(stateB, regressed);
  assert.ok(stateC !== null);
  assert.equal(stateC.verdict, "rejected");
  assert.equal(stateC.releaseObservationStatus, "regressed");
  assert.match(stateC.reason, /error rate spike/);
});

test("reduceApprovalGate: foreign project/change events are dropped", () => {
  const ours = makeAggregatedAcceptedEvent({ globalSequence: 1 });
  const foreign = makeForeignChangeEvent({ globalSequence: 2 });
  const stateA = reduceApprovalGate(null, ours);
  const stateB = reduceApprovalGate(stateA, foreign);
  assert.ok(stateB !== null);
  // The foreign event must not contaminate this gate's
  // verdict: it belongs to a different (projectId, changeId).
  assert.equal(stateB.verdict, "pending");
  assert.equal(stateB.eventCount, 1);
});

test("reduceApprovalGate: task events are ignored", () => {
  const state = reduceApprovalGate(null, {
    aggregateKind: "task",
    eventType: "task.transitioned",
    payload: { projectId: "proj-x", changeId: "chg-x", toStatus: "ready" },
    globalSequence: 1,
    eventId: "evt-task-1",
    occurredAt: "2026-06-22T05:00:00.000Z"
  });
  assert.equal(state, null);
});

test("reduceApprovalGate: malformed payload yields no state change", () => {
  const state = reduceApprovalGate(null, {
    aggregateKind: "whole_change",
    eventType: "change.aggregated",
    payload: { /* missing changeId */ status: "accepted" },
    globalSequence: 1,
    eventId: "evt-malformed",
    occurredAt: "2026-06-22T05:00:00.000Z"
  });
  assert.equal(state, null);
});

test("replayApprovalGate: full approval flow", () => {
  const events = [
    makeAggregatedAcceptedEvent({ globalSequence: 1 }),
    makeReleasePromotedEvent({ globalSequence: 2 })
  ];
  const state = replayApprovalGate(events);
  assert.ok(state !== null);
  assert.equal(state.verdict, "approved");
  assert.equal(state.eventCount, 2);
});

test("replayApprovalGate: deterministic replay", () => {
  const events = [
    makeAggregatedAcceptedEvent({ globalSequence: 1 }),
    makeReleasePromotedEvent({ globalSequence: 2 })
  ];
  const stateA = replayApprovalGate(events);
  const stateB = replayApprovalGate(events);
  assert.deepEqual(stateA, stateB);
});

test("decideApprovalGateVerdict: top-level verdict helper", () => {
  const events = [
    makeAggregatedAcceptedEvent({ globalSequence: 1 }),
    makeReleasePromotedEvent({ globalSequence: 2 })
  ];
  assert.equal(decideApprovalGateVerdict(events), "approved");

  const rejectedEvents = [makeAggregatedRejectedEvent({ globalSequence: 1 })];
  assert.equal(decideApprovalGateVerdict(rejectedEvents), "rejected");

  const blockedEvents = [makeChangeBlockedEvent({ globalSequence: 1 })];
  assert.equal(decideApprovalGateVerdict(blockedEvents), "blocked");

  assert.equal(decideApprovalGateVerdict([]), "pending");
});

test("makeApprovalGateReducer: returns a reducer compatible with the projection shape", () => {
  const reducer = makeApprovalGateReducer();
  const event = makeAggregatedAcceptedEvent({ globalSequence: 1 });
  const result = reducer(null, event);
  assert.ok(result !== null);
  assert.equal(result.wholeChangeStatus, "accepted");
});

test("reduceApprovalGate: release.observed is non-terminal (timeline only)", () => {
  const observed = {
    aggregateKind: "release_observation",
    eventType: "release.observed",
    payload: {
      projectId: APPROVAL_GATE_FIXTURE_CONSTANTS.projectId,
      changeId: APPROVAL_GATE_FIXTURE_CONSTANTS.changeId,
      mergeQueueHash: APPROVAL_GATE_FIXTURE_CONSTANTS.mergeQueueHash,
      reportSha256: APPROVAL_GATE_FIXTURE_CONSTANTS.reportSha256,
      observedAt: "2026-06-22T05:20:00.000Z"
    },
    globalSequence: 1,
    eventId: "evt-rel-obs",
    occurredAt: "2026-06-22T05:20:00.000Z"
  };
  const state = reduceApprovalGate(null, observed);
  assert.ok(state !== null);
  assert.equal(state.verdict, "pending");
  assert.equal(state.releaseObservationStatus, "absent");
  assert.equal(state.eventCount, 1);
});

test("reduceApprovalGate: ignore foreign aggregateKind", () => {
  // A release.promoted event with aggregateKind != "release_observation"
  // must be ignored by the foreign-event guard.
  const event = makeReleasePromotedEvent({ globalSequence: 1 });
  const badEvent = {
    ...event,
    aggregateKind: "task",
    eventId: "evt-rel-bad-agg"
  };
  const state = reduceApprovalGate(null, badEvent);
  assert.equal(state, null);
});

test("APPROVAL_GATE_FIXTURE_CONSTANTS are stable", () => {
  assert.ok(APPROVAL_GATE_FIXTURE_CONSTANTS.projectId.startsWith("proj-"));
  assert.ok(APPROVAL_GATE_FIXTURE_CONSTANTS.changeId.startsWith("chg-"));
  assert.match(APPROVAL_GATE_FIXTURE_CONSTANTS.mergeQueueHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(APPROVAL_GATE_FIXTURE_CONSTANTS.decisionSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(APPROVAL_GATE_FIXTURE_CONSTANTS.aggregatorHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(APPROVAL_GATE_FIXTURE_CONSTANTS.reportSha256, /^sha256:[0-9a-f]{64}$/);
});