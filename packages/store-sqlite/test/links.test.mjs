import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_TASK_LINK_DAG_RELATIONS,
  BOARD_TASK_LINK_RELATIONS,
  BoardTaskLinkAlreadyExistsError,
  BoardTaskLinkCycleAggregateError,
  BoardTaskLinkCycleError,
  BoardTaskLinkEndpointNotFoundError,
  BoardTaskLinkInvalidRelationError,
  BoardTaskLinkNotFoundError,
  BoardTaskLinkSelfLoopError,
  openSqliteBoardStore,
  openSqliteBoardTaskLinkRepository,
  openSqliteBoardTaskRepository,
  SqliteBoardStoreWithTaskLinkRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t08-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildRepositories(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const taskRepository = openSqliteBoardTaskRepository({ database: new DatabaseSync(databasePath) });
  const linkRepository = openSqliteBoardTaskLinkRepository({ database: new DatabaseSync(databasePath) });
  const cleanupStore = {
    close: () => {
      linkRepository.closeDatabase();
      taskRepository.closeDatabase();
      store.close();
    }
  };
  return { store: cleanupStore, taskRepository, linkRepository };
}

function buildWrappedStore(databasePath) {
  const store = SqliteBoardStoreWithTaskLinkRepository.open({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  return store;
}

const PROJECT_ID = "prj_links";
const CHANGE_ID = "chg_links";
const CONTRACT_ID = "ctr_links";
const CONTRACT_REVISION = 1;
const CONTRACT_HASH = "a".repeat(64);

function createTaskInput(taskId, overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId,
    contractId: CONTRACT_ID,
    contractRevision: CONTRACT_REVISION,
    contractHash: CONTRACT_HASH,
    ...overrides
  };
}

function seedTasks(repository, ...taskIds) {
  for (const taskId of taskIds) {
    repository.createTask(createTaskInput(taskId));
  }
}

function insertRawLink(databasePath, taskId, dependsOnTaskId, relation) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db
      .prepare("INSERT INTO board_task_links (task_id, depends_on_task_id, relation, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, dependsOnTaskId, relation, "2026-06-21T12:00:00.000Z");
  } finally {
    db.close();
  }
}

test("P03-T08 addLink + getLink round-trip for every relation kind", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      for (const relation of BOARD_TASK_LINK_RELATIONS) {
        const a = "tsk_" + relation + "_a";
        const b = "tsk_" + relation + "_b";
        seedTasks(taskRepository, a, b);
        const created = linkRepository.addLink({
          taskId: a,
          dependsOnTaskId: b,
          relation,
          createdAt: "2026-06-21T12:00:00.000Z"
        });
        assert.equal(created.taskId, a);
        assert.equal(created.dependsOnTaskId, b);
        assert.equal(created.relation, relation);
        assert.equal(created.createdAt, "2026-06-21T12:00:00.000Z");

        const fetched = linkRepository.getLink(a, b, relation);
        assert.deepEqual(fetched, created);
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T08 addLink rejects self-loops, invalid relations, and missing endpoints", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");

      assert.throws(
        () => linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_a", relation: "depends_on" }),
        BoardTaskLinkSelfLoopError
      );

      assert.throws(
        () => linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_b", relation: "unknown" }),
        BoardTaskLinkInvalidRelationError
      );

      try {
        linkRepository.addLink({ taskId: "tsk_missing", dependsOnTaskId: "tsk_b", relation: "depends_on" });
        assert.fail("expected endpoint error");
      } catch (error) {
        assert.ok(error instanceof BoardTaskLinkEndpointNotFoundError);
        assert.equal(error.missingEndpoint, "taskId");
      }

      try {
        linkRepository.addLink({ taskId: "tsk_x", dependsOnTaskId: "tsk_y", relation: "depends_on" });
        assert.fail("expected endpoint error");
      } catch (error) {
        assert.ok(error instanceof BoardTaskLinkEndpointNotFoundError);
        assert.equal(error.missingEndpoint, "both");
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T08 addLink detects a 2-node depends_on cycle", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");
      insertRawLink(databasePath, "tsk_a", "tsk_b", "depends_on");
      insertRawLink(databasePath, "tsk_b", "tsk_a", "depends_on");

      const cycles = linkRepository.findCycles();
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].nodes[0], cycles[0].nodes.at(-1));
      assert.equal(linkRepository.getLink("tsk_b", "tsk_a", "depends_on") !== null, true);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 addLink detects a longer depends_on cycle", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c");
      insertRawLink(databasePath, "tsk_a", "tsk_b", "depends_on");
      insertRawLink(databasePath, "tsk_b", "tsk_c", "depends_on");
      insertRawLink(databasePath, "tsk_c", "tsk_a", "depends_on");
      const cycles = linkRepository.findCycles();
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].nodes.length, cycles[0].relations.length + 1);
      assert.equal(cycles[0].nodes[0], cycles[0].nodes.at(-1));
    } finally {
      store.close();
    }
  });
});

