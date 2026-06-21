import {
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  type BoardIndexName,
  type BoardMigrationReport,
  type BoardSchemaDiagnostics,
  type BoardSchemaMigrationRecord,
  type BoardStore,
  type BoardTableName
} from "@legion/board-store";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION
} from "@legion/board-store";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export interface RunSqliteMigrationsOptions {
  readonly targetVersion?: number;
  readonly now?: () => string;
}

export interface OpenSqliteBoardStoreOptions {
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
}

interface SqlitePragmaRow {
  readonly user_version?: number;
  readonly journal_mode?: string;
  readonly foreign_keys?: number;
  readonly timeout?: number;
}

interface SqliteMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const UTC_NOW = (): string => new Date().toISOString();

export const SQLITE_BOARD_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "create-board-control-plane-schema",
    statements: [
      `CREATE TABLE board_metadata (
        key TEXT PRIMARY KEY CHECK (length(key) > 0),
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS board_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL CHECK (length(name) > 0),
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE board_idempotency_records (
        scope TEXT NOT NULL CHECK (length(scope) > 0),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
        result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, idempotency_key)
      )`,
      `CREATE TABLE board_tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
        contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
        generation INTEGER NOT NULL CHECK (generation > 0),
        status TEXT NOT NULL CHECK (status IN ('queued', 'ready', 'claimed', 'running', 'blocked', 'completed', 'failed', 'canceled', 'superseded')),
        priority INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 1000),
        blocker_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE board_task_links (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('depends_on', 'blocks', 'supersedes', 'relates_to')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id, relation),
        CHECK (task_id <> depends_on_task_id),
        FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_task_id) REFERENCES board_tasks(task_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE board_task_comments (
        comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 8192),
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE board_task_events (
        event_id TEXT PRIMARY KEY,
        aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) > 0),
        aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) > 0),
        aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence > 0),
        global_sequence INTEGER NOT NULL UNIQUE,
        event_type TEXT NOT NULL CHECK (length(event_type) > 0),
        event_version TEXT NOT NULL CHECK (length(event_version) > 0),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        causation_id TEXT,
        correlation_id TEXT,
        occurred_at TEXT NOT NULL,
        UNIQUE (aggregate_kind, aggregate_id, aggregate_sequence)
      )`,
      `CREATE TABLE board_projections (
        projection_key TEXT PRIMARY KEY CHECK (length(projection_key) > 0),
        projection_version INTEGER NOT NULL CHECK (projection_version > 0),
        rebuilt_through_global_sequence INTEGER NOT NULL CHECK (rebuilt_through_global_sequence >= 0),
        state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE board_claims (
        lease_token TEXT PRIMARY KEY CHECK (length(lease_token) > 0),
        task_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
        run_id TEXT,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        released_at TEXT,
        release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('completed', 'blocked', 'failed', 'canceled', 'expired')),
        FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE board_task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        status TEXT NOT NULL CHECK (status IN ('created', 'started', 'succeeded', 'failed', 'blocked', 'canceled', 'superseded')),
        manifest_json TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE board_approvals (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('requested', 'granted', 'denied', 'expired')),
        scope_json TEXT NOT NULL,
        requested_by_json TEXT NOT NULL,
        decided_by_json TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES board_task_runs(run_id) ON DELETE SET NULL
      )`,
      `CREATE TABLE board_outbox (
        outbox_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        effect_class TEXT NOT NULL CHECK (effect_class IN ('S0', 'S1', 'S2', 'S3', 'S4')),
        effect_kind TEXT NOT NULL CHECK (length(effect_kind) > 0),
        target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'dead_lettered')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE INDEX idx_board_tasks_status_priority ON board_tasks(status, priority, updated_at)",
      "CREATE INDEX idx_board_task_links_depends_on ON board_task_links(depends_on_task_id, task_id)",
      "CREATE INDEX idx_board_task_events_aggregate_sequence ON board_task_events(aggregate_kind, aggregate_id, aggregate_sequence)",
      "CREATE INDEX idx_board_task_events_global_sequence ON board_task_events(global_sequence)",
      "CREATE UNIQUE INDEX idx_board_claims_live_task_generation ON board_claims(task_id, generation) WHERE released_at IS NULL",
      "CREATE INDEX idx_board_task_runs_task ON board_task_runs(task_id, generation, attempt)",
      "CREATE INDEX idx_board_outbox_status ON board_outbox(status, available_at)",
      "CREATE INDEX idx_board_idempotency_scope_key ON board_idempotency_records(scope, idempotency_key)"
    ]
  }
] as const;

function migrationChecksum(migration: SqliteMigration): string {
  return createHash("sha256").update(migration.statements.join("\n")).digest("hex");
}

function quoteString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function scalarPragma(database: DatabaseSync, sql: string): SqlitePragmaRow {
  return database.prepare(sql).get() as SqlitePragmaRow;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error("Expected SQLite column " + key + " to be a string.");
  }
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error("Expected SQLite column " + key + " to be a number.");
  }
  return value;
}

function migrationRow(row: Record<string, unknown>): SqliteMigrationRow {
  return {
    version: rowNumber(row, "version"),
    name: rowString(row, "name"),
    checksum: rowString(row, "checksum"),
    applied_at: rowString(row, "applied_at")
  };
}

function getUserVersion(database: DatabaseSync): number {
  return Number(scalarPragma(database, "PRAGMA user_version").user_version ?? 0);
}

function setUserVersion(database: DatabaseSync, version: number): void {
  database.exec(`PRAGMA user_version = ${version}`);
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS board_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL
  )`);
}

