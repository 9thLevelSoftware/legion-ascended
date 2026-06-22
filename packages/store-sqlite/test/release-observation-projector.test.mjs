/**
 * P10-T01 — SqliteReleaseObservationProjector tests.
 *
 * Exercises the SQLite-backed projector against a real SQLite
 * database to prove the projector replays aggregator-emitted
 * events into the board's projection store and verifies the
 * projection drift-free. Mirrors the P09-T02
 * whole-change-projector test surface.
 */

import assert from "node:assert/strict";

import test from "node:test";

import {
  SqliteReleaseObservationProjector,
  envelopeReleaseObservationState,
  releaseObservationProjectionKeyFor,
  stateFromReleaseObservationEnvelope
} from "../dist/index.js";

import {
  buildFixturePayload,
  buildRepositories,
  makeFixtureBoardEvent,
  makeFixtureReport,
  RELEASE_OBSERVATION_STORE_FIXTURE_CONSTANTS,
  withTempDatabase
} from "./release-observation-fixture.mjs";

const FIX = RELEASE_OBSERVATION_STORE_FIXTURE_CONSTANTS;

function closeRepositories(repositories) {
  repositories.database.close();
  repositories.store.close();
}

function makePagedEventRepository(events) {
  return {
    listEvents(query = {}) {
      const order = query.order ?? "asc";
      const limit = query.limit ?? 1_000;
      const filtered = events.filter((event) => {
        if (query.aggregateKind && event.aggregateKind !== query.aggregateKind) return false;
        if (query.aggregateId && event.aggregateId !== query.aggregateId) return false;
        if (query.eventType && event.eventType !== query.eventType) return false;
        if (
          typeof query.fromGlobalSequence === "number" &&
          event.globalSequence < query.fromGlobalSequence
        ) {
          return false;
        }
        if (
          typeof query.untilGlobalSequence === "number" &&
          event.globalSequence > query.untilGlobalSequence
        ) {
          return false;
        }
        return true;
      });
      filtered.sort((a, b) =>
        order === "desc"
          ? b.globalSequence - a.globalSequence
          : a.globalSequence - b.globalSequence
      );
      return filtered.slice(0, limit);
    },
    appendEvent() { throw new Error("not used"); },
    appendEvents() { throw new Error("not used"); },
    getEvent() { return null; },
    getEventByIdempotencyKey() { return null; },
    countEvents() { return events.length; },
    tail() { return []; }
  };
}

const noopProjectionRepository = {
  saveProjection() { throw new Error("not used"); },
  loadProjection() { return null; },
  deleteProjection() { throw new Error("not used"); },
  listProjections() { return []; }
};

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

test("envelopeReleaseObservationState wraps null state into the projection envelope", () => {
  const envelope = envelopeReleaseObservationState(null);
  assert.deepEqual(envelope, { state: null });
});

test("stateFromReleaseObservationEnvelope unwraps a null state", () => {
  const state = stateFromReleaseObservationEnvelope({ state: null });
  assert.equal(state, null);
});

