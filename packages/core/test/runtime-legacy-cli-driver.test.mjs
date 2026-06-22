import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNTIME_DRIVER_METHODS,
  RUNTIME_LEGACY_CLI_DRIVER_ID,
  RUNTIME_LEGACY_CLI_DRIVER_VERSION,
  RUNTIME_LEGACY_CLI_GUARANTEES,
  RuntimeLegacyCliDriver,
  RuntimeLegacyCliError,
  buildLegacyCliWorkerBundle,
  scopeForLegacyApproval,
  sha256ContentHash
} from "../dist/index.js";

const ACTOR = { kind: "worker", id: "worker.legacy-cli-test", displayName: "Legacy CLI Driver Tests" };
const APPROVER = { kind: "human", id: "reviewer.legacy-cli", displayName: "Legacy Reviewer" };
const PROJECT_ID = "prj_runtime-legacy-cli-tests";
const CHANGE_ID = "chg_p05-t03";
const TASK_ID = "tsk_p05-t03-legacy-cli-driver";
const CONTRACT_ID = "ctr_p05-t03-legacy-cli-driver";

function makeRequest(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    attempt: 1,
    workerBundle: buildLegacyCliWorkerBundle(),
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
      sandboxDriver: "runtime-legacy-cli",
      worktreePath: "worktrees/p05-t03"
    },
    policy: {
      riskTier: "R1",
      policyVersion: "0.1.0"
    },
    idempotencyKey:
      "prj_x:chg_x:tsk_x:run_x:approve-merge:sha256:" +
      "1".repeat(64),
    requestedBy: ACTOR,
    approvedAt: "2026-06-21T20:00:00.000Z",
    driver: {
      driver: RUNTIME_LEGACY_CLI_DRIVER_ID,
      version: RUNTIME_LEGACY_CLI_DRIVER_VERSION
    },
    protocolVersion: "0.1.0",
    ...overrides
  };
}

test("runtime-legacy-cli exports the ADR-004 driver id and version", () => {
  assert.equal(RUNTIME_LEGACY_CLI_DRIVER_ID, "runtime-legacy-cli");
  assert.equal(RUNTIME_LEGACY_CLI_DRIVER_VERSION, "0.1.0");
});

test("runtime-legacy-cli advertises documented reduced-guarantee contract", () => {
  assert.equal(RUNTIME_LEGACY_CLI_GUARANTEES.level, "reduced");
  assert.equal(RUNTIME_LEGACY_CLI_GUARANTEES.checkpointResumeFidelity, "placeholder");
  assert.equal(RUNTIME_LEGACY_CLI_GUARANTEES.streamTerminalShape, "single");
  assert.equal(RUNTIME_LEGACY_CLI_GUARANTEES.artifactPreservation, "reference-only");
});

test("runtime-legacy-cli driver instance exposes guarantees() method", () => {
  const driver = new RuntimeLegacyCliDriver();
  const guarantees = driver.guarantees();
  assert.equal(guarantees.level, "reduced");
  assert.equal(guarantees.checkpointResumeFidelity, "placeholder");
});

test("runtime-legacy-cli start emits a leg_-prefixed run id and protocol events", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();

  const result = await driver.start(request);

  assert.ok(result.runId.startsWith("leg_"), `expected run id to start with leg_ prefix, got ${result.runId}`);
  assert.equal(result.status, "started");
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "run.created.v1");
  assert.equal(result.events[1].type, "run.started.v1");
  assert.equal(result.events[1].causationId, result.events[0].id);
  assert.equal(result.checkpoint.runId, result.runId);
  assert.equal(result.checkpoint.generation, 1);
  assert.match(result.checkpoint.note, /legacy-compat/);
  // run.created payload should expose guarantee level
  assert.equal(result.events[0].payload.guaranteeLevel, "reduced");
  // run.started payload should expose guarantee level
  assert.equal(result.events[1].payload.guaranteeLevel, "reduced");
  assert.ok(result.manifestHash.startsWith("sha256:"));
});

test("runtime-legacy-cli start is idempotent against the same idempotency key", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  await driver.start(request);
  await assert.rejects(driver.start(request), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "duplicate_run");
    return true;
  });
});

test("runtime-legacy-cli start rejects a request bound to a different driver id", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest({
    driver: { driver: "runtime-local", version: "0.1.0" }
  });
  await assert.rejects(driver.start(request), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "driver_mismatch");
    return true;
  });
});

test("runtime-legacy-cli start rejects invalid request shapes", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const base = makeRequest();
  await assert.rejects(
    driver.start(makeRequest({ contractRevision: 0 })),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "invalid_request");
      return true;
    }
  );
  await assert.rejects(
    driver.start(makeRequest({ attempt: 0 })),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "invalid_request");
      return true;
    }
  );
  void base;
});

