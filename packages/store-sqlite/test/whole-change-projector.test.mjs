/**
 * P09-T02 — SqliteWholeChangeAcceptanceProjector tests.
 *
 * Exercises the SQLite-backed projector against a real SQLite
 * database to prove the projector replays aggregator-emitted
 * events into the board's projection store and verifies the
 * projection drift-free.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  openSqliteBoardEventRepository,
  openSqliteBoardProjectionRepository,
  openSqliteBoardStore,
  SqliteWholeChangeAcceptanceProjector
} from "../dist/index.js";

import {
  buildWholeChangeAcceptance,
  wholeChangeAcceptanceProjectionKey,
  WHOLE_CHANGE_PROJECTION_VERSION
} from "@legion/board";

import {
  makeBoardEvent,
  makeForeignBoardEvent,
  makeOrchestratorSuccess,
  WHOLE_CHANGE_FIXTURE_CONSTANTS
} from "./whole-change-fixture.mjs";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p09-t02-proj-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildRepositories(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const database = new DatabaseSync(databasePath);
  const eventRepository = openSqliteBoardEventRepository({ database });
  const projectionRepository = openSqliteBoardProjectionRepository({ database });
  return { store, database, eventRepository, projectionRepository };
}

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

function appendEvent(eventRepository, payload, options) {
  const result = eventRepository.appendEvent({
    aggregateKind: "whole_change",
    aggregateId: `${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`,
    eventType: options.eventType,
    eventVersion: "0.1.0",
    payload,
    occurredAt: options.occurredAt ?? "2026-06-22T04:00:00.000Z",
    correlationId: options.correlationId ?? null,
    idempotencyKey: options.idempotencyKey ?? null,
    causationId: null
  });
  return result.event;
}

test("projector replays an aggregator-emitted event into the projection store", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const orchestratorResult = makeOrchestratorSuccess();
      const aggregatorResult = buildWholeChangeAcceptance({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        orchestratorResult,
        acceptedBy: "ci-bot",
        now: () => "2026-06-22T04:00:00.000Z"
      });
      const event = aggregatorResult.events[0];

      appendEvent(eventRepository, event.payload, {
        eventType: "change.accepted",
        idempotencyKey: event.idempotencyKey
      });

      const projector = new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.equal(replay.state !== null, true);
      assert.equal(replay.state.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
      assert.equal(replay.state.status, "accepted");
      assert.equal(replay.state.aggregatorHash, aggregatorResult.aggregatorHash);

      const persisted = projector.rebuildAndSave();
      assert.equal(persisted.state.aggregatorHash, replay.state.aggregatorHash);

      const verified = projector.verify();
      assert.equal(verified.state.aggregatorHash, replay.state.aggregatorHash);
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
      const projector = new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.equal(replay.state, null);
      assert.equal(replay.eventCount, 0);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector filters replay to its bound change and merge queue", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const aggregatorResult = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now: () => "2026-06-22T04:00:00.000Z"
  });
  const event = aggregatorResult.events[0];
  const foreign = makeBoardEvent({
    payload: event.payload,
    globalSequence: 1,
    aggregateId: `chg-other:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`
  });
  const target = makeBoardEvent({
    payload: event.payload,
    globalSequence: 2,
    eventType: event.eventType
  });
  const projector = new SqliteWholeChangeAcceptanceProjector({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
    eventRepository: makePagedEventRepository([foreign, target]),
    projectionRepository: noopProjectionRepository
  });
  const replay = projector.replay();
  assert.equal(replay.eventCount, 1);
  assert.equal(replay.rebuiltThroughGlobalSequence, 2);
  assert.equal(replay.state?.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
});

test("projector replay pages past the first event page", () => {
  const orchestratorResult = makeOrchestratorSuccess();
  const aggregatorResult = buildWholeChangeAcceptance({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    orchestratorResult,
    acceptedBy: "ci-bot",
    now: () => "2026-06-22T04:00:00.000Z"
  });
  const events = [];
  for (let i = 1; i <= 1_000; i += 1) {
    events.push(makeForeignBoardEvent({ globalSequence: i }));
  }
  events.push(
    makeBoardEvent({
      payload: aggregatorResult.events[0].payload,
      globalSequence: 1_001,
      eventType: aggregatorResult.events[0].eventType
    })
  );
  const projector = new SqliteWholeChangeAcceptanceProjector({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
    eventRepository: makePagedEventRepository(events),
    projectionRepository: noopProjectionRepository
  });
  const replay = projector.replay();
  assert.equal(replay.eventCount, 1);
  assert.equal(replay.rebuiltThroughGlobalSequence, 1_001);
  assert.equal(replay.state?.status, "accepted");
});

test("projector rebuildAndSave persists and verifies an empty projection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
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

test("projector projection key matches the canonical whole_change.acceptance:<changeId>:<mergeQueueHash> shape", () => {
  const expected = wholeChangeAcceptanceProjectionKey(
    WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash
  );
  assert.equal(
    expected,
    `whole_change.acceptance:${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`
  );
});

test("projector exposes the bound changeId and the canonical projection key/version", () => {
  const dummyRepo = {
    listEvents() { return []; },
    appendEvent() { throw new Error("not used"); },
    appendEvents() { throw new Error("not used"); },
    getEvent() { return null; },
    getEventByIdempotencyKey() { return null; },
    countEvents() { return 0; },
    tail() { return []; }
  };
  const projector = new SqliteWholeChangeAcceptanceProjector({
    changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
    mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
    eventRepository: dummyRepo,
    projectionRepository: dummyRepo
  });
  assert.equal(projector.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(projector.mergeQueueHash, WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash);
  assert.equal(
    projector.projectionKeyPublic,
    `whole_change.acceptance:${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}:${WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash}`
  );
  assert.equal(projector.projectionVersionPublic, WHOLE_CHANGE_PROJECTION_VERSION);
});

test("projector throws on invalid constructor inputs", () => {
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: "",
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
        eventRepository: {},
        projectionRepository: {}
      }),
    /changeId must be a non-empty branded string/
  );
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: "not-a-hash",
        eventRepository: {},
        projectionRepository: {}
      }),
    /mergeQueueHash must be a sha256: prefixed content hash/
  );
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
        eventRepository: null,
        projectionRepository: {}
      }),
    /eventRepository is required/
  );
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        mergeQueueHash: WHOLE_CHANGE_FIXTURE_CONSTANTS.mergeQueueHash,
        eventRepository: {},
        projectionRepository: null
      }),
    /projectionRepository is required/
  );
});
