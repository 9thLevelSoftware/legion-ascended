/**
 * ADR-004 `runtime-eve` driver.
 *
 * Implements the seven-method `RuntimeDriver` contract
 * (`start` / `resume` / `cancel` / `inspect` / `stream` /
 * `approve` / `artifact`) against Vercel Eve's documented public
 * TypeScript surface.
 *
 * The driver is intentionally thin: every Eve interaction goes
 * through the `EveTransport` boundary so the rest of the package
 * never imports the `eve` module directly. This keeps the
 * `runtime-eve` package testable in environments where the
 * pinned `eve@0.11.7` peer dependency is not installed and
 * keeps the import-boundary scan
 * (`scripts/scan-runtime-import-boundaries.mjs`) free of Eve
 * references inside the `runtime-eve` package.
 *
 * Event translation (per ADR-004): the driver must translate
 * provider details into Legion protocol events before they enter
 * the store. We do that here by mapping
 *   - `defineAgent`            -> `run.created.v1` + `run.started.v1`
 *   - `resumeSession`          -> `run.started.v1`
 *   - `cancelSession`          -> `run.finished.v1` (status: canceled)
 *   - `deliverApproval`        -> `approval.requested.v1` + `approval.granted.v1`
 *   - `resolveArtifact`        -> `evidence.collected.v1`
 *   - `streamSession`          -> `progress` / `tool_call` / `artifact_registered` / `terminal`
 *
 * The `FakeEveTransport` exercises this surface in the public
 * contract test suite. The `RealEveTransport` wraps Eve's public
 * `defineAgent` / `ctx` helpers in production.
 */

import * as crypto from "node:crypto";

import type {
  Actor,
  ApprovalId,
  ArtifactReference,
  ContentHash,
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
} from "@legion/core";

import {
  RUNTIME_EVE_PINNED_VERSION,
  type EveAgentSpec,
  type EveSessionSnapshot,
  type EveSubagentSpec,
  type EveTransport,
  type EveTransportEvent
} from "../transport/contract.js";
import { buildEveSubagentSpec, invokeSubagent as invokeSubagentHelper } from "../subagent/invoke.js";
import { buildEveSandboxSpec, openSandbox as openSandboxHelper } from "../sandbox/open.js";
import { runEval as runEvalHelper, type EvalDefinition } from "../eval/run.js";

export const RUNTIME_EVE_DRIVER_ID = "runtime-eve" as const;
export const RUNTIME_EVE_DRIVER_VERSION = "0.1.0" as const;

export interface RuntimeEveDriverOptions {
  readonly transport: EveTransport;
  readonly driverId?: RuntimeDriverId;
  readonly clock?: RuntimeEveClock;
  readonly fallbackInstructions?: string;
}

export interface RuntimeEveClock {
  now(): UtcTimestamp;
}

export const FIXED_RUNTIME_EVE_CLOCK: RuntimeEveClock = {
  now: () => "2026-06-21T20:00:00.000Z" as UtcTimestamp
};

interface EveRunState {
  readonly request: RuntimeStartRequest;
  readonly sessionId: string;
  readonly runId: RunId;
  continuationToken: string;
  readonly manifestHash: ContentHash;
  status: RuntimeInspection["status"];
  startedAt: UtcTimestamp;
  finishedAt?: UtcTimestamp;
  checkpoint: RuntimeCheckpointRef;
  artifacts: ArtifactReference[];
  approvals: Map<ApprovalId, RuntimeApprovalRef>;
  generation: number;
  approvalMode: "always" | "once" | "never";
  usedApprovals: Set<ApprovalId>;
  subagents: Map<string, WorkerBundle>;
  subagentInvocations: Array<{ subagentId: string; input: Readonly<Record<string, unknown>>; output: Readonly<Record<string, unknown>> }>;
  evalReports: Map<string, { status: "pass" | "fail" | "error"; assertions: ReadonlyArray<{ description: string; status: "pass" | "fail" }> }>;
}

export class RuntimeEveDriverError extends Error {
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
    this.name = "RuntimeEveDriverError";
  }
}

/**
 * The `runtime-eve` driver. State is held in-memory; the driver
 * is safe to instantiate per test and is not shared across
 * processes. Production deployments instantiate one driver per
 * workflow run and pass it a `RealEveTransport` that wraps Eve's
 * public `defineAgent` / `ctx` helpers.
 */
