/**
 * P10-T01 — Release observation board adapter tests.
 *
 * Coverage:
 *  1. eventTypeForReleaseObservationStatus covers the
 *     canonical status → event-type map.
 *  2. releaseObservationIdempotencyKey returns the
 *     `<changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`
 *     shape.
 *  3. Aggregator emits one event with the matching event
 *     type per status.
 *  4. AggregatorHash is content-addressed.
 *  5. Board event envelope: aggregateKind, eventType,
 *     idempotencyKey, correlationId propagation.
 *  6. Validation: missing report, hash mismatch,
 *     changeId mismatch yield typed issues.
 *  7. Frozen output.
 *  8. Reducer: same input → same state; foreign events
 *     ignored; projectionKey helper.
 *  9. Replay: replayReleaseObservation replays an event
 *     stream into a single state.
 * 10. Foreign event types do not match
 *     `isReleaseObservationEventType`.
 * 11. releaseObservationProjectionKey is content-shaped.
 * 12. parseReleaseObservationProjectionKey round-trips.
 * 13. class vs free-function equivalence.
 * 14. Provider neutrality — release-observation board
 *     source never imports runtime drivers or process.env.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReleaseObservationBoardEvent,
  deriveReleaseObservationAggregateId,
  deriveReleaseObservationEventPayloadHash,
  eventTypeForReleaseObservationStatus,
  isReleaseObservationEventType,
  makeReleaseObservationReducer,
  parseReleaseObservationProjectionKey,
  reduceReleaseObservation,
  releaseObservationIdempotencyKey,
  releaseObservationProjectionDescriptor,
  releaseObservationProjectionKey,
  replayReleaseObservation,
  RELEASE_OBSERVATION_ADAPTER_KIND,
  RELEASE_OBSERVATION_BOARD_EVENT_TYPES,
  RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX,
  RELEASE_OBSERVATION_PROJECTION_VERSION,
  RELEASE_OBSERVATION_REDUCER_KIND,
  ReleaseObservationBoardAggregator
} from "../dist/index.js";

import {
  makeBoardEventForReport,
  makeReleaseObservationReport,
  RELEASE_OBSERVATION_BOARD_FIXTURE_CONSTANTS
} from "./release-observation-fixture.mjs";

const FIX = RELEASE_OBSERVATION_BOARD_FIXTURE_CONSTANTS;

// ---------------------------------------------------------------------------
// Event type map
// ---------------------------------------------------------------------------

test("eventTypeForReleaseObservationStatus covers the canonical status → event-type map", () => {
  assert.equal(eventTypeForReleaseObservationStatus("observing"), "release.observing");
  assert.equal(eventTypeForReleaseObservationStatus("promoted"), "release.promoted");
  assert.equal(eventTypeForReleaseObservationStatus("regressed"), "release.regressed");
  assert.equal(eventTypeForReleaseObservationStatus("rolled_back"), "release.rolled_back");
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

test("releaseObservationIdempotencyKey returns the canonical shape", () => {
  const key = releaseObservationIdempotencyKey(
    FIX.changeId,
    FIX.mergeQueueHash,
    FIX.reportSha256,
    "release.promoted"
  );
  assert.equal(
    key,
    `${FIX.changeId}:${FIX.mergeQueueHash}:${FIX.reportSha256}:release.promoted`
  );
});

// ---------------------------------------------------------------------------
// Aggregator success path
// ---------------------------------------------------------------------------

test("aggregator emits one event with the matching event type per status", () => {
  for (const status of ["observing", "promoted", "regressed", "rolled_back"]) {
    const report = makeReleaseObservationReport({ status });
    const result = buildReleaseObservationBoardEvent({
      changeId: FIX.changeId,
      report
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.events.length, 1);
    const event = result.events[0];
    assert.equal(event.aggregateKind, "release_observation");
    assert.equal(
      event.eventType,
      eventTypeForReleaseObservationStatus(status)
    );
    assert.equal(event.idempotencyKey, releaseObservationIdempotencyKey(
      FIX.changeId,
      FIX.mergeQueueHash,
      report.reportSha256,
      eventTypeForReleaseObservationStatus(status)
    ));
  }
});

test("aggregator honors input.now over the constructor clock", () => {
  const report = makeReleaseObservationReport({ status: "promoted" });
  const inputNow = () => "2026-06-22T05:44:44.000Z";
  const constructorNow = () => "2026-06-22T05:33:33.000Z";
  const result = buildReleaseObservationBoardEvent(
    {
      changeId: FIX.changeId,
      report,
      now: inputNow
    },
    { now: constructorNow }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observedAt, inputNow());
  assert.equal(result.events[0].occurredAt, inputNow());
  assert.equal(result.state.lastObservedAt, inputNow());
});

// ---------------------------------------------------------------------------
// Aggregator validation
// ---------------------------------------------------------------------------

test("aggregator fails when reportSha256 is missing", () => {
  const report = makeReleaseObservationReport();
  const bad = { ...report, reportSha256: "" };
  const result = buildReleaseObservationBoardEvent({
    changeId: FIX.changeId,
    report: bad
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("report_sha_mismatch"));
});

test("aggregator rejects stale reportSha256 values", () => {
  const report = makeReleaseObservationReport({
    reportSha256: FIX.reportSha256
  });
  const result = buildReleaseObservationBoardEvent({
    changeId: FIX.changeId,
    report
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("report_sha_mismatch"));
});

test("aggregator fails when changeId mismatches", () => {
  const report = makeReleaseObservationReport();
  const result = buildReleaseObservationBoardEvent({
    changeId: "chg-other",
    report
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("change_id_mismatch"));
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

test("aggregator result and event are deeply frozen", () => {
  const report = makeReleaseObservationReport();
  const result = buildReleaseObservationBoardEvent({
    changeId: FIX.changeId,
    report
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events[0]), true);
  assert.equal(Object.isFrozen(result.state), true);
});

// ---------------------------------------------------------------------------
// AggregateId + projection key helpers
// ---------------------------------------------------------------------------

test("deriveReleaseObservationAggregateId returns the canonical shape", () => {
  const id = deriveReleaseObservationAggregateId({
    changeId: FIX.changeId,
    mergeQueueHash: FIX.mergeQueueHash,
    reportSha256: FIX.reportSha256
  });
  assert.equal(id, `${FIX.changeId}:${FIX.mergeQueueHash}:${FIX.reportSha256}`);
});

test("releaseObservationProjectionKey uses the canonical prefix", () => {
  const key = releaseObservationProjectionKey(
    FIX.changeId,
    FIX.mergeQueueHash
  );
  assert.equal(
    key,
    `${RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX}${FIX.changeId}:${FIX.mergeQueueHash}`
  );
});

test("parseReleaseObservationProjectionKey round-trips a valid key", () => {
  const key = releaseObservationProjectionKey(
    FIX.changeId,
    FIX.mergeQueueHash
  );
  const parsed = parseReleaseObservationProjectionKey(key);
  assert.deepEqual(parsed, {
    changeId: FIX.changeId,
    mergeQueueHash: FIX.mergeQueueHash
  });
});

test("parseReleaseObservationProjectionKey returns null for an invalid key", () => {
  assert.equal(parseReleaseObservationProjectionKey("not-a-release-obs-key"), null);
  assert.equal(parseReleaseObservationProjectionKey("release-observation:"), null);
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

test("reduceReleaseObservation returns null for foreign events", () => {
  const event = makeBoardEventForReport(makeReleaseObservationReport());
  const foreign = {
    ...event,
    aggregateKind: "task",
    eventType: "task.created"
  };
  const result = reduceReleaseObservation(null, foreign);
  assert.equal(result, null);
});

test("reduceReleaseObservation produces a state for a release event", () => {
  const report = makeReleaseObservationReport({ status: "promoted" });
  const event = makeBoardEventForReport(report);
  const state = reduceReleaseObservation(null, event);
  assert.notEqual(state, null);
  if (!state) return;
  assert.equal(state.changeId, report.changeId);
  assert.equal(state.mergeQueueHash, report.mergeQueueHash);
  assert.equal(state.reportSha256, report.reportSha256);
  assert.equal(state.lastEventType, "release.promoted");
});

test("replayReleaseObservation replays an event stream into a single state", () => {
  const a = makeBoardEventForReport(makeReleaseObservationReport({ status: "promoted" }));
  const b = makeBoardEventForReport(
    makeReleaseObservationReport({ status: "rolled_back" }),
    { eventType: "release.rolled_back" }
  );
  // The reducer applies the most recent event, so the final
  // state reflects the rolled_back event.
  const state = replayReleaseObservation([a, b]);
  assert.notEqual(state, null);
  if (!state) return;
  assert.equal(state.lastEventType, "release.rolled_back");
});

test("makeReleaseObservationReducer returns a working reducer", () => {
  const reducer = makeReleaseObservationReducer();
  const report = makeReleaseObservationReport();
  const event = makeBoardEventForReport(report);
  const state = reducer(null, event);
  assert.notEqual(state, null);
});

test("releaseObservationProjectionDescriptor exposes the canonical surface", () => {
  assert.equal(
    releaseObservationProjectionDescriptor.projectionKey,
    RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX
  );
  assert.equal(
    releaseObservationProjectionDescriptor.projectionVersion,
    RELEASE_OBSERVATION_PROJECTION_VERSION
  );
  assert.equal(releaseObservationProjectionDescriptor.initialState, null);
  assert.equal(typeof releaseObservationProjectionDescriptor.reduce, "function");
});

// ---------------------------------------------------------------------------
// Foreign event filter
// ---------------------------------------------------------------------------

test("isReleaseObservationEventType accepts only release-observation event types", () => {
  assert.equal(isReleaseObservationEventType("release.observing"), true);
  assert.equal(isReleaseObservationEventType("release.promoted"), true);
  assert.equal(isReleaseObservationEventType("release.regressed"), true);
  assert.equal(isReleaseObservationEventType("release.rolled_back"), true);
  assert.equal(isReleaseObservationEventType("task.created"), false);
  assert.equal(isReleaseObservationEventType("change.accepted"), false);
});

test("RELEASE_OBSERVATION_BOARD_EVENT_TYPES includes all five event types", () => {
  assert.equal(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.length, 5);
  assert.ok(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.includes("release.observing"));
  assert.ok(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.includes("release.observed"));
  assert.ok(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.includes("release.promoted"));
  assert.ok(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.includes("release.regressed"));
  assert.ok(RELEASE_OBSERVATION_BOARD_EVENT_TYPES.includes("release.rolled_back"));
});

// ---------------------------------------------------------------------------
// Hash determinism
// ---------------------------------------------------------------------------

test("deriveReleaseObservationEventPayloadHash is content-addressed", () => {
  const report = makeReleaseObservationReport();
  const payload = {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    changeId: report.changeId,
    mergeQueueHash: report.mergeQueueHash,
    decisionSha256: report.decisionSha256,
    tier: report.tier,
    releaseability: report.releaseability,
    status: report.status,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    observedAt: report.observedAt,
    observedBy: report.observedBy,
    canary: report.canary,
    healthCheck: report.healthCheck,
    regression: report.regression,
    alert: report.alert,
    reportSha256: report.reportSha256,
    failureReason: report.failureReason
  };
  const a = deriveReleaseObservationEventPayloadHash(payload);
  const b = deriveReleaseObservationEventPayloadHash(payload);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Class equivalence
// ---------------------------------------------------------------------------

test("ReleaseObservationBoardAggregator class returns the same result shape as buildReleaseObservationBoardEvent", () => {
  const aggregator = new ReleaseObservationBoardAggregator();
  const report = makeReleaseObservationReport();
  const a = aggregator.aggregate({ changeId: FIX.changeId, report });
  const b = buildReleaseObservationBoardEvent({ changeId: FIX.changeId, report });
  assert.equal(a.ok, b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.equal(a.lastEventType, b.lastEventType);
  }
});

// ---------------------------------------------------------------------------
// Provider neutrality
// ---------------------------------------------------------------------------

const RELEASE_OBSERVATION_SRC_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "release-observation"
);

test("release-observation board source never imports a runtime driver, eve, or reads process.env", async () => {
  const files = await readdir(RELEASE_OBSERVATION_SRC_ROOT);
  // `@legion/board-store` is the legitimate persistence
  // surface for the board adapter, so we explicitly
  // exclude it from the forbidden list. Runtime drivers,
  // Eve, node:sqlite, and process.env remain forbidden.
  const forbiddenImports = [
    " from \"eve\"",
    " from 'eve'",
    " from \"@legion/runtime\"",
    " from '@legion/runtime'",
    " from \"@legion/runtime-eve\"",
    " from '@legion/runtime-eve'",
    " from \"node:sqlite\"",
    " from 'node:sqlite'"
  ];
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const raw = await readFile(path.join(RELEASE_OBSERVATION_SRC_ROOT, file), "utf8");
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+\/\/.*$/gm, "");
    for (const bad of forbiddenImports) {
      assert.equal(
        codeOnly.includes(bad),
        false,
        `${file} must not import ${bad}`
      );
    }
    assert.equal(
      codeOnly.includes("process.env"),
      false,
      `${file} must not read process.env`
    );
  }
});

// ---------------------------------------------------------------------------
// Reducer kind pin
// ---------------------------------------------------------------------------

test("RELEASE_OBSERVATION_ADAPTER_KIND + RELEASE_OBSERVATION_REDUCER_KIND are typed constants", () => {
  assert.equal(typeof RELEASE_OBSERVATION_ADAPTER_KIND, "string");
  assert.equal(RELEASE_OBSERVATION_ADAPTER_KIND, "release-observation-adapter");
  assert.equal(typeof RELEASE_OBSERVATION_REDUCER_KIND, "string");
});
