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

import { makeOrchestratorSuccess, WHOLE_CHANGE_FIXTURE_CONSTANTS } from "./whole-change-fixture.mjs";

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

test("projector projection key matches the canonical whole_change.acceptance:<changeId> shape", () => {
  const expected = wholeChangeAcceptanceProjectionKey(WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(
    expected,
    `whole_change.acceptance:${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}`
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
    eventRepository: dummyRepo,
    projectionRepository: dummyRepo
  });
  assert.equal(projector.changeId, WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId);
  assert.equal(projector.projectionKeyPublic, `whole_change.acceptance:${WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId}`);
  assert.equal(projector.projectionVersionPublic, WHOLE_CHANGE_PROJECTION_VERSION);
});

test("projector throws on invalid constructor inputs", () => {
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: "",
        eventRepository: {},
        projectionRepository: {}
      }),
    /changeId must be a non-empty branded string/
  );
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        eventRepository: null,
        projectionRepository: {}
      }),
    /eventRepository is required/
  );
  assert.throws(
    () =>
      new SqliteWholeChangeAcceptanceProjector({
        changeId: WHOLE_CHANGE_FIXTURE_CONSTANTS.changeId,
        eventRepository: {},
        projectionRepository: null
      }),
    /projectionRepository is required/
  );
});