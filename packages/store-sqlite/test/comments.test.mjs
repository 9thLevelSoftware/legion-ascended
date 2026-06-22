import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_TASK_COMMENT_BODY_MAX_LENGTH,
  BoardTaskCommentNotFoundError,
  BoardTaskNotFoundError,
  openSqliteBoardStore,
  openSqliteBoardTaskCommentRepository,
  openSqliteBoardTaskRepository
} from "../dist/index.js";

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-comments-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildRepositories(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const tasks = openSqliteBoardTaskRepository({ database: new DatabaseSync(databasePath) });
  const comments = openSqliteBoardTaskCommentRepository({ database: new DatabaseSync(databasePath) });
  const cleanupStore = {
    close: () => {
      comments.closeDatabase();
      tasks.closeDatabase();
      store.close();
    }
  };
  return {
    store: cleanupStore,
    tasks,
    comments
  };
}

const PROJECT_ID = "prj_comment";
const CHANGE_ID = "chg_comment";
const TASK_ID = "tsk_comment";
const CONTRACT_ID = "ctr_comment";
const CONTRACT_HASH = "a".repeat(64);

const ACTOR = { id: "usr_1", kind: "human", displayName: "Test User" };

function createTaskInput(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: 1,
    contractHash: CONTRACT_HASH,
    ...overrides
  };
}

function createCommentInput(overrides = {}) {
  return {
    taskId: TASK_ID,
    actor: ACTOR,
    body: "A helpful comment.",
    ...overrides
  };
}

test("P03-comments create + get round-trip persists comment with task association and timestamps", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const created = comments.createComment(createCommentInput({ body: "First!" }));

      assert.equal(typeof created.commentId, "number");
      assert.equal(created.taskId, TASK_ID);
      assert.deepEqual(created.actor, ACTOR);
      assert.equal(created.body, "First!");
      assert.equal(created.createdAt, created.updatedAt);

      const fetched = comments.getComment(created.commentId);
      assert.deepEqual(fetched, created);
    } finally {
      store.close();
    }
  });
});

test("P03-comments list returns comments for a task ordered by creation time with task id", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const first = comments.createComment(createCommentInput({ body: "alpha" }));
      const second = comments.createComment(createCommentInput({ body: "beta" }));

      const listed = comments.listComments({ taskId: TASK_ID });
      assert.equal(listed.length, 2);
      assert.equal(listed[0].commentId, first.commentId);
      assert.equal(listed[1].commentId, second.commentId);
      assert.equal(listed[0].taskId, TASK_ID);
      assert.equal(listed[1].taskId, TASK_ID);
      assert.ok(listed[0].createdAt <= listed[1].createdAt);
    } finally {
      store.close();
    }
  });
});

test("P03-comments update changes body and updatedAt while preserving task association and createdAt", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const created = comments.createComment(createCommentInput());
      const updated = comments.updateComment(created.commentId, { body: "Updated body" });

      assert.equal(updated.commentId, created.commentId);
      assert.equal(updated.taskId, created.taskId);
      assert.equal(updated.body, "Updated body");
      assert.equal(updated.createdAt, created.createdAt);
      assert.ok(updated.updatedAt >= created.updatedAt);

      const fetched = comments.getComment(created.commentId);
      assert.equal(fetched.body, "Updated body");
      assert.equal(fetched.updatedAt, updated.updatedAt);
    } finally {
      store.close();
    }
  });
});

test("P03-comments update can change actor without changing task association", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const created = comments.createComment(createCommentInput());
      const newActor = { id: "agent_1", kind: "agent" };
      const updated = comments.updateComment(created.commentId, { actor: newActor });

      assert.deepEqual(updated.actor, newActor);
      assert.equal(updated.taskId, TASK_ID);
      assert.equal(updated.body, created.body);
    } finally {
      store.close();
    }
  });
});

test("P03-comments delete removes the comment from the task's comment list", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const created = comments.createComment(createCommentInput());
      assert.equal(comments.listComments({ taskId: TASK_ID }).length, 1);

      comments.deleteComment(created.commentId);

      assert.equal(comments.getComment(created.commentId), null);
      assert.equal(comments.listComments({ taskId: TASK_ID }).length, 0);
    } finally {
      store.close();
    }
  });
});

test("P03-comments create and list for a missing task fail with BoardTaskNotFoundError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, comments } = buildRepositories(databasePath);
    try {
      assert.throws(
        () => comments.createComment(createCommentInput({ taskId: "tsk_missing" })),
        (error) => error instanceof BoardTaskNotFoundError && error.taskId === "tsk_missing"
      );
      assert.throws(
        () => comments.listComments({ taskId: "tsk_missing" }),
        (error) => error instanceof BoardTaskNotFoundError && error.taskId === "tsk_missing"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-comments get returns null and update/delete throw for unknown comment ids", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      assert.equal(comments.getComment(999), null);
      assert.throws(
        () => comments.updateComment(999, { body: "nope" }),
        (error) => error instanceof BoardTaskCommentNotFoundError && error.commentId === 999
      );
      assert.throws(
        () => comments.deleteComment(999),
        (error) => error instanceof BoardTaskCommentNotFoundError && error.commentId === 999
      );
    } finally {
      store.close();
    }
  });
});

test("P03-comments rejects empty, oversized, and invalid comment bodies", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      assert.throws(() => comments.createComment(createCommentInput({ body: "" })), /non-empty/);
      assert.throws(
        () => comments.createComment(createCommentInput({ body: "x".repeat(BOARD_TASK_COMMENT_BODY_MAX_LENGTH + 1) })),
        /8192/
      );
      const created = comments.createComment(createCommentInput());
      assert.throws(() => comments.updateComment(created.commentId, { body: "" }), /non-empty/);
    } finally {
      store.close();
    }
  });
});

test("P03-comments rejects malformed actors", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      assert.throws(
        () => comments.createComment(createCommentInput({ actor: { id: "" } })),
        /non-empty/
      );
      assert.throws(
        () => comments.createComment(createCommentInput({ actor: { id: "x", kind: "robot" } })),
        /kind/
      );
      const created = comments.createComment(createCommentInput());
      assert.throws(
        () => comments.updateComment(created.commentId, { actor: { id: "" } }),
        /non-empty/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-comments deleting a task cascades and removes its comments", async () => {
  await withTempDatabase((databasePath) => {
    const { store, tasks, comments } = buildRepositories(databasePath);
    try {
      tasks.createTask(createTaskInput());
      const comment = comments.createComment(createCommentInput());
      tasks.deleteTask(TASK_ID, 1);

      assert.equal(comments.getComment(comment.commentId), null);
      assert.throws(
        () => comments.listComments({ taskId: TASK_ID }),
        (error) => error instanceof BoardTaskNotFoundError && error.taskId === TASK_ID
      );
    } finally {
      store.close();
    }
  });
});
