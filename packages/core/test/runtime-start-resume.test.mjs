/**
 * ADR-004 RuntimeDriver — `FakeRuntimeDriver` start/resume unit tests.
 *
 * Companion to `runtime-skeleton.test.mjs`. The skeleton suite already
 * proves the abstract base + Fake wiring; this file pins the four
 * scenario-level acceptance criteria spelled out for the start/resume
 * card:
 *
 *   1. valid `start` returns a handle-shaped result
 *   2. invalid `start` request returns a structured failure
 *   3. `resume` of an unknown handle returns a structured failure
 *   4. `resume` of a terminal handle returns a structured failure
 *
 * `FakeRuntimeDriver` deliberately fails loud rather than throwing a
 * generic `Error`, so each negative case asserts on both the
 * `FakeDriverValidationError` shape (via `instanceof`) and the stable
 * `code` string the production `RuntimeLocalDriver` mirrors.
 *
 * The tests use only the public surface of `FakeRuntimeDriver` plus
 * the test-helper fixtures (`makeFakeStartRequest`,
 * `makeFakeCancelReason`). They do not import from the broken
 * `local-driver.ts` and they do not rely on the `@legion/protocol`
 * internals beyond the types exposed via the runtime contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FakeDriverValidationError,
  FakeRuntimeDriver,
  makeFakeCancelReason,
  makeFakeStartRequest
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// 1. Valid start returns a handle-shaped result
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver.start with a valid request returns a handle-shaped result", async () => {
  const fake = new FakeRuntimeDriver();
  const request = makeFakeStartRequest();

  const result = await fake.start(request);

  // Handle shape — opaque run id + manifest hash + checkpoint + events
  // array, matching `RuntimeStartResult` in the ADR-004 contract.
  assert.equal(typeof result.runId, "string", "runId is an opaque string");
  assert.ok(result.runId.startsWith("run_"), "runId is namespaced under run_");
  assert.equal(result.status, "started", "status reflects initial transition");
  assert.equal(typeof result.manifestHash, "string");
  assert.ok(
    result.manifestHash.startsWith("sha256:"),
    "manifestHash is a content-addressed fingerprint"
  );
  assert.equal(typeof result.startedAt, "string", "startedAt is a UTC timestamp");
  assert.ok(result.startedAt.endsWith("Z"), "startedAt is a UTC ISO-8601 string");

  // Checkpoint ref is part of the returned handle.
  assert.equal(result.checkpoint.runId, result.runId);
  assert.equal(typeof result.checkpoint.generation, "number");
  assert.ok(result.checkpoint.generation >= 1);
  assert.ok(result.checkpoint.fingerprint.startsWith("sha256:"));

  // No protocol-level events are emitted from start itself in the
  // Fake (the event-store emission is the local driver's job), but
  // the field is present and array-shaped for contract symmetry.
  assert.ok(Array.isArray(result.events), "events is an array");

  // The driver must record the run so subsequent resume/inspect
  // calls see it.
  assert.equal(fake.__runCount(), 1, "start registers the run with the driver");
});

test("FakeRuntimeDriver.start is deterministic for the same request shape", async () => {
  const fake = new FakeRuntimeDriver();
  const request = makeFakeStartRequest();

  const first = await fake.start(request);
  // A second `start` with the same idempotency key must be a no-op
  // success — it returns the existing handle unchanged.
  const second = await fake.start(request);

  assert.equal(first.runId, second.runId, "runId is stable across replays");
  assert.equal(
    first.checkpoint.generation,
    second.checkpoint.generation,
    "checkpoint generation does not advance on replay"
  );
  assert.equal(fake.__runCount(), 1, "duplicate start does not register a second run");
});

// ---------------------------------------------------------------------------
// 2. Invalid start request returns a structured failure
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver.start with a non-positive contractRevision returns invalid_request", async () => {
  const fake = new FakeRuntimeDriver();

  await assert.rejects(
    () => fake.start(makeFakeStartRequest({ contractRevision: 0 })),
    (err) => {
      assert.ok(
        err instanceof FakeDriverValidationError,
        `expected FakeDriverValidationError, got ${err?.constructor?.name}`
      );
      assert.equal(err.code, "invalid_request");
      assert.match(err.message, /contractRevision/);
      return true;
    }
  );

  assert.equal(fake.__runCount(), 0, "invalid start must not register the run");
});

test("FakeRuntimeDriver.start with a non-positive attempt returns invalid_request", async () => {
  const fake = new FakeRuntimeDriver();

  await assert.rejects(
    () => fake.start(makeFakeStartRequest({ attempt: 0 })),
    (err) => {
      assert.ok(err instanceof FakeDriverValidationError);
      assert.equal(err.code, "invalid_request");
      assert.match(err.message, /attempt/);
      return true;
    }
  );

  assert.equal(fake.__runCount(), 0, "invalid start must not register the run");
});

test("FakeRuntimeDriver.start with a mismatched driver id returns driver_mismatch", async () => {
  const fake = new FakeRuntimeDriver();

  await assert.rejects(
    () =>
      fake.start(
        makeFakeStartRequest({
          driver: { driver: "runtime-eve", version: "0.0.0" }
        })
      ),
    (err) => {
      assert.ok(err instanceof FakeDriverValidationError);
      assert.equal(err.code, "driver_mismatch");
      assert.match(err.message, /runtime-eve/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Resume of an unknown handle returns a structured failure
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver.resume of an unknown handle returns unknown_run", async () => {
  const fake = new FakeRuntimeDriver();
  const unknown = "run_does_not_exist";
  const checkpoint = {
    runId: unknown,
    generation: 1,
    fingerprint: "sha256:" + "0".repeat(64)
  };

  await assert.rejects(() => fake.resume(unknown, checkpoint), (err) => {
    assert.ok(
      err instanceof FakeDriverValidationError,
      `expected FakeDriverValidationError, got ${err?.constructor?.name}`
    );
    assert.equal(err.code, "unknown_run");
    assert.match(err.message, /not registered/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 4. Resume of a terminal handle returns a structured failure
// ---------------------------------------------------------------------------

test("FakeRuntimeDriver.resume of a terminal (canceled) handle returns terminal_run", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId, checkpoint } = await fake.start(makeFakeStartRequest());

  // Move the run to a terminal state via cancel.
  const cancelResult = await fake.cancel(runId, makeFakeCancelReason());
  assert.equal(cancelResult.status, "canceled");
  assert.equal(fake.__status(runId), "canceled", "run is terminal before resume");

  await assert.rejects(() => fake.resume(runId, checkpoint), (err) => {
    assert.ok(err instanceof FakeDriverValidationError);
    assert.equal(err.code, "terminal_run");
    assert.match(err.message, /canceled/);
    return true;
  });
});

test("FakeRuntimeDriver.resume rejects every terminal status with terminal_run", async () => {
  for (const terminal of ["canceled"]) {
    const fake = new FakeRuntimeDriver();
    const { runId, checkpoint } = await fake.start(makeFakeStartRequest());
    await fake.cancel(runId, makeFakeCancelReason());
    assert.equal(fake.__status(runId), terminal);

    await assert.rejects(
      () => fake.resume(runId, checkpoint),
      (err) => err instanceof FakeDriverValidationError && err.code === "terminal_run"
    );
  }
});
