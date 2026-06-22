/**
 * Deterministic, in-memory `runtime-local` driver.
 *
 * Purpose (ADR-004):
 *  - Allow deterministic tests, development, Phase 1 contract
 *    verification, and fallback environments where Eve is unavailable.
 *  - Produce Legion-protocol-compliant events that the rest of the
 *    core (state machines, event store, evidence indexing) can consume
 *    unchanged.
 *
 * Design constraints:
 *  - Zero provider imports. No Eve, no host CLI, no storage adapter.
 *  - Deterministic output. Two calls with the same `RuntimeStartRequest`
 *    produce the same run id, checkpoint fingerprint, and event
 *    sequence when a fixed clock is supplied.
 *  - No `any`. All inputs and outputs are typed via the RuntimeDriver
 *    contract and @legion/protocol.
 */

import * as crypto from "node:crypto";

import type {
  Actor,
  ApprovalId,
  ApprovalScope,
  ArtifactReference,
  ContentHash,
  EvidenceId,
  EventEnvelope,
  EventType,
  RunId,
  SchemaVersion,
  UtcTimestamp,
  WorkerBundle
} from "@legion/protocol";

import type {
  RuntimeApprovalOutcome,
  RuntimeApprovalRef,
  RuntimeArtifactHandle,
  RuntimeArtifactRef,
  RuntimeCancelReason,
  RuntimeCancelResult,
  RuntimeCheckpointRef,
  RuntimeDriver,
  RuntimeDriverId,
  RuntimeInspection,
  RuntimeResumeResult,
  RuntimeSandboxState,
  RuntimeStartRequest,
  RuntimeStartResult,
  RuntimeStreamEvent
} from "./contract.js";

export const RUNTIME_LOCAL_DRIVER_ID = "runtime-local" as const;
export const RUNTIME_LOCAL_DRIVER_VERSION = "0.1.0" as const;

export interface RuntimeLocalClock {
  now(): UtcTimestamp;
}

/**
 * Default deterministic clock. Returns a fixed UTC timestamp so that
 * tests are stable. Production callers inject their own clock.
 */
export const FIXED_RUNTIME_LOCAL_CLOCK: RuntimeLocalClock = {
  now: () => "2026-06-21T20:00:00.000Z" as UtcTimestamp
};

export interface RuntimeLocalDriverOptions {
  readonly driverId?: RuntimeDriverId;
  readonly clock?: RuntimeLocalClock;
}

/**
 * The `runtime-local` driver. State is held in-memory; the driver is
 * safe to instantiate per test and is not shared across processes.
 */
export class RuntimeLocalDriver implements RuntimeDriver {
  readonly driverId: RuntimeDriverId;
  private readonly clock: RuntimeLocalClock;
  private readonly runs: Map<RunId, LocalRunState> = new Map();
  private readonly streams: Map<RunId, RuntimeStreamEvent[]> = new Map();
  private readonly approvals: Map<ApprovalId, RuntimeApprovalRef> = new Map();

  constructor(options: RuntimeLocalDriverOptions = {}) {
    this.driverId = options.driverId ?? {
      driver: RUNTIME_LOCAL_DRIVER_ID,
      version: RUNTIME_LOCAL_DRIVER_VERSION as unknown as SchemaVersion
    };
    this.clock = options.clock ?? FIXED_RUNTIME_LOCAL_CLOCK;
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    assertRequestContract(request, this.driverId);

    const runId = deriveRunId(request);
    if (this.runs.has(runId)) {
      throw new RuntimeLocalDriverError(
        "duplicate_run",
        `Run ${runId} already exists for ${request.idempotencyKey}`
      );
    }

    const startedAt = this.clock.now();
    const checkpoint = deriveCheckpoint(runId, request, startedAt, 1);
    const events = buildRunCreatedEvents(request, runId, startedAt, checkpoint);

    const state: LocalRunState = {
      request,
      runId,
      status: "started",
      startedAt,
      checkpoint,
      artifacts: [],
      generation: 1
    };
    this.runs.set(runId, state);
    this.streams.set(runId, [
      {
        kind: "progress",
        runId,
        at: startedAt,
        sequence: 0,
        note: `runtime-local: started ${request.taskId} on attempt ${request.attempt}`
      }
    ]);

    return {
      runId,
      status: "started",
      manifestHash: checkpoint.fingerprint,
      startedAt,
      checkpoint,
      events
    };
  }

