import {
  actorSchema,
  blockerSchema,
  evidenceIdSchema,
  observationIdSchema,
  releaseIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema
} from "@legion/protocol";
import type {
  Actor,
  ApprovalId,
  Blocker,
  ChangeId,
  CommandEnvelope,
  ContractId,
  EventEnvelope,
  EventType,
  EvidenceId,
  ObservationId,
  ProjectId,
  ReleaseId,
  ReviewId,
  RunId,
  TaskId
} from "@legion/protocol";

import {
  acceptTransition,
  rejectIfGenerationMismatch,
  rejectTransition
} from "../transition.js";
import type {
  ExpectedGenerationInput,
  RejectedTransition,
  TransitionDecision
} from "../transition.js";

const COMMON_CONTROL_STATES = ["blocked", "needs_human", "needs_replan", "stale", "invalidated", "canceled"] as const;

export const CHANGE_LIFECYCLE_STATES = [
  "draft",
  "proposed",
  "approved",
  "planned",
  "in_progress",
  "verifying",
  "accepted",
  "rejected",
  "archived",
  ...COMMON_CONTROL_STATES
] as const;

export const TASK_LIFECYCLE_STATES = [
  "queued",
  "ready",
  "claimed",
  "running",
  "completed",
  "failed",
  "superseded",
  ...COMMON_CONTROL_STATES
] as const;

export const TASK_RUN_LIFECYCLE_STATES = [
  "created",
  "started",
  "succeeded",
  "failed",
  "superseded",
  ...COMMON_CONTROL_STATES
] as const;

export const REVIEW_LIFECYCLE_STATES = [
  "requested",
  "submitted",
  "accepted",
  "rejected",
  "superseded",
  "unknown",
  ...COMMON_CONTROL_STATES
] as const;

export const APPROVAL_LIFECYCLE_STATES = [
  "requested",
  "granted",
  "denied",
  "expired",
  "revoked",
  ...COMMON_CONTROL_STATES
] as const;

export const INTEGRATION_LIFECYCLE_STATES = [
  "pending",
  "intent_recorded",
  "effect_succeeded",
  "effect_failed",
  ...COMMON_CONTROL_STATES
] as const;

export const RELEASE_LIFECYCLE_STATES = [
  "requested",
  "staging",
  "deployed",
  "healthy",
  "failed",
  "rollback_required",
  "rolled_back",
  "forward_fix_required",
  "superseded",
  ...COMMON_CONTROL_STATES
] as const;

export const OBSERVATION_LIFECYCLE_STATES = [
  "pending",
  "observing",
  "healthy",
  "degraded",
  "failed",
  "rolled_back",
  "forward_fix_required",
  "unknown",
  ...COMMON_CONTROL_STATES
] as const;

export type ChangeLifecycleState = (typeof CHANGE_LIFECYCLE_STATES)[number];
export type TaskLifecycleState = (typeof TASK_LIFECYCLE_STATES)[number];
export type TaskRunLifecycleState = (typeof TASK_RUN_LIFECYCLE_STATES)[number];
export type ReviewLifecycleState = (typeof REVIEW_LIFECYCLE_STATES)[number];
export type ApprovalLifecycleState = (typeof APPROVAL_LIFECYCLE_STATES)[number];
export type IntegrationLifecycleState = (typeof INTEGRATION_LIFECYCLE_STATES)[number];
export type ReleaseLifecycleState = (typeof RELEASE_LIFECYCLE_STATES)[number];
export type ObservationLifecycleState = (typeof OBSERVATION_LIFECYCLE_STATES)[number];

export interface TransitionRule<State extends string> {
  readonly from: State;
  readonly eventType: EventType;
  readonly to: State;
}

export interface TransitionMatrix<Aggregate extends string, State extends string> {
  readonly aggregate: Aggregate;
  readonly states: readonly State[];
  readonly terminalStates: readonly State[];
  readonly transitions: readonly TransitionRule<State>[];
}

const CHANGE_TERMINAL_STATES = ["accepted", "rejected", "archived", "invalidated", "canceled"] as const;
const TASK_TERMINAL_STATES = ["completed", "failed", "superseded", "invalidated", "canceled"] as const;
const TASK_RUN_TERMINAL_STATES = ["succeeded", "failed", "superseded", "invalidated", "canceled"] as const;
const REVIEW_TERMINAL_STATES = ["accepted", "rejected", "superseded", "invalidated", "canceled"] as const;
const APPROVAL_TERMINAL_STATES = ["granted", "denied", "expired", "revoked", "invalidated", "canceled"] as const;
const INTEGRATION_TERMINAL_STATES = ["effect_succeeded", "effect_failed", "invalidated", "canceled"] as const;
const RELEASE_TERMINAL_STATES = ["healthy", "rolled_back", "forward_fix_required", "superseded", "invalidated", "canceled"] as const;
const OBSERVATION_TERMINAL_STATES = ["healthy", "failed", "rolled_back", "forward_fix_required", "invalidated", "canceled"] as const;
const TASK_RETRYABLE_TERMINAL_STATES = ["completed", "failed"] as const;
const TASK_INVALIDATABLE_STATES = ["queued", "ready", "claimed", "running", "blocked", "needs_human", "needs_replan", "stale"] as const;

