export const LEGION_BOARD_VERSION = "0.1.0" as const;

export {
  BOARD_LEASE_RELEASE_REASONS,
  BOARD_LEASE_TOKEN_MIN_LENGTH,
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_SCHEMA_VERSION,
  BOARD_TASK_GENERATION_MIN,
  BOARD_TASK_PRIORITY_MAX,
  BOARD_TASK_PRIORITY_MIN,
  BOARD_TASK_STATUSES,
  BOARD_TASK_STATUS_TRANSITIONS,
  BoardClaimAlreadyReleasedError,
  BoardClaimContendedError,
  BoardClaimGenerationError,
  BoardClaimNotFoundError,
  BoardConcurrencyError,
  BoardIllegalStatusTransitionError,
  BoardTaskNotFoundError,
  BoardTerminalTaskMutationError,
  type BoardApprovalProjection,
  type BoardClaim,
  type BoardClaimRepository,
  type BoardEventCursor,
  type BoardLeaseReleaseReason,
  type BoardMigrationReport,
  type BoardRunProjection,
  type BoardSchemaDiagnostics,
  type BoardStore,
  type BoardTask,
  type BoardTaskBlocker,
  type BoardTaskIdentity,
  type BoardTaskProjection,
  type BoardTaskRepository,
  type BoardTaskStatus,
  type BoardTaskStatusTransition,
  type BumpBoardTaskGenerationInput,
  type CreateBoardClaimInput,
  type CreateBoardTaskInput,
  type HeartbeatBoardClaimInput,
  type ListBoardTasksQuery,
  type ReclaimBoardClaimsOptions,
  type ReleaseBoardClaimInput,
  type SupersedeBoardTaskInput,
  type SupersedeBoardTaskResult
} from "@legion/board-store";

// P03-T03: Board event append + projection rebuild surface.
export {
  BOARD_EVENT_AGGREGATE_KINDS,
  BOARD_EVENT_SCHEMA_VERSION,
  BOARD_EVENT_TYPES,
  BOARD_PROJECTION_KEY_MAX_LENGTH,
  BOARD_PROJECTION_KEY_PATTERN,
  BoardEventAppendError,
  BoardProjectionDriftError,
  type AppendBoardEventInput,
  type AppendBoardEventsInput,
  type BoardEvent,
  type BoardEventAggregateKind,
  type BoardEventAppendBatchResult,
  type BoardEventAppendErrorContext,
  type BoardEventAppendResult,
  type BoardEventEnvelope,
  type BoardEventQuery,
  type BoardEventRepository,
  type BoardEventType,
  type BoardProjectionRebuildReport,
  type BoardProjectionRebuilder,
  type BoardProjectionRecord,
  type BoardProjectionRepository,
  type BoardProjectionState,
  type BoardProjectionDrift,
  type BoardTaskEventHook,
  type BoardTaskMutationKind,
  type BoardTaskRepositoryWithHooks,
  type SaveBoardProjectionInput
} from "@legion/board-store";

// P03-T07: Board approval lifecycle surface.
export {
  BOARD_APPROVAL_LIFECYCLE_PHASES,
  BOARD_APPROVAL_STATUSES,
  BOARD_APPROVAL_STATUS_TRANSITIONS,
  BOARD_APPROVAL_TERMINAL_STATUSES,
  BoardApprovalAlreadyExistsError,
  BoardApprovalConcurrencyError,
  BoardApprovalIllegalStatusTransitionError,
  BoardApprovalNotFoundError,
  BoardApprovalTerminalStatusError,
  type BoardApproval,
  type BoardApprovalActor,
  type BoardApprovalLifecyclePhase,
  type BoardApprovalRepository,
  type BoardApprovalScope,
  type BoardApprovalStatus,
  type CreateBoardApprovalInput,
  type DecideBoardApprovalInput,
  type ExpireBoardApprovalInput,
  type ListBoardApprovalsQuery,
  type RevokeBoardApprovalInput
} from "@legion/board-store";

// P03-T08: Board task link repository surface.
export {
  BOARD_TASK_LINK_DAG_RELATIONS,
  BOARD_TASK_LINK_RELATIONS,
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
  type CreateBoardTaskLinkInput,
  type ListBoardTaskLinksQuery
} from "@legion/board-store";

// Board task comment repository surface.
export {
  BOARD_OUTBOX_EFFECT_CLASSES,
  BOARD_OUTBOX_STATUSES,
  BoardOutboxConcurrencyError,
  BoardOutboxNotFoundError,
  BoardOutboxTerminalStatusError,
  type BoardOutbox,
  type BoardOutboxEffectClass,
  type BoardOutboxRepository,
  type BoardOutboxStatus,
  type ClaimBoardOutboxInput,
  type CreateBoardOutboxInput,
  type ListBoardOutboxQuery,
  type MarkBoardOutboxAttemptInput,
  BOARD_TASK_COMMENT_BODY_MAX_LENGTH,
  BoardTaskCommentNotFoundError,
  type BoardTaskComment,
  type BoardTaskCommentActor,
  type BoardTaskCommentRepository,
  type CreateBoardTaskCommentInput,
  type ListBoardTaskCommentsQuery,
  type UpdateBoardTaskCommentInput
} from "@legion/board-store";

// =====================================================================
// P09-T02 — Whole-change acceptance aggregator (board adapter layer).
// Bridges the merge queue's `MergeIntegrationDecision` to the board's
// event log + projection store. Re-exports the typed contract, the
// pure reducer, the aggregator, the projector, and the deterministic
// hashing helpers.
// =====================================================================

export {
  buildWholeChangeAcceptance,
  deriveWholeChangeAggregateId,
  deriveWholeChangeAggregatorHash,
  deriveWholeChangeEventPayloadHash,
  deriveWholeChangeProjectionState,
  deriveWholeChangeProjectionStateHash,
  isWholeChangeAcceptanceProjectionKey,
  mapOutcomeToStatus,
  parseWholeChangeAcceptanceProjectionKey,
  parseWholeChangeAggregatedPayload,
  reduceWholeChangeAcceptance,
  replayWholeChangeAcceptance,
  sha256OfCanonical,
  verifyWholeChangeAcceptanceState,
  wholeChangeAcceptanceProjectionDescriptor,
  wholeChangeAcceptanceProjectionKey,
  WholeChangeAcceptanceAggregator,
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
  WHOLE_CHANGE_AGGREGATE_KIND_LITERAL,
  WHOLE_CHANGE_AGGREGATE_KINDS,
  WHOLE_CHANGE_EVENT_TYPES,
  WHOLE_CHANGE_HASH_VERSION,
  WHOLE_CHANGE_PROJECTION_KEY_PREFIX,
  WHOLE_CHANGE_PROJECTION_VERSION,
  type ChangeId
} from "./whole-change/index.js";

export type {
  WholeChangeAcceptanceAggregatorFailure,
  WholeChangeAcceptanceAggregatorInput,
  WholeChangeAcceptanceAggregatorOptions,
  WholeChangeAcceptanceAggregatorResult,
  WholeChangeAcceptanceAggregatorSuccess,
  WholeChangeAcceptanceProjectionDescriptor,
  WholeChangeAcceptanceReducer,
  WholeChangeAcceptanceState,
  WholeChangeAcceptanceStatus,
  WholeChangeAggregateId,
  WholeChangeAggregateKind,
  WholeChangeAggregatedPayload,
  WholeChangeAggregatorIssue,
  WholeChangeAggregatorIssueCode,
  WholeChangeEventPayload,
  WholeChangeEventType
} from "./whole-change/index.js";
