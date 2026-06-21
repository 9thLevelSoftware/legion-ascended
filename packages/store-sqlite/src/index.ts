import {
  BOARD_APPROVAL_LIFECYCLE_PHASES,
  BOARD_APPROVAL_STATUSES,
  BOARD_APPROVAL_STATUS_TRANSITIONS,
  BOARD_APPROVAL_TERMINAL_STATUSES,
  BOARD_EVENT_AGGREGATE_KINDS,
  BOARD_EVENT_SCHEMA_VERSION,
  BOARD_EVENT_TYPES,
  BOARD_LEASE_RELEASE_REASONS,
  BOARD_LEASE_TOKEN_MIN_LENGTH,
  BOARD_OUTBOX_EFFECT_CLASSES,
  BOARD_OUTBOX_STATUSES,
  BOARD_TASK_LINK_DAG_RELATIONS,
  BOARD_TASK_LINK_RELATIONS,
  BOARD_PROJECTION_KEY_MAX_LENGTH,
  BOARD_PROJECTION_KEY_PATTERN,
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  BOARD_TASK_COMMENT_BODY_MAX_LENGTH,
  BOARD_TASK_GENERATION_MIN,
  BOARD_TASK_PRIORITY_MAX,
  BOARD_TASK_PRIORITY_MIN,
  BOARD_TASK_STATUSES,
  BOARD_TASK_STATUS_TRANSITIONS,
  BoardApprovalAlreadyExistsError,
  BoardApprovalConcurrencyError,
  BoardApprovalIllegalStatusTransitionError,
  BoardApprovalNotFoundError,
  BoardApprovalTerminalStatusError,
  BoardClaimContendedError,
  BoardClaimGenerationError,
  BoardClaimNotFoundError,
  BoardConcurrencyError,
  BoardEventAppendError,
  BoardIllegalStatusTransitionError,
  BoardOutboxConcurrencyError,
  BoardOutboxNotFoundError,
  BoardOutboxTerminalStatusError,
  BoardProjectionDriftError,
  BoardTaskCommentNotFoundError,
  BoardTaskNotFoundError,
  BoardTerminalTaskMutationError,
  type AppendBoardEventInput,
  type AppendBoardEventsInput,
  type BoardApproval,
  type BoardApprovalActor,
  type BoardApprovalLifecyclePhase,
  type BoardApprovalRepository,
  type BoardApprovalScope,
  type BoardApprovalStatus,
  type BoardClaim,
  type BoardClaimRepository,
  type BoardEvent,
  type BoardEventAggregateKind,
  type BoardEventAppendBatchResult,
  type BoardEventAppendResult,
  type BoardEventQuery,
  type BoardEventRepository,
  type BoardEventType,
  type BoardIndexName,
  type BoardLeaseReleaseReason,
  type BoardMigrationReport,
  type BoardOutbox,
  type BoardOutboxEffectClass,
  type BoardOutboxRepository,
  type BoardOutboxStatus,
  type BoardProjectionRebuildReport,
  type BoardProjectionRecord,
  type BoardProjectionRepository,
  type BoardProjectionState,
  type BoardSchemaDiagnostics,
  type BoardSchemaMigrationRecord,
  type BoardStore,
  type BoardTableName,
  type BoardTask,
  type BoardTaskBlocker,
  type BoardTaskComment,
  type BoardTaskCommentActor,
  type BoardTaskCommentRepository,
  type BoardTaskEventHook,
  BoardTaskLinkAlreadyExistsError,
  BoardTaskLinkCycleAggregateError,
  BoardTaskLinkCycleError,
  BoardTaskLinkEndpointNotFoundError,
  BoardTaskLinkInvalidRelationError,
  BoardTaskLinkNotFoundError,
  BoardTaskLinkSelfLoopError,
  type BoardTaskLink,
  type BoardTaskLinkCycle,
  type BoardTaskLinkCycleAggregateErrorContext,
  type BoardTaskLinkCycleErrorContext,
  type BoardTaskLinkDagRelation,
  type BoardTaskLinkRelation,
  type BoardTaskLinkRepository,
  type BoardTaskMutationKind,
  type BoardTaskRepository,
  type BoardTaskRepositoryWithHooks,
  type BoardTaskStatus,
  type BoardTaskStatusTransition,
  type BumpBoardTaskGenerationInput,
  type ClaimBoardOutboxInput,
  type CreateBoardApprovalInput,
  type CreateBoardClaimInput,
  type CreateBoardOutboxInput,
  type CreateBoardTaskCommentInput,
  type CreateBoardTaskInput,
  type CreateBoardTaskLinkInput,
  type DecideBoardApprovalInput,
  type EventId,
  type ExpireBoardApprovalInput,
  type HeartbeatBoardClaimInput,
  type ListBoardApprovalsQuery,
  type ListBoardOutboxQuery,
  type ListBoardTaskCommentsQuery,
  type ListBoardTaskLinksQuery,
  type ListBoardTasksQuery,
  type MarkBoardOutboxAttemptInput,
  type ReclaimBoardClaimsOptions,
  type ReleaseBoardClaimInput,
  type RevokeBoardApprovalInput,
  type SaveBoardProjectionInput,
  type SupersedeBoardTaskInput,
  type SupersedeBoardTaskResult,
  type TaskId,
  type UpdateBoardTaskCommentInput
} from "@legion/board-store";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  BOARD_APPROVAL_LIFECYCLE_PHASES,
  BOARD_APPROVAL_STATUSES,
  BOARD_APPROVAL_STATUS_TRANSITIONS,
  BOARD_APPROVAL_TERMINAL_STATUSES,
  BOARD_EVENT_AGGREGATE_KINDS,
  BOARD_EVENT_SCHEMA_VERSION,
  BOARD_EVENT_TYPES,
  BOARD_LEASE_RELEASE_REASONS,
  BOARD_LEASE_TOKEN_MIN_LENGTH,
  BOARD_OUTBOX_EFFECT_CLASSES,
  BOARD_OUTBOX_STATUSES,
  BOARD_TASK_LINK_DAG_RELATIONS,
  BOARD_TASK_LINK_RELATIONS,
  BOARD_PROJECTION_KEY_MAX_LENGTH,
  BOARD_PROJECTION_KEY_PATTERN,
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  BOARD_TASK_COMMENT_BODY_MAX_LENGTH,
  BOARD_TASK_GENERATION_MIN,
  BOARD_TASK_PRIORITY_MAX,
  BOARD_TASK_PRIORITY_MIN,
  BOARD_TASK_STATUSES,
  BOARD_TASK_STATUS_TRANSITIONS,
  BoardApprovalAlreadyExistsError,
  BoardApprovalConcurrencyError,
  BoardApprovalIllegalStatusTransitionError,
  BoardApprovalNotFoundError,
  BoardApprovalTerminalStatusError,
  BoardClaimContendedError,
  BoardClaimGenerationError,
  BoardClaimNotFoundError,
  BoardConcurrencyError,
  BoardEventAppendError,
  BoardIllegalStatusTransitionError,
  BoardOutboxConcurrencyError,
  BoardOutboxNotFoundError,
  BoardOutboxTerminalStatusError,
  BoardProjectionDriftError,
  BoardTaskCommentNotFoundError,
  BoardTaskNotFoundError,
  BoardTerminalTaskMutationError,
  type AppendBoardEventInput,
  type AppendBoardEventsInput,
  type BoardApproval,
  type BoardApprovalActor,
  type BoardApprovalLifecyclePhase,
  type BoardApprovalRepository,
  type BoardApprovalScope,
  type BoardApprovalStatus,
  type BoardClaim,
  type BoardClaimRepository,
  type BoardEvent,
  type BoardEventAggregateKind,
  type BoardEventAppendBatchResult,
  type BoardEventAppendResult,
  type BoardEventQuery,
  type BoardEventRepository,
  type BoardEventType,
  type BoardIndexName,
  type BoardLeaseReleaseReason,
  type BoardMigrationReport,
  type BoardOutbox,
  type BoardOutboxEffectClass,
  type BoardOutboxRepository,
  type BoardOutboxStatus,
  type BoardProjectionRebuildReport,
  type BoardProjectionRecord,
  type BoardProjectionRepository,
  type BoardProjectionState,
  type BoardSchemaDiagnostics,
  type BoardSchemaMigrationRecord,
  type BoardStore,
  type BoardTableName,
  type BoardTask,
  type BoardTaskBlocker,
  type BoardTaskComment,
  type BoardTaskCommentActor,
  type BoardTaskCommentRepository,
  type BoardTaskEventHook,
  BoardTaskLinkAlreadyExistsError,
  BoardTaskLinkCycleAggregateError,
  BoardTaskLinkCycleError,
  BoardTaskLinkEndpointNotFoundError,
  BoardTaskLinkInvalidRelationError,
  BoardTaskLinkNotFoundError,
  BoardTaskLinkSelfLoopError,
  type BoardTaskLink,
  type BoardTaskLinkCycle,
  type BoardTaskLinkCycleAggregateErrorContext,
  type BoardTaskLinkCycleErrorContext,
  type BoardTaskLinkDagRelation,
  type BoardTaskLinkRelation,
  type BoardTaskLinkRepository,
  type BoardTaskMutationKind,
  type BoardTaskRepository,
  type BoardTaskRepositoryWithHooks,
  type BoardTaskStatus,
  type BoardTaskStatusTransition,
  type BumpBoardTaskGenerationInput,
  type ClaimBoardOutboxInput,
  type CreateBoardApprovalInput,
  type CreateBoardClaimInput,
  type CreateBoardOutboxInput,
  type CreateBoardTaskCommentInput,
  type CreateBoardTaskInput,
  type CreateBoardTaskLinkInput,
  type DecideBoardApprovalInput,
  type EventId,
  type ExpireBoardApprovalInput,
  type HeartbeatBoardClaimInput,
  type ListBoardApprovalsQuery,
  type ListBoardOutboxQuery,
  type ListBoardTaskCommentsQuery,
  type ListBoardTaskLinksQuery,
  type ListBoardTasksQuery,
  type MarkBoardOutboxAttemptInput,
  type ReclaimBoardClaimsOptions,
  type ReleaseBoardClaimInput,
  type RevokeBoardApprovalInput,
  type SaveBoardProjectionInput,
  type SupersedeBoardTaskInput,
  type SupersedeBoardTaskResult,
  type TaskId,
  type UpdateBoardTaskCommentInput
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
        aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence >= 0),
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
        release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('completed', 'blocked', 'failed', 'canceled', 'expired', 'superseded')),
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
        status TEXT NOT NULL CHECK (status IN ('requested', 'granted', 'denied', 'expired', 'revoked')),
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
      "CREATE INDEX idx_board_idempotency_scope_key ON board_idempotency_records(scope, idempotency_key)",
      "CREATE INDEX idx_board_task_comments_task_id ON board_task_comments(task_id)",
      "CREATE INDEX idx_board_claims_task_id ON board_claims(task_id)",
      "CREATE INDEX idx_board_approvals_task_id ON board_approvals(task_id)",
      "CREATE INDEX idx_board_approvals_run_id ON board_approvals(run_id)"
    ]
  },
  {
    version: 2,
    name: "add-board-task-comment-updated-at",
    statements: [
      `ALTER TABLE board_task_comments ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
      `UPDATE board_task_comments SET updated_at = created_at WHERE updated_at = '1970-01-01T00:00:00.000Z'`
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
  return (database.prepare(sql).get() ?? {}) as SqlitePragmaRow;
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
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure; rollback is best-effort after a failed transaction body.
    }
    throw error;
  }
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(filePath, "r");
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
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
  const latestVersion = ordered.at(-1)?.version ?? 0;
  const targetVersion = options.targetVersion ?? latestVersion;

  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new Error("Target board schema version must be a non-negative integer.");
  }
  if (targetVersion > latestVersion) {
    throw new Error("Unsupported target board schema version " + targetVersion + "; latest available migration is " + latestVersion + ".");
  }

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
    if (migration.version > targetVersion) break;

    const checksum = migrationChecksum(migration);
    checksums[migration.version] = checksum;

    if (migration.version <= currentVersion) {
      const existing = migrationRecords.get(migration.version);
      if (!existing) {
        throw new Error("Missing board schema migration record for applied version " + migration.version + ".");
      }
      if (existing.checksum !== checksum) {
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
      sha256: sha256File(resolvedBackupPath)
    };
  }
}

export function openSqliteBoardStore(options: OpenSqliteBoardStoreOptions): SqliteBoardStore {
  return new SqliteBoardStore(options);
}

interface BoardTaskRow {
  readonly task_id: string;
  readonly project_id: string;
  readonly change_id: string;
  readonly contract_id: string;
  readonly contract_revision: number;
  readonly contract_hash: string;
  readonly generation: number;
  readonly status: string;
  readonly priority: number;
  readonly blocker_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const TERMINAL_BOARD_TASK_STATUSES: ReadonlySet<BoardTaskStatus> = new Set<BoardTaskStatus>([
  "completed",
  "canceled",
  "superseded"
]);

const STATEMENTS = {
  selectById: `SELECT task_id, project_id, change_id, contract_id, contract_revision, contract_hash,
                       generation, status, priority, blocker_json, created_at, updated_at
                FROM board_tasks WHERE task_id = ?`,
  selectForUpdateByGeneration: `SELECT task_id, project_id, change_id, contract_id, contract_revision, contract_hash,
                                       generation, status, priority, blocker_json, created_at, updated_at
                                FROM board_tasks WHERE task_id = ? AND generation = ?`,
  insert: `INSERT INTO board_tasks (task_id, project_id, change_id, contract_id, contract_revision, contract_hash,
                                   generation, status, priority, blocker_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
} as const;

function assertValidContractHash(contractHash: string): void {
  if (typeof contractHash !== "string" || contractHash.length !== 64) {
    throw new Error("Board task contract hash must be a 64-character SHA-256 hex string.");
  }
}

function assertValidPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < BOARD_TASK_PRIORITY_MIN || priority > BOARD_TASK_PRIORITY_MAX) {
    throw new Error(
      "Board task priority must be an integer between " +
        BOARD_TASK_PRIORITY_MIN +
        " and " +
        BOARD_TASK_PRIORITY_MAX +
        ", received " +
        priority +
        "."
    );
  }
}

function assertValidStatus(status: string): asserts status is BoardTaskStatus {
  if (!(BOARD_TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error("Unknown board task status: " + status + ".");
  }
}

function blockerToJson(blocker: BoardTaskBlocker | null | undefined): string | null {
  if (!blocker) return null;
  if (typeof blocker.reason !== "string" || blocker.reason.length === 0) {
    throw new Error("Board task blocker must include a non-empty reason.");
  }
  return JSON.stringify(blocker);
}

function blockerFromJson(raw: string | null): BoardTaskBlocker | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BoardTaskBlocker;
    if (!parsed || typeof parsed.reason !== "string") {
      throw new Error("Board task blocker JSON missing reason field.");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Failed to deserialize board task blocker JSON: " + message);
  }
}

