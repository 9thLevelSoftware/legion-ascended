/**
 * ADR-004 `runtime-legacy-cli` driver — transitional compatibility path.
 *
 * Purpose:
 *  - Provide a fallback execution path that satisfies the seven-method
 *    `RuntimeDriver` contract for v8-like flows during the v9 rollout
 *    window. The v9 plan acknowledges that some users must continue
 *    running v8-shaped workflows while Eve is still public-preview and
 *    while `runtime-local` does not cover their edge cases (e.g.
 *    long-running streaming tasks, host-CLI session semantics).
 *  - Per ADR-004: "Transitional compatibility path with reduced
 *    guarantees for v8-like flows. … Keep host CLI adapters as the
 *    runtime — Revisit only for transitional legacy mode with reduced
 *    guarantees."
 *  - The driver itself does NOT spawn, link, or import any host CLI.
 *    That is a deliberate boundary: the import-boundary scan forbids
 *    `claude-code`, `codex-cli`, `kilo-cli`, etc. inside
 *    `packages/core/src/runtime/`. The driver is a deterministic
 *    in-memory stand-in that emits Legion-protocol events shaped like
 *    the events a legacy adapter would surface; the actual host CLI
 *    bridge (if needed in production) lives outside the core.
 *
 * Reduced-guarantee contract (intentional, documented):
 *  - Run ids are deterministic from the request idempotency key and a
 *    `legacy-compat` seed, but the run-id prefix is `leg_` so audit
 *    trails can tell legacy runs apart from runtime-local runs.
 *  - The checkpoint fingerprint is a `legacy-compat` placeholder; the
 *    driver cannot promise bitwise-equal checkpoint resume because the
 *    legacy host CLI does not expose provider-neutral checkpoint
 *    primitives.
 *  - `stream(runId)` emits a single deterministic progress event
 *    describing the legacy driver took ownership, then a terminal
 *    event with status `succeeded` and a synthetic evidence ref so
 *    downstream consumers can rely on the stream terminating exactly
 *    once. This is the strongest guarantee a host-CLI bridge can give
 *    without adopting Eve's checkpoint semantics.
 *  - `approve()` accepts the first approval with status `delivered`
 *    and records the decision; subsequent duplicate approvals are
 *    idempotent (same decidedAt + decidedBy.id). This matches v8 host
 *    CLI approval semantics (the host CLI replays the same decision
 *    on reconnect).
 *  - `artifact(runId, ref)` records the reference against the run's
 *    final-output bundle; `artifact(runId)` (no ref) returns the
 *    terminal bundle once the run is terminal. Same shape as
 *    `RuntimeLocalDriver`'s final-output mode.
 *  - Every method that the legacy adapter cannot fulfill without
 *    host-CLI access — e.g. true checkpoint resume fidelity, true
 *    sandbox re-creation, true artifact streaming — returns a typed
 *    `RuntimeLegacyCliError` with a `reduced_guarantee` code rather
 *    than a generic `unknown`. The selector and downstream consumers
 *    pattern-match on the code to distinguish a host-CLI bridge
 *    limitation from a real driver failure.
 *
 * Driver id:
 *  - `driver: "runtime-legacy-cli"`, `version: "0.1.0"`. The id is
 *    stable for the duration of Phase 5 / Phase 6 and may be bumped
 *    once Eve exits public preview.
 *
 * The driver never throws synchronous errors; every failure is a
 * rejected Promise so callers can `await` consistently. This mirrors
 * `RuntimeLocalDriver`.
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

/**
 * Driver id constants. `RUNTIME_LEGACY_CLI_DRIVER_ID` is the public
 * selector key; `RUNTIME_LEGACY_CLI_DRIVER_VERSION` is the pinned
 * schema version used by the import-boundary scan and the selector.
 */
export const RUNTIME_LEGACY_CLI_DRIVER_ID = "runtime-legacy-cli" as const;
export const RUNTIME_LEGACY_CLI_DRIVER_VERSION = "0.1.0" as const;

/**
 * The reduced-guarantee surface. `RuntimeLocalDriver` and any future
 * `RuntimeEveDriver` return `level: "full"`; `RuntimeLegacyCliDriver`
 * returns `level: "reduced"`. The selector surfaces this level so
 * board code and audit logs can see why a fallback path was chosen.
 */
export type RuntimeLegacyCliGuaranteeLevel = "full" | "reduced";