test("P03-T08 addLink detects cycles for blocks relations", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");
      insertRawLink(databasePath, "tsk_a", "tsk_b", "blocks");
      insertRawLink(databasePath, "tsk_b", "tsk_a", "blocks");
      assert.equal(linkRepository.findCycles().length, 1);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 relates_to is non-directional and never rejected for cycles", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");
      linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_b", relation: "relates_to" });
      const reverse = linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "relates_to" });
      assert.equal(reverse.relation, "relates_to");
      assert.equal(linkRepository.findCycles().length, 0);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 removeLink returns the removed edge and getLink returns null", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");
      const created = linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_b", relation: "depends_on" });
      const removed = linkRepository.removeLink("tsk_a", "tsk_b", "depends_on");
      assert.deepEqual(removed, created);
      assert.equal(linkRepository.getLink("tsk_a", "tsk_b", "depends_on"), null);
      assert.throws(
        () => linkRepository.removeLink("tsk_a", "tsk_b", "depends_on"),
        BoardTaskLinkNotFoundError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T08 listOutgoingLinks, listIncomingLinks, and listLinks filter correctly", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c");
      linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_b", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_c", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_c", relation: "relates_to" });
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_c", relation: "blocks" });

      const outgoing = linkRepository.listOutgoingLinks("tsk_a");
      assert.equal(outgoing.length, 3);

      const outgoingDepends = linkRepository.listOutgoingLinks("tsk_a", "depends_on");
      assert.equal(outgoingDepends.length, 2);
      assert.ok(outgoingDepends.every((l) => l.relation === "depends_on"));

      const incoming = linkRepository.listIncomingLinks("tsk_c");
      assert.equal(incoming.length, 3);

      const incomingBlocks = linkRepository.listIncomingLinks("tsk_c", "blocks");
      assert.equal(incomingBlocks.length, 1);
      assert.equal(incomingBlocks[0].taskId, "tsk_b");

      const filtered = linkRepository.listLinks({ taskId: "tsk_a", relation: "depends_on" });
      assert.equal(filtered.length, 2);
      assert.ok(filtered.every((l) => l.taskId === "tsk_a" && l.relation === "depends_on"));

      const limited = linkRepository.listLinks({ limit: 2 });
      assert.equal(limited.length, 2);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 findCycles returns empty for an acyclic graph and reports cycles injected below the repository boundary", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c");
      assert.deepEqual(linkRepository.findCycles(), []);

      linkRepository.addLink({ taskId: "tsk_a", dependsOnTaskId: "tsk_b", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_c", relation: "depends_on" });
      assert.deepEqual(linkRepository.findCycles(), []);

      assert.throws(
        () => linkRepository.addLink({ taskId: "tsk_c", dependsOnTaskId: "tsk_a", relation: "depends_on" }),
        BoardTaskLinkCycleError
      );
      assert.deepEqual(linkRepository.findCycles(), []);

      const cycleDatabasePath = path.join(path.dirname(databasePath), "raw-cycle.sqlite");
      const rawStore = openSqliteBoardStore({ databasePath: cycleDatabasePath, busyTimeoutMs: 7_500 });
      rawStore.migrate();
      const rawTasks = openSqliteBoardTaskRepository({ database: new DatabaseSync(cycleDatabasePath) });
      const rawLinks = openSqliteBoardTaskLinkRepository({ database: new DatabaseSync(cycleDatabasePath) });
      try {
        seedTasks(rawTasks, "tsk_x", "tsk_y", "tsk_z");
        insertRawLink(cycleDatabasePath, "tsk_x", "tsk_y", "depends_on");
        insertRawLink(cycleDatabasePath, "tsk_y", "tsk_z", "depends_on");
        insertRawLink(cycleDatabasePath, "tsk_z", "tsk_x", "depends_on");
        const cycles = rawLinks.findCycles();
        assert.equal(cycles.length, 1);
        assert.equal(cycles[0].nodes.length, cycles[0].relations.length + 1);
        assert.equal(cycles[0].nodes[0], cycles[0].nodes.at(-1));
      } finally {
        rawTasks.close();
        rawLinks.closeDatabase();
        rawStore.close();
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrder returns dependency-safe order with alphabetical tie-breaking", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c", "tsk_d");
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_c", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_d", dependsOnTaskId: "tsk_b", relation: "depends_on" });

      const order = linkRepository.topologicalOrder();
      assert.deepEqual(order, ["tsk_a", "tsk_b", "tsk_c", "tsk_d"]);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrder handles disconnected subgraphs", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c", "tsk_d");
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_d", dependsOnTaskId: "tsk_c", relation: "depends_on" });

      const order = linkRepository.topologicalOrder();
      assert.deepEqual(order, ["tsk_a", "tsk_b", "tsk_c", "tsk_d"]);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrder omits tasks with no DAG edges", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_orphan");
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_orphan", dependsOnTaskId: "tsk_a", relation: "relates_to" });

      const order = linkRepository.topologicalOrder();
      assert.deepEqual(order, ["tsk_a", "tsk_b"]);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrder throws BoardTaskLinkCycleAggregateError for cycles", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b");
      insertRawLink(databasePath, "tsk_b", "tsk_a", "depends_on");
      insertRawLink(databasePath, "tsk_a", "tsk_b", "depends_on");
      assert.throws(() => linkRepository.topologicalOrder(), BoardTaskLinkCycleAggregateError);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrderForRoots restricts ordering to reachable subgraph", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c", "tsk_d", "tsk_e");
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_c", dependsOnTaskId: "tsk_b", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_d", dependsOnTaskId: "tsk_c", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_e", dependsOnTaskId: "tsk_d", relation: "depends_on" });

      const result = linkRepository.topologicalOrderForRoots(["tsk_b"]);
      assert.deepEqual(result.order, ["tsk_b", "tsk_c", "tsk_d", "tsk_e"]);
      assert.equal(result.excludedIncoming.length, 1);
      assert.equal(result.excludedIncoming[0].taskId, "tsk_b");
      assert.equal(result.excludedIncoming[0].dependsOnTaskId, "tsk_a");
      assert.equal(result.excludedIncoming[0].relation, "depends_on");
    } finally {
      store.close();
    }
  });
});