export const CHANGE_TRANSITION_MATRIX: TransitionMatrix<"change", ChangeLifecycleState> = {
  aggregate: "change",
  states: CHANGE_LIFECYCLE_STATES,
  terminalStates: CHANGE_TERMINAL_STATES,
  transitions: [
    { from: "draft", eventType: "change.proposed.v1", to: "proposed" },
    { from: "proposed", eventType: "artifact_revision.recorded.v1", to: "approved" },
    { from: "approved", eventType: "artifact_revision.recorded.v1", to: "planned" },
    { from: "planned", eventType: "task.created.v1", to: "in_progress" },
    { from: "in_progress", eventType: "review.submitted.v1", to: "verifying" }
  ]
};

export const TASK_TRANSITION_MATRIX: TransitionMatrix<"task", TaskLifecycleState> = {
  aggregate: "task",
  states: TASK_LIFECYCLE_STATES,
  terminalStates: TASK_TERMINAL_STATES,
  transitions: [
    { from: "queued", eventType: "task.created.v1", to: "ready" },
    { from: "ready", eventType: "task.claimed.v1", to: "claimed" },
    { from: "claimed", eventType: "task.heartbeat_recorded.v1", to: "running" },
    { from: "running", eventType: "task.blocked.v1", to: "blocked" },
    { from: "running", eventType: "review.submitted.v1", to: "needs_replan" },
    { from: "running", eventType: "task.completed.v1", to: "completed" },
    { from: "blocked", eventType: "task.retry_scheduled.v1", to: "ready" },
    { from: "needs_replan", eventType: "task.retry_scheduled.v1", to: "ready" },
    { from: "completed", eventType: "task.retry_scheduled.v1", to: "ready" },
    { from: "failed", eventType: "task.retry_scheduled.v1", to: "ready" },
    { from: "queued", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "ready", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "claimed", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "running", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "blocked", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "needs_human", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "needs_replan", eventType: "task.invalidated.v1", to: "invalidated" },
    { from: "stale", eventType: "task.invalidated.v1", to: "invalidated" }
  ]
};

export const TASK_RUN_TRANSITION_MATRIX: TransitionMatrix<"taskRun", TaskRunLifecycleState> = {
  aggregate: "taskRun",
  states: TASK_RUN_LIFECYCLE_STATES,
  terminalStates: TASK_RUN_TERMINAL_STATES,
  transitions: [
    { from: "created", eventType: "run.started.v1", to: "started" },
    { from: "started", eventType: "run.finished.v1", to: "succeeded" },
    { from: "started", eventType: "run.finished.v1", to: "failed" },
    { from: "started", eventType: "run.finished.v1", to: "blocked" },
    { from: "started", eventType: "run.finished.v1", to: "canceled" },
    { from: "started", eventType: "input.recorded.v1", to: "needs_human" },
    { from: "needs_human", eventType: "run.finished.v1", to: "succeeded" },
    { from: "needs_human", eventType: "run.finished.v1", to: "failed" },
    { from: "needs_human", eventType: "run.finished.v1", to: "blocked" },
    { from: "needs_human", eventType: "run.finished.v1", to: "canceled" }
  ]
};

export const REVIEW_TRANSITION_MATRIX: TransitionMatrix<"review", ReviewLifecycleState> = {
  aggregate: "review",
  states: REVIEW_LIFECYCLE_STATES,
  terminalStates: REVIEW_TERMINAL_STATES,
  transitions: [
    { from: "unknown", eventType: "review.submitted.v1", to: "submitted" },
    { from: "unknown", eventType: "review.submitted.v1", to: "accepted" },
    { from: "unknown", eventType: "review.submitted.v1", to: "rejected" },
    { from: "requested", eventType: "review.submitted.v1", to: "submitted" },
    { from: "requested", eventType: "review.submitted.v1", to: "accepted" },
    { from: "requested", eventType: "review.submitted.v1", to: "rejected" }
  ]
};

export const APPROVAL_TRANSITION_MATRIX: TransitionMatrix<"approval", ApprovalLifecycleState> = {
  aggregate: "approval",
  states: APPROVAL_LIFECYCLE_STATES,
  terminalStates: APPROVAL_TERMINAL_STATES,
  transitions: [
    { from: "requested", eventType: "approval.granted.v1", to: "granted" },
    { from: "requested", eventType: "approval.denied.v1", to: "denied" }
  ]
};

