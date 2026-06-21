import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  openSqliteBoardStore,
  runSqliteMigrations
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t01-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function openRaw(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

test("P03-T01 migrates a real board database and reports schema diagnostics", async () => {
  await withTempDatabase((databasePath) => {
    const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
    try {
      const report = store.migrate();

      assert.equal(report.fromVersion, 0);
      assert.equal(report.toVersion, BOARD_SCHEMA_VERSION);
      assert.deepEqual(report.appliedVersions, [1]);

      const diagnostics = store.inspect();
      assert.equal(diagnostics.userVersion, BOARD_SCHEMA_VERSION);
      assert.equal(diagnostics.foreignKeys, true);
      assert.equal(diagnostics.busyTimeoutMs, 7_500);
      assert.equal(diagnostics.journalMode, "wal");
      assert.deepEqual(diagnostics.missingTables, []);
      assert.deepEqual(diagnostics.missingIndexes, []);

      for (const table of BOARD_REQUIRED_TABLES) {
        assert.ok(diagnostics.tables.includes(table), "missing table " + table);
      }
      for (const index of BOARD_REQUIRED_INDEXES) {
        assert.ok(diagnostics.indexes.includes(index), "missing index " + index);
      }
      for (const index of [
        "idx_board_task_comments_task_id",
        "idx_board_claims_task_id",
        "idx_board_approvals_task_id",
        "idx_board_approvals_run_id"
      ]) {
        assert.ok(diagnostics.indexes.includes(index), "missing foreign-key support index " + index);
      }

      const repeat = store.migrate();
      assert.equal(repeat.fromVersion, BOARD_SCHEMA_VERSION);
      assert.equal(repeat.toVersion, BOARD_SCHEMA_VERSION);
      assert.deepEqual(repeat.appliedVersions, []);
    } finally {
      store.close();
    }
  });
});

test("P03-T01 schema enforces ownership, foreign-key, unique, and check constraints", async () => {
  await withTempDatabase((databasePath) => {
    const store = openSqliteBoardStore({ databasePath });
    store.migrate();
    store.close();

    const database = openRaw(databasePath);
    try {
      assert.throws(() => {
        database.prepare(`
          INSERT INTO board_task_links (task_id, depends_on_task_id, relation, created_at)
          VALUES ('tsk_missing-a', 'tsk_missing-b', 'depends_on', '2026-06-21T00:00:00.000Z')
        `).run();
      }, /FOREIGN KEY/);

      assert.throws(() => {
        database.prepare(`
          INSERT INTO board_tasks (task_id, project_id, change_id, contract_id, contract_revision, contract_hash, generation, status, priority, created_at, updated_at)
          VALUES ('tsk_alpha', 'prj_alpha', 'chg_alpha', 'ctr_alpha', 1, ?, 1, 'nonsense', 500, '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z')
        `).run("a".repeat(64));
      }, /CHECK/);

      database.prepare(`
        INSERT INTO board_tasks (task_id, project_id, change_id, contract_id, contract_revision, contract_hash, generation, status, priority, created_at, updated_at)
        VALUES ('tsk_alpha', 'prj_alpha', 'chg_alpha', 'ctr_alpha', 1, ?, 1, 'ready', 500, '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z')
      `).run("a".repeat(64));

      assert.throws(() => {
        database.prepare(`
          INSERT INTO board_tasks (task_id, project_id, change_id, contract_id, contract_revision, contract_hash, generation, status, priority, created_at, updated_at)
          VALUES ('tsk_alpha', 'prj_alpha', 'chg_alpha', 'ctr_alpha', 1, ?, 1, 'ready', 500, '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z')
        `).run("a".repeat(64));
      }, /UNIQUE/);
    } finally {
      database.close();
    }
  });
});

test("P03-T01 migration runner rolls back interrupted migrations without advancing schema version", async () => {
  await withTempDatabase((databasePath) => {
    const database = openRaw(databasePath);
    try {
      runSqliteMigrations(database, [
        {
          version: 1,
          name: "first",
          statements: ["CREATE TABLE surviving_table (id TEXT PRIMARY KEY)"]
        }
      ]);

      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);

      assert.throws(() => {
        runSqliteMigrations(database, [
          {
            version: 1,
            name: "first",
            statements: ["CREATE TABLE surviving_table (id TEXT PRIMARY KEY)"]
          },
          {
            version: 2,
            name: "interrupted",
            statements: [
              "CREATE TABLE should_rollback (id TEXT PRIMARY KEY)",
              "INSERT INTO missing_table (id) VALUES ('boom')"
            ]
          }
        ]);
      }, /missing_table/);

      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'surviving_table'").get().name, "surviving_table");
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(), undefined);
    } finally {
      database.close();
    }
  });
});

test("P03-T01 migration runner treats missing scalar pragma rows as empty rows", () => {
  const database = {
    exec() {},
    prepare() {
      return {
        get() {
          return undefined;
        },
        all() {
          return [];
        }
      };
    }
  };

  const report = runSqliteMigrations(database, []);

  assert.equal(report.fromVersion, 0);
  assert.equal(report.toVersion, 0);
  assert.deepEqual(report.appliedVersions, []);
});

test("P03-T01 migration rollback preserves the original migration failure", () => {
  const originalError = new Error("original migration failure");
  const rollbackError = new Error("rollback failure");
  const database = {
    exec(sql) {
      if (sql === "BEGIN IMMEDIATE" || sql.includes("board_schema_migrations")) return;
      if (sql === "ROLLBACK") throw rollbackError;
      throw originalError;
    },
    prepare(sql) {
      return {
        get() {
          if (sql === "PRAGMA user_version") return { user_version: 0 };
          return undefined;
        },
        all() {
          return [];
        },
        run() {}
      };
    }
  };

  assert.throws(
    () => runSqliteMigrations(database, [{ version: 1, name: "boom", statements: ["CREATE TABLE boom (id TEXT PRIMARY KEY)"] }]),
    (error) => error === originalError
  );
});

test("P03-T01 backup hashing avoids whole-file reads", async () => {
  const source = await readFile(path.join(TEST_DIR, "../src/index.ts"), "utf8");

  assert.doesNotMatch(source, /\breadFileSync\b/);
  assert.match(source, /\breadSync\b/);
});

test("P03-T01 migration runner fails closed for unknown future schema versions", async () => {
  await withTempDatabase((databasePath) => {
    const database = openRaw(databasePath);
    database.exec("PRAGMA user_version = 999");
    database.close();

    const store = openSqliteBoardStore({ databasePath });
    try {
      assert.throws(() => store.migrate(), /future board schema version 999/);
    } finally {
      store.close();
    }
  });
});

test("P03-T01 migration checksums are deterministic over ordered SQL statements", async () => {
  await withTempDatabase((databasePath) => {
    const database = openRaw(databasePath);
    try {
      const migration = {
        version: 1,
        name: "checksum",
        statements: [
          "CREATE TABLE checksum_table (id TEXT PRIMARY KEY)",
          "CREATE INDEX idx_checksum_table_id ON checksum_table(id)"
        ]
      };
      const expectedChecksum = createHash("sha256").update(migration.statements.join("\n")).digest("hex");

      const report = runSqliteMigrations(database, [migration]);

      assert.deepEqual(report.appliedVersions, [1]);
      assert.equal(report.checksums[1], expectedChecksum);
      assert.equal(
        database.prepare("SELECT checksum FROM board_schema_migrations WHERE version = 1").get().checksum,
        expectedChecksum
      );
    } finally {
      database.close();
    }
  });
});
