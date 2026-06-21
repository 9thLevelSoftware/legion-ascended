import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BOARD_LEASE_TOKEN_MIN_LENGTH,
  BoardOutboxTerminalStatusError,
  openSqliteBoardClaimRepository,
  openSqliteBoardEventRepository,
  openSqliteBoardOutboxRepository,
  openSqliteBoardProjectionRepository,
  openSqliteBoardStore,
  openSqliteBoardTaskRepository,
  SqliteBoardProjectionRebuilder,
  SqliteBoardStoreWithOutboxRepository,
  SqliteBoardStoreWithRepository
} from "../dist/index.js";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t10-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function closeDatabase(repository) {
  try {
    repository.closeDatabase();
  } catch {
    // Best-effort cleanup for integration tests.
  }
}

function corruptDatabaseFiles(databasePath) {
  return Promise.all([
    writeFile(databasePath, "not a sqlite database"),
    writeFile(`${databasePath}-wal`, "not a sqlite wal"),
    writeFile(`${databasePath}-shm`, "not a sqlite shm")
  ]);
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
      delete tasks[event.payload.taskId];
      break;
    }
  }
  return { ...state, tasks };
}

function createTaskInput(overrides = {}) {
  return {
    projectId: "prj_integration",
    changeId: "chg_integration",
    taskId: "tsk_integration",
    contractId: "ctr_integration",
    contractRevision: 1,
    contractHash: "a".repeat(64),
    initialStatus: "ready",
    ...overrides
  };
}

function createOutboxInput(overrides = {}) {
  return {
    effectClass: "S0",
    effectKind: "board.integration.deliver",
    targetHash: "b".repeat(64),
    payload: { taskId: "tsk_integration", version: 1 },
    ...overrides
  };
}

test("P03-T10 board integration recovers claimed tasks from a backup after storage corruption", async () => {
  await withTempDatabase(async (databasePath, root) => {
    const backupPath = path.join(root, "recovered-board.sqlite");
    const taskRepositoryStore = SqliteBoardStoreWithRepository.open({ databasePath, busyTimeoutMs: 7_500 });
    const claimRepository = openSqliteBoardClaimRepository({ database: new DatabaseSync(databasePath) });
    let claim;
    try {
      taskRepositoryStore.migrate();
      taskRepositoryStore.repository.createTask(createTaskInput());

      claim = claimRepository.tryClaim({
        taskId: "tsk_integration",
        expectedGeneration: 1,
        ownerId: "worker_integration",
        leaseDurationMs: 30_000,
        runId: "run_integration",
        claimedAt: "2026-06-21T12:00:00.000Z"
      });

      assert.ok(claim.leaseToken.length >= BOARD_LEASE_TOKEN_MIN_LENGTH);
      assert.equal(claim.releasedAt, null);
      assert.equal(claim.releaseReason, null);

      const backup = taskRepositoryStore.backupTo(backupPath);
      assert.equal(backup.sha256.length, 64);
    } finally {
      closeDatabase(claimRepository);
      taskRepositoryStore.close();
    }

    await corruptDatabaseFiles(databasePath);

    assert.throws(() => {
      let corruptedStore;
      try {
        corruptedStore = openSqliteBoardStore({ databasePath });
        corruptedStore.migrate();
      } finally {
        corruptedStore?.close();
      }
    }, Error);

    const recoveredTaskRepository = openSqliteBoardTaskRepository({ database: new DatabaseSync(backupPath) });
    const recoveredClaimRepository = openSqliteBoardClaimRepository({ database: new DatabaseSync(backupPath) });
    try {
      const recoveredTask = recoveredTaskRepository.getTask("tsk_integration");
      assert.equal(recoveredTask.taskId, "tsk_integration");
      assert.equal(recoveredTask.status, "ready");

      const activeClaim = recoveredClaimRepository.getActiveClaimForTask("tsk_integration");
      assert.equal(activeClaim.taskId, "tsk_integration");
      assert.equal(activeClaim.ownerId, "worker_integration");

      const reclaimed = recoveredClaimRepository.reclaimExpiredLeases({ now: "2026-06-21T12:01:00.000Z" });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].leaseToken, claim.leaseToken);
      assert.equal(reclaimed[0].releaseReason, "expired");
    } finally {
      closeDatabase(recoveredClaimRepository);
      closeDatabase(recoveredTaskRepository);
    }
  });
});