export const INTEGRATION_TRANSITION_MATRIX: TransitionMatrix<"integration", IntegrationLifecycleState> = {
  aggregate: "integration",
  states: INTEGRATION_LIFECYCLE_STATES,
  terminalStates: INTEGRATION_TERMINAL_STATES,
  transitions: [
    { from: "pending", eventType: "integration.outbox_intent_recorded.v1", to: "intent_recorded" },
    { from: "intent_recorded", eventType: "integration.effect_succeeded.v1", to: "effect_succeeded" },
    { from: "intent_recorded", eventType: "integration.effect_failed.v1", to: "effect_failed" }
  ]
};

export const RELEASE_TRANSITION_MATRIX: TransitionMatrix<"release", ReleaseLifecycleState> = {
  aggregate: "release",
  states: RELEASE_LIFECYCLE_STATES,
  terminalStates: RELEASE_TERMINAL_STATES,
  transitions: [
    { from: "requested", eventType: "release.requested.v1", to: "staging" },
    { from: "requested", eventType: "release.deployed.v1", to: "deployed" },
    { from: "staging", eventType: "release.deployed.v1", to: "deployed" },
    { from: "deployed", eventType: "observation.recorded.v1", to: "healthy" },
    { from: "deployed", eventType: "observation.recorded.v1", to: "failed" },
    { from: "deployed", eventType: "observation.recorded.v1", to: "rollback_required" },
    { from: "deployed", eventType: "observation.recorded.v1", to: "forward_fix_required" },
    { from: "deployed", eventType: "release.rolled_back.v1", to: "rolled_back" },
    { from: "failed", eventType: "release.rolled_back.v1", to: "rolled_back" },
    { from: "rollback_required", eventType: "release.rolled_back.v1", to: "rolled_back" }
  ]
};

export const OBSERVATION_TRANSITION_MATRIX: TransitionMatrix<"observation", ObservationLifecycleState> = {
  aggregate: "observation",
  states: OBSERVATION_LIFECYCLE_STATES,
  terminalStates: OBSERVATION_TERMINAL_STATES,
  transitions: [
    { from: "pending", eventType: "observation.recorded.v1", to: "observing" },
    { from: "pending", eventType: "observation.recorded.v1", to: "healthy" },
    { from: "pending", eventType: "observation.recorded.v1", to: "degraded" },
    { from: "pending", eventType: "observation.recorded.v1", to: "failed" },
    { from: "pending", eventType: "observation.recorded.v1", to: "rolled_back" },
    { from: "pending", eventType: "observation.recorded.v1", to: "forward_fix_required" },
    { from: "observing", eventType: "observation.recorded.v1", to: "healthy" },
    { from: "observing", eventType: "observation.recorded.v1", to: "degraded" },
    { from: "observing", eventType: "observation.recorded.v1", to: "failed" },
    { from: "observing", eventType: "observation.recorded.v1", to: "rolled_back" },
    { from: "observing", eventType: "observation.recorded.v1", to: "forward_fix_required" },
    { from: "degraded", eventType: "observation.recorded.v1", to: "failed" }
  ]
};

export const STATE_MACHINE_TRANSITION_MATRICES = {
  change: CHANGE_TRANSITION_MATRIX,
  task: TASK_TRANSITION_MATRIX,
  taskRun: TASK_RUN_TRANSITION_MATRIX,
  review: REVIEW_TRANSITION_MATRIX,
  approval: APPROVAL_TRANSITION_MATRIX,
  integration: INTEGRATION_TRANSITION_MATRIX,
  release: RELEASE_TRANSITION_MATRIX,
  observation: OBSERVATION_TRANSITION_MATRIX
} as const;

export interface ChangeMachineState {
  readonly kind: "change";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly status: ChangeLifecycleState;
  readonly generation: number;
}

export interface TaskMachineState {
  readonly kind: "task";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly contractId: ContractId;
  readonly contractRevision: number;
  readonly priority: number;
  readonly status: TaskLifecycleState;
  readonly generation: number;
  readonly runId?: RunId;
  readonly claimedBy?: Actor;
  readonly blockers: readonly Blocker[];
  readonly evidenceRefs: readonly EvidenceId[];
  readonly reviewRefs: readonly ReviewId[];
  readonly passedReviewRefs: readonly ReviewId[];
}

