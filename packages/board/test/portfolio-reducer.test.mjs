/**
 * P11-T02 — Portfolio projection reducer tests.
 *
 * Mirrors the P11-T01 dashboard reducer test style: pure
 * node:test assertions over the frozen
 * `PortfolioProjectionState` shape produced by the
 * `reducePortfolio` / `replayPortfolio` reducer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  portfolioProjectionKey,
  parsePortfolioProjectionKey,
  PORTFOLIO_ADAPTER_KIND,
  PORTFOLIO_ADAPTER_SCHEMA_VERSION,
  PORTFOLIO_PROJECTION_KEY_PREFIX,
  PORTFOLIO_PROJECTION_VERSION,
  PORTFOLIO_PRIORITY_BANDS,
  PORTFOLIO_DEPENDENCY_RELATIONS,
  PORTFOLIO_ADAPTER_KEYS,
  asTenantId,
  makeInitialPortfolioState,
  isPortfolioProjectionState,
  derivePortfolioProjectionStateHash,
  reducePortfolio,
  replayPortfolio,
  makePortfolioReducer,
  portfolioProjectionDescriptor,
  portfolioPriorityBand,
  portfolioEdgeKey,
  portfolioScopeFromList
} from "@legion/board";

import {
  PORTFOLIO_FIXTURE_CONSTANTS,
  makePortfolioTaskCreatedEvent,
  makePortfolioTaskTransitionedEvent,
  makePortfolioTaskPriorityChangedEvent,
  makePortfolioTaskLinkedEvent,
  makePortfolioChangeAggregatedEvent,
  makePortfolioReleasePromotedEvent,
  buildMultiProjectEventStream
} from "./portfolio-fixture.mjs";

test("portfolio projection key has canonical shape", () => {
  const key = portfolioProjectionKey(asTenantId("tnt-foo-001"));
  assert.equal(key, "portfolio:tnt-foo-001");
  assert.ok(key.startsWith(`${PORTFOLIO_PROJECTION_KEY_PREFIX}:`));
  assert.equal(parsePortfolioProjectionKey(key)?.tenantId, "tnt-foo-001");
  assert.equal(parsePortfolioProjectionKey("not-a-portfolio-key"), null);
  assert.equal(parsePortfolioProjectionKey("portfolio:"), null);
});

test("portfolio projection version + schema constants are stable", () => {
  assert.equal(PORTFOLIO_PROJECTION_VERSION, 1);
  assert.equal(PORTFOLIO_ADAPTER_KIND, "portfolio-adapter");
  assert.equal(PORTFOLIO_ADAPTER_SCHEMA_VERSION, "1.0.0");
  assert.deepEqual(PORTFOLIO_PRIORITY_BANDS, ["high", "mid", "low"]);
  assert.deepEqual(PORTFOLIO_DEPENDENCY_RELATIONS, ["depends_on", "blocks"]);
  assert.ok(PORTFOLIO_ADAPTER_KEYS.includes("dependencyEdges"));
  assert.ok(PORTFOLIO_ADAPTER_KEYS.includes("resourceLedger"));
});

test("makeInitialPortfolioState seeds a frozen empty state", () => {
  const initial = makeInitialPortfolioState(asTenantId("tnt-empty-001"));
  assert.equal(initial.kind, PORTFOLIO_ADAPTER_KIND);
  assert.equal(initial.tenantId, "tnt-empty-001");
  assert.equal(initial.eventCount, 0);
  assert.equal(Object.isFrozen(initial.projectRollups), true);
  assert.equal(Object.isFrozen(initial.dependencyEdges), true);
  assert.equal(Object.isFrozen(initial.resourceLedger), true);
  assert.equal(Object.isFrozen(initial.scope), true);
  assert.equal(initial.crossProjectDependencyCount, 0);
  assert.equal(initial.terminalProjectCount, 0);
  assert.ok(isPortfolioProjectionState(initial));
});

test("makeInitialPortfolioState respects explicit projectIds scope", () => {
  const scope = portfolioScopeFromList([
    PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    PORTFOLIO_FIXTURE_CONSTANTS.projectB
  ]);
  const initial = makeInitialPortfolioState(
    asTenantId(PORTFOLIO_FIXTURE_CONSTANTS.tenantId),
    scope
  );
  assert.deepEqual(
    [...initial.scope].sort(),
    [
      PORTFOLIO_FIXTURE_CONSTANTS.projectA,
      PORTFOLIO_FIXTURE_CONSTANTS.projectB
    ].sort()
  );
  assert.ok(initial.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA]);
  assert.ok(initial.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectB]);
});

test("isPortfolioProjectionState rejects malformed input", () => {
  assert.equal(isPortfolioProjectionState(null), false);
  assert.equal(isPortfolioProjectionState({}), false);
  assert.equal(isPortfolioProjectionState({ kind: "not-portfolio" }), false);
  assert.equal(
    isPortfolioProjectionState({
      kind: PORTFOLIO_ADAPTER_KIND,
      tenantId: 42,
      eventCount: 0
    }),
    false
  );
});

test("portfolioPriorityBand buckets priorities correctly", () => {
  assert.equal(portfolioPriorityBand(0), "low");
  assert.equal(portfolioPriorityBand(249), "low");
  assert.equal(portfolioPriorityBand(250), "mid");
  assert.equal(portfolioPriorityBand(749), "mid");
  assert.equal(portfolioPriorityBand(750), "high");
  assert.equal(portfolioPriorityBand(1000), "high");
});

test("portfolioEdgeKey is stable and order-independent on tuple identity", () => {
  const a = portfolioEdgeKey({
    relation: "depends_on",
    fromProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    fromTaskId: "task-a",
    toProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    toTaskId: "task-b"
  });
  const b = portfolioEdgeKey({
    relation: "depends_on",
    fromProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    fromTaskId: "task-a",
    toProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    toTaskId: "task-b"
  });
  assert.equal(a, b);
  const c = portfolioEdgeKey({
    relation: "blocks",
    fromProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    fromTaskId: "task-a",
    toProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    toTaskId: "task-b"
  });
  assert.notEqual(a, c);
});

test("portfolio reducer accumulates task counts per project", () => {
  const tenantId = asTenantId("tnt-r1-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r1-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 800,
    globalSequence: 1
  });
  const e2 = makePortfolioTaskCreatedEvent({
    taskId: "task-r1-2",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 200,
    globalSequence: 2
  });
  const e3 = makePortfolioTaskCreatedEvent({
    taskId: "task-r1-3",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeB1,
    priority: 500,
    globalSequence: 3
  });
  let state = initial;
  state = reducePortfolio(state, e1, { priorEvents: [] });
  state = reducePortfolio(state, e2, { priorEvents: [e1] });
  state = reducePortfolio(state, e3, { priorEvents: [e1, e2] });
  assert.equal(state.eventCount, 3);
  const rollupA = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA];
  const rollupB = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectB];
  assert.ok(rollupA);
  assert.ok(rollupB);
  assert.equal(rollupA.taskCount, 2);
  assert.equal(rollupB.taskCount, 1);
  assert.equal(rollupA.totalPriority, 1000);
  assert.equal(rollupB.totalPriority, 500);
  assert.equal(rollupA.maxPriority, 800);
  assert.equal(rollupB.maxPriority, 500);
  assert.equal(rollupA.taskStatusCounts.queued, 2);
  assert.equal(rollupB.taskStatusCounts.queued, 1);
  assert.equal(state.resourceLedger.priorityBands.high, 1); // 800
  assert.equal(state.resourceLedger.priorityBands.mid, 1); // 500
  assert.equal(state.resourceLedger.priorityBands.low, 1); // 200
});

test("portfolio reducer tracks task transitions across projects", () => {
  const tenantId = asTenantId("tnt-r2-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r2-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 500,
    globalSequence: 1
  });
  const e2 = makePortfolioTaskTransitionedEvent({
    taskId: "task-r2-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    toStatus: "claimed",
    fromStatus: "queued",
    globalSequence: 2
  });
  let state = reducePortfolio(initial, e1, { priorEvents: [] });
  state = reducePortfolio(state, e2, { priorEvents: [e1] });
  const rollup = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA];
  assert.equal(rollup.taskStatusCounts.queued, undefined);
  assert.equal(rollup.taskStatusCounts.claimed, 1);
  assert.equal(rollup.claimedTaskCount, 1);
  assert.equal(rollup.activeTaskCount, 1);
});

test("portfolio reducer tracks priority changes", () => {
  const tenantId = asTenantId("tnt-r3-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r3-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 100,
    globalSequence: 1
  });
  const e2 = makePortfolioTaskPriorityChangedEvent({
    taskId: "task-r3-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 900,
    globalSequence: 2
  });
  let state = reducePortfolio(initial, e1, { priorEvents: [] });
  state = reducePortfolio(state, e2, { priorEvents: [e1] });
  const rollup = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA];
  assert.equal(rollup.totalPriority, 900);
  assert.equal(rollup.maxPriority, 900);
  assert.equal(state.resourceLedger.priorityBands.high, 1);
  assert.equal(state.resourceLedger.priorityBands.low, 0);
});

test("portfolio reducer exposes cross-project dependency edges", () => {
  const tenantId = asTenantId("tnt-r4-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r4-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 500,
    globalSequence: 1
  });
  const e2 = makePortfolioTaskCreatedEvent({
    taskId: "task-r4-2",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeB1,
    priority: 500,
    globalSequence: 2
  });
  const e3 = makePortfolioTaskLinkedEvent({
    taskId: "task-r4-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    dependsOnTaskId: "task-r4-2",
    toProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectB,
    relation: "depends_on",
    globalSequence: 3
  });
  let state = reducePortfolio(initial, e1);
  state = reducePortfolio(state, e2);
  state = reducePortfolio(state, e3);
  assert.equal(state.crossProjectDependencyCount, 1);
  assert.equal(state.dependencyEdges.length, 1);
  const edge = state.dependencyEdges[0];
  assert.equal(edge.relation, "depends_on");
  assert.equal(edge.fromProjectId, PORTFOLIO_FIXTURE_CONSTANTS.projectA);
  assert.equal(edge.toProjectId, PORTFOLIO_FIXTURE_CONSTANTS.projectB);
  assert.equal(edge.fromTaskId, "task-r4-1");
  assert.equal(edge.toTaskId, "task-r4-2");
  assert.equal(edge.eventCount, 1);
});

test("portfolio reducer drops same-project dependency edges", () => {
  const tenantId = asTenantId("tnt-r5-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r5-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 500,
    globalSequence: 1
  });
  const e2 = makePortfolioTaskCreatedEvent({
    taskId: "task-r5-2",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 500,
    globalSequence: 2
  });
  // Same-project link: portfolio drops it from the
  // dependencyEdges array (toProjectId missing ⇒ same
  // project on the source side).
  const e3 = makePortfolioTaskLinkedEvent({
    taskId: "task-r5-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    dependsOnTaskId: "task-r5-2",
    toProjectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    relation: "depends_on",
    globalSequence: 3
  });
  let state = reducePortfolio(initial, e1);
  state = reducePortfolio(state, e2);
  state = reducePortfolio(state, e3);
  assert.equal(state.crossProjectDependencyCount, 0);
  assert.equal(state.dependencyEdges.length, 0);
});

test("portfolio reducer exposes change and release verdicts per project", () => {
  const tenantId = asTenantId("tnt-r6-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioChangeAggregatedEvent({
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    status: "accepted",
    globalSequence: 1
  });
  const e2 = makePortfolioReleasePromotedEvent({
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    globalSequence: 2
  });
  let state = reducePortfolio(initial, e1);
  state = reducePortfolio(state, e2);
  const rollup = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA];
  assert.equal(rollup.lastApprovalVerdict, "accepted");
  assert.equal(rollup.lastReleaseObservationStatus, "release.promoted");
});

test("portfolio reducer is foreign-event-safe", () => {
  const tenantId = asTenantId("tnt-r7-001");
  const initial = makeInitialPortfolioState(tenantId);
  const foreign = makePortfolioTaskCreatedEvent({
    taskId: "task-r7-foreign",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.foreignProject,
    changeId: "chg_foreign",
    priority: 500,
    globalSequence: 1
  });
  const state = reducePortfolio(initial, foreign);
  // Foreign project is silently dropped from the rollup
  // map because no scope filter is set — wait, no scope
  // means EVERY project is in scope, so the foreign project
  // DOES appear. Verify the reducer drops only events
  // outside an explicit scope filter.
  assert.equal(state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.foreignProject].taskCount, 1);

  // Now test the scope filter: events for projects not in
  // the scope are silently dropped.
  const scoped = makeInitialPortfolioState(
    tenantId,
    portfolioScopeFromList([PORTFOLIO_FIXTURE_CONSTANTS.projectA])
  );
  const foreignScoped = makePortfolioTaskCreatedEvent({
    taskId: "task-r7-foreign-2",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.foreignProject,
    changeId: "chg_foreign_2",
    priority: 500,
    globalSequence: 2
  });
  const afterForeign = reducePortfolio(scoped, foreignScoped);
  assert.equal(afterForeign.eventCount, 1);
  assert.equal(
    afterForeign.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.foreignProject],
    undefined
  );
  assert.equal(
    afterForeign.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA].taskCount,
    0
  );
});

test("portfolio reducer is deterministic — same event log ⇒ same state", () => {
  const tenantId = asTenantId("tnt-r8-001");
  const events = buildMultiProjectEventStream();
  const a = replayPortfolio(events, { tenantId });
  const b = replayPortfolio(events, { tenantId });
  assert.deepEqual(a, b);
  assert.equal(
    derivePortfolioProjectionStateHash(a),
    derivePortfolioProjectionStateHash(b)
  );
});

test("portfolio reducer handles terminal projects", () => {
  const tenantId = asTenantId("tnt-r9-001");
  const initial = makeInitialPortfolioState(tenantId);
  const e1 = makePortfolioTaskCreatedEvent({
    taskId: "task-r9-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 500,
    globalSequence: 1
  });
  // No transition to terminal — yet.
  let state = reducePortfolio(initial, e1);
  assert.equal(state.terminalProjectCount, 0);
  // Add a second project with a task that goes straight to
  // completed — the reducer doesn't see terminal transitions
  // (those come from the operator's `task.transitioned`
  // events), so the count only ticks up when we observe
  // a `task.transitioned` that lands on a terminal status.
  // We seed a transition to `completed` directly via the
  // fixture.
  const e2 = makePortfolioTaskTransitionedEvent({
    taskId: "task-r9-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    toStatus: "completed",
    fromStatus: "queued",
    globalSequence: 2
  });
  state = reducePortfolio(state, e2);
  assert.equal(state.terminalProjectCount, 1);
});

test("portfolio reducer keeps superseded tasks in terminal rollups", () => {
  const tenantId = asTenantId("tnt-superseded-001");
  const created = makePortfolioTaskCreatedEvent({
    taskId: "task-superseded-1",
    projectId: PORTFOLIO_FIXTURE_CONSTANTS.projectA,
    changeId: PORTFOLIO_FIXTURE_CONSTANTS.changeA1,
    priority: 700,
    globalSequence: 1
  });
  const superseded = {
    ...created,
    eventId: "evt-portfolio-superseded-2",
    aggregateSequence: 2,
    globalSequence: 2,
    eventType: "task.superseded",
    occurredAt: "2026-06-22T05:02:00.000Z",
    payload: {
      ...created.payload,
      fromStatus: "queued",
      toStatus: "superseded"
    }
  };
  const state = replayPortfolio([created, superseded], { tenantId });
  const rollup = state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA];
  assert.equal(rollup.taskCount, 1);
  assert.equal(rollup.terminalTaskCount, 1);
  assert.equal(rollup.taskStatusCounts.superseded, 1);
  assert.equal(rollup.taskStatusCounts.queued, undefined);
  assert.equal(rollup.totalPriority, 700);
  assert.equal(state.terminalProjectCount, 1);
});

test("portfolio descriptor wires the reducer into the standard shape", () => {
  const tenantId = asTenantId("tnt-desc-001");
  const descriptor = portfolioProjectionDescriptor({ tenantId });
  assert.equal(descriptor.projectionKey, "portfolio:tnt-desc-001");
  assert.equal(descriptor.projectionVersion, 1);
  assert.ok(descriptor.initialState);
  assert.equal(typeof descriptor.reduce, "function");
});

test("makePortfolioReducer rejects missing tenantId", () => {
  assert.throws(
    () =>
      makePortfolioReducer({
        tenantId: undefined
      }),
    /tenantId/
  );
});

test("portfolio replay deterministically reduces multi-project streams", () => {
  const tenantId = asTenantId("tnt-replay-001");
  const events = buildMultiProjectEventStream();
  const state = replayPortfolio(events, { tenantId });
  assert.ok(state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA]);
  assert.ok(state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectB]);
  assert.equal(
    state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectA].taskCount,
    2
  );
  assert.equal(
    state.projectRollups[PORTFOLIO_FIXTURE_CONSTANTS.projectB].taskCount,
    1
  );
  assert.equal(state.crossProjectDependencyCount, 2);
  assert.equal(state.dependencyEdges.length, 2);
  // One edge goes A -> B (depends_on), the other goes B -> A
  // (blocks). Both are cross-project and counted.
  const relations = state.dependencyEdges
    .map((edge) => `${edge.fromProjectId}->${edge.toProjectId}:${edge.relation}`)
    .sort();
  assert.deepEqual(relations, [
    `${PORTFOLIO_FIXTURE_CONSTANTS.projectA}->${PORTFOLIO_FIXTURE_CONSTANTS.projectB}:depends_on`,
    `${PORTFOLIO_FIXTURE_CONSTANTS.projectB}->${PORTFOLIO_FIXTURE_CONSTANTS.projectA}:blocks`
  ]);
});

test("portfolio reducer threads priorEvents through reducePortfolio", () => {
  // Verify incremental replay produces the same state as a
  // full replay — this is the P11-T01-style foreign-event
  // safety test that the working-state rebuild path
  // matches the incremental path. The incremental caller
  // threads `priorEvents` through `reducePortfolio` so the
  // per-task priority cache is reconstructed for each
  // step.
  const tenantId = asTenantId("tnt-incr-001");
  const events = buildMultiProjectEventStream();
  const fullState = replayPortfolio(events, { tenantId });
  const seen = [];
  let incState = makeInitialPortfolioState(tenantId);
  for (const event of events) {
    incState = reducePortfolio(incState, event, {
      priorEvents: seen.slice()
    });
    seen.push(event);
  }
  assert.equal(
    derivePortfolioProjectionStateHash(fullState),
    derivePortfolioProjectionStateHash(incState)
  );
});