test("runtime-legacy-cli inspect returns provider-neutral state for a started run", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);

  const inspection = await driver.inspect(runId);

  assert.equal(inspection.runId, runId);
  assert.equal(inspection.status, "started");
  assert.equal(inspection.sandbox.sandboxDriver, request.workspace.sandboxDriver);
  assert.equal(inspection.sandbox.worktreePath, request.workspace.worktreePath);
  assert.equal(inspection.sandbox.sealed, false);
  assert.equal(inspection.checkpoint.generation, 1);
  assert.ok(inspection.startedAt);
  assert.equal(inspection.finishedAt, undefined);
});

test("runtime-legacy-cli inspect rejects unknown runs with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  await assert.rejects(driver.inspect("leg_doesnotexist000000000000"), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "unknown_run");
    return true;
  });
});

test("runtime-legacy-cli resume advances the checkpoint generation", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId, checkpoint } = await driver.start(request);

  const resume = await driver.resume(runId, checkpoint);

  assert.equal(resume.status, "started");
  assert.equal(resume.checkpoint.generation, 2);
  assert.equal(driver.__streamLength(runId), 2);
  assert.match(resume.checkpoint.note, /legacy-compat/);
});

test("runtime-legacy-cli resume rejects stale checkpoints with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId, checkpoint } = await driver.start(request);
  const staleCheckpoint = { ...checkpoint, generation: 99 };

  await assert.rejects(driver.resume(runId, staleCheckpoint), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "stale_checkpoint");
    return true;
  });
});

test("runtime-legacy-cli resume rejects mismatched fingerprints with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId, checkpoint } = await driver.start(request);
  const mismatchedCheckpoint = {
    ...checkpoint,
    fingerprint: "sha256:" + "0".repeat(64)
  };

  await assert.rejects(driver.resume(runId, mismatchedCheckpoint), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "checkpoint_mismatch");
    return true;
  });
});

test("runtime-legacy-cli resume rejects unknown runs with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  await assert.rejects(
    driver.resume("leg_unknown00000000000000000", {
      runId: "leg_unknown00000000000000000",
      generation: 1,
      fingerprint: "sha256:" + "0".repeat(64)
    }),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "unknown_run");
      return true;
    }
  );
});

test("runtime-legacy-cli cancel transitions to canceled and emits a terminal stream event", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const cancelReason = {
    code: "user_cancel",
    message: "user requested cancel",
    requestedBy: APPROVER,
    at: "2026-06-21T20:00:00.000Z"
  };

  const cancel = await driver.cancel(runId, cancelReason);

  assert.equal(cancel.status, "canceled");
  assert.equal(cancel.reason, cancelReason);
  assert.ok(cancel.finishedAt);
  const events = [];
  for await (const event of driver.stream(runId)) {
    events.push(event);
  }
  const terminalEvents = events.filter((event) => event.kind === "terminal");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].status, "canceled");
});

test("runtime-legacy-cli cancel is idempotent: a second cancel throws already_canceled", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const cancelReason = {
    code: "user_cancel",
    message: "user requested cancel",
    requestedBy: APPROVER,
    at: "2026-06-21T20:00:00.000Z"
  };
  await driver.cancel(runId, cancelReason);
  await assert.rejects(driver.cancel(runId, cancelReason), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "already_canceled");
    return true;
  });
});

test("runtime-legacy-cli cancel rejects unknown runs with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  await assert.rejects(
    driver.cancel("leg_unknown00000000000000000", {
      code: "user_cancel",
      message: "user requested cancel",
      requestedBy: APPROVER,
      at: "2026-06-21T20:00:00.000Z"
    }),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "unknown_run");
      return true;
    }
  );
});

test("runtime-legacy-cli stream yields a single progress event for a fresh run", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);

  const events = [];
  for await (const event of driver.stream(runId)) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "progress");
  assert.match(events[0].note, /reduced-guarantee fallback/);
});

test("runtime-legacy-cli stream rejects unknown runs with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const iterator = driver.stream("leg_unknown00000000000000000");
  await assert.rejects(iterator.next(), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "unknown_run");
    return true;
  });
});

test("runtime-legacy-cli approve delivers the first approval and records a stream event", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const approvalId = "apr_legacy-cli-test-1";
  const scope = scopeForLegacyApproval(approvalId, runId);
  const approvalRef = {
    approvalId,
    runId,
    scope,
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:00:00.000Z",
    reason: "human reviewer approved"
  };

  const outcome = await driver.approve(approvalRef);

  assert.equal(outcome.status, "delivered");
  assert.equal(outcome.approvalId, approvalId);
  assert.equal(outcome.reason, approvalRef.reason);
  assert.equal(driver.__streamLength(runId), 2);
});

test("runtime-legacy-cli approve is idempotent for a duplicate (decidedAt + decidedBy.id match)", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const approvalId = "apr_legacy-cli-test-2";
  const scope = scopeForLegacyApproval(approvalId, runId);
  const approvalRef = {
    approvalId,
    runId,
    scope,
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:00:00.000Z",
    reason: "human reviewer approved"
  };
  await driver.approve(approvalRef);
  const second = await driver.approve(approvalRef);
  assert.equal(second.status, "delivered");
  assert.match(second.reason, /idempotent/);
});