function rowToBoardTask(row: BoardTaskRow): BoardTask {
  const status = row.status;
  assertValidStatus(status);
  return {
    taskId: row.task_id as BoardTask["taskId"],
    projectId: row.project_id as BoardTask["projectId"],
    changeId: row.change_id as BoardTask["changeId"],
    contractId: row.contract_id as BoardTask["contractId"],
    contractRevision: row.contract_revision,
    contractHash: row.contract_hash,
    generation: row.generation,
    status,
    priority: row.priority,
    blocker: blockerFromJson(row.blocker_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadBoardTaskRow(database: DatabaseSync, taskId: string): BoardTaskRow | undefined {
  const row = database.prepare(STATEMENTS.selectById).get(taskId) as BoardTaskRow | undefined;
  return row;
}

function isTerminalStatus(status: BoardTaskStatus): boolean {
  return TERMINAL_BOARD_TASK_STATUSES.has(status);
}

function assertTransitionLegal(taskId: BoardTask["taskId"], currentStatus: BoardTaskStatus, nextStatus: BoardTaskStatus): void {
  if (currentStatus === nextStatus) return;
  const allowed = BOARD_TASK_STATUS_TRANSITIONS[currentStatus] as readonly BoardTaskStatus[];
  if (!allowed.includes(nextStatus)) {
    throw new BoardIllegalStatusTransitionError(taskId, currentStatus, nextStatus);
  }
}

interface SqliteBoardTaskRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
  readonly eventRepository?: SqliteBoardEventRepository;
  readonly eventHooks?: readonly BoardTaskEventHook[];
}

export class SqliteBoardTaskRepository implements BoardTaskRepositoryWithHooks {
  readonly #database: DatabaseSync;
  readonly #now: () => string;
  readonly #eventRepository: SqliteBoardEventRepository | null;
  readonly eventRepository: SqliteBoardEventRepository | null;
  readonly eventHooks: readonly BoardTaskEventHook[];

  constructor(options: SqliteBoardTaskRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
    this.#eventRepository = options.eventRepository ?? null;
    this.eventRepository = this.#eventRepository;
    this.eventHooks = options.eventHooks ?? [];
  }

  close(): void {
    this.#database.close();
  }

  closeDatabase(): void {
    this.#database.close();
  }

  createTask(input: CreateBoardTaskInput): BoardTask {
    const status: BoardTaskStatus = input.initialStatus ?? "queued";
    assertValidStatus(status);
    if (status === "completed" || status === "failed" || status === "canceled" || status === "superseded") {
      throw new Error("Board task initial status '" + status + "' is terminal and not valid for new board tasks.");
    }
    const priority = input.initialPriority ?? 500;
    assertValidPriority(priority);
    assertValidContractHash(input.contractHash);

    if (!Number.isInteger(input.contractRevision) || input.contractRevision <= 0) {
      throw new Error("Board task contract revision must be a positive integer.");
    }

    const now = this.#now();
    const blockerJson = blockerToJson(input.blocker);
    const taskIdString = String(input.taskId);
    const projectIdString = String(input.projectId);
    const changeIdString = String(input.changeId);
    const contractIdString = String(input.contractId);
    const createdAt = input.createdAt ?? now;
    const initialGeneration = input.initialGeneration ?? BOARD_TASK_GENERATION_MIN;
    if (!Number.isInteger(initialGeneration) || initialGeneration < BOARD_TASK_GENERATION_MIN) {
      throw new Error("Board task initial generation must be a positive integer.");
    }

    const database = this.#database;
    database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existingIdempotent = database
          .prepare(
            "SELECT result_json FROM board_idempotency_records " +
              "WHERE scope = ? AND idempotency_key = ?"
          )
          .get("board.task.create", input.idempotencyKey) as { result_json: string } | undefined;
        if (existingIdempotent) {
          try {
            const parsed = JSON.parse(existingIdempotent.result_json) as { taskId: string };
            const existingRow = loadBoardTaskRow(database, parsed.taskId);
            if (existingRow) {
              database.exec("COMMIT");
              return rowToBoardTask(existingRow);
            }
          } catch {
            // Fall through and re-raise as a duplicate-task error below.
          }
        }
      }
      const existing = database.prepare(STATEMENTS.selectById).get(taskIdString);
      if (existing) {
        throw new Error("Board task " + taskIdString + " already exists.");
      }
      database.prepare(STATEMENTS.insert).run(
        taskIdString,
        projectIdString,
        changeIdString,
        contractIdString,
        input.contractRevision,
        input.contractHash,
        initialGeneration,
        status,
        priority,
        blockerJson,
        createdAt,
        now
      );
      if (input.idempotencyKey) {
        const resultJson = JSON.stringify({ taskId: taskIdString });
        const resultHash = createHash("sha256").update(resultJson).digest("hex");
        database
          .prepare(
            "INSERT INTO board_idempotency_records (scope, idempotency_key, result_hash, result_json, created_at) " +
              "VALUES (?, ?, ?, ?, ?)"
          )
          .run("board.task.create", input.idempotencyKey, resultHash, resultJson, now);
      }
      const createdRow = loadBoardTaskRow(database, taskIdString);
      if (!createdRow) {
        throw new Error("Board task " + taskIdString + " was not persisted after insert.");
      }
      this.#emitEvents({
        taskId: taskIdString,
        projectId: projectIdString,
        changeId: changeIdString,
        generation: createdRow.generation,
        mutation: "create",
        previous: null,
        current: rowToBoardTask(createdRow),
        successor: null,
        blocker: null,
        occurredAt: now,
        idempotencyKey: input.idempotencyKey ?? null
      });
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the create failure; rollback is best-effort after a thrown error.
      }
      throw error;
    }

    const row = loadBoardTaskRow(database, taskIdString);
    if (!row) {
      throw new Error("Board task " + taskIdString + " was not persisted after insert.");
    }
    return rowToBoardTask(row);
  }

  getTask(taskId: BoardTask["taskId"]): BoardTask | null {
    const row = loadBoardTaskRow(this.#database, String(taskId));
    return row ? rowToBoardTask(row) : null;
  }

  listTasks(query: ListBoardTasksQuery = {}): readonly BoardTask[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.status && query.status.length > 0) {
      const placeholders = query.status.map(() => "?").join(", ");
      where.push("status IN (" + placeholders + ")");
      for (const status of query.status) {
        assertValidStatus(status);
        params.push(status);
      }
    }
    if (query.projectId) {
      where.push("project_id = ?");
      params.push(String(query.projectId));
    }
    if (query.changeId) {
      where.push("change_id = ?");
      params.push(String(query.changeId));
    }
    if (!query.includeTerminal) {
      const nonTerminalPlaceholders = BOARD_TASK_STATUSES.filter((s) => !TERMINAL_BOARD_TASK_STATUSES.has(s))
        .map(() => "?")
        .join(", ");
      where.push("status IN (" + nonTerminalPlaceholders + ")");
      for (const status of BOARD_TASK_STATUSES) {
        if (!TERMINAL_BOARD_TASK_STATUSES.has(status)) {
          params.push(status);
        }
      }
    }

    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board task list limit must be a positive integer.");
    }

    const sql =
      "SELECT task_id, project_id, change_id, contract_id, contract_revision, contract_hash, " +
      "generation, status, priority, blocker_json, created_at, updated_at " +
      "FROM board_tasks" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY priority DESC, updated_at ASC " +
      " LIMIT " +
      limit;

    const rows = this.#database.prepare(sql).all(...params) as unknown as BoardTaskRow[];
    return rows.map(rowToBoardTask);
  }

  updateTaskPriority(
    taskId: BoardTask["taskId"],
    nextPriority: number,
    expectedGeneration?: number
  ): BoardTask {
    assertValidPriority(nextPriority);
    if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < BOARD_TASK_GENERATION_MIN)) {
      throw new Error("Board task expected generation must be a positive integer.");
    }
    return this.#mutateTask(taskId, expectedGeneration, "update_priority", (current) => {
      if (isTerminalStatus(current.status)) {
        throw new BoardTerminalTaskMutationError(taskId, current.status);
      }
      const now = this.#now();
      const targetGeneration = expectedGeneration ?? current.generation;
      const result = this.#database
        .prepare(
          "UPDATE board_tasks SET priority = ?, updated_at = ? " +
            "WHERE task_id = ? AND generation = ?"
        )
        .run(nextPriority, now, String(taskId), targetGeneration);
      if (result.changes !== 1) {
        throw new BoardConcurrencyError(taskId, targetGeneration, current.generation);
      }
      return { ...current, priority: nextPriority, updatedAt: now };
    });
  }

  transitionTaskStatus(
    taskId: BoardTask["taskId"],
    transition: BoardTaskStatusTransition,
    expectedGeneration?: number
  ): BoardTask {
    assertValidStatus(transition.toStatus);
    if (transition.advanceGeneration !== undefined && (!Number.isInteger(transition.advanceGeneration) || transition.advanceGeneration < 1)) {
      throw new Error("Board task advanceGeneration must be a positive integer when provided.");
    }
    if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < BOARD_TASK_GENERATION_MIN)) {
      throw new Error("Board task expected generation must be a positive integer.");
    }
    if (transition.toStatus === "blocked" && !transition.blocker) {
      throw new Error("Board task transition to blocked must include a blocker.");
    }
    if (transition.toStatus !== "blocked" && transition.blocker) {
      throw new Error("Board task transition to " + transition.toStatus + " must not include a blocker.");
    }

    return this.#mutateTask(
      taskId,
      expectedGeneration,
      "transition_status",
      (current) => {
        if (isTerminalStatus(current.status) && current.status !== transition.toStatus) {
          throw new BoardTerminalTaskMutationError(taskId, current.status);
        }
        assertTransitionLegal(taskId, current.status as BoardTaskStatus, transition.toStatus);
        const blockerJson = blockerToJson(transition.blocker ?? null);
        const now = this.#now();
        const targetGeneration = expectedGeneration ?? current.generation;
        const advanceBy = transition.advanceGeneration ?? 0;
        const nextGeneration = current.generation + advanceBy;
        const result = this.#database
          .prepare(
            "UPDATE board_tasks SET status = ?, blocker_json = ?, " +
              (advanceBy > 0 ? "generation = ?, " : "") +
              "updated_at = ? " +
              "WHERE task_id = ? AND generation = ?"
          )
          .run(
            transition.toStatus,
            blockerJson,
            ...(advanceBy > 0 ? [nextGeneration] : []),
            now,
            String(taskId),
            targetGeneration
          );
        if (result.changes !== 1) {
          throw new BoardConcurrencyError(taskId, targetGeneration, current.generation);
        }
        return {
          ...current,
          status: transition.toStatus,
          blocker: transition.blocker ?? null,
          generation: nextGeneration,
          updatedAt: now
        };
      },
      { blocker: transition.blocker ?? null }
    );
  }

  bumpGeneration(input: BumpBoardTaskGenerationInput): BoardTask {
    if (!Number.isInteger(input.nextContractRevision) || input.nextContractRevision <= 0) {
      throw new Error("Board task next contract revision must be a positive integer.");
    }
    if (typeof input.nextContractHash !== "string" || input.nextContractHash.length !== 64) {
      throw new Error("Board task next contract hash must be a 64-character SHA-256 hex string.");
    }
    if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < BOARD_TASK_GENERATION_MIN) {
      throw new Error("Board task expected generation must be a positive integer.");
    }
    return this.#mutateTask(input.taskId, input.expectedGeneration, "bump_generation", (current) => {
      if (isTerminalStatus(current.status)) {
        throw new BoardTerminalTaskMutationError(input.taskId, current.status);
      }
      const now = this.#now();
      const nextGeneration = current.generation + 1;
      const result = this.#database
        .prepare(
          "UPDATE board_tasks SET contract_id = ?, contract_revision = ?, contract_hash = ?, " +
            "generation = ?, updated_at = ? WHERE task_id = ? AND generation = ?"
        )
        .run(
          String(input.nextContractId),
          input.nextContractRevision,
          input.nextContractHash,
          nextGeneration,
          now,
          String(input.taskId),
          input.expectedGeneration
        );
      if (result.changes !== 1) {
        throw new BoardConcurrencyError(input.taskId, input.expectedGeneration, current.generation);
      }
      return {
        ...current,
        contractId: input.nextContractId,
        contractRevision: input.nextContractRevision,
        contractHash: input.nextContractHash,
        generation: nextGeneration,
        updatedAt: now
      };
    });
  }

  supersedeTask(input: SupersedeBoardTaskInput): SupersedeBoardTaskResult {
    return runImmediateTransaction(this.#database, () => {
      const taskIdString = String(input.taskId);
      const currentRow = this.#database
        .prepare(STATEMENTS.selectForUpdateByGeneration)
        .get(taskIdString, input.expectedGeneration) as BoardTaskRow | undefined;

      if (!currentRow) {
        const actual = loadBoardTaskRow(this.#database, taskIdString);
        throw new BoardConcurrencyError(input.taskId, input.expectedGeneration, actual?.generation ?? null);
      }
      const current = rowToBoardTask(currentRow);

      if (current.status === "superseded") {
        throw new BoardTerminalTaskMutationError(input.taskId, current.status);
      }
      const now = this.#now();
      // Supersede must advance the generation so any live leases or queued
      // claims on the prior generation become stale and are reclaimed.
      const nextGeneration = current.generation + 1;
      const supersedeResult = this.#database
        .prepare(
          "UPDATE board_tasks SET status = 'superseded', generation = ?, updated_at = ? " +
            "WHERE task_id = ? AND generation = ?"
        )
        .run(nextGeneration, now, taskIdString, input.expectedGeneration);
      if (supersedeResult.changes !== 1) {
        throw new BoardConcurrencyError(input.taskId, input.expectedGeneration, current.generation);
      }
      const retiredRow = loadBoardTaskRow(this.#database, taskIdString);
      if (!retiredRow) {
        throw new BoardTaskNotFoundError(input.taskId);
      }
      const retired = rowToBoardTask(retiredRow);
      const retiredContractHash = retiredRow.contract_hash;

      let successor: BoardTask | null = null;
      if (input.successorTaskId) {
        const successorId = String(input.successorTaskId);
        const existingSuccessor = loadBoardTaskRow(this.#database, successorId);
        if (existingSuccessor) {
          throw new Error("Successor board task " + successorId + " already exists.");
        }
        this.#database
          .prepare(
            "INSERT INTO board_tasks (task_id, project_id, change_id, contract_id, contract_revision, " +
              "contract_hash, generation, status, priority, blocker_json, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?)"
          )
          .run(
            successorId,
            String(retired.projectId),
            String(retired.changeId),
            String(retired.contractId),
            retired.contractRevision,
            retiredContractHash,
            BOARD_TASK_GENERATION_MIN,
            retired.priority,
            now,
            now
          );
        // Record the supersede edge in board_task_links so successor and
        // predecessor stay bound even after the predecessor is terminal.
        const link = this.#database
          .prepare(
            "INSERT INTO board_task_links (task_id, depends_on_task_id, relation, created_at) " +
              "VALUES (?, ?, 'supersedes', ?)"
          )
          .run(successorId, taskIdString, now);
        if (link.changes !== 1) {
          throw new Error("Failed to record board_task_links supersede edge for " + successorId + ".");
        }
        const successorRow = loadBoardTaskRow(this.#database, successorId);
        if (!successorRow) {
          throw new Error("Successor board task " + successorId + " was not persisted after insert.");
        }
        successor = rowToBoardTask(successorRow);
        }

        this.#emitEvents({
        taskId: taskIdString,
        projectId: retired.projectId,
        changeId: retired.changeId,
        generation: retired.generation,
        mutation: "supersede",
        previous: current,
        current: retired,
        successor,
        blocker: null,
        occurredAt: now
        });

        return { retired, successor };
        });
  }

  deleteTask(taskId: BoardTask["taskId"], expectedGeneration: number): void {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < BOARD_TASK_GENERATION_MIN) {
      throw new Error("Board task expected generation must be a positive integer.");
    }
    runImmediateTransaction(this.#database, () => {
      const taskIdString = String(taskId);
      const currentRow = this.#database
        .prepare(STATEMENTS.selectForUpdateByGeneration)
        .get(taskIdString, expectedGeneration) as BoardTaskRow | undefined;
      if (!currentRow) {
        const actual = loadBoardTaskRow(this.#database, taskIdString);
        throw new BoardConcurrencyError(taskId, expectedGeneration, actual?.generation ?? null);
      }
      const previous = rowToBoardTask(currentRow);
      const result = this.#database
        .prepare("DELETE FROM board_tasks WHERE task_id = ? AND generation = ?")
        .run(taskIdString, expectedGeneration);
      if (result.changes !== 1) {
        throw new BoardConcurrencyError(taskId, expectedGeneration, currentRow.generation);
      }
      this.#emitEvents({
        taskId: taskIdString,
        projectId: previous.projectId,
        changeId: previous.changeId,
        generation: previous.generation,
        mutation: "delete",
        previous,
        current: null,
        successor: null,
        blocker: null,
        occurredAt: this.#now()
      });
    });
  }

  #mutateTask(
    taskId: BoardTask["taskId"],
    expectedGeneration: number | undefined,
    mutation: BoardTaskMutationKind,
    mutate: (current: BoardTask) => BoardTask,
    options: { readonly blocker?: BoardTaskBlocker | null } = {}
  ): BoardTask {
    return runImmediateTransaction(this.#database, () => {
      const taskIdString = String(taskId);
      let currentRow: BoardTaskRow | undefined;
      if (expectedGeneration !== undefined) {
        currentRow = this.#database
          .prepare(STATEMENTS.selectForUpdateByGeneration)
          .get(taskIdString, expectedGeneration) as BoardTaskRow | undefined;
        if (!currentRow) {
          const actual = loadBoardTaskRow(this.#database, taskIdString);
          throw new BoardConcurrencyError(taskId, expectedGeneration, actual?.generation ?? null);
        }
      } else {
        const lookup = loadBoardTaskRow(this.#database, taskIdString);
        if (!lookup) {
          throw new BoardTaskNotFoundError(taskId);
        }
        currentRow = lookup;
      }
      const current = rowToBoardTask(currentRow);
      const updated = mutate(current);
      const reloaded = loadBoardTaskRow(this.#database, taskIdString);
      if (!reloaded) {
        throw new BoardTaskNotFoundError(taskId);
      }
      // mutate returned the projected state; verify it matches the persisted row.
      if (
        reloaded.generation !== updated.generation ||
        reloaded.status !== updated.status ||
        reloaded.priority !== updated.priority ||
        reloaded.updated_at !== updated.updatedAt ||
        reloaded.blocker_json !== blockerToJson(updated.blocker)
      ) {
        throw new Error("Board task mutation projection did not match persisted row.");
      }
      const result = rowToBoardTask(reloaded);
      this.#emitEvents({
        taskId: taskIdString,
        projectId: result.projectId,
        changeId: result.changeId,
        generation: result.generation,
        mutation,
        previous: current,
        current: result,
        successor: null,
        blocker: options.blocker ?? null,
        occurredAt: result.updatedAt
      });
      return result;
    });
  }

  #emitEvents(context: Parameters<BoardTaskEventHook>[0]): readonly BoardEvent[] {
    if (!this.#eventRepository || this.eventHooks.length === 0) {
      return [];
    }
    const inputs: AppendBoardEventInput[] = [];
    for (const hook of this.eventHooks) {
      inputs.push(...hook(context));
    }
    const events: BoardEvent[] = [];
    for (const input of inputs) {
      events.push(this.#eventRepository.appendEventInTransaction(input));
    }
    return events;
  }
}

export function openSqliteBoardTaskRepository(options: SqliteBoardTaskRepositoryOptions): SqliteBoardTaskRepository {
  return new SqliteBoardTaskRepository(options);
}

export interface OpenSqliteBoardStoreWithRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithRepository implements BoardStore {
  readonly databasePath: string;
  readonly repository: SqliteBoardTaskRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    // Re-open a sibling handle from the same path so the repository has its own
    // transaction boundary without conflicting with the store's schema runner.
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const eventRepository = new SqliteBoardEventRepository(
      options.now ? { database, now: options.now } : { database }
    );
    this.repository = new SqliteBoardTaskRepository({
      database,
      eventRepository,
      eventHooks: [createBoardTaskEventHook()]
    });
  }

  static open(
    options: OpenSqliteBoardStoreWithRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    // The repository owns its own database handle opened via DatabaseSync; close
    // it explicitly before delegating to the store so both handles shut down cleanly.
    this.repository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

interface BoardClaimRow {
  readonly lease_token: string;
  readonly task_id: string;
  readonly generation: number;
  readonly owner_id: string;
  readonly run_id: string | null;
  readonly claimed_at: string;
  readonly lease_expires_at: string;
  readonly heartbeat_at: string;
  readonly released_at: string | null;
  readonly release_reason: string | null;
}

const BOARD_CLAIM_STATEMENTS = {
  selectByLeaseToken: `SELECT lease_token, task_id, generation, owner_id, run_id, claimed_at,
                              lease_expires_at, heartbeat_at, released_at, release_reason
                       FROM board_claims WHERE lease_token = ?`,
  selectActiveForTask: `SELECT lease_token, task_id, generation, owner_id, run_id, claimed_at,
                                lease_expires_at, heartbeat_at, released_at, release_reason
                         FROM board_claims
                         WHERE task_id = ? AND released_at IS NULL
                         ORDER BY claimed_at ASC
                         LIMIT 1`,
  selectTaskGeneration: `SELECT generation FROM board_tasks WHERE task_id = ?`,
  insertClaim: `INSERT INTO board_claims (lease_token, task_id, generation, owner_id, run_id,
                                        claimed_at, lease_expires_at, heartbeat_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  heartbeat: `UPDATE board_claims SET heartbeat_at = ?, lease_expires_at = ?
              WHERE lease_token = ? AND released_at IS NULL`,
  release: `UPDATE board_claims SET released_at = ?, release_reason = ?
            WHERE lease_token = ? AND released_at IS NULL`,
  selectExpired: `SELECT lease_token, task_id, generation, owner_id, run_id, claimed_at,
                          lease_expires_at, heartbeat_at, released_at, release_reason
                  FROM board_claims
                  WHERE released_at IS NULL AND lease_expires_at <= ?
                  ORDER BY lease_expires_at ASC`,
  expireOne: `UPDATE board_claims SET released_at = ?, release_reason = 'expired'
              WHERE lease_token = ? AND released_at IS NULL`
} as const;

function assertValidLeaseToken(leaseToken: string): void {
  if (typeof leaseToken !== "string" || leaseToken.length < BOARD_LEASE_TOKEN_MIN_LENGTH) {
    throw new Error(
      "Board claim lease token must be a string of at least " +
        BOARD_LEASE_TOKEN_MIN_LENGTH +
        " characters."
    );
  }
}

function assertValidOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("Board claim owner id must be a non-empty string.");
  }
}

function assertValidLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isFinite(leaseDurationMs) || !Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Board claim lease duration must be a positive integer (ms).");
  }
}

function assertValidReleaseReason(reason: string): asserts reason is BoardLeaseReleaseReason {
  if (!(BOARD_LEASE_RELEASE_REASONS as readonly string[]).includes(reason)) {
    throw new Error("Unknown board claim release reason: " + reason + ".");
  }
}

function rowToBoardClaim(row: BoardClaimRow): BoardClaim {
  const releaseReason = row.release_reason;
  let normalizedReason: BoardLeaseReleaseReason | null = null;
  if (releaseReason !== null) {
    assertValidReleaseReason(releaseReason);
    normalizedReason = releaseReason;
  }
  return {
    leaseToken: row.lease_token,
    taskId: row.task_id as BoardClaim["taskId"],
    generation: row.generation,
    ownerId: row.owner_id,
    runId: row.run_id === null ? null : (row.run_id as BoardClaim["runId"]),
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    releaseReason: normalizedReason
  };
}

function loadClaimRow(database: DatabaseSync, leaseToken: string): BoardClaimRow | undefined {
  return database.prepare(BOARD_CLAIM_STATEMENTS.selectByLeaseToken).get(leaseToken) as
    | BoardClaimRow
    | undefined;
}

function addLeaseDuration(isoNow: string, leaseDurationMs: number): string {
  const parsed = new Date(isoNow);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Board claim timestamp must be a valid ISO-8601 date: " + isoNow);
  }
  return new Date(parsed.getTime() + leaseDurationMs).toISOString();
}

interface SqliteBoardClaimRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

export class SqliteBoardClaimRepository implements BoardClaimRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardClaimRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  tryClaim(input: CreateBoardClaimInput): BoardClaim {
    assertValidOwnerId(input.ownerId);
    assertValidLeaseDuration(input.leaseDurationMs);
    if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < BOARD_TASK_GENERATION_MIN) {
      throw new Error("Board claim expected generation must be a positive integer.");
    }

    const now = this.#now();
    const claimedAt = input.claimedAt ?? now;
    if (typeof claimedAt !== "string" || Number.isNaN(new Date(claimedAt).getTime())) {
      throw new Error("Board claim claimedAt must be a valid ISO-8601 timestamp.");
    }
    const leaseToken = input.leaseToken ?? randomUUID();
    assertValidLeaseToken(leaseToken);
    const leaseExpiresAt = addLeaseDuration(claimedAt, input.leaseDurationMs);
    const taskId = String(input.taskId);
    const runId = input.runId === undefined ? null : String(input.runId);

    return runImmediateTransaction(this.#database, () => {
      const taskGenerationRow = this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.selectTaskGeneration)
        .get(taskId) as { generation: number } | undefined;
      if (!taskGenerationRow) {
        throw new BoardClaimGenerationError(input.taskId, input.expectedGeneration, null);
      }
      if (taskGenerationRow.generation !== input.expectedGeneration) {
        throw new BoardClaimGenerationError(
          input.taskId,
          input.expectedGeneration,
          taskGenerationRow.generation
        );
      }
      const existing = this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.selectActiveForTask)
        .get(taskId) as BoardClaimRow | undefined;
      if (existing) {
        throw new BoardClaimContendedError(
          input.taskId,
          input.expectedGeneration,
          existing.owner_id,
          existing.lease_token
        );
      }
      this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.insertClaim)
        .run(leaseToken, taskId, input.expectedGeneration, input.ownerId, runId, claimedAt, leaseExpiresAt, claimedAt);
      const row = loadClaimRow(this.#database, leaseToken);
      if (!row) {
        throw new Error("Board claim " + leaseToken + " was not persisted after insert.");
      }
      return rowToBoardClaim(row);
    });
  }

  getClaim(leaseToken: string): BoardClaim | null {
    assertValidLeaseToken(leaseToken);
    const row = loadClaimRow(this.#database, leaseToken);
    return row ? rowToBoardClaim(row) : null;
  }

  getActiveClaimForTask(taskId: BoardClaim["taskId"]): BoardClaim | null {
    const row = this.#database
      .prepare(BOARD_CLAIM_STATEMENTS.selectActiveForTask)
      .get(String(taskId)) as BoardClaimRow | undefined;
    return row ? rowToBoardClaim(row) : null;
  }

  heartbeat(input: HeartbeatBoardClaimInput): BoardClaim {
    assertValidLeaseDuration(input.leaseDurationMs);
    assertValidLeaseToken(input.leaseToken);
    const now = input.now ?? this.#now();
    if (typeof now !== "string" || Number.isNaN(new Date(now).getTime())) {
      throw new Error("Board claim heartbeat timestamp must be a valid ISO-8601 timestamp.");
    }
    const leaseExpiresAt = addLeaseDuration(now, input.leaseDurationMs);
    return runImmediateTransaction(this.#database, () => {
      const existing = loadClaimRow(this.#database, input.leaseToken);
      if (!existing) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      if (existing.released_at !== null) {
        // Idempotent heartbeat on a released claim: return the archived
        // record without touching it. Callers may still see heartbeatAt
        // unchanged; the lease is effectively dead either way.
        return rowToBoardClaim(existing);
      }
      const result = this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.heartbeat)
        .run(now, leaseExpiresAt, input.leaseToken);
      if (result.changes !== 1) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      const reloaded = loadClaimRow(this.#database, input.leaseToken);
      if (!reloaded) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      return rowToBoardClaim(reloaded);
    });
  }

  release(input: ReleaseBoardClaimInput): BoardClaim {
    assertValidLeaseToken(input.leaseToken);
    assertValidReleaseReason(input.reason);
    const now = input.now ?? this.#now();
    if (typeof now !== "string" || Number.isNaN(new Date(now).getTime())) {
      throw new Error("Board claim release timestamp must be a valid ISO-8601 timestamp.");
    }
    return runImmediateTransaction(this.#database, () => {
      const existing = loadClaimRow(this.#database, input.leaseToken);
      if (!existing) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      // Idempotent release: if the lease is already archived, return the
      // existing row instead of overwriting the original reason/timestamp.
      if (existing.released_at !== null) {
        return rowToBoardClaim(existing);
      }
      const result = this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.release)
        .run(now, input.reason, input.leaseToken);
      if (result.changes !== 1) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      const reloaded = loadClaimRow(this.#database, input.leaseToken);
      if (!reloaded) {
        throw new BoardClaimNotFoundError(input.leaseToken);
      }
      return rowToBoardClaim(reloaded);
    });
  }

  reclaimExpiredLeases(options: ReclaimBoardClaimsOptions = {}): readonly BoardClaim[] {
    const now = options.now ?? this.#now();
    if (typeof now !== "string" || Number.isNaN(new Date(now).getTime())) {
      throw new Error("Board claim reclaim timestamp must be a valid ISO-8601 timestamp.");
    }
    return runImmediateTransaction(this.#database, () => {
      const expired = this.#database
        .prepare(BOARD_CLAIM_STATEMENTS.selectExpired)
        .all(now) as unknown as BoardClaimRow[];
      const reclaimed: BoardClaim[] = [];
      for (const row of expired) {
        const result = this.#database
          .prepare(BOARD_CLAIM_STATEMENTS.expireOne)
          .run(now, row.lease_token);
        if (result.changes !== 1) {
          continue;
        }
        const reloaded = loadClaimRow(this.#database, row.lease_token);
        if (reloaded) {
          reclaimed.push(rowToBoardClaim(reloaded));
        }
      }
      return reclaimed;
    });
  }
}

export function openSqliteBoardClaimRepository(
  options: SqliteBoardClaimRepositoryOptions
): SqliteBoardClaimRepository {
  return new SqliteBoardClaimRepository(options);
}

export interface OpenSqliteBoardStoreWithClaimRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithClaimRepository implements BoardStore {
  readonly databasePath: string;
  readonly claimRepository: SqliteBoardClaimRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const claimOptions: SqliteBoardClaimRepositoryOptions = options.now
      ? { database, now: options.now }
      : { database };
    this.claimRepository = new SqliteBoardClaimRepository(claimOptions);
  }

  static open(
    options: OpenSqliteBoardStoreWithClaimRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithClaimRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithClaimRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    this.claimRepository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

// =====================================================================
// P03-T07: SqliteBoardApprovalRepository.
//
// Reads and writes the `board_approvals` table introduced by the v1
// schema. The table columns are:
//   approval_id TEXT PRIMARY KEY
//   task_id     TEXT NOT NULL  -> board_tasks.task_id  (ON DELETE CASCADE)
//   run_id      TEXT NULL      -> board_task_runs.run_id (ON DELETE SET NULL)
//   status      TEXT NOT NULL  CHECK (... 'requested','granted','denied','expired','revoked')
//   scope_json  TEXT NOT NULL
//   requested_by_json TEXT NOT NULL
//   decided_by_json   TEXT NULL
//   requested_at TEXT NOT NULL
//   decided_at  TEXT NULL
//
// Notes:
// - The schema has no separate expires_at column; we encode the
//   caller-supplied TTL inside `scope_json` under a reserved
//   `expiresAt` key so the v1 schema stays untouched and consumers
//   can detect when an approval has outlived its request window.
// - The lifecycle phase (`pending`/`approved`/`revoked`) is computed
//   from the persisted `status` column at read time. The DB never
//   stores the phase directly.
// =====================================================================

const BOARD_APPROVAL_EFFECT_CLASSES = ["S0", "S1", "S2", "S3", "S4"] as const;
const BOARD_APPROVAL_ACTOR_KINDS = ["human", "agent", "system", "automation"] as const;

interface BoardApprovalRow {
  readonly approval_id: string;
  readonly task_id: string;
  readonly run_id: string | null;
  readonly status: string;
  readonly scope_json: string;
  readonly requested_by_json: string;
  readonly decided_by_json: string | null;
  readonly requested_at: string;
  readonly decided_at: string | null;
}

const BOARD_APPROVAL_STATEMENTS = {
  selectById: `SELECT approval_id, task_id, run_id, status, scope_json,
                       requested_by_json, decided_by_json, requested_at, decided_at
                FROM board_approvals WHERE approval_id = ?`
} as const;

function assertValidApprovalStatus(status: string): asserts status is BoardApprovalStatus {
  if (!(BOARD_APPROVAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error("Unknown board approval status: " + status + ".");
  }
}

function assertValidApprovalLifecyclePhase(
  phase: string
): asserts phase is BoardApprovalLifecyclePhase {
  if (!(BOARD_APPROVAL_LIFECYCLE_PHASES as readonly string[]).includes(phase)) {
    throw new Error("Unknown board approval lifecycle phase: " + phase + ".");
  }
}

function assertValidApprovalEffectClass(
  effectClass: string
): asserts effectClass is BoardApprovalScope["effectClass"] {
  if (!(BOARD_APPROVAL_EFFECT_CLASSES as readonly string[]).includes(effectClass)) {
    throw new Error(
      "Board approval scope effectClass must be one of " +
        BOARD_APPROVAL_EFFECT_CLASSES.join(", ") +
        ", received " +
        effectClass +
        "."
    );
  }
}

function assertValidApprovalAction(action: string): void {
  if (typeof action !== "string" || !/^[a-z][a-z0-9._:-]{1,127}$/.test(action)) {
    throw new Error(
      "Board approval scope action must match /^[a-z][a-z0-9._:-]{1,127}$/, received " +
        JSON.stringify(action) +
        "."
    );
  }
}

function assertValidApprovalTargetsJson(targetsJson: string): void {
  if (typeof targetsJson !== "string" || targetsJson.length === 0) {
    throw new Error("Board approval scope targetsJson must be a non-empty JSON array string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(targetsJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Board approval scope targetsJson is not valid JSON: " + message);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Board approval scope targetsJson must decode to a non-empty array.");
  }
}

function assertValidApprovalActor(actor: BoardApprovalActor, fieldName: string): void {
  if (!actor || typeof actor !== "object") {
    throw new Error("Board approval " + fieldName + " must be an object.");
  }
  if (typeof actor.id !== "string" || actor.id.length === 0) {
    throw new Error("Board approval " + fieldName + ".id must be a non-empty string.");
  }
  if (
    actor.displayName !== undefined &&
    (typeof actor.displayName !== "string" || actor.displayName.length === 0)
  ) {
    throw new Error(
      "Board approval " + fieldName + ".displayName must be a non-empty string when provided."
    );
  }
  if (!(BOARD_APPROVAL_ACTOR_KINDS as readonly string[]).includes(actor.kind)) {
    throw new Error(
      "Board approval " +
        fieldName +
        ".kind must be one of " +
        BOARD_APPROVAL_ACTOR_KINDS.join(", ") +
        ", received " +
        JSON.stringify(actor.kind) +
        "."
    );
  }
}

function assertValidApprovalScope(scope: BoardApprovalScope): void {
  if (!scope || typeof scope !== "object") {
    throw new Error("Board approval scope must be an object.");
  }
  assertValidApprovalEffectClass(scope.effectClass);
  assertValidApprovalAction(scope.action);
  assertValidApprovalTargetsJson(scope.targetsJson);
  if (
    scope.justification !== undefined &&
    (typeof scope.justification !== "string" || scope.justification.length === 0)
  ) {
    throw new Error(
      "Board approval scope.justification must be a non-empty string when provided."
    );
  }
}

function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error("Board approval " + fieldName + " must be a valid ISO-8601 timestamp.");
  }
}

function assertValidDecisionReason(reason: string): void {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("Board approval decision reason must be a non-empty string.");
  }
  if (reason.length > 2_048) {
    throw new Error("Board approval decision reason must be 2048 characters or fewer.");
  }
}

/**
 * Stable mapping from `BoardApprovalStatus` to the three lifecycle
 * phases. `requested` -> pending, `granted` -> approved, the rest ->
 * revoked (with `revoked` reachable from either `requested` or
 * `granted`).
 */
const BOARD_APPROVAL_LIFECYCLE_PHASE_BY_STATUS: Readonly<
  Record<BoardApprovalStatus, BoardApprovalLifecyclePhase>
> = {
  requested: "pending",
  granted: "approved",
  denied: "revoked",
  expired: "revoked",
  revoked: "revoked"
};

function lifecyclePhaseForStatus(status: BoardApprovalStatus): BoardApprovalLifecyclePhase {
  return BOARD_APPROVAL_LIFECYCLE_PHASE_BY_STATUS[status];
}

function assertApprovalTransitionLegal(
  approvalId: string,
  from: BoardApprovalStatus,
  to: BoardApprovalStatus
): void {
  const allowed = BOARD_APPROVAL_STATUS_TRANSITIONS[from];
  if (!(allowed as readonly string[]).includes(to)) {
    throw new BoardApprovalIllegalStatusTransitionError(
      approvalId as BoardApproval["approvalId"],
      from,
      to
    );
  }
}

function isTerminalApprovalStatus(status: BoardApprovalStatus): boolean {
  return (BOARD_APPROVAL_TERMINAL_STATUSES as readonly BoardApprovalStatus[]).includes(status);
}

interface BoardApprovalScopeEnvelope {
  readonly effectClass: BoardApprovalScope["effectClass"];
  readonly action: string;
  readonly targetsJson: string;
  readonly justification?: string;
  readonly expiresAt?: string | null;
}

function scopeToJson(scope: BoardApprovalScope, expiresAt: string | null | undefined): string {
  const envelope: BoardApprovalScopeEnvelope = {
    effectClass: scope.effectClass,
    action: scope.action,
    targetsJson: scope.targetsJson,
    ...(scope.justification !== undefined ? { justification: scope.justification } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
  };
  return JSON.stringify(envelope);
}

function scopeFromJson(raw: string): { scope: BoardApprovalScope; expiresAt: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Board approval scope_json is not valid JSON: " + message);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Board approval scope_json must decode to an object.");
  }
  const envelope = parsed as Partial<BoardApprovalScopeEnvelope>;
  if (
    typeof envelope.effectClass !== "string" ||
    typeof envelope.action !== "string" ||
    typeof envelope.targetsJson !== "string"
  ) {
    throw new Error("Board approval scope_json is missing required fields.");
  }
  const scope: BoardApprovalScope = {
    effectClass: envelope.effectClass,
    action: envelope.action,
    targetsJson: envelope.targetsJson,
    ...(typeof envelope.justification === "string" && envelope.justification.length > 0
      ? { justification: envelope.justification }
      : {})
  };
  let expiresAt: string | null = null;
  if (typeof envelope.expiresAt === "string" && envelope.expiresAt.length > 0) {
    if (Number.isNaN(new Date(envelope.expiresAt).getTime())) {
      throw new Error("Board approval scope_json.expiresAt is not a valid ISO-8601 timestamp.");
    }
    expiresAt = envelope.expiresAt;
  }
  return { scope, expiresAt };
}

function actorToJson(actor: BoardApprovalActor): string {
  return JSON.stringify(actor);
}

function actorFromJson(raw: string, fieldName: string): BoardApprovalActor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Board approval " + fieldName + " JSON is invalid: " + message);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Board approval " + fieldName + " JSON must decode to an object.");
  }
  const candidate = parsed as Partial<BoardApprovalActor>;
  const actor: BoardApprovalActor = {
    id: typeof candidate.id === "string" ? candidate.id : "",
    kind:
      typeof candidate.kind === "string" &&
      (BOARD_APPROVAL_ACTOR_KINDS as readonly string[]).includes(candidate.kind)
        ? (candidate.kind as BoardApprovalActor["kind"])
        : "system",
    ...(typeof candidate.displayName === "string" && candidate.displayName.length > 0
      ? { displayName: candidate.displayName }
      : {})
  };
  assertValidApprovalActor(actor, fieldName);
  return actor;
}

function loadApprovalRow(database: DatabaseSync, approvalId: string): BoardApprovalRow | undefined {
  return database.prepare(BOARD_APPROVAL_STATEMENTS.selectById).get(approvalId) as
    | BoardApprovalRow
    | undefined;
}

function rowToBoardApproval(row: BoardApprovalRow): BoardApproval {
  assertValidApprovalStatus(row.status);
  const status = row.status;
  const { scope, expiresAt } = scopeFromJson(row.scope_json);
  const requestedBy = actorFromJson(row.requested_by_json, "requestedBy");
  const decidedBy =
    row.decided_by_json === null || row.decided_by_json.length === 0
      ? null
      : actorFromJson(row.decided_by_json, "decidedBy");
  // v1 schema has no separate decision_reason column; surface null on
  // the read shape so callers know the column does not exist. Scope
  // justification is the existing mechanism for caller-supplied text.
  const decisionReason = null;
  return {
    approvalId: row.approval_id as BoardApproval["approvalId"],
    taskId: row.task_id as BoardApproval["taskId"],
    runId: row.run_id === null ? null : (row.run_id as BoardApproval["runId"]),
    status,
    lifecyclePhase: lifecyclePhaseForStatus(status),
    scope,
    requestedBy,
    decidedBy,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    approvedAt: row.decided_at,
    expiresAt,
    decisionReason
  };
}

interface SqliteBoardApprovalRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

export class SqliteBoardApprovalRepository implements BoardApprovalRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardApprovalRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  createApproval(input: CreateBoardApprovalInput): BoardApproval {
    assertValidApprovalScope(input.scope);
    assertValidApprovalActor(input.requestedBy, "requestedBy");
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      assertValidIsoTimestamp(input.expiresAt, "expiresAt");
    }
    const requestedAt = input.requestedAt ?? this.#now();
    assertValidIsoTimestamp(requestedAt, "requestedAt");
    const taskId = String(input.taskId);
    const runId = input.runId === undefined || input.runId === null ? null : String(input.runId);
    const approvalId = String(input.approvalId ?? "apv_" + randomUUID());
    const scopeJson = scopeToJson(input.scope, input.expiresAt ?? null);
    const requestedByJson = actorToJson(input.requestedBy);

    return runImmediateTransaction(this.#database, () => {
      if (input.idempotencyKey) {
        const existingIdempotent = this.#database
          .prepare(
            "SELECT result_json FROM board_idempotency_records " +
              "WHERE scope = ? AND idempotency_key = ?"
          )
          .get("board.approval.create", input.idempotencyKey) as
          | { result_json: string }
          | undefined;
        if (existingIdempotent) {
          try {
            const parsed = JSON.parse(existingIdempotent.result_json) as { approvalId: string };
            const existingRow = loadApprovalRow(this.#database, parsed.approvalId);
            if (existingRow) {
              return rowToBoardApproval(existingRow);
            }
          } catch {
            // Fall through and surface a duplicate-approval error below.
          }
        }
      }
      const existing = loadApprovalRow(this.#database, approvalId);
      if (existing) {
        throw new BoardApprovalAlreadyExistsError(approvalId as BoardApproval["approvalId"]);
      }
      try {
        this.#database
          .prepare(
            "INSERT INTO board_approvals " +
              "(approval_id, task_id, run_id, status, scope_json, " +
              "requested_by_json, decided_by_json, requested_at, decided_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            approvalId,
            taskId,
            runId,
            "requested",
            scopeJson,
            requestedByJson,
            null,
            requestedAt,
            null
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/FOREIGN KEY/i.test(message)) {
          throw new Error(
            "Board approval references unknown task " +
              taskId +
              " or run " +
              (runId ?? "<none>") +
              "."
          );
        }
        throw error;
      }
      if (input.idempotencyKey) {
        const resultJson = JSON.stringify({ approvalId });
        const resultHash = createHash("sha256").update(resultJson).digest("hex");
        this.#database
          .prepare(
            "INSERT INTO board_idempotency_records (scope, idempotency_key, result_hash, result_json, created_at) " +
              "VALUES (?, ?, ?, ?, ?)"
          )
          .run("board.approval.create", input.idempotencyKey, resultHash, resultJson, requestedAt);
      }
      const row = loadApprovalRow(this.#database, approvalId);
      if (!row) {
        throw new Error("Board approval " + approvalId + " was not persisted after insert.");
      }
      return rowToBoardApproval(row);
    });
  }

  getApproval(approvalId: BoardApproval["approvalId"]): BoardApproval | null {
    const row = loadApprovalRow(this.#database, String(approvalId));
    return row ? rowToBoardApproval(row) : null;
  }

  listApprovals(query: ListBoardApprovalsQuery = {}): readonly BoardApproval[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.taskId) {
      where.push("task_id = ?");
      params.push(String(query.taskId));
    }
    if (query.runId) {
      where.push("run_id = ?");
      params.push(String(query.runId));
    }

    let statusFilter: readonly BoardApprovalStatus[] | null = null;
    if (query.status && query.status.length > 0) {
      statusFilter = query.status;
      for (const s of statusFilter) {
        assertValidApprovalStatus(s);
      }
    } else if (query.lifecyclePhase && query.lifecyclePhase.length > 0) {
      for (const p of query.lifecyclePhase) {
        assertValidApprovalLifecyclePhase(p);
      }
      const phaseStatuses = new Set<BoardApprovalStatus>();
      for (const status of BOARD_APPROVAL_STATUSES) {
        for (const phase of query.lifecyclePhase) {
          if (lifecyclePhaseForStatus(status) === phase) {
            phaseStatuses.add(status);
          }
        }
      }
      statusFilter = Array.from(phaseStatuses);
    }
    const hasFilter =
      query.taskId !== undefined ||
      query.runId !== undefined ||
      (query.status && query.status.length > 0) ||
      (query.lifecyclePhase && query.lifecyclePhase.length > 0);
    const includeTerminal = query.includeTerminal ?? hasFilter;
    if (!includeTerminal) {
      const nonTerminal = BOARD_APPROVAL_STATUSES.filter((s) => !isTerminalApprovalStatus(s));
      if (statusFilter && statusFilter.length > 0) {
        statusFilter = statusFilter.filter((s) => nonTerminal.includes(s));
      } else {
        statusFilter = nonTerminal;
      }
    }
    if (statusFilter && statusFilter.length > 0) {
      const placeholders = statusFilter.map(() => "?").join(", ");
      where.push("status IN (" + placeholders + ")");
      for (const s of statusFilter) {
        params.push(s);
      }
    }

    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board approval list limit must be a positive integer.");
    }

    const sql =
      "SELECT approval_id, task_id, run_id, status, scope_json, " +
      "requested_by_json, decided_by_json, requested_at, decided_at " +
      "FROM board_approvals" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY requested_at ASC " +
      "LIMIT " +
      limit;

    const rows = this.#database.prepare(sql).all(...params) as unknown as BoardApprovalRow[];
    return rows.map(rowToBoardApproval);
  }

  grantApproval(input: DecideBoardApprovalInput): BoardApproval {
    return this.#decideApproval(input, "granted");
  }

  denyApproval(input: DecideBoardApprovalInput): BoardApproval {
    return this.#decideApproval(input, "denied");
  }

  expireApproval(input: ExpireBoardApprovalInput): BoardApproval {
    const approvalId = String(input.approvalId);
    return runImmediateTransaction(this.#database, () => {
      const existing = loadApprovalRow(this.#database, approvalId);
      if (!existing) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      const currentStatus = assertApprovalStatusMatches(existing.status, approvalId, input.expectedStatus);
      assertApprovalTransitionLegal(approvalId, currentStatus, "expired");
      if (isTerminalApprovalStatus(currentStatus)) {
        throw new BoardApprovalTerminalStatusError(input.approvalId, currentStatus);
      }
      const now = input.now ?? this.#now();
      assertValidIsoTimestamp(now, "now");
      const result = this.#database
        .prepare(
          "UPDATE board_approvals SET status = ?, decided_at = ?, decided_by_json = NULL " +
            "WHERE approval_id = ? AND status = ?"
        )
        .run("expired", now, approvalId, input.expectedStatus);
      if (result.changes !== 1) {
        throw new BoardApprovalConcurrencyError(input.approvalId, input.expectedStatus, currentStatus);
      }
      const reloaded = loadApprovalRow(this.#database, approvalId);
      if (!reloaded) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      return rowToBoardApproval(reloaded);
    });
  }

  revokeApproval(input: RevokeBoardApprovalInput): BoardApproval {
    assertValidApprovalActor(input.revokedBy, "revokedBy");
    assertValidDecisionReason(input.revokeReason);
    const approvalId = String(input.approvalId);
    return runImmediateTransaction(this.#database, () => {
      const existing = loadApprovalRow(this.#database, approvalId);
      if (!existing) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      const currentStatus = assertApprovalStatusMatches(existing.status, approvalId, input.expectedStatus);
      assertApprovalTransitionLegal(approvalId, currentStatus, "revoked");
      if (isTerminalApprovalStatus(currentStatus)) {
        throw new BoardApprovalTerminalStatusError(input.approvalId, currentStatus);
      }
      const now = input.revokedAt ?? this.#now();
      assertValidIsoTimestamp(now, "revokedAt");
      const revokedByJson = actorToJson(input.revokedBy);
      const result = this.#database
        .prepare(
          "UPDATE board_approvals SET status = ?, decided_at = ?, decided_by_json = ? " +
            "WHERE approval_id = ? AND status = ?"
        )
        .run("revoked", now, revokedByJson, approvalId, input.expectedStatus);
      if (result.changes !== 1) {
        throw new BoardApprovalConcurrencyError(input.approvalId, input.expectedStatus, currentStatus);
      }
      const reloaded = loadApprovalRow(this.#database, approvalId);
      if (!reloaded) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      return rowToBoardApproval(reloaded);
    });
  }

  #decideApproval(input: DecideBoardApprovalInput, targetStatus: "granted" | "denied"): BoardApproval {
    assertValidApprovalActor(input.decidedBy, "decidedBy");
    assertValidDecisionReason(input.decisionReason);
    const approvalId = String(input.approvalId);
    return runImmediateTransaction(this.#database, () => {
      const existing = loadApprovalRow(this.#database, approvalId);
      if (!existing) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      const currentStatus = assertApprovalStatusMatches(existing.status, approvalId, input.expectedStatus);
      assertApprovalTransitionLegal(approvalId, currentStatus, targetStatus);
      const now = input.decidedAt ?? this.#now();
      assertValidIsoTimestamp(now, "decidedAt");
      const decidedByJson = actorToJson(input.decidedBy);
      const result = this.#database
        .prepare(
          "UPDATE board_approvals SET status = ?, decided_at = ?, decided_by_json = ? " +
            "WHERE approval_id = ? AND status = ?"
        )
        .run(targetStatus, now, decidedByJson, approvalId, input.expectedStatus);
      if (result.changes !== 1) {
        throw new BoardApprovalConcurrencyError(input.approvalId, input.expectedStatus, currentStatus);
      }
      const reloaded = loadApprovalRow(this.#database, approvalId);
      if (!reloaded) {
        throw new BoardApprovalNotFoundError(input.approvalId);
      }
      return rowToBoardApproval(reloaded);
    });
  }
}

function assertApprovalStatusMatches(
  actual: string,
  approvalId: string,
  expected: BoardApprovalStatus
): BoardApprovalStatus {
  assertValidApprovalStatus(actual);
  if (actual !== expected) {
    throw new BoardApprovalConcurrencyError(
      approvalId as BoardApproval["approvalId"],
      expected,
      actual
    );
  }
  return actual;
}

export function openSqliteBoardApprovalRepository(
  options: SqliteBoardApprovalRepositoryOptions
): SqliteBoardApprovalRepository {
  return new SqliteBoardApprovalRepository(options);
}

export interface OpenSqliteBoardStoreWithApprovalRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithApprovalRepository implements BoardStore {
  readonly databasePath: string;
  readonly approvalRepository: SqliteBoardApprovalRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    // Sibling handle so the approval repository has its own transaction
    // boundary independent of the schema runner, mirroring the task
    // and claim repository pattern.
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const approvalOptions: SqliteBoardApprovalRepositoryOptions = options.now
      ? { database, now: options.now }
      : { database };
    this.approvalRepository = new SqliteBoardApprovalRepository(approvalOptions);
  }

  static open(
    options: OpenSqliteBoardStoreWithApprovalRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithApprovalRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithApprovalRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    this.approvalRepository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

// =====================================================================
// P03-T05: Board outbox repository (SQLite provider).
// =====================================================================

interface BoardOutboxRow {
  readonly outbox_id: string;
  readonly idempotency_key: string;
  readonly effect_class: string;
  readonly effect_kind: string;
  readonly target_hash: string;
  readonly payload_json: string;
  readonly status: string;
  readonly attempts: number;
  readonly available_at: string;
  readonly claimed_by: string | null;
  readonly claimed_until: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const BOARD_OUTBOX_STATEMENTS = {
  selectById: `SELECT outbox_id, idempotency_key, effect_class, effect_kind, target_hash, payload_json,
                      status, attempts, available_at, claimed_by, claimed_until, last_error, created_at, updated_at
               FROM board_outbox WHERE outbox_id = ?`,
  selectByIdempotencyKey: `SELECT outbox_id, idempotency_key, effect_class, effect_kind, target_hash, payload_json,
                                  status, attempts, available_at, claimed_by, claimed_until, last_error, created_at, updated_at
                           FROM board_outbox WHERE idempotency_key = ?`
} as const;

function assertValidOutboxEffectClass(effectClass: string): asserts effectClass is BoardOutboxEffectClass {
  if (!(BOARD_OUTBOX_EFFECT_CLASSES as readonly string[]).includes(effectClass)) {
    throw new Error(
      "Board outbox effectClass must be one of " +
        BOARD_OUTBOX_EFFECT_CLASSES.join(", ") +
        ", received " +
        effectClass +
        "."
    );
  }
}

function assertValidOutboxEffectKind(effectKind: string): void {
  if (typeof effectKind !== "string" || effectKind.length === 0) {
    throw new Error("Board outbox effectKind must be a non-empty string.");
  }
}

function assertValidOutboxTargetHash(targetHash: string): void {
  assertValidContractHash(targetHash);
}

function assertValidOutboxPayload(payload: Readonly<Record<string, unknown>>): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Board outbox payload must be a plain object.");
  }
}

function assertValidOutboxStatus(status: string): asserts status is BoardOutboxStatus {
  if (!(BOARD_OUTBOX_STATUSES as readonly string[]).includes(status)) {
    throw new Error("Unknown board outbox status: " + status + ".");
  }
}

function isTerminalOutboxStatus(status: BoardOutboxStatus): boolean {
  return status === "succeeded" || status === "dead_lettered";
}

function loadOutboxRow(database: DatabaseSync, outboxId: string): BoardOutboxRow | undefined {
  return database.prepare(BOARD_OUTBOX_STATEMENTS.selectById).get(outboxId) as BoardOutboxRow | undefined;
}

function loadOutboxRowByIdempotencyKey(
  database: DatabaseSync,
  idempotencyKey: string
): BoardOutboxRow | undefined {
  return database.prepare(BOARD_OUTBOX_STATEMENTS.selectByIdempotencyKey).get(idempotencyKey) as
    | BoardOutboxRow
    | undefined;
}

function parseOutboxPayloadJson(raw: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Board outbox payload_json is not valid JSON: " + message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Board outbox payload_json must decode to a plain object.");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function rowToBoardOutbox(row: BoardOutboxRow): BoardOutbox {
  assertValidOutboxStatus(row.status);
  assertValidOutboxEffectClass(row.effect_class);
  assertValidOutboxEffectKind(row.effect_kind);
  assertValidOutboxTargetHash(row.target_hash);
  return {
    outboxId: row.outbox_id,
    idempotencyKey: row.idempotency_key,
    effectClass: row.effect_class,
    effectKind: row.effect_kind,
    targetHash: row.target_hash,
    payload: parseOutboxPayloadJson(row.payload_json),
    payloadJson: row.payload_json,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedBy: row.claimed_by,
    claimedUntil: row.claimed_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface SqliteBoardOutboxRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

export class SqliteBoardOutboxRepository implements BoardOutboxRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardOutboxRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  enqueueOutbox(input: CreateBoardOutboxInput): BoardOutbox {
    assertValidOutboxEffectClass(input.effectClass);
    assertValidOutboxEffectKind(input.effectKind);
    assertValidOutboxTargetHash(input.targetHash);
    assertValidOutboxPayload(input.payload);
    if (input.idempotencyKey !== undefined && input.idempotencyKey.length === 0) {
      throw new Error("Board outbox idempotencyKey must be a non-empty string when provided.");
    }
    const now = this.#now();
    const outboxId = String(input.outboxId ?? "outbox_" + randomUUID());
    const createdAt = input.createdAt ?? now;
    assertValidIsoTimestamp(createdAt, "createdAt");
    const availableAt = input.availableAt ?? createdAt;
    assertValidIsoTimestamp(availableAt, "availableAt");
    const payloadJson = canonicalizeJson(input.payload);
    const idempotencyKey = input.idempotencyKey ?? `outbox:${outboxId}`;

    return runImmediateTransaction(this.#database, () => {
      if (input.idempotencyKey) {
        const existing = loadOutboxRowByIdempotencyKey(this.#database, input.idempotencyKey);
        if (existing) {
          return rowToBoardOutbox(existing);
        }
      }
      const existingById = loadOutboxRow(this.#database, outboxId);
      if (existingById) {
        throw new BoardOutboxConcurrencyError(outboxId, "pending", rowToBoardOutbox(existingById).status);
      }
      this.#database
        .prepare(
          "INSERT INTO board_outbox (outbox_id, idempotency_key, effect_class, effect_kind, target_hash, payload_json, status, attempts, available_at, claimed_by, claimed_until, last_error, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)"
        )
        .run(outboxId, idempotencyKey, input.effectClass, input.effectKind, input.targetHash, payloadJson, availableAt, createdAt, createdAt);
      if (input.idempotencyKey) {
        const resultJson = JSON.stringify({ outboxId });
        const resultHash = createHash("sha256").update(resultJson).digest("hex");
        this.#database
          .prepare(
            "INSERT INTO board_idempotency_records (scope, idempotency_key, result_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run("board.outbox.enqueue", input.idempotencyKey, resultHash, resultJson, createdAt);
      }
      const row = loadOutboxRow(this.#database, outboxId);
      if (!row) {
        throw new Error("Board outbox row " + outboxId + " was not persisted after insert.");
      }
      return rowToBoardOutbox(row);
    });
  }

  getOutbox(outboxId: string): BoardOutbox | null {
    const row = loadOutboxRow(this.#database, String(outboxId));
    return row ? rowToBoardOutbox(row) : null;
  }

  getOutboxByIdempotencyKey(idempotencyKey: string): BoardOutbox | null {
    const row = loadOutboxRowByIdempotencyKey(this.#database, String(idempotencyKey));
    return row ? rowToBoardOutbox(row) : null;
  }

  listOutbox(query: ListBoardOutboxQuery = {}): readonly BoardOutbox[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.status && query.status.length > 0) {
      const placeholders = query.status.map(() => "?").join(", ");
      where.push("status IN (" + placeholders + ")");
      for (const status of query.status) {
        assertValidOutboxStatus(status);
        params.push(status);
      }
    }
    if (query.effectClass && query.effectClass.length > 0) {
      const placeholders = query.effectClass.map(() => "?").join(", ");
      where.push("effect_class IN (" + placeholders + ")");
      for (const effectClass of query.effectClass) {
        assertValidOutboxEffectClass(effectClass);
        params.push(effectClass);
      }
    }
    if (query.effectKind !== undefined) {
      assertValidOutboxEffectKind(query.effectKind);
      where.push("effect_kind = ?");
      params.push(query.effectKind);
    }
    if (query.availableBefore !== undefined) {
      assertValidIsoTimestamp(query.availableBefore, "availableBefore");
      where.push("available_at <= ?");
      params.push(query.availableBefore);
    }

    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board outbox list limit must be a positive integer.");
    }

    const sql =
      "SELECT outbox_id, idempotency_key, effect_class, effect_kind, target_hash, payload_json, status, attempts, available_at, claimed_by, claimed_until, last_error, created_at, updated_at " +
      "FROM board_outbox" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY available_at ASC, created_at ASC " +
      "LIMIT " +
      limit;

    const rows = this.#database.prepare(sql).all(...params) as unknown as BoardOutboxRow[];
    return rows.map(rowToBoardOutbox);
  }

  claimOutbox(input: ClaimBoardOutboxInput): BoardOutbox {
    if (typeof input.claimedBy !== "string" || input.claimedBy.length === 0) {
      throw new Error("Board outbox claimedBy must be a non-empty string.");
    }
    assertValidIsoTimestamp(input.claimedUntil, "claimedUntil");
    const now = input.now ?? this.#now();
    assertValidIsoTimestamp(now, "now");
    const outboxId = String(input.outboxId);

    return runImmediateTransaction(this.#database, () => {
      const row = loadOutboxRow(this.#database, outboxId);
      if (!row) {
        throw new BoardOutboxNotFoundError(outboxId);
      }
      const current = rowToBoardOutbox(row);
      if (isTerminalOutboxStatus(current.status)) {
        throw new BoardOutboxTerminalStatusError(outboxId, current.status);
      }
      if (current.status === "claimed" && current.claimedUntil !== null) {
        const expires = new Date(current.claimedUntil).getTime();
        const nowMs = new Date(now).getTime();
        if (expires > nowMs) {
          throw new BoardOutboxConcurrencyError(outboxId, "pending", current.status);
        }
      }
      const availableMs = new Date(current.availableAt).getTime();
      const nowMs = new Date(now).getTime();
      if (availableMs > nowMs) {
        throw new BoardOutboxConcurrencyError(outboxId, current.status, current.status);
      }
      this.#database
        .prepare(
          "UPDATE board_outbox SET status = 'claimed', attempts = attempts + 1, claimed_by = ?, claimed_until = ?, last_error = NULL, updated_at = ? WHERE outbox_id = ?"
        )
        .run(input.claimedBy, input.claimedUntil, now, outboxId);
      const claimed = loadOutboxRow(this.#database, outboxId);
      if (!claimed) {
        throw new BoardOutboxNotFoundError(outboxId);
      }
      return rowToBoardOutbox(claimed);
    });
  }

  markOutboxAttempt(input: MarkBoardOutboxAttemptInput): BoardOutbox {
    const outboxId = String(input.outboxId);
    const updatedAt = input.updatedAt ?? this.#now();
    assertValidIsoTimestamp(updatedAt, "updatedAt");
    if (input.nextAvailableAt !== undefined) {
      assertValidIsoTimestamp(input.nextAvailableAt, "nextAvailableAt");
    }
    if (input.lastError !== undefined && input.lastError !== null && input.lastError.length === 0) {
      throw new Error("Board outbox lastError must be a non-empty string when provided.");
    }

    return runImmediateTransaction(this.#database, () => {
      const row = loadOutboxRow(this.#database, outboxId);
      if (!row) {
        throw new BoardOutboxNotFoundError(outboxId);
      }
      const current = rowToBoardOutbox(row);
      if (current.status !== "claimed") {
        if (isTerminalOutboxStatus(current.status)) {
          throw new BoardOutboxTerminalStatusError(outboxId, current.status);
        }
        throw new BoardOutboxConcurrencyError(outboxId, "claimed", current.status);
      }
      const nextAvailableAt = input.nextAvailableAt ?? updatedAt;
      const nextStatus = input.result;
      const nextLastError = input.lastError ?? null;
      this.#database
        .prepare(
          "UPDATE board_outbox SET status = ?, available_at = ?, claimed_by = NULL, claimed_until = NULL, last_error = ?, updated_at = ? WHERE outbox_id = ?"
        )
        .run(nextStatus, nextAvailableAt, nextLastError, updatedAt, outboxId);
      const saved = loadOutboxRow(this.#database, outboxId);
      if (!saved) {
        throw new BoardOutboxNotFoundError(outboxId);
      }
      return rowToBoardOutbox(saved);
    });
  }
}

export function openSqliteBoardOutboxRepository(
  options: SqliteBoardOutboxRepositoryOptions
): SqliteBoardOutboxRepository {
  return new SqliteBoardOutboxRepository(options);
}

export interface OpenSqliteBoardStoreWithOutboxRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithOutboxRepository implements BoardStore {
  readonly databasePath: string;
  readonly outboxRepository: SqliteBoardOutboxRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const outboxOptions: SqliteBoardOutboxRepositoryOptions = options.now ? { database, now: options.now } : { database };
    this.outboxRepository = new SqliteBoardOutboxRepository(outboxOptions);
  }

  static open(
    options: OpenSqliteBoardStoreWithOutboxRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithOutboxRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithOutboxRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    this.outboxRepository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

// =====================================================================
// Board task comment repository (SQLite provider).
// =====================================================================

const BOARD_COMMENT_ACTOR_KINDS = ["human", "agent", "system", "automation"] as const;

interface BoardTaskCommentRow {
  readonly comment_id: number;
  readonly task_id: string;
  readonly actor_json: string;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const BOARD_COMMENT_STATEMENTS = {
  selectById: `SELECT comment_id, task_id, actor_json, body, created_at, updated_at
               FROM board_task_comments WHERE comment_id = ?`,
  selectByTask: `SELECT comment_id, task_id, actor_json, body, created_at, updated_at
                  FROM board_task_comments
                  WHERE task_id = ?
                  ORDER BY created_at ASC, comment_id ASC`,
  insert: `INSERT INTO board_task_comments (task_id, actor_json, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
  update: `UPDATE board_task_comments SET actor_json = ?, body = ?, updated_at = ?
           WHERE comment_id = ?`,
  delete: `DELETE FROM board_task_comments WHERE comment_id = ?`
} as const;

function assertValidCommentBody(body: string): void {
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("Board task comment body must be a non-empty string.");
  }
  if (body.length > BOARD_TASK_COMMENT_BODY_MAX_LENGTH) {
    throw new Error(
      "Board task comment body must be " + BOARD_TASK_COMMENT_BODY_MAX_LENGTH + " characters or fewer."
    );
  }
}

function assertValidCommentActor(actor: BoardTaskCommentActor, fieldName: string): void {
  if (!actor || typeof actor !== "object") {
    throw new Error("Board task comment " + fieldName + " must be an object.");
  }
  if (typeof actor.id !== "string" || actor.id.length === 0) {
    throw new Error("Board task comment " + fieldName + ".id must be a non-empty string.");
  }
  if (
    actor.displayName !== undefined &&
    (typeof actor.displayName !== "string" || actor.displayName.length === 0)
  ) {
    throw new Error(
      "Board task comment " + fieldName + ".displayName must be a non-empty string when provided."
    );
  }
  if (
    actor.kind !== undefined &&
    !(BOARD_COMMENT_ACTOR_KINDS as readonly string[]).includes(actor.kind)
  ) {
    throw new Error(
      "Board task comment " +
        fieldName +
        ".kind must be one of " +
        BOARD_COMMENT_ACTOR_KINDS.join(", ") +
        ", received " +
        JSON.stringify(actor.kind) +
        "."
    );
  }
}

function commentActorToJson(actor: BoardTaskCommentActor): string {
  return JSON.stringify(actor);
}

function commentActorFromJson(raw: string, fieldName: string): BoardTaskCommentActor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Board task comment " + fieldName + " JSON is invalid: " + message);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Board task comment " + fieldName + " JSON must decode to an object.");
  }
  const candidate = parsed as Partial<BoardTaskCommentActor>;
  const displayName =
    typeof candidate.displayName === "string" && candidate.displayName.length > 0
      ? candidate.displayName
      : undefined;
  const kind =
    typeof candidate.kind === "string" &&
    (BOARD_COMMENT_ACTOR_KINDS as readonly string[]).includes(candidate.kind)
      ? (candidate.kind as BoardTaskCommentActor["kind"])
      : undefined;
  const actor = {
    id: typeof candidate.id === "string" ? candidate.id : "",
    ...(displayName !== undefined ? { displayName } : {}),
    ...(kind !== undefined ? { kind } : {})
  } as BoardTaskCommentActor;
  assertValidCommentActor(actor, fieldName);
  return actor;
}

