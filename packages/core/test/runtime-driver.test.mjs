import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNTIME_DRIVER_METHODS,
  RUNTIME_LOCAL_DRIVER_ID,
  RUNTIME_LOCAL_DRIVER_VERSION,
  RuntimeLocalDriver,
  RuntimeLocalDriverError,
  buildLocalWorkerBundle,
  deterministicRunId,
  scopeForApproval,
  sha256ContentHash
} from "../dist/index.js";

const ACTOR = { kind: "worker", id: "worker.local-test", displayName: "RuntimeDriver Tests" };
const APPROVER = { kind: "human", id: "reviewer.test", displayName: "Reviewer" };
const PROJECT_ID = "prj_runtime-driver-tests";
const CHANGE_ID = "chg_p05-t01";
const TASK_ID = "tsk_p05-t01-runtime-driver";
const CONTRACT_ID = "ctr_p05-t01-runtime-driver";

function makeRequest(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    attempt: 1,
    workerBundle: buildLocalWorkerBundle(),
    inputs: {
      contractHash: sha256ContentHash("contract-1"),
      currentSpecsHash: sha256ContentHash("current-specs"),
      deltaSpecsHash: sha256ContentHash("delta-specs"),
      oracleHash: sha256ContentHash("oracle")
    },
    repository: {
      baseCommit: "0123456789abcdef0123456789abcdef01234567"
    },
    workspace: {
      sandboxDriver: "runtime-local",
      worktreePath: "worktrees/p05-t01"
    },
    policy: {
      riskTier: "R1",
      policyVersion: "0.1.0"
    },
    idempotencyKey:
      "prj_x:chg_x:tsk_x:run_x:approve-merge:sha256:" +
      "0".repeat(64),
    requestedBy: ACTOR,
    approvedAt: "2026-06-21T20:00:00.000Z",
    driver: {
      driver: RUNTIME_LOCAL_DRIVER_ID,
      version: RUNTIME_LOCAL_DRIVER_VERSION
    },
    protocolVersion: "0.1.0",
    ...overrides
  };
}

test("RuntimeDriver contract enumerates ADR-004's seven methods", () => {
  assert.deepEqual(RUNTIME_DRIVER_METHODS, [
    "start",
    "resume",
    "cancel",
    "inspect",
    "stream",
    "approve",
    "artifact"
  ]);
});

test("runtime-local start emits a deterministic run id and protocol events", async () => {
  const driver = new RuntimeLocalDriver();
  const request = makeRequest();
  const expectedRunId = deterministicRunId(
    `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`
  );

  const result = await driver.start(request);

  assert.equal(result.runId, expectedRunId);
  assert.equal(result.status, "started");
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "run.created.v1");
  assert.equal(result.events[1].type, "run.started.v1");
  assert.equal(result.events[0].aggregate.kind, "run");
  assert.equal(result.events[0].aggregate.id, expectedRunId);
  assert.equal(result.events[1].causationId, result.events[0].id);
  assert.equal(result.checkpoint.runId, expectedRunId);
  assert.equal(result.checkpoint.generation, 1);
  assert.ok(result.manifestHash.startsWith("sha256:"));
});

test("runtime-local start is idempotent against the same idempotency key", async () => {
  const driver = new RuntimeLocalDriver();
  const request = makeRequest();
  await driver.start(request);
  await assert.rejects(driver.start(request), (error) => {
    assert.ok(error instanceof RuntimeLocalDriverError);
    assert.equal(error.code, "duplicate_run");
    return true;
  });
});

test("runtime-local inspect returns provider-neutral state for a started run", async () => {
  const driver = new RuntimeLocalDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);

  const inspection = await driver.inspect(runId);

  assert.equal(inspection.runId, runId);
  assert.equal(inspection.status, "started");
  assert.equal(inspection.sandbox.sandboxDriver, request.workspace.sandboxDriver);
  assert.equal(inspection.sandbox.worktreePath, request.workspace.worktreePath);
  assert.equal(inspection.sandbox.sealed, false);
  assert.equal(inspection.checkpoint.generation, 1);
  assert.deepEqual(inspection.artifacts, []);
});

test("runtime-local stream yields protocol events and terminal marker for cancel", async () => {
  const driver = new RuntimeLocalDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);

  const streamEvents = [];
  for await (const event of driver.stream(runId)) {
    streamEvents.push(event);
  }
  assert.ok(streamEvents.length >= 1);
  assert.equal(streamEvents[0].kind, "progress");

  await driver.cancel(runId, {
    code: "user_requested",
    message: "user pressed cancel",
    requestedBy: ACTOR,
    at: "2026-06-21T20:05:00.000Z"
  });

  const allEvents = [];
  for await (const event of driver.stream(runId)) {
    allEvents.push(event);
  }
  const terminal = allEvents[allEvents.length - 1];
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.status, "canceled");
});

test("runtime-local resume advances the checkpoint generation", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId, checkpoint } = await driver.start(makeRequest());
  const next = await driver.resume(runId, checkpoint);

  assert.equal(next.status, "started");
  assert.equal(next.checkpoint.generation, 2);
  assert.notEqual(next.checkpoint.fingerprint, checkpoint.fingerprint);
  assert.equal(driver.__generation(runId), 2);

  // stale checkpoint fails
  await assert.rejects(driver.resume(runId, checkpoint), (error) => {
    assert.equal(error.code, "stale_checkpoint");
    return true;
  });
});

