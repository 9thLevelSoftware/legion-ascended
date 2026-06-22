/**
 * ADR-004 Runtime Driver — `FakeRuntimeDriver`.
 *
 * Purpose:
 *  - Provide a deterministic in-memory driver used by unit tests so
 *    downstream consumers (state machines, board logic, etc.) can
 *    exercise the seven-method surface without spinning up a real
 *    provider.
 *  - Be small enough to read in one screen so test failures are
 *    easy to diagnose. The Fake is NOT a replacement for the
 *    production `RuntimeLocalDriver`; it intentionally skips
 *    hashing, event-envelope construction, and protocol event ids.
 *
 * Behaviour:
 *  - `start` allocates a fresh run id derived from the request
 *    idempotency key, records the run in `running` state, and emits
 *    a single `progress` event so downstream tests can observe the
 *    transition through `stream`.
 *  - `resume` returns a structured failure for unknown or terminal
 *    runs; for a known non-terminal run it bumps the checkpoint
 *    generation and re-emits a single progress event.
 *  - `cancel` is idempotent on already-terminal runs and transitions
 *    non-terminal runs to `canceled`.
 *  - `inspect` returns a structured failure for unknown runs and a
 *    snapshot for known ones.
 *  - `stream` yields a canned sequence for a `running` run and
 *    replays the recorded sequence for terminal runs (no further
 *    events).
 *  - `approve` advances a run in `awaiting_approval` to `running`,
 *    rejects a run not waiting on approval, and records a `deny:`
 *    decision by transitioning to `canceled`.
 *  - `artifact` has two modes: register/fetch when called with an
 *    `artifactRef` argument, and final-output when called with only
 *    a runId. Final-output returns the full bundle (status, files,
 *    metadata, startedAt, finishedAt, checkpoint) for terminal
 *    runs and surfaces a structured `not_terminal` failure with the
 *    current state for non-terminal runs.
 *
 * The Fake never throws from its public API except for programmer
 * errors (invalid request shape). All protocol-level failures come
 * back as `FakeDriverValidationError` shapes so tests can assert on
 * `code` rather than catching exceptions.
 */

import type {
  Actor,
  ApprovalId,
  ApprovalScope,
  ArtifactReference,
  ContentHash,
  EventEnvelope,
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
  RuntimeDriverId,
  RuntimeInspection,
  RuntimeResumeResult,
  RuntimeSandboxState,
  RuntimeStartInputs,
  RuntimeStartRequest,
  RuntimeStartResult,
  RuntimeStreamEvent
} from "./contract.js";

import { RuntimeDriverSkeleton } from "./skeleton.js";

export const FAKE_RUNTIME_DRIVER_ID = "fake" as const;
export const FAKE_RUNTIME_DRIVER_VERSION: SchemaVersion =
  "0.0.0" as SchemaVersion;

/**
 * Internal status for a Fake run. The set is intentionally a
 * subset of `RuntimeInspection["status"]` plus one extra
 * `awaiting_approval` value that exists only inside the Fake and
 * is collapsed into `started` on inspect.
 */
export type FakeRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "canceled";

interface FakeRun {
  readonly runId: RunId;
  readonly request: RuntimeStartRequest;
  status: FakeRunStatus;
  startedAt: UtcTimestamp;
  finishedAt?: UtcTimestamp;
  checkpoint: RuntimeCheckpointRef;
  generation: number;
  artifacts: ArtifactReference[];
  approvals: Map<ApprovalId, RuntimeApprovalRef>;
  events: RuntimeStreamEvent[];
  sequence: number;
}

/**
 * Clock injected into the Fake so tests can pin timestamps. The
 * default clock returns a fixed UTC timestamp.
 */
export interface FakeRuntimeDriverClock {
  now(): UtcTimestamp;
}

export const FIXED_FAKE_CLOCK: FakeRuntimeDriverClock = {
  now: () => "2026-01-01T00:00:00.000Z" as UtcTimestamp
};

export interface FakeRuntimeDriverOptions {
  readonly driverId?: RuntimeDriverId;
  readonly clock?: FakeRuntimeDriverClock;
}

