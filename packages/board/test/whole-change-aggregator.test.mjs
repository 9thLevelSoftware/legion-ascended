/**
 * P09-T02 — Whole-change acceptance aggregator tests.
 *
 * Covers:
 *  - Outcome → status mapping (integrated → accepted,
 *    rejected → rejected, escalated → blocked, blocked → blocked).
 *  - Validation (empty queue, missing decision/snapshot,
 *    hash mismatch, invalid acceptedBy).
 *  - Frozen + content-addressed aggregator result.
 *  - Board event shape: aggregateKind, eventType, idempotencyKey,
 *    correlationId propagation.
 *  - AggregatorHash stability (same inputs ⇒ same hash).
 *  - Reducer roundtrip: aggregator emit → reducer replay → same
 *    state hash.
 *  - Foreign events are ignored.
 *  - Projection-key helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWholeChangeAcceptance,
  deriveWholeChangeAggregateId,
  deriveWholeChangeAggregatorHash,
  deriveWholeChangeEventPayloadHash,
  deriveWholeChangeProjectionStateHash,
  isWholeChangeAcceptanceProjectionKey,
  mapOutcomeToStatus,
  parseWholeChangeAcceptanceProjectionKey,
  parseWholeChangeAggregatedPayload,
  reduceWholeChangeAcceptance,
  replayWholeChangeAcceptance,
  sha256OfCanonical,
  verifyWholeChangeAcceptanceState,
  wholeChangeAcceptanceProjectionKey,
  WholeChangeAcceptanceAggregator,
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_EVENT_TYPES,
  WHOLE_CHANGE_HASH_VERSION,
  WHOLE_CHANGE_PROJECTION_KEY_PREFIX
} from "../dist/index.js";

import {
  makeBoardEvent,
  makeForeignBoardEvent,
  makeOrchestratorSuccess,
  WHOLE_CHANGE_FIXTURE_CONSTANTS
} from "./whole-change-fixture.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aggregateEventFor(result) {
  // The aggregator always emits exactly one event; extract it
  // so tests can probe its envelope shape.
  return result.events[0];
}

function now() {
  return "2026-06-22T04:00:00.000Z";
}

// ---------------------------------------------------------------------------
// Outcome → status mapping
// ---------------------------------------------------------------------------

test("mapOutcomeToStatus covers the canonical non-invertible map", () => {
  assert.equal(mapOutcomeToStatus("integrated"), "accepted");
  assert.equal(mapOutcomeToStatus("rejected"), "rejected");
  assert.equal(mapOutcomeToStatus("escalated"), "blocked");
  assert.equal(mapOutcomeToStatus("blocked"), "blocked");
});

// ---------------------------------------------------------------------------
// Aggregator: success path
// ---------------------------------------------------------------------------

test("aggregator emits one event with the matching event type per outcome", () => {
  const cases = [
    { outcome: "integrated", status: "accepted", eventType: "change.accepted" },
    { outcome: "rejected", status: "rejected", eventType: "change.rejected" },
    { outcome: "escalated", status: "blocked", eventType: "change.blocked" },
    { outcome: "blocked", status: "blocked", eventType: "change.blocked" }
  ];

  for (const { outcome, status, eventType } of cases) {
    // Use `acceptedEntries: [0]` for the blocked case so the
    // aggregator can harvest worker-context hashes from the
    // snapshot's steps. The whole-change outcome is whatever
    // the orchestrator reports; the per-entry breakdown is
    // orthogonal.
    const orchestratorResult = makeOrchestratorSuccess({
      outcome,
      acceptedEntries:
        outcome === "accepted" || outcome === "integrated" ? [0, 1] : [0],
      rejectedEntries: outcome === "rejected" ? [0] : [],
      escalatedEntries: outcome === "escalated" ? [0] : [],
      conflictEntries: []
    });

    const result = buildWholeChangeAcceptance({
      changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
      orchestratorResult,
      acceptedBy: "ci-bot",
      now
    });

    assert.equal(result.ok, true, `outcome=${outcome}`);
    assert.equal(result.status, status, `outcome=${outcome}`);
    assert.equal(result.events.length, 1);
    assert.equal(aggregateEventFor(result).eventType, eventType);
  }
});

test("aggregator carries the per-task decision breakdown into the state", () => {
  const orchestratorResult = makeOrchestratorSuccess({
    outcome: "rejected",
    acceptedEntries: [],
    rejectedEntries: [0, 1],
    escalatedEntries: [],
    conflictEntries: [0, 1]
  });

  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    reason: "merge queue found 2 path conflicts",
    now
  });

  assert.equal(result.ok, true);
  assert.deepEqual([...result.state.rejectedEntries], [0, 1]);
  assert.deepEqual([...result.state.conflictEntries], [0, 1]);
  assert.equal(result.state.reason, "merge queue found 2 path conflicts");
  assert.equal(result.state.acceptedBy, "ci-bot");
});

test("aggregator produces a content-addressed aggregatorHash that is stable across calls", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const input = {
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  };

  const r1 = buildWholeChangeAcceptance(input);
  const r2 = buildWholeChangeAcceptance(input);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.aggregatorHash, r2.aggregatorHash);
  assert.equal(r1.state.aggregatorHash, r2.state.aggregatorHash);
  assert.match(r1.aggregatorHash, /^sha256:[0-9a-f]{64}$/);
});

test("aggregator honors input.now over the constructor clock", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const aggregator = new WholeChangeAcceptanceAggregator({
    now: () => "2026-06-22T04:00:00.000Z"
  });
  const result = aggregator.aggregate({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now: () => "2026-06-22T04:12:34.000Z"
  });
  assert.equal(result.ok, true);
  assert.equal(result.acceptedAt, "2026-06-22T04:12:34.000Z");
  assert.equal(result.state.acceptedAt, "2026-06-22T04:12:34.000Z");
  assert.equal(
    aggregateEventFor(result).occurredAt,
    "2026-06-22T04:12:34.000Z"
  );
});

test("aggregator uses deterministic, content-addressed audit hashes for payload and state", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  assert.equal(event.eventType, "change.accepted");
  assert.equal(event.aggregateKind, "whole_change");
  assert.equal(event.aggregateId, `${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`);

  // payloadHash matches deriveWholeChangeEventPayloadHash for the payload
  const expectedPayloadHash = deriveWholeChangeEventPayloadHash(event.payload);
  assert.equal(event.payloadHash, expectedPayloadHash);

  // aggregatorHash matches deriveWholeChangeAggregatorHash over the
  // canonical input tuple.
  const expectedAggregatorHash = deriveWholeChangeAggregatorHash({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
    decisionSha256: WHOLE_CHANGE_FIXTURE_CONSTANTS.decisionSha256,
    outcome: "integrated",
    finalHeadRef: "refs/heads/whole-change-fixture",
    acceptedBy: "ci-bot",
    reason: result.state.reason,
    workerContextHashes: [...result.state.workerContextHashes].sort(),
    acceptedEntries: [...result.state.acceptedEntries],
    rejectedEntries: [...result.state.rejectedEntries],
    escalatedEntries: [...result.state.escalatedEntries],
    conflictEntries: [...result.state.conflictEntries],
    acceptedAt: result.acceptedAt
  });
  assert.equal(result.aggregatorHash, expectedAggregatorHash);

  // stateHash is content-addressed over the canonical projection state
  const stateHash = deriveWholeChangeProjectionStateHash(result.state);
  assert.match(stateHash, /^sha256:[0-9a-f]{64}$/);
});

test("aggregator emits idempotencyKey that uniquely identifies (changeId, mergeQueueHash, eventType)", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  assert.equal(
    event.idempotencyKey,
    `${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}:change.accepted`
  );
});

test("aggregator result is deeply frozen", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.events), true);
  assert.equal(Object.isFrozen(aggregateEventFor(result)), true);
  assert.equal(Object.isFrozen(result.state.acceptedEntries), true);
});

test("aggregator propagates correlationId to the emitted event", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    correlationId: "merge-queue-run-42",
    now
  });
  const event = aggregateEventFor(result);
  assert.equal(event.correlationId, "merge-queue-run-42");
});

test("aggregator hashes the merge queue through both mergeQueueHash and decisionSha256", () => {
  const orchestratorResult = makeOrchestratorSuccess({
    mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
    decisionSha256: WHOLE_CHANGE_FIXTURE_CONSTANTS.decisionSha256
  });
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(result.decisionSha256, WHOLE_CHANGE_FIXTURE_CONSTANTS.decisionSha256);
});

// ---------------------------------------------------------------------------
// Aggregator: validation (fail-closed)
// ---------------------------------------------------------------------------

test("aggregator rejects invalid acceptedBy", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const cases = [null, undefined, "", "   ", 42, {}];
  for (const acceptedBy of cases) {
    const result = buildWholeChangeAcceptance({
      changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
      orchestratorResult,
      acceptedBy,
      now
    });
    assert.equal(result.ok, false, `acceptedBy=${JSON.stringify(acceptedBy)}`);
    assert.equal(result.issues.some((i) => i.code === "accepted_by_invalid"), true);
  }
});

test("aggregator rejects orchestrator result with missing decision", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  delete orchestratorResult.decision;
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.code === "decision_missing"), true);
});

test("aggregator rejects orchestrator result with missing snapshot", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  delete orchestratorResult.snapshot;
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.code === "snapshot_missing"), true);
});

test("aggregator rejects orchestrator result with mismatched decision.mergeQueueHash", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  orchestratorResult.decision.mergeQueueHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.code === "merge_queue_hash_mismatch"), true);
});

test("aggregator rejects empty queue", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  orchestratorResult.snapshot.sequenceLength = 0;
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.code === "empty_queue"), true);
});

test("aggregator reports both attemptedOutcome and attemptedMergeQueueHash on failure", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  delete orchestratorResult.decision;
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(result.ok, false);
  assert.equal(result.attemptedOutcome, null);
  assert.equal(result.attemptedMergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
});

// ---------------------------------------------------------------------------
// Reducer roundtrip: aggregator emit → reducer replay → same state
// ---------------------------------------------------------------------------

test("reducer replays the aggregator's emitted event into the same state", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });

  const event = aggregateEventFor(result);
  const replayed = replayWholeChangeAcceptance([event]);
  assert.ok(replayed, "reducer should produce a state");
  assert.equal(replayed.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(replayed.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(replayed.aggregatorHash, result.aggregatorHash);
  assert.deepEqual([...replayed.acceptedEntries], [...result.state.acceptedEntries]);
});

test("reducer ignores foreign events (different aggregateKind)", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  const foreign = makeForeignBoardEvent({ globalSequence: 2 });

  const replayed = replayWholeChangeAcceptance([foreign, event]);
  assert.ok(replayed);
  assert.equal(replayed.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
});

test("reducer ignores foreign events (same aggregateKind but different aggregateId)", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  const foreign = makeBoardEvent({
    payload: event.payload,
    globalSequence: 2,
    aggregateId: "chg-other:different-merge-queue-hash"
  });

  const replayed = replayWholeChangeAcceptance([foreign, event]);
  assert.ok(replayed);
  assert.equal(replayed.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
});

test("reducer ignores malformed payloads and returns the prior state", () => {
  const malformedEvent = {
    schemaVersion: "0.1.0",
    eventId: "evt-malformed",
    aggregateKind: "whole_change",
    aggregateId: "chg-x:merge-queue-hash",
    aggregateSequence: 1,
    globalSequence: 1,
    eventType: "change.accepted",
    eventVersion: "0.1.0",
    payload: { not: "the right shape" },
    payloadHash: "sha256:" + "0".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt: "2026-06-22T04:00:00.000Z",
    idempotencyKey: "chg-x:merge-queue-hash:change.accepted",
    payloadJson: "{}"
  };
  const next = reduceWholeChangeAcceptance(null, malformedEvent);
  assert.equal(next, null);
});

test("reducer is idempotent under duplicate event emission", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);

  const first = replayWholeChangeAcceptance([event]);
  const second = replayWholeChangeAcceptance([event, event]);
  assert.equal(first.aggregatorHash, second.aggregatorHash);
  assert.deepEqual(first, second);
});

test("reducer accepts events from the change.* family (change.rejected, change.blocked)", () => {
  const orchestratorResult = makeOrchestratorSuccess({
    outcome: "rejected",
    rejectedEntries: [0]
  });
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  assert.equal(event.eventType, "change.rejected");

  const replayed = replayWholeChangeAcceptance([event]);
  assert.equal(replayed.status, "rejected");
});

// ---------------------------------------------------------------------------
// Payload shape + parser
// ---------------------------------------------------------------------------

test("parseWholeChangeAggregatedPayload rejects missing fields", () => {
  assert.equal(parseWholeChangeAggregatedPayload(null), null);
  assert.equal(parseWholeChangeAggregatedPayload({}), null);
  assert.equal(parseWholeChangeAggregatedPayload({ status: "accepted" }), null);
});

test("parseWholeChangeAggregatedPayload rejects non-content-hash mergeQueueHash", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  const tampered = { ...event.payload, mergeQueueHash: "not-a-hash" };
  assert.equal(parseWholeChangeAggregatedPayload(tampered), null);
});

test("parseWholeChangeAggregatedPayload roundtrips the aggregator-emitted payload", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const event = aggregateEventFor(result);
  const parsed = parseWholeChangeAggregatedPayload(event.payload);
  assert.ok(parsed);
  assert.equal(parsed.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(parsed.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(parsed.outcome, "integrated");
  assert.equal(parsed.status, "accepted");
});

// ---------------------------------------------------------------------------
// Helpers: deriveWholeChangeAggregateId, projection keys
// ---------------------------------------------------------------------------

test("deriveWholeChangeAggregateId pins the (changeId, mergeQueueHash) shape", () => {
  const id = deriveWholeChangeAggregateId(
    WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash
  );
  assert.equal(
    id,
    `${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`
  );
});

test("wholeChangeAcceptanceProjectionKey follows the whole_change.acceptance: prefix", () => {
  const key = wholeChangeAcceptanceProjectionKey(
    WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash
  );
  assert.ok(key.startsWith(WHOLE_CHANGE_PROJECTION_KEY_PREFIX));
  assert.equal(isWholeChangeAcceptanceProjectionKey(key), true);
  assert.equal(isWholeChangeAcceptanceProjectionKey("unrelated.projection"), false);
});

test("parseWholeChangeAcceptanceProjectionKey round-trips the projection key", () => {
  const key = wholeChangeAcceptanceProjectionKey(
    WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash
  );
  const parsed = parseWholeChangeAcceptanceProjectionKey(key);
  assert.equal(parsed.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(parsed.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(parseWholeChangeAcceptanceProjectionKey("not-a-key"), null);
});

// ---------------------------------------------------------------------------
// State verification
// ---------------------------------------------------------------------------

test("verifyWholeChangeAcceptanceState passes for aggregator-emitted state", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(verifyWholeChangeAcceptanceState(result.state), true);
});

test("verifyWholeChangeAcceptanceState fails for tampered state", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const result = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  const tampered = { ...result.state, reason: "tampered" };
  assert.equal(verifyWholeChangeAcceptanceState(tampered), false);
});

// ---------------------------------------------------------------------------
// Schema-versioning constants
// ---------------------------------------------------------------------------

test("WHOLE_CHANGE_ACCEPTANCE_KIND, WHOLE_CHANGE_EVENT_TYPES, and WHOLE_CHANGE_HASH_VERSION are exported", () => {
  assert.equal(WHOLE_CHANGE_ACCEPTANCE_KIND, "whole-change-acceptance");
  assert.ok(WHOLE_CHANGE_EVENT_TYPES.length >= 1);
  assert.match(WHOLE_CHANGE_HASH_VERSION, /^\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------------------
// Aggregator class wrapper
// ---------------------------------------------------------------------------

test("WholeChangeAcceptanceAggregator class is equivalent to buildWholeChangeAcceptance", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const aggregator = new WholeChangeAcceptanceAggregator({ now });
  const r1 = aggregator.aggregate({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot"
  });
  const r2 = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now
  });
  assert.equal(r1.aggregatorHash, r2.aggregatorHash);
  assert.equal(r1.events.length, r2.events.length);
});

// ---------------------------------------------------------------------------
// sha256OfCanonical is stable for the same input
// ---------------------------------------------------------------------------

test("sha256OfCanonical is order-independent", () => {
  const a = sha256OfCanonical({ b: 1, a: 2, c: { y: 3, x: 4 } });
  const b = sha256OfCanonical({ a: 2, c: { x: 4, y: 3 }, b: 1 });
  assert.equal(a, b);
});
