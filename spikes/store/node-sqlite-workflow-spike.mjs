import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "legion-store-spike-"));
const dbPath = join(root, "board.sqlite");
const backupPath = join(root, "board.backup.sqlite");

const db = new DatabaseSync(dbPath);
const secondConnection = new DatabaseSync(dbPath);

const now = () => new Date().toISOString();
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

function execTransaction(connection, fn) {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

function hashRows(connection) {
  const events = connection.prepare("SELECT event_id, stream_id, type, payload_json FROM events ORDER BY event_id").all();
  const tasks = connection.prepare("SELECT task_id, generation, status, lease_owner FROM tasks ORDER BY task_id").all();
  return createHash("sha256").update(JSON.stringify({ events, tasks })).digest("hex");
}

function appendEvent(connection, id, stream, type, payload) {
  connection.prepare(`
    INSERT INTO events (event_id, stream_id, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, stream, type, JSON.stringify(payload), now());
}

function projectTaskCreated(connection, taskId) {
  connection.prepare(`
    INSERT INTO tasks (task_id, generation, status, lease_owner, lease_expires_at, updated_at)
    VALUES (?, 0, 'ready', NULL, NULL, ?)
    ON CONFLICT(task_id) DO NOTHING
  `).run(taskId, now());
}

function rebuildProjection(connection) {
  const events = connection.prepare(`
    SELECT event_id, payload_json
    FROM events
    WHERE type = 'task.created.v1'
    ORDER BY event_id
  `).all();
  for (const event of events) {
    projectTaskCreated(connection, JSON.parse(event.payload_json).taskId);
  }
}

function claimTask(connection, taskId, owner) {
  return execTransaction(connection, () => {
    const before = connection.prepare("SELECT generation FROM tasks WHERE task_id = ? AND status = 'ready'").get(taskId);
    if (!before) return null;

    connection.prepare(`
      UPDATE tasks
      SET status = 'claimed',
          generation = generation + 1,
          lease_owner = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE task_id = ? AND status = 'ready' AND generation = ?
    `).run(owner, new Date(Date.now() + 60_000).toISOString(), now(), taskId, before.generation);

    const after = connection.prepare("SELECT generation, lease_owner FROM tasks WHERE task_id = ?").get(taskId);
    if (after.lease_owner !== owner) return null;
    appendEvent(connection, `evt_claim_${owner}`, taskId, "task.claimed.v1", {
      taskId,
      owner,
      generation: after.generation,
    });
    return after;
  });
}

const results = [];

try {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    CREATE TABLE outbox (
      outbox_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  execTransaction(db, () => {
    appendEvent(db, "evt_create_alpha", "task-alpha", "task.created.v1", { taskId: "task-alpha" });
    projectTaskCreated(db, "task-alpha");
    db.prepare(`
      INSERT INTO outbox (outbox_id, idempotency_key, kind, payload_json, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run("outbox-1", "project:change:task-alpha:git-commit:tree-a", "git.commit", JSON.stringify({ tree: "tree-a" }));
  });

  const firstClaim = claimTask(db, "task-alpha", "worker-a");
  const secondClaim = claimTask(secondConnection, "task-alpha", "worker-b");
  const finalClaim = db.prepare("SELECT generation, status, lease_owner FROM tasks WHERE task_id = ?").get("task-alpha");
  results.push({
    check: "atomic_claim",
    passed: Boolean(firstClaim) && secondClaim === null && finalClaim.lease_owner === "worker-a",
    detail: finalClaim,
  });

  appendEvent(db, "evt_create_beta", "task-beta", "task.created.v1", { taskId: "task-beta" });
  const beforeRebuild = db.prepare("SELECT task_id FROM tasks WHERE task_id = 'task-beta'").get();
  rebuildProjection(db);
  const afterRebuild = db.prepare("SELECT task_id, status FROM tasks WHERE task_id = 'task-beta'").get();
  results.push({
    check: "event_append_projection_rebuild",
    passed: beforeRebuild === undefined && afterRebuild.status === "ready",
    detail: afterRebuild,
  });

  try {
    execTransaction(db, () => {
      db.exec("CREATE TABLE migration_should_rollback (id TEXT PRIMARY KEY)");
      throw new Error("simulated migration failure");
    });
  } catch {
    // Expected.
  }
  const rolledBack = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_should_rollback'
  `).get();
  results.push({
    check: "migration_rollback",
    passed: rolledBack === undefined,
    detail: rolledBack ?? null,
  });

  const originalHash = hashRows(db);
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  const backup = new DatabaseSync(backupPath);
  const backupHash = hashRows(backup);
  backup.close();
  results.push({
    check: "backup_restore_hash",
    passed: originalHash === backupHash,
    detail: { originalHash, backupHash },
  });

  const journalMode = db.prepare("PRAGMA journal_mode").get();
  results.push({
    check: "wal_mode",
    passed: String(journalMode.journal_mode).toLowerCase() === "wal",
    detail: journalMode,
  });
} finally {
  secondConnection.close();
  db.close();
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({
  status: failed.length === 0 ? "PASS" : "FAIL",
  store: "node:sqlite",
  database: dbPath,
  node: process.version,
  platform: process.platform,
  results,
}, null, 2));

rmSync(root, { recursive: true, force: true });

if (failed.length > 0) {
  process.exitCode = 1;
}