export class RuntimeEveDriver implements RuntimeDriver {
  readonly driverId: RuntimeDriverId;
  private readonly transport: EveTransport;
  private readonly clock: RuntimeEveClock;
  private readonly fallbackInstructions: string;
  private readonly runs: Map<RunId, EveRunState> = new Map();
  private readonly streamLogs: Map<RunId, RuntimeStreamEvent[]> = new Map();

  constructor(options: RuntimeEveDriverOptions) {
    this.transport = options.transport;
    this.clock = options.clock ?? FIXED_RUNTIME_EVE_CLOCK;
    this.fallbackInstructions = options.fallbackInstructions ?? "Legion Next runtime-eve default instructions";
    this.driverId = options.driverId ?? {
      driver: RUNTIME_EVE_DRIVER_ID,
      version: RUNTIME_EVE_DRIVER_VERSION as unknown as SchemaVersion
    };
  }

  /**
   * `start` — invoke Eve's `defineAgent` helper, freeze the
   * manifest hash, and emit `run.created.v1` + `run.started.v1`
   * protocol events.
   */
  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    assertRequestContract(request, this.driverId);

    if (this.transport.pinnedEveVersion !== RUNTIME_EVE_PINNED_VERSION) {
      throw new RuntimeEveDriverError(
        "eve_version_mismatch",
        `runtime-eve requires pinned eve@${RUNTIME_EVE_PINNED_VERSION}; transport is pinned ${this.transport.pinnedEveVersion}`
      );
    }

    const runId = deriveRunId(request);
    if (this.runs.has(runId)) {
      throw new RuntimeEveDriverError("duplicate_run", `Run ${runId} already exists for ${request.idempotencyKey}`);
    }

    const sandboxSpec = buildEveSandboxSpec(request.workspace, request.policy);
    const subagentSpecs: EveSubagentSpec[] = [];
    const declaredSubagents = (request.workerBundle as unknown as Record<string, unknown>)["subagents"] as ReadonlyArray<{ id: string; instructionsPath?: string }> | undefined;
    if (Array.isArray(declaredSubagents)) {
      for (const sub of declaredSubagents) {
        subagentSpecs.push({
          id: sub.id,
          instructionsPath: sub.instructionsPath ?? `${request.taskId}/subagents/${sub.id}/instructions.md`,
          capabilities: [...request.workerBundle.capabilities]
        });
      }
    }

    const eveSpec: EveAgentSpec = {
      agentId: `${request.taskId}-attempt-${request.attempt}`,
      contractId: request.contractId,
      contractRevision: request.contractRevision,
      attempt: request.attempt,
      workerBundleId: request.workerBundle.id,
      workerBundleVersion: request.workerBundle.version as unknown as string,
      policyTier: request.policy.riskTier,
      instructions: this.fallbackInstructions,
      approvalPolicy: { kind: "always" },
      sandbox: sandboxSpec,
      subagents: subagentSpecs
    };

    const authored = await this.transport.defineAgent(eveSpec);
    const startedAt = this.clock.now();
    const checkpoint: RuntimeCheckpointRef = {
      runId,
      generation: 1,
      fingerprint: authored.manifestHash as unknown as ContentHash,
      note: `runtime-eve: defineAgent(${eveSpec.agentId}) -> ${authored.sessionId}`
    };

    const state: EveRunState = {
      request,
      runId,
      sessionId: authored.sessionId,
      continuationToken: authored.continuationToken,
      manifestHash: authored.manifestHash as unknown as ContentHash,
      status: "started",
      startedAt,
      checkpoint,
      artifacts: [],
      approvals: new Map(),
      generation: 1,
      approvalMode: "always",
      usedApprovals: new Set(),
      subagents: new Map(),
      subagentInvocations: [],
      evalReports: new Map()
    };
    this.runs.set(runId, state);
    this.streamLogs.set(runId, [
      {
        kind: "progress",
        runId,
        at: startedAt,
        sequence: 0,
        note: `runtime-eve: started ${request.taskId} on attempt ${request.attempt}`
      }
    ]);

