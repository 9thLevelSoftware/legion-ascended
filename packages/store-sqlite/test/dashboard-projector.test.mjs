/**
 * P11-T01 — SqliteDashboardProjector tests.
 *
 * Mirrors the P09-T02 / P10-T01 projector test style:
 * exercises the SQLite-backed projector against a real
 * SQLite database to prove the projector replays board
 * events into the projection store and verifies the
 * projection drift-free.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  openSqliteBoardEventRepository,
  openSqliteBoardProjectionRepository,
  openSqliteBoardStore,
  SqliteDashboardProjector
} from "../dist/index.js";

import {
  dashboardProjectionKey,
  DASHBOARD_PROJECTION_VERSION,
  replayDashboard
} from "@legion/board";

import {
  DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS,
  buildTaskCreatedAppendInput,
  buildTaskTransitionedAppendInput,
  buildChangeAggregatedAppendInput,
  buildReleasePromotedAppendInput
} from "./dashboard-fixture.mjs";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p11-t01-dash-"));
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

function appendFixtureEvents(eventRepository, appendInputs) {
  return eventRepository.appendEvents({ events: appendInputs }).events;
}

function boardEventFromAppendInput(input, globalSequence) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-dashboard-page-${globalSequence}`,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateSequence: globalSequence,
    globalSequence,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    payload: input.payload,
    payloadHash: "0".repeat(64),
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? null,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey ?? null,
    payloadJson: JSON.stringify(input.payload)
  };
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

test("projector replays task.* events into the dashboard projection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildTaskCreatedAppendInput({
          taskId: "task-1",
          fromStatus: "queued",
          occurredAt: "2026-06-22T05:00:00.000Z"
        }),
        buildTaskCreatedAppendInput({
          taskId: "task-2",
          fromStatus: "queued",
          occurredAt: "2026-06-22T05:00:01.000Z"
        }),
        buildTaskTransitionedAppendInput({
          taskId: "task-1",
          fromStatus: "queued",
          toStatus: "ready",
          occurredAt: "2026-06-22T05:00:02.000Z"
        })
      ]);

      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      assert.equal(replay.state.taskStatusCounts.queued, 1);
      assert.equal(replay.state.taskStatusCounts.ready, 1);
      assert.equal(replay.state.aggregateKindCounts.task, 3);
      assert.equal(replay.state.eventCount, 3);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector produces state=null when no events are present", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      // The dashboard reducer yields `state === null` when no
      // events have been observed yet. The projector surfaces
      // that null directly so the CLI can render the
      // "absent" dashboard state.
      assert.equal(replay.state, null);
      assert.equal(replay.eventCount, 0);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector rebuildAndSave persists projection state for downstream verify", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildChangeAggregatedAppendInput({
          status: "accepted",
          outcome: "integrated",
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        })
      ]);

      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      const persisted = projector.rebuildAndSave();
      assert.equal(persisted.state.approvalPointers.length, 1);
      assert.equal(persisted.state.approvalPointers[0].verdict, "approved");
      assert.equal(persisted.state.releaseObservationPointers.length, 1);
      assert.equal(persisted.state.releaseObservationPointers[0].status, "promoted");
      assert.equal(
        persisted.stateHash.startsWith("sha256:"),
        false,
        "SQLite projector must strip the sha256: prefix"
      );

      const verified = projector.verify();
      assert.equal(verified.stateHash, persisted.stateHash);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector verify throws on drift when an event is appended after rebuild", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildChangeAggregatedAppendInput({
          status: "accepted",
          outcome: "integrated",
          occurredAt: "2026-06-22T05:10:00.000Z"
        })
      ]);

      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      projector.rebuildAndSave();

      // Append a new event AFTER the rebuild to force a drift.
      appendFixtureEvents(eventRepository, [
        buildChangeAggregatedAppendInput({
          status: "rejected",
          outcome: "rejected",
          occurredAt: "2026-06-22T05:11:00.000Z"
        })
      ]);

      assert.throws(() => projector.verify(), /drift detected/);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector exposes the bound projectId and canonical projection key/version", () => {
  const dummyRepo = {
    listEvents() { return []; },
    appendEvent() { throw new Error("not used"); },
    appendEvents() { throw new Error("not used"); },
    getEvent() { return null; },
    getEventByIdempotencyKey() { return null; },
    countEvents() { return 0; },
    tail() { return []; }
  };
  const projector = new SqliteDashboardProjector({
    projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
    eventRepository: dummyRepo,
    projectionRepository: dummyRepo
  });
  assert.equal(projector.projectId, DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId);
  assert.equal(
    projector.projectionKeyPublic,
    `dashboard:${DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId}`
  );
  assert.equal(projector.projectionVersionPublic, DASHBOARD_PROJECTION_VERSION);
});

test("projector projection key matches the canonical dashboard:<projectId> shape", () => {
  assert.equal(
    dashboardProjectionKey(DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId),
    `dashboard:${DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId}`
  );
});

test("projector throws on invalid constructor inputs", () => {
  const dummyRepo = {
    listEvents() { return []; },
    appendEvent() { throw new Error("not used"); },
    appendEvents() { throw new Error("not used"); },
    getEvent() { return null; },
    getEventByIdempotencyKey() { return null; },
    countEvents() { return 0; },
    tail() { return []; }
  };
  assert.throws(
    () =>
      new SqliteDashboardProjector({
        projectId: "",
        eventRepository: dummyRepo,
        projectionRepository: dummyRepo
      }),
    /projectId must be a non-empty branded string/
  );
  assert.throws(
    () =>
      new SqliteDashboardProjector({
        projectId: "proj-x",
        eventRepository: null,
        projectionRepository: dummyRepo
      }),
    /eventRepository is required/
  );
  assert.throws(
    () =>
      new SqliteDashboardProjector({
        projectId: "proj-x",
        eventRepository: dummyRepo,
        projectionRepository: null
      }),
    /projectionRepository is required/
  );
});

test("projector replay() matches replayDashboard() output for the same event log", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const appended = appendFixtureEvents(eventRepository, [
        buildTaskCreatedAppendInput({
          taskId: "task-x",
          fromStatus: "queued",
          occurredAt: "2026-06-22T05:00:00.000Z"
        }),
        buildChangeAggregatedAppendInput({
          status: "accepted",
          outcome: "integrated",
          occurredAt: "2026-06-22T05:10:00.000Z"
        })
      ]);

      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      const projectorState = projector.replay().state;
      const directState = replayDashboard(appended, {
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId
      });
      assert.deepEqual(projectorState, directState);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector replay pages past the first event page", () => {
  const events = [];
  for (let i = 1; i <= 1_000; i += 1) {
    events.push(
      boardEventFromAppendInput(
        buildTaskCreatedAppendInput({
          taskId: `task-page-${i}`,
          occurredAt: `2026-06-22T05:00:${String(i % 60).padStart(2, "0")}.000Z`,
          idempotencyKey: `dashboard-page-${i}`
        }),
        i
      )
    );
  }
  events.push(
    boardEventFromAppendInput(
      buildChangeAggregatedAppendInput({
        status: "accepted",
        outcome: "integrated",
        occurredAt: "2026-06-22T05:20:00.000Z",
        idempotencyKey: "dashboard-page-tail"
      }),
      1_001
    )
  );

  const projector = new SqliteDashboardProjector({
    projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
    eventRepository: makePagedEventRepository(events),
    projectionRepository: noopProjectionRepository
  });
  const replay = projector.replay();
  assert.equal(replay.eventCount, 1_001);
  assert.ok(replay.state !== null);
  assert.equal(replay.state.approvalPointers.length, 1);
  assert.equal(replay.state.rebuiltThroughGlobalSequence, 1_001);
});

test("projector seeds the bound project for canonical events without projectId", () => {
  const accepted = boardEventFromAppendInput(
    buildChangeAggregatedAppendInput({
      status: "accepted",
      outcome: "integrated",
      occurredAt: "2026-06-22T05:20:00.000Z",
      idempotencyKey: "dashboard-canonical-accepted"
    }),
    1
  );
  delete accepted.payload.projectId;
  const foreign = boardEventFromAppendInput(
    buildChangeAggregatedAppendInput({
      projectId: "proj-dashboard-foreign",
      changeId: "chg-dashboard-foreign",
      status: "rejected",
      outcome: "rejected",
      occurredAt: "2026-06-22T05:21:00.000Z",
      idempotencyKey: "dashboard-canonical-foreign"
    }),
    2
  );

  const projector = new SqliteDashboardProjector({
    projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
    eventRepository: makePagedEventRepository([accepted, foreign]),
    projectionRepository: noopProjectionRepository
  });
  const replay = projector.replay();
  assert.ok(replay.state !== null);
  assert.equal(replay.state.projectId, DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId);
  assert.equal(replay.state.approvalPointers.length, 1);
  assert.equal(replay.state.approvalPointers[0].changeId, DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.changeId);
});

test("projector ignore foreign project events (dashboard is project-scoped)", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildTaskCreatedAppendInput({
          taskId: "task-ours",
          projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
          changeId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.changeId,
          fromStatus: "queued",
          occurredAt: "2026-06-22T05:00:00.000Z"
        }),
        buildTaskCreatedAppendInput({
          taskId: "task-foreign",
          projectId: "proj-foreign",
          changeId: "chg-foreign",
          fromStatus: "queued",
          occurredAt: "2026-06-22T05:00:01.000Z"
        })
      ]);

      const projector = new SqliteDashboardProjector({
        projectId: DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      // Only our project tasks contribute to the dashboard's
      // counter surface and event count. Foreign-project events
      // are silently dropped by the reducer.
      assert.equal(replay.state.taskStatusCounts.queued, 1);
      assert.equal(replay.state.eventCount, 1);
    } finally {
      closeRepositories(repositories);
    }
  });
});