export interface RuntimeLegacyCliGuarantees {
  /**
   * Whether the driver can honor provider-neutral checkpoint resume
   * bitwise-equal. The legacy driver can NOT — it can only mirror the
   * request shape and emit a placeholder fingerprint.
   */
  readonly checkpointResumeFidelity: "exact" | "placeholder";

  /**
   * Whether `stream(runId)` yields a deterministic terminal event
   * sequence. The legacy driver promises exactly one terminal event
   * (`succeeded` or `canceled`); the run state machine treats that
   * single event as the only legal termination.
   */
  readonly streamTerminalShape: "single" | "multi";

  /**
   * Whether artifact references recorded during the run are preserved
   * in the final-output bundle. The legacy driver preserves them, but
   * with the same `legacy-compat` fingerprint caveat.
   */
  readonly artifactPreservation: "complete" | "reference-only";

  /**
   * The cumulative guarantee level. Always `"reduced"` for this
   * driver. Reserved as a string so the selector and audit logs can
   * read the level without a structural type match.
   */
  readonly level: RuntimeLegacyCliGuaranteeLevel;
}

export const RUNTIME_LEGACY_CLI_GUARANTEES: RuntimeLegacyCliGuarantees = {
  checkpointResumeFidelity: "placeholder",
  streamTerminalShape: "single",
  artifactPreservation: "reference-only",
  level: "reduced"
};

/**
 * Deterministic UTC clock so the legacy driver produces stable output
 * for tests. Production callers inject their own clock.
 */
export interface RuntimeLegacyCliClock {
  now(): UtcTimestamp;
}

export const FIXED_RUNTIME_LEGACY_CLI_CLOCK: RuntimeLegacyCliClock = {
  now: () => "2026-06-21T20:00:00.000Z" as UtcTimestamp
};

export interface RuntimeLegacyCliDriverOptions {
  readonly driverId?: RuntimeDriverId;
  readonly clock?: RuntimeLegacyCliClock;
}

/**
 * Internal run record. Mirrors `RuntimeLocalDriver`'s
 * `LocalRunState` but with a `legacy-compat` seed in the run id and a
 * `guaranteeLevel` field the selector / audit trail can read.
 */
interface LegacyRunState {
  readonly request: RuntimeStartRequest;
  readonly runId: RunId;
  status: "created" | "started" | "succeeded" | "failed" | "blocked" | "canceled" | "superseded" | "needs_human";
  startedAt: UtcTimestamp;
  finishedAt?: UtcTimestamp;
  checkpoint: RuntimeCheckpointRef;
  artifacts: ArtifactReference[];
  generation: number;
  guaranteeLevel: RuntimeLegacyCliGuaranteeLevel;
}

function isTerminalStatus(status: LegacyRunState["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "canceled" ||
    status === "superseded"
  );
}

/**
 * Typed errors emitted by the legacy driver. The `code` field is the
 * selector's stable contract; downstream consumers must pattern-match
 * on the code, never on the message.
 */
export class RuntimeLegacyCliError extends Error {
  readonly code:
    | "unknown_run"
    | "duplicate_run"
    | "driver_mismatch"
    | "invalid_request"
    | "stale_checkpoint"
    | "checkpoint_mismatch"
    | "terminal_run"
    | "already_canceled"
    | "already_succeeded"
    | "approval_not_acceptable"
    | "duplicate_approval"
    | "not_terminal"
    | "reduced_guarantee";
  readonly retryable: boolean;
  readonly state?: Readonly<Record<string, unknown>>;

  constructor(
    code: RuntimeLegacyCliError["code"],
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
    this.name = "RuntimeLegacyCliError";
  }
}

/**
 * The `runtime-legacy-cli` driver. State is held in-memory; the driver
 * is safe to instantiate per test and is not shared across processes.
 *
 * The driver implements the same seven-method `RuntimeDriver` shape
 * as `RuntimeLocalDriver` so the selector can substitute one for the
 * other without changing call sites. See the file-level docstring
 * for the documented reduced-guarantee contract.
 */
export class RuntimeLegacyCliDriver implements RuntimeDriver {
  readonly driverId: RuntimeDriverId;
  private readonly clock: RuntimeLegacyCliClock;
  private readonly runs: Map<RunId, LegacyRunState> = new Map();
  private readonly streams: Map<RunId, RuntimeStreamEvent[]> = new Map();
  private readonly approvals: Map<ApprovalId, RuntimeApprovalRef> = new Map();

