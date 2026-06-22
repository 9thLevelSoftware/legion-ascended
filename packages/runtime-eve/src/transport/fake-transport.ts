/**
 * In-memory Eve transport for unit tests and the public-contract
 * certification suite.
 *
 * The fake records every call (`defineAgent`, `resumeSession`,
 * `cancelSession`, etc.) into a per-session event journal, and
 * yields that journal through `streamSession`. It also stores
 * approval and artifact metadata, and exposes a
 * `__pushStreamEvent` helper so tests can simulate harness output
 * mid-run (e.g. emit a `progress` event from a subagent).
 *
 * The fake is intentionally stateful but process-local. It is the
 * canonical fixture used by `tests/public-contract.test.mjs` to
 * certify that the runtime-eve driver satisfies ADR-004 against
 * the documented Eve public surface.
 */

import {
  RUNTIME_EVE_PINNED_VERSION,
  type EveAgentAuthored,
  type EveAgentSpec,
  type EveApprovalDelivered,
  type EveArtifactResolved,
  type EveEvalReport,
  type EveEvalSpec,
  type EveSandboxExecution,
  type EveSandboxSpec,
  type EveSessionCanceled,
  type EveSessionResumed,
  type EveSessionSnapshot,
  type EveSubagentSpec,
  type EveTransport,
  type EveTransportEvent
} from "./contract.js";

interface SessionJournal {
  readonly sessionId: string;
  readonly spec: EveAgentSpec;
  status: EveSessionSnapshot["status"];
  startedAt: string;
  finishedAt?: string;
  checkpointGeneration: number;
  checkpointFingerprint: string;
  artifactPaths: string[];
  lastError?: { code: string; message: string } | undefined;
  sandbox: EveSandboxExecution;
  approvals: Map<string, { decidedAt: string; reason: string }>;
  events: EveTransportEvent[];
  subagents: Map<string, EveSubagentSpec>;
  subagentInvocations: Array<{ subagentId: string; input: Readonly<Record<string, unknown>>; output: Readonly<Record<string, unknown>> }>;
  evalReports: Map<string, EveEvalReport>;
}

export class FakeEveTransport implements EveTransport {
  readonly id = "fake" as const;
  readonly pinnedEveVersion = RUNTIME_EVE_PINNED_VERSION;
  private readonly sessions: Map<string, SessionJournal> = new Map();
  private readonly defineAgentCalls: EveAgentSpec[] = [];
  private readonly resumeCalls: Array<{ sessionId: string; continuationToken: string; checkpointFingerprint: string }> = [];
  private readonly cancelCalls: Array<{ sessionId: string; reason: { code: string; message: string } }> = [];
  private readonly approvalCalls: Array<{ sessionId: string; approvalId: string; reason: string }> = [];
  private readonly artifactCalls: Array<{ sessionId: string; ref: { kind: "register" | "fetch"; reference: string; sha256?: string } }> = [];
  private readonly sandboxCalls: Array<{ sessionId: string; spec: EveSandboxSpec }> = [];
  private readonly evalCalls: Array<{ sessionId: string; spec: EveEvalSpec }> = [];

  // -------------------------------------------------------------------
  // EveTransport
  // -------------------------------------------------------------------

  async defineAgent(spec: EveAgentSpec): Promise<EveAgentAuthored> {
    this.defineAgentCalls.push(spec);
    const sessionId = `eve_test_${this.defineAgentCalls.length}`;
    const manifestHash = `sha256:${spec.contractId}-r${spec.contractRevision}-a${spec.attempt}`;
    const sandbox: EveSandboxExecution = {
      sandboxDriver: spec.sandbox.sandboxDriver,
      worktreePath: spec.sandbox.worktreePath,
      networkEgressAllowed: spec.sandbox.allowNetworkEgress,
      sealed: false,
      observed: { secretCanaryEnv: spec.sandbox.secretCanaryEnv ?? null }
    };
    this.sessions.set(sessionId, {
      sessionId,
      spec,
      status: "started",
      startedAt: new Date().toISOString(),
      checkpointGeneration: 1,
      checkpointFingerprint: manifestHash,
      artifactPaths: [],
      sandbox,
      approvals: new Map(),
      events: [
        { kind: "progress", at: new Date().toISOString(), note: `fake: defineAgent(${spec.agentId})` }
      ],
      subagents: new Map(),
      subagentInvocations: [],
      evalReports: new Map()
    });
    return {
      sessionId,
      continuationToken: `cont_${sessionId}`,
      manifestHash,
      subagentIds: spec.subagents.map((s) => s.id)
    };
  }