function rowToBoardTaskComment(row: BoardTaskCommentRow): BoardTaskComment {
  return {
    commentId: row.comment_id,
    taskId: row.task_id as BoardTaskComment["taskId"],
    actor: commentActorFromJson(row.actor_json, "actor"),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadCommentRow(database: DatabaseSync, commentId: number): BoardTaskCommentRow | undefined {
  return database.prepare(BOARD_COMMENT_STATEMENTS.selectById).get(commentId) as
    | BoardTaskCommentRow
    | undefined;
}

interface SqliteBoardTaskCommentRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

export class SqliteBoardTaskCommentRepository implements BoardTaskCommentRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardTaskCommentRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  createComment(input: CreateBoardTaskCommentInput): BoardTaskComment {
    assertValidCommentActor(input.actor, "actor");
    assertValidCommentBody(input.body);
    const taskId = String(input.taskId);
    const now = this.#now();
    const createdAt = input.createdAt ?? now;
    assertValidIsoTimestamp(createdAt, "createdAt");
    const actorJson = commentActorToJson(input.actor);

    return runImmediateTransaction(this.#database, () => {
      const task = loadBoardTaskRow(this.#database, taskId);
      if (!task) {
        throw new BoardTaskNotFoundError(input.taskId);
      }
      const result = this.#database
        .prepare(BOARD_COMMENT_STATEMENTS.insert)
        .run(taskId, actorJson, input.body, createdAt, createdAt);
      const commentId = Number(result.lastInsertRowid);
      const row = loadCommentRow(this.#database, commentId);
      if (!row) {
        throw new Error("Board task comment was not persisted after insert.");
      }
      return rowToBoardTaskComment(row);
    });
  }

  getComment(commentId: number): BoardTaskComment | null {
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error("Board task comment id must be a positive integer.");
    }
    const row = loadCommentRow(this.#database, commentId);
    return row ? rowToBoardTaskComment(row) : null;
  }

  listComments(query: ListBoardTaskCommentsQuery = {}): readonly BoardTaskComment[] {
    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board task comment list limit must be a positive integer.");
    }

    if (query.taskId) {
      const taskId = String(query.taskId);
      const task = loadBoardTaskRow(this.#database, taskId);
      if (!task) {
        throw new BoardTaskNotFoundError(query.taskId);
      }
      const rows = this.#database
        .prepare(BOARD_COMMENT_STATEMENTS.selectByTask + " LIMIT " + limit)
        .all(taskId) as unknown as BoardTaskCommentRow[];
      return rows.map(rowToBoardTaskComment);
    }

    const rows = this.#database
      .prepare(
        "SELECT comment_id, task_id, actor_json, body, created_at, updated_at " +
          "FROM board_task_comments ORDER BY created_at ASC, comment_id ASC LIMIT " +
          limit
      )
      .all() as unknown as BoardTaskCommentRow[];
    return rows.map(rowToBoardTaskComment);
  }

  updateComment(commentId: number, input: UpdateBoardTaskCommentInput): BoardTaskComment {
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error("Board task comment id must be a positive integer.");
    }
    if (input.body !== undefined) {
      assertValidCommentBody(input.body);
    }
    if (input.actor !== undefined) {
      assertValidCommentActor(input.actor, "actor");
    }

    return runImmediateTransaction(this.#database, () => {
      const row = loadCommentRow(this.#database, commentId);
      if (!row) {
        throw new BoardTaskCommentNotFoundError(commentId);
      }
      const actorJson = input.actor !== undefined ? commentActorToJson(input.actor) : row.actor_json;
      const body = input.body !== undefined ? input.body : row.body;
      const updatedAt = input.updatedAt ?? this.#now();
      assertValidIsoTimestamp(updatedAt, "updatedAt");
      const result = this.#database
        .prepare(BOARD_COMMENT_STATEMENTS.update)
        .run(actorJson, body, updatedAt, commentId);
      if (result.changes !== 1) {
        throw new BoardTaskCommentNotFoundError(commentId);
      }
      const reloaded = loadCommentRow(this.#database, commentId);
      if (!reloaded) {
        throw new BoardTaskCommentNotFoundError(commentId);
      }
      return rowToBoardTaskComment(reloaded);
    });
  }

  deleteComment(commentId: number): void {
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error("Board task comment id must be a positive integer.");
    }
    runImmediateTransaction(this.#database, () => {
      const row = loadCommentRow(this.#database, commentId);
      if (!row) {
        throw new BoardTaskCommentNotFoundError(commentId);
      }
      const result = this.#database.prepare(BOARD_COMMENT_STATEMENTS.delete).run(commentId);
      if (result.changes !== 1) {
        throw new BoardTaskCommentNotFoundError(commentId);
      }
    });
  }
}

export function openSqliteBoardTaskCommentRepository(
  options: SqliteBoardTaskCommentRepositoryOptions
): SqliteBoardTaskCommentRepository {
  return new SqliteBoardTaskCommentRepository(options);
}

export interface OpenSqliteBoardStoreWithCommentRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithCommentRepository implements BoardStore {
  readonly databasePath: string;
  readonly commentRepository: SqliteBoardTaskCommentRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const commentOptions: SqliteBoardTaskCommentRepositoryOptions = options.now
      ? { database, now: options.now }
      : { database };
    this.commentRepository = new SqliteBoardTaskCommentRepository(commentOptions);
  }

  static open(
    options: OpenSqliteBoardStoreWithCommentRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithCommentRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithCommentRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    this.commentRepository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

// =====================================================================
// =====================================================================
// P03-T03: Board event append + projection rebuild (SQLite provider).
// =====================================================================

interface BoardEventRow {
  readonly event_id: string;
  readonly aggregate_kind: string;
  readonly aggregate_id: string;
  readonly aggregate_sequence: number;
  readonly global_sequence: number;
  readonly event_type: string;
  readonly event_version: string;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly causation_id: string | null;
  readonly correlation_id: string | null;
  readonly occurred_at: string;
}

interface BoardProjectionRow {
  readonly projection_key: string;
  readonly projection_version: number;
  readonly rebuilt_through_global_sequence: number;
  readonly state_hash: string;
  readonly state_json: string;
  readonly updated_at: string;
}

interface BoardIdempotencyRow {
  readonly scope: string;
  readonly idempotency_key: string;
  readonly result_hash: string;
  readonly result_json: string;
  readonly created_at: string;
}

const BOARD_EVENT_IDEMPOTENCY_SCOPE = "board.event.append";

export interface SqliteBoardEventRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

const BOARD_EVENT_AGGREGATE_KIND_SET: ReadonlySet<BoardEventAggregateKind> = new Set(
  BOARD_EVENT_AGGREGATE_KINDS as readonly BoardEventAggregateKind[]
);

const BOARD_EVENT_TYPE_SET: ReadonlySet<BoardEventType> = new Set(
  BOARD_EVENT_TYPES as readonly BoardEventType[]
);

const BOARD_EVENT_STATEMENTS = {
  insert:
    "INSERT INTO board_task_events (event_id, aggregate_kind, aggregate_id, aggregate_sequence, global_sequence, event_type, event_version, payload_json, payload_hash, causation_id, correlation_id, occurred_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  selectById:
    "SELECT event_id, aggregate_kind, aggregate_id, aggregate_sequence, global_sequence, event_type, event_version, payload_json, payload_hash, causation_id, correlation_id, occurred_at " +
    "FROM board_task_events WHERE event_id = ?",
  selectMaxAggregateSequence:
    "SELECT COALESCE(MAX(aggregate_sequence), -1) AS next FROM board_task_events " +
    "WHERE aggregate_kind = ? AND aggregate_id = ?",
  selectMaxGlobalSequence:
    "SELECT COALESCE(MAX(global_sequence), -1) AS next FROM board_task_events",
  selectIdempotency:
    "SELECT scope, idempotency_key, result_hash, result_json, created_at FROM board_idempotency_records " +
    "WHERE scope = ? AND idempotency_key = ?",
  insertIdempotency:
    "INSERT INTO board_idempotency_records (scope, idempotency_key, result_hash, result_json, created_at) " +
    "VALUES (?, ?, ?, ?, ?)"
} as const;

function assertValidAggregateKind(kind: string): asserts kind is BoardEventAggregateKind {
  if (!BOARD_EVENT_AGGREGATE_KIND_SET.has(kind as BoardEventAggregateKind)) {
    throw new BoardEventAppendError("Unknown board event aggregate kind: " + kind + ".", {
      cause: "aggregate_sequence_conflict"
    });
  }
}

function assertValidEventType(eventType: string): asserts eventType is BoardEventType {
  if (!BOARD_EVENT_TYPE_SET.has(eventType as BoardEventType)) {
    throw new BoardEventAppendError("Unknown board event type: " + eventType + ".", {
      cause: "aggregate_sequence_conflict"
    });
  }
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalizeJson(v ?? null)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalizeJson(raw));
  }
  return "{" + parts.join(",") + "}";
}