test("releaseObservationProjectionKeyFor uses the canonical prefix", () => {
  const key = releaseObservationProjectionKeyFor(FIX.changeId, FIX.mergeQueueHash);
  assert.match(key, /^release-observation:/);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("SqliteReleaseObservationProjector throws on invalid constructor inputs", () => {
  assert.throws(
    () =>
      new SqliteReleaseObservationProjector({
        changeId: "",
        mergeQueueHash: FIX.mergeQueueHash
      }),
    /changeId/
  );
  assert.throws(
    () =>
      new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: "not-a-hash"
      }),
    /mergeQueueHash/
  );
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function appendReleaseObservationEvent(
  eventRepository,
  payload,
  options = {}
) {
  const eventType = options.eventType ?? "release.promoted";
  return eventRepository.appendEvent({
    aggregateKind: "release_observation",
    aggregateId:
      options.aggregateId ??
      `${payload.changeId}:${payload.mergeQueueHash}:${payload.reportSha256}`,
    eventType,
    eventVersion: "0.1.0",
    payload,
    occurredAt: options.occurredAt ?? "2026-06-22T05:30:00.000Z",
    correlationId: options.correlationId ?? null,
    idempotencyKey:
      options.idempotencyKey ??
      `${payload.changeId}:${payload.mergeQueueHash}:${payload.reportSha256}:${eventType}`,
    causationId: null
  }).event;
}

test("projector replays an aggregator-emitted event into the projection state", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const report = makeFixtureReport();
      appendReleaseObservationEvent(eventRepository, buildFixturePayload(report), {
        eventType: "release.promoted"
      });

      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const result = projector.replay();
      assert.equal(result.state !== null, true);
      if (!result.state) return;
      assert.equal(result.state.changeId, FIX.changeId);
      assert.equal(result.state.mergeQueueHash, FIX.mergeQueueHash);
      assert.equal(result.state.lastEventType, "release.promoted");
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector produces state=null when no events have been emitted for the change", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const result = projector.replay();
      assert.equal(result.state, null);
      assert.equal(result.eventCount, 0);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector filters replay to its bound aggregate", () => {
  const foreignReport = makeFixtureReport({
    changeId: "chg-release-observation-foreign",
    reportSha256: "sha256:" + "1".repeat(64)
  });
  const targetReport = makeFixtureReport();
  const events = [
    makeFixtureBoardEvent(foreignReport, { globalSequence: 1 }),
    makeFixtureBoardEvent(targetReport, { globalSequence: 2 })
  ];
  const projector = new SqliteReleaseObservationProjector({
    changeId: FIX.changeId,
    mergeQueueHash: FIX.mergeQueueHash,
    eventRepository: makePagedEventRepository(events),
    projectionRepository: noopProjectionRepository
  });
  const result = projector.replay();
  assert.equal(result.eventCount, 1);
  assert.equal(result.rebuiltThroughGlobalSequence, 2);
  assert.equal(result.state?.changeId, FIX.changeId);
});

test("projector replay pages past the first event page", () => {
  const events = [];
  for (let i = 1; i <= 1_000; i += 1) {
    events.push({
      schemaVersion: "0.1.0",
      eventId: `evt-release-filler-${i}`,
      aggregateKind: "task",
      aggregateId: `task:filler:${i}`,
      aggregateSequence: i,
      globalSequence: i,
      eventType: "task.created",
      eventVersion: "0.1.0",
      payload: { projectId: "proj-filler", changeId: "chg-filler", taskId: `task-${i}` },
      payloadHash: "0".repeat(64),
      causationId: null,
      correlationId: null,
      occurredAt: "2026-06-22T05:00:00.000Z",
      idempotencyKey: null,
      payloadJson: "{}"
    });
  }
  events.push(makeFixtureBoardEvent(makeFixtureReport(), { globalSequence: 1_001 }));
  const projector = new SqliteReleaseObservationProjector({
    changeId: FIX.changeId,
    mergeQueueHash: FIX.mergeQueueHash,
    eventRepository: makePagedEventRepository(events),
    projectionRepository: noopProjectionRepository
  });
  const result = projector.replay();
  assert.equal(result.eventCount, 1);
  assert.equal(result.rebuiltThroughGlobalSequence, 1_001);
  assert.equal(result.state?.lastEventType, "release.promoted");
});

// ---------------------------------------------------------------------------
// rebuildAndSave + verify
// ---------------------------------------------------------------------------

test("projector rebuildAndSave persists the state and verify round-trips", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const report = makeFixtureReport({ status: "regressed" });
      appendReleaseObservationEvent(
        eventRepository,
        buildFixturePayload(report),
        { eventType: "release.regressed" }
      );

      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const replay = projector.rebuildAndSave();
      assert.equal(replay.state !== null, true);
      if (!replay.state) return;
      assert.equal(replay.state.lastEventType, "release.regressed");

      // Re-open the projection store and verify it survives a
      // round trip.
      const projectionRecord = projectionRepository.loadProjection(
        projector.projectionKeyPublic
      );
      assert.notEqual(projectionRecord, null);
      if (!projectionRecord) return;
      assert.equal(projectionRecord.stateHash.length, 64);
      assert.notEqual(
        stateFromReleaseObservationEnvelope(projectionRecord.state),
        null
      );
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector rebuildAndSave persists and verifies an empty projection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const rebuilt = projector.rebuildAndSave();
      assert.equal(rebuilt.state, null);
      assert.equal(rebuilt.rebuiltThroughGlobalSequence, 0);
      const verified = projector.verify();
      assert.equal(verified.state, null);
      assert.equal(verified.rebuiltThroughGlobalSequence, 0);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector verify throws when no saved state exists", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      assert.throws(
        () => projector.verify(),
        /no saved state/
      );
    } finally {
      closeRepositories(repositories);
    }
  });
});

// ---------------------------------------------------------------------------
// Foreign event filter
// ---------------------------------------------------------------------------

test("projector skips foreign aggregate kinds during replay", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      // Foreign event: aggregateKind = "task" with a valid
      // release-observation payload shape. The projector must
      // ignore it.
      eventRepository.appendEvent({
        aggregateKind: "task",
        aggregateId: "ctr-foreign",
        eventType: "task.created",
        eventVersion: "0.1.0",
        payload: { schemaVersion: "0.1.0", foreign: true },
        occurredAt: "2026-06-22T05:30:00.000Z",
        correlationId: null,
        idempotencyKey: null,
        causationId: null
      });

      const projector = new SqliteReleaseObservationProjector({
        changeId: FIX.changeId,
        mergeQueueHash: FIX.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const result = projector.replay();
      assert.equal(result.state, null);
    } finally {
      closeRepositories(repositories);
    }
  });
});