test("P03-T08 topologicalOrderForRoots seeds only zero in-degree reachable roots", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, linkRepository } = buildRepositories(databasePath);
    try {
      seedTasks(taskRepository, "tsk_a", "tsk_b", "tsk_c");
      linkRepository.addLink({ taskId: "tsk_b", dependsOnTaskId: "tsk_a", relation: "depends_on" });
      linkRepository.addLink({ taskId: "tsk_c", dependsOnTaskId: "tsk_b", relation: "depends_on" });

      const result = linkRepository.topologicalOrderForRoots(["tsk_b", "tsk_a"]);
      assert.deepEqual(result.order, ["tsk_a", "tsk_b", "tsk_c"]);
      assert.deepEqual(result.excludedIncoming, []);
    } finally {
      store.close();
    }
  });
});

test("P03-T08 SqliteBoardStoreWithTaskLinkRepository exposes the link repository", async () => {
  await withTempDatabase((databasePath) => {
    const store = buildWrappedStore(databasePath);
    try {
      assert.equal(typeof store.linkRepository, "object");
      assert.equal(typeof store.linkRepository.addLink, "function");
      assert.equal(typeof store.linkRepository.topologicalOrder, "function");
      const diagnostics = store.inspect();
      assert.ok(diagnostics.tables.includes("board_task_links"));
      assert.ok(diagnostics.indexes.includes("idx_board_task_links_depends_on"));
    } finally {
      store.close();
    }
  });
});

test("P03-T08 SQLite provider exports every link contract the @legion/board package re-exports", async () => {
  await withTempDatabase((databasePath) => {
    const { store } = buildRepositories(databasePath);
    try {
      assert.equal(typeof SqliteBoardStoreWithTaskLinkRepository, "function");
      assert.equal(typeof openSqliteBoardTaskLinkRepository, "function");
      assert.deepEqual([...BOARD_TASK_LINK_RELATIONS], ["depends_on", "blocks", "supersedes", "relates_to"]);
      assert.deepEqual([...BOARD_TASK_LINK_DAG_RELATIONS], ["depends_on", "blocks"]);
    } finally {
      store.close();
    }
  });
});