function canonicalStateHash(state: BoardProjectionState): string {
  return createHash("sha256").update(canonicalizeJson(state)).digest("hex");
}

function payloadHashOf(payload: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalizeJson(payload)).digest("hex");
}

function rowToBoardEvent(row: BoardEventRow, idempotencyKey: string | null = null): BoardEvent {
  assertValidAggregateKind(row.aggregate_kind);
  assertValidEventType(row.event_type);
  let parsedPayload: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Board event payload must be a JSON object.");
    }
    parsedPayload = parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Failed to parse board event payload_json: " + message);
  }
  return {
    schemaVersion: BOARD_EVENT_SCHEMA_VERSION,
    eventId: row.event_id as BoardEvent["eventId"],
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    aggregateSequence: row.aggregate_sequence,
    globalSequence: row.global_sequence,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: parsedPayload,
    payloadHash: row.payload_hash,
    causationId: row.causation_id as BoardEvent["causationId"],
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    idempotencyKey,
    payloadJson: row.payload_json
  };
}

interface StoredEventCursor {
  readonly eventId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly globalSequence: number;
  readonly payloadHash: string;
}

function rowToStoredCursor(row: BoardEventRow): StoredEventCursor {
  return {
    eventId: row.event_id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    aggregateSequence: row.aggregate_sequence,
    globalSequence: row.global_sequence,
    payloadHash: row.payload_hash
  };
}