test("runtime-legacy-cli approve rejects a different decision for the same approval id", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const approvalId = "apr_legacy-cli-test-3";
  const scope = scopeForLegacyApproval(approvalId, runId);
  const firstRef = {
    approvalId,
    runId,
    scope,
    decidedBy: APPROVER,
    decidedAt: "2026-06-21T20:00:00.000Z",
    reason: "first decision"
  };
  const conflictingRef = {
    ...firstRef,
    decidedAt: "2026-06-21T20:00:01.000Z",
    reason: "conflicting decision"
  };
  await driver.approve(firstRef);
  await assert.rejects(driver.approve(conflictingRef), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "duplicate_approval");
    return true;
  });
});

test("runtime-legacy-cli approve rejects non-started runs with approval_not_acceptable", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  await driver.cancel(runId, {
    code: "user_cancel",
    message: "user requested cancel",
    requestedBy: APPROVER,
    at: "2026-06-21T20:00:00.000Z"
  });
  await assert.rejects(
    driver.approve({
      approvalId: "apr_legacy-cli-test-4",
      runId,
      scope: scopeForLegacyApproval("apr_legacy-cli-test-4", runId),
      decidedBy: APPROVER,
      decidedAt: "2026-06-21T20:00:00.000Z",
      reason: "should not accept on canceled run"
    }),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "approval_not_acceptable");
      return true;
    }
  );
});

test("runtime-legacy-cli approve rejects unknown runs with a typed failure", async () => {
  const driver = new RuntimeLegacyCliDriver();
  await assert.rejects(
    driver.approve({
      approvalId: "apr_unknown",
      runId: "leg_unknown00000000000000000",
      scope: scopeForLegacyApproval("apr_unknown", "leg_unknown00000000000000000"),
      decidedBy: APPROVER,
      decidedAt: "2026-06-21T20:00:00.000Z",
      reason: "should fail unknown run"
    }),
    (error) => {
      assert.ok(error instanceof RuntimeLegacyCliError);
      assert.equal(error.code, "unknown_run");
      return true;
    }
  );
});

test("runtime-legacy-cli artifact(handle) on a non-terminal run returns a structured failure with current state", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);

  await assert.rejects(driver.artifact(runId), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "not_terminal");
    assert.ok(error.state);
    assert.equal(error.state.state, "started");
    assert.equal(error.state.startedAt, "2026-06-21T20:00:00.000Z");
    assert.ok(error.state.checkpoint);
    return true;
  });
});

test("runtime-legacy-cli artifact(handle) on a terminal run returns the final-output bundle with reduced guarantee metadata", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  driver.__terminate(runId, "succeeded");

  const handle = await driver.artifact(runId);

  assert.equal(handle.kind, "fetch");
  assert.equal(handle.status, "succeeded");
  assert.ok(handle.finishedAt);
  assert.equal(handle.startedAt, "2026-06-21T20:00:00.000Z");
  assert.match(handle.reference.path, new RegExp(`^\\.runtime-legacy-cli/${runId}/final-output\\.json$`));
  assert.equal(handle.metadata.guaranteeLevel, "reduced");
  assert.equal(handle.metadata.checkpointResumeFidelity, "placeholder");
  assert.equal(handle.metadata.streamTerminalShape, "single");
  assert.equal(handle.metadata.artifactPreservation, "reference-only");
});

test("runtime-legacy-cli artifact(handle) on a canceled run preserves the canceled terminal status and finishedAt", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const cancelReason = {
    code: "user_cancel",
    message: "user requested cancel",
    requestedBy: APPROVER,
    at: "2026-06-21T20:00:00.000Z"
  };
  await driver.cancel(runId, cancelReason);

  const handle = await driver.artifact(runId);

  assert.equal(handle.status, "canceled");
  assert.equal(handle.finishedAt, cancelReason.at);
});

test("runtime-legacy-cli __terminate on a terminal run throws already_succeeded / already_canceled", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  driver.__terminate(runId, "succeeded");
  assert.throws(() => driver.__terminate(runId, "succeeded"), (error) => {
    assert.ok(error instanceof RuntimeLegacyCliError);
    assert.equal(error.code, "already_succeeded");
    return true;
  });
});

test("runtime-legacy-cli artifact(handle) preserves the artifact reference registered during the run", async () => {
  const driver = new RuntimeLegacyCliDriver();
  const request = makeRequest();
  const { runId } = await driver.start(request);
  const reference = {
    path: "evidence/p05-t03/legacy-cli-artifact.txt",
    sha256: "sha256:" + "0".repeat(64)
  };
  await driver.artifact(runId, { kind: "register", reference });
  driver.__terminate(runId, "succeeded");

  const handle = await driver.artifact(runId);

  assert.equal(handle.files.length, 1);
  assert.equal(handle.files[0], reference);
});

test("runtime-legacy-cli satisfies the seven-method ADR-004 surface", () => {
  const driver = new RuntimeLegacyCliDriver();
  for (const method of RUNTIME_DRIVER_METHODS) {
    assert.equal(typeof driver[method], "function", `expected ${method} to be a function on RuntimeLegacyCliDriver`);
  }
});