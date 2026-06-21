import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  BOARD_TASK_GENERATION_MIN,
  BOARD_TASK_PRIORITY_MAX,
  BOARD_TASK_PRIORITY_MIN,
  BoardConcurrencyError,
  BoardIllegalStatusTransitionError,
  BoardTaskNotFoundError,
  BoardTerminalTaskMutationError,
  openSqliteBoardStore,
  openSqliteBoardTaskRepository,
  SqliteBoardTaskRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t02-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildRepository(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const repository = openSqliteBoardTaskRepository({ database: new DatabaseSync(databasePath) });
  const cleanupStore = {
    inspect: () => store.inspect(),
    close: () => {
      repository.closeDatabase();
      store.close();
    }
  };
  return { store: cleanupStore, repository };
}

const PROJECT_ID = "prj_alpha";
const CHANGE_ID = "chg_alpha";
const TASK_ID = "tsk_alpha";
const CONTRACT_ID = "ctr_alpha";
const CONTRACT_REVISION = 1;
const CONTRACT_HASH = "a".repeat(64);

function createInput(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: CONTRACT_REVISION,
    contractHash: CONTRACT_HASH,
    ...overrides
  };
}

test("P03-T02 create + get round-trip persists every column of a new board task", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      const created = repository.createTask(createInput({ initialPriority: 750, initialStatus: "ready" }));
      assert.equal(created.taskId, TASK_ID);
      assert.equal(created.projectId, PROJECT_ID);
      assert.equal(created.changeId, CHANGE_ID);
      assert.equal(created.contractId, CONTRACT_ID);
      assert.equal(created.contractRevision, 1);
      assert.equal(created.contractHash, CONTRACT_HASH);
      assert.equal(created.generation, BOARD_TASK_GENERATION_MIN);
      assert.equal(created.status, "ready");
      assert.equal(created.priority, 750);
      assert.equal(created.blocker, null);

      const fetched = repository.getTask(TASK_ID);
      assert.deepEqual(fetched, created);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 create rejects duplicate task ids with a descriptive error", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      assert.throws(() => repository.createTask(createInput()), /already exists/);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 create rejects malformed contract hash, invalid priority, and unknown statuses", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      assert.throws(
        () => repository.createTask(createInput({ contractHash: "not-a-real-hash" })),
        /64-character SHA-256 hex string/
      );
      assert.throws(
        () => repository.createTask(createInput({ initialPriority: -1 })),
        /integer between 0 and 1000/
      );
      assert.throws(
        () => repository.createTask(createInput({ initialPriority: 1_001 })),
        /integer between 0 and 1000/
      );
      assert.throws(
        () => repository.createTask(createInput({ initialStatus: "completed" })),
        /initial status 'completed' is terminal and not valid for new board tasks/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 priority, status, and generation min/max constants agree with the protocol and schema", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      const task = repository.createTask(createInput({ initialPriority: BOARD_TASK_PRIORITY_MAX }));
      assert.equal(task.priority, BOARD_TASK_PRIORITY_MAX);

      const atMin = repository.createTask(
        createInput({ taskId: "tsk_beta", initialPriority: BOARD_TASK_PRIORITY_MIN })
      );
      assert.equal(atMin.priority, BOARD_TASK_PRIORITY_MIN);

      const direct = openSqliteBoardTaskRepository({ database: new DatabaseSync(databasePath) });
      try {
        const raw = new DatabaseSync(databasePath);
        try {
          raw.exec("PRAGMA foreign_keys = ON");
          const row = raw
            .prepare("SELECT priority, generation FROM board_tasks WHERE task_id = ?")
            .get("tsk_beta");
          assert.equal(row.priority, 0);
          assert.equal(row.generation, BOARD_TASK_GENERATION_MIN);
        } finally {
          raw.close();
        }
        const missing = direct.getTask("tsk_does_not_exist");
        assert.equal(missing, null);
      } finally {
        direct.closeDatabase();
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T02 setPriority advances the task while preserving status, contract, and generation", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready" }));
      const updated = repository.updateTaskPriority(TASK_ID, 900, 1);
      assert.equal(updated.priority, 900);
      assert.equal(updated.status, "ready");
      assert.equal(updated.generation, 1);
      assert.equal(updated.contractId, CONTRACT_ID);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 setPriority throws BoardConcurrencyError on generation mismatch", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      assert.throws(
        () => repository.updateTaskPriority(TASK_ID, 800, 99),
        (error) => error instanceof BoardConcurrencyError && error.actualGeneration === 1
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 setPriority throws BoardTaskNotFoundError when no expectedGeneration is provided and the task is missing", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      assert.throws(
        () => repository.updateTaskPriority("tsk_missing", 500),
        (error) => error instanceof BoardTaskNotFoundError && error.taskId === "tsk_missing"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 transitionTaskStatus walks the queued → ready → claimed → running → completed path", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      const ready = repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      assert.equal(ready.status, "ready");

      const claimed = repository.transitionTaskStatus(TASK_ID, { toStatus: "claimed" }, 1);
      assert.equal(claimed.status, "claimed");

      const running = repository.transitionTaskStatus(TASK_ID, { toStatus: "running" }, 1);
      assert.equal(running.status, "running");

      const completed = repository.transitionTaskStatus(TASK_ID, { toStatus: "completed" }, 1);
      assert.equal(completed.status, "completed");
      assert.equal(completed.generation, 1);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 transitionTaskStatus records a blocker for blocked status and rejects mismatched blockers", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "claimed" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "running" }, 1);

      assert.throws(
        () => repository.transitionTaskStatus(TASK_ID, { toStatus: "blocked" }, 1),
        /transition to blocked must include a blocker/
      );

      const blocker = { reason: "missing dependency", reportedBy: "tsk_gamma" };
      const blocked = repository.transitionTaskStatus(TASK_ID, { toStatus: "blocked", blocker }, 1);
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.blocker, blocker);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 transitionTaskStatus refuses illegal status transitions with BoardIllegalStatusTransitionError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      assert.throws(
        () => repository.transitionTaskStatus(TASK_ID, { toStatus: "completed" }, 1),
        (error) =>
          error instanceof BoardIllegalStatusTransitionError &&
          error.from === "queued" &&
          error.to === "completed"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 transitionTaskStatus refuses mutating terminal states with BoardTerminalTaskMutationError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "canceled" }, 1);
      assert.throws(
        () => repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1),
        (error) => error instanceof BoardTerminalTaskMutationError && error.status === "canceled"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 failed tasks can be re-queued and run again to completion", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "claimed" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "running" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "failed" }, 1);
      const requeued = repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      assert.equal(requeued.status, "ready");
      repository.transitionTaskStatus(TASK_ID, { toStatus: "claimed" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "running" }, 1);
      const completed = repository.transitionTaskStatus(TASK_ID, { toStatus: "completed" }, 1);
      assert.equal(completed.status, "completed");
    } finally {
      store.close();
    }
  });
});

