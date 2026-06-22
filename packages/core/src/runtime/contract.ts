/**
 * ADR-004 Runtime Driver — provider-neutral contract surface.
 *
 * The core defines a typed seven-method contract that any runtime
 * implementation must satisfy. The contract is intentionally narrow:
 * it only references types from @legion/protocol and from this package
 * so driver implementations cannot import Eve, host CLI, or storage
 * types into the core.
 *
 * Core-owned responsibilities (per ADR-004):
 *  - task state, risk policy, approval policy, event schemas,
 *    idempotency keys, outbox, evidence indexing, and completion semantics.
 *
 * Driver-owned responsibilities:
 *  - provider session creation, provider checkpointing, sandbox execution
 *    within its documented contract, and provider-specific transport.
 *  - the driver MUST translate provider details into Legion protocol
 *    events before they enter the store.
 */

import type {
  Actor,
  ApprovalId,
  ApprovalScope,
  ArtifactReference,
  ChangeId,
  ContentHash,
  ContractId,
  EvidenceId,
  EventEnvelope,
  ProjectId,
  ProtocolError,
  RunId,
  SchemaVersion,
  TaskId,
  UtcTimestamp,
  WorkerBundle
} from "@legion/protocol";

/**
 * The seven lifecycle methods that ADR-004 mandates for any runtime
 * driver. The order in this interface mirrors ADR-004 verbatim.
 */
export interface RuntimeDriver {
  /**
   * Create one version-pinned execution attempt for an approved task
   * contract. The driver must return a deterministic run id and a
   * frozen manifest that downstream state machines can rely on.
   */
  start(request: RuntimeStartRequest): Promise<RuntimeStartResult>;

  /**
   * Continue a paused or interrupted run after reconciling board state
   * and idempotency records. The checkpoint reference is provider
   * neutral; the driver must translate it to whatever its provider
   * supports.
   */
  resume(runId: RunId, checkpointRef: RuntimeCheckpointRef): Promise<RuntimeResumeResult>;

  /**
   * Request termination and record the result without deleting run
   * history. The reason is preserved as a driver-neutral protocol
   * error so the board can emit a `run.finished.v1` event.
   */
  cancel(runId: RunId, reason: RuntimeCancelReason): Promise<RuntimeCancelResult>;

  /**
   * Return provider-neutral status, checkpoint, sandbox, and artifact
   * references for the run. Inspect is a read-only query and MUST NOT
   * mutate driver state.
   */
  inspect(runId: RunId): Promise<RuntimeInspection>;

  /**
   * Emit provider-neutral run events for progress, tool calls,
   * approvals, artifacts, and terminal state. The driver owns ordering
   * and at-least-once delivery to the consumer; the consumer owns
   * persistence into the event store.
   */
  stream(runId: RunId): AsyncIterable<RuntimeStreamEvent>;

