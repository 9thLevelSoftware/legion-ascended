import type {
  ApprovalId,
  ApprovalStatus,
  ChangeId,
  ContractId,
  EventId,
  ProjectId,
  RunId,
  TaskId,
  TaskRunStatus,
  TaskStatus
} from "@legion/protocol";

// Re-export the protocol id + status types that board-store contracts
// reference so provider packages only need to depend on @legion/board-store.
export type { ApprovalId, ApprovalStatus, ChangeId, ContractId, EventId, ProjectId, RunId, TaskId, TaskRunStatus, TaskStatus };

export const BOARD_SCHEMA_VERSION = 3 as const;

export const BOARD_TASK_STATUSES = [
  "queued",
  "ready",
  "claimed",
  "running",
  "blocked",
  "completed",
  "failed",
  "canceled",
  "superseded"
] as const;

export type BoardTaskStatus = (typeof BOARD_TASK_STATUSES)[number];

export const BOARD_TASK_PRIORITY_MIN = 0;
export const BOARD_TASK_PRIORITY_MAX = 1_000;

export const BOARD_TASK_GENERATION_MIN = 1;

/**
 * Allowed task status transitions on the board. Rows that reach `completed`,
 * `canceled`, or `superseded` are terminal. `failed` is retryable by moving
 * back to `ready`, and active pre-terminal rows can move to `superseded` when
 * a replacement task is published.
 */
export const BOARD_TASK_STATUS_TRANSITIONS = {
  queued: ["ready", "canceled", "superseded"],
  ready: ["claimed", "canceled", "superseded"],
  claimed: ["running", "blocked", "canceled", "superseded"],
  running: ["completed", "failed", "blocked", "canceled", "superseded"],
  blocked: ["ready", "canceled", "superseded"],
  completed: [],
  failed: ["ready"],
  canceled: [],
  superseded: []
} as const satisfies Readonly<Record<BoardTaskStatus, readonly BoardTaskStatus[]>>;

export interface BoardTaskBlocker {
  readonly reason: string;
  readonly reportedBy?: string;
  readonly reportedAt?: string;
}

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
  readonly contractHash: string;
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
  readonly status: ApprovalStatus;
  readonly updatedAt: string;
}

export interface BoardEventCursor {
  readonly eventId: EventId;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly globalSequence: number;
}

export interface BoardTask extends BoardTaskIdentity {
  readonly status: TaskStatus;
  readonly priority: number;
  readonly blocker: BoardTaskBlocker | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBoardTaskInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly contractId: ContractId;
  readonly contractRevision: number;
  readonly contractHash: string;
  readonly initialStatus?: BoardTaskStatus;
  readonly initialPriority?: number;
  readonly initialGeneration?: number;
  readonly blocker?: BoardTaskBlocker | null;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}

export interface ListBoardTasksQuery {
  readonly status?: readonly BoardTaskStatus[];
  readonly projectId?: ProjectId;
  readonly changeId?: ChangeId;
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export interface BoardTaskStatusTransition {
  readonly toStatus: BoardTaskStatus;
  readonly blocker?: BoardTaskBlocker | null;
  readonly advanceGeneration?: number;
}

export interface SupersedeBoardTaskInput {
  readonly taskId: TaskId;
  readonly expectedGeneration: number;
  readonly successorTaskId?: TaskId;
  readonly supersededAt?: string;
}

export interface BumpBoardTaskGenerationInput {
  readonly taskId: TaskId;
  readonly expectedGeneration: number;
  readonly nextContractId: ContractId;
  readonly nextContractRevision: number;
  readonly nextContractHash: string;
  readonly updatedAt?: string;
}

export interface SupersedeBoardTaskResult {
  readonly retired: BoardTask;
  readonly successor: BoardTask | null;
}

export class BoardConcurrencyError extends Error {
  readonly taskId: TaskId;
  readonly expectedGeneration: number;
  readonly actualGeneration: number | null;