export interface TaskRunMachineState {
  readonly kind: "task-run";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly status: TaskRunLifecycleState;
  readonly generation: number;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface ReviewMachineState {
  readonly kind: "review";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId?: TaskId;
  readonly reviewId: ReviewId;
  readonly status: ReviewLifecycleState;
  readonly generation: number;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface ApprovalMachineState {
  readonly kind: "approval";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly approvalId: ApprovalId;
  readonly status: ApprovalLifecycleState;
  readonly generation: number;
}

export interface IntegrationMachineState {
  readonly kind: "integration";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly runId: RunId;
  readonly status: IntegrationLifecycleState;
  readonly generation: number;
  readonly effectKind?: string;
  readonly targetHash?: string;
}

export interface ReleaseMachineState {
  readonly kind: "release";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly releaseId: ReleaseId;
  readonly status: ReleaseLifecycleState;
  readonly generation: number;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface ObservationMachineState {
  readonly kind: "observation";
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly releaseId: ReleaseId;
  readonly observationId: ObservationId;
  readonly status: ObservationLifecycleState;
  readonly generation: number;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface CreateChangeStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly status?: ChangeLifecycleState;
  readonly generation?: number;
}

export interface CreateTaskStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly contractId: ContractId;
  readonly contractRevision: number;
  readonly priority: number;
  readonly status?: TaskLifecycleState;
  readonly generation?: number;
  readonly runId?: RunId;
  readonly claimedBy?: Actor;
  readonly blockers?: readonly Blocker[];
  readonly evidenceRefs?: readonly EvidenceId[];
  readonly reviewRefs?: readonly ReviewId[];
  readonly passedReviewRefs?: readonly ReviewId[];
}

export interface CreateTaskRunStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly status?: TaskRunLifecycleState;
  readonly generation?: number;
  readonly evidenceRefs?: readonly EvidenceId[];
}

export interface CreateReviewStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId?: TaskId;
  readonly reviewId: ReviewId;
  readonly status?: ReviewLifecycleState;
  readonly generation?: number;
  readonly evidenceRefs?: readonly EvidenceId[];
}

export interface CreateApprovalStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly approvalId: ApprovalId;
  readonly status?: ApprovalLifecycleState;
  readonly generation?: number;
}

export interface CreateIntegrationStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly runId: RunId;
  readonly status?: IntegrationLifecycleState;
  readonly generation?: number;
  readonly effectKind?: string;
  readonly targetHash?: string;
}

export interface CreateReleaseStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly releaseId: ReleaseId;
  readonly status?: ReleaseLifecycleState;
  readonly generation?: number;
  readonly evidenceRefs?: readonly EvidenceId[];
}

export interface CreateObservationStateInput {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly releaseId: ReleaseId;
  readonly observationId: ObservationId;
  readonly status?: ObservationLifecycleState;
  readonly generation?: number;
  readonly evidenceRefs?: readonly EvidenceId[];
}

export function createChangeState(input: CreateChangeStateInput): ChangeMachineState {
  return {
    kind: "change",
    projectId: input.projectId,
    changeId: input.changeId,
    status: input.status ?? "draft",
    generation: input.generation ?? 1
  };
}

export function createTaskState(input: CreateTaskStateInput): TaskMachineState {
  const state: TaskMachineState = {
    kind: "task",
    projectId: input.projectId,
    changeId: input.changeId,
    taskId: input.taskId,
    contractId: input.contractId,
    contractRevision: input.contractRevision,
    priority: input.priority,
    status: input.status ?? "queued",
    generation: input.generation ?? 1,
    blockers: input.blockers ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    reviewRefs: input.reviewRefs ?? [],
    passedReviewRefs: input.passedReviewRefs ?? []
  };

  return {
    ...state,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.claimedBy ? { claimedBy: input.claimedBy } : {})
  };
}

export function createTaskRunState(input: CreateTaskRunStateInput): TaskRunMachineState {
  return {
    kind: "task-run",
    projectId: input.projectId,
    changeId: input.changeId,
    taskId: input.taskId,
    runId: input.runId,
    status: input.status ?? "created",
    generation: input.generation ?? 1,
    evidenceRefs: input.evidenceRefs ?? []
  };
}

export function createReviewState(input: CreateReviewStateInput): ReviewMachineState {
  return {
    kind: "review",
    projectId: input.projectId,
    changeId: input.changeId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    reviewId: input.reviewId,
    status: input.status ?? "requested",
    generation: input.generation ?? 1,
    evidenceRefs: input.evidenceRefs ?? []
  };
}

export function createApprovalState(input: CreateApprovalStateInput): ApprovalMachineState {
  return {
    kind: "approval",
    projectId: input.projectId,
    changeId: input.changeId,
    approvalId: input.approvalId,
    status: input.status ?? "requested",
    generation: input.generation ?? 1
  };
}

export function createIntegrationState(input: CreateIntegrationStateInput): IntegrationMachineState {
  return {
    kind: "integration",
    projectId: input.projectId,
    changeId: input.changeId,
    runId: input.runId,
    status: input.status ?? "pending",
    generation: input.generation ?? 1,
    ...(input.effectKind ? { effectKind: input.effectKind } : {}),
    ...(input.targetHash ? { targetHash: input.targetHash } : {})
  };
}

export function createReleaseState(input: CreateReleaseStateInput): ReleaseMachineState {
  return {
    kind: "release",
    projectId: input.projectId,
    changeId: input.changeId,
    releaseId: input.releaseId,
    status: input.status ?? "requested",
    generation: input.generation ?? 1,
    evidenceRefs: input.evidenceRefs ?? []
  };
}

