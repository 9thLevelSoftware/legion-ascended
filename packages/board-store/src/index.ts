import type {
  ApprovalId,
  ChangeId,
  ContractId,
  EventId,
  ProjectId,
  RunId,
  TaskId,
  TaskRunStatus,
  TaskStatus
} from "@legion/protocol";

export const BOARD_SCHEMA_VERSION = 1 as const;

export const BOARD_REQUIRED_TABLES = [
  "board_metadata",
  "board_schema_migrations",
  "board_idempotency_records",
  "board_tasks",
  "board_task_links",
  "board_task_comments",
  "board_task_events",
  "board_projections",
  "board_claims",
  "board_task_runs",
  "board_approvals",
  "board_outbox"
] as const;

export const BOARD_REQUIRED_INDEXES = [
  "idx_board_tasks_status_priority",
  "idx_board_task_links_depends_on",
  "idx_board_task_events_aggregate_sequence",
  "idx_board_task_events_global_sequence",
  "idx_board_claims_live_task_generation",
  "idx_board_task_runs_task",
  "idx_board_outbox_status",
  "idx_board_idempotency_scope_key",
  "idx_board_task_comments_task_id",
  "idx_board_claims_task_id",
  "idx_board_approvals_task_id",
  "idx_board_approvals_run_id"
] as const;

export type BoardTableName = (typeof BOARD_REQUIRED_TABLES)[number];
export type BoardIndexName = (typeof BOARD_REQUIRED_INDEXES)[number];

export interface BoardMigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedVersions: readonly number[];
  readonly checksums: Readonly<Record<number, string>>;
  readonly backupPath?: string;
}

export interface BoardSchemaMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface BoardSchemaDiagnostics {
  readonly databasePath: string;
  readonly userVersion: number;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly tables: readonly string[];
  readonly indexes: readonly string[];
  readonly missingTables: readonly BoardTableName[];
  readonly missingIndexes: readonly BoardIndexName[];
  readonly migrations: readonly BoardSchemaMigrationRecord[];
}

export interface BoardStore {
  readonly databasePath: string;
  migrate(): BoardMigrationReport;
  inspect(): BoardSchemaDiagnostics;
  close(): void;
}

export type BoardTaskGeneration = number;

export interface BoardTaskIdentity {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly contractId: ContractId;
  readonly contractRevision: number;
  readonly generation: BoardTaskGeneration;
}

export interface BoardTaskProjection extends BoardTaskIdentity {
  readonly status: TaskStatus;
  readonly priority: number;
  readonly updatedAt: string;
}

export interface BoardRunProjection {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly generation: BoardTaskGeneration;
  readonly status: TaskRunStatus;
  readonly updatedAt: string;
}

export interface BoardApprovalProjection {
  readonly approvalId: ApprovalId;
  readonly taskId: TaskId;
  readonly status: "requested" | "granted" | "denied" | "expired";
  readonly updatedAt: string;
}

export interface BoardEventCursor {
  readonly eventId: EventId;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly globalSequence: number;
}