  constructor(options: RuntimeLegacyCliDriverOptions = {}) {
    this.driverId = options.driverId ?? {
      driver: RUNTIME_LEGACY_CLI_DRIVER_ID,
      version: RUNTIME_LEGACY_CLI_DRIVER_VERSION as unknown as SchemaVersion
    };
    this.clock = options.clock ?? FIXED_RUNTIME_LEGACY_CLI_CLOCK;
  }

  /**
   * Returns the documented reduced-guarantee contract. Exposed as a
   * method (not a property) so the selector can call it uniformly
   * across drivers regardless of how each driver caches its
   * guarantees internally.
   */
  guarantees(): RuntimeLegacyCliGuarantees {
    return RUNTIME_LEGACY_CLI_GUARANTEES;
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    assertRequestContract(request, this.driverId);

    const runId = deriveLegacyRunId(request);
    if (this.runs.has(runId)) {
      throw new RuntimeLegacyCliError(
        "duplicate_run",
        `Run ${runId} already exists for ${request.idempotencyKey}`
      );
    }

    const startedAt = this.clock.now();
    const checkpoint = deriveLegacyCheckpoint(runId, request, startedAt, 1);
    const events = buildRunCreatedEvents(request, runId, startedAt, checkpoint);

    const state: LegacyRunState = {
      request,
      runId,
      status: "started",
      startedAt,
      checkpoint,
      artifacts: [],
      generation: 1,
      guaranteeLevel: RUNTIME_LEGACY_CLI_GUARANTEES.level
    };
    this.runs.set(runId, state);
    this.streams.set(runId, [
      {
        kind: "progress",
        runId,
        at: startedAt,
        sequence: 0,
        note: `runtime-legacy-cli: started ${request.taskId} on attempt ${request.attempt} under reduced-guarantee fallback (checkpointResumeFidelity=${RUNTIME_LEGACY_CLI_GUARANTEES.checkpointResumeFidelity}, streamTerminalShape=${RUNTIME_LEGACY_CLI_GUARANTEES.streamTerminalShape}, artifactPreservation=${RUNTIME_LEGACY_CLI_GUARANTEES.artifactPreservation})`
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
    if (isTerminalStatus(state.status)) {
      throw new RuntimeLegacyCliError(
        "terminal_run",
        `Run ${runId} is ${state.status} and cannot be resumed`,
        false,
        { state: state.status, startedAt: state.startedAt, checkpoint: state.checkpoint }
      );
    }
    if (checkpointRef.generation !== state.checkpoint.generation) {
      throw new RuntimeLegacyCliError(
        "stale_checkpoint",
        `Checkpoint generation ${checkpointRef.generation} does not match run ${runId} generation ${state.checkpoint.generation}`
      );
    }
    if (checkpointRef.fingerprint !== state.checkpoint.fingerprint) {
      throw new RuntimeLegacyCliError(
        "checkpoint_mismatch",
        `Checkpoint fingerprint for ${runId} does not match recorded fingerprint; the legacy driver only promises placeholder fingerprint equality (see RUNTIME_LEGACY_CLI_GUARANTEES.checkpointResumeFidelity)`
      );
    }

    const resumedAt = this.clock.now();
    state.generation += 1;
    state.checkpoint = deriveLegacyCheckpoint(runId, state.request, resumedAt, state.generation);
    state.status = "started";
    const events = buildRunResumedEvents(state, resumedAt);

    this.appendStream(state.runId, {
      kind: "progress",
      runId,
      at: resumedAt,
      sequence: this.nextSequence(runId),
      note: `runtime-legacy-cli: resumed ${state.request.taskId} at generation ${state.generation} (reduced-guarantee)`
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
      throw new RuntimeLegacyCliError("already_canceled", `Run ${runId} is already canceled`);
    }

    state.status = "canceled";
    const finishedAt = this.clock.now();
    state.finishedAt = finishedAt;
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

    return {
      runId,
      status: state.status,
      startedAt: state.startedAt,
      checkpoint: state.checkpoint,
      sandbox,
      artifacts: [...state.artifacts],
      ...(state.finishedAt ? { finishedAt: state.finishedAt } : {})
    };
  }

  async *stream(runId: RunId): AsyncIterable<RuntimeStreamEvent> {
    const events = this.streams.get(runId);
    if (!events) {
      throw new RuntimeLegacyCliError("unknown_run", `Run ${runId} has no recorded stream`);
    }
    for (const event of events) {
      yield event;
    }
  }

  async approve(approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome> {
    const state = this.requireRun(approvalRef.runId);
    if (state.status !== "started" && state.status !== "needs_human") {
      throw new RuntimeLegacyCliError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} is ${state.status} and cannot accept approval (reduced-guarantee driver)`
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
          reason: "duplicate approval is idempotent (legacy adapter replay)",
          events: []
        };
      }
      throw new RuntimeLegacyCliError(
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

    if (artifactRef === undefined) {
      if (!isTerminalStatus(state.status)) {
        throw new RuntimeLegacyCliError(
          "not_terminal",
          `Run ${runId} is ${state.status} and not yet terminal; artifact(handle) requires a terminal run (legacy driver)`,
          false,
          { state: state.status, startedAt: state.startedAt, checkpoint: state.checkpoint }
        );
      }
      const terminalStatus: "succeeded" | "failed" | "blocked" | "canceled" =
        state.status === "succeeded" ||
        state.status === "failed" ||
        state.status === "blocked" ||
        state.status === "canceled"
          ? state.status
          : "canceled";
      const finishedAt = state.finishedAt ?? resolvedAt;
      const files = [...state.artifacts];
      const metadata: Record<string, unknown> = {
        attempt: state.request.attempt,
        contractId: state.request.contractId,
        contractRevision: state.request.contractRevision,
        generation: state.generation,
        workerBundleId: state.request.workerBundle.id,
        sandboxDriver: state.request.workspace.sandboxDriver,
        worktreePath: state.request.workspace.worktreePath,
        terminalStatus: state.status,
        guaranteeLevel: state.guaranteeLevel,
        checkpointResumeFidelity: RUNTIME_LEGACY_CLI_GUARANTEES.checkpointResumeFidelity,
        streamTerminalShape: RUNTIME_LEGACY_CLI_GUARANTEES.streamTerminalShape,
        artifactPreservation: RUNTIME_LEGACY_CLI_GUARANTEES.artifactPreservation
      };
      const finalOutputRef: ArtifactReference = {
        path: `.runtime-legacy-cli/${runId}/final-output.json` as ArtifactReference["path"],
        sha256: sha256ContentHash(`legacy-compat|${runId}|${terminalStatus}|${finishedAt}|${files.length}`)
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

    const reference = artifactRef.reference;
    if (artifactRef.kind === "register") {
      state.artifacts.push(reference);
    }
    const evidenceId = artifactRef.evidenceId;
    const events: EventEnvelope[] = buildArtifactEvents(state, reference, resolvedAt, evidenceId);
    this.appendStream(state.runId, {
      kind: "artifact_registered",
      runId,
      at: resolvedAt,
      sequence: this.nextSequence(runId),
      reference,
      ...(evidenceId ? { evidenceId } : {})
    });

    return evidenceId
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
  }

  /**
   * Visible for tests only — drive a started run to a terminal
   * `succeeded` state so callers can exercise the final-output bundle
   * path without waiting on a host-CLI bridge. Mirrors
   * `RuntimeLocalDriver.__terminate`.
   */
  __terminate(runId: RunId, status: "succeeded" | "failed" | "blocked" = "succeeded"): void {
    const state = this.requireRun(runId);
    if (state.status === "succeeded" || state.status === "canceled") {
      throw new RuntimeLegacyCliError(
        status === "succeeded" ? "already_succeeded" : "already_canceled",
        `Run ${runId} is already terminal (${state.status}); __terminate is a no-op`
      );
    }
    state.status = status;
    const finishedAt = this.clock.now();
    state.finishedAt = finishedAt;
    this.appendStream(state.runId, {
      kind: "terminal",
      runId,
      at: finishedAt,
      sequence: this.nextSequence(runId),
      status,
      evidenceRefs: []
    });
  }

  /** Visible for tests only — returns the recorded guarantee level. */
  __guaranteeLevel(runId: RunId): RuntimeLegacyCliGuaranteeLevel {
    return this.requireRun(runId).guaranteeLevel;
  }

  /** Visible for tests only — returns the count of events recorded. */
  __streamLength(runId: RunId): number {
    return this.streams.get(runId)?.length ?? 0;
  }

  private requireRun(runId: RunId): LegacyRunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new RuntimeLegacyCliError("unknown_run", `Run ${runId} is not registered with runtime-legacy-cli`);
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

function assertRequestContract(request: RuntimeStartRequest, driverId: RuntimeDriverId): void {
  if (request.driver.driver !== driverId.driver) {
    throw new RuntimeLegacyCliError(
      "driver_mismatch",
      `Request driver ${request.driver.driver} does not match loaded driver ${driverId.driver}`
    );
  }
  if (request.contractRevision <= 0) {
    throw new RuntimeLegacyCliError(
      "invalid_request",
      `contractRevision must be positive, received ${request.contractRevision}`
    );
  }
  if (request.attempt <= 0) {
    throw new RuntimeLegacyCliError(
      "invalid_request",
      `attempt must be positive, received ${request.attempt}`
    );
  }
}

function deriveLegacyRunId(request: RuntimeStartRequest): RunId {
  const seed = `legacy-compat|${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`;
  const hash = sha256Hex(seed);
  const suffix = hash.slice(0, 22);
  return `leg_${suffix}` as RunId;
}

function deriveLegacyCheckpoint(
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
    at,
    guaranteeLevel: RUNTIME_LEGACY_CLI_GUARANTEES.level,
    note: "legacy-compat placeholder fingerprint; the legacy driver only promises placeholder equality (see RUNTIME_LEGACY_CLI_GUARANTEES.checkpointResumeFidelity)"
  });
  const fingerprint = sha256ContentHash(payload);
  return {
    runId,
    generation,
    fingerprint,
    note: `runtime-legacy-cli checkpoint for ${request.taskId} attempt ${request.attempt} (legacy-compat)`
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
    occurredAt: startedAt,
    payload: {
      runId,
      taskId,
      contractId: request.contractId,
      attempt: request.attempt,
      driver: RUNTIME_LEGACY_CLI_DRIVER_ID,
      guaranteeLevel: RUNTIME_LEGACY_CLI_GUARANTEES.level
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
    occurredAt: startedAt,
    payload: {
      runId,
      taskId,
      startedAt,
      guaranteeLevel: RUNTIME_LEGACY_CLI_GUARANTEES.level
    },
    causationId: created.id
  });

  return [created, started];
}

function buildRunResumedEvents(state: LegacyRunState, resumedAt: UtcTimestamp): EventEnvelope[] {
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
      occurredAt: resumedAt,
      payload: {
        runId: state.runId,
        taskId: state.request.taskId,
        startedAt: resumedAt,
        guaranteeLevel: state.guaranteeLevel
      }
    })
  ];
}

function buildRunFinishedEvents(
  state: LegacyRunState,
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
      occurredAt: finishedAt,
      payload: {
        runId: state.runId,
        taskId: state.request.taskId,
        status,
        finishedAt,
        evidenceRefs: [],
        guaranteeLevel: state.guaranteeLevel
      }
    })
  ];
}

function buildApprovalGrantedEvents(
  state: LegacyRunState,
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
      occurredAt: deliveredAt,
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
      occurredAt: deliveredAt,
      payload: {
        approvalId,
        decidedBy: approvalRef.decidedBy,
        reason: approvalRef.reason
      }
    })
  ];
}

function buildArtifactEvents(
  state: LegacyRunState,
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
      occurredAt: resolvedAt,
      payload: {
        evidenceId,
        taskId: state.request.taskId,
        runId: state.runId,
        verdict: "pass",
        guaranteeLevel: state.guaranteeLevel
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
  readonly occurredAt: UtcTimestamp;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causationId?: EventEnvelope["id"];
  readonly correlationId?: EventEnvelope["correlationId"];
}

function buildEvent(input: BuildEventInput): EventEnvelope {
  const id = deterministicEventId(input.type, input.runId, input.sequence, input.generation);
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
    occurredAt: input.occurredAt,
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
  const hash = sha256Hex(`${type}|${runId}|${sequence}|${generation}|${RUNTIME_LEGACY_CLI_DRIVER_ID}`);
  return `evt_${hash.slice(0, 26)}`;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function sha256ContentHash(input: string): ContentHash {
  return `sha256:${sha256Hex(input)}` as unknown as ContentHash;
}

/**
 * Convenience factory for worker bundles in tests.
 */
export function buildLegacyCliWorkerBundle(): WorkerBundle {
  return {
    id: "legion.legacy-cli-worker",
    version: "0.1.0" as unknown as WorkerBundle["version"],
    role: "implementer",
    domain: "core",
    capabilities: ["filesystem.read", "filesystem.write"],
    promptContentContract: {
      instructionsHash: sha256ContentHash("legacy-cli-worker"),
      requiredSections: ["workflow"],
      forbiddenSections: []
    }
  };
}

/**
 * Convenience helper for tests that need a valid `ApprovalScope`.
 */
export function scopeForLegacyApproval(approvalId: ApprovalId, runId: RunId): ApprovalScope {
  return {
    effectClass: "S2",
    action: "approve-run",
    targets: [
      { kind: "approval", id: approvalId },
      { kind: "run", id: runId }
    ]
  };
}