  async resumeSession(
    sessionId: string,
    continuationToken: string,
    checkpointFingerprint: string
  ): Promise<EveSessionResumed> {
    this.resumeCalls.push({ sessionId, continuationToken, checkpointFingerprint });
    const journal = this.requireSession(sessionId);
    journal.checkpointGeneration += 1;
    journal.checkpointFingerprint = `${checkpointFingerprint}-g${journal.checkpointGeneration}`;
    journal.status = "started";
    journal.events.push({
      kind: "progress",
      at: new Date().toISOString(),
      note: `fake: resumeSession(${sessionId}) g=${journal.checkpointGeneration}`
    });
    return {
      sessionId,
      continuationToken,
      checkpointGeneration: journal.checkpointGeneration,
      checkpointFingerprint: journal.checkpointFingerprint
    };
  }

  async cancelSession(
    sessionId: string,
    reason: { code: string; message: string }
  ): Promise<EveSessionCanceled> {
    this.cancelCalls.push({ sessionId, reason });
    const journal = this.requireSession(sessionId);
    const at = new Date().toISOString();
    journal.status = "canceled";
    journal.finishedAt = at;
    journal.sandbox = { ...journal.sandbox, sealed: true };
    journal.lastError = { code: reason.code, message: reason.message };
    journal.events.push({ kind: "terminal", at, status: "canceled", error: `${reason.code}: ${reason.message}` });
    return { sessionId, finishedAt: at };
  }

  async inspectSession(sessionId: string): Promise<EveSessionSnapshot> {
    const journal = this.requireSession(sessionId);
    return {
      sessionId,
      status: journal.status,
      checkpointGeneration: journal.checkpointGeneration,
      checkpointFingerprint: journal.checkpointFingerprint,
      sandbox: journal.sandbox,
      artifactPaths: [...journal.artifactPaths],
      startedAt: journal.startedAt,
      ...(journal.finishedAt ? { finishedAt: journal.finishedAt } : {}),
      ...(journal.lastError ? { lastError: journal.lastError } : {})
    };
  }

  async *streamSession(sessionId: string): AsyncIterable<EveTransportEvent> {
    const journal = this.requireSession(sessionId);
    for (const event of journal.events) {
      yield event;
    }
  }

  async deliverApproval(sessionId: string, approvalId: string, reason: string): Promise<EveApprovalDelivered> {
    this.approvalCalls.push({ sessionId, approvalId, reason });
    const journal = this.requireSession(sessionId);
    const deliveredAt = new Date().toISOString();
    journal.approvals.set(approvalId, { decidedAt: deliveredAt, reason });
    journal.events.push({ kind: "approval_requested", at: deliveredAt, approvalId, reason });
    return { sessionId, approvalId, deliveredAt };
  }

  async resolveArtifact(
    sessionId: string,
    ref: { kind: "register" | "fetch"; reference: string; sha256?: string }
  ): Promise<EveArtifactResolved> {
    this.artifactCalls.push({ sessionId, ref });
    const journal = this.requireSession(sessionId);
    const resolvedAt = new Date().toISOString();
    const sha256 = ref.sha256 ?? `sha256:${ref.reference}`;
    if (ref.kind === "register") {
      journal.artifactPaths.push(ref.reference);
    }
    const event: EveTransportEvent = ref.sha256
      ? { kind: "artifact_registered", at: resolvedAt, reference: ref.reference, sha256: ref.sha256 }
      : { kind: "artifact_registered", at: resolvedAt, reference: ref.reference };
    journal.events.push(event);
    return { sessionId, reference: ref.reference, sha256, resolvedAt, kind: ref.kind };
  }

  async resolveFinalOutput(sessionId: string): Promise<{
    sessionId: string;
    status: "succeeded" | "failed" | "blocked" | "canceled";
    startedAt: string;
    finishedAt: string;
    files: ReadonlyArray<{ reference: string; sha256: string }>;
    metadata: Readonly<Record<string, unknown>>;
    checkpointFingerprint: string;
    checkpointGeneration: number;
  }> {
    const journal = this.requireSession(sessionId);
    const terminalStatus: "succeeded" | "failed" | "blocked" | "canceled" =
      journal.status === "succeeded" ||
      journal.status === "failed" ||
      journal.status === "blocked" ||
      journal.status === "canceled"
        ? journal.status
        : "failed";
    return {
      sessionId,
      status: terminalStatus,
      startedAt: journal.startedAt,
      finishedAt: journal.finishedAt ?? new Date().toISOString(),
      files: journal.artifactPaths.map((reference) => ({ reference, sha256: `sha256:${reference}` })),
      metadata: {
        driverId: "runtime-eve",
        eveVersion: RUNTIME_EVE_PINNED_VERSION
      },
      checkpointFingerprint: journal.checkpointFingerprint,
      checkpointGeneration: journal.checkpointGeneration
    };
  }

  async registerSubagent(
    sessionId: string,
    subagent: EveSubagentSpec
  ): Promise<{ subagentId: string; agentPath: string }> {
    const journal = this.requireSession(sessionId);
    journal.subagents.set(subagent.id, subagent);
    return { subagentId: subagent.id, agentPath: `<fake>/${sessionId}/subagents/${subagent.id}/agent.ts` };
  }