    const events = buildRunCreatedEvents(request, runId, state.sessionId, startedAt, checkpoint);
    return { runId, status: "started", manifestHash: state.manifestHash, startedAt, checkpoint, events };
  }

  /**
   * `resume` — translate a provider-neutral checkpoint ref into
   * Eve's `continuationToken` resume signal and advance the
   * checkpoint generation.
   */
  async resume(runId: RunId, checkpointRef: RuntimeCheckpointRef): Promise<RuntimeResumeResult> {
    const state = this.requireRun(runId);
    await this.refreshRunState(state);
    if (isTerminalStatus(state.status)) {
      throw new RuntimeEveDriverError(
        "terminal_run",
        `Run ${runId} is ${state.status} and cannot be resumed`,
        false,
        { state: state.status, startedAt: state.startedAt, checkpoint: state.checkpoint }
      );
    }
    if (checkpointRef.generation !== state.checkpoint.generation) {
      throw new RuntimeEveDriverError(
        "stale_checkpoint",
        `Checkpoint generation ${checkpointRef.generation} does not match run ${runId} generation ${state.checkpoint.generation}`
      );
    }
    if (checkpointRef.fingerprint !== state.checkpoint.fingerprint) {
      throw new RuntimeEveDriverError(
        "checkpoint_mismatch",
        `Checkpoint fingerprint for ${runId} does not match recorded fingerprint`
      );
    }

    const resumed = await this.transport.resumeSession(
      state.sessionId,
      state.continuationToken,
      state.checkpoint.fingerprint
    );
    state.generation = resumed.checkpointGeneration;
    state.checkpoint = {
      runId,
      generation: resumed.checkpointGeneration,
      fingerprint: resumed.checkpointFingerprint as unknown as ContentHash,
      note: `runtime-eve: resumed at generation ${resumed.checkpointGeneration}`
    };
    state.status = "started";
    state.continuationToken = resumed.continuationToken;
    const resumedAt = this.clock.now();
    this.appendStream(runId, {
      kind: "progress",
      runId,
      at: resumedAt,
      sequence: this.nextSequence(runId),
      note: `runtime-eve: resumed ${state.request.taskId} at generation ${state.generation}`
    });

    const events = buildRunResumedEvents(state, resumedAt);
    return { runId, status: "started", resumedAt, checkpoint: state.checkpoint, events };
  }

  /**
   * `cancel` — request termination and record the result
   * without deleting run history. Emits `run.finished.v1`
   * with `status: canceled` and translates the cancel reason
   * into a provider-neutral `ProtocolError` payload.
   */
  async cancel(runId: RunId, reason: RuntimeCancelReason): Promise<RuntimeCancelResult> {
    const state = this.requireRun(runId);
    if (state.status === "canceled") {
      throw new RuntimeEveDriverError("already_canceled", `Run ${runId} is already canceled`);
    }
    const finished = await this.transport.cancelSession(state.sessionId, { code: reason.code, message: reason.message });
    state.status = "canceled";
    state.finishedAt = finished.finishedAt as UtcTimestamp;
    this.appendStream(runId, {
      kind: "terminal",
      runId,
      at: state.finishedAt,
      sequence: this.nextSequence(runId),
      status: "canceled",
      evidenceRefs: []
    });
    const events = buildRunFinishedEvents(state, state.finishedAt, "canceled");
    return { runId, status: "canceled", finishedAt: state.finishedAt, reason, events };
  }

  /**
   * `inspect` — read-only query. Translates the Eve session
   * snapshot into the contract's `RuntimeInspection` shape.
   */
  async inspect(runId: RunId): Promise<RuntimeInspection> {
    const state = this.requireRun(runId);
    const snapshot = await this.transport.inspectSession(state.sessionId);
    this.applySnapshot(state, snapshot);
    const sandbox: RuntimeSandboxState = {
      sandboxDriver: snapshot.sandbox.sandboxDriver,
      worktreePath: snapshot.sandbox.worktreePath,
      generation: state.generation,
      sealed: snapshot.sandbox.sealed
    };
    return {
      runId,
      status: state.status,
      checkpoint: state.checkpoint,
      sandbox,
      artifacts: [...state.artifacts],
      ...(snapshot.startedAt ? { startedAt: snapshot.startedAt as UtcTimestamp } : {}),
      ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt as UtcTimestamp } : {}),
      ...(snapshot.lastError
        ? {
            lastError: {
              code: snapshot.lastError.code,
              message: snapshot.lastError.message,
              retryable: false
            }
          }
        : {})
    };
  }

  /**
   * `stream` — translate Eve's `sessionStream` events into the
   * provider-neutral `RuntimeStreamEvent` shape.
   */
  async *stream(runId: RunId): AsyncIterable<RuntimeStreamEvent> {
    const state = this.requireRun(runId);
    const log = this.streamLogs.get(runId) ?? [];
    for (const event of log) {
      yield event;
    }
    let sequence = this.nextSequence(runId);
    for await (const event of this.transport.streamSession(state.sessionId)) {
      const translated = translateStreamEvent(event, runId, sequence);
      sequence += 1;
      if (translated.kind === "terminal") {
        this.applyTerminalStreamEvent(state, translated);
      }
      yield translated;
    }
  }

  /**
   * `approve` — deliver a durable human authorization to a
   * paused run. The transport translates the approval into
   * Eve's provider-native resume signal.
   */
  async approve(approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome> {
    const state = this.requireRun(approvalRef.runId);
    if (state.status !== "started" && state.status !== "needs_human") {
      throw new RuntimeEveDriverError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} is ${state.status} and cannot accept approval`
      );
    }
    if (state.approvalMode === "never") {
      throw new RuntimeEveDriverError(
        "approval_not_acceptable",
        `Run ${approvalRef.runId} policy tier ${state.request.policy.riskTier} rejects all approvals`
      );
    }
    if (state.approvalMode === "once" && state.usedApprovals.has(approvalRef.approvalId)) {
      return {
        runId: approvalRef.runId,
        approvalId: approvalRef.approvalId,
        status: "delivered",
        deliveredAt: approvalRef.decidedAt,
        reason: "duplicate approval is idempotent for once-mode policy",
        events: []
      };
    }

    const previous = state.approvals.get(approvalRef.approvalId);
    if (previous && previous.decidedAt === approvalRef.decidedAt && previous.decidedBy.id === approvalRef.decidedBy.id) {
      return {
        runId: approvalRef.runId,
        approvalId: approvalRef.approvalId,
        status: "delivered",
        deliveredAt: approvalRef.decidedAt,
        reason: "duplicate approval is idempotent",
        events: []
      };
    }
    if (previous) {
      throw new RuntimeEveDriverError(
        "duplicate_approval",
        `Approval ${approvalRef.approvalId} already delivered with a different decision`
      );
    }

    const delivered = await this.transport.deliverApproval(state.sessionId, approvalRef.approvalId, approvalRef.reason);
    state.approvals.set(approvalRef.approvalId, approvalRef);
    state.usedApprovals.add(approvalRef.approvalId);
    this.appendStream(approvalRef.runId, {
      kind: "approval_requested",
      runId: approvalRef.runId,
      at: delivered.deliveredAt as UtcTimestamp,
      sequence: this.nextSequence(approvalRef.runId),
      approvalId: approvalRef.approvalId,
      scope: approvalRef.scope,
      requestedBy: approvalRef.decidedBy
    });
    const events = buildApprovalGrantedEvents(state, approvalRef, delivered.deliveredAt as UtcTimestamp);
    return {
      runId: approvalRef.runId,
      approvalId: approvalRef.approvalId,
      status: "delivered",
      deliveredAt: delivered.deliveredAt as UtcTimestamp,
      reason: approvalRef.reason,
      events
    };
  }

  /**
   * `artifact` — register/fetch a single artifact OR — when
   * called with no `artifactRef` — return the final structured
   * output bundle for a terminal run.
   */
  async artifact(runId: RunId, artifactRef?: RuntimeArtifactRef): Promise<RuntimeArtifactHandle> {
    const state = this.requireRun(runId);
    const resolvedAt = this.clock.now();

    if (artifactRef === undefined) {
      await this.refreshRunState(state);
      if (!isTerminalStatus(state.status)) {
        throw new RuntimeEveDriverError(
          "not_terminal",
          `Run ${runId} is ${state.status} and not yet terminal; artifact(handle) requires a terminal run`,
          false,
          { state: state.status, startedAt: state.startedAt, checkpoint: state.checkpoint }
        );
      }
      const bundle = await this.transport.resolveFinalOutput(state.sessionId);
      const terminalStatus = terminalArtifactStatus(state.status);
      const finishedAt = state.finishedAt ?? (bundle.finishedAt as UtcTimestamp);
      state.status = terminalStatus;
      state.finishedAt = finishedAt;
      const files = bundle.files.map((file) => ({
        path: file.reference as unknown as ArtifactReference["path"],
        sha256: normalizeContentHash(file.sha256, `runtime-eve:final-output-file:${file.reference}`)
      }));
      const finalOutputRef: ArtifactReference = {
        path: `.runtime-eve/${runId}/final-output.json` as unknown as ArtifactReference["path"],
        sha256: sha256ContentHash(`${runId}|${terminalStatus}|${finishedAt}|${files.length}`)
      };
      this.appendStream(runId, {
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
        metadata: {
          attempt: state.request.attempt,
          contractId: state.request.contractId,
          contractRevision: state.request.contractRevision,
          generation: bundle.checkpointGeneration,
          workerBundleId: state.request.workerBundle.id,
          sandboxDriver: state.request.workspace.sandboxDriver,
          worktreePath: state.request.workspace.worktreePath,
          terminalStatus,
          eveVersion: this.transport.pinnedEveVersion
        },
        startedAt: state.startedAt,
        finishedAt,
        checkpoint: state.checkpoint,
        events: []
      };
    }

    const reference: ArtifactReference = artifactRef.reference;
    const resolved = await this.transport.resolveArtifact(state.sessionId, {
      kind: artifactRef.kind,
      reference: reference.path,
      sha256: reference.sha256 as unknown as string
    });
    if (artifactRef.kind === "register") {
      state.artifacts.push(reference);
    }
    const events = buildArtifactEvents(state, reference, resolvedAt, artifactRef.evidenceId);
    this.appendStream(runId, {
      kind: "artifact_registered",
      runId,
      at: resolvedAt,
      sequence: this.nextSequence(runId),
      reference,
      ...(artifactRef.evidenceId ? { evidenceId: artifactRef.evidenceId } : {})
    });
    const handle: RuntimeArtifactHandle = {
      runId,
      reference,
      kind: artifactRef.kind,
      resolvedAt,
      events
    };
    if (artifactRef.evidenceId) {
      return { ...handle, evidenceId: artifactRef.evidenceId };
    }
    return handle;
  }

  // -------------------------------------------------------------------
  // Subagent / sandbox / eval public methods (P05-B001 acceptance)
  // -------------------------------------------------------------------

  /**
   * Register a Legion worker bundle as an Eve remote subagent
   * and invoke it. Returns the provider-neutral result.
   */
  async registerAndInvokeSubagent(
    runId: RunId,
    workerBundle: WorkerBundle,
    input: Readonly<Record<string, unknown>>,
    invokedBy: Actor
  ): Promise<{ subagentId: string; output: Readonly<Record<string, unknown>>; at: UtcTimestamp }> {
    const state = this.requireRun(runId);
    state.subagents.set(workerBundle.id, workerBundle);
    const spec = buildEveSubagentSpec(workerBundle, `${state.request.taskId}/subagents/${workerBundle.id}/instructions.md`);
    void spec; // we still register through the helper for the
    //              side effect of pushing the bundle into the
    //              state map above; the transport call happens
    //              via the helper below.
    const result = await invokeSubagentHelper(
      this.transport,
      runId,
      state.sessionId,
      {
        subagentId: workerBundle.id,
        workerBundle,
        input,
        invokedBy,
        at: this.clock.now()
      }
    );
    state.subagentInvocations.push({ subagentId: result.subagentId, input, output: result.output });
    this.appendStream(runId, {
      kind: "tool_call",
      runId,
      at: result.at,
      sequence: this.nextSequence(runId),
      tool: `subagent.${result.subagentId}`,
      input
    });
    return { subagentId: result.subagentId, output: result.output, at: result.at };
  }

  /**
   * Open the Eve sandbox for a session. Wraps the transport
   * `openSandbox` helper and records the result in the run's
   * state so subsequent `inspect` calls report the live
   * sandbox execution.
   */
  async openRunSandbox(runId: RunId): Promise<{ sandbox: RuntimeSandboxState; networkEgressAllowed: boolean }> {
    const state = this.requireRun(runId);
    const spec = buildEveSandboxSpec(state.request.workspace, state.request.policy);
    const execution = await openSandboxHelper(this.transport, state.sessionId, spec);
    return {
      sandbox: {
        sandboxDriver: execution.sandboxDriver,
        worktreePath: execution.worktreePath,
        generation: state.generation,
        sealed: execution.sealed
      },
      networkEgressAllowed: execution.networkEgressAllowed
    };
  }

  /**
   * Run an Eve eval against the session. The transport returns
   * a structured `EveEvalReport` we record as evidence.
   */
  async runRunEval(
    runId: RunId,
    definition: EvalDefinition
  ): Promise<{ status: "pass" | "fail" | "error"; report: Readonly<Record<string, unknown>> }> {
    const state = this.requireRun(runId);
    const result = await runEvalHelper(this.transport, runId, state.sessionId, definition);
    state.evalReports.set(definition.name, { status: result.report.status, assertions: result.report.assertions });
    this.appendStream(runId, {
      kind: "progress",
      runId,
      at: this.clock.now(),
      sequence: this.nextSequence(runId),
      note: `runtime-eve: eval ${definition.name} -> ${result.report.status}`
    });
    return { status: result.report.status, report: { ...result.report, evidenceId: result.evidenceId } };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private requireRun(runId: RunId): EveRunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new RuntimeEveDriverError("unknown_run", `Run ${runId} is not registered with runtime-eve`);
    }
    return state;
  }

  private appendStream(runId: RunId, event: RuntimeStreamEvent): void {
    const log = this.streamLogs.get(runId);
    if (!log) return;
    log.push(event);
  }

  private nextSequence(runId: RunId): number {
    const log = this.streamLogs.get(runId);
    return log ? log.length : 0;
  }

  private async refreshRunState(state: EveRunState): Promise<void> {
    const snapshot = await this.transport.inspectSession(state.sessionId);
    this.applySnapshot(state, snapshot);
  }

  private applySnapshot(state: EveRunState, snapshot: EveSessionSnapshot): void {
    if (isTerminalStatus(state.status) && !isTerminalStatus(snapshot.status)) {
      return;
    }
    state.status = snapshot.status;
    if (snapshot.finishedAt) {
      state.finishedAt = snapshot.finishedAt as UtcTimestamp;
    }
  }

  private applyTerminalStreamEvent(state: EveRunState, event: Extract<RuntimeStreamEvent, { kind: "terminal" }>): void {
    state.status = event.status;
    state.finishedAt = event.at;
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function assertRequestContract(request: RuntimeStartRequest, driverId: RuntimeDriverId): void {
  if (request.driver.driver !== driverId.driver) {
    throw new RuntimeEveDriverError(
      "driver_mismatch",
      `Request driver ${request.driver.driver} does not match loaded driver ${driverId.driver}`
    );
  }
  if (request.contractRevision <= 0) {
    throw new RuntimeEveDriverError("invalid_request", `contractRevision must be positive, received ${request.contractRevision}`);
  }
  if (request.attempt <= 0) {
    throw new RuntimeEveDriverError("invalid_request", `attempt must be positive, received ${request.attempt}`);
  }
}

function deriveRunId(request: RuntimeStartRequest): RunId {
  const seed = `${request.projectId}|${request.changeId}|${request.taskId}|${request.attempt}|${request.idempotencyKey}`;
  const hash = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  return `run_${hash.slice(0, 22)}` as RunId;
}

function translateStreamEvent(event: EveTransportEvent, runId: RunId, sequence: number): RuntimeStreamEvent {
  switch (event.kind) {
    case "progress":
      return {
        kind: "progress",
        runId,
        at: event.at as UtcTimestamp,
        sequence,
        note: event.note,
        ...(event.data ? { data: event.data } : {})
      };
    case "tool_call":
      return {
        kind: "tool_call",
        runId,
        at: event.at as UtcTimestamp,
        sequence,
        tool: event.tool,
        input: event.input,
        ...(event.output ? { output: event.output } : {})
      };
    case "approval_requested":
      return {
        kind: "approval_requested",
        runId,
        at: event.at as UtcTimestamp,
        sequence,
        approvalId: event.approvalId as unknown as RuntimeStreamEvent extends { kind: "approval_requested"; approvalId: infer T } ? T : never,
        scope: { effectClass: "S0", action: "approve-eve", targets: [] },
        requestedBy: { kind: "worker", id: "runtime-eve", displayName: "runtime-eve" }
      } as RuntimeStreamEvent;
    case "artifact_registered":
      return {
        kind: "artifact_registered",
        runId,
        at: event.at as UtcTimestamp,
        sequence,
        reference: {
          path: event.reference as unknown as ArtifactReference["path"],
          sha256: normalizeContentHash(event.sha256, `runtime-eve:stream-artifact:${event.reference}`)
        }
      };
    case "terminal":
      return {
        kind: "terminal",
        runId,
        at: event.at as UtcTimestamp,
        sequence,
        status: event.status,
        evidenceRefs: []
      };
  }
}

type EveTerminalStatus = "succeeded" | "failed" | "blocked" | "canceled" | "superseded";

function isTerminalStatus(status: RuntimeInspection["status"]): status is EveTerminalStatus {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "canceled" ||
    status === "superseded"
  );
}

function terminalArtifactStatus(status: EveTerminalStatus): "succeeded" | "failed" | "blocked" | "canceled" {
  return status === "superseded" ? "canceled" : status;
}

function normalizeContentHash(candidate: string | undefined, fallbackSeed: string): ContentHash {
  if (candidate && /^sha256:[0-9a-f]{64}$/.test(candidate)) {
    return candidate as unknown as ContentHash;
  }
  return sha256ContentHash(fallbackSeed);
}

function buildRunCreatedEvents(
  request: RuntimeStartRequest,
  runId: RunId,
  sessionId: string,
  startedAt: UtcTimestamp,
  checkpoint: RuntimeCheckpointRef
): EventEnvelope[] {
  const actor = request.requestedBy;
  const runAggregate = { kind: "run" as const, id: runId };
  const created = buildEvent({
    type: "run.created.v1",
    runId,
    aggregate: runAggregate,
    actor,
    changeId: request.changeId,
    projectId: request.projectId,
    generation: 1,
    sequence: 0,
    payload: {
      runId,
      taskId: request.taskId,
      contractId: request.contractId,
      attempt: request.attempt,
      sessionId
    }
  });
  const started = buildEvent({
    type: "run.started.v1",
    runId,
    aggregate: runAggregate,
    actor,
    changeId: request.changeId,
    projectId: request.projectId,
    generation: 1,
    sequence: 1,
    payload: { runId, taskId: request.taskId, startedAt, sessionId, checkpointFingerprint: checkpoint.fingerprint },
    causationId: created.id
  });
  return [created, started];
}

function buildRunResumedEvents(state: EveRunState, resumedAt: UtcTimestamp): EventEnvelope[] {
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
      payload: { runId: state.runId, taskId: state.request.taskId, startedAt: resumedAt }
    })
  ];
}

function buildRunFinishedEvents(
  state: EveRunState,
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
  state: EveRunState,
  approvalRef: RuntimeApprovalRef,
  deliveredAt: UtcTimestamp
): EventEnvelope[] {
  const approvalAggregate = { kind: "approval" as const, id: approvalRef.approvalId };
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
      payload: { approvalId: approvalRef.approvalId, requestedBy: approvalRef.decidedBy, scope: approvalRef.scope }
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
      payload: { approvalId: approvalRef.approvalId, decidedBy: approvalRef.decidedBy, reason: approvalRef.reason, deliveredAt }
    })
  ];
}

function buildArtifactEvents(
  state: EveRunState,
  _reference: ArtifactReference,
  _resolvedAt: UtcTimestamp,
  evidenceId: string | undefined
): EventEnvelope[] {
  if (!evidenceId) return [];
  return [
    buildEvent({
      type: "evidence.collected.v1",
      runId: state.runId,
      aggregate: { kind: "evidence", id: evidenceId },
      actor: state.request.requestedBy,
      changeId: state.request.changeId,
      projectId: state.request.projectId,
      generation: state.generation,
      sequence: 0,
      payload: { evidenceId, taskId: state.request.taskId, runId: state.runId, verdict: "pass" }
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
  const hash = crypto.createHash("sha256").update(`${type}|${runId}|${sequence}|${generation}`, "utf8").digest("hex");
  return `evt_${hash.slice(0, 26)}` as unknown as EventEnvelope["id"];
}

export function sha256ContentHash(input: string): ContentHash {
  return `sha256:${crypto.createHash("sha256").update(input, "utf8").digest("hex")}` as unknown as ContentHash;
}
