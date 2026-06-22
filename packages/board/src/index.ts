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

// =====================================================================
// P10-T01 — Release observation board adapter.
// Bridges the release-observation orchestrator's
// `ReleaseObservationReport` to the board's event log + projection
// store. Re-exports the typed contract, the pure reducer, the
// aggregator, and the deterministic hashing helpers.
// =====================================================================

export {
  buildReleaseObservationBoardEvent,
  deriveReleaseObservationAggregateId,
  deriveReleaseObservationEventPayloadHash,
  deriveReleaseObservationProjectionStateHash,
  eventTypeForReleaseObservationStatus,
  isReleaseObservationEventType,
  makeReleaseObservationReducer,
  parseReleaseObservationProjectionKey,
  reduceReleaseObservation,
  releaseObservationIdempotencyKey,
  releaseObservationProjectionDescriptor,
  releaseObservationProjectionKey,
  replayReleaseObservation,
  sha256OfCanonical as releaseObservationSha256OfCanonical,
  ReleaseObservationBoardAggregator,
  RELEASE_OBSERVATION_AGGREGATE_KIND_LITERAL,
  RELEASE_OBSERVATION_AGGREGATE_KINDS,
  RELEASE_OBSERVATION_ADAPTER_HASH_VERSION,
  RELEASE_OBSERVATION_ADAPTER_KIND,
  RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
  RELEASE_OBSERVATION_BOARD_EVENT_TYPES,
  RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX,
  RELEASE_OBSERVATION_PROJECTION_VERSION,
  RELEASE_OBSERVATION_REDUCER_KIND,
  RELEASE_OBSERVATION_REDUCER_KIND_LITERAL,
  type ContentHash
} from "./release-observation/index.js";

export type {
  ReleaseObservationBoardAggregatorFailure,
  ReleaseObservationBoardAggregatorInput,
  ReleaseObservationBoardAggregatorOptions,
  ReleaseObservationBoardAggregatorResult,
  ReleaseObservationBoardAggregatorSuccess,
  ReleaseObservationBoardIssue,
  ReleaseObservationBoardIssueCode,
  ReleaseObservationBoardEventType,
  ReleaseObservationReducer,
  ReleaseObservationAggregateId,
  ReleaseObservationAggregateKind,
  ReleaseObservationAdapterKey,
  ReleaseObservationProjectionDescriptor,
  ReleaseObservationProjectionState
} from "./release-observation/index.js";

// =====================================================================
// P11-T01 — Dashboard projection (board adapter layer).
// Cross-aggregate read projection over the board event log:
// task counts, event timeline, release-observation verdict
// pointers, approval verdict pointers. Re-exports the typed
// contract, the pure reducer, the hash helpers, and the
// projection descriptor.
// =====================================================================

export {
  DASHBOARD_ADAPTER_KEYS,
  DASHBOARD_ADAPTER_KIND,
  DASHBOARD_ADAPTER_SCHEMA_VERSION,
  DASHBOARD_APPROVAL_VERDICTS,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  DASHBOARD_KNOWN_RELEASE_STATUSES,
  DASHBOARD_MAX_TAIL_LIMIT,
  DASHBOARD_PROJECTION_KEY_PREFIX,
  DASHBOARD_PROJECTION_VERSION,
  DASHBOARD_REDUCER_KIND,
  DASHBOARD_REDUCER_KIND_LITERAL,
  DASHBOARD_RELEASE_STATUSES,
  DASHBOARD_TIMELINE_KEY,
  dashboardProjectionKey,
  deriveDashboardProjectionStateHash,
  isDashboardProjectionState,
  makeDashboardReducer,
  makeInitialDashboardState,
  parseDashboardProjectionKey,
  reduceDashboard,
  replayDashboard,
  sha256OfCanonicalDashboardInput
} from "./dashboard/index.js";

export type {
  DashboardAdapterKey,
  DashboardAggregateKindCounts,
  DashboardApprovalPointer,
  DashboardApprovalVerdict,
  DashboardEventTailEntry,
  DashboardProjectionDescriptor,
  DashboardProjectionState,
  DashboardReducer,
  DashboardReleaseObservationPointer,
  DashboardReleaseStatus,
  DashboardTaskStatusCounts,
  ReduceDashboardOptions,
  ProjectId
} from "./dashboard/index.js";

// =====================================================================
// P11-T01 — Approval-gate projection (board adapter layer).
// Per-(projectId, changeId) read projection that ties the
// Phase 9 whole-change acceptance verdict and the Phase 10
// release-observation verdict into a single operator-facing
// ApprovalGateVerdict. Re-exports the typed contract, the
// pure reducer, the projection descriptor, and the verdict
// decision helper.
// =====================================================================

export {
  APPROVAL_GATE_ADAPTER_KEYS,
  APPROVAL_GATE_ADAPTER_KIND,
  APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
  APPROVAL_GATE_PROJECTION_KEY_PREFIX,
  APPROVAL_GATE_PROJECTION_VERSION,
  APPROVAL_GATE_REDUCER_KIND,
  APPROVAL_GATE_REDUCER_KIND_LITERAL,
  APPROVAL_GATE_VERDICTS,
  approvalGateProjectionKey,
  decideApprovalGateVerdict,
  isApprovalGateProjectionState,
  makeApprovalGateReducer,
  makeInitialApprovalGateState,
  parseApprovalGateProjectionKey,
  reduceApprovalGate,
  replayApprovalGate
} from "./approval-gate/index.js";

export type {
  ApprovalGateAdapterKey,
  ApprovalGateAggregateId,
  ApprovalGateProjectionDescriptor,
  ApprovalGateProjectionState,
  ApprovalGateReducer,
  ApprovalGateVerdict
} from "./approval-gate/index.js";