function sortedMigrations(migrations: readonly SqliteMigration[]): readonly SqliteMigration[] {
  return [...migrations].sort((left, right) => left.version - right.version);
}

function assertContiguousMigrations(migrations: readonly SqliteMigration[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error("Board schema migrations must be contiguous; expected version " + expected + " but found " + migration.version + ".");
    }
    expected += 1;
  }
}

function readMigrationRecords(database: DatabaseSync): Map<number, SqliteMigrationRow> {
  const rows = database.prepare(`
    SELECT version, name, checksum, applied_at
    FROM board_schema_migrations
    ORDER BY version
  `).all();
  const migrations = rows.map((row) => migrationRow(row));
  return new Map(migrations.map((row) => [row.version, row]));
}

function runImmediateTransaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function configureSqliteBoardConnection(database: DatabaseSync, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.prepare("PRAGMA journal_mode = WAL").get();
}

export function runSqliteMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = SQLITE_BOARD_MIGRATIONS,
  options: RunSqliteMigrationsOptions = {}
): BoardMigrationReport {
  const ordered = sortedMigrations(migrations);
  assertContiguousMigrations(ordered);
  const targetVersion = options.targetVersion ?? ordered.at(-1)?.version ?? 0;
  const currentVersion = getUserVersion(database);

  if (currentVersion > targetVersion) {
    throw new Error("Database has unsupported future board schema version " + currentVersion + "; latest supported version is " + targetVersion + ".");
  }

  ensureMigrationTable(database);
  const migrationRecords = readMigrationRecords(database);
  const checksums: Record<number, string> = {};
  const appliedVersions: number[] = [];
  let version = currentVersion;

  for (const migration of ordered) {
    const checksum = migrationChecksum(migration);
    checksums[migration.version] = checksum;

    if (migration.version <= currentVersion) {
      const existing = migrationRecords.get(migration.version);
      if (existing && existing.checksum !== checksum) {
        throw new Error("Applied board schema migration " + migration.version + " checksum mismatch.");
      }
      continue;
    }

    if (migration.version !== version + 1) {
      throw new Error("Missing board schema migration between versions " + version + " and " + migration.version + ".");
    }

    runImmediateTransaction(database, () => {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database.prepare(`
        INSERT INTO board_schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, checksum, options.now?.() ?? UTC_NOW());
      setUserVersion(database, migration.version);
    });

    version = migration.version;
    appliedVersions.push(migration.version);
  }

  return {
    fromVersion: currentVersion,
    toVersion: targetVersion,
    appliedVersions,
    checksums
  };
}

function listSqliteNames(database: DatabaseSync, type: "table" | "index"): readonly string[] {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = ?
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type);
  return rows.map((row) => rowString(row, "name"));
}

function listMigrationRecords(database: DatabaseSync): readonly BoardSchemaMigrationRecord[] {
  try {
    const rows = database.prepare(`
      SELECT version, name, checksum, applied_at
      FROM board_schema_migrations
      ORDER BY version
    `).all();
    return rows.map((row) => migrationRow(row)).map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at
    }));
  } catch {
    return [];
  }
}

function missingNames<const Name extends string>(required: readonly Name[], actual: readonly string[]): readonly Name[] {
  const actualSet = new Set(actual);
  return required.filter((name) => !actualSet.has(name));
}

export class SqliteBoardStore implements BoardStore {
  readonly databasePath: string;
  readonly #database: DatabaseSync;
  readonly #busyTimeoutMs: number;

  constructor(options: OpenSqliteBoardStoreOptions) {
    this.databasePath = path.resolve(options.databasePath);
    this.#busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.#database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(this.#database, this.#busyTimeoutMs);
  }

  migrate(): BoardMigrationReport {
    return runSqliteMigrations(this.#database, SQLITE_BOARD_MIGRATIONS);
  }

  inspect(): BoardSchemaDiagnostics {
    const tables = listSqliteNames(this.#database, "table");
    const indexes = listSqliteNames(this.#database, "index");
    const journalMode = String(scalarPragma(this.#database, "PRAGMA journal_mode").journal_mode ?? "");
    const foreignKeys = Number(scalarPragma(this.#database, "PRAGMA foreign_keys").foreign_keys ?? 0) === 1;
    const busyTimeoutMs = Number(scalarPragma(this.#database, "PRAGMA busy_timeout").timeout ?? 0);

    return {
      databasePath: this.databasePath,
      userVersion: getUserVersion(this.#database),
      journalMode,
      foreignKeys,
      busyTimeoutMs,
      tables,
      indexes,
      missingTables: missingNames(BOARD_REQUIRED_TABLES, tables) as readonly BoardTableName[],
      missingIndexes: missingNames(BOARD_REQUIRED_INDEXES, indexes) as readonly BoardIndexName[],
      migrations: listMigrationRecords(this.#database)
    };
  }

  close(): void {
    this.#database.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    const resolvedBackupPath = path.resolve(backupPath);
    mkdirSync(path.dirname(resolvedBackupPath), { recursive: true });
    if (existsSync(resolvedBackupPath)) {
      throw new Error("Board database backup target already exists: " + resolvedBackupPath);
    }
    this.#database.exec("VACUUM INTO " + quoteString(resolvedBackupPath));
    return {
      sha256: createHash("sha256").update(readFileSync(resolvedBackupPath)).digest("hex")
    };
  }
}

export function openSqliteBoardStore(options: OpenSqliteBoardStoreOptions): SqliteBoardStore {
  return new SqliteBoardStore(options);
}
