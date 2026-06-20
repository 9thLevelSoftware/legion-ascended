import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPROVAL_LIFECYCLE_STATES,
  CHANGE_LIFECYCLE_STATES,
  INTEGRATION_LIFECYCLE_STATES,
  OBSERVATION_LIFECYCLE_STATES,
  OBSERVATION_TRANSITION_MATRIX,
  RELEASE_LIFECYCLE_STATES,
  RELEASE_TRANSITION_MATRIX,
  REVIEW_LIFECYCLE_STATES,
  REVIEW_TRANSITION_MATRIX,
  STATE_MACHINE_TRANSITION_MATRICES,
  TASK_LIFECYCLE_STATES,
  TASK_RUN_LIFECYCLE_STATES,
  TASK_RUN_TRANSITION_MATRIX,
  TRANSITION_REJECTION_CATALOG,
  createApprovalState,
  createChangeState,
  createIntegrationState,
  createObservationState,
  createReleaseState,
  createReviewState,
  createTaskRunState,
  createTaskState,
  decideTaskCommand,
  reduceApprovalState,
  reduceChangeState,
  reduceIntegrationState,
  reduceObservationState,
  reduceReleaseState,
  reduceReviewState,
  reduceTaskEvents,
  reduceTaskRunState,
  reduceTaskState,
  stableStateStringify
} from "../dist/index.js";

const PROJECT_ID = "prj_legion-next";
const CHANGE_ID = "chg_phase-01";
const TASK_ID = "tsk_p01-t07-state-machines";
const CONTRACT_ID = "ctr_state-machines";
const RUN_ID = "run_p01-t07-r1";
const EVIDENCE_ID = "evd_p01-t07-evidence";
const REVIEW_ID = "rev_p01-t07-review";
const APPROVAL_ID = "apv_p01-t07-approval";
const RELEASE_ID = "rel_p01-t07-release";
const OBSERVATION_ID = "obs_p01-t07-observation";
const ACTOR = { kind: "worker", id: "worker.codex" };
const OCCURRED_AT = "2026-06-19T12:00:00.000Z";

function eventOf(type, aggregate, payload, generation = 1, sequence = 0) {
  return {
    schemaVersion: "0.1.0",
    id: `evt_01jz${String(sequence).padStart(22, "0")}`,
    type,
    version: 1,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    aggregate,
    generation,
    sequence,
    actor: ACTOR,
    occurredAt: OCCURRED_AT,
    payload
  };
}

function commandOf(type, payload, overrides = {}) {
  return {
    schemaVersion: "0.1.0",
    id: "cmd_01jz0000000000000000000000",
    type,
    version: 1,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    actor: ACTOR,
    issuedAt: OCCURRED_AT,
    payload,
    ...overrides
  };
}

function taskState(status, overrides = {}) {
  return createTaskState({
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    priority: 10,
    status,
    ...overrides
  });
}

function taskEvent(type, payload, generation = 1, sequence = 0) {
  return eventOf(type, { kind: "task", id: TASK_ID }, { taskId: TASK_ID, ...payload }, generation, sequence);
}

test("P01-T07 lifecycle state catalogs include explicit control and terminal states", () => {
  const catalogs = [
    CHANGE_LIFECYCLE_STATES,
    TASK_LIFECYCLE_STATES,
    TASK_RUN_LIFECYCLE_STATES,
    REVIEW_LIFECYCLE_STATES,
    APPROVAL_LIFECYCLE_STATES,
    INTEGRATION_LIFECYCLE_STATES,
    RELEASE_LIFECYCLE_STATES,
    OBSERVATION_LIFECYCLE_STATES
  ];
  const requiredControlStates = ["blocked", "needs_human", "needs_replan", "stale", "invalidated", "canceled"];

  for (const states of catalogs) {
    for (const state of requiredControlStates) {
      assert.ok(states.includes(state), `${state} must be explicit in ${states.join(",")}`);
    }
  }

  assert.ok(TASK_LIFECYCLE_STATES.includes("completed"));
  assert.ok(TASK_RUN_LIFECYCLE_STATES.includes("succeeded"));
  assert.ok(REVIEW_LIFECYCLE_STATES.includes("accepted"));
  assert.ok(RELEASE_LIFECYCLE_STATES.includes("rolled_back"));
  assert.ok(OBSERVATION_LIFECYCLE_STATES.includes("forward_fix_required"));
  assert.ok(TRANSITION_REJECTION_CATALOG.unexpected_generation);
  assert.ok(TRANSITION_REJECTION_CATALOG.missing_evidence);
});

