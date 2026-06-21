import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BoardProjectionDriftError,
  openSqliteBoardEventRepository,
  openSqliteBoardProjectionRepository,
  openSqliteBoardStore,
  SqliteBoardProjectionRebuilder,
  SqliteBoardProjectionRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t03-proj-"));
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
  const cleanupStore = {
    close: () => {
      projectionRepository.closeDatabase();
      store.close();
    }
  };
  return { store: cleanupStore, eventRepository, projectionRepository };
}

function taskStatusReducer(state, event) {
  const tasks = { ...state.tasks };
  switch (event.eventType) {
    case "task.created": {
      const payload = event.payload;
      tasks[payload.taskId] = {
        taskId: payload.taskId,
        projectId: payload.projectId,
        status: payload.status,
        priority: payload.priority,
        generation: payload.generation,
        updatedAt: payload.updatedAt
      };
      break;
    }
    case "task.transitioned": {
      const payload = event.payload;
      const existing = tasks[payload.taskId];
      if (existing) {
        tasks[payload.taskId] = {
          ...existing,
          status: payload.nextStatus,
          generation: payload.nextGeneration,
          updatedAt: payload.occurredAt
        };
      }
      break;
    }
    case "task.priority_changed": {
      const payload = event.payload;
      const existing = tasks[payload.taskId];
      if (existing) {
        tasks[payload.taskId] = {
          ...existing,
          priority: payload.nextPriority,
          updatedAt: payload.occurredAt
        };
      }
      break;
    }
    case "task.deleted": {
      const payload = event.payload;
      delete tasks[payload.taskId];
      break;
    }
  }
  return { ...state, tasks };
}

function makeTaskEvent(taskId, eventType, payload) {
  return {
    aggregateKind: "task",
    aggregateId: taskId,
    eventType,
    payload
  };
}

