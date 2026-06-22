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