test("P01-T07 transition matrices are exported for every aggregate", () => {
  assert.deepEqual(Object.keys(STATE_MACHINE_TRANSITION_MATRICES).sort(), [
    "approval",
    "change",
    "integration",
    "observation",
    "release",
    "review",
    "task",
    "taskRun"
  ]);

  for (const [name, matrix] of Object.entries(STATE_MACHINE_TRANSITION_MATRICES)) {
    assert.equal(matrix.aggregate, name);
    assert.ok(matrix.states.length > 0, `${name} has states`);
    assert.ok(matrix.terminalStates.length > 0, `${name} has terminal states`);
    assert.ok(matrix.transitions.length > 0, `${name} has transition rows`);
  }
});

test("P01-T07 legal transition table moves each aggregate through its protocol facts", () => {
  const cases = [
    {
      name: "change proposed",
      reduce: reduceChangeState,
      state: createChangeState({ projectId: PROJECT_ID, changeId: CHANGE_ID, status: "draft" }),
      event: eventOf(
        "change.proposed.v1",
        { kind: "change", id: CHANGE_ID },
        { changeId: CHANGE_ID, title: "State machines", summary: "Implement reducers.", riskTier: "R1" }
      ),
      to: "proposed"
    },
    {
      name: "task created",
      reduce: reduceTaskState,
      state: taskState("queued"),
      event: taskEvent("task.created.v1", { contractId: CONTRACT_ID, contractRevision: 1, priority: 10 }),
      to: "ready"
    },
    {
      name: "task claimed",
      reduce: reduceTaskState,
      state: taskState("ready"),
      event: taskEvent("task.claimed.v1", { runId: RUN_ID, claimedBy: ACTOR }),
      to: "claimed"
    },
    {
      name: "task running heartbeat",
      reduce: reduceTaskState,
      state: taskState("claimed", { runId: RUN_ID }),
      event: taskEvent("task.heartbeat_recorded.v1", { runId: RUN_ID, status: "running", observedAt: OCCURRED_AT }),
      to: "running"
    },
    {
      name: "task blocked",
      reduce: reduceTaskState,
      state: taskState("running", { runId: RUN_ID }),
      event: taskEvent("task.blocked.v1", { blocker: { code: "review_blocked", reason: "Needs human input.", severity: "major" } }),
      to: "blocked"
    },
    {
      name: "change in progress",
      reduce: reduceChangeState,
      state: createChangeState({ projectId: PROJECT_ID, changeId: CHANGE_ID, status: "planned" }),
      event: taskEvent("task.created.v1", { contractId: CONTRACT_ID, contractRevision: 1, priority: 10 }),
      to: "in_progress"
    },
    {
      name: "change verifying",
      reduce: reduceChangeState,
      state: createChangeState({ projectId: PROJECT_ID, changeId: CHANGE_ID, status: "in_progress" }),
      event: eventOf("review.submitted.v1", { kind: "review", id: REVIEW_ID }, { reviewId: REVIEW_ID, taskId: TASK_ID, reviewer: ACTOR, verdict: "pass" }),
      to: "verifying"
    },
    {
      name: "task run started",
      reduce: reduceTaskRunState,
      state: createTaskRunState({ projectId: PROJECT_ID, changeId: CHANGE_ID, taskId: TASK_ID, runId: RUN_ID, status: "created" }),
      event: eventOf("run.started.v1", { kind: "run", id: RUN_ID }, { runId: RUN_ID, taskId: TASK_ID, startedAt: OCCURRED_AT }),
      to: "started"
    },
    {
      name: "task run succeeded",
      reduce: reduceTaskRunState,
      state: createTaskRunState({ projectId: PROJECT_ID, changeId: CHANGE_ID, taskId: TASK_ID, runId: RUN_ID, status: "started" }),
      event: eventOf("run.finished.v1", { kind: "run", id: RUN_ID }, { runId: RUN_ID, taskId: TASK_ID, status: "succeeded", finishedAt: OCCURRED_AT, evidenceRefs: [EVIDENCE_ID] }),
      to: "succeeded"
    },
    {
      name: "review accepted",
      reduce: reduceReviewState,
      state: createReviewState({ projectId: PROJECT_ID, changeId: CHANGE_ID, taskId: TASK_ID, reviewId: REVIEW_ID, status: "requested" }),
      event: eventOf("review.submitted.v1", { kind: "review", id: REVIEW_ID }, { reviewId: REVIEW_ID, taskId: TASK_ID, reviewer: ACTOR, verdict: "pass" }),
      to: "accepted"
    },
    {
      name: "approval granted",
      reduce: reduceApprovalState,
      state: createApprovalState({ projectId: PROJECT_ID, changeId: CHANGE_ID, approvalId: APPROVAL_ID, status: "requested" }),
      event: eventOf("approval.granted.v1", { kind: "approval", id: APPROVAL_ID }, { approvalId: APPROVAL_ID, decidedBy: ACTOR, reason: "Approved." }),
      to: "granted"
    },
    {
      name: "integration succeeded",
      reduce: reduceIntegrationState,
      state: createIntegrationState({ projectId: PROJECT_ID, changeId: CHANGE_ID, runId: RUN_ID, status: "intent_recorded" }),
      event: eventOf("integration.effect_succeeded.v1", { kind: "run", id: RUN_ID }, { effectKind: "git.push", targetHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      to: "effect_succeeded"
    },
    {
      name: "release deployed",
      reduce: reduceReleaseState,
      state: createReleaseState({ projectId: PROJECT_ID, changeId: CHANGE_ID, releaseId: RELEASE_ID, status: "requested" }),
      event: eventOf("release.deployed.v1", { kind: "release", id: RELEASE_ID }, { releaseId: RELEASE_ID, environment: "local", deploymentId: "deploy-p01-t07" }),
      to: "deployed"
    },
    {
      name: "observation healthy",
      reduce: reduceObservationState,
      state: createObservationState({ projectId: PROJECT_ID, changeId: CHANGE_ID, releaseId: RELEASE_ID, observationId: OBSERVATION_ID, status: "observing" }),
      event: eventOf("observation.recorded.v1", { kind: "observation", id: OBSERVATION_ID }, { observationId: OBSERVATION_ID, releaseId: RELEASE_ID, status: "healthy" }),
      to: "healthy"
    }
  ];

  for (const { name, reduce, state, event, to } of cases) {
    assert.equal(reduce(state, event).status, to, name);
  }
});

test("P01-T07 matrices describe reducer outcomes for conditioned transitions", () => {
  assert.ok(TASK_RUN_TRANSITION_MATRIX.transitions.some((row) => row.from === "started" && row.eventType === "run.finished.v1" && row.to === "failed"));
  assert.ok(TASK_RUN_TRANSITION_MATRIX.transitions.some((row) => row.from === "started" && row.eventType === "run.finished.v1" && row.to === "blocked"));
  assert.ok(TASK_RUN_TRANSITION_MATRIX.transitions.some((row) => row.from === "started" && row.eventType === "run.finished.v1" && row.to === "canceled"));
  assert.ok(REVIEW_TRANSITION_MATRIX.transitions.some((row) => row.from === "requested" && row.eventType === "review.submitted.v1" && row.to === "rejected"));
  assert.ok(REVIEW_TRANSITION_MATRIX.transitions.some((row) => row.from === "requested" && row.eventType === "review.submitted.v1" && row.to === "submitted"));
  assert.ok(RELEASE_TRANSITION_MATRIX.transitions.some((row) => row.from === "deployed" && row.eventType === "observation.recorded.v1" && row.to === "failed"));
  assert.ok(RELEASE_TRANSITION_MATRIX.transitions.some((row) => row.from === "deployed" && row.eventType === "observation.recorded.v1" && row.to === "rollback_required"));
  assert.ok(OBSERVATION_TRANSITION_MATRIX.transitions.some((row) => row.from === "observing" && row.eventType === "observation.recorded.v1" && row.to === "degraded"));
  assert.ok(OBSERVATION_TRANSITION_MATRIX.transitions.some((row) => row.from === "observing" && row.eventType === "observation.recorded.v1" && row.to === "forward_fix_required"));
});

test("P01-T07 illegal transitions preserve state and emit no synthetic facts", () => {
  const cases = [
    {
      name: "task cannot complete without evidence refs",
      reduce: reduceTaskState,
      state: taskState("running", { runId: RUN_ID }),
      event: taskEvent("task.completed.v1", { runId: RUN_ID, evidenceRefs: [] })
    },
    {
      name: "approval cannot be denied after grant",
      reduce: reduceApprovalState,
      state: createApprovalState({ projectId: PROJECT_ID, changeId: CHANGE_ID, approvalId: APPROVAL_ID, status: "granted" }),
      event: eventOf("approval.denied.v1", { kind: "approval", id: APPROVAL_ID }, { approvalId: APPROVAL_ID, decidedBy: ACTOR, reason: "Too late." })
    },
    {
      name: "release cannot deploy after rollback",
      reduce: reduceReleaseState,
      state: createReleaseState({ projectId: PROJECT_ID, changeId: CHANGE_ID, releaseId: RELEASE_ID, status: "rolled_back" }),
      event: eventOf("release.deployed.v1", { kind: "release", id: RELEASE_ID }, { releaseId: RELEASE_ID, environment: "local", deploymentId: "deploy-p01-t07" })
    }
  ];

  for (const { name, reduce, state, event } of cases) {
    assert.deepEqual(reduce(state, event), state, name);
  }
});

test("P01-T07 stale and mismatched cross-aggregate task events are ignored", () => {
  const current = taskState("running", {
    generation: 2,
    runId: RUN_ID,
    evidenceRefs: [EVIDENCE_ID],
    reviewRefs: [REVIEW_ID],
    passedReviewRefs: [REVIEW_ID]
  });
  const staleEvidence = eventOf(
    "evidence.collected.v1",
    { kind: "evidence", id: "evd_old-evidence" },
    { evidenceId: "evd_old-evidence", taskId: TASK_ID, runId: RUN_ID, verdict: "pass" },
    1
  );
  const wrongRunEvidence = eventOf(
    "evidence.collected.v1",
    { kind: "evidence", id: "evd_wrong-run" },
    { evidenceId: "evd_wrong-run", taskId: TASK_ID, runId: "run_wrong-r1", verdict: "pass" },
    2
  );
  const terminalReview = eventOf(
    "review.submitted.v1",
    { kind: "review", id: "rev_late-fail" },
    { reviewId: "rev_late-fail", taskId: TASK_ID, reviewer: ACTOR, verdict: "fail" },
    2
  );

  assert.deepEqual(reduceTaskState(current, staleEvidence), current);
  assert.deepEqual(reduceTaskState(current, wrongRunEvidence), current);
  assert.deepEqual(reduceTaskState(taskState("completed", { generation: 2 }), terminalReview), taskState("completed", { generation: 2 }));
});

test("P01-T07 task blockers accumulate in reducer and command decision", () => {
  const blocked = reduceTaskState(
    taskState("blocked", {
      runId: RUN_ID,
      blockers: [{ code: "first_blocker", reason: "First blocker.", severity: "major" }]
    }),
    taskEvent("task.blocked.v1", { blocker: { code: "second_blocker", reason: "Second blocker.", severity: "critical" } })
  );

  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ["first_blocker", "second_blocker"]);

  const decision = decideTaskCommand(
    taskState("blocked", { runId: RUN_ID }),
    {
      command: commandOf("task.block.v1", { taskId: TASK_ID, reason: "Still blocked." }),
      expectedGeneration: 1
    }
  );

  assert.equal(decision.accepted, true);
  assert.equal(decision.events[0].type, "task.blocked.v1");
});

test("P01-T07 task completion command requires expected generation, evidence, and passed review", () => {
  const command = commandOf("task.complete.v1", { taskId: TASK_ID, runId: RUN_ID, evidenceRefs: [EVIDENCE_ID] });

  assert.deepEqual(decideTaskCommand(taskState("running", { runId: RUN_ID }), { command, expectedGeneration: 99 }), {
    accepted: false,
    rejection: {
      code: "unexpected_generation",
      message: "Expected generation 99 but current generation is 1.",
      retryable: true
    },
    events: []
  });

  const missingEvidence = decideTaskCommand(taskState("running", { runId: RUN_ID }), {
    command: commandOf("task.complete.v1", { taskId: TASK_ID, runId: RUN_ID, evidenceRefs: [] }),
    expectedGeneration: 1
  });
  assert.equal(missingEvidence.accepted, false);
  assert.equal(missingEvidence.rejection.code, "missing_evidence");

  const unattachedEvidence = decideTaskCommand(taskState("running", {
    runId: RUN_ID,
    evidenceRefs: ["evd_other-evidence"],
    reviewRefs: [REVIEW_ID],
    passedReviewRefs: [REVIEW_ID]
  }), {
    command,
    expectedGeneration: 1
  });
  assert.equal(unattachedEvidence.accepted, false);
  assert.equal(unattachedEvidence.rejection.code, "missing_evidence");

  const missingReview = decideTaskCommand(taskState("running", { runId: RUN_ID, evidenceRefs: [EVIDENCE_ID] }), {
    command,
    expectedGeneration: 1
  });
  assert.equal(missingReview.accepted, false);
  assert.equal(missingReview.rejection.code, "missing_review");

  const accepted = decideTaskCommand(
    taskState("running", {
      runId: RUN_ID,
      evidenceRefs: [EVIDENCE_ID],
      reviewRefs: [REVIEW_ID],
      passedReviewRefs: [REVIEW_ID]
    }),
    { command, expectedGeneration: 1 }
  );

  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.events.map((event) => event.type), ["task.completed.v1"]);
  assert.deepEqual(accepted.events[0].payload.evidenceRefs, [EVIDENCE_ID]);
});

