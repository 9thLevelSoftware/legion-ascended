/**
 * P11-T01 — Dashboard projection reducer tests.
 *
 * Mirrors the P09-T02 / P10-T01 reducer test style: pure
 * node:test assertions over the frozen
 * `DashboardProjectionState` shape produced by the
 * `reduceDashboard` / `replayDashboard` reducer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardProjectionKey,
  parseDashboardProjectionKey,
  DASHBOARD_ADAPTER_KIND,
  DASHBOARD_ADAPTER_SCHEMA_VERSION,
  DASHBOARD_PROJECTION_KEY_PREFIX,
  DASHBOARD_PROJECTION_VERSION,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  DASHBOARD_MAX_TAIL_LIMIT,
  DASHBOARD_APPROVAL_VERDICTS,
  DASHBOARD_RELEASE_STATUSES,
  makeInitialDashboardState,
  isDashboardProjectionState,
  deriveDashboardProjectionStateHash,
  reduceDashboard,
  replayDashboard,
  makeDashboardReducer,
  DASHBOARD_REDUCER_KIND
} from "@legion/board";

import {
  DASHBOARD_FIXTURE_CONSTANTS,
  makeTaskCreatedEvent,
  makeTaskTransitionedEvent,
  makeChangeAggregatedEvent,
  makeReleasePromotedEvent,
  makeReleaseRegressedEvent,
  makeForeignProjectTaskEvent
} from "./dashboard-fixture.mjs";

test("dashboard projection key has canonical shape", () => {
  const key = dashboardProjectionKey("proj-foo-001");
  assert.equal(key, "dashboard:proj-foo-001");
  assert.ok(key.startsWith(`${DASHBOARD_PROJECTION_KEY_PREFIX}:`));
  assert.equal(parseDashboardProjectionKey(key)?.projectId, "proj-foo-001");
  assert.equal(parseDashboardProjectionKey("not-a-dashboard-key"), null);
  assert.equal(parseDashboardProjectionKey("dashboard:"), null);
});

test("dashboard projection version + schema constants are stable", () => {
  assert.equal(DASHBOARD_PROJECTION_VERSION, 1);
  assert.equal(DASHBOARD_ADAPTER_KIND, "dashboard-adapter");
  assert.equal(DASHBOARD_ADAPTER_SCHEMA_VERSION, "1.0.0");
  assert.equal(DASHBOARD_DEFAULT_TAIL_LIMIT, 25);
  assert.equal(DASHBOARD_MAX_TAIL_LIMIT, 200);
  assert.deepEqual(DASHBOARD_APPROVAL_VERDICTS, [
    "approved",
    "pending",
    "rejected",
    "blocked"
  ]);
  assert.deepEqual(DASHBOARD_RELEASE_STATUSES, [
    "observing",
    "promoted",
    "regressed",
    "rolled_back",
    "absent"
  ]);
});

test("makeInitialDashboardState seeds a frozen empty state", () => {
  const initial = makeInitialDashboardState("proj-empty-001");
  assert.equal(initial.kind, DASHBOARD_ADAPTER_KIND);
  assert.equal(initial.projectId, "proj-empty-001");
  assert.equal(initial.eventCount, 0);
  assert.deepEqual(initial.taskStatusCounts, {});
  assert.deepEqual(initial.aggregateKindCounts, {});
  assert.deepEqual(initial.releaseObservationPointers, []);
  assert.deepEqual(initial.approvalPointers, []);
  assert.deepEqual(initial.eventTimeline, []);
  assert.ok(isDashboardProjectionState(initial));
  // Mutable mutation must not affect the frozen shape.
  assert.equal(Object.isFrozen(initial.taskStatusCounts), true);
  assert.equal(Object.isFrozen(initial.eventTimeline), true);
});

test("isDashboardProjectionState rejects malformed input", () => {
  assert.equal(isDashboardProjectionState(null), false);
  assert.equal(isDashboardProjectionState({}), false);
  assert.equal(isDashboardProjectionState({ kind: "not-dashboard" }), false);
  assert.equal(
    isDashboardProjectionState({
      kind: DASHBOARD_ADAPTER_KIND,
      projectId: 42,
      eventCount: 0
    }),
    false
  );
});

test("reduceDashboard: task.created seeds queued counter", () => {
  const event = makeTaskCreatedEvent({
    taskId: "task-a",
    fromStatus: "queued",
    globalSequence: 1
  });
  const next = reduceDashboard(null, event);
  assert.ok(next !== null);
  assert.equal(next.eventCount, 1);
  assert.equal(next.taskStatusCounts.queued, 1);
  assert.equal(next.aggregateKindCounts.task, 1);
  assert.equal(next.eventTimeline.length, 1);
  assert.equal(next.eventTimeline[0].eventType, "task.created");
  assert.equal(next.eventTimeline[0].globalSequence, 1);
});

test("reduceDashboard: task.transitioned rolls the counter", () => {
  const created = makeTaskCreatedEvent({
    taskId: "task-b",
    fromStatus: "queued",
    globalSequence: 1
  });
  const transitioned = makeTaskTransitionedEvent({
    taskId: "task-b",
    fromStatus: "queued",
    toStatus: "ready",
    aggregateSequence: 2,
    globalSequence: 2
  });
  const stateA = reduceDashboard(null, created);
  // Incremental callers (tests) must supply priorEvents so
  // the per-task live state can be reconstructed. Production
  // callers (CLI projector) replay the full event log via
  // `replayDashboard` and never need this hint.
  const stateB = reduceDashboard(stateA, transitioned, {
    priorEvents: [created]
  });
  assert.ok(stateB !== null);
  assert.equal(stateB.taskStatusCounts.queued, undefined);
  assert.equal(stateB.taskStatusCounts.ready, 1);
  assert.equal(stateB.eventCount, 2);
});

test("reduceDashboard: change.aggregated seeds approval pointer", () => {
  const event = makeChangeAggregatedEvent({
    changeId: "chg-test-1",
    status: "accepted",
    globalSequence: 1
  });
  const next = reduceDashboard(null, event);
  assert.ok(next !== null);
  assert.equal(next.approvalPointers.length, 1);
  assert.equal(next.approvalPointers[0].verdict, "approved");
  assert.equal(next.approvalPointers[0].changeId, "chg-test-1");
});

test("reduceDashboard: change.aggregated(status=rejected) → rejected verdict", () => {
  const event = makeChangeAggregatedEvent({
    changeId: "chg-rejected-1",
    status: "rejected",
    outcome: "rejected",
    globalSequence: 1
  });
  const next = reduceDashboard(null, event);
  assert.ok(next !== null);
  assert.equal(next.approvalPointers[0].verdict, "rejected");
});

test("reduceDashboard: release.promoted seeds release pointer", () => {
  const event = makeReleasePromotedEvent({ globalSequence: 1 });
  const next = reduceDashboard(null, event);
  assert.ok(next !== null);
  assert.equal(next.releaseObservationPointers.length, 1);
  assert.equal(next.releaseObservationPointers[0].status, "promoted");
});

test("reduceDashboard: release.regressed keeps the pointer and updates verdict", () => {
  const promoted = makeReleasePromotedEvent({ globalSequence: 1 });
  const regressed = makeReleaseRegressedEvent({ globalSequence: 2 });
  const stateA = reduceDashboard(null, promoted);
  const stateB = reduceDashboard(stateA, regressed);
  assert.ok(stateB !== null);
  assert.equal(stateB.releaseObservationPointers.length, 1);
  assert.equal(stateB.releaseObservationPointers[0].status, "regressed");
});

test("reduceDashboard: foreign project events do not contaminate", () => {
  const ours = makeTaskCreatedEvent({
    taskId: "task-ours",
    globalSequence: 1
  });
  const foreign = makeForeignProjectTaskEvent({
    globalSequence: 2
  });
  const stateA = reduceDashboard(null, ours);
  const stateB = reduceDashboard(stateA, foreign);
  assert.ok(stateB !== null);
  // Foreign events are dropped from the counter surface and timeline.
  assert.equal(stateB.taskStatusCounts.queued, 1);
  assert.equal(stateB.eventCount, 1);
  assert.equal(stateB.eventTimeline.length, 1);
});

test("reduceDashboard: ignores malformed / null payloads", () => {
  const state = reduceDashboard(null, {
    aggregateKind: "task",
    eventType: "task.created",
    payload: null,
    globalSequence: 1,
    eventId: "evt-bad",
    occurredAt: "2026-06-22T05:00:00.000Z"
  });
  assert.equal(state, null);
});

test("replayDashboard: full event stream", () => {
  const events = [
    makeTaskCreatedEvent({
      taskId: "task-c",
      fromStatus: "queued",
      globalSequence: 1
    }),
    makeTaskCreatedEvent({
      taskId: "task-d",
      fromStatus: "queued",
      globalSequence: 2
    }),
    makeTaskTransitionedEvent({
      taskId: "task-c",
      fromStatus: "queued",
      toStatus: "ready",
      aggregateSequence: 2,
      globalSequence: 3
    }),
    makeChangeAggregatedEvent({
      changeId: "chg-c",
      status: "accepted",
      globalSequence: 4
    }),
    makeReleasePromotedEvent({
      changeId: "chg-c",
      globalSequence: 5
    })
  ];
  const state = replayDashboard(events);
  assert.ok(state !== null);
  assert.equal(state.eventCount, 5);
  assert.equal(state.taskStatusCounts.queued, 1);
  assert.equal(state.taskStatusCounts.ready, 1);
  assert.equal(state.approvalPointers[0].verdict, "approved");
  assert.equal(state.releaseObservationPointers[0].status, "promoted");
});

test("replayDashboard: deterministic — same events ⇒ same hash", () => {
  const events = [
    makeTaskCreatedEvent({ globalSequence: 1 }),
    makeTaskTransitionedEvent({ globalSequence: 2 }),
    makeChangeAggregatedEvent({ globalSequence: 3 })
  ];
  const stateA = replayDashboard(events);
  const stateB = replayDashboard(events);
  assert.deepEqual(stateA, stateB);
  assert.equal(
    deriveDashboardProjectionStateHash(stateA),
    deriveDashboardProjectionStateHash(stateB)
  );
});

test("deriveDashboardProjectionStateHash: null state yields empty hash", () => {
  const hash = deriveDashboardProjectionStateHash(null);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, `sha256:${"0".repeat(64)}`);
});

test("deriveDashboardProjectionStateHash: non-null state yields content hash", () => {
  const state = replayDashboard([
    makeTaskCreatedEvent({ globalSequence: 1 }),
    makeChangeAggregatedEvent({ globalSequence: 2 })
  ]);
  const hash = deriveDashboardProjectionStateHash(state);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(hash, `sha256:${"0".repeat(64)}`);
});

test("makeDashboardReducer: returns a reducer compatible with the projection shape", () => {
  const reducer = makeDashboardReducer();
  assert.equal(DASHBOARD_REDUCER_KIND, "dashboard-adapter");
  const event = makeTaskCreatedEvent({ globalSequence: 1 });
  const result = reducer(null, event);
  assert.ok(result !== null);
  assert.equal(result.eventCount, 1);
});

test("reduceDashboard: tail bound clamps the rolling timeline", () => {
  const events = [];
  for (let i = 1; i <= 8; i++) {
    events.push(
      makeTaskCreatedEvent({
        taskId: `task-tail-${i}`,
        globalSequence: i,
        eventId: `evt-tail-${i}`
      })
    );
  }
  const state = replayDashboard(events, { tailLimit: 3 });
  assert.ok(state !== null);
  assert.equal(state.eventTimeline.length, 3);
  assert.equal(state.eventTimeline[0].eventId, "evt-tail-6");
  assert.equal(state.eventTimeline[2].eventId, "evt-tail-8");
  assert.equal(state.eventCount, 8);
});

test("reduceDashboard: timeline pushes are idempotent on duplicate eventId", () => {
  const event = makeTaskCreatedEvent({
    taskId: "task-idem",
    globalSequence: 1,
    eventId: "evt-idem-1"
  });
  const stateA = reduceDashboard(null, event);
  const stateB = reduceDashboard(stateA, event);
  assert.ok(stateB !== null);
  assert.equal(stateB.eventTimeline.length, 1);
});

test("reduceDashboard: DASHBOARD_FIXTURE_CONSTANTS are stable", () => {
  assert.ok(DASHBOARD_FIXTURE_CONSTANTS.projectId.startsWith("proj-"));
  assert.ok(DASHBOARD_FIXTURE_CONSTANTS.changeId.startsWith("chg-"));
  assert.match(DASHBOARD_FIXTURE_CONSTANTS.mergeQueueHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(DASHBOARD_FIXTURE_CONSTANTS.decisionSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(DASHBOARD_FIXTURE_CONSTANTS.aggregatorHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(DASHBOARD_FIXTURE_CONSTANTS.reportSha256, /^sha256:[0-9a-f]{64}$/);
});