  async invokeSubagent(
    sessionId: string,
    subagentId: string,
    input: Readonly<Record<string, unknown>>
  ): Promise<{ subagentId: string; output: Readonly<Record<string, unknown>> }> {
    const journal = this.requireSession(sessionId);
    if (!journal.subagents.has(subagentId)) {
      throw new Error(`FakeEveTransport: subagent ${subagentId} is not registered for ${sessionId}`);
    }
    const output = { echoed: input, subagentId };
    journal.subagentInvocations.push({ subagentId, input, output });
    journal.events.push({
      kind: "tool_call",
      at: new Date().toISOString(),
      tool: `subagent.${subagentId}`,
      input
    });
    return { subagentId, output };
  }

  async openSandbox(sessionId: string, spec: EveSandboxSpec): Promise<EveSandboxExecution> {
    this.sandboxCalls.push({ sessionId, spec });
    const journal = this.requireSession(sessionId);
    const execution: EveSandboxExecution = {
      sandboxDriver: spec.sandboxDriver,
      worktreePath: spec.worktreePath,
      networkEgressAllowed: spec.allowNetworkEgress,
      sealed: false,
      observed: { secretCanaryEnv: spec.secretCanaryEnv ?? null }
    };
    journal.sandbox = execution;
    journal.events.push({
      kind: "progress",
      at: new Date().toISOString(),
      note: `fake: openSandbox(${spec.sandboxDriver}, ${spec.worktreePath})`
    });
    return execution;
  }

  async runEval(sessionId: string, spec: EveEvalSpec): Promise<EveEvalReport> {
    this.evalCalls.push({ sessionId, spec });
    const journal = this.requireSession(sessionId);
    const startedAt = Date.now();
    const report: EveEvalReport = {
      name: spec.name,
      status: spec.expectations.length === 0 ? "error" : "pass",
      assertions: spec.expectations.map((description) => ({ description, status: "pass" as const })),
      durationMs: Math.max(1, Date.now() - startedAt)
    };
    journal.evalReports.set(spec.name, report);
    journal.events.push({
      kind: "progress",
      at: new Date().toISOString(),
      note: `fake: runEval(${spec.name}) -> ${report.status}`
    });
    return report;
  }

  // -------------------------------------------------------------------
  // Test introspection helpers
  // -------------------------------------------------------------------

  __defineAgentCalls(): readonly EveAgentSpec[] {
    return [...this.defineAgentCalls];
  }

  __resumeCalls(): readonly { sessionId: string; continuationToken: string; checkpointFingerprint: string }[] {
    return [...this.resumeCalls];
  }

  __cancelCalls(): readonly { sessionId: string; reason: { code: string; message: string } }[] {
    return [...this.cancelCalls];
  }

  __approvalCalls(): readonly { sessionId: string; approvalId: string; reason: string }[] {
    return [...this.approvalCalls];
  }

  __artifactCalls(): readonly { sessionId: string; ref: { kind: "register" | "fetch"; reference: string; sha256?: string } }[] {
    return [...this.artifactCalls];
  }

  __sandboxCalls(): readonly { sessionId: string; spec: EveSandboxSpec }[] {
    return [...this.sandboxCalls];
  }

  __evalCalls(): readonly { sessionId: string; spec: EveEvalSpec }[] {
    return [...this.evalCalls];
  }

  __subagentInvocations(sessionId: string): readonly { subagentId: string; input: Readonly<Record<string, unknown>>; output: Readonly<Record<string, unknown>> }[] {
    return [...this.requireSession(sessionId).subagentInvocations];
  }

  __subagentInvocationsByDefineOrder(): readonly { sessionId: string; subagentId: string; input: Readonly<Record<string, unknown>>; output: Readonly<Record<string, unknown>> }[] {
    const out: { sessionId: string; subagentId: string; input: Readonly<Record<string, unknown>>; output: Readonly<Record<string, unknown>> }[] = [];
    for (const [sessionId, journal] of this.sessions.entries()) {
      for (const invocation of journal.subagentInvocations) {
        out.push({ sessionId, ...invocation });
      }
    }
    return out;
  }

  __pushStreamEvent(sessionId: string, event: EveTransportEvent): void {
    this.requireSession(sessionId).events.push(event);
  }

  __setStatus(sessionId: string, status: EveSessionSnapshot["status"]): void {
    const journal = this.requireSession(sessionId);
    journal.status = status;
    if (status === "canceled" || status === "failed" || status === "succeeded" || status === "blocked") {
      journal.finishedAt = new Date().toISOString();
    }
  }

  private requireSession(sessionId: string): SessionJournal {
    const journal = this.sessions.get(sessionId);
    if (!journal) {
      throw new Error(`FakeEveTransport: session ${sessionId} is not registered`);
    }
    return journal;
  }
}