test("P01-T07 task command decisions reject misrouted envelopes and terminal invalidation", () => {
  const misroutedProject = decideTaskCommand(
    taskState("running", {
      runId: RUN_ID,
      evidenceRefs: [EVIDENCE_ID],
      reviewRefs: [REVIEW_ID],
      passedReviewRefs: [REVIEW_ID]
    }),
    {
      command: commandOf("task.complete.v1", { taskId: TASK_ID, runId: RUN_ID, evidenceRefs: [EVIDENCE_ID] }, { projectId: "prj_other-project" }),
      expectedGeneration: 1
    }
  );
  assert.equal(misroutedProject.accepted, false);
  assert.equal(misroutedProject.rejection.code, "aggregate_mismatch");

  const misroutedRun = decideTaskCommand(
    taskState("ready"),
    {
      command: commandOf("task.claim.v1", { taskId: TASK_ID, workerBundleId: "worker.codex" }, { runId: "run_wrong-r1" }),
      allocatedRunId: RUN_ID,
      expectedGeneration: 1
    }
  );
  assert.equal(misroutedRun.accepted, false);
  assert.equal(misroutedRun.rejection.code, "aggregate_mismatch");

  const terminalInvalidation = decideTaskCommand(taskState("completed"), {
    command: commandOf("task.invalidate.v1", { taskId: TASK_ID, reason: "Too late." }),
    expectedGeneration: 1
  });
  assert.equal(terminalInvalidation.accepted, false);
  assert.equal(terminalInvalidation.rejection.code, "terminal_state");
});