  /**
   * Deliver a durable human authorization to a paused run when policy
   * permits. The driver translates the approval into a provider-native
   * resume signal but returns a provider-neutral outcome.
   */
  approve(approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome>;

  /**
   * Fetch or register provider-neutral artifact metadata. The driver
   * must not interpret the bytes; it only resolves references to and
   * from provider storage.
   */
  artifact(runId: RunId, artifactRef: RuntimeArtifactRef): Promise<RuntimeArtifactHandle>;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const RUNTIME_DRIVER_METHODS = [
  "start",
  "resume",
  "cancel",
  "inspect",
  "stream",
  "approve",
  "artifact"
] as const;

export type RuntimeDriverMethod = (typeof RUNTIME_DRIVER_METHODS)[number];

/**
 * Provider-neutral manifest a driver receives for `start`. It is
 * derived from the protocol `TaskRunManifest` minus any provider
 * types so the contract stays portable.
 */
export interface RuntimeStartRequest {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly taskId: TaskId;
  readonly contractId: ContractId;
  readonly contractRevision: number;
  readonly attempt: number;
  readonly workerBundle: WorkerBundle;
  readonly inputs: RuntimeStartInputs;
  readonly repository: RuntimeRepository;
  readonly workspace: RuntimeWorkspace;
  readonly policy: RuntimePolicy;
  readonly idempotencyKey: string;
  readonly requestedBy: Actor;
  readonly approvedAt: UtcTimestamp;
  readonly driver: RuntimeDriverId;
  readonly driverVersion: SchemaVersion;
  readonly protocolVersion: SchemaVersion;
}

export interface RuntimeStartInputs {
  readonly contractHash: ContentHash;
  readonly currentSpecsHash: ContentHash;
  readonly deltaSpecsHash: ContentHash;
  readonly oracleHash: ContentHash;
}

export interface RuntimeRepository {
  readonly baseCommit: string;
  readonly branch?: string;
}

export interface RuntimeWorkspace {
  readonly sandboxDriver: string;
  readonly worktreePath: string;
}

export interface RuntimePolicy {
  readonly riskTier: "R0" | "R1" | "R2" | "R3";
  readonly policyVersion: SchemaVersion;
}

export interface RuntimeDriverId {
  readonly driver: string;
  readonly version: SchemaVersion;
}

export interface RuntimeCheckpointRef {
  readonly runId: RunId;
  readonly generation: number;
  readonly fingerprint: ContentHash;
  readonly note?: string;
}

export interface RuntimeCancelReason {
  readonly code: string;
  readonly message: string;
  readonly requestedBy: Actor;
  readonly at: UtcTimestamp;
}

export interface RuntimeApprovalRef {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly scope: ApprovalScope;
  readonly decidedBy: Actor;
  readonly decidedAt: UtcTimestamp;
  readonly reason: string;
}

export interface RuntimeArtifactRef {
  readonly kind: "fetch" | "register";
  readonly reference: ArtifactReference;
  readonly evidenceId?: EvidenceId;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface RuntimeStartResult {
  readonly runId: RunId;
  readonly status: "created" | "started";
  readonly manifestHash: ContentHash;
  readonly startedAt: UtcTimestamp;
  readonly checkpoint: RuntimeCheckpointRef;
  readonly events: readonly EventEnvelope[];
}

export interface RuntimeResumeResult {
  readonly runId: RunId;
  readonly status: "started";
  readonly resumedAt: UtcTimestamp;
  readonly checkpoint: RuntimeCheckpointRef;
  readonly events: readonly EventEnvelope[];
}

export interface RuntimeCancelResult {
  readonly runId: RunId;
  readonly status: "canceled";
  readonly finishedAt: UtcTimestamp;
  readonly reason: RuntimeCancelReason;
  readonly events: readonly EventEnvelope[];
}

export interface RuntimeInspection {
  readonly runId: RunId;
  readonly status:
    | "created"
    | "started"
    | "succeeded"
    | "failed"
    | "blocked"
    | "canceled"
    | "superseded"
    | "needs_human";
  readonly startedAt?: UtcTimestamp;
  readonly finishedAt?: UtcTimestamp;
  readonly checkpoint: RuntimeCheckpointRef;
  readonly sandbox: RuntimeSandboxState;
  readonly artifacts: readonly ArtifactReference[];
  readonly lastError?: ProtocolError;
}

export interface RuntimeSandboxState {
  readonly sandboxDriver: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly sealed: boolean;
}

export type RuntimeStreamEvent =
  | RuntimeProgressEvent
  | RuntimeToolCallEvent
  | RuntimeApprovalRequestedEvent
  | RuntimeArtifactRegisteredEvent
  | RuntimeTerminalEvent;

export interface RuntimeProgressEvent {
  readonly kind: "progress";
  readonly runId: RunId;
  readonly at: UtcTimestamp;
  readonly sequence: number;
  readonly note: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RuntimeToolCallEvent {
  readonly kind: "tool_call";
  readonly runId: RunId;
  readonly at: UtcTimestamp;
  readonly sequence: number;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: ProtocolError;
}

export interface RuntimeApprovalRequestedEvent {
  readonly kind: "approval_requested";
  readonly runId: RunId;
  readonly at: UtcTimestamp;
  readonly sequence: number;
  readonly approvalId: ApprovalId;
  readonly scope: ApprovalScope;
  readonly requestedBy: Actor;
}

export interface RuntimeArtifactRegisteredEvent {
  readonly kind: "artifact_registered";
  readonly runId: RunId;
  readonly at: UtcTimestamp;
  readonly sequence: number;
  readonly reference: ArtifactReference;
  readonly evidenceId?: EvidenceId;
}

export interface RuntimeTerminalEvent {
  readonly kind: "terminal";
  readonly runId: RunId;
  readonly at: UtcTimestamp;
  readonly sequence: number;
  readonly status: "succeeded" | "failed" | "blocked" | "canceled";
  readonly evidenceRefs: readonly EvidenceId[];
  readonly error?: ProtocolError;
}

export interface RuntimeApprovalOutcome {
  readonly runId: RunId;
  readonly approvalId: ApprovalId;
  readonly status: "delivered" | "rejected";
  readonly deliveredAt: UtcTimestamp;
  readonly reason: string;
  readonly events: readonly EventEnvelope[];
}

export interface RuntimeArtifactHandle {
  readonly runId: RunId;
  readonly reference: ArtifactReference;
  readonly kind: "fetch" | "register";
  readonly resolvedAt: UtcTimestamp;
  readonly evidenceId?: EvidenceId;
  readonly events: readonly EventEnvelope[];
}