  async resume(runId: RunId, checkpointRef: RuntimeCheckpointRef): Promise<RuntimeResumeResult> {
    const state = this.requireRun(runId);
    if (checkpointRef.generation !== state.checkpoint.generation) {
      throw new RuntimeLocalDriverError(
        "stale_checkpoint",
        `Checkpoint generation ${checkpointRef.generation} does not match run ${runId} generation ${state.checkpoint.generation}`
      );
    }
    if (checkpointRef.fingerprint !== state.checkpoint.fingerprint) {
      throw new RuntimeLocalDriverError(
        "checkpoint_mismatch",
        `Checkpoint fingerprint for ${runId} does not match recorded fingerprint`
      );
    }

    state.generation += 1;
    state.checkpoint = deriveCheckpoint(runId, state.request, this.clock.now(), state.generation);
    state.status = "started";
    const resumedAt = this.clock.now();
    const events = buildRunResumedEvents(state, resumedAt);

    this.appendStream(state.runId, {
      kind: "progress",
      runId,
      at: resumedAt,
      sequence: this.nextSequence(runId),
      note: `runtime-local: resumed ${state.request.taskId} at generation ${state.generation}`
    });

    return {
      runId,
      status: "started",
      resumedAt,
      checkpoint: state.checkpoint,
      events
    };
  }

  async cancel(runId: RunId, reason: RuntimeCancelReason): Promise<RuntimeCancelResult> {
    const state = this.requireRun(runId);
    if (state.status === "canceled") {
      throw new RuntimeLocalDriverError(
        "already_canceled",
        `Run ${runId} is already canceled`
      );
    }

    state.status = "canceled";
    const finishedAt = this.clock.now();
    const events = buildRunFinishedEvents(state, finishedAt, "canceled");
    this.appendStream(state.runId, {
      kind: "terminal",
      runId,
      at: finishedAt,
      sequence: this.nextSequence(runId),
      status: "canceled",
      evidenceRefs: []
    });

    return {
      runId,
      status: "canceled",
      finishedAt,
      reason,
      events
    };
  }

  async inspect(runId: RunId): Promise<RuntimeInspection> {
    const state = this.requireRun(runId);
    const sandbox: RuntimeSandboxState = {
      sandboxDriver: state.request.workspace.sandboxDriver,
      worktreePath: state.request.workspace.worktreePath,
      generation: state.generation,
      sealed: state.status === "succeeded" || state.status === "canceled" || state.status === "failed"
    };

    const inspection: RuntimeInspection = {
      runId,
      status: state.status,
      startedAt: state.startedAt,
      checkpoint: state.checkpoint,
      sandbox,
      artifacts: [...state.artifacts]
    };
    return inspection;
  }

  async *stream(runId: RunId): AsyncIterable<RuntimeStreamEvent> {
    const events = this.streams.get(runId);
    if (!events) {
      throw new RuntimeLocalDriverError("unknown_run", `Run ${runId} has no recorded stream`);
    }
    for (const event of events) {
      yield event;
    }
  }