test("P03-T03 saveProjection inserts and updates a projection with optimistic version CAS", async () => {
  await withTempDatabase((databasePath) => {
    const { store, projectionRepository } = buildRepositories(databasePath);
    try {
      const inserted = projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        rebuiltThroughGlobalSequence: 5,
        state: { tasks: {} }
      });
      assert.equal(inserted.projectionKey, "tasks.status");
      assert.equal(inserted.projectionVersion, 1);
      assert.equal(inserted.rebuiltThroughGlobalSequence, 5);
      assert.equal(inserted.stateHash.length, 64);

      const loaded = projectionRepository.loadProjection("tasks.status");
      assert.deepEqual(loaded.state, { tasks: {} });

      const updated = projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 2,
        rebuiltThroughGlobalSequence: 7,
        state: { tasks: { tsk_1: { status: "ready" } } },
        expectedProjectionVersion: 1
      });
      assert.equal(updated.projectionVersion, 2);
      assert.equal(updated.rebuiltThroughGlobalSequence, 7);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 saveProjection throws BoardProjectionDriftError on version mismatch", async () => {
  await withTempDatabase((databasePath) => {
    const { store, projectionRepository } = buildRepositories(databasePath);
    try {
      projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        rebuiltThroughGlobalSequence: 5,
        state: { tasks: {} }
      });
      assert.throws(
        () =>
          projectionRepository.saveProjection({
            projectionKey: "tasks.status",
            projectionVersion: 3,
            rebuiltThroughGlobalSequence: 6,
            state: { tasks: {} },
            expectedProjectionVersion: 2
          }),
        (error) => error instanceof BoardProjectionDriftError && error.drift.projectionKey === "tasks.status"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T03 deleteProjection removes a projection and respects expected version", async () => {
  await withTempDatabase((databasePath) => {
    const { store, projectionRepository } = buildRepositories(databasePath);
    try {
      projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        rebuiltThroughGlobalSequence: 5,
        state: { tasks: {} }
      });
      assert.throws(
        () => projectionRepository.deleteProjection("tasks.status", 2),
        (error) => error instanceof BoardProjectionDriftError
      );
      assert.ok(projectionRepository.deleteProjection("tasks.status", 1));
      assert.equal(projectionRepository.loadProjection("tasks.status"), null);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 listStaleProjections returns projections behind a global sequence", async () => {
  await withTempDatabase((databasePath) => {
    const { store, projectionRepository } = buildRepositories(databasePath);
    try {
      projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        rebuiltThroughGlobalSequence: 3,
        state: { tasks: {} }
      });
      projectionRepository.saveProjection({
        projectionKey: "tasks.count",
        projectionVersion: 1,
        rebuiltThroughGlobalSequence: 7,
        state: { count: 0 }
      });
      const stale = projectionRepository.listStaleProjections(5);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].projectionKey, "tasks.status");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 rebuilder replays events in order to produce deterministic projection state", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository, projectionRepository } = buildRepositories(databasePath);
    try {
      const rebuilder = new SqliteBoardProjectionRebuilder({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        initialState: { tasks: {} },
        reduce: taskStatusReducer,
        eventRepository,
        projectionRepository
      });

      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.created", {
          taskId: "tsk_alpha",
          projectId: "prj_alpha",
          status: "queued",
          priority: 500,
          generation: 1,
          updatedAt: "2026-06-21T12:00:00.000Z"
        })
      );
      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.transitioned", {
          taskId: "tsk_alpha",
          nextStatus: "ready",
          nextGeneration: 1,
          occurredAt: "2026-06-21T12:01:00.000Z"
        })
      );
      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.priority_changed", {
          taskId: "tsk_alpha",
          nextPriority: 900,
          occurredAt: "2026-06-21T12:02:00.000Z"
        })
      );

      const report = rebuilder.rebuildAndSave();
      assert.equal(report.projectionKey, "tasks.status");
      assert.equal(report.projectionVersion, 1);
      assert.equal(report.eventCount, 3);
      assert.equal(report.rebuiltThroughGlobalSequence, 2);
      assert.equal(report.state.tasks.tsk_alpha.status, "ready");
      assert.equal(report.state.tasks.tsk_alpha.priority, 900);
      assert.equal(report.stateHash.length, 64);

      const saved = projectionRepository.loadProjection("tasks.status");
      assert.deepEqual(saved.state, report.state);
      assert.equal(saved.stateHash, report.stateHash);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 rebuilder replay is deterministic: same events produce same state hash", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository, projectionRepository } = buildRepositories(databasePath);
    try {
      const rebuilder = new SqliteBoardProjectionRebuilder({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        initialState: { tasks: {} },
        reduce: taskStatusReducer,
        eventRepository,
        projectionRepository
      });

      for (let i = 0; i < 3; i++) {
        eventRepository.appendEvent(
          makeTaskEvent(`tsk_${i}`, "task.created", {
            taskId: `tsk_${i}`,
            projectId: "prj_alpha",
            status: "queued",
            priority: 500,
            generation: 1,
            updatedAt: "2026-06-21T12:00:00.000Z"
          })
        );
      }

      const first = rebuilder.replay();
      const second = rebuilder.replay();
      assert.equal(first.stateHash, second.stateHash);
      assert.equal(first.eventCount, second.eventCount);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 rebuild can recover a projection after its derived state is deleted", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository, projectionRepository } = buildRepositories(databasePath);
    try {
      const rebuilder = new SqliteBoardProjectionRebuilder({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        initialState: { tasks: {} },
        reduce: taskStatusReducer,
        eventRepository,
        projectionRepository
      });

      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.created", {
          taskId: "tsk_alpha",
          projectId: "prj_alpha",
          status: "queued",
          priority: 500,
          generation: 1,
          updatedAt: "2026-06-21T12:00:00.000Z"
        })
      );
      const original = rebuilder.rebuildAndSave();
      projectionRepository.deleteProjection("tasks.status");
      assert.equal(projectionRepository.loadProjection("tasks.status"), null);

      const recovered = rebuilder.rebuildAndSave();
      assert.deepEqual(recovered.state, original.state);
      assert.equal(recovered.stateHash, original.stateHash);
      assert.equal(recovered.rebuiltThroughGlobalSequence, original.rebuiltThroughGlobalSequence);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 verify detects drift and confirms consistency", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository, projectionRepository } = buildRepositories(databasePath);
    try {
      const rebuilder = new SqliteBoardProjectionRebuilder({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        initialState: { tasks: {} },
        reduce: taskStatusReducer,
        eventRepository,
        projectionRepository
      });

      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.created", {
          taskId: "tsk_alpha",
          projectId: "prj_alpha",
          status: "queued",
          priority: 500,
          generation: 1,
          updatedAt: "2026-06-21T12:00:00.000Z"
        })
      );
      rebuilder.rebuildAndSave();
      assert.ok(rebuilder.verify());

      // Mutate the projection directly to simulate drift.
      projectionRepository.saveProjection({
        projectionKey: "tasks.status",
        projectionVersion: 2,
        rebuiltThroughGlobalSequence: 0,
        state: { tasks: { tsk_alpha: { status: "corrupted" } } }
      });
      assert.throws(() => rebuilder.verify(), (error) => error instanceof BoardProjectionDriftError);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 rebuilder rebuildAndSave advances projection version atomically", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository, projectionRepository } = buildRepositories(databasePath);
    try {
      const rebuilder = new SqliteBoardProjectionRebuilder({
        projectionKey: "tasks.status",
        projectionVersion: 1,
        initialState: { tasks: {} },
        reduce: taskStatusReducer,
        eventRepository,
        projectionRepository
      });

      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.created", {
          taskId: "tsk_alpha",
          projectId: "prj_alpha",
          status: "queued",
          priority: 500,
          generation: 1,
          updatedAt: "2026-06-21T12:00:00.000Z"
        })
      );
      const first = rebuilder.rebuildAndSave();
      assert.equal(first.projectionVersion, 1);
      assert.equal(first.rebuiltThroughGlobalSequence, 0);

      eventRepository.appendEvent(
        makeTaskEvent("tsk_alpha", "task.transitioned", {
          taskId: "tsk_alpha",
          nextStatus: "ready",
          nextGeneration: 1,
          occurredAt: "2026-06-21T12:01:00.000Z"
        })
      );
      const second = rebuilder.rebuildAndSave({ expectedProjectionVersion: 1 });
      assert.equal(second.projectionVersion, 1);
      assert.equal(second.rebuiltThroughGlobalSequence, 1);
      assert.equal(second.state.tasks.tsk_alpha.status, "ready");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 SQLite provider exports every projection contract the board package re-exports", async () => {
  await withTempDatabase((databasePath) => {
    const { store } = buildRepositories(databasePath);
    try {
      assert.equal(typeof SqliteBoardProjectionRepository, "function");
      assert.equal(typeof SqliteBoardProjectionRebuilder, "function");
    } finally {
      store.close();
    }
  });
});
