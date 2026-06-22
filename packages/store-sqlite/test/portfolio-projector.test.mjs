/**
 * P11-T02 — SqlitePortfolioProjector tests.
 *
 * Mirrors the P09-T02 / P10-T01 / P11-T01 projector test
 * style: exercises the SQLite-backed portfolio projector
 * against a real SQLite database to prove the projector
 * replays board events into the projection store and
 * verifies the projection drift-free.
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
  SqlitePortfolioProjector
} from "../dist/index.js";

import {
  portfolioProjectionKey,
  PORTFOLIO_PROJECTION_VERSION,
  replayPortfolio,
  asTenantId,
  derivePortfolioProjectionStateHash
} from "@legion/board";

import {
  PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS,
  buildTaskCreatedAppendInput,
  buildTaskTransitionedAppendInput,
  buildTaskLinkedAppendInput,
  buildChangeAggregatedAppendInput,
  buildReleasePromotedAppendInput,
  buildMultiProjectAppendStream
} from "./portfolio-fixture.mjs";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p11-t02-portfolio-"));
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
    eventId: `evt-portfolio-page-${globalSequence}`,
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

test("projector replays multi-project events into the portfolio projection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, buildMultiProjectAppendStream());

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository
      });
      const report = projector.replay();

      assert.equal(report.projectionKey, "portfolio:tnt-portfolio-fixture-001");
      assert.equal(
        report.tenantId,
        PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
      );
      assert.equal(report.eventCount, 6);
      assert.ok(report.state !== null);
      assert.ok(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA
        ]
      );
      assert.ok(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectB
        ]
      );
      assert.equal(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA
        ].taskCount,
        2
      );
      assert.equal(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectB
        ].taskCount,
        1
      );
      assert.equal(report.state.crossProjectDependencyCount, 1);
      assert.equal(report.state.dependencyEdges.length, 1);
      assert.equal(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA
        ].lastApprovalVerdict,
        "accepted"
      );
      assert.equal(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA
        ].lastReleaseObservationStatus,
        "release.promoted"
      );
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector rebuildAndSave persists the projection state", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, buildMultiProjectAppendStream());

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository
      });
      const rebuilt = projector.rebuildAndSave();
      const projectionKey = portfolioProjectionKey(
        asTenantId(PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId)
      );
      const stored = projectionRepository.loadProjection(projectionKey);
      assert.ok(stored !== null);
      assert.equal(stored.projectionKey, projectionKey);
      assert.equal(stored.projectionVersion, PORTFOLIO_PROJECTION_VERSION);
      assert.equal(stored.rebuiltThroughGlobalSequence, rebuilt.rebuiltThroughGlobalSequence);
      // The projector strips the `sha256:` prefix before
      // persisting; verify the persisted hash matches the
      // raw hex digest.
      assert.equal(stored.stateHash, rebuilt.stateHash);
      assert.equal(stored.stateHash.length, 64);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector verify succeeds when the persisted state matches a fresh replay", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, buildMultiProjectAppendStream());

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository
      });
      const rebuilt = projector.rebuildAndSave();
      const verified = projector.verify();
      assert.equal(verified.stateHash, rebuilt.stateHash);
      assert.equal(verified.rebuiltThroughGlobalSequence, rebuilt.rebuiltThroughGlobalSequence);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector verify fails closed on missing projection", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId("tnt-portfolio-empty-001"),
        eventRepository,
        projectionRepository
      });
      assert.throws(() => projector.verify(), /has no saved state/);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector verify fails closed on drift after appended event", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, buildMultiProjectAppendStream());

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository
      });
      projector.rebuildAndSave();

      // Append another event WITHOUT rebuilding — this
      // should make a fresh replay produce a different
      // hash and verify should fail closed.
      appendFixtureEvents(eventRepository, [
        buildTaskTransitionedAppendInput({
          taskId: "task-a-1",
          projectId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA,
          changeId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.changeA1,
          fromStatus: "queued",
          toStatus: "running",
          globalSequence: 99,
          occurredAt: "2026-06-22T06:00:00.000Z"
        })
      ]);
      assert.throws(() => projector.verify(), /drift detected/);
    } finally {
      closeRepositories(repositories);
    }
  });
});

test("projector replay matches replayPortfolio output for the same event log", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      const appended = appendFixtureEvents(
        eventRepository,
        buildMultiProjectAppendStream()
      );

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository
      });
      const projectorReport = projector.replay();

      const direct = replayPortfolio(appended, {
        tenantId: asTenantId(PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId)
      });
      const directHash = derivePortfolioProjectionStateHash(direct);
      const projectorHash = derivePortfolioProjectionStateHash(
        projectorReport.state
      );
      assert.equal(projectorHash, directHash);
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
          taskId: `foreign-task-${i}`,
          projectId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectB,
          changeId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.changeB1,
          globalSequence: i
        }),
        i
      )
    );
  }
  events.push(
    boardEventFromAppendInput(
      buildTaskCreatedAppendInput({
        taskId: "scoped-tail-task",
        projectId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA,
        changeId: PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.changeA1,
        globalSequence: 1_001
      }),
      1_001
    )
  );

  const projector = new SqlitePortfolioProjector({
    tenantId: asTenantId(PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId),
    eventRepository: makePagedEventRepository(events),
    projectionRepository: noopProjectionRepository,
    scope: [PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA]
  });
  const replay = projector.replay();
  assert.ok(replay.state !== null);
  assert.equal(
    replay.state.projectRollups[PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA].taskCount,
    1
  );
  assert.equal(replay.rebuiltThroughGlobalSequence, 1_001);
});

test("projector constructor validates required arguments", () => {
  const fakeEventRepo = {};
  const fakeProjectionRepo = {};
  assert.throws(
    () =>
      new SqlitePortfolioProjector({
        tenantId: "",
        eventRepository: fakeEventRepo,
        projectionRepository: fakeProjectionRepo
      }),
    /tenantId/
  );
  assert.throws(
    () =>
      new SqlitePortfolioProjector({
        tenantId: asTenantId("tnt-x"),
        eventRepository: null,
        projectionRepository: fakeProjectionRepo
      }),
    /eventRepository/
  );
  assert.throws(
    () =>
      new SqlitePortfolioProjector({
        tenantId: asTenantId("tnt-x"),
        eventRepository: fakeEventRepo,
        projectionRepository: null
      }),
    /projectionRepository/
  );
});

test("projector supports an explicit scope filter", async () => {
  await withTempDatabase(async (databasePath) => {
    const repositories = buildRepositories(databasePath);
    const { eventRepository, projectionRepository } = repositories;
    try {
      appendFixtureEvents(eventRepository, buildMultiProjectAppendStream());

      const projector = new SqlitePortfolioProjector({
        tenantId: asTenantId(
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.tenantId
        ),
        eventRepository,
        projectionRepository,
        scope: [PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA]
      });
      const report = projector.replay();
      assert.ok(
        report.state !== null &&
          report.state.projectRollups[
            PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectA
          ] !== undefined
      );
      assert.equal(
        report.state.projectRollups[
          PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS.projectB
        ],
        undefined
      );
      assert.equal(report.state.crossProjectDependencyCount, 0);
    } finally {
      closeRepositories(repositories);
    }
  });
});