  constructor(taskId: TaskId, expectedGeneration: number, actualGeneration: number | null) {
    super(
      "Board task " +
        taskId +
        " expected generation " +
        expectedGeneration +
        " but found " +
        (actualGeneration ?? "missing") +
        "."
    );
    this.name = "BoardConcurrencyError";
    this.taskId = taskId;
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
  }
}

export class BoardTaskNotFoundError extends Error {
  readonly taskId: TaskId;
  constructor(taskId: TaskId) {
    super("Board task " + taskId + " was not found.");
    this.name = "BoardTaskNotFoundError";
    this.taskId = taskId;
  }
}

export class BoardIllegalStatusTransitionError extends Error {
  readonly taskId: TaskId;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(taskId: TaskId, from: TaskStatus, to: TaskStatus) {
    super(
      "Board task " + taskId + " cannot transition from " + from + " to " + to + "."
    );
    this.name = "BoardIllegalStatusTransitionError";
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

export class BoardTerminalTaskMutationError extends Error {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  constructor(taskId: TaskId, status: TaskStatus) {
    super("Board task " + taskId + " is in terminal status " + status + " and cannot be mutated.");
    this.name = "BoardTerminalTaskMutationError";
    this.taskId = taskId;
    this.status = status;
  }
}

/**
 * Lease-token minimum length. The schema enforces `length(lease_token) > 0`
 * but we add a defensive floor so callers can't accidentally generate single-
 * character tokens and collide on the unique index.
 */
export const BOARD_LEASE_TOKEN_MIN_LENGTH = 16;

export const BOARD_LEASE_RELEASE_REASONS = [
  "completed",
  "blocked",
  "failed",
  "canceled",
  "expired",
  "superseded"
] as const;

export type BoardLeaseReleaseReason = (typeof BOARD_LEASE_RELEASE_REASONS)[number];

/**
 * Active lease row bound to a board task. Once `releasedAt` is set the row
 * is archived for history but no longer blocks future claims on the same
 * `(task_id, generation)` tuple.
 */
export interface BoardClaim {
  readonly leaseToken: string;
  readonly taskId: TaskId;
  readonly generation: BoardTaskGeneration;
  readonly ownerId: string;
  readonly runId: RunId | null;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: BoardLeaseReleaseReason | null;
}

export interface CreateBoardClaimInput {
  readonly taskId: TaskId;
  readonly expectedGeneration: number;
  readonly ownerId: string;
  readonly runId?: RunId;
  readonly leaseDurationMs: number;
  readonly leaseToken?: string;
  readonly claimedAt?: string;
}

export interface HeartbeatBoardClaimInput {
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly now?: string;
}

export interface ReleaseBoardClaimInput {
  readonly leaseToken: string;
  readonly reason: BoardLeaseReleaseReason;
  readonly now?: string;
}

export interface ReclaimBoardClaimsOptions {
  readonly now?: string;
  readonly ownerId?: string;
}

export interface BoardClaimRepository {
  /**
   * Atomically claim `taskId` for `ownerId` at `expectedGeneration`. Returns
   * the new lease when the claim succeeds. Throws `BoardClaimContendedError`
   * when another live claim holds the same `(taskId, generation)` tuple, and
   * `BoardClaimGenerationError` when the task is on a different generation.
   */
  tryClaim(input: CreateBoardClaimInput): BoardClaim;
  getClaim(leaseToken: string): BoardClaim | null;
  getActiveClaimForTask(taskId: TaskId): BoardClaim | null;
  heartbeat(input: HeartbeatBoardClaimInput): BoardClaim;
  release(input: ReleaseBoardClaimInput): BoardClaim;
  /**
   * Release every claim whose `lease_expires_at` is older than `now()` and
   * stamp the rows with `release_reason = 'expired'`. Returns the claims that
   * were reclaimed so callers can re-queue the now-unclaimed tasks.
   */
  reclaimExpiredLeases(options?: ReclaimBoardClaimsOptions): readonly BoardClaim[];
}

export class BoardClaimNotFoundError extends Error {
  readonly leaseToken: string;
  constructor(leaseToken: string) {
    super("Board claim with lease token " + leaseToken + " was not found.");
    this.name = "BoardClaimNotFoundError";
    this.leaseToken = leaseToken;
  }
}

export class BoardClaimAlreadyReleasedError extends Error {
  readonly leaseToken: string;
  readonly releasedAt: string;
  readonly releaseReason: BoardLeaseReleaseReason;
  constructor(leaseToken: string, releasedAt: string, releaseReason: BoardLeaseReleaseReason) {
    super(
      "Board claim with lease token " +
        leaseToken +
        " was already released at " +
        releasedAt +
        " with reason " +
        releaseReason +
        "."
    );
    this.name = "BoardClaimAlreadyReleasedError";
    this.leaseToken = leaseToken;
    this.releasedAt = releasedAt;
    this.releaseReason = releaseReason;
  }
}

export class BoardClaimContendedError extends Error {
  readonly taskId: TaskId;
  readonly generation: BoardTaskGeneration;
  readonly holderOwnerId: string;
  readonly holderLeaseToken: string;
  constructor(taskId: TaskId, generation: BoardTaskGeneration, holderOwnerId: string, holderLeaseToken: string) {
    super(
      "Board claim for task " +
        taskId +
        " generation " +
        generation +
        " is already held by owner " +
        holderOwnerId +
        " (lease token " +
        holderLeaseToken +
        ")."
    );
    this.name = "BoardClaimContendedError";
    this.taskId = taskId;
    this.generation = generation;
    this.holderOwnerId = holderOwnerId;
    this.holderLeaseToken = holderLeaseToken;
  }
}

export class BoardClaimGenerationError extends Error {
  readonly taskId: TaskId;
  readonly expectedGeneration: number;
  readonly actualGeneration: number | null;
  constructor(taskId: TaskId, expectedGeneration: number, actualGeneration: number | null) {
    super(
      "Board claim for task " +
        taskId +
        " expected generation " +
        expectedGeneration +
        " but found " +
        (actualGeneration ?? "missing") +
        "."
    );
    this.name = "BoardClaimGenerationError";
    this.taskId = taskId;
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
  }
}

export interface BoardTaskRepository {
  createTask(input: CreateBoardTaskInput): BoardTask;
  getTask(taskId: TaskId): BoardTask | null;
  listTasks(query?: ListBoardTasksQuery): readonly BoardTask[];
  updateTaskPriority(taskId: TaskId, nextPriority: number, expectedGeneration?: number): BoardTask;
  transitionTaskStatus(
    taskId: TaskId,
    transition: BoardTaskStatusTransition,
    expectedGeneration?: number
  ): BoardTask;
  bumpGeneration(input: BumpBoardTaskGenerationInput): BoardTask;
  supersedeTask(input: SupersedeBoardTaskInput): SupersedeBoardTaskResult;
  deleteTask(taskId: TaskId, expectedGeneration: number): void;
}

// =====================================================================
// Board task comment repository.
//
// `board_task_comments` stores short text notes attached to a board task.
// Comments are independent of the task state machine; they can be added,
// edited, and removed regardless of task status. The schema enforces the
// task association through a foreign key with `ON DELETE CASCADE`.
// =====================================================================

export const BOARD_TASK_COMMENT_BODY_MAX_LENGTH = 8192;

export interface BoardTaskCommentActor {
  readonly id: string;
  readonly kind?: "human" | "agent" | "system" | "automation";
  readonly displayName?: string;
}

export interface BoardTaskComment {
  readonly commentId: number;
  readonly taskId: TaskId;
  readonly actor: BoardTaskCommentActor;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBoardTaskCommentInput {
  readonly taskId: TaskId;
  readonly actor: BoardTaskCommentActor;
  readonly body: string;
  readonly createdAt?: string;
}

export interface UpdateBoardTaskCommentInput {
  readonly actor?: BoardTaskCommentActor;
  readonly body?: string;
  readonly updatedAt?: string;
}

export interface ListBoardTaskCommentsQuery {
  readonly taskId?: TaskId;
  readonly limit?: number;
}

export interface BoardTaskCommentRepository {
  createComment(input: CreateBoardTaskCommentInput): BoardTaskComment;
  getComment(commentId: number): BoardTaskComment | null;
  listComments(query?: ListBoardTaskCommentsQuery): readonly BoardTaskComment[];
  updateComment(commentId: number, input: UpdateBoardTaskCommentInput): BoardTaskComment;
  deleteComment(commentId: number): void;
}

export class BoardTaskCommentNotFoundError extends Error {
  readonly commentId: number;
  constructor(commentId: number) {
    super("Board task comment " + commentId + " was not found.");
    this.name = "BoardTaskCommentNotFoundError";
    this.commentId = commentId;
  }
}

// =====================================================================
// P03-T05: Board outbox repository.
// `board_outbox` stores durable side-effect intents. Rows begin in
// `pending`, move to `claimed` while a dispatcher owns the attempt, and
// finish in `succeeded`, `failed`, or `dead_lettered`. The table keeps
// the delivery payload, a target hash for idempotent dispatching, and
// claim metadata so workers can recover after process loss.
// =====================================================================

export const BOARD_OUTBOX_STATUSES = ["pending", "claimed", "succeeded", "failed", "dead_lettered"] as const;

export type BoardOutboxStatus = (typeof BOARD_OUTBOX_STATUSES)[number];

export const BOARD_OUTBOX_EFFECT_CLASSES = ["S0", "S1", "S2", "S3", "S4"] as const;

export type BoardOutboxEffectClass = (typeof BOARD_OUTBOX_EFFECT_CLASSES)[number];

export interface BoardOutbox {
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly effectClass: BoardOutboxEffectClass;
  readonly effectKind: string;
  readonly targetHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadJson: string;
  readonly status: BoardOutboxStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly claimedBy: string | null;
  readonly claimedUntil: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBoardOutboxInput {
  readonly effectClass: BoardOutboxEffectClass;
  readonly effectKind: string;
  readonly targetHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly outboxId?: string;
  readonly availableAt?: string;
  readonly createdAt?: string;
}

export interface ClaimBoardOutboxInput {
  readonly outboxId: string;
  readonly claimedBy: string;
  readonly claimedUntil: string;
  readonly now?: string;
}

export interface MarkBoardOutboxAttemptInput {
  readonly outboxId: string;
  readonly result: "succeeded" | "failed" | "dead_lettered";
  readonly lastError?: string | null;
  readonly nextAvailableAt?: string;
  readonly updatedAt?: string;
}

export interface ListBoardOutboxQuery {
  readonly status?: readonly BoardOutboxStatus[];
  readonly effectClass?: readonly BoardOutboxEffectClass[];
  readonly effectKind?: string;
  readonly availableBefore?: string;
  readonly limit?: number;
}

export interface BoardOutboxRepository {
  enqueueOutbox(input: CreateBoardOutboxInput): BoardOutbox;
  getOutbox(outboxId: string): BoardOutbox | null;
  getOutboxByIdempotencyKey(idempotencyKey: string): BoardOutbox | null;
  listOutbox(query?: ListBoardOutboxQuery): readonly BoardOutbox[];
  claimOutbox(input: ClaimBoardOutboxInput): BoardOutbox;
  markOutboxAttempt(input: MarkBoardOutboxAttemptInput): BoardOutbox;
}

export class BoardOutboxNotFoundError extends Error {
  readonly outboxId: string;
  constructor(outboxId: string) {
    super("Board outbox row " + outboxId + " was not found.");
    this.name = "BoardOutboxNotFoundError";
    this.outboxId = outboxId;
  }
}

export class BoardOutboxConcurrencyError extends Error {
  readonly outboxId: string;
  readonly expectedStatus: BoardOutboxStatus;
  readonly actualStatus: BoardOutboxStatus;
  constructor(outboxId: string, expectedStatus: BoardOutboxStatus, actualStatus: BoardOutboxStatus) {
    super(
      "Board outbox row " +
        outboxId +
        " expected status " +
        expectedStatus +
        " but found " +
        actualStatus +
        "."
    );
    this.name = "BoardOutboxConcurrencyError";
    this.outboxId = outboxId;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export class BoardOutboxTerminalStatusError extends Error {
  readonly outboxId: string;
  readonly status: BoardOutboxStatus;
  constructor(outboxId: string, status: BoardOutboxStatus) {
    super("Board outbox row " + outboxId + " is terminal in status " + status + ".");
    this.name = "BoardOutboxTerminalStatusError";
    this.outboxId = outboxId;
    this.status = status;
  }
}

// =====================================================================
// P03-T03: Board event append + projection rebuild contracts.
// The board_task_events table is an append-only log of every board
// mutation; board_projections stores a rebuilt_through marker plus a
// state_hash that detects drift after rebuild.
// =====================================================================

export const BOARD_EVENT_SCHEMA_VERSION = "0.1.0" as const;

/**
 * Board-local event types emitted by repository mutations. These are
 * distinct from the protocol `EVENT_TYPES` catalog because they describe
 * control-plane state changes (priority edits, generation bumps, deletes)
 * that are not yet modeled as workflow facts.
 */
export const BOARD_EVENT_TYPES = [
  "task.created",
  "task.priority_changed",
  "task.transitioned",
  "task.bumped",
  "task.superseded",
  "task.linked",
  "task.deleted",
  // P09-T02 — Whole-change acceptance aggregator (board adapter
  // layer). Persisted as TEXT by the SQLite repository; the
  // allowlist is the source of truth for consumers.
  "change.aggregated",
  "change.accepted",
  "change.rejected",
  "change.escalated",
  "change.blocked",
  // P10-T01 — Release observation aggregator (board adapter
  // layer). Emits observing/promoted/regressed/rolled_back
  // transitions on top of accepted whole-change state.
  "release.observing",
  "release.observed",
  "release.promoted",
  "release.regressed",
  "release.rolled_back"
] as const;

export type BoardEventType = (typeof BOARD_EVENT_TYPES)[number];

/**
 * Aggregate kinds supported by the board event log. The DB column is a
 * free-form TEXT, but the contract enumerates the legal values so
 * consumers can pattern-match without parsing event_type strings.
 */
export const BOARD_EVENT_AGGREGATE_KINDS = [
  "task",
  "task_link",
  "task_run",
  "claim",
  "approval",
  "outbox",
  "projection",
  // P09-T02 — Whole-change aggregate (board adapter layer).
  "whole_change",
  // P10-T01 — Release-observation aggregate (board adapter layer).
  "release_observation"
] as const;

export type BoardEventAggregateKind = (typeof BOARD_EVENT_AGGREGATE_KINDS)[number];

export interface BoardEventEnvelope {
  readonly schemaVersion: typeof BOARD_EVENT_SCHEMA_VERSION;
  readonly eventId: EventId;
  readonly aggregateKind: BoardEventAggregateKind;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly globalSequence: number;
  readonly eventType: BoardEventType;
  readonly eventVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
  readonly causationId: EventId | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
  readonly idempotencyKey: string | null;
}

export interface BoardEvent extends BoardEventEnvelope {
  readonly payloadJson: string;
}

export interface AppendBoardEventInput {
  readonly aggregateKind: BoardEventAggregateKind;
  readonly aggregateId: string;
  readonly eventType: BoardEventType;
  readonly eventVersion?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causationId?: EventId | null;
  readonly correlationId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly occurredAt?: string;
  readonly expectedAggregateSequence?: number;
  readonly expectedGlobalSequence?: number;
  readonly eventId?: EventId;
}

export interface AppendBoardEventsInput {
  readonly events: readonly AppendBoardEventInput[];
}

export interface BoardEventAppendResult {
  readonly event: BoardEvent;
}

export interface BoardEventAppendBatchResult {
  readonly events: readonly BoardEvent[];
}

export interface BoardEventQuery {
  readonly aggregateKind?: BoardEventAggregateKind;
  readonly aggregateId?: string;
  readonly eventType?: BoardEventType;
  readonly fromGlobalSequence?: number;
  readonly untilGlobalSequence?: number;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export interface BoardEventAppendErrorContext {
  readonly eventId?: EventId;
  readonly idempotencyKey?: string | null;
  readonly cause: "duplicate_event_id" | "duplicate_idempotency_key" | "payload_hash_mismatch" | "aggregate_sequence_conflict" | "global_sequence_conflict";
  readonly expected?: number;
  readonly actual?: number | null;
}

export class BoardEventAppendError extends Error {
  readonly context: BoardEventAppendErrorContext;
  constructor(message: string, context: BoardEventAppendErrorContext) {
    super(message);
    this.name = "BoardEventAppendError";
    this.context = context;
  }
}

export interface BoardEventRepository {
  appendEvent(input: AppendBoardEventInput): BoardEventAppendResult;
  appendEvents(input: AppendBoardEventsInput): BoardEventAppendBatchResult;
  listEvents(query?: BoardEventQuery): readonly BoardEvent[];
  getEvent(eventId: EventId): BoardEvent | null;
  getEventByIdempotencyKey(idempotencyKey: string): BoardEvent | null;
  countEvents(query?: BoardEventQuery): number;
  tail(limit: number): readonly BoardEvent[];
}

// =====================================================================
// Projection rebuild contracts.
// board_projections stores the projection key, version, the global
// sequence the projection was last rebuilt through, a state_hash over
// the canonical JSON state, and the state itself.
// =====================================================================

export const BOARD_PROJECTION_KEY_MAX_LENGTH = 256;
export const BOARD_PROJECTION_KEY_PATTERN = /^[a-z][a-z0-9._:-]{0,254}[a-z0-9]$/;

export interface BoardProjectionState {
  readonly [key: string]: unknown;
}

export interface BoardProjectionRecord {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly stateHash: string;
  readonly state: BoardProjectionState;
  readonly updatedAt: string;
}

export interface SaveBoardProjectionInput {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly state: BoardProjectionState;
  readonly stateHash?: string;
  readonly expectedProjectionVersion?: number;
  readonly updatedAt?: string;
}

export interface BoardProjectionRebuildReport {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: BoardProjectionState;
  readonly stateHash: string;
  readonly rebuiltAt: string;
}

export interface BoardProjectionDrift {
  readonly projectionKey: string;
  readonly savedRebuiltThrough: number;
  readonly actualRebuiltThrough: number;
  readonly savedStateHash: string;
  readonly actualStateHash: string;
}

export class BoardProjectionDriftError extends Error {
  readonly drift: BoardProjectionDrift;
  constructor(drift: BoardProjectionDrift) {
    super(
      "Board projection " +
        drift.projectionKey +
        " drifted: saved rebuilt_through=" +
        drift.savedRebuiltThrough +
        " hash=" +
        drift.savedStateHash +
        " but rebuilt=" +
        drift.actualRebuiltThrough +
        " hash=" +
        drift.actualStateHash +
        "."
    );
    this.name = "BoardProjectionDriftError";
    this.drift = drift;
  }
}

export interface BoardProjectionRebuilder<S extends BoardProjectionState = BoardProjectionState> {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  rebuild(input: {
    readonly events: readonly BoardEvent[];
    readonly throughGlobalSequence: number;
    readonly now?: () => string;
  }): BoardProjectionRebuildReport & { readonly state: S };
}

export interface BoardProjectionRepository {
  saveProjection(input: SaveBoardProjectionInput): BoardProjectionRecord;
  loadProjection(projectionKey: string): BoardProjectionRecord | null;
  deleteProjection(projectionKey: string, expectedProjectionVersion?: number): boolean;
  listStaleProjections(belowGlobalSequence: number): readonly BoardProjectionRecord[];
}

/**
 * Hook signature that `SqliteBoardTaskRepository` invokes inside its
 * `BEGIN IMMEDIATE` mutation transaction so every board state change
 * emits a corresponding `board_task_events` row atomically with the
 * board_tasks update. Hooks must be non-throwing; any thrown error is
 * surfaced by the repository as a regular transaction failure.
 */
export type BoardTaskEventHook = (context: {
  readonly taskId: string;
  readonly projectId: string;
  readonly changeId: string;
  readonly generation: number;
  readonly mutation: BoardTaskMutationKind;
  readonly previous: BoardTask | null;
  readonly current: BoardTask | null;
  readonly successor: BoardTask | null;
  readonly blocker: BoardTaskBlocker | null;
  readonly occurredAt: string;
  readonly causationId?: string | null;
  readonly correlationId?: string | null;
  readonly idempotencyKey?: string | null;
}) => readonly AppendBoardEventInput[];

export type BoardTaskMutationKind =
  | "create"
  | "update_priority"
  | "transition_status"
  | "bump_generation"
  | "supersede"
  | "delete";

export interface BoardTaskRepositoryWithHooks extends BoardTaskRepository {
  readonly eventHooks: readonly BoardTaskEventHook[];
}

// =====================================================================
// P03-T07: Board approval lifecycle.
// board_approvals stores protocol-aligned ApprovalStatus values
// (`requested`/`granted`/`denied`/`expired`/`revoked`) keyed by task_id
// and optionally run_id. The status FSM is:
//
//   requested ──► granted ──► revoked
//      │            │
//      ├─► denied   │
//      ├─► expired  │
//      └─► revoked  │
//
// `denied`, `expired`, and the post-grant `revoked` are terminal; only
// `requested` and `granted` can transition further. The "lifecycle
// phase" helpers below group the five protocol statuses into the three
// user-facing buckets callers care about: `pending`, `approved`,
// `revoked`. Storage always uses the protocol enum; the phase helpers
// are pure projections.
// =====================================================================

export const BOARD_APPROVAL_STATUSES = [
  "requested",
  "granted",
  "denied",
  "expired",
  "revoked"
] as const;

export type BoardApprovalStatus = (typeof BOARD_APPROVAL_STATUSES)[number];

/**
 * High-level lifecycle phases grouping the protocol statuses. Storage
 * never writes these values directly; consumers use them to filter or
 * summarize the status field.
 */
export const BOARD_APPROVAL_LIFECYCLE_PHASES = ["pending", "approved", "revoked"] as const;

export type BoardApprovalLifecyclePhase = (typeof BOARD_APPROVAL_LIFECYCLE_PHASES)[number];

/**
 * Allowed approval status transitions. Rows in `requested` can be
 * decided, expired, or revoked. Rows in `granted` can be revoked (an
 * approver yanks a previously-granted approval). `denied`, `expired`,
 * and `revoked` are terminal.
 */
export const BOARD_APPROVAL_STATUS_TRANSITIONS = {
  requested: ["granted", "denied", "expired", "revoked"],
  granted: ["revoked"],
  denied: [],
  expired: [],
  revoked: []
} as const satisfies Readonly<Record<BoardApprovalStatus, readonly BoardApprovalStatus[]>>;

/**
 * Terminal approval statuses. Once an approval reaches one of these it
 * can never move again. Distinct from the lifecycle phases because
 * `revoked` can be entered from `requested` AND from `granted`.
 */
export const BOARD_APPROVAL_TERMINAL_STATUSES = ["denied", "expired", "revoked"] as const;

export type BoardApprovalTerminalStatus = (typeof BOARD_APPROVAL_TERMINAL_STATUSES)[number];

/**
 * Scope payload for an approval. Mirrors `ApprovalScope` from the
 * protocol but stays opaque here so the board store never has to know
 * the canonical target reference schema.
 */
export interface BoardApprovalScope {
  readonly effectClass: "S0" | "S1" | "S2" | "S3" | "S4";
  readonly action: string;
  readonly targetsJson: string;
  readonly justification?: string;
}

/**
 * Actor identity stored alongside the approval. Mirrors `actorSchema`
 * from the protocol but stays opaque to the board store; the JSON form
 * is what gets persisted and round-tripped.
 */
export interface BoardApprovalActor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind: "human" | "agent" | "system" | "automation";
}

/**
 * Full approval record as it appears on read paths.
 *
 * - `scope` is the structured `BoardApprovalScope` view of the row's
 *   `scope_json` column.
 * - `requestedBy` and `decidedBy` are the actor JSON columns decoded.
 * - `lifecyclePhase` is computed from `status`; it is not persisted.
 * - `approvedAt` is set when status moves to `granted` (alias for
 *   `decidedAt`); callers that only care about the grant event can use
 *   it directly.
 */
export interface BoardApproval {
  readonly approvalId: ApprovalId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly status: BoardApprovalStatus;
  readonly lifecyclePhase: BoardApprovalLifecyclePhase;
  readonly scope: BoardApprovalScope;
  readonly requestedBy: BoardApprovalActor;
  readonly decidedBy: BoardApprovalActor | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly approvedAt: string | null;
  readonly expiresAt: string | null;
  readonly decisionReason: string | null;
}

export interface CreateBoardApprovalInput {
  readonly approvalId?: ApprovalId;
  readonly taskId: TaskId;
  readonly runId?: RunId | null;
  readonly scope: BoardApprovalScope;
  readonly requestedBy: BoardApprovalActor;
  readonly expiresAt?: string | null;
  readonly idempotencyKey?: string;
  readonly requestedAt?: string;
}

export interface DecideBoardApprovalInput {
  readonly approvalId: ApprovalId;
  readonly expectedStatus: BoardApprovalStatus;
  readonly decidedBy: BoardApprovalActor;
  readonly decisionReason: string;
  readonly decidedAt?: string;
}

export interface ExpireBoardApprovalInput {
  readonly approvalId: ApprovalId;
  readonly expectedStatus: BoardApprovalStatus;
  readonly now?: string;
}

export interface RevokeBoardApprovalInput {
  readonly approvalId: ApprovalId;
  readonly expectedStatus: BoardApprovalStatus;
  readonly revokedBy: BoardApprovalActor;
  readonly revokeReason: string;
  readonly revokedAt?: string;
}

export interface ListBoardApprovalsQuery {
  readonly taskId?: TaskId;
  readonly runId?: RunId;
  readonly status?: readonly BoardApprovalStatus[];
  readonly lifecyclePhase?: readonly BoardApprovalLifecyclePhase[];
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export interface BoardApprovalRepository {
  createApproval(input: CreateBoardApprovalInput): BoardApproval;
  getApproval(approvalId: ApprovalId): BoardApproval | null;
  listApprovals(query?: ListBoardApprovalsQuery): readonly BoardApproval[];
  grantApproval(input: DecideBoardApprovalInput): BoardApproval;
  denyApproval(input: DecideBoardApprovalInput): BoardApproval;
  expireApproval(input: ExpireBoardApprovalInput): BoardApproval;
  revokeApproval(input: RevokeBoardApprovalInput): BoardApproval;
}

export class BoardApprovalNotFoundError extends Error {
  readonly approvalId: ApprovalId;
  constructor(approvalId: ApprovalId) {
    super("Board approval " + approvalId + " was not found.");
    this.name = "BoardApprovalNotFoundError";
    this.approvalId = approvalId;
  }
}

export class BoardApprovalAlreadyExistsError extends Error {
  readonly approvalId: ApprovalId;
  constructor(approvalId: ApprovalId) {
    super("Board approval " + approvalId + " already exists.");
    this.name = "BoardApprovalAlreadyExistsError";
    this.approvalId = approvalId;
  }
}

export class BoardApprovalIllegalStatusTransitionError extends Error {
  readonly approvalId: ApprovalId;
  readonly from: BoardApprovalStatus;
  readonly to: BoardApprovalStatus;
  constructor(approvalId: ApprovalId, from: BoardApprovalStatus, to: BoardApprovalStatus) {
    super(
      "Board approval " +
        approvalId +
        " cannot transition from " +
        from +
        " to " +
        to +
        "."
    );
    this.name = "BoardApprovalIllegalStatusTransitionError";
    this.approvalId = approvalId;
    this.from = from;
    this.to = to;
  }
}

export class BoardApprovalTerminalStatusError extends Error {
  readonly approvalId: ApprovalId;
  readonly status: BoardApprovalStatus;
  constructor(approvalId: ApprovalId, status: BoardApprovalStatus) {
    super(
      "Board approval " + approvalId + " is in terminal status " + status + " and cannot be mutated."
    );
    this.name = "BoardApprovalTerminalStatusError";
    this.approvalId = approvalId;
    this.status = status;
  }
}

export class BoardApprovalConcurrencyError extends Error {
  readonly approvalId: ApprovalId;
  readonly expectedStatus: BoardApprovalStatus;
  readonly actualStatus: BoardApprovalStatus | null;
  constructor(approvalId: ApprovalId, expectedStatus: BoardApprovalStatus, actualStatus: BoardApprovalStatus | null) {
    super(
      "Board approval " +
        approvalId +
        " expected status " +
        expectedStatus +
        " but found " +
        (actualStatus ?? "missing") +
        "."
    );
    this.name = "BoardApprovalConcurrencyError";
    this.approvalId = approvalId;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

// =====================================================================
// P03-T08: Board task link repository.
//
// `board_task_links` is the dependency-edge table between board tasks.
// The schema constrains `relation` to four legal values:
//
//   depends_on  - directional: the successor task must wait for the
//                 predecessor to finish. The edge (A -> B) means "A
//                 depends on B", so B precedes A in the run order.
//   blocks      - directional: the predecessor task cannot complete
//                 while the successor is still running. The edge
//                 (A -> B) means "A blocks B", so A precedes B in
//                 the run order.
//   supersedes  - terminal, written by `supersedeTask` to bind a
//                 successor task to its retired predecessor. Already
//                 used by P03-T02; the link repository reuses the
//                 same physical row.
//   relates_to  - non-directional; two tasks are thematically related
//                 but neither blocks the other.
//
// Only `depends_on` and `blocks` participate in cycle detection and
// topological ordering. `supersedes` always points at a retired task
// and `relates_to` is intentionally non-directional, so neither can
// create a meaningful cycle.
//
// The link repository sits beside `BoardTaskRepository`:
//   - `addLink`/`removeLink` mutate the edges.
//   - `getLink`/`listOutgoingLinks`/`listIncomingLinks` read them.
//   - `topologicalOrder` orders tasks across the depends_on + blocks
//     DAG using Kahn's algorithm.
//   - `findCycles` reports every cycle currently present in the DAG.
// Both `addLink` and `removeLink` run inside the storage layer's
// `BEGIN IMMEDIATE` transaction so a check-then-insert cannot race
// against another writer and silently bypass cycle detection.
// =====================================================================

export const BOARD_TASK_LINK_RELATIONS = [
  "depends_on",
  "blocks",
  "supersedes",
  "relates_to"
] as const;

export type BoardTaskLinkRelation = (typeof BOARD_TASK_LINK_RELATIONS)[number];

/**
 * Relations that contribute to the dependency DAG. `supersedes` and
 * `relates_to` are excluded: `supersedes` always points at a retired
 * row and `relates_to` is explicitly non-directional.
 */
export const BOARD_TASK_LINK_DAG_RELATIONS = ["depends_on", "blocks"] as const;

export type BoardTaskLinkDagRelation = (typeof BOARD_TASK_LINK_DAG_RELATIONS)[number];

/**
 * A directed edge in the dependency DAG. For `depends_on`, the
 * `predecessor` is the task that must finish first and `successor`
 * is the task that depends on it. For `blocks`, the `predecessor`
 * is the task that is blocking the `successor` from completing.
 *
 * `successor` here means "the task that has to come later"; this is
 * the sense in which the edge is "A precedes B" in run order.
 */
export interface BoardTaskLink {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  readonly createdAt: string;
}

export interface CreateBoardTaskLinkInput {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  readonly createdAt?: string;
}

export interface ListBoardTaskLinksQuery {
  readonly taskId?: TaskId;
  readonly dependsOnTaskId?: TaskId;
  readonly relation?: BoardTaskLinkRelation | readonly BoardTaskLinkRelation[];
  readonly limit?: number;
}

export interface BoardTaskLinkCycle {
  /** Cycle nodes in traversal order; the first and last entry are the same task. */
  readonly nodes: readonly TaskId[];
  /** Edges in traversal order, where `edges[i]` is the relation that connects `nodes[i]` -> `nodes[i+1]`. */
  readonly relations: readonly BoardTaskLinkRelation[];
}

export interface BoardTaskLinkCycleErrorContext {
  readonly attemptedTaskId: TaskId;
  readonly attemptedDependsOnTaskId: TaskId;
  readonly attemptedRelation: BoardTaskLinkRelation;
  readonly cycle: BoardTaskLinkCycle;
}

export class BoardTaskLinkCycleError extends Error {
  readonly context: BoardTaskLinkCycleErrorContext;
  constructor(context: BoardTaskLinkCycleErrorContext) {
    const path = context.cycle.nodes.join(" -> ");
    super(
      "Board task link from " +
        context.attemptedTaskId +
        " " +
        context.attemptedRelation +
        " " +
        context.attemptedDependsOnTaskId +
        " would create a dependency cycle: " +
        path +
        "."
    );
    this.name = "BoardTaskLinkCycleError";
    this.context = context;
  }
}

export class BoardTaskLinkNotFoundError extends Error {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  constructor(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation) {
    super(
      "Board task link " +
        taskId +
        " " +
        relation +
        " " +
        dependsOnTaskId +
        " was not found."
    );
    this.name = "BoardTaskLinkNotFoundError";
    this.taskId = taskId;
    this.dependsOnTaskId = dependsOnTaskId;
    this.relation = relation;
  }
}

export class BoardTaskLinkAlreadyExistsError extends Error {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  constructor(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation) {
    super(
      "Board task link " +
        taskId +
        " " +
        relation +
        " " +
        dependsOnTaskId +
        " already exists."
    );
    this.name = "BoardTaskLinkAlreadyExistsError";
    this.taskId = taskId;
    this.dependsOnTaskId = dependsOnTaskId;
    this.relation = relation;
  }
}

export class BoardTaskLinkInvalidRelationError extends Error {
  readonly relation: string;
  constructor(relation: string) {
    super("Unknown board task link relation: " + relation + ".");
    this.name = "BoardTaskLinkInvalidRelationError";
    this.relation = relation;
  }
}

export class BoardTaskLinkSelfLoopError extends Error {
  readonly taskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  constructor(taskId: TaskId, relation: BoardTaskLinkRelation) {
    super(
      "Board task link " +
        taskId +
        " " +
        relation +
        " " +
        taskId +
        " is a self-loop and is rejected by the schema."
    );
    this.name = "BoardTaskLinkSelfLoopError";
    this.taskId = taskId;
    this.relation = relation;
  }
}

export class BoardTaskLinkEndpointNotFoundError extends Error {
  readonly taskId: TaskId;
  readonly dependsOnTaskId: TaskId;
  readonly relation: BoardTaskLinkRelation;
  readonly missingEndpoint: "taskId" | "dependsOnTaskId" | "both";
  constructor(
    taskId: TaskId,
    dependsOnTaskId: TaskId,
    relation: BoardTaskLinkRelation,
    missingEndpoint: "taskId" | "dependsOnTaskId" | "both"
  ) {
    super(
      "Board task link " +
        taskId +
        " " +
        relation +
        " " +
        dependsOnTaskId +
        " requires both endpoints to exist on the board (missing " +
        missingEndpoint +
        ")."
    );
    this.name = "BoardTaskLinkEndpointNotFoundError";
    this.taskId = taskId;
    this.dependsOnTaskId = dependsOnTaskId;
    this.relation = relation;
    this.missingEndpoint = missingEndpoint;
  }
}

export interface BoardTaskLinkRepository {
  /**
   * Add a directed edge. Validates the relation, both endpoints exist
   * on the board, and that the edge does not point at its own source.
   * For DAG relations (`depends_on`, `blocks`) the call also confirms
   * the new edge would not introduce a cycle; a cycle raises
   * `BoardTaskLinkCycleError` and leaves the table untouched.
   */
  addLink(input: CreateBoardTaskLinkInput): BoardTaskLink;
  /**
   * Remove a directed edge. Returns the removed link or throws
   * `BoardTaskLinkNotFoundError` when the edge was not present.
   */
  removeLink(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation): BoardTaskLink;
  /**
   * Fetch a single directed edge.
   */
  getLink(taskId: TaskId, dependsOnTaskId: TaskId, relation: BoardTaskLinkRelation): BoardTaskLink | null;
  /**
   * Enumerate every link where `task_id = taskId` (the source side
   * of the directed edge). Mirrors `idx_board_task_links_depends_on`
   * when queried with no other filter.
   */
  listOutgoingLinks(taskId: TaskId, relation?: BoardTaskLinkRelation): readonly BoardTaskLink[];
  /**
   * Enumerate every link where `depends_on_task_id = taskId` (the
   * destination side of the directed edge). Backed by
   * `idx_board_task_links_depends_on`.
   */
  listIncomingLinks(taskId: TaskId, relation?: BoardTaskLinkRelation): readonly BoardTaskLink[];
  /**
   * General-purpose listing for diagnostics and tests; the query
   * filters narrow by source, destination, relation, and bounded limit.
   */
  listLinks(query?: ListBoardTaskLinksQuery): readonly BoardTaskLink[];
  /**
   * Return every DAG cycle currently present on the board. Each entry
   * describes a single strongly-connected component of size > 1, with
   * the cycle nodes and edges in traversal order.
   */
  findCycles(): readonly BoardTaskLinkCycle[];
  /**
   * Stable topological order over the union of every task reachable
   * from a DAG edge (`depends_on` + `blocks`). Tasks with no incoming
   * edges come first; ties broken alphabetically by TaskId so the
   * order is deterministic across runs.
   *
   * Throws an aggregate error describing every cycle when the DAG is
   * not acyclic; callers must repair the graph first.
   */
  topologicalOrder(): readonly TaskId[];
  /**
   * Topological order restricted to the subgraph induced by `rootIds`
   * and their descendants. Roots are emitted first even when they
   * carry in-edges from outside the subgraph; the outside edges are
   * surfaced in `excludedIncoming` so callers can decide whether to
   * treat the subset as a closed unit.
   */
  topologicalOrderForRoots(rootIds: readonly TaskId[]): {
    readonly order: readonly TaskId[];
    readonly excludedIncoming: readonly BoardTaskLink[];
  };
}

export interface BoardTaskLinkCycleAggregateErrorContext {
  readonly cycles: readonly BoardTaskLinkCycle[];
}

export class BoardTaskLinkCycleAggregateError extends Error {
  readonly context: BoardTaskLinkCycleAggregateErrorContext;
  constructor(context: BoardTaskLinkCycleAggregateErrorContext) {
    const rendered = context.cycles
      .map((cycle) => cycle.nodes.join(" -> "))
      .join("; ");
    super("Board dependency graph is not a DAG; found " + context.cycles.length + " cycle(s): " + rendered + ".");
    this.name = "BoardTaskLinkCycleAggregateError";
    this.context = context;
  }
}