  async approve(approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome> {
    const state = this.requireRun(approvalRef.runId);
    if (state.status !== "started" && state.status !== "needs_human") {
      throw new RuntimeLocalDriverError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} is ${state.status} and cannot accept approval`
      );
    }

    const approvalId = approvalRef.approvalId;
    if (this.approvals.has(approvalId)) {
      const previous = this.approvals.get(approvalId);
      if (previous && previous.decidedAt === approvalRef.decidedAt && previous.decidedBy.id === approvalRef.decidedBy.id) {
        return {
          runId: approvalRef.runId,
          approvalId,
          status: "delivered",
          deliveredAt: approvalRef.decidedAt,
          reason: "duplicate approval is idempotent",
          events: []
        };
      }
      throw new RuntimeLocalDriverError(
        "duplicate_approval",
        `Approval ${approvalId} already delivered with a different decision`
      );
    }
    this.approvals.set(approvalId, approvalRef);

    const deliveredAt = this.clock.now();
    const events: EventEnvelope[] = buildApprovalGrantedEvents(state, approvalRef, deliveredAt);
    this.appendStream(state.runId, {
      kind: "approval_requested",
      runId: state.runId,
      at: approvalRef.decidedAt,
      sequence: this.nextSequence(state.runId),
      approvalId,
      scope: approvalRef.scope,
      requestedBy: approvalRef.decidedBy
    });

    return {
      runId: approvalRef.runId,
      approvalId,
      status: "delivered",
      deliveredAt,
      reason: approvalRef.reason,
      events
    };
  }

  async artifact(runId: RunId, artifactRef?: RuntimeArtifactRef): Promise<RuntimeArtifactHandle> {
    const state = this.requireRun(runId);
    const resolvedAt = this.clock.now();

    // Final-output mode (no artifactRef): only valid when the run is
    // in a terminal state. Surface a structured failure that carries
    // the current state for non-terminal runs so callers can react
    // without re-querying via `inspect`.
    if (artifactRef === undefined) {
      const isTerminal =
        state.status === "succeeded" ||
        state.status === "failed" ||
        state.status === "canceled" ||
        state.status === "superseded" ||
        state.status === "blocked";
      if (!isTerminal) {
        throw new RuntimeLocalDriverError(
          "not_terminal",
          `Run ${runId} is ${state.status} and not yet terminal; artifact(handle) requires a terminal run`
        );
      }
      const terminalStatus: "succeeded" | "failed" | "blocked" | "canceled" =
        state.status === "succeeded" ||
        state.status === "failed" ||
        state.status === "blocked" ||
        state.status === "canceled"
          ? state.status
          : "canceled";
      const finishedAt = resolvedAt;
      const files = [...state.artifacts];
      const metadata: Record<string, unknown> = {
        attempt: state.request.attempt,
        contractId: state.request.contractId,
        contractRevision: state.request.contractRevision,
        generation: state.generation,
        workerBundleId: state.request.workerBundle.id,
        sandboxDriver: state.request.workspace.sandboxDriver,
        worktreePath: state.request.workspace.worktreePath,
        terminalStatus: state.status
      };
      const finalOutputRef: ArtifactReference = {
        path: `.runtime-local/${runId}/final-output.json` as ArtifactReference["path"],
        sha256: sha256ContentHash(`${runId}|${terminalStatus}|${finishedAt}|${files.length}`)
      };
      this.appendStream(state.runId, {
        kind: "artifact_registered",
        runId,
        at: resolvedAt,
        sequence: this.nextSequence(runId),
        reference: finalOutputRef
      });

      return {
        runId,
        reference: finalOutputRef,
        kind: "fetch",
        resolvedAt,
        status: terminalStatus,
        files,
        metadata,
        startedAt: state.startedAt,
        finishedAt,
        checkpoint: state.checkpoint,
        events: []
      };
    }

    // Register / fetch mode: an artifactRef was provided.
    const reference = artifactRef.reference;
    if (artifactRef.kind === "register") {
      state.artifacts.push(reference);
    }
    const evidenceId = artifactRef.evidenceId;
    const events: EventEnvelope[] = buildArtifactEvents(state, reference, resolvedAt, evidenceId);

    const streamEvent: RuntimeStreamEvent = evidenceId
      ? {
          kind: "artifact_registered",
          runId,
          at: resolvedAt,
          sequence: this.nextSequence(runId),
          reference,
          evidenceId
        }
      : {
          kind: "artifact_registered",
          runId,
          at: resolvedAt,
          sequence: this.nextSequence(runId),
          reference
        };
    this.appendStream(state.runId, streamEvent);

    const handle: RuntimeArtifactHandle = evidenceId
      ? {
          runId,
          reference,
          kind: artifactRef.kind,
          resolvedAt,
          evidenceId,
          events
        }
      : {
          runId,
          reference,
          kind: artifactRef.kind,
          resolvedAt,
          events
        };
    return handle;
  }

  // -------------------------------------------------------------------------
  // Test introspection helpers (not part of the public RuntimeDriver shape)
  // -------------------------------------------------------------------------

  /** Visible for tests only — returns the count of events recorded. */
  __streamLength(runId: RunId): number {
    return this.streams.get(runId)?.length ?? 0;
  }

  /** Visible for tests only — current generation of the run. */
  __generation(runId: RunId): number {
    return this.requireRun(runId).generation;
  }

  private requireRun(runId: RunId): LocalRunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new RuntimeLocalDriverError("unknown_run", `Run ${runId} is not registered with runtime-local`);
    }
    return state;
  }

  private appendStream(runId: RunId, event: RuntimeStreamEvent): void {
    const events = this.streams.get(runId);
    if (!events) return;
    events.push(event);
  }

  private nextSequence(runId: RunId): number {
    const events = this.streams.get(runId);
    return events ? events.length : 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers (all pure, no I/O)
// ---------------------------------------------------------------------------

interface LocalRunState {
  readonly request: RuntimeStartRequest;
  readonly runId: RunId;
  status: "created" | "started" | "succeeded" | "failed" | "blocked" | "canceled" | "superseded" | "needs_human";
  startedAt: UtcTimestamp;
  checkpoint: RuntimeCheckpointRef;
  artifacts: ArtifactReference[];
  generation: number;
}

export class RuntimeLocalDriverError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "RuntimeLocalDriverError";
  }
}

function assertRequestContract(request: RuntimeStartRequest, driverId: RuntimeDriverId): void {
  if (request.driver.driver !== driverId.driver) {
    throw new RuntimeLocalDriverError(
      "driver_mismatch",
      `Request driver ${request.driver.driver} does not match loaded driver ${driverId.driver}`
    );
  }
  if (request.contractRevision <= 0) {
    throw new RuntimeLocalDriverError(
      "invalid_request",
      `contractRevision must be positive, received ${request.contractRevision}`
    );
  }
  if (request.attempt <= 0) {
    throw new RuntimeLocalDriverError(
      "invalid_request",
      `attempt must be positive, received ${request.attempt}`
    );
  }
}

function deriveRunId(request: RuntimeStartRequest): RunId {
  const seed = `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`;
  return deterministicRunId(seed);
}

export function deterministicRunId(seed: string): RunId {
  const hash = sha256Hex(seed);
  const suffix = hash.slice(0, 22);
  return `run_${suffix}` as RunId;
}

function deriveCheckpoint(
  runId: RunId,
  request: RuntimeStartRequest,
  at: UtcTimestamp,
  generation: number
): RuntimeCheckpointRef {
  const payload = JSON.stringify({
    runId,
    contractId: request.contractId,
    contractRevision: request.contractRevision,
    attempt: request.attempt,
    workerBundleId: request.workerBundle.id,
    workerBundleVersion: request.workerBundle.version,
    generation,
    at
  });
  const fingerprint = sha256ContentHash(payload);
  return {
    runId,
    generation,
    fingerprint,
    note: `runtime-local checkpoint for ${request.taskId} attempt ${request.attempt}`
  };
}

function buildRunCreatedEvents(
  request: RuntimeStartRequest,
  runId: RunId,
  startedAt: UtcTimestamp,
  checkpoint: RuntimeCheckpointRef
): EventEnvelope[] {
  const actor = request.requestedBy;
  const changeId = request.changeId;
  const taskId = request.taskId;
  const runAggregate = { kind: "run" as const, id: runId };

  const created = buildEvent({
    type: "run.created.v1",
    runId,
    aggregate: runAggregate,
    actor,
    changeId,
    projectId: request.projectId,
    generation: 1,
    sequence: 0,
    payload: {
      runId,
      taskId,
      contractId: request.contractId,
      attempt: request.attempt
    }
  });

  const started = buildEvent({
    type: "run.started.v1",
    runId,
    aggregate: runAggregate,
    actor,
    changeId,
    projectId: request.projectId,
    generation: 1,
    sequence: 1,
    payload: {
      runId,
      taskId,
      startedAt
    },
    causationId: created.id
  });

  return [created, started];
}

function buildRunResumedEvents(state: LocalRunState, resumedAt: UtcTimestamp): EventEnvelope[] {
  return [
    buildEvent({
      type: "run.started.v1",
      runId: state.runId,
      aggregate: { kind: "run", id: state.runId },
      actor: state.request.requestedBy,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 0,
      payload: {
        runId: state.runId,
        taskId: state.request.taskId,
        startedAt: resumedAt
      }
    })
  ];
}

function buildRunFinishedEvents(
  state: LocalRunState,
  finishedAt: UtcTimestamp,
  status: "succeeded" | "failed" | "blocked" | "canceled"
): EventEnvelope[] {
  return [
    buildEvent({
      type: "run.finished.v1",
      runId: state.runId,
      aggregate: { kind: "run", id: state.runId },
      actor: state.request.requestedBy,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 0,
      payload: {
        runId: state.runId,
        taskId: state.request.taskId,
        status,
        finishedAt,
        evidenceRefs: []
      }
    })
  ];
}

function buildApprovalGrantedEvents(
  state: LocalRunState,
  approvalRef: RuntimeApprovalRef,
  deliveredAt: UtcTimestamp
): EventEnvelope[] {
  const approvalAggregate = { kind: "approval" as const, id: approvalRef.approvalId };
  const approvalId = approvalRef.approvalId;
  return [
    buildEvent({
      type: "approval.requested.v1",
      runId: state.runId,
      aggregate: approvalAggregate,
      actor: approvalRef.decidedBy,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 0,
      payload: {
        approvalId,
        requestedBy: approvalRef.decidedBy,
        scope: approvalRef.scope
      }
    }),
    buildEvent({
      type: "approval.granted.v1",
      runId: state.runId,
      aggregate: approvalAggregate,
      actor: approvalRef.decidedBy,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 1,
      payload: {
        approvalId,
        decidedBy: approvalRef.decidedBy,
        reason: approvalRef.reason
      }
    })
  ];
}

function buildArtifactEvents(
  state: LocalRunState,
  reference: ArtifactReference,
  resolvedAt: UtcTimestamp,
  evidenceId: EvidenceId | undefined
): EventEnvelope[] {
  const actor = state.request.requestedBy;
  if (!evidenceId) return [];
  void reference;
  void resolvedAt;
  return [
    buildEvent({
      type: "evidence.collected.v1",
      runId: state.runId,
      aggregate: { kind: "evidence", id: evidenceId },
      actor,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 0,
      payload: {
        evidenceId,
        taskId: state.request.taskId,
        runId: state.runId,
        verdict: "pass"
      }
    })
  ];
}

interface BuildEventInput {
  readonly type: EventType;
  readonly runId: RunId;
  readonly aggregate: EventEnvelope["aggregate"];
  readonly actor: Actor;
  readonly changeId: EventEnvelope["changeId"];
  readonly projectId: EventEnvelope["projectId"];
  readonly generation: number;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causationId?: EventEnvelope["id"];
  readonly correlationId?: EventEnvelope["correlationId"];
}

function buildEvent(input: BuildEventInput): EventEnvelope {
  const id = deterministicEventId(input.type, input.runId, input.sequence, input.generation);
  const occurredAt = "2026-06-21T20:00:00.000Z" as UtcTimestamp;
  const base = {
    schemaVersion: "0.1.0",
    id,
    type: input.type,
    version: 1,
    projectId: input.projectId,
    changeId: input.changeId,
    aggregate: input.aggregate,
    generation: input.generation,
    sequence: input.sequence,
    actor: input.actor,
    occurredAt,
    payload: input.payload as EventEnvelope["payload"]
  } as const;

  if (input.causationId) {
    return { ...base, causationId: input.causationId };
  }
  if (input.correlationId) {
    return { ...base, correlationId: input.correlationId as EventEnvelope["correlationId"] };
  }
  return base as EventEnvelope;
}

function deterministicEventId(type: EventType, runId: RunId, sequence: number, generation: number): EventEnvelope["id"] {
  const hash = sha256Hex(`${type}|${runId}|${sequence}|${generation}`);
  return `evt_${hash.slice(0, 26)}`;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256ContentHash(input: string): ContentHash {
  return `sha256:${sha256Hex(input)}` as unknown as ContentHash;
}

// Convenience factory for worker bundles in tests
export function buildLocalWorkerBundle(): WorkerBundle {
  return {
    id: "legion.local-worker",
    version: "0.1.0" as unknown as WorkerBundle["version"],
    role: "implementer",
    domain: "core",
    capabilities: ["filesystem.read", "filesystem.write"],
    promptContentContract: {
      instructionsHash: sha256ContentHash("local-worker"),
      requiredSections: ["workflow"],
      forbiddenSections: []
    }
  };
}

export function scopeForApproval(approvalId: ApprovalId, runId: RunId): ApprovalScope {
  return {
    effectClass: "S2",
    action: "approve-run",
    targets: [
      { kind: "approval", id: approvalId },
      { kind: "run", id: runId }
    ]
  };
}