function generateEventId(): EventId {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const hex = randomBytes(16).toString("hex");
  let out = "";
  for (let i = 0; i < hex.length && out.length < 26; i++) {
    const ch = hex[i];
    if (ch === undefined) continue;
    const code = ch.charCodeAt(0);
    const slot = ((code + i) & 0x1f) % 32;
    out += alphabet[slot] ?? "0";
  }
  while (out.length < 26) {
    out += alphabet[out.length % 32] ?? "0";
  }
  return ("evt_" + out.slice(0, 26)) as EventId;
}

export class SqliteBoardEventRepository implements BoardEventRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardEventRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  appendEvent(input: AppendBoardEventInput): BoardEventAppendResult {
    return { event: this.#appendOne(input) };
  }

  /**
   * Append a single event assuming the caller has already started a SQLite
   * transaction on the same database handle. This is used by repositories
   * that want to emit board_task_events atomically with their own mutation.
   */
  appendEventInTransaction(input: AppendBoardEventInput): BoardEvent {
    return this.#appendOneInTransaction(input);
  }

  appendEvents(input: AppendBoardEventsInput): BoardEventAppendBatchResult {
    if (input.events.length === 0) {
      return { events: [] };
    }
    return runImmediateTransaction(this.#database, () => {
      const events: BoardEvent[] = [];
      for (const entry of input.events) {
        events.push(this.#appendOneInTransaction(entry));
      }
      return { events };
    });
  }

  listEvents(query: BoardEventQuery = {}): readonly BoardEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.aggregateKind) {
      assertValidAggregateKind(query.aggregateKind);
      where.push("aggregate_kind = ?");
      params.push(query.aggregateKind);
    }
    if (query.aggregateId) {
      where.push("aggregate_id = ?");
      params.push(query.aggregateId);
    }
    if (query.eventType) {
      assertValidEventType(query.eventType);
      where.push("event_type = ?");
      params.push(query.eventType);
    }
    if (typeof query.fromGlobalSequence === "number") {
      if (!Number.isInteger(query.fromGlobalSequence) || query.fromGlobalSequence < 0) {
        throw new Error("Board event fromGlobalSequence must be a non-negative integer.");
      }
      where.push("global_sequence >= ?");
      params.push(query.fromGlobalSequence);
    }
    if (typeof query.untilGlobalSequence === "number") {
      if (!Number.isInteger(query.untilGlobalSequence) || query.untilGlobalSequence < 0) {
        throw new Error("Board event untilGlobalSequence must be a non-negative integer.");
      }
      where.push("global_sequence <= ?");
      params.push(query.untilGlobalSequence);
    }

    const order = query.order ?? "asc";
    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board event list limit must be a positive integer.");
    }

    const sql =
      "SELECT event_id, aggregate_kind, aggregate_id, aggregate_sequence, global_sequence, event_type, event_version, payload_json, payload_hash, causation_id, correlation_id, occurred_at " +
      "FROM board_task_events" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY global_sequence " + (order === "desc" ? "DESC" : "ASC") +
      " LIMIT " + limit;

    const rows = this.#database.prepare(sql).all(...params) as unknown as BoardEventRow[];
    return rows.map((row) => rowToBoardEvent(row));
  }

  getEvent(eventId: EventId): BoardEvent | null {
    const row = this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectById)
      .get(String(eventId)) as BoardEventRow | undefined;
    if (!row) return null;
    const idem = this.#database
      .prepare(
        "SELECT idempotency_key FROM board_idempotency_records " +
          "WHERE scope = ? AND result_json LIKE ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(BOARD_EVENT_IDEMPOTENCY_SCOPE, "%" + String(eventId) + "%") as
      | { idempotency_key: string }
      | undefined;
    const idempotencyKey = idem?.idempotency_key ?? null;
    return rowToBoardEvent(row, idempotencyKey);
  }

  getEventByIdempotencyKey(idempotencyKey: string): BoardEvent | null {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new Error("Board event idempotencyKey must be a non-empty string.");
    }
    const record = this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectIdempotency)
      .get(BOARD_EVENT_IDEMPOTENCY_SCOPE, idempotencyKey) as BoardIdempotencyRow | undefined;
    if (!record) return null;
    try {
      const cursor = JSON.parse(record.result_json) as StoredEventCursor;
      const eventRow = this.#database
        .prepare(BOARD_EVENT_STATEMENTS.selectById)
        .get(cursor.eventId) as BoardEventRow | undefined;
      if (!eventRow) return null;
      return rowToBoardEvent(eventRow, idempotencyKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error("Failed to deserialize board event idempotency record: " + message);
    }
  }

  countEvents(query: BoardEventQuery = {}): number {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.aggregateKind) {
      assertValidAggregateKind(query.aggregateKind);
      where.push("aggregate_kind = ?");
      params.push(query.aggregateKind);
    }
    if (query.aggregateId) {
      where.push("aggregate_id = ?");
      params.push(query.aggregateId);
    }
    if (query.eventType) {
      assertValidEventType(query.eventType);
      where.push("event_type = ?");
      params.push(query.eventType);
    }
    if (typeof query.fromGlobalSequence === "number") {
      where.push("global_sequence >= ?");
      params.push(query.fromGlobalSequence);
    }
    if (typeof query.untilGlobalSequence === "number") {
      where.push("global_sequence <= ?");
      params.push(query.untilGlobalSequence);
    }

    const sql =
      "SELECT COUNT(*) AS count FROM board_task_events" +
      (where.length ? " WHERE " + where.join(" AND ") : "");
    const row = this.#database.prepare(sql).get(...params) as { count: number };
    return Number(row.count);
  }

  tail(limit: number): readonly BoardEvent[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board event tail limit must be a positive integer.");
    }
    const rows = this.#database
      .prepare(
        "SELECT event_id, aggregate_kind, aggregate_id, aggregate_sequence, global_sequence, event_type, event_version, payload_json, payload_hash, causation_id, correlation_id, occurred_at " +
          "FROM board_task_events ORDER BY global_sequence DESC LIMIT " +
          limit
      )
      .all() as unknown as BoardEventRow[];
    return rows.map((row) => rowToBoardEvent(row));
  }

  #appendOne(input: AppendBoardEventInput): BoardEvent {
    return runImmediateTransaction(this.#database, () => this.#appendOneInTransaction(input));
  }

  #appendOneInTransaction(input: AppendBoardEventInput): BoardEvent {
    assertValidAggregateKind(input.aggregateKind);
    assertValidEventType(input.eventType);
    if (typeof input.aggregateId !== "string" || input.aggregateId.length === 0) {
      throw new Error("Board event aggregateId must be a non-empty string.");
    }
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new Error("Board event payload must be a JSON object.");
    }
    const eventVersion = input.eventVersion ?? BOARD_EVENT_SCHEMA_VERSION;
    if (typeof eventVersion !== "string" || eventVersion.length === 0) {
      throw new Error("Board event eventVersion must be a non-empty string.");
    }
    const occurredAt = input.occurredAt ?? this.#now();
    if (typeof occurredAt !== "string" || Number.isNaN(new Date(occurredAt).getTime())) {
      throw new Error("Board event occurredAt must be a valid ISO-8601 timestamp.");
    }
    const payloadHash = payloadHashOf(input.payload);
    const idempotencyKey = input.idempotencyKey ?? null;
    const causationId = input.causationId ? String(input.causationId) : null;
    const correlationId = input.correlationId ?? null;
    const eventId = input.eventId ? String(input.eventId) : generateEventId();

    const existingById = this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectById)
      .get(eventId) as BoardEventRow | undefined;
    if (existingById) {
      throw new BoardEventAppendError("Board event " + eventId + " already exists.", {
        eventId: existingById.event_id as EventId,
        cause: "duplicate_event_id"
      });
    }

    if (idempotencyKey) {
      const existingIdem = this.#database
        .prepare(BOARD_EVENT_STATEMENTS.selectIdempotency)
        .get(BOARD_EVENT_IDEMPOTENCY_SCOPE, idempotencyKey) as BoardIdempotencyRow | undefined;
      if (existingIdem) {
        try {
          const cursor = JSON.parse(existingIdem.result_json) as StoredEventCursor;
          if (cursor.payloadHash !== payloadHash) {
            throw new BoardEventAppendError(
              "Board event idempotencyKey " +
                idempotencyKey +
                " replayed with a different payload hash.",
              {
                idempotencyKey,
                cause: "payload_hash_mismatch",
                actual: cursor.globalSequence
              }
            );
          }
          const eventRow = this.#database
            .prepare(BOARD_EVENT_STATEMENTS.selectById)
            .get(cursor.eventId) as BoardEventRow | undefined;
          if (eventRow) {
            return rowToBoardEvent(eventRow, idempotencyKey);
          }
        } catch (error) {
          if (error instanceof BoardEventAppendError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error("Failed to deserialize board event idempotency record: " + message);
        }
      }
    }

    const nextAggregate = (this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectMaxAggregateSequence)
      .get(input.aggregateKind, input.aggregateId) as { next: number }).next + 1;
    if (
      typeof input.expectedAggregateSequence === "number" &&
      input.expectedAggregateSequence !== nextAggregate
    ) {
      throw new BoardEventAppendError(
        "Board event aggregate sequence conflict for " +
          input.aggregateKind +
          ":" +
          input.aggregateId +
          ": expected " +
          input.expectedAggregateSequence +
          " but next is " +
          nextAggregate +
          ".",
        {
          cause: "aggregate_sequence_conflict",
          expected: input.expectedAggregateSequence,
          actual: nextAggregate
        }
      );
    }

    const nextGlobal = (this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectMaxGlobalSequence)
      .get() as { next: number }).next + 1;
    if (
      typeof input.expectedGlobalSequence === "number" &&
      input.expectedGlobalSequence !== nextGlobal
    ) {
      throw new BoardEventAppendError(
        "Board event global sequence conflict: expected " +
          input.expectedGlobalSequence +
          " but next is " +
          nextGlobal +
          ".",
        {
          cause: "global_sequence_conflict",
          expected: input.expectedGlobalSequence,
          actual: nextGlobal
        }
      );
    }

    const result = this.#database
      .prepare(BOARD_EVENT_STATEMENTS.insert)
      .run(
        eventId,
        input.aggregateKind,
        input.aggregateId,
        nextAggregate,
        nextGlobal,
        input.eventType,
        eventVersion,
        JSON.stringify(input.payload),
        payloadHash,
        causationId,
        correlationId,
        occurredAt
      );
    if (result.changes !== 1) {
      throw new Error(
        "Board event " + eventId + " was not persisted (changes=" + result.changes + ")."
      );
    }

    const inserted = this.#database
      .prepare(BOARD_EVENT_STATEMENTS.selectById)
      .get(eventId) as BoardEventRow | undefined;
    if (!inserted) {
      throw new Error("Board event " + eventId + " was not persisted after insert.");
    }

    if (idempotencyKey) {
      const cursor: StoredEventCursor = rowToStoredCursor(inserted);
      const resultJson = JSON.stringify(cursor);
      const resultHash = createHash("sha256").update(resultJson).digest("hex");
      this.#database
        .prepare(BOARD_EVENT_STATEMENTS.insertIdempotency)
        .run(
          BOARD_EVENT_IDEMPOTENCY_SCOPE,
          idempotencyKey,
          resultHash,
          resultJson,
          occurredAt
        );
    }

    return rowToBoardEvent(inserted, idempotencyKey);
  }
}

export function openSqliteBoardEventRepository(
  options: SqliteBoardEventRepositoryOptions
): SqliteBoardEventRepository {
  return new SqliteBoardEventRepository(options);
}

// =====================================================================
// Projection repository
// =====================================================================

export interface SqliteBoardProjectionRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

const BOARD_PROJECTION_STATEMENTS = {
  insert:
    "INSERT INTO board_projections (projection_key, projection_version, rebuilt_through_global_sequence, state_hash, state_json, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?)",
  update:
    "UPDATE board_projections SET projection_version = ?, rebuilt_through_global_sequence = ?, state_hash = ?, state_json = ?, updated_at = ? " +
    "WHERE projection_key = ? AND projection_version = ?",
  selectByKey:
    "SELECT projection_key, projection_version, rebuilt_through_global_sequence, state_hash, state_json, updated_at " +
    "FROM board_projections WHERE projection_key = ?",
  selectStale:
    "SELECT projection_key, projection_version, rebuilt_through_global_sequence, state_hash, state_json, updated_at " +
    "FROM board_projections WHERE rebuilt_through_global_sequence < ? ORDER BY projection_key",
  deleteByKeyAndVersion: "DELETE FROM board_projections WHERE projection_key = ? AND projection_version = ?"
} as const;

function assertValidProjectionKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > BOARD_PROJECTION_KEY_MAX_LENGTH) {
    throw new Error(
      "Board projection key must be 1.." +
        BOARD_PROJECTION_KEY_MAX_LENGTH +
        " characters, received length " +
        String(key?.length) +
        "."
    );
  }
  if (!BOARD_PROJECTION_KEY_PATTERN.test(key)) {
    throw new Error("Board projection key " + key + " does not match the required slug pattern.");
  }
}

function rowToBoardProjection(row: BoardProjectionRow): BoardProjectionRecord {
  let parsedState: BoardProjectionState;
  try {
    const parsed = JSON.parse(row.state_json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Board projection state must be a JSON object.");
    }
    parsedState = parsed as BoardProjectionState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Failed to parse board projection state_json: " + message);
  }
  return {
    projectionKey: row.projection_key,
    projectionVersion: row.projection_version,
    rebuiltThroughGlobalSequence: row.rebuilt_through_global_sequence,
    stateHash: row.state_hash,
    state: parsedState,
    updatedAt: row.updated_at
  };
}

export class SqliteBoardProjectionRepository implements BoardProjectionRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardProjectionRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  saveProjection(input: SaveBoardProjectionInput): BoardProjectionRecord {
    assertValidProjectionKey(input.projectionKey);
    if (!Number.isInteger(input.projectionVersion) || input.projectionVersion < 1) {
      throw new Error("Board projection version must be a positive integer.");
    }
    if (
      !Number.isInteger(input.rebuiltThroughGlobalSequence) ||
      input.rebuiltThroughGlobalSequence < 0
    ) {
      throw new Error("Board projection rebuiltThroughGlobalSequence must be a non-negative integer.");
    }
    if (typeof input.state !== "object" || input.state === null || Array.isArray(input.state)) {
      throw new Error("Board projection state must be a JSON object.");
    }

    const now = input.updatedAt ?? this.#now();
    if (typeof now !== "string" || Number.isNaN(new Date(now).getTime())) {
      throw new Error("Board projection updatedAt must be a valid ISO-8601 timestamp.");
    }
    const stateHash = input.stateHash ?? canonicalStateHash(input.state);
    if (stateHash.length !== 64 || !/^[0-9a-f]{64}$/.test(stateHash)) {
      throw new Error("Board projection stateHash must be a 64-character SHA-256 hex string.");
    }
    const stateJson = canonicalizeJson(input.state);

