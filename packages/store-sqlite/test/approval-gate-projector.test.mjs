/**
 * P11-T01 — SqliteApprovalGateProjector tests.
 *
 * Mirrors the P09-T02 / P10-T01 projector test style:
 * exercises the SQLite-backed projector against a real
 * SQLite database to prove the projector replays the
 * per-(projectId, changeId) approval verdict and verifies
 * the projection drift-free.
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
  SqliteApprovalGateProjector
} from "../dist/index.js";

import {
  approvalGateProjectionKey,
  APPROVAL_GATE_PROJECTION_VERSION,
  replayApprovalGate
} from "@legion/board";

import {
  APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS,
  buildAggregatedAcceptedAppendInput,
  buildAggregatedRejectedAppendInput,
  buildReleasePromotedAppendInput,
  buildReleaseRegressedAppendInput
} from "./approval-gate-fixture.mjs";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p11-t01-gate-"));
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

test("projector yields verdict=approved for accepted + promoted", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildAggregatedAcceptedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      assert.equal(replay.state.verdict, "approved");
      assert.equal(replay.state.wholeChangeStatus, "accepted");
      assert.equal(replay.state.releaseObservationStatus, "promoted");
      assert.equal(
        replay.state.mergeQueueHash,
        APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.mergeQueueHash
      );
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector yields verdict=rejected for whole-change rejection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildAggregatedRejectedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      assert.equal(replay.state.verdict, "rejected");
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector yields verdict=pending when no events present", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
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

test("projector rolls verdict back to rejected on release.regressed", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildAggregatedAcceptedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        }),
        buildReleaseRegressedAppendInput({
          occurredAt: "2026-06-22T05:45:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      assert.equal(replay.state.verdict, "rejected");
      assert.equal(replay.state.releaseObservationStatus, "regressed");
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
        buildAggregatedAcceptedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const persisted = projector.rebuildAndSave();
      assert.equal(persisted.state !== null, true);
      assert.equal(persisted.state.verdict, "approved");
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
        buildAggregatedAcceptedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      projector.rebuildAndSave();

      // Append a release.promoted AFTER the rebuild to force a drift.
      appendFixtureEvents(eventRepository, [
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        })
      ]);

      assert.throws(() => projector.verify(), /drift detected/);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector exposes the bound (projectId, changeId) and canonical projection key/version", () => {
  const dummyRepo = {
    listEvents() { return []; },
    appendEvent() { throw new Error("not used"); },
    appendEvents() { throw new Error("not used"); },
    getEvent() { return null; },
    getEventByIdempotencyKey() { return null; },
    countEvents() { return 0; },
    tail() { return []; }
  };
  const projector = new SqliteApprovalGateProjector({
    projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
    changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
    eventRepository: dummyRepo,
    projectionRepository: dummyRepo
  });
  assert.equal(projector.projectId, APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId);
  assert.equal(projector.changeId, APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId);
  assert.equal(
    projector.projectionKeyPublic,
    approvalGateProjectionKey(
      APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
      APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId
    )
  );
  assert.equal(projector.projectionVersionPublic, APPROVAL_GATE_PROJECTION_VERSION);
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
      new SqliteApprovalGateProjector({
        projectId: "",
        changeId: "chg",
        eventRepository: dummyRepo,
        projectionRepository: dummyRepo
      }),
    /projectId must be a non-empty branded string/
  );
  assert.throws(
    () =>
      new SqliteApprovalGateProjector({
        projectId: "proj",
        changeId: "",
        eventRepository: dummyRepo,
        projectionRepository: dummyRepo
      }),
    /changeId must be a non-empty branded string/
  );
  assert.throws(
    () =>
      new SqliteApprovalGateProjector({
        projectId: "proj",
        changeId: "chg",
        eventRepository: null,
        projectionRepository: dummyRepo
      }),
    /eventRepository is required/
  );
  assert.throws(
    () =>
      new SqliteApprovalGateProjector({
        projectId: "proj",
        changeId: "chg",
        eventRepository: dummyRepo,
        projectionRepository: null
      }),
    /projectionRepository is required/
  );
});

test("projector replay() matches replayApprovalGate() output for the same event log", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const appended = appendFixtureEvents(eventRepository, [
        buildAggregatedAcceptedAppendInput({
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildReleasePromotedAppendInput({
          occurredAt: "2026-06-22T05:30:00.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const projectorState = projector.replay().state;
      const directState = replayApprovalGate(appended);
      assert.deepEqual(projectorState, directState);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector ignores foreign (projectId, changeId) events", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, [
        buildAggregatedAcceptedAppendInput({
          projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
          changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
          occurredAt: "2026-06-22T05:10:00.000Z"
        }),
        buildAggregatedAcceptedAppendInput({
          projectId: "proj-foreign",
          changeId: "chg-foreign",
          occurredAt: "2026-06-22T05:10:01.000Z"
        })
      ]);

      const projector = new SqliteApprovalGateProjector({
        projectId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.projectId,
        changeId: APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS.changeId,
        eventRepository,
        projectionRepository
      });

      const replay = projector.replay();
      assert.ok(replay.state !== null);
      assert.equal(replay.state.eventCount, 1);
      assert.equal(replay.state.wholeChangeStatus, "accepted");
      assert.equal(replay.state.verdict, "pending");
    } finally {
      closeRepositories(repositories);
    }
  });
});