/**
 * Canned stream payload emitted when `stream(runId)` is called on
 * a `running` run. Tests can rely on the order and the count of
 * these events. Each template omits the `runId`, `at`, and
 * `sequence` fields because the Fake fills them in at yield time.
 */
type FakeStreamTemplate =
  | { kind: "progress"; note: string; data?: Readonly<Record<string, unknown>> }
  | { kind: "tool_call"; tool: string; input: Readonly<Record<string, unknown>> };

const CANNED_RUNNING_STREAM: ReadonlyArray<FakeStreamTemplate> = [
  { kind: "progress", note: "fake: worker started" },
  { kind: "progress", note: "fake: tool_call dispatched" },
  { kind: "tool_call", tool: "noop.read", input: { path: "." } },
  { kind: "progress", note: "fake: idle" }
];

/**
 * The Fake driver. Allocates fresh state per run; safe to
 * instantiate once per test.
 */
export class FakeRuntimeDriver extends RuntimeDriverSkeleton {
  private readonly clock: FakeRuntimeDriverClock;
  private readonly runs = new Map<RunId, FakeRun>();
  private generationCounter = 0;

  constructor(options: FakeRuntimeDriverOptions = {}) {
    super(
      options.driverId ?? {
        driver: FAKE_RUNTIME_DRIVER_ID,
        version: FAKE_RUNTIME_DRIVER_VERSION
      }
    );
    this.clock = options.clock ?? FIXED_FAKE_CLOCK;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  override async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    const validation = validateStartRequest(request, this.driverId);
    if (validation) {
      throw new FakeDriverValidationError(validation.code, validation.message);
    }

    const runId = deriveFakeRunId(request);
    if (this.runs.has(runId)) {
      // Idempotent re-start: return the existing run unchanged.
      const existing = this.runs.get(runId) as FakeRun;
      return this.toStartResult(existing);
    }

    const startedAt = this.clock.now();
    this.generationCounter += 1;
    const checkpoint: RuntimeCheckpointRef = {
      runId,
      generation: this.generationCounter,
      fingerprint: fakeContentHash(`${runId}|${startedAt}`),
      note: `fake checkpoint for ${request.taskId}`
    };

    const run: FakeRun = {
      runId,
      request,
      status: "running",
      startedAt,
      checkpoint,
      generation: checkpoint.generation,
      artifacts: [],
      approvals: new Map(),
      events: [],
      sequence: 0
    };
    this.runs.set(runId, run);
    this.appendStream(run, {
      kind: "progress",
      runId,
      at: startedAt,
      sequence: this.nextSequence(run),
      note: `fake: started ${request.taskId} attempt ${request.attempt}`
    });

    return this.toStartResult(run);
  }

  // -------------------------------------------------------------------------
  // resume
  // -------------------------------------------------------------------------

  override async resume(runId: RunId, checkpointRef: RuntimeCheckpointRef): Promise<RuntimeResumeResult> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    if (isTerminal(run.status)) {
      throw new FakeDriverValidationError(
        "terminal_run",
        `Run ${runId} is ${run.status} and cannot be resumed`
      );
    }
    if (checkpointRef.generation !== run.checkpoint.generation) {
      throw new FakeDriverValidationError(
        "stale_checkpoint",
        `Checkpoint generation ${checkpointRef.generation} does not match recorded ${run.checkpoint.generation}`
      );
    }

    run.generation += 1;
    this.generationCounter += 1;
    run.checkpoint = {
      runId,
      generation: this.generationCounter,
      fingerprint: fakeContentHash(`${runId}|resume|${run.generation}`),
      note: `fake resume checkpoint for ${run.request.taskId}`
    };
    if (run.status === "pending" || run.status === "awaiting_approval") {
      // keep current non-running status
    } else if (run.status !== "running") {
      run.status = "running";
    }
    const resumedAt = this.clock.now();
    this.appendStream(run, {
      kind: "progress",
      runId,
      at: resumedAt,
      sequence: this.nextSequence(run),
      note: `fake: resumed ${run.request.taskId} generation ${run.generation}`
    });

