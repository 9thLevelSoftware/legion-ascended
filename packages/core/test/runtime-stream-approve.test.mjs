/**
 * ADR-004 Runtime Driver — focused contract tests for `stream` and `approve`.
 *
 * These tests isolate the two provider-neutral methods that the
 * `t_09e6f3e7` card is responsible for delivering on top of the
 * skeleton + FakeRuntimeDriver added in `t_8ab26710`. The base
 * behaviour is already covered in `runtime-skeleton.test.mjs`; this
 * file pins down the five acceptance criteria from the card body
 * as individual, named, narrow tests so failures attribute directly
 * to the affected contract clause.
 *
 * Scenarios:
 *   1. stream of running handle yields events in order
 *   2. stream of terminal handle yields nothing further
 *   3. approve of waiting handle advances state
 *   4. approve of non-waiting handle returns failure
 *   5. reject cancels
 *
 * Every assertion targets the `FakeRuntimeDriver` because the card
 * is scoped to the provider-neutral contract surface, not to the
 * full `RuntimeLocalDriver` path. The local driver has its own
 * test file (`runtime-driver.test.mjs`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FakeRuntimeDriver,
  FakeDriverValidationError,
  makeFakeApprovalRef,
  makeFakeCancelReason,
  makeFakeStartRequest
} from "../dist/index.js";

const REQUEST = makeFakeStartRequest();
const APPROVER = { kind: "human", id: "reviewer.stream-approve" };

// ---------------------------------------------------------------------------
// 1. stream of running handle yields events in order
// ---------------------------------------------------------------------------

test("stream(handle) yields incremental provider-neutral events in order for a running run", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  const events = [];
  for await (const event of fake.stream(runId)) {
    events.push(event);
  }

  // The Fake emits: 1 start progress + 4 canned running events.
  assert.ok(events.length >= 5, `expected >=5 events on a running run, got ${events.length}`);

  // Sequence numbers are monotonically increasing, starting at 0
  // (start's own progress is sequence 0; canned begins at 1).
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(
      events[i].sequence,
      events[i - 1].sequence + 1,
      `events must be in monotonically increasing sequence order (index ${i})`
    );
  }

  // Every event is provider-neutral: no event leaks provider-native
  // transport, and the runId is stable across the stream.
  for (const event of events) {
    assert.equal(event.runId, runId, "every event must carry the same runId");
    assert.equal(typeof event.at, "string", "every event must carry a timestamp");
  }

  // Canned tail matches the documented "running" sequence:
  // progress, progress, tool_call, progress.
  const tail = events.slice(-4).map((e) => e.kind);
  assert.deepEqual(
    tail,
    ["progress", "progress", "tool_call", "progress"],
    "canned running tail must match ADR-004 sequence"
  );
});

// ---------------------------------------------------------------------------
// 2. stream of terminal handle yields nothing further
// ---------------------------------------------------------------------------

test("stream(handle) on a terminal run yields nothing further", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);

  // Drain once to populate history.
  const first = [];
  for await (const event of fake.stream(runId)) {
    first.push(event);
  }
  const historyLength = first.length;

  // Cancel the run so it transitions to a terminal status.
  await fake.cancel(runId, makeFakeCancelReason());
  const recordedLength = fake.__streamLength(runId);
  assert.ok(recordedLength > historyLength, "cancel must append a terminal event");

  // A second stream on a terminal run must replay exactly the
  // recorded history and emit nothing beyond it. Per the body:
  // "stream of terminal handle yields nothing further."
  const second = [];
  for await (const event of fake.stream(runId)) {
    second.push(event);
  }

  assert.equal(
    second.length,
    recordedLength,
    "terminal stream must replay history without emitting any further events"
  );
  assert.equal(
    second[second.length - 1].kind,
    "terminal",
    "the last replayed event must be the terminal marker"
  );
  assert.equal(
    second[second.length - 1].status,
    "canceled",
    "the terminal marker must reflect the cancel status"
  );
});

// ---------------------------------------------------------------------------
// 3. approve of waiting handle advances state
// ---------------------------------------------------------------------------

test("approve(handle, decision) advances a waiting handle forward", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);
  fake.__requestApproval(runId);
  assert.equal(fake.__status(runId), "awaiting_approval", "precondition: run is waiting");

  const approvalId = "apv_waiting-advance";
  const outcome = await fake.approve(
    makeFakeApprovalRef({
      approvalId,
      runId,
      decidedBy: APPROVER,
      decidedAt: "2026-06-21T21:00:00.000Z",
      reason: "advance"
    })
  );

  assert.equal(outcome.status, "delivered", "delivered decision must report delivered outcome");
  assert.equal(outcome.runId, runId, "outcome must echo the handle runId");
  assert.equal(outcome.approvalId, approvalId, "outcome must echo the approvalId");

  assert.equal(fake.__status(runId), "running", "approve must transition awaiting_approval -> running");

  // The driver's own stream must reflect the advance as an
  // approval_requested event with the new approvalId, so downstream
  // consumers can observe the transition.
  const events = [];
  for await (const event of fake.stream(runId)) {
    events.push(event);
  }
  const approvalEvents = events.filter((e) => e.kind === "approval_requested");
  assert.equal(approvalEvents.length, 1, "advance must emit exactly one approval_requested event");
  assert.equal(approvalEvents[0].approvalId, approvalId, "approval_requested must carry the approvalId");
});

// ---------------------------------------------------------------------------
// 4. approve of non-waiting handle returns failure
// ---------------------------------------------------------------------------

test("approve(handle, decision) of a non-waiting handle returns a structured failure", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);
  // No __requestApproval: the run is in `running` state and is not
  // waiting for an approval.

  await assert.rejects(
    () =>
      fake.approve(
        makeFakeApprovalRef({
          approvalId: "apv_not-waiting",
          runId,
          reason: "approve"
        })
      ),
    (err) => {
      assert.ok(
        err instanceof FakeDriverValidationError,
        "non-waiting approve must surface a structured FakeDriverValidationError"
      );
      assert.equal(err.code, "approval_not_acceptable", "non-waiting approve must report approval_not_acceptable");
      return true;
    }
  );

  // The run must not have moved; approve on a non-waiting run is a
  // no-op on state.
  assert.equal(fake.__status(runId), "running", "non-waiting approve must not transition state");
});

// ---------------------------------------------------------------------------
// 5. reject cancels
// ---------------------------------------------------------------------------

test("reject cancels a waiting handle", async () => {
  const fake = new FakeRuntimeDriver();
  const { runId } = await fake.start(REQUEST);
  fake.__requestApproval(runId);
  assert.equal(fake.__status(runId), "awaiting_approval", "precondition: run is waiting");

  const approvalId = "apv_deny-1";
  const outcome = await fake.approve(
    makeFakeApprovalRef({
      approvalId,
      runId,
      decidedBy: APPROVER,
      decidedAt: "2026-06-21T21:05:00.000Z",
      reason: "deny:policy violation"
    })
  );

  assert.equal(outcome.status, "rejected", "deny decision must report rejected outcome");
  assert.equal(fake.__status(runId), "canceled", "reject must transition run to canceled");

  // The terminal event emitted by the reject must reach the stream
  // so downstream consumers can observe the cancellation.
  const events = [];
  for await (const event of fake.stream(runId)) {
    events.push(event);
  }
  const terminal = events[events.length - 1];
  assert.equal(terminal.kind, "terminal", "reject must append a terminal event");
  assert.equal(terminal.status, "canceled", "terminal marker must reflect canceled status");
});