export function createObservationState(input: CreateObservationStateInput): ObservationMachineState {
  return {
    kind: "observation",
    projectId: input.projectId,
    changeId: input.changeId,
    releaseId: input.releaseId,
    observationId: input.observationId,
    status: input.status ?? "pending",
    generation: input.generation ?? 1,
    evidenceRefs: input.evidenceRefs ?? []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadRecord(eventOrCommand: { readonly payload: unknown }): Record<string, unknown> {
  return isRecord(eventOrCommand.payload) ? eventOrCommand.payload : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function taskIdField(payload: Record<string, unknown>): TaskId | undefined {
  const result = taskIdSchema.safeParse(payload["taskId"]);
  return result.success ? result.data : undefined;
}

function runIdField(payload: Record<string, unknown>): RunId | undefined {
  const result = runIdSchema.safeParse(payload["runId"]);
  return result.success ? result.data : undefined;
}

function evidenceIdField(payload: Record<string, unknown>): EvidenceId | undefined {
  const result = evidenceIdSchema.safeParse(payload["evidenceId"]);
  return result.success ? result.data : undefined;
}

function reviewIdField(payload: Record<string, unknown>): ReviewId | undefined {
  const result = reviewIdSchema.safeParse(payload["reviewId"]);
  return result.success ? result.data : undefined;
}

function releaseIdField(payload: Record<string, unknown>): ReleaseId | undefined {
  const result = releaseIdSchema.safeParse(payload["releaseId"]);
  return result.success ? result.data : undefined;
}

function observationIdField(payload: Record<string, unknown>): ObservationId | undefined {
  const result = observationIdSchema.safeParse(payload["observationId"]);
  return result.success ? result.data : undefined;
}

function actorField(payload: Record<string, unknown>, key: string): Actor | undefined {
  const result = actorSchema.safeParse(payload[key]);
  return result.success ? result.data : undefined;
}

function blockerField(payload: Record<string, unknown>): Blocker | undefined {
  const result = blockerSchema.safeParse(payload["blocker"]);
  return result.success ? result.data : undefined;
}

function evidenceRefsField(payload: Record<string, unknown>): readonly EvidenceId[] {
  const value = payload["evidenceRefs"];
  if (!Array.isArray(value)) return [];

  const refs: EvidenceId[] = [];
  for (const item of value) {
    const result = evidenceIdSchema.safeParse(item);
    if (result.success) refs.push(result.data);
  }
  return refs;
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function appendUnique<T>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values : [...values, value];
}

function appendUniqueMany<T>(values: readonly T[], additions: readonly T[]): readonly T[] {
  return additions.reduce((current, value) => appendUnique(current, value), values);
}

function isSubset<T>(candidate: readonly T[], source: readonly T[]): boolean {
  return candidate.every((value) => source.includes(value));
}

function sameAggregate(event: EventEnvelope, kind: EventEnvelope["aggregate"]["kind"], id: string): boolean {
  return event.aggregate.kind === kind && event.aggregate.id === id;
}

function newerOrSameGeneration(state: { readonly generation: number }, event: EventEnvelope): boolean {
  return event.generation >= state.generation;
}

function matchesCurrentChange(event: EventEnvelope, changeId: ChangeId): boolean {
  return !event.changeId || event.changeId === changeId;
}

export function reduceChangeState(state: ChangeMachineState, event: EventEnvelope): ChangeMachineState {
  if (event.changeId === state.changeId && newerOrSameGeneration(state, event) && !includesString(CHANGE_TERMINAL_STATES, state.status)) {
    if (state.status === "planned" && event.type === "task.created.v1") {
      return { ...state, status: "in_progress", generation: event.generation };
    }

    if (state.status === "in_progress" && event.type === "review.submitted.v1") {
      return { ...state, status: "verifying", generation: event.generation };
    }
  }

  if (!sameAggregate(event, "change", state.changeId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(CHANGE_TERMINAL_STATES, state.status)) return state;

  if (state.status === "draft" && event.type === "change.proposed.v1") {
    return { ...state, status: "proposed", generation: event.generation };
  }

  if (event.type === "artifact_revision.recorded.v1") {
    if (state.status === "proposed") return { ...state, status: "approved", generation: event.generation };
    if (state.status === "approved") return { ...state, status: "planned", generation: event.generation };
  }

  return state;
}

export function reduceTaskState(state: TaskMachineState, event: EventEnvelope): TaskMachineState {
  const payload = payloadRecord(event);

  if (event.type === "evidence.collected.v1") {
    const taskId = taskIdField(payload);
    const evidenceId = evidenceIdField(payload);
    const runId = runIdField(payload);
    if (taskId !== state.taskId || !evidenceId) return state;
    if (!matchesCurrentChange(event, state.changeId) || includesString(TASK_TERMINAL_STATES, state.status)) return state;
    if (state.runId && runId !== state.runId) return state;
    return {
      ...state,
      evidenceRefs: appendUnique(state.evidenceRefs, evidenceId)
    };
  }

  if (event.type === "review.submitted.v1") {
    const taskId = taskIdField(payload);
    const reviewId = reviewIdField(payload);
    if (taskId !== state.taskId || !reviewId) return state;
    if (!matchesCurrentChange(event, state.changeId) || includesString(TASK_TERMINAL_STATES, state.status)) return state;

    const reviewRefs = appendUnique(state.reviewRefs, reviewId);
    const verdict = stringField(payload, "verdict");
    if (verdict === "pass") {
      return {
        ...state,
        reviewRefs,
        passedReviewRefs: appendUnique(state.passedReviewRefs, reviewId)
      };
    }

    if (verdict === "fail") {
      return {
        ...state,
        status: includesString(TASK_TERMINAL_STATES, state.status) ? state.status : "needs_replan",
        reviewRefs
      };
    }

    return {
      ...state,
      status: includesString(TASK_TERMINAL_STATES, state.status) ? state.status : "needs_human",
      reviewRefs
    };
  }

  if (!sameAggregate(event, "task", state.taskId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;

  if (includesString(TASK_TERMINAL_STATES, state.status)) {
    if (
      event.type !== "task.retry_scheduled.v1" ||
      event.generation <= state.generation ||
      !includesString(TASK_RETRYABLE_TERMINAL_STATES, state.status)
    ) {
      return state;
    }
    const retryRunId = runIdField(payload);
    const retried: TaskMachineState = {
      ...state,
      status: "ready",
      generation: event.generation,
      blockers: [],
      evidenceRefs: [],
      reviewRefs: [],
      passedReviewRefs: []
    };
    return retryRunId ? { ...retried, runId: retryRunId } : retried;
  }

  switch (event.type) {
    case "task.created.v1":
      if (state.status !== "queued") return state;
      return {
        ...state,
        status: "ready",
        generation: event.generation
      };
    case "task.claimed.v1": {
      if (state.status !== "ready") return state;
      const runId = runIdField(payload);
      const claimedBy = actorField(payload, "claimedBy");
      if (!runId || !claimedBy) return state;
      return {
        ...state,
        status: "claimed",
        runId,
        claimedBy,
        generation: event.generation
      };
    }
    case "task.heartbeat_recorded.v1": {
      if (state.status !== "claimed" && state.status !== "running") return state;
      const runId = runIdField(payload);
      if (state.runId && runId !== state.runId) return state;
      const heartbeatStatus = stringField(payload, "status");
      return {
        ...state,
        status: heartbeatStatus === "waiting" ? "needs_human" : "running",
        generation: event.generation
      };
    }
    case "task.blocked.v1": {
      if (state.status !== "running" && state.status !== "claimed" && state.status !== "ready" && state.status !== "blocked") return state;
      const blocker = blockerField(payload);
      return {
        ...state,
        status: "blocked",
        blockers: blocker ? [...state.blockers, blocker] : state.blockers,
        generation: event.generation
      };
    }
    case "task.retry_scheduled.v1": {
      if (state.status !== "blocked" && state.status !== "needs_replan" && state.status !== "needs_human" && state.status !== "stale") {
        return state;
      }
      return {
        ...state,
        status: "ready",
        generation: event.generation,
        blockers: []
      };
    }
    case "task.completed.v1": {
      if (state.status !== "running") return state;
      const evidenceRefs = evidenceRefsField(payload);
      if (evidenceRefs.length === 0) return state;
      return {
        ...state,
        status: "completed",
        evidenceRefs: appendUniqueMany(state.evidenceRefs, evidenceRefs),
        generation: event.generation
      };
    }
    case "task.invalidated.v1":
      if (!includesString(TASK_INVALIDATABLE_STATES, state.status)) return state;
      return {
        ...state,
        status: "invalidated",
        generation: event.generation
      };
    default:
      return state;
  }
}

export function reduceTaskEvents(state: TaskMachineState, events: readonly EventEnvelope[]): TaskMachineState {
  return events.reduce((current, event) => reduceTaskState(current, event), state);
}

export function reduceTaskRunState(state: TaskRunMachineState, event: EventEnvelope): TaskRunMachineState {
  if (!sameAggregate(event, "run", state.runId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(TASK_RUN_TERMINAL_STATES, state.status)) return state;

  if (state.status === "created" && event.type === "run.started.v1") {
    return { ...state, status: "started", generation: event.generation };
  }

  if ((state.status === "started" || state.status === "needs_human") && event.type === "run.finished.v1") {
    const payload = payloadRecord(event);
    const runStatus = stringField(payload, "status");
    const nextStatus = runStatus === "succeeded" || runStatus === "failed" || runStatus === "blocked" || runStatus === "canceled"
      ? runStatus
      : undefined;
    if (!nextStatus) return state;
    return {
      ...state,
      status: nextStatus,
      generation: event.generation,
      evidenceRefs: appendUniqueMany(state.evidenceRefs, evidenceRefsField(payload))
    };
  }

  if (state.status === "started" && event.type === "input.recorded.v1") {
    return { ...state, status: "needs_human", generation: event.generation };
  }

  return state;
}

export function reduceReviewState(state: ReviewMachineState, event: EventEnvelope): ReviewMachineState {
  if (!sameAggregate(event, "review", state.reviewId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(REVIEW_TERMINAL_STATES, state.status)) return state;

  if (event.type !== "review.submitted.v1") return state;

  const payload = payloadRecord(event);
  const verdict = stringField(payload, "verdict");
  const evidenceRefs = evidenceRefsField(payload);
  const status = verdict === "pass" ? "accepted" : verdict === "fail" ? "rejected" : "submitted";

  return {
    ...state,
    status,
    generation: event.generation,
    evidenceRefs: appendUniqueMany(state.evidenceRefs, evidenceRefs)
  };
}

export function reduceApprovalState(state: ApprovalMachineState, event: EventEnvelope): ApprovalMachineState {
  if (!sameAggregate(event, "approval", state.approvalId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(APPROVAL_TERMINAL_STATES, state.status)) return state;

  if (state.status !== "requested") return state;
  if (event.type === "approval.granted.v1") return { ...state, status: "granted", generation: event.generation };
  if (event.type === "approval.denied.v1") return { ...state, status: "denied", generation: event.generation };
  return state;
}

export function reduceIntegrationState(state: IntegrationMachineState, event: EventEnvelope): IntegrationMachineState {
  if (!sameAggregate(event, "run", state.runId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(INTEGRATION_TERMINAL_STATES, state.status)) return state;

  const payload = payloadRecord(event);
  const effectKind = stringField(payload, "effectKind");
  const targetHash = stringField(payload, "targetHash");
  if (event.type === "integration.outbox_intent_recorded.v1" && state.status === "pending") {
    return {
      ...state,
      status: "intent_recorded",
      generation: event.generation,
      ...(effectKind ? { effectKind } : {}),
      ...(targetHash ? { targetHash } : {})
    };
  }
  if (event.type === "integration.effect_succeeded.v1" && state.status === "intent_recorded") {
    if (!state.effectKind || !state.targetHash || effectKind !== state.effectKind || targetHash !== state.targetHash) return state;
    return { ...state, status: "effect_succeeded", generation: event.generation };
  }
  if (event.type === "integration.effect_failed.v1" && state.status === "intent_recorded") {
    if (!state.effectKind || !state.targetHash || effectKind !== state.effectKind || targetHash !== state.targetHash) return state;
    return { ...state, status: "effect_failed", generation: event.generation };
  }

  return state;
}

export function reduceReleaseState(state: ReleaseMachineState, event: EventEnvelope): ReleaseMachineState {
  const payload = payloadRecord(event);

  if (!newerOrSameGeneration(state, event)) return state;

  if (event.type === "observation.recorded.v1") {
    const releaseId = releaseIdField(payload);
    if (releaseId !== state.releaseId || state.status !== "deployed") return state;
    const observationStatus = stringField(payload, "status");
    if (observationStatus === "healthy") return { ...state, status: "healthy", generation: event.generation };
    if (observationStatus === "degraded") return { ...state, status: "failed", generation: event.generation };
    if (observationStatus === "failed") return { ...state, status: "rollback_required", generation: event.generation };
    if (observationStatus === "rolled_back") return { ...state, status: "rolled_back", generation: event.generation };
    if (observationStatus === "forward_fix_required") {
      return { ...state, status: "forward_fix_required", generation: event.generation };
    }
    return state;
  }

  if (!sameAggregate(event, "release", state.releaseId)) return state;
  if (includesString(RELEASE_TERMINAL_STATES, state.status)) return state;

  if (event.type === "release.requested.v1" && state.status === "requested") {
    return { ...state, status: "staging", generation: event.generation };
  }

  if (event.type === "release.deployed.v1" && (state.status === "requested" || state.status === "staging")) {
    return { ...state, status: "deployed", generation: event.generation };
  }

  if (event.type === "release.rolled_back.v1") {
    if (state.status !== "deployed" && state.status !== "failed" && state.status !== "rollback_required") return state;
    const evidenceRefs = evidenceRefsField(payload);
    if (evidenceRefs.length === 0) return state;
    return {
      ...state,
      status: "rolled_back",
      generation: event.generation,
      evidenceRefs: appendUniqueMany(state.evidenceRefs, evidenceRefs)
    };
  }

  return state;
}

export function reduceObservationState(state: ObservationMachineState, event: EventEnvelope): ObservationMachineState {
  if (!sameAggregate(event, "observation", state.observationId)) return state;
  if (!newerOrSameGeneration(state, event)) return state;
  if (includesString(OBSERVATION_TERMINAL_STATES, state.status)) return state;
  if (event.type !== "observation.recorded.v1") return state;

  const payload = payloadRecord(event);
  const observationId = observationIdField(payload);
  if (observationId !== state.observationId) return state;
  const status = stringField(payload, "status");
  if (
    status === "healthy" ||
    status === "degraded" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "forward_fix_required"
  ) {
    return { ...state, status, generation: event.generation, evidenceRefs: appendUniqueMany(state.evidenceRefs, evidenceRefsField(payload)) };
  }
  return state.status === "pending" ? { ...state, status: "observing", generation: event.generation } : state;
}

export interface TaskCommandDecisionInput extends ExpectedGenerationInput {
  readonly command: CommandEnvelope;
  readonly allocatedRunId?: RunId;
}

function taskCommandRoutingRejection(state: TaskMachineState, input: TaskCommandDecisionInput): RejectedTransition | undefined {
  const { command } = input;
  if (command.projectId !== state.projectId) return rejectTransition("aggregate_mismatch");
  if (command.changeId && command.changeId !== state.changeId) return rejectTransition("aggregate_mismatch");
  if (command.taskId && command.taskId !== state.taskId) return rejectTransition("aggregate_mismatch");

  const payload = payloadRecord(command);
  const taskId = taskIdField(payload);
  if (taskId && taskId !== state.taskId) return rejectTransition("aggregate_mismatch");

  const payloadRunId = runIdField(payload);
  if (payloadRunId && state.runId && payloadRunId !== state.runId) return rejectTransition("aggregate_mismatch");

  if (command.runId) {
    if (command.type === "task.claim.v1" && input.allocatedRunId && command.runId !== input.allocatedRunId) {
      return rejectTransition("aggregate_mismatch");
    }
    if (command.type !== "task.claim.v1" && state.runId && command.runId !== state.runId) {
      return rejectTransition("aggregate_mismatch");
    }
  }

  return undefined;
}

export function decideTaskCommand(state: TaskMachineState, input: TaskCommandDecisionInput): TransitionDecision {
  const generationRejection = rejectIfGenerationMismatch(state, input);
  if (generationRejection) return generationRejection;

  const routingRejection = taskCommandRoutingRejection(state, input);
  if (routingRejection) return routingRejection;

  const payload = payloadRecord(input.command);

  if (includesString(TASK_TERMINAL_STATES, state.status)) {
    return rejectTransition("terminal_state");
  }

  switch (input.command.type) {
    case "task.claim.v1": {
      if (state.status !== "ready") return rejectTransition("illegal_transition");
      if (!input.allocatedRunId) return rejectTransition("missing_command_context");
      return acceptTransition([
        {
          type: "task.claimed.v1",
          aggregate: { kind: "task", id: state.taskId },
          generation: state.generation,
          payload: {
            taskId: state.taskId,
            runId: input.allocatedRunId,
            claimedBy: input.command.actor
          }
        }
      ]);
    }
    case "task.block.v1": {
      if (state.status !== "ready" && state.status !== "claimed" && state.status !== "running" && state.status !== "blocked") {
        return rejectTransition("illegal_transition");
      }
      const reason = stringField(payload, "reason");
      if (!reason) return rejectTransition("invalid_command_payload");
      return acceptTransition([
        {
          type: "task.blocked.v1",
          aggregate: { kind: "task", id: state.taskId },
          generation: state.generation,
          payload: {
            taskId: state.taskId,
            blocker: {
              code: "task_blocked",
              reason,
              severity: "major"
            }
          }
        }
      ]);
    }
    case "task.complete.v1": {
      if (state.status !== "running") return rejectTransition("illegal_transition");
      const runId = runIdField(payload);
      const evidenceRefs = evidenceRefsField(payload);
      if (!runId || (state.runId && runId !== state.runId)) return rejectTransition("aggregate_mismatch");
      if (evidenceRefs.length === 0 || !isSubset(evidenceRefs, state.evidenceRefs)) return rejectTransition("missing_evidence");
      if (state.passedReviewRefs.length === 0) return rejectTransition("missing_review");
      return acceptTransition([
        {
          type: "task.completed.v1",
          aggregate: { kind: "task", id: state.taskId },
          generation: state.generation,
          payload: {
            taskId: state.taskId,
            runId,
            evidenceRefs
          }
        }
      ]);
    }
    case "task.invalidate.v1": {
      if (!includesString(TASK_INVALIDATABLE_STATES, state.status)) return rejectTransition("illegal_transition");
      const reason = stringField(payload, "reason");
      if (!reason) return rejectTransition("invalid_command_payload");
      return acceptTransition([
        {
          type: "task.invalidated.v1",
          aggregate: { kind: "task", id: state.taskId },
          generation: state.generation,
          payload: {
            taskId: state.taskId,
            reason
          }
        }
      ]);
    }
    default:
      return rejectTransition("unsupported_command");
  }
}