    return runImmediateTransaction(this.#database, () => {
      const existing = this.#database
        .prepare(BOARD_PROJECTION_STATEMENTS.selectByKey)
        .get(input.projectionKey) as BoardProjectionRow | undefined;
      if (!existing) {
        const result = this.#database
          .prepare(BOARD_PROJECTION_STATEMENTS.insert)
          .run(
            input.projectionKey,
            input.projectionVersion,
            input.rebuiltThroughGlobalSequence,
            stateHash,
            stateJson,
            now
          );
        if (result.changes !== 1) {
          throw new Error(
            "Board projection " +
              input.projectionKey +
              " was not inserted (changes=" +
              result.changes +
              ")."
          );
        }
      } else {
        const expectedVersion =
          input.expectedProjectionVersion ?? existing.projection_version;
        if (expectedVersion !== existing.projection_version) {
          throw new BoardProjectionDriftError({
            projectionKey: input.projectionKey,
            savedRebuiltThrough: existing.rebuilt_through_global_sequence,
            actualRebuiltThrough: input.rebuiltThroughGlobalSequence,
            savedStateHash: existing.state_hash,
            actualStateHash: stateHash
          });
        }
        const result = this.#database
          .prepare(BOARD_PROJECTION_STATEMENTS.update)
          .run(
            input.projectionVersion,
            input.rebuiltThroughGlobalSequence,
            stateHash,
            stateJson,
            now,
            input.projectionKey,
            expectedVersion
          );
        if (result.changes !== 1) {
          const reloaded = this.#database
            .prepare(BOARD_PROJECTION_STATEMENTS.selectByKey)
            .get(input.projectionKey) as BoardProjectionRow | undefined;
          throw new BoardProjectionDriftError({
            projectionKey: input.projectionKey,
            savedRebuiltThrough: reloaded?.rebuilt_through_global_sequence ?? -1,
            actualRebuiltThrough: input.rebuiltThroughGlobalSequence,
            savedStateHash: reloaded?.state_hash ?? "",
            actualStateHash: stateHash
          });
        }
      }
      const reloaded = this.#database
        .prepare(BOARD_PROJECTION_STATEMENTS.selectByKey)
        .get(input.projectionKey) as BoardProjectionRow | undefined;
      if (!reloaded) {
        throw new Error("Board projection " + input.projectionKey + " vanished after save.");
      }
      return rowToBoardProjection(reloaded);
    });
  }

  loadProjection(projectionKey: string): BoardProjectionRecord | null {
    assertValidProjectionKey(projectionKey);
    const row = this.#database
      .prepare(BOARD_PROJECTION_STATEMENTS.selectByKey)
      .get(projectionKey) as BoardProjectionRow | undefined;
    return row ? rowToBoardProjection(row) : null;
  }

  deleteProjection(projectionKey: string, expectedProjectionVersion?: number): boolean {
    assertValidProjectionKey(projectionKey);
    if (
      typeof expectedProjectionVersion !== "undefined" &&
      (!Number.isInteger(expectedProjectionVersion) || expectedProjectionVersion < 1)
    ) {
      throw new Error("Board projection expectedProjectionVersion must be a positive integer.");
    }
    return runImmediateTransaction(this.#database, () => {
      const existing = this.#database
        .prepare(BOARD_PROJECTION_STATEMENTS.selectByKey)
        .get(projectionKey) as BoardProjectionRow | undefined;
      if (!existing) return false;
      if (
        typeof expectedProjectionVersion === "number" &&
        expectedProjectionVersion !== existing.projection_version
      ) {
        throw new BoardProjectionDriftError({
          projectionKey,
          savedRebuiltThrough: existing.rebuilt_through_global_sequence,
          actualRebuiltThrough: existing.rebuilt_through_global_sequence,
          savedStateHash: existing.state_hash,
          actualStateHash: existing.state_hash
        });
      }
      const result = this.#database
        .prepare(BOARD_PROJECTION_STATEMENTS.deleteByKeyAndVersion)
        .run(projectionKey, existing.projection_version);
      return result.changes === 1;
    });
  }

  listStaleProjections(belowGlobalSequence: number): readonly BoardProjectionRecord[] {
    if (!Number.isInteger(belowGlobalSequence) || belowGlobalSequence < 0) {
      throw new Error("Board projection listStaleProjections threshold must be a non-negative integer.");
    }
    const rows = this.#database
      .prepare(BOARD_PROJECTION_STATEMENTS.selectStale)
      .all(belowGlobalSequence) as unknown as BoardProjectionRow[];
    return rows.map(rowToBoardProjection);
  }
}

export function openSqliteBoardProjectionRepository(
  options: SqliteBoardProjectionRepositoryOptions
): SqliteBoardProjectionRepository {
  return new SqliteBoardProjectionRepository(options);
}

// =====================================================================
// Projection rebuilder (reducer-driven).
// =====================================================================

export type BoardProjectionReducer<S extends BoardProjectionState = BoardProjectionState> = (
  state: S,
  event: BoardEvent
) => S;

export interface SqliteBoardProjectionRebuilderOptions<S extends BoardProjectionState = BoardProjectionState> {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: S;
  readonly reduce: BoardProjectionReducer<S>;
  readonly eventRepository: BoardEventRepository;
  readonly projectionRepository: BoardProjectionRepository;
  readonly now?: () => string;
}

export class SqliteBoardProjectionRebuilder<S extends BoardProjectionState = BoardProjectionState> {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly #initialState: S;
  readonly #reduce: BoardProjectionReducer<S>;
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #now: () => string;

  constructor(options: SqliteBoardProjectionRebuilderOptions<S>) {
    assertValidProjectionKey(options.projectionKey);
    if (!Number.isInteger(options.projectionVersion) || options.projectionVersion < 1) {
      throw new Error("Board projection version must be a positive integer.");
    }
    if (typeof options.initialState !== "object" || options.initialState === null || Array.isArray(options.initialState)) {
      throw new Error("Board projection initialState must be a JSON object.");
    }
    this.projectionKey = options.projectionKey;
    this.projectionVersion = options.projectionVersion;
    this.#initialState = options.initialState;
    this.#reduce = options.reduce;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#now = options.now ?? UTC_NOW;
  }

  replay(input: { readonly throughGlobalSequence?: number } = {}): BoardProjectionRebuildReport & {
    readonly state: S;
  } {
    const until = input.throughGlobalSequence;
    if (typeof until !== "undefined" && (!Number.isInteger(until) || until < 0)) {
      throw new Error("Board projection replay throughGlobalSequence must be a non-negative integer.");
    }
    const events = this.#eventRepository.listEvents({
      ...(typeof until === "number" ? { untilGlobalSequence: until } : {}),
      order: "asc"
    });
    let state: S = this.#initialState;
    let lastSequence = -1;
    for (const event of events) {
      state = this.#reduce(state, event);
      lastSequence = event.globalSequence;
    }
    return {
      projectionKey: this.projectionKey,
      projectionVersion: this.projectionVersion,
      rebuiltThroughGlobalSequence: lastSequence,
      eventCount: events.length,
      state,
      stateHash: canonicalStateHash(state),
      rebuiltAt: this.#now()
    };
  }

  rebuildAndSave(input: { readonly throughGlobalSequence?: number; readonly expectedProjectionVersion?: number } = {}): BoardProjectionRebuildReport & {
    readonly state: S;
  } {
    const report = this.replay(input);
    this.#projectionRepository.saveProjection({
      projectionKey: this.projectionKey,
      projectionVersion: this.projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      ...(typeof input.expectedProjectionVersion === "number"
        ? { expectedProjectionVersion: input.expectedProjectionVersion }
        : {}),
      updatedAt: report.rebuiltAt
    });
    return report;
  }

  verify(input: { readonly throughGlobalSequence?: number } = {}): BoardProjectionRebuildReport & {
    readonly state: S;
  } {
    const saved = this.#projectionRepository.loadProjection(this.projectionKey);
    if (!saved) {
      throw new Error(
        "Board projection " + this.projectionKey + " has no saved state to verify against."
      );
    }
    const report = this.replay(input);
    if (
      saved.stateHash !== report.stateHash ||
      saved.rebuiltThroughGlobalSequence !== report.rebuiltThroughGlobalSequence
    ) {
      throw new BoardProjectionDriftError({
        projectionKey: this.projectionKey,
        savedRebuiltThrough: saved.rebuiltThroughGlobalSequence,
        actualRebuiltThrough: report.rebuiltThroughGlobalSequence,
        savedStateHash: saved.stateHash,
        actualStateHash: report.stateHash
      });
    }
    return report;
  }
}

// =====================================================================
// Task event projector (optional decorator).
// =====================================================================

export interface SqliteBoardTaskEventProjectorOptions {
  readonly eventRepository: SqliteBoardEventRepository;
  readonly now?: () => string;
  readonly causationId?: string | null;
  readonly correlationId?: string | null;
}

const BOARD_TASK_EVENT_SCHEMA_VERSION = "0.1.0";

function taskToEventPayload(task: BoardTask): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: task.taskId,
    projectId: task.projectId,
    changeId: task.changeId,
    contractId: task.contractId,
    contractRevision: task.contractRevision,
    contractHash: task.contractHash,
    generation: task.generation,
    status: task.status,
    priority: task.priority,
    blocker: task.blocker ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function priorityEventPayload(
  previous: BoardTask,
  current: BoardTask,
  occurredAt: string
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: current.taskId,
    projectId: current.projectId,
    changeId: current.changeId,
    generation: current.generation,
    previousPriority: previous.priority,
    nextPriority: current.priority,
    occurredAt
  };
}

function transitionEventPayload(
  previous: BoardTask,
  current: BoardTask,
  blocker: BoardTaskBlocker | null,
  occurredAt: string
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: current.taskId,
    projectId: current.projectId,
    changeId: current.changeId,
    generation: current.generation,
    previousStatus: previous.status,
    nextStatus: current.status,
    previousGeneration: previous.generation,
    nextGeneration: current.generation,
    blocker,
    occurredAt
  };
}

function bumpEventPayload(
  previous: BoardTask,
  current: BoardTask,
  occurredAt: string
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: current.taskId,
    projectId: current.projectId,
    changeId: current.changeId,
    previousGeneration: previous.generation,
    nextGeneration: current.generation,
    previousContractId: previous.contractId,
    nextContractId: current.contractId,
    previousContractRevision: previous.contractRevision,
    nextContractRevision: current.contractRevision,
    previousContractHash: previous.contractHash,
    nextContractHash: current.contractHash,
    occurredAt
  };
}

function supersedeEventPayload(
  retired: BoardTask,
  successor: BoardTask | null,
  occurredAt: string
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: retired.taskId,
    projectId: retired.projectId,
    changeId: retired.changeId,
    retiredGeneration: retired.generation,
    successorTaskId: successor?.taskId ?? null,
    successorGeneration: successor?.generation ?? null,
    occurredAt
  };
}

function linkEventPayload(
  successor: BoardTask,
  predecessorTaskId: string,
  relation: "supersedes",
  occurredAt: string
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: successor.taskId,
    projectId: successor.projectId,
    changeId: successor.changeId,
    predecessorTaskId,
    relation,
    occurredAt
  };
}

function deleteEventPayload(task: BoardTask, occurredAt: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
    taskId: task.taskId,
    projectId: task.projectId,
    changeId: task.changeId,
    generation: task.generation,
    occurredAt
  };
}

export interface CreateBoardTaskEventHookOptions {
  readonly causationId?: string | null;
  readonly correlationId?: string | null;
}

/**
 * Build a default `BoardTaskEventHook` that turns every repository mutation
 * into the standard `task.*` event inputs. The repository is responsible for
 * appending these inputs inside the same SQLite transaction as the mutation.
 */
export function createBoardTaskEventHook(
  options: CreateBoardTaskEventHookOptions = {}
): BoardTaskEventHook {
  const causationId = options.causationId ?? null;
  const correlationId = options.correlationId ?? null;
  return (context) => {
    const occurredAt = context.occurredAt;
    switch (context.mutation) {
      case "create": {
        if (!context.current) return [];
        return [
          {
            aggregateKind: "task",
            aggregateId: String(context.current.taskId),
            eventType: "task.created",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: taskToEventPayload(context.current),
            occurredAt,
            idempotencyKey: context.idempotencyKey ?? null,
            causationId,
            correlationId
          }
        ];
      }
      case "update_priority": {
        if (!context.previous || !context.current) return [];
        return [
          {
            aggregateKind: "task",
            aggregateId: String(context.current.taskId),
            eventType: "task.priority_changed",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: priorityEventPayload(context.previous, context.current, occurredAt),
            occurredAt,
            causationId,
            correlationId
          }
        ];
      }
      case "transition_status": {
        if (!context.previous || !context.current) return [];
        return [
          {
            aggregateKind: "task",
            aggregateId: String(context.current.taskId),
            eventType: "task.transitioned",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: transitionEventPayload(
              context.previous,
              context.current,
              context.blocker,
              occurredAt
            ),
            occurredAt,
            causationId,
            correlationId
          }
        ];
      }
      case "bump_generation": {
        if (!context.previous || !context.current) return [];
        return [
          {
            aggregateKind: "task",
            aggregateId: String(context.current.taskId),
            eventType: "task.bumped",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: bumpEventPayload(context.previous, context.current, occurredAt),
            occurredAt,
            causationId,
            correlationId
          }
        ];
      }
      case "supersede": {
        if (!context.current) return [];
        const events: AppendBoardEventInput[] = [
          {
            aggregateKind: "task",
            aggregateId: String(context.current.taskId),
            eventType: "task.superseded",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: supersedeEventPayload(context.current, context.successor, occurredAt),
            occurredAt,
            causationId,
            correlationId
          }
        ];
        if (context.successor) {
          events.push({
            aggregateKind: "task_link",
            aggregateId: String(context.successor.taskId),
            eventType: "task.linked",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: linkEventPayload(context.successor, String(context.current.taskId), "supersedes", occurredAt),
            occurredAt,
            causationId,
            correlationId
          });
        }
        return events;
      }
      case "delete": {
        if (!context.previous) return [];
        return [
          {
            aggregateKind: "task",
            aggregateId: String(context.previous.taskId),
            eventType: "task.deleted",
            eventVersion: BOARD_TASK_EVENT_SCHEMA_VERSION,
            payload: deleteEventPayload(context.previous, occurredAt),
            occurredAt,
            causationId,
            correlationId
          }
        ];
      }
      default:
        return [];
    }
  };
}

export class SqliteBoardTaskEventProjector {
  readonly #eventRepository: SqliteBoardEventRepository;
  readonly #now: () => string;
  readonly #causationId: string | null;
  readonly #correlationId: string | null;

  constructor(options: SqliteBoardTaskEventProjectorOptions) {
    this.#eventRepository = options.eventRepository;
    this.#now = options.now ?? UTC_NOW;
    this.#causationId = options.causationId ?? null;
    this.#correlationId = options.correlationId ?? null;
  }

  projectCreate(task: BoardTask, idempotencyKey?: string | null): BoardEvent {
    const occurredAt = this.#now();
    return this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(task.taskId),
      eventType: "task.created",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: taskToEventPayload(task),
      occurredAt,
      idempotencyKey: idempotencyKey ?? null,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
  }

  projectPriorityChange(previous: BoardTask, current: BoardTask): BoardEvent {
    const occurredAt = this.#now();
    return this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(current.taskId),
      eventType: "task.priority_changed",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: priorityEventPayload(previous, current, occurredAt),
      occurredAt,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
  }

  projectTransition(
    previous: BoardTask,
    current: BoardTask,
    blocker: BoardTaskBlocker | null
  ): BoardEvent {
    const occurredAt = this.#now();
    return this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(current.taskId),
      eventType: "task.transitioned",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: transitionEventPayload(previous, current, blocker, occurredAt),
      occurredAt,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
  }

  projectBump(previous: BoardTask, current: BoardTask): BoardEvent {
    const occurredAt = this.#now();
    return this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(current.taskId),
      eventType: "task.bumped",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: bumpEventPayload(previous, current, occurredAt),
      occurredAt,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
  }

  projectSupersede(retired: BoardTask, successor: BoardTask | null): readonly BoardEvent[] {
    const occurredAt = this.#now();
    const supersedeEvent = this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(retired.taskId),
      eventType: "task.superseded",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: supersedeEventPayload(retired, successor, occurredAt),
      occurredAt,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
    if (!successor) {
      return [supersedeEvent];
    }
    const linkEvent = this.#eventRepository.appendEvent({
      aggregateKind: "task_link",
      aggregateId: String(successor.taskId),
      eventType: "task.linked",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: linkEventPayload(successor, String(retired.taskId), "supersedes", occurredAt),
      occurredAt,
      causationId: supersedeEvent.eventId,
      correlationId: this.#correlationId
    }).event;
    return [supersedeEvent, linkEvent];
  }

  projectDelete(task: BoardTask): BoardEvent {
    const occurredAt = this.#now();
    return this.#eventRepository.appendEvent({
      aggregateKind: "task",
      aggregateId: String(task.taskId),
      eventType: "task.deleted",
      eventVersion: BOARD_EVENT_SCHEMA_VERSION,
      payload: deleteEventPayload(task, occurredAt),
      occurredAt,
      causationId: this.#causationId as EventId | null,
      correlationId: this.#correlationId
    }).event;
  }
}

// =====================================================================
// Open-and-compose helpers
// =====================================================================

export interface OpenSqliteBoardStoreWithEventRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithEventRepository implements BoardStore {
  readonly databasePath: string;
  readonly eventRepository: SqliteBoardEventRepository;
  readonly projectionRepository: SqliteBoardProjectionRepository;
  readonly #eventDatabase: DatabaseSync;
  readonly #projectionDatabase: DatabaseSync;
  readonly #store: SqliteBoardStore;
  #closed: boolean;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    this.#eventDatabase = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(this.#eventDatabase);
    this.#projectionDatabase = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(this.#projectionDatabase);
    const eventOptions: SqliteBoardEventRepositoryOptions = options.now
      ? { database: this.#eventDatabase, now: options.now }
      : { database: this.#eventDatabase };
    this.eventRepository = new SqliteBoardEventRepository(eventOptions);
    const projectionOptions: SqliteBoardProjectionRepositoryOptions = options.now
      ? { database: this.#projectionDatabase, now: options.now }
      : { database: this.#projectionDatabase };
    this.projectionRepository = new SqliteBoardProjectionRepository(projectionOptions);
    this.#closed = false;
  }

  static open(
    options: OpenSqliteBoardStoreWithEventRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithEventRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithEventRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.eventRepository.closeDatabase();
    } catch {
      // Best-effort close: ignore errors so sibling handles can still be torn down.
    }
    try {
      this.projectionRepository.closeDatabase();
    } catch {
      // Best-effort close.
    }
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}

// =====================================================================
// P03-T08: SqliteBoardTaskLinkRepository.
//
// Reads and writes the `board_task_links` dependency-edge table. Cycle
// detection and topological ordering operate over the DAG formed by the
// `depends_on` and `blocks` relations; `supersedes` and `relates_to` are
// ignored for ordering and are not allowed to create cycles.
// =====================================================================

interface BoardTaskLinkRow {
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly relation: string;
  readonly created_at: string;
}

const BOARD_TASK_LINK_DAG_RELATION_SET: ReadonlySet<BoardTaskLinkDagRelation> = new Set(
  BOARD_TASK_LINK_DAG_RELATIONS as readonly BoardTaskLinkDagRelation[]
);

function assertValidTaskLinkRelation(relation: string): asserts relation is BoardTaskLinkRelation {
  if (!(BOARD_TASK_LINK_RELATIONS as readonly string[]).includes(relation)) {
    throw new BoardTaskLinkInvalidRelationError(relation);
  }
}

function rowToBoardTaskLink(row: BoardTaskLinkRow): BoardTaskLink {
  const relation = row.relation;
  assertValidTaskLinkRelation(relation);
  return {
    taskId: row.task_id as BoardTaskLink["taskId"],
    dependsOnTaskId: row.depends_on_task_id as BoardTaskLink["dependsOnTaskId"],
    relation,
    createdAt: row.created_at
  };
}

function isDagRelation(relation: BoardTaskLinkRelation): relation is BoardTaskLinkDagRelation {
  return BOARD_TASK_LINK_DAG_RELATION_SET.has(relation as BoardTaskLinkDagRelation);
}

interface SqliteBoardTaskLinkRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => string;
}

export class SqliteBoardTaskLinkRepository implements BoardTaskLinkRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteBoardTaskLinkRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? UTC_NOW;
  }

  closeDatabase(): void {
    this.#database.close();
  }

  addLink(input: CreateBoardTaskLinkInput): BoardTaskLink {
    const taskId = String(input.taskId);
    const dependsOnTaskId = String(input.dependsOnTaskId);
    const relation = input.relation;
    assertValidTaskLinkRelation(relation);

    if (taskId === dependsOnTaskId) {
      throw new BoardTaskLinkSelfLoopError(taskId, relation);
    }

    const createdAt = input.createdAt ?? this.#now();

    return runImmediateTransaction(this.#database, () => {
      const missing = this.#missingEndpoints(taskId, dependsOnTaskId);
      if (missing) {
        throw new BoardTaskLinkEndpointNotFoundError(taskId, dependsOnTaskId, relation, missing);
      }

      if (this.#loadLinkRow(taskId, dependsOnTaskId, relation)) {
        throw new BoardTaskLinkAlreadyExistsError(taskId, dependsOnTaskId, relation);
      }


      if (isDagRelation(relation)) {
        if (this.#wouldCycle(taskId, dependsOnTaskId, relation)) {
          const cycle = this.#findCycleFrom(taskId, dependsOnTaskId, relation) ?? {
            nodes: [taskId, dependsOnTaskId, taskId],
            relations: [relation]
          };
          throw new BoardTaskLinkCycleError({
            attemptedTaskId: taskId,
            attemptedDependsOnTaskId: dependsOnTaskId,
            attemptedRelation: relation,
            cycle
          });
        }
      }

      this.#database
        .prepare(
          "INSERT INTO board_task_links (task_id, depends_on_task_id, relation, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(taskId, dependsOnTaskId, relation, createdAt);

      const row = this.#loadLinkRow(taskId, dependsOnTaskId, relation);
      if (!row) {
        throw new Error("Board task link was not persisted after insert.");
      }
      return rowToBoardTaskLink(row);
    });
  }

  removeLink(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation): BoardTaskLink {
    assertValidTaskLinkRelation(relation);
    const taskIdString = String(taskId);
    const dependsOnTaskIdString = String(dependsOnTaskId);

    return runImmediateTransaction(this.#database, () => {
      const existing = this.#loadLinkRow(taskIdString, dependsOnTaskIdString, relation);
      if (!existing) {
        throw new BoardTaskLinkNotFoundError(taskId, dependsOnTaskId, relation);
      }
      const result = this.#database
        .prepare(
          "DELETE FROM board_task_links WHERE task_id = ? AND depends_on_task_id = ? AND relation = ?"
        )
        .run(taskIdString, dependsOnTaskIdString, relation);
      if (result.changes !== 1) {
        throw new Error("Board task link was not removed.");
      }
      return rowToBoardTaskLink(existing);
    });
  }

  getLink(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation): BoardTaskLink | null {
    assertValidTaskLinkRelation(relation);
    const row = this.#loadLinkRow(String(taskId), String(dependsOnTaskId), relation);
    return row ? rowToBoardTaskLink(row) : null;
  }

  listOutgoingLinks(taskId: TaskId, relation?: BoardTaskLinkRelation): readonly BoardTaskLink[] {
    if (relation !== undefined) assertValidTaskLinkRelation(relation);
    const sql =
      "SELECT task_id, depends_on_task_id, relation, created_at FROM board_task_links " +
      "WHERE task_id = ?" +
      (relation !== undefined ? " AND relation = ?" : "") +
      " ORDER BY depends_on_task_id ASC, relation ASC";
    const rows = this.#database
      .prepare(sql)
      .all(...(relation !== undefined ? [String(taskId), relation] : [String(taskId)])) as unknown as BoardTaskLinkRow[];
    return rows.map(rowToBoardTaskLink);
  }

  listIncomingLinks(taskId: TaskId, relation?: BoardTaskLinkRelation): readonly BoardTaskLink[] {
    if (relation !== undefined) assertValidTaskLinkRelation(relation);
    const sql =
      "SELECT task_id, depends_on_task_id, relation, created_at FROM board_task_links " +
      "WHERE depends_on_task_id = ?" +
      (relation !== undefined ? " AND relation = ?" : "") +
      " ORDER BY task_id ASC, relation ASC";
    const rows = this.#database
      .prepare(sql)
      .all(...(relation !== undefined ? [String(taskId), relation] : [String(taskId)])) as unknown as BoardTaskLinkRow[];
    return rows.map(rowToBoardTaskLink);
  }

  listLinks(query: ListBoardTaskLinksQuery = {}): readonly BoardTaskLink[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.taskId) {
      where.push("task_id = ?");
      params.push(String(query.taskId));
    }
    if (query.dependsOnTaskId) {
      where.push("depends_on_task_id = ?");
      params.push(String(query.dependsOnTaskId));
    }
    if (query.relation !== undefined) {
      const relations = Array.isArray(query.relation) ? query.relation : [query.relation];
      if (relations.length > 0) {
        const placeholders = relations.map(() => "?").join(", ");
        where.push("relation IN (" + placeholders + ")");
        params.push(...relations);
      }
    }
    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Board task link list limit must be a positive integer.");
    }
    const sql =
      "SELECT task_id, depends_on_task_id, relation, created_at FROM board_task_links" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY task_id ASC, depends_on_task_id ASC, relation ASC " +
      "LIMIT " + limit;
    const rows = this.#database.prepare(sql).all(...params) as unknown as BoardTaskLinkRow[];
    return rows.map(rowToBoardTaskLink);
  }

  findCycles(): readonly BoardTaskLinkCycle[] {
    const graph = this.#buildDagGraph();
    const cycles: BoardTaskLinkCycle[] = [];
    const visited = new Set<string>();

    for (const node of graph.keys()) {
      if (visited.has(node)) continue;
      const stack: string[] = [];
      const onStack = new Set<string>();

      const dfs = (current: string): boolean => {
        visited.add(current);
        stack.push(current);
        onStack.add(current);

        for (const edge of graph.get(current) ?? []) {
          if (!visited.has(edge.successor)) {
            if (dfs(edge.successor)) return true;
          } else if (onStack.has(edge.successor)) {
            const start = stack.indexOf(edge.successor);
            const nodes: string[] = [...stack.slice(start), edge.successor];
            const relations: BoardTaskLinkRelation[] = [];
            for (let i = 0; i < nodes.length - 1; i++) {
              const from = nodes[i]!;
              const to = nodes[i + 1]!;
              const edgeInfo = (graph.get(from) ?? []).find((e) => e.successor === to);
              relations.push(edgeInfo?.relation ?? "depends_on");
            }
            cycles.push({ nodes, relations });
            return true;
          }
        }

        stack.pop();
        onStack.delete(current);
        return false;
      };

      dfs(node);
    }

    return cycles;
  }

  topologicalOrder(): readonly TaskId[] {
    const cycles = this.findCycles();
    if (cycles.length > 0) {
      throw new BoardTaskLinkCycleAggregateError({ cycles });
    }

    const graph = this.#buildDagGraph();
    const inDegree = new Map<string, number>();
    for (const [node, edges] of graph) {
      if (!inDegree.has(node)) inDegree.set(node, 0);
      for (const edge of edges) {
        inDegree.set(edge.successor, (inDegree.get(edge.successor) ?? 0) + 1);
      }
    }

    const ready: string[] = [];
    for (const [node, degree] of inDegree) {
      if (degree === 0) ready.push(node);
    }
    ready.sort();

    const order: string[] = [];
    while (ready.length > 0) {
      const next = ready.shift()!;
      order.push(next);
      for (const edge of graph.get(next) ?? []) {
        const successor = edge.successor;
        const newDegree = (inDegree.get(successor) ?? 0) - 1;
        inDegree.set(successor, newDegree);
        if (newDegree === 0) {
          ready.push(successor);
          ready.sort();
        }
      }
    }

    return order as TaskId[];
  }

  topologicalOrderForRoots(rootIds: readonly TaskId[]): {
    readonly order: readonly TaskId[];
    readonly excludedIncoming: readonly BoardTaskLink[];
  } {
    const rootSet = new Set(rootIds.map(String));
    const graph = this.#buildDagGraph();
    const reachable = new Set<string>();

    for (const root of rootSet) {
      const stack = [root];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (reachable.has(current)) continue;
        reachable.add(current);
        for (const edge of graph.get(current) ?? []) {
          stack.push(edge.successor);
        }
      }
    }

    const subgraph = new Map<string, { readonly successor: string; readonly relation: BoardTaskLinkDagRelation }[]>();
    for (const [node, edges] of graph) {
      if (!reachable.has(node)) continue;
      const localEdges: { readonly successor: string; readonly relation: BoardTaskLinkDagRelation }[] = [];
      for (const edge of edges) {
        if (reachable.has(edge.successor)) {
          localEdges.push(edge);
        }
      }
      subgraph.set(node, localEdges);
    }

    const excludedIncoming: BoardTaskLink[] = [];
    for (const [predecessor, edges] of graph) {
      if (reachable.has(predecessor)) continue;
      for (const edge of edges) {
        if (!reachable.has(edge.successor)) continue;
        const link =
          edge.relation === "depends_on"
            ? this.getLink(edge.successor, predecessor, edge.relation)
            : this.getLink(predecessor, edge.successor, edge.relation);
        if (link) excludedIncoming.push(link);
      }
    }

    const inDegree = new Map<string, number>();
    for (const node of reachable) {
      inDegree.set(node, 0);
    }
    for (const [node, edges] of subgraph) {
      for (const edge of edges) {
        inDegree.set(edge.successor, (inDegree.get(edge.successor) ?? 0) + 1);
      }
    }

    const ready: string[] = [];
    for (const root of rootSet) {
      if (reachable.has(root)) ready.push(root);
    }
    ready.sort();

    const order: string[] = [];
    while (ready.length > 0) {
      const next = ready.shift()!;
      order.push(next);
      for (const edge of subgraph.get(next) ?? []) {
        const successor = edge.successor;
        const newDegree = (inDegree.get(successor) ?? 0) - 1;
        inDegree.set(successor, newDegree);
        if (newDegree === 0) {
          ready.push(successor);
          ready.sort();
        }
      }
    }

    if (order.length !== reachable.size) {
      throw new BoardTaskLinkCycleAggregateError({ cycles: this.findCycles() });
    }

    return {
      order: order as TaskId[],
      excludedIncoming
    };
  }

  #loadLinkRow(taskId: string, dependsOnTaskId: string, relation: string): BoardTaskLinkRow | undefined {
    return this.#database
      .prepare(
        "SELECT task_id, depends_on_task_id, relation, created_at FROM board_task_links " +
          "WHERE task_id = ? AND depends_on_task_id = ? AND relation = ?"
      )
      .get(taskId, dependsOnTaskId, relation) as BoardTaskLinkRow | undefined;
  }

  #missingEndpoints(
    taskId: string,
    dependsOnTaskId: string
  ): "taskId" | "dependsOnTaskId" | "both" | null {
    const taskExists = this.#taskExists(taskId);
    const dependsExists = this.#taskExists(dependsOnTaskId);
    if (taskExists && dependsExists) return null;
    if (!taskExists && !dependsExists) return "both";
    return taskExists ? "dependsOnTaskId" : "taskId";
  }

  #taskExists(taskId: string): boolean {
    const row = this.#database.prepare("SELECT 1 FROM board_tasks WHERE task_id = ?").get(taskId);
    return row !== undefined;
  }

  #wouldCycle(taskId: string, dependsOnTaskId: string, relation: BoardTaskLinkDagRelation): boolean {
    const graph = this.#buildDagGraph();
    const start = relation === "depends_on" ? taskId : dependsOnTaskId;
    const target = relation === "depends_on" ? dependsOnTaskId : taskId;
    const stack = [start];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of graph.get(current) ?? []) {
        stack.push(edge.successor);
      }
    }

    return false;
  }

  #findCycleFrom(
    taskId: string,
    dependsOnTaskId: string,
    relation: BoardTaskLinkDagRelation
  ): BoardTaskLinkCycle | null {
    const graph = this.#buildDagGraph();
    const start = relation === "depends_on" ? taskId : dependsOnTaskId;
    const target = relation === "depends_on" ? dependsOnTaskId : taskId;
    const path: string[] = [start];
    const visited = new Set<string>();

    const dfs = (current: string): boolean => {
      if (current === target && path.length > 1) {
        return true;
      }
      visited.add(current);
      for (const edge of graph.get(current) ?? []) {
        if (!visited.has(edge.successor) || edge.successor === target) {
          path.push(edge.successor);
          if (dfs(edge.successor)) return true;
          path.pop();
        }
      }
      return false;
    };

    if (!dfs(start)) return null;

    const nodes = [...path, start];
    const relations: BoardTaskLinkRelation[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const from = nodes[i]!;
      const to = nodes[i + 1]!;
      const edgeInfo = (graph.get(from) ?? []).find((e) => e.successor === to);
      relations.push(edgeInfo?.relation ?? relation);
    }
    return { nodes, relations };
  }

  #buildDagGraph(): Map<string, { readonly successor: string; readonly relation: BoardTaskLinkDagRelation }[]> {
    const rows = this.#database
      .prepare(
        "SELECT task_id, depends_on_task_id, relation FROM board_task_links WHERE relation IN ('depends_on', 'blocks')"
      )
      .all() as unknown as { readonly task_id: string; readonly depends_on_task_id: string; readonly relation: string }[];

    const graph = new Map<string, { readonly successor: string; readonly relation: BoardTaskLinkDagRelation }[]>();

    for (const row of rows) {
      const relation = row.relation as BoardTaskLinkDagRelation;
      const predecessor = relation === "depends_on" ? row.depends_on_task_id : row.task_id;
      const successor = relation === "depends_on" ? row.task_id : row.depends_on_task_id;
      const edges = graph.get(predecessor) ?? [];
      edges.push({ successor, relation });
      graph.set(predecessor, edges);
    }

    for (const row of rows) {
      const successor = row.relation === "depends_on" ? row.task_id : row.depends_on_task_id;
      if (!graph.has(successor)) graph.set(successor, []);
    }

    for (const edges of graph.values()) {
      edges.sort((a, b) => a.successor.localeCompare(b.successor));
    }

    return graph;
  }
}

export function openSqliteBoardTaskLinkRepository(
  options: SqliteBoardTaskLinkRepositoryOptions
): SqliteBoardTaskLinkRepository {
  return new SqliteBoardTaskLinkRepository(options);
}

export interface OpenSqliteBoardStoreWithTaskLinkRepositoryOptions extends OpenSqliteBoardStoreOptions {}

export class SqliteBoardStoreWithTaskLinkRepository implements BoardStore {
  readonly databasePath: string;
  readonly linkRepository: SqliteBoardTaskLinkRepository;
  readonly #store: SqliteBoardStore;

  constructor(store: SqliteBoardStore, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.databasePath = store.databasePath;
    const database = new DatabaseSync(this.databasePath);
    configureSqliteBoardConnection(database);
    const linkOptions: SqliteBoardTaskLinkRepositoryOptions = options.now
      ? { database, now: options.now }
      : { database };
    this.linkRepository = new SqliteBoardTaskLinkRepository(linkOptions);
  }

  static open(
    options: OpenSqliteBoardStoreWithTaskLinkRepositoryOptions,
    extras: { readonly now?: () => string } = {}
  ): SqliteBoardStoreWithTaskLinkRepository {
    const store = openSqliteBoardStore(options);
    return new SqliteBoardStoreWithTaskLinkRepository(store, extras);
  }

  migrate(): BoardMigrationReport {
    return this.#store.migrate();
  }

  inspect(): BoardSchemaDiagnostics {
    return this.#store.inspect();
  }

  close(): void {
    this.linkRepository.closeDatabase();
    this.#store.close();
  }

  backupTo(backupPath: string): { readonly sha256: string } {
    return this.#store.backupTo(backupPath);
  }
}