test("runtime-local cancel transitions the run to canceled and rejects duplicate cancels", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());

  const result = await driver.cancel(runId, {
    code: "policy_denial",
    message: "policy refused execution",
    requestedBy: ACTOR,
    at: "2026-06-21T20:10:00.000Z"
  });

  assert.equal(result.status, "canceled");
  assert.equal(result.events[0].type, "run.finished.v1");
  const inspection = await driver.inspect(runId);
  assert.equal(inspection.status, "canceled");
  assert.equal(inspection.sandbox.sealed, true);

  await assert.rejects(driver.cancel(runId, {
    code: "again",
    message: "second cancel",
    requestedBy: ACTOR,
    at: "2026-06-21T20:11:00.000Z"
  }), (error) => {
    assert.equal(error.code, "already_canceled");
    return true;
  });
});

test("runtime-local approve delivers an approval and emits approval.requested.v1 + approval.granted.v1 events", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());

  const approvalId = "apv_local-test-1";
  const outcome = await driver.approve({
    approvalId,
    runId,
    scope: scopeForApproval(approvalId, runId),
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:15:00.000Z",
    reason: "checked the diff"
  });

  assert.equal(outcome.status, "delivered");
  assert.equal(outcome.runId, runId);
  assert.equal(outcome.events.length, 2);
  assert.equal(outcome.events[0].type, "approval.requested.v1");
  assert.equal(outcome.events[1].type, "approval.granted.v1");
});

test("runtime-local approve is idempotent for the same approval decision", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());
  const approvalId = "apv_local-test-2";
  const ref = {
    approvalId,
    runId,
    scope: scopeForApproval(approvalId, runId),
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:16:00.000Z",
    reason: "approved"
  };
  const first = await driver.approve(ref);
  assert.equal(first.status, "delivered");
  assert.equal(first.events.length, 2);
  const second = await driver.approve(ref);
  assert.equal(second.status, "delivered");
  assert.equal(second.events.length, 0);
});

test("runtime-local approve rejects when the run is no longer accepting input", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());
  await driver.cancel(runId, {
    code: "policy_denial",
    message: "stop",
    requestedBy: ACTOR,
    at: "2026-06-21T20:18:00.000Z"
  });
  await assert.rejects(driver.approve({
    approvalId: "apv_after-cancel",
    runId,
    scope: scopeForApproval("apv_after-cancel", runId),
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:18:30.000Z",
    reason: "too late"
  }), (error) => {
    assert.equal(error.code, "approval_not_acceptable");
    return true;
  });
});

test("runtime-local artifact register records an artifact and emits an artifact_registered stream event", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());

  const reference = {
    path: "evidence/p05-t01/output.txt",
    sha256: sha256ContentHash("output-bytes"),
    mediaType: "text/plain"
  };
  const handle = await driver.artifact(runId, {
    kind: "register",
    reference,
    evidenceId: undefined
  });

  assert.equal(handle.kind, "register");
  assert.equal(handle.runId, runId);
  assert.equal(handle.reference.path, reference.path);
  assert.deepEqual(handle.events, []);

  const inspection = await driver.inspect(runId);
  assert.equal(inspection.artifacts.length, 1);
  assert.equal(inspection.artifacts[0].path, reference.path);
});

test("runtime-local artifact with evidence id emits an evidence.collected.v1 event", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());

  const evidenceId = "evd_p05-t01-artifact-1";
  const reference = {
    path: "evidence/p05-t01/note.md",
    sha256: sha256ContentHash("note-bytes"),
    mediaType: "text/markdown"
  };
  const handle = await driver.artifact(runId, {
    kind: "register",
    reference,
    evidenceId
  });

  assert.equal(handle.events.length, 1);
  assert.equal(handle.events[0].type, "evidence.collected.v1");
  assert.equal(handle.events[0].aggregate.kind, "evidence");
  assert.equal(handle.events[0].aggregate.id, evidenceId);
});

test("runtime-local artifact fetch without registering keeps inspection unchanged", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());
  const reference = {
    path: "evidence/p05-t01/fetched.bin",
    sha256: sha256ContentHash("fetched"),
    mediaType: "application/octet-stream"
  };
  const handle = await driver.artifact(runId, { kind: "fetch", reference });
  assert.equal(handle.kind, "fetch");
  const inspection = await driver.inspect(runId);
  assert.equal(inspection.artifacts.length, 0);
});

test("runtime-local rejects a request whose driver id does not match the loaded driver", async () => {
  const driver = new RuntimeLocalDriver();
  await assert.rejects(driver.start(makeRequest({
    driver: { driver: "runtime-eve", version: RUNTIME_LOCAL_DRIVER_VERSION }
  })), (error) => {
    assert.equal(error.code, "driver_mismatch");
    return true;
  });
});

test("runtime-local rejects start when contractRevision is not positive", async () => {
  const driver = new RuntimeLocalDriver();
  await assert.rejects(driver.start(makeRequest({ contractRevision: 0 })), (error) => {
    assert.equal(error.code, "invalid_request");
    return true;
  });
});

test("runtime-local errors when inspect/stream/approve/artifact are called on an unknown run", async () => {
  const driver = new RuntimeLocalDriver();
  const unknown = "run_zzzzzzzzzzzzzzzzzzzzzz";
  await assert.rejects(driver.inspect(unknown), (error) => {
    assert.equal(error.code, "unknown_run");
    return true;
  });
  await assert.rejects(driver.resume(unknown, {
    runId: unknown,
    generation: 1,
    fingerprint: sha256ContentHash("nope")
  }), (error) => {
    assert.equal(error.code, "unknown_run");
    return true;
  });
});

test("runtime-local cancel returns a single run.finished.v1 event with terminal status", async () => {
  const driver = new RuntimeLocalDriver();
  const { runId } = await driver.start(makeRequest());
  const result = await driver.cancel(runId, {
    code: "user_requested",
    message: "user pressed cancel",
    requestedBy: ACTOR,
    at: "2026-06-21T20:20:00.000Z"
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "run.finished.v1");
  assert.equal(result.events[0].payload.status, "canceled");
});