test("P01-T07 task replay is deterministic and equivalent from genesis", () => {
  const sequence = [
    taskEvent("task.created.v1", { contractId: CONTRACT_ID, contractRevision: 1, priority: 10 }, 1, 1),
    taskEvent("task.claimed.v1", { runId: RUN_ID, claimedBy: ACTOR }, 1, 2),
    taskEvent("task.heartbeat_recorded.v1", { runId: RUN_ID, status: "running", observedAt: OCCURRED_AT }, 1, 3),
    eventOf("evidence.collected.v1", { kind: "evidence", id: EVIDENCE_ID }, { evidenceId: EVIDENCE_ID, taskId: TASK_ID, runId: RUN_ID, verdict: "pass" }, 1, 4),
    eventOf("review.submitted.v1", { kind: "review", id: REVIEW_ID }, { reviewId: REVIEW_ID, taskId: TASK_ID, reviewer: ACTOR, verdict: "pass" }, 1, 5),
    taskEvent("task.completed.v1", { runId: RUN_ID, evidenceRefs: [EVIDENCE_ID] }, 1, 6)
  ];

  const initial = taskState("queued");
  const first = reduceTaskEvents(initial, sequence);
  const second = reduceTaskEvents(taskState("queued"), sequence);
  const incremental = sequence.reduce((state, event) => reduceTaskState(state, event), initial);

  assert.equal(first.status, "completed");
  assert.equal(stableStateStringify(first), stableStateStringify(second));
  assert.deepEqual(first, incremental);
});