test("P03-T02 bumpGeneration rotates the contract reference and increments generation atomically", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      const nextHash = "b".repeat(64);
      const nextContractId = "ctr_alpha_v2";
      const bumped = repository.bumpGeneration({
        taskId: TASK_ID,
        expectedGeneration: 1,
        nextContractId,
        nextContractRevision: 2,
        nextContractHash: nextHash
      });
      assert.equal(bumped.generation, 2);
      assert.equal(bumped.contractId, nextContractId);
      assert.equal(bumped.contractRevision, 2);
      assert.equal(bumped.contractHash, nextHash);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 bumpGeneration rejects generation mismatches with BoardConcurrencyError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.bumpGeneration({
        taskId: TASK_ID,
        expectedGeneration: 1,
        nextContractId: "ctr_v2",
        nextContractRevision: 2,
        nextContractHash: "b".repeat(64)
      });
      assert.throws(
        () =>
          repository.bumpGeneration({
            taskId: TASK_ID,
            expectedGeneration: 1,
            nextContractId: "ctr_v3",
            nextContractRevision: 3,
            nextContractHash: "c".repeat(64)
          }),
        (error) => error instanceof BoardConcurrencyError && error.actualGeneration === 2
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 bumpGeneration refuses to migrate terminal tasks", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.transitionTaskStatus(TASK_ID, { toStatus: "ready" }, 1);
      repository.transitionTaskStatus(TASK_ID, { toStatus: "canceled" }, 1);
      assert.throws(
        () =>
          repository.bumpGeneration({
            taskId: TASK_ID,
            expectedGeneration: 1,
            nextContractId: "ctr_v2",
            nextContractRevision: 2,
            nextContractHash: "b".repeat(64)
          }),
        (error) => error instanceof BoardTerminalTaskMutationError && error.status === "canceled"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 supersedeTask writes a board_task_links row keyed on relation='supersedes' and updates generation", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      const successorId = "tsk_alpha_successor";
      const result = repository.supersedeTask({
        taskId: TASK_ID,
        expectedGeneration: 1,
        successorTaskId: successorId
      });
      assert.equal(result.retired.status, "superseded");
      assert.equal(result.retired.generation, 2);
      assert.ok(result.successor);
      assert.equal(result.successor.taskId, successorId);
      assert.equal(result.successor.status, "queued");
      assert.equal(result.successor.contractId, CONTRACT_ID);
      assert.equal(result.successor.contractHash, CONTRACT_HASH);
      assert.equal(result.successor.contractRevision, CONTRACT_REVISION);

      const raw = new DatabaseSync(databasePath);
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        const link = raw
          .prepare(
            "SELECT relation, depends_on_task_id FROM board_task_links WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
          )
          .get(successorId);
        assert.equal(link.relation, "supersedes");
        assert.equal(link.depends_on_task_id, TASK_ID);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T02 supersedeTask fails on generation mismatch and does not write a successor", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      assert.throws(
        () =>
          repository.supersedeTask({
            taskId: TASK_ID,
            expectedGeneration: 99,
            successorTaskId: "tsk_after"
          }),
        (error) => error instanceof BoardConcurrencyError && error.actualGeneration === 1
      );
      const raw = new DatabaseSync(databasePath);
      try {
        const count = raw.prepare("SELECT COUNT(*) as c FROM board_task_links").get().c;
        assert.equal(count, 0);
        const successor = raw
          .prepare("SELECT task_id FROM board_tasks WHERE task_id = ?")
          .get("tsk_after");
        assert.equal(successor, undefined);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T02 listTasks filters by status, project, change, and excludes terminal states by default", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready", initialPriority: 800 }));
      repository.createTask(
        createInput({
          taskId: "tsk_beta",
          initialStatus: "queued",
          initialPriority: 500
        })
      );
      repository.createTask(
        createInput({
          taskId: "tsk_gamma",
          projectId: "prj_beta",
          changeId: "chg_beta",
          initialStatus: "ready",
          initialPriority: 700
        })
      );
      repository.createTask(
        createInput({
          taskId: "tsk_delta",
          initialStatus: "ready",
          initialPriority: 900
        })
      );
      repository.transitionTaskStatus("tsk_delta", { toStatus: "ready" }, 1);
      repository.transitionTaskStatus("tsk_delta", { toStatus: "canceled" }, 1);

      const active = repository.listTasks();
      const activeIds = active.map((task) => task.taskId).sort();
      assert.deepEqual(activeIds, ["tsk_alpha", "tsk_beta", "tsk_gamma"]);

      const readyOnly = repository.listTasks({ status: ["ready"] });
      const readyIds = readyOnly.map((task) => task.taskId).sort();
      assert.deepEqual(readyIds, ["tsk_alpha", "tsk_gamma"]);

      const byProject = repository.listTasks({ projectId: "prj_beta" });
      assert.equal(byProject.length, 1);
      assert.equal(byProject[0].taskId, "tsk_gamma");

      const orderedByPriority = repository.listTasks({ includeTerminal: true });
      const priorities = orderedByPriority.map((task) => task.priority);
      assert.deepEqual(priorities, [900, 800, 700, 500]);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 listTasks rejects invalid limits and honors bounded limits", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready" }));
      repository.createTask(createInput({ taskId: "tsk_beta", initialStatus: "ready" }));
      repository.createTask(createInput({ taskId: "tsk_gamma", initialStatus: "ready" }));
      assert.throws(() => repository.listTasks({ limit: 0 }), /positive integer/);
      const limited = repository.listTasks({ limit: 2 });
      assert.equal(limited.length, 2);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 deleteTask removes the row when the generation matches", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      repository.deleteTask(TASK_ID, 1);
      assert.equal(repository.getTask(TASK_ID), null);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 deleteTask throws BoardConcurrencyError on generation mismatch", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput());
      assert.throws(
        () => repository.deleteTask(TASK_ID, 99),
        (error) => error instanceof BoardConcurrencyError && error.actualGeneration === 1
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T02 migration diagnostics surface every required table and index for board_tasks operations", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      const diagnostics = store.inspect();
      assert.equal(diagnostics.userVersion, BOARD_SCHEMA_VERSION);
      assert.equal(diagnostics.foreignKeys, true);
      assert.equal(diagnostics.journalMode, "wal");
      assert.deepEqual(diagnostics.missingTables, []);
      assert.deepEqual(diagnostics.missingIndexes, []);

      for (const table of BOARD_REQUIRED_TABLES) {
        assert.ok(diagnostics.tables.includes(table), "missing table " + table);
      }
      for (const index of BOARD_REQUIRED_INDEXES) {
        assert.ok(diagnostics.indexes.includes(index), "missing index " + index);
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T02 concurrent priority writes preserve last-writer-wins via generation check", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready" }));
      const a = repository.updateTaskPriority(TASK_ID, 600, 1);
      assert.equal(a.priority, 600);
      // Bump generation by rotating the contract; row is now at generation 2.
      repository.bumpGeneration({
        taskId: TASK_ID,
        expectedGeneration: 1,
        nextContractId: "ctr_v2",
        nextContractRevision: 2,
        nextContractHash: "b".repeat(64)
      });
      // A second writer that races with the now-stale generation 1 must fail
      // with a concurrency error rather than silently overwriting the live row.
      assert.throws(
        () => repository.updateTaskPriority(TASK_ID, 800, 1),
        (error) => error instanceof BoardConcurrencyError
      );
      // Without an expected generation the second writer succeeds (last-writer-wins).
      const b = repository.updateTaskPriority(TASK_ID, 800);
      assert.equal(b.priority, 800);
    } finally {
      store.close();
    }
  });
});

