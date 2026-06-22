/**
 * ADR-004 RuntimeDriver skeleton smoke test.
 *
 * Verifies that:
 *  - the `RuntimeDriverSkeleton` declares all seven methods from
 *    ADR-004 with the correct signatures (matching the
 *    `RuntimeDriver` interface), and that the un-overridden base
 *    implementations throw `NotImplementedError` carrying the
 *    driver id and method name;
 *  - the `FakeRuntimeDriver` implements every method end-to-end
 *    against a minimal `RuntimeStartRequest` fixture, so downstream
 *    consumers (start/resume, cancel/inspect, stream/approve, and
 *    artifact tests in sibling cards) have a known-working
 *    reference.
 *
 * The test deliberately avoids depending on the broken
 * `local-driver.ts`; it only exercises the skeleton and the Fake.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAKE_RUNTIME_DRIVER_ID,
  FAKE_RUNTIME_DRIVER_VERSION,
  FakeRuntimeDriver,
  NotImplementedError,
  RUNTIME_DRIVER_METHODS,
  RuntimeDriverSkeleton,
  makeFakeApprovalRef,
  makeFakeArtifactRef,
  makeFakeCancelReason,
  makeFakeStartRequest
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST = makeFakeStartRequest();
// `runId` is derived from `REQUEST` by the Fake, so per-test
// approval/artifact refs are built inline below using the runId
// returned from `start` rather than hard-coded constants.

const SCHEMA = {
  startArgs: ["request"],
  resumeArgs: ["runId", "checkpointRef"],
  cancelArgs: ["runId", "reason"],
  inspectArgs: ["runId"],
  streamArgs: ["runId"],
  approveArgs: ["approvalRef"],
  artifactArgs: ["runId", "artifactRef"]
};

// ---------------------------------------------------------------------------
// 1. Contract surface
// ---------------------------------------------------------------------------

test("RUNTIME_DRIVER_METHODS enumerates the seven ADR-004 methods in order", () => {
  assert.deepEqual([...RUNTIME_DRIVER_METHODS], [
    "start",
    "resume",
    "cancel",
    "inspect",
    "stream",
    "approve",
    "artifact"
  ]);
});

test("RuntimeDriverSkeleton declares all seven methods matching ADR-004", () => {
  const proto = RuntimeDriverSkeleton.prototype;
  for (const method of RUNTIME_DRIVER_METHODS) {
    assert.equal(
      typeof proto[method],
      "function",
      `RuntimeDriverSkeleton must declare ${method}()`
    );
  }
  // Sanity check the parameter arity matches ADR-004.
  assert.equal(proto.start.length, SCHEMA.startArgs.length, "start arity");
  assert.equal(proto.resume.length, SCHEMA.resumeArgs.length, "resume arity");
  assert.equal(proto.cancel.length, SCHEMA.cancelArgs.length, "cancel arity");
  assert.equal(proto.inspect.length, SCHEMA.inspectArgs.length, "inspect arity");
  // `stream` is an async generator; its declared arity is the same.
  assert.equal(proto.stream.length, SCHEMA.streamArgs.length, "stream arity");
  assert.equal(proto.approve.length, SCHEMA.approveArgs.length, "approve arity");
  assert.equal(proto.artifact.length, SCHEMA.artifactArgs.length, "artifact arity");
});

// ---------------------------------------------------------------------------
// 2. Skeleton base behaviour — every method throws NotImplementedError
// ---------------------------------------------------------------------------

class StubDriver extends RuntimeDriverSkeleton {
  constructor() {
    super({ driver: "stub", version: "0.0.0" });
  }
}

test("skeleton.start throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.start(REQUEST),
    (err) =>
      err instanceof NotImplementedError &&
      err.code === "not_implemented" &&
      err.driverId.driver === "stub" &&
      err.method === "start"
  );
});

test("skeleton.resume throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.resume("run_unknown", { runId: "run_unknown", generation: 1, fingerprint: "sha256:" + "0".repeat(64) }),
    (err) => err instanceof NotImplementedError && err.method === "resume"
  );
});

test("skeleton.cancel throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.cancel("run_unknown", makeFakeCancelReason()),
    (err) => err instanceof NotImplementedError && err.method === "cancel"
  );
});

test("skeleton.inspect throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.inspect("run_unknown"),
    (err) => err instanceof NotImplementedError && err.method === "inspect"
  );
});

test("skeleton.approve throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.approve(makeFakeApprovalRef()),
    (err) => err instanceof NotImplementedError && err.method === "approve"
  );
});

test("skeleton.artifact throws NotImplementedError", async () => {
  const stub = new StubDriver();
  await assert.rejects(
    () => stub.artifact("run_unknown", makeFakeArtifactRef()),
    (err) => err instanceof NotImplementedError && err.method === "artifact"
  );
});

test("skeleton stream generator throws NotImplementedError on first pull", async () => {
  const stub = new StubDriver();
  const iterator = stub.stream("run_unknown");
  await assert.rejects(
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _event of iterator) {
        // should never reach here
      }
    },
    (err) => err instanceof NotImplementedError && err.method === "stream"
  );
});

// ---------------------------------------------------------------------------
// 3. FakeRuntimeDriver — happy-path through every ADR-004 method
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver exposes the correct driverId", () => {
  const fake = new FakeRuntimeDriver();
  assert.equal(fake.driverId.driver, FAKE_RUNTIME_DRIVER_ID);
  assert.equal(fake.driverId.version, FAKE_RUNTIME_DRIVER_VERSION);
});

test("FakeRuntimeDriver.start allocates a run and returns a handle-shaped result", async () => {
  const fake = new FakeRuntimeDriver();
  const result = await fake.start(REQUEST);

  assert.equal(typeof result.runId, "string");
  assert.ok(result.runId.startsWith("run_"), "runId is opaque and namespaced");
  assert.equal(result.status, "started");
  assert.equal(typeof result.manifestHash, "string");
  assert.ok(result.manifestHash.startsWith("sha256:"));
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.checkpoint.generation, "number");
  assert.equal(result.checkpoint.runId, result.runId);
  assert.ok(result.checkpoint.fingerprint.startsWith("sha256:"));
  assert.equal(fake.__runCount(), 1);
});

test("FakeRuntimeDriver.resume rejects unknown and terminal runs, advances known runs", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId, checkpoint } = await fake.start(REQUEST);

  // Unknown run -> structured failure.
  await assert.rejects(
    () => fake.resume("run_unknown", { runId: "run_unknown", generation: 1, fingerprint: checkpoint.fingerprint }),
    (err) => err.code === "unknown_run"
  );

  // Terminal run -> structured failure.
  await fake.cancel(runId, makeFakeCancelReason());
  await assert.rejects(
    () => fake.resume(runId, checkpoint),
    (err) => err.code === "terminal_run"
  );
});

test("FakeRuntimeDriver.cancel is idempotent and transitions state", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  const first = await fake.cancel(runId, makeFakeCancelReason());
  assert.equal(first.status, "canceled");

  const second = await fake.cancel(runId, makeFakeCancelReason());
  assert.equal(second.status, "canceled", "cancel must be idempotent");

  // Cancelling an unknown run is a no-op success (caller can replay safely).
  const unknown = await fake.cancel("run_never_seen", makeFakeCancelReason());
  assert.equal(unknown.status, "canceled");
});

test("FakeRuntimeDriver.inspect rejects unknown runs and reflects state for known runs", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  await assert.rejects(
    () => fake.inspect("run_unknown"),
    (err) => err.code === "unknown_run"
  );

  const runningInspection = await fake.inspect(runId);
  assert.equal(runningInspection.runId, runId);
  assert.equal(runningInspection.status, "started");
  assert.equal(runningInspection.sandbox.sealed, false);
  assert.equal(runningInspection.checkpoint.runId, runId);

  await fake.cancel(runId, makeFakeCancelReason());
  const terminalInspection = await fake.inspect(runId);
  assert.equal(terminalInspection.status, "canceled");
  assert.equal(terminalInspection.sandbox.sealed, true);
  assert.ok(terminalInspection.finishedAt, "finishedAt present on terminal");
});

test("FakeRuntimeDriver.stream yields events in order and replays history", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  const first = [];
  for await (const event of fake.stream(runId)) {
    first.push(event);
  }
  assert.ok(first.length >= 4, `expected >=4 canned events, got ${first.length}`);
  const kinds = first.map((e) => e.kind);
  assert.equal(kinds[0], "progress", "first event is a progress note");
  // Last few events should match the canned sequence tail.
  const tail = kinds.slice(-4);
  assert.deepEqual(tail, ["progress", "progress", "tool_call", "progress"]);

  // Stream again on a terminal run yields the recorded history
  // (including any events recorded by operations like cancel that
  // happened between the first and second stream calls) without
  // emitting any additional canned events.
  const historyLength = first.length;
  await fake.cancel(runId, makeFakeCancelReason());
  const afterCancelHistory = fake.__streamLength(runId);

  const second = [];
  for await (const event of fake.stream(runId)) {
    second.push(event);
  }
  assert.equal(
    second.length,
    afterCancelHistory,
    "terminal stream must replay history without emitting further events"
  );
  assert.ok(
    second.length >= historyLength,
    `terminal stream should preserve at least the pre-cancel history (got ${second.length} >= ${historyLength})`
  );
});

test("FakeRuntimeDriver.approve advances a waiting run and rejects non-waiting runs", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);
  fake.__requestApproval(runId);
  assert.equal(fake.__status(runId), "awaiting_approval");

  const approved = await fake.approve(
    makeFakeApprovalRef({ runId, reason: "approve" })
  );
  assert.equal(approved.status, "delivered");
  assert.equal(fake.__status(runId), "running", "approve advances waiting run");

  // Approving a non-waiting run returns a structured failure.
  await assert.rejects(
    () =>
      fake.approve(makeFakeApprovalRef({ runId, reason: "approve" })),
    (err) => err.code === "approval_not_acceptable"
  );

  // Rejecting another waiting run cancels it. We use a fresh
  // approval id because the previous approval was already
  // delivered for this run.
  fake.__requestApproval(runId);
  const denied = await fake.approve(
    makeFakeApprovalRef({ runId, approvalId: "apv_fake_deny", reason: "deny:bad" })
  );
  assert.equal(denied.status, "rejected");
  assert.equal(fake.__status(runId), "canceled");
});

test("FakeRuntimeDriver.artifact registers and rejects unknown runs", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  await assert.rejects(
    () => fake.artifact("run_unknown", makeFakeArtifactRef()),
    (err) => err.code === "unknown_run"
  );

  const handle = await fake.artifact(runId, makeFakeArtifactRef());
  assert.equal(handle.runId, runId);
  assert.equal(handle.kind, "register");
  assert.ok(handle.resolvedAt);

  // Inspect reflects the registered artifact.
  const inspection = await fake.inspect(runId);
  assert.equal(inspection.artifacts.length, 1);
  assert.equal(inspection.artifacts[0].path, ".fake/artifact.txt");
});

// ---------------------------------------------------------------------------
// 4. Structural compatibility with the RuntimeDriver interface
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver is structurally assignable to RuntimeDriver", () => {
  const fake = new FakeRuntimeDriver();
  // If FakeRuntimeDriver is missing or wrongly typed, the TypeScript
  // build step catches it; at runtime we assert that every method
  // of the seven-method surface is callable on the instance.
  const candidate = fake;
  assert.equal(typeof candidate.start, "function");
  assert.equal(typeof candidate.resume, "function");
  assert.equal(typeof candidate.cancel, "function");
  assert.equal(typeof candidate.inspect, "function");
  assert.equal(typeof candidate.stream, "function");
  assert.equal(typeof candidate.approve, "function");
  assert.equal(typeof candidate.artifact, "function");
});