test("P01-T07 terminal tasks do not resume without a higher-generation retry event", () => {
  const completed = taskState("completed", {
    runId: RUN_ID,
    evidenceRefs: [EVIDENCE_ID],
    reviewRefs: [REVIEW_ID],
    passedReviewRefs: [REVIEW_ID]
  });

  assert.equal(
    reduceTaskState(
      completed,
      taskEvent("task.heartbeat_recorded.v1", { runId: RUN_ID, status: "running", observedAt: OCCURRED_AT })
    ).status,
    "completed"
  );
  assert.equal(
    reduceTaskState(completed, taskEvent("task.retry_scheduled.v1", { runId: RUN_ID, attempt: 2, reason: "Retry." })).status,
    "completed"
  );

  const retried = reduceTaskState(
    completed,
    taskEvent("task.retry_scheduled.v1", { runId: RUN_ID, attempt: 2, reason: "Retry." }, 2)
  );

  assert.equal(retried.status, "ready");
  assert.equal(retried.generation, 2);

  assert.equal(
    reduceTaskState(taskState("invalidated", { generation: 2 }), taskEvent("task.retry_scheduled.v1", { runId: RUN_ID, attempt: 2, reason: "Retry." }, 3)).status,
    "invalidated"
  );
});

test("P01-T07 release guards reject stale observations and invalid rollback states", () => {
  const deployed = createReleaseState({ projectId: PROJECT_ID, changeId: CHANGE_ID, releaseId: RELEASE_ID, status: "deployed", generation: 2 });
  const staleObservation = eventOf(
    "observation.recorded.v1",
    { kind: "observation", id: OBSERVATION_ID },
    { observationId: OBSERVATION_ID, releaseId: RELEASE_ID, status: "healthy" },
    1
  );
  const requestedRollback = eventOf(
    "release.rolled_back.v1",
    { kind: "release", id: RELEASE_ID },
    { releaseId: RELEASE_ID, evidenceRefs: [EVIDENCE_ID] },
    1
  );

  assert.deepEqual(reduceReleaseState(deployed, staleObservation), deployed);
  assert.equal(
    reduceReleaseState(createReleaseState({ projectId: PROJECT_ID, changeId: CHANGE_ID, releaseId: RELEASE_ID, status: "requested" }), requestedRollback).status,
    "requested"
  );
});

test("P01-T07 stable state stringify sorts keys bytewise and rejects non-serializable roots", () => {
  assert.equal(stableStateStringify({ b: 1, a: { d: 4, c: 3 } }), "{\"a\":{\"c\":3,\"d\":4},\"b\":1}");
  assert.throws(() => stableStateStringify(undefined), /JSON-serializable/);
});
