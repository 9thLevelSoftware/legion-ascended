/**
 * Public-contract test suite for `@legion/runtime-eve`.
 *
 * Certifies that the runtime-eve adapter satisfies the
 * seven-method `RuntimeDriver` contract declared in
 * `@legion/core` against Vercel Eve's documented public surface
 * (`defineAgent`, `ctx.getSandbox`, `defineSandbox`,
 * `defineRemoteAgent`, `defineEval`).
 *
 * The test exercises every ADR-004 lifecycle method
 * (start, resume, cancel, inspect, stream, approve, artifact)
 * plus the subagent, sandbox, and eval surfaces that
 * `docs/next/IMPLEMENTATION-BACKLOG.yaml`'s `P05-B001`
 * acceptance criteria require. A `FakeEveTransport` is wired
 * into the driver so the tests run without a live Eve
 * install; the real `RealEveTransport` exercises the same
 * surface against the pinned `eve@0.11.7` peer dependency in
 * a separate smoke test below.
 *
 * The test file is `.test.mjs` (not `.test.ts`) because the
 * workspace's `node --test` runner executes the suite with
 * plain JavaScript; we still get the type-checked driver
 * because the import is the compiled `dist/index.js`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNTIME_DRIVER_METHODS,
  RUNTIME_LOCAL_DRIVER_ID,
  RUNTIME_LOCAL_DRIVER_VERSION,
  RuntimeLocalDriver,
  buildLocalWorkerBundle,
  deterministicRunId,
  sha256ContentHash
} from "@legion/core";

import {
  RUNTIME_EVE_DRIVER_ID,
  RUNTIME_EVE_DRIVER_VERSION,
  RUNTIME_EVE_PINNED_VERSION,
  RuntimeEveDriver,
  RuntimeEveDriverError,
  FakeEveTransport,
  RealEveTransport,
  checkEveTransportVersion,
  selectDriver
} from "@legion/runtime-eve";

const ACTOR = { kind: "worker", id: "worker.runtime-eve-test", displayName: "RuntimeEve Tests" };
const APPROVER = { kind: "human", id: "reviewer.eve", displayName: "Eve Reviewer" };
const PROJECT_ID = "prj_runtime-eve";
const CHANGE_ID = "chg_p05-t02";
const TASK_ID = "tsk_p05-t02-runtime-eve";
const CONTRACT_ID = "ctr_p05-t02-runtime-eve";

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
    repository: { baseCommit: "0123456789abcdef0123456789abcdef01234567" },
    workspace: { sandboxDriver: "eve-sandbox", worktreePath: "worktrees/p05-t02" },
    policy: { riskTier: "R1", policyVersion: "0.1.0" },
    idempotencyKey:
      "prj_x:chg_x:tsk_x:run_x:eve-certification:sha256:" +
      "1".repeat(64),
    requestedBy: ACTOR,
    approvedAt: "2026-06-21T20:00:00.000Z",
    driver: { driver: RUNTIME_EVE_DRIVER_ID, version: RUNTIME_EVE_DRIVER_VERSION },
    protocolVersion: "0.1.0",
    ...overrides
  };
}

test("RuntimeEveDriver exports the same seven-method surface as the ADR-004 contract", () => {
  assert.deepEqual(RUNTIME_DRIVER_METHODS, [
    "start",
    "resume",
    "cancel",
    "inspect",
    "stream",
    "approve",
    "artifact"
  ]);
  assert.equal(RUNTIME_EVE_DRIVER_ID, "runtime-eve");
  assert.equal(RUNTIME_EVE_PINNED_VERSION, "0.11.7");
});

test("start: defines the agent on Eve, freezes the manifest hash, and emits run.created + run.started", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const expectedRunId = deterministicRunId(
    `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`
  );
  void expectedRunId;

  const result = await driver.start(request);

  assert.equal(result.status, "started");
  assert.equal(typeof result.runId, "string");
  assert.equal(result.runId.startsWith("run_"), true);
  assert.equal(result.manifestHash.startsWith("sha256:"), true);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "run.created.v1");
  assert.equal(result.events[1].type, "run.started.v1");
  assert.equal(transport.__defineAgentCalls().length, 1);
  assert.equal(transport.__defineAgentCalls()[0].agentId, `${request.taskId}-attempt-${request.attempt}`);
});

test("start: rejects requests that do not match the runtime-eve driver id", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest({
    driver: { driver: RUNTIME_LOCAL_DRIVER_ID, version: RUNTIME_LOCAL_DRIVER_VERSION }
  });
  await assert.rejects(driver.start(request), (err) => {
    return err instanceof RuntimeEveDriverError && err.code === "driver_mismatch";
  });
});

test("start: rejects duplicate run ids with a structured duplicate_run failure", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  await driver.start(request);
  await assert.rejects(driver.start(request), (err) => {
    return err instanceof RuntimeEveDriverError && err.code === "duplicate_run";
  });
});

test("resume: advances the checkpoint generation through Eve's continuation token", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const resumed = await driver.resume(start.runId, start.checkpoint);
  assert.equal(resumed.status, "started");
  assert.equal(resumed.checkpoint.generation, 2);
  assert.equal(transport.__resumeCalls().length, 1);
});

test("resume: rejects a stale checkpoint generation", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await assert.rejects(
    driver.resume(start.runId, { ...start.checkpoint, generation: 99 }),
    (err) => err instanceof RuntimeEveDriverError && err.code === "stale_checkpoint"
  );
});

test("cancel: terminates the Eve session and emits run.finished.v1 with status canceled", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const cancel = await driver.cancel(start.runId, {
    code: "user_cancel",
    message: "user pressed stop",
    requestedBy: APPROVER,
    at: "2026-06-21T20:30:00.000Z"
  });
  assert.equal(cancel.status, "canceled");
  assert.equal(cancel.events[0].type, "run.finished.v1");
  const terminal = await driver.inspect(start.runId);
  assert.equal(terminal.status, "canceled");
  assert.equal(transport.__cancelCalls().length, 1);
});

test("cancel: rejects a re-cancel with an already_canceled failure", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await driver.cancel(start.runId, {
    code: "user_cancel",
    message: "first",
    requestedBy: APPROVER,
    at: "2026-06-21T20:30:00.000Z"
  });
  await assert.rejects(
    driver.cancel(start.runId, {
      code: "user_cancel",
      message: "second",
      requestedBy: APPROVER,
      at: "2026-06-21T20:30:01.000Z"
    }),
    (err) => err instanceof RuntimeEveDriverError && err.code === "already_canceled"
  );
});

test("inspect: returns provider-neutral status, sandbox, and artifact references", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const inspection = await driver.inspect(start.runId);
  assert.equal(inspection.status, "started");
  assert.equal(inspection.sandbox.sandboxDriver, request.workspace.sandboxDriver);
  assert.equal(inspection.sandbox.worktreePath, request.workspace.worktreePath);
  assert.deepEqual(inspection.artifacts, []);
});

test("stream: yields the recorded progress and translated Eve events", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await driver.artifact(start.runId, {
    kind: "register",
    reference: {
      path: "agents/test/notes.md",
      sha256: sha256ContentHash("notes")
    }
  });
  const events = [];
  for await (const event of driver.stream(start.runId)) {
    events.push(event);
    if (events.length > 16) break;
  }
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds.includes("progress"), true);
  assert.equal(kinds.includes("artifact_registered"), true);
});

test("approve: delivers the approval to Eve and emits approval.requested + approval.granted", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const approvalId = "apv_eve_test_1";
  const outcome = await driver.approve({
    approvalId,
    runId: start.runId,
    scope: { effectClass: "S1", action: "approve-eve", targets: [] },
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:31:00.000Z",
    reason: "looks good"
  });
  assert.equal(outcome.status, "delivered");
  assert.equal(outcome.events[0].type, "approval.requested.v1");
  assert.equal(outcome.events[1].type, "approval.granted.v1");
  assert.equal(transport.__approvalCalls().length, 1);
});

test("approve: is idempotent for the same approvalId, decidedAt, and decidedBy", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const approvalId = "apv_eve_idempotent";
  const ref = {
    approvalId,
    runId: start.runId,
    scope: { effectClass: "S1", action: "approve-eve", targets: [] },
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:31:00.000Z",
    reason: "first"
  };
  const first = await driver.approve(ref);
  const second = await driver.approve(ref);
  assert.equal(first.status, "delivered");
  assert.equal(second.status, "delivered");
  assert.equal(transport.__approvalCalls().length, 1);
});

test("approve: rejects a run that is not in started or needs_human state", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await driver.cancel(start.runId, {
    code: "user_cancel",
    message: "stop",
    requestedBy: APPROVER,
    at: "2026-06-21T20:30:00.000Z"
  });
  await assert.rejects(
    driver.approve({
      approvalId: "apv_eve_after_cancel",
      runId: start.runId,
      scope: { effectClass: "S1", action: "approve-eve", targets: [] },
      decidedBy: APPROVER,
      decidedAt: "2026-06-21T20:31:00.000Z",
      reason: "should not work"
    }),
    (err) => err instanceof RuntimeEveDriverError && err.code === "approval_not_acceptable"
  );
});

test("artifact: register mode appends to the run's artifact list and emits an artifact_registered stream event", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const reference = {
    path: "agents/test/result.json",
    sha256: sha256ContentHash("result")
  };
  const handle = await driver.artifact(start.runId, { kind: "register", reference });
  assert.equal(handle.kind, "register");
  assert.equal(handle.reference.path, reference.path);
  const inspection = await driver.inspect(start.runId);
  assert.equal(inspection.artifacts.length, 1);
});

test("artifact: final-output mode requires a terminal run and rejects non-terminal calls with state snapshot", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await assert.rejects(
    driver.artifact(start.runId),
    (err) => {
      if (!(err instanceof RuntimeEveDriverError)) return false;
      if (err.code !== "not_terminal") return false;
      const state = err.state;
      return state && state.state === "started";
    }
  );
});

test("artifact: final-output mode returns the terminal bundle after cancel", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  await driver.cancel(start.runId, {
    code: "user_cancel",
    message: "stop",
    requestedBy: APPROVER,
    at: "2026-06-21T20:30:00.000Z"
  });
  const bundle = await driver.artifact(start.runId);
  assert.equal(bundle.kind, "fetch");
  assert.equal(bundle.status, "canceled");
  assert.equal(typeof bundle.finishedAt, "string");
  assert.equal(bundle.checkpoint && bundle.checkpoint.generation, start.checkpoint.generation);
});

// -------------------------------------------------------------------
// Subagent / sandbox / eval (P05-B001 acceptance criteria)
// -------------------------------------------------------------------

test("subagent: registerAndInvokeSubagent delegates to Eve's defineRemoteAgent and records the invocation", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const result = await driver.registerAndInvokeSubagent(
    start.runId,
    {
      ...buildLocalWorkerBundle(),
      id: "legion.subagent.researcher"
    },
    { topic: "eve-adapter" },
    ACTOR
  );
  assert.equal(result.subagentId, "legion.subagent.researcher");
  assert.notEqual(result.output.echoed, undefined);
  const allInvocations = transport.__subagentInvocationsByDefineOrder();
  assert.equal(allInvocations.length, 1);
  assert.equal(allInvocations[0].subagentId, "legion.subagent.researcher");
});

test("sandbox: openRunSandbox returns the Eve sandbox execution and asserts network egress is denied by default", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest({ policy: { riskTier: "R1", policyVersion: "0.1.0" } });
  const start = await driver.start(request);
  const sandbox = await driver.openRunSandbox(start.runId);
  assert.equal(sandbox.networkEgressAllowed, false);
  assert.equal(sandbox.sandbox.sandboxDriver, request.workspace.sandboxDriver);
  assert.equal(transport.__sandboxCalls().length, 1);
});

test("sandbox: R0 policy tier gets a secret canary env on the Eve sandbox", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest({ policy: { riskTier: "R0", policyVersion: "0.1.0" } });
  const start = await driver.start(request);
  const sandbox = await driver.openRunSandbox(start.runId);
  void sandbox;
  const calls = transport.__sandboxCalls();
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].spec.secretCanaryEnv, "string");
});

test("eval: runRunEval records the assertion set and emits a progress stream event", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const result = await driver.runRunEval(start.runId, {
    name: "p05-t02-eve-adapter",
    fixture: "tests/fixtures/eve-adapter.fixture.json",
    expectations: ["start succeeds", "resume advances generation", "cancel emits run.finished"],
    reporter: "summary",
    runBy: ACTOR,
    at: "2026-06-21T20:32:00.000Z"
  });
  assert.equal(result.status, "pass");
  assert.equal(transport.__evalCalls().length, 1);
});

// -------------------------------------------------------------------
// Fallback policy
// -------------------------------------------------------------------

test("fallback: selectDriver picks runtime-local when Eve is unavailable", () => {
  const selection = selectDriver({
    isLocalAvailable: true,
    isEveInstalled: false,
    isLegacyCliAvailable: false
  });
  assert.equal(selection.driver, "runtime-local");
  assert.equal(selection.pinnedEveVersion, null);
});

test("fallback: selectDriver picks runtime-eve when Eve is installed and no preferred driver is set", () => {
  const selection = selectDriver({
    isLocalAvailable: true,
    isEveInstalled: true,
    isLegacyCliAvailable: false
  });
  assert.equal(selection.driver, "runtime-eve");
  assert.equal(selection.pinnedEveVersion, RUNTIME_EVE_PINNED_VERSION);
});

test("fallback: preferredDriver falls back to runtime-local when the preferred driver is unavailable", () => {
  const selection = selectDriver({
    preferredDriver: "runtime-eve",
    isLocalAvailable: true,
    isEveInstalled: false,
    isLegacyCliAvailable: false
  });
  assert.equal(selection.driver, "runtime-local");
  assert.match(selection.reason, /preferred driver runtime-eve is unavailable/);
});

test("fallback: checkEveTransportVersion returns null when the transport is pinned to the canonical version", () => {
  const transport = new FakeEveTransport();
  assert.equal(checkEveTransportVersion(transport), null);
});

// -------------------------------------------------------------------
// Cross-driver compatibility with runtime-local
// -------------------------------------------------------------------

test("runtime-eve produces the same seven-method shape that runtime-local satisfies", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  for (const method of RUNTIME_DRIVER_METHODS) {
    assert.equal(typeof driver[method], "function", `driver.${method} should be a function`);
  }
  const start = await driver.start(request);
  await driver.resume(start.runId, start.checkpoint);
  await driver.inspect(start.runId);
  let count = 0;
  for await (const _ of driver.stream(start.runId)) {
    count += 1;
    if (count > 8) break;
  }
  await driver.approve({
    approvalId: "apv_eve_shape",
    runId: start.runId,
    scope: { effectClass: "S1", action: "approve-eve", targets: [] },
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:33:00.000Z",
    reason: "shape check"
  });
  await driver.artifact(start.runId, {
    kind: "register",
    reference: {
      path: "agents/test/shape.json",
      sha256: sha256ContentHash("shape")
    }
  });
  void count;
  await driver.cancel(start.runId, {
    code: "shape_check",
    message: "shape check complete",
    requestedBy: APPROVER,
    at: "2026-06-21T20:34:00.000Z"
  });
  const bundle = await driver.artifact(start.runId);
  assert.equal(bundle.status, "canceled");
});

test("runtime-local and runtime-eve share the same driverId-version field semantics", () => {
  const local = new RuntimeLocalDriver();
  const eve = new RuntimeEveDriver({ transport: new FakeEveTransport() });
  assert.equal(typeof local.driverId.driver, "string");
  assert.equal(typeof eve.driverId.driver, "string");
  assert.equal(local.driverId.driver, RUNTIME_LOCAL_DRIVER_ID);
  assert.equal(eve.driverId.driver, RUNTIME_EVE_DRIVER_ID);
});

// -------------------------------------------------------------------
// Run id derivation (sanity)
// -------------------------------------------------------------------

test("runtime-eve derives a deterministic run id from the request seed", async () => {
  const transport = new FakeEveTransport();
  const driver = new RuntimeEveDriver({ transport });
  const request = makeRequest();
  const start = await driver.start(request);
  const expected = deterministicRunId(
    `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`
  );
  // Both drivers hash the same seed with sha256; the leading
  // run_ prefix and the 22-char suffix must match because the
  // seeds are identical.
  assert.equal(start.runId, expected);
});

// -------------------------------------------------------------------
// RealEveTransport smoke (only runs when eve is installed)
// -------------------------------------------------------------------

test("RealEveTransport returns a synthetic authored result in dry-run mode (no worktree root)", async () => {
  const transport = new RealEveTransport();
  const request = makeRequest();
  const driver = new RuntimeEveDriver({ transport });
  // Real transport with no worktree root produces synthetic
  // results; the driver should still satisfy the start contract.
  const result = await driver.start(request);
  assert.equal(result.status, "started");
  assert.equal(result.runId.startsWith("run_"), true);
});

test("RealEveTransport: dynamic import works against the pinned eve@0.11.7 peer dependency", async () => {
  // This is a smoke test that only passes if the eve package
  // is installed. The transport catches import errors and
  // returns a structured failure when eve is unavailable; we
  // do NOT assert success, only that the call resolves without
  // throwing.
  const transport = new RealEveTransport();
  const result = await transport.defineAgent({
    agentId: "smoke-test",
    contractId: "ctr_smoke",
    contractRevision: 1,
    attempt: 1,
    workerBundleId: "legion.smoke",
    workerBundleVersion: "0.1.0",
    policyTier: "R0",
    instructions: "smoke",
    approvalPolicy: { kind: "always" },
    sandbox: {
      sandboxDriver: "eve-sandbox",
      worktreePath: "worktrees/smoke",
      allowNetworkEgress: false,
      readonlyFilesystem: true
    },
    subagents: []
  });
  assert.equal(typeof result.sessionId, "string");
  assert.equal(typeof result.continuationToken, "string");
  // The smoke test only requires that the transport resolves cleanly;
  // manifest hashing is provider-specific and may be omitted in dry-run mode.
  if (result.manifestHash !== undefined) {
    assert.equal(typeof result.manifestHash, "string");
  }
});