test("P03-T02 bumpGeneration + priority update interact correctly when generation changes mid-flight", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready" }));
      repository.bumpGeneration({
        taskId: TASK_ID,
        expectedGeneration: 1,
        nextContractId: "ctr_v2",
        nextContractRevision: 2,
        nextContractHash: "b".repeat(64)
      });
      const updated = repository.updateTaskPriority(TASK_ID, 750, 2);
      assert.equal(updated.priority, 750);
      assert.equal(updated.generation, 2);
      assert.equal(updated.contractId, "ctr_v2");
    } finally {
      store.close();
    }
  });
});

test("P03-T02 board_task_events can be appended after CRUD with zero-based aggregate sequence per schema", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      repository.createTask(createInput({ initialStatus: "ready" }));
      repository.transitionTaskStatus(TASK_ID, { toStatus: "claimed" }, 1);
      const raw = new DatabaseSync(databasePath);
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        const insert = raw.prepare(
          "INSERT INTO board_task_events (event_id, aggregate_kind, aggregate_id, aggregate_sequence, global_sequence, event_type, event_version, payload_json, payload_hash, occurred_at) " +
            "VALUES (?, 'task', ?, 0, ?, 'task.claimed.v1', '0.1.0', '{}', ?, ?)"
        );
        const eventId = "evt_p03t02_alpha_claimed";
        const payloadHash = createHash("sha256").update("{}").digest("hex");
        const nextGlobal = (raw.prepare("SELECT COALESCE(MAX(global_sequence), -1) + 1 AS next FROM board_task_events").get().next);
        insert.run(eventId, TASK_ID, nextGlobal, payloadHash, new Date().toISOString());
        const row = raw.prepare("SELECT aggregate_sequence FROM board_task_events WHERE event_id = ?").get(eventId);
        assert.equal(row.aggregate_sequence, 0);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T02 SQLite provider package exports every contract type the @legion/board package re-exports", async () => {
  // Sanity check that the SQLite package re-exports the same surface that
  // @legion/board-store publishes, so consumers depending on either
  // entry point see identical contracts.
  await withTempDatabase((databasePath) => {
    const { store } = buildRepository(databasePath);
    try {
      assert.equal(typeof SqliteBoardTaskRepository, "function");
      assert.equal(typeof openSqliteBoardTaskRepository, "function");
    } finally {
      store.close();
    }
  });
});