test("P03-T10 board integration replays repository events after backup restore", async () => {
  await withTempDatabase(async (databasePath, root) => {
    const backupPath = path.join(root, "replay-board.sqlite");
    const store = SqliteBoardStoreWithRepository.open({ databasePath, busyTimeoutMs: 7_500 });
    try {
      store.migrate();
      const repository = store.repository;
      repository.createTask(createTaskInput());
      repository.transitionTaskStatus("tsk_integration", { toStatus: "claimed" }, 1);
      repository.updateTaskPriority("tsk_integration", 900, 1);

      const backup = store.backupTo(backupPath);
      assert.equal(backup.sha256.length, 64);
    } finally {
      store.close();
    }

    const eventDatabase = new DatabaseSync(backupPath);
    const projectionDatabase = new DatabaseSync(backupPath);
    const eventRepository = openSqliteBoardEventRepository({ database: eventDatabase });
    const projectionRepository = openSqliteBoardProjectionRepository({ database: projectionDatabase });
    const rebuilder = new SqliteBoardProjectionRebuilder({
      projectionKey: "tasks.integration",
      projectionVersion: 1,
      initialState: { tasks: {} },
      reduce: taskStatusReducer,
      eventRepository,
      projectionRepository
    });

    try {
      const replay = rebuilder.replay();
      assert.equal(replay.eventCount, 3);
      assert.equal(replay.state.tasks.tsk_integration.status, "claimed");
      assert.equal(replay.state.tasks.tsk_integration.priority, 900);

      const report = rebuilder.rebuildAndSave();
      assert.equal(report.rebuiltThroughGlobalSequence, 2);
      assert.equal(report.stateHash, replay.stateHash);
      assert.ok(rebuilder.verify());
    } finally {
      projectionDatabase.close();
      eventDatabase.close();
    }
  });
});

test("P03-T10 board integration preserves outbox delivery state across backup restore", async () => {
  await withTempDatabase(async (databasePath, root) => {
    const backupPath = path.join(root, "outbox-board.sqlite");
    const fixedNow = () => "2026-06-21T12:00:00.000Z";
    const store = SqliteBoardStoreWithOutboxRepository.open(
      { databasePath, busyTimeoutMs: 7_500 },
      { now: fixedNow }
    );
    try {
      store.migrate();
      const created = store.outboxRepository.enqueueOutbox(
        createOutboxInput({
          outboxId: "outbox_integration",
          idempotencyKey: "idem-outbox-integration"
        })
      );
      assert.equal(created.status, "pending");

      const claimed = store.outboxRepository.claimOutbox({
        outboxId: created.outboxId,
        claimedBy: "worker_integration",
        claimedUntil: "2026-06-21T12:05:00.000Z",
        now: "2026-06-21T12:00:00.000Z"
      });
      assert.equal(claimed.status, "claimed");
      assert.equal(claimed.attempts, 1);

      const succeeded = store.outboxRepository.markOutboxAttempt({
        outboxId: created.outboxId,
        result: "succeeded",
        updatedAt: "2026-06-21T12:00:05.000Z"
      });
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.claimedBy, null);

      const backup = store.backupTo(backupPath);
      assert.equal(backup.sha256.length, 64);
    } finally {
      store.close();
    }

    const recoveredOutboxRepository = openSqliteBoardOutboxRepository({ database: new DatabaseSync(backupPath) });
    try {
      const delivered = recoveredOutboxRepository.getOutbox("outbox_integration");
      assert.equal(delivered.status, "succeeded");
      assert.equal(delivered.attempts, 1);
      assert.equal(delivered.idempotencyKey, "idem-outbox-integration");
      assert.deepEqual(recoveredOutboxRepository.listOutbox({ status: ["pending"] }), []);
      assert.equal(recoveredOutboxRepository.listOutbox({ status: ["succeeded"] }).length, 1);

      assert.throws(
        () =>
          recoveredOutboxRepository.claimOutbox({
            outboxId: delivered.outboxId,
            claimedBy: "worker_retry",
            claimedUntil: "2026-06-21T12:10:00.000Z",
            now: "2026-06-21T12:06:00.000Z"
          }),
        (error) => error instanceof BoardOutboxTerminalStatusError
      );
    } finally {
      closeDatabase(recoveredOutboxRepository);
    }
  });
});