    return {
      runId,
      status: "started",
      resumedAt,
      checkpoint: run.checkpoint,
      events: []
    };
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  override async cancel(runId: RunId, reason: RuntimeCancelReason): Promise<RuntimeCancelResult> {
    const run = this.runs.get(runId);
    if (!run) {
      // Idempotent semantics: cancelling an unknown run is treated as
      // a no-op success so callers can replay cancels safely.
      return {
        runId,
        status: "canceled",
        finishedAt: this.clock.now(),
        reason,
        events: []
      };
    }
    if (run.status === "canceled") {
      return {
        runId,
        status: "canceled",
        finishedAt: run.finishedAt ?? this.clock.now(),
        reason,
        events: []
      };
    }
    run.status = "canceled";
    run.finishedAt = this.clock.now();
    this.appendStream(run, {
      kind: "terminal",
      runId,
      at: run.finishedAt,
      sequence: this.nextSequence(run),
      status: "canceled",
      evidenceRefs: []
    });
    return {
      runId,
      status: "canceled",
      finishedAt: run.finishedAt,
      reason,
      events: []
    };
  }

  // -------------------------------------------------------------------------
  // inspect
  // -------------------------------------------------------------------------

  override async inspect(runId: RunId): Promise<RuntimeInspection> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    const sandbox: RuntimeSandboxState = {
      sandboxDriver: run.request.workspace.sandboxDriver,
      worktreePath: run.request.workspace.worktreePath,
      generation: run.generation,
      sealed: isTerminal(run.status)
    };
    return {
      runId,
      status: collapseForInspect(run.status),
      startedAt: run.startedAt,
      checkpoint: run.checkpoint,
      sandbox,
      artifacts: [...run.artifacts],
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {})
    };
  }

  // -------------------------------------------------------------------------
  // stream
  // -------------------------------------------------------------------------

  override async *stream(runId: RunId): AsyncIterableIterator<RuntimeStreamEvent> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    // Replay any events recorded so far (so a fresh consumer sees
    // history), then emit the canned "running" sequence while the
    // run is still active.
    for (const event of run.events) {
      yield event;
    }
    if (isTerminal(run.status)) {
      return;
    }
    for (const template of CANNED_RUNNING_STREAM) {
      this.appendStream(run, {
        ...template,
        runId,
        at: this.clock.now(),
        sequence: this.nextSequence(run)
      } as RuntimeStreamEvent);
      const last = run.events[run.events.length - 1];
      if (last) yield last;
    }
  }

  // -------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------

  override async approve(approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome> {
    const run = this.runs.get(approvalRef.runId);
    if (!run) {
      throw new FakeDriverValidationError(
        "unknown_run",
        `Run ${approvalRef.runId} is not registered with FakeRuntimeDriver`
      );
    }
    if (run.status === "canceled") {
      throw new FakeDriverValidationError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} is canceled and cannot accept approval`
      );
    }
    if (run.status !== "awaiting_approval") {
      // Non-waiting run: surface a structured failure so tests can
      // assert on `code === "approval_not_acceptable"`.
      throw new FakeDriverValidationError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} is ${run.status} and not waiting for approval`
      );
    }

    const prior = run.approvals.get(approvalRef.approvalId);
    if (prior && prior.decidedAt === approvalRef.decidedAt && prior.reason === approvalRef.reason) {
      return {
        runId: approvalRef.runId,
        approvalId: approvalRef.approvalId,
        status: "delivered",
        deliveredAt: this.clock.now(),
        reason: "duplicate approval is idempotent",
        events: []
      };
    }
    if (prior) {
      throw new FakeDriverValidationError(
        "duplicate_approval",
        `Approval ${approvalRef.approvalId} already delivered with a different decision`
      );
    }
    run.approvals.set(approvalRef.approvalId, approvalRef);

    const denied = approvalRef.reason.startsWith("deny:");
    if (denied) {
      run.status = "canceled";
      run.finishedAt = this.clock.now();
      this.appendStream(run, {
        kind: "terminal",
        runId: run.runId,
        at: run.finishedAt,
        sequence: this.nextSequence(run),
        status: "canceled",
        evidenceRefs: []
      });
      return {
        runId: run.runId,
        approvalId: approvalRef.approvalId,
        status: "rejected",
        deliveredAt: run.finishedAt,
        reason: approvalRef.reason,
        events: []
      };
    }

    run.status = "running";
    const deliveredAt = this.clock.now();
    this.appendStream(run, {
      kind: "approval_requested",
      runId: run.runId,
      at: deliveredAt,
      sequence: this.nextSequence(run),
      approvalId: approvalRef.approvalId,
      scope: approvalRef.scope,
      requestedBy: approvalRef.decidedBy
    });
    return {
      runId: run.runId,
      approvalId: approvalRef.approvalId,
      status: "delivered",
      deliveredAt,
      reason: approvalRef.reason,
      events: []
    };
  }

  // -------------------------------------------------------------------------
  // artifact
  // -------------------------------------------------------------------------

  override async artifact(
    runId: RunId,
    artifactRef?: RuntimeArtifactRef
  ): Promise<RuntimeArtifactHandle> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    const resolvedAt = this.clock.now();

    // Final-output mode: no artifactRef provided.
    //
    // Per ADR-004, `artifact(runId)` (no second argument) is the
    // "give me the final structured output" call. It succeeds only
    // when the run is in a terminal state; otherwise the driver
    // surfaces a structured `not_terminal` failure that includes the
    // current state so the caller can react accordingly.
    if (artifactRef === undefined) {
      if (!isTerminal(run.status)) {
        throw new FakeDriverValidationError(
          "not_terminal",
          `Run ${runId} is ${run.status} and not yet terminal; artifact(handle) requires a terminal run`,
          false,
          { state: run.status, startedAt: run.startedAt, checkpoint: run.checkpoint }
        );
      }
      const terminalStatus =
        run.status === "succeeded" || run.status === "failed" || run.status === "canceled"
          ? run.status
          : "canceled";
      const finishedAt = run.finishedAt ?? resolvedAt;
      const files = [...run.artifacts];
      const metadata: Record<string, unknown> = {
        attempt: run.request.attempt,
        contractId: run.request.contractId,
        contractRevision: run.request.contractRevision,
        generation: run.generation,
        workerBundleId: run.request.workerBundle.id,
        sandboxDriver: run.request.workspace.sandboxDriver,
        worktreePath: run.request.workspace.worktreePath,
        terminalStatus: run.status
      };
      const finalOutputRef: ArtifactReference = {
        path: `.fake/${runId}/final-output.json` as ArtifactReference["path"],
        sha256: fakeContentHash(`${runId}|${terminalStatus}|${finishedAt}|${files.length}`)
      };
      // Record an artifact_registered stream event so downstream
      // consumers that subscribed to the stream see the final-output
      // fetch, mirroring the register-mode behaviour.
      this.appendStream(run, {
        kind: "artifact_registered",
        runId,
        at: resolvedAt,
        sequence: this.nextSequence(run),
        reference: finalOutputRef
      } as RuntimeStreamEvent);

      return {
        runId,
        reference: finalOutputRef,
        kind: "fetch",
        resolvedAt,
        status: terminalStatus,
        files,
        metadata,
        startedAt: run.startedAt,
        finishedAt,
        checkpoint: run.checkpoint,
        events: [] as readonly EventEnvelope[]
      };
    }

    // Register / fetch mode: an artifactRef was provided.
    const reference = artifactRef.reference;
    if (artifactRef.kind === "register") {
      if (!run.artifacts.some((existing) => existing.path === reference.path)) {
        run.artifacts.push(reference);
      }
    }
    this.appendStream(run, {
      kind: "artifact_registered",
      runId,
      at: resolvedAt,
      sequence: this.nextSequence(run),
      reference,
      ...(artifactRef.evidenceId ? { evidenceId: artifactRef.evidenceId } : {})
    } as RuntimeStreamEvent);

    return {
      runId,
      reference,
      kind: artifactRef.kind,
      resolvedAt,
      ...(artifactRef.evidenceId ? { evidenceId: artifactRef.evidenceId } : {}),
      events: [] as readonly EventEnvelope[]
    };
  }

  // -------------------------------------------------------------------------
  // Test introspection (not part of RuntimeDriver)
  // -------------------------------------------------------------------------

  /** Visible for tests only. Returns the current status. */
  __status(runId: RunId): FakeRunStatus | undefined {
    return this.runs.get(runId)?.status;
  }

  /** Visible for tests only. Returns the recorded stream length. */
  __streamLength(runId: RunId): number {
    return this.runs.get(runId)?.events.length ?? 0;
  }

  /** Visible for tests only. Number of registered runs. */
  __runCount(): number {
    return this.runs.size;
  }

  /** Visible for tests only. Promote a running run to awaiting_approval. */
  __requestApproval(runId: RunId): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    if (run.status !== "running") {
      throw new FakeDriverValidationError(
        "invalid_state",
        `Cannot request approval on run ${runId} in status ${run.status}`
      );
    }
    run.status = "awaiting_approval";
  }

  /**
   * Visible for tests only. Promote a running (or awaiting-approval)
   * run to a terminal `succeeded` | `failed` | `canceled` status so
   * the new `artifact(handle)` final-output path can be exercised
   * without going through a real provider completion. Appends a
   * matching `terminal` stream event so downstream consumers see
   * the transition the same way they would for a real
   * provider-driven completion.
   */
  __terminate(runId: RunId, terminalStatus: "succeeded" | "failed" | "canceled" = "succeeded"): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FakeDriverValidationError("unknown_run", `Run ${runId} is not registered with FakeRuntimeDriver`);
    }
    if (isTerminal(run.status)) {
      throw new FakeDriverValidationError(
        "invalid_state",
        `Cannot terminate run ${runId} that is already ${run.status}`
      );
    }
    if (terminalStatus !== "succeeded" && terminalStatus !== "failed" && terminalStatus !== "canceled") {
      throw new FakeDriverValidationError(
        "invalid_state",
        `__terminate only accepts succeeded|failed|canceled, got ${terminalStatus}`
      );
    }
    run.status = terminalStatus;
    run.finishedAt = this.clock.now();
    this.appendStream(run, {
      kind: "terminal",
      runId: run.runId,
      at: run.finishedAt,
      sequence: this.nextSequence(run),
      status: terminalStatus,
      evidenceRefs: []
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toStartResult(run: FakeRun): RuntimeStartResult {
    return {
      runId: run.runId,
      status: "started",
      manifestHash: run.checkpoint.fingerprint,
      startedAt: run.startedAt,
      checkpoint: run.checkpoint,
      events: []
    };
  }

  private appendStream(run: FakeRun, event: RuntimeStreamEvent): void {
    run.events.push(event);
    run.sequence = event.sequence;
  }

  private nextSequence(run: FakeRun): number {
    return run.events.length;
  }
}

/**
 * Validation error thrown by Fake methods for protocol-level
 * failures. Mirrors the shape used by `RuntimeLocalDriverError` but
 * is independent so test assertions do not have to import the
 * production error class.
 *
 * Optional `state` carries a provider-neutral snapshot of the run
 * state at the moment of the failure (used by `artifact(handle)`
 * non-terminal rejections so callers can branch on the current
 * status without re-issuing an `inspect` call).
 */
export class FakeDriverValidationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly state?: Readonly<Record<string, unknown>>;
  constructor(
    code: string,
    message: string,
    retryable: boolean = false,
    state?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    if (state) {
      this.state = state;
    }
    this.name = "FakeDriverValidationError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isTerminal(status: FakeRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function collapseForInspect(status: FakeRunStatus): RuntimeInspection["status"] {
  switch (status) {
    case "awaiting_approval":
    case "running":
      return "started";
    case "pending":
      return "created";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

function deriveFakeRunId(request: RuntimeStartRequest): RunId {
  // Deterministic and short: enough entropy for tests, no crypto.
  let hash = 0;
  const seed = `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const suffix = Math.abs(hash).toString(36).padStart(8, "0").slice(0, 16);
  return `run_fake_${suffix}` as RunId;
}

function fakeContentHash(seed: string): ContentHash {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 33 + seed.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
  return `sha256:${hex}` as ContentHash;
}

function validateStartRequest(
  request: RuntimeStartRequest,
  driverId: RuntimeDriverId
): { code: string; message: string } | null {
  if (request.driver.driver !== driverId.driver) {
    return {
      code: "driver_mismatch",
      message: `Request driver ${request.driver.driver} does not match loaded driver ${driverId.driver}`
    };
  }
  if (request.contractRevision <= 0) {
    return {
      code: "invalid_request",
      message: `contractRevision must be positive, received ${request.contractRevision}`
    };
  }
  if (request.attempt <= 0) {
    return {
      code: "invalid_request",
      message: `attempt must be positive, received ${request.attempt}`
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test fixture builders
// ---------------------------------------------------------------------------

/**
 * Minimum-viable `RuntimeStartRequest` for tests. Tests that need
 * more fields can spread and override.
 */
export function makeFakeStartRequest(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  const baseInputs: RuntimeStartInputs = {
    contractHash: fakeContentHash("contract"),
    currentSpecsHash: fakeContentHash("specs-current"),
    deltaSpecsHash: fakeContentHash("specs-delta"),
    oracleHash: fakeContentHash("oracle")
  };
  const requestedBy: Actor = { kind: "worker", id: "worker.fake" };
  const approvedAt = FIXED_FAKE_CLOCK.now();
  const driver = overrides.driver ?? {
    driver: FAKE_RUNTIME_DRIVER_ID,
    version: FAKE_RUNTIME_DRIVER_VERSION
  };
  const workerBundle: WorkerBundle = overrides.workerBundle ?? {
    id: "bundle.fake",
    version: FAKE_RUNTIME_DRIVER_VERSION,
    role: "implementer",
    domain: "runtime",
    capabilities: ["runtime.fake.smoke"],
    promptContentContract: {
      instructionsHash: fakeContentHash("instructions"),
      requiredSections: ["goal"],
      forbiddenSections: []
    }
  };
  return {
    projectId: "prj_fake" as RuntimeStartRequest["projectId"],
    changeId: "chg_fake" as RuntimeStartRequest["changeId"],
    taskId: "tsk_fake" as RuntimeStartRequest["taskId"],
    contractId: "ctr_fake" as RuntimeStartRequest["contractId"],
    contractRevision: 1,
    attempt: 1,
    workerBundle,
    inputs: baseInputs,
    repository: { baseCommit: "0000000000000000000000000000000000000000" },
    workspace: {
      sandboxDriver: "fake",
      worktreePath: "/tmp/fake-worktree"
    },
    policy: {
      riskTier: "R0",
      policyVersion: FAKE_RUNTIME_DRIVER_VERSION
    },
    idempotencyKey: "prj_fake:chg_fake:tsk_fake:run_fake_x:start:sha256:" + "0".repeat(64),
    requestedBy,
    approvedAt,
    driver,
    driverVersion: FAKE_RUNTIME_DRIVER_VERSION,
    protocolVersion: FAKE_RUNTIME_DRIVER_VERSION,
    ...overrides
  };
}

/**
 * Helper to build a minimal valid `RuntimeApprovalRef` for tests.
 */
export function makeFakeApprovalRef(overrides: Partial<RuntimeApprovalRef> = {}): RuntimeApprovalRef {
  const scope: ApprovalScope = overrides.scope ?? {
    effectClass: "S0",
    action: "fake.approve",
    targets: [{ kind: "run", id: ("run_fake_x" as RuntimeApprovalRef["runId"]) }]
  };
  return {
    approvalId: "apv_fake" as ApprovalId,
    runId: "run_fake_x" as RuntimeApprovalRef["runId"],
    scope,
    decidedBy: { kind: "human", id: "tester" },
    decidedAt: FIXED_FAKE_CLOCK.now(),
    reason: "approve",
    ...overrides
  };
}

/**
 * Helper to build a minimal `RuntimeArtifactRef` for tests.
 */
export function makeFakeArtifactRef(overrides: Partial<RuntimeArtifactRef> = {}): RuntimeArtifactRef {
  const reference: ArtifactReference = overrides.reference ?? {
    path: ".fake/artifact.txt" as ArtifactReference["path"],
    sha256: fakeContentHash("artifact-bytes")
  };
  return {
    kind: "register",
    reference,
    ...overrides
  };
}

/**
 * Helper to build a minimal `RuntimeCancelReason` for tests.
 */
export function makeFakeCancelReason(overrides: Partial<RuntimeCancelReason> = {}): RuntimeCancelReason {
  return {
    code: "user_canceled",
    message: "test cancellation",
    requestedBy: { kind: "human", id: "tester" },
    at: FIXED_FAKE_CLOCK.now(),
    ...overrides
  };
}
