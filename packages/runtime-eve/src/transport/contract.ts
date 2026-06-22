/**
 * Provider-neutral transport boundary for the runtime-eve adapter.
 *
 * Purpose (ADR-004):
 *  - Encapsulate every call into Vercel Eve's public TypeScript
 *    surface so the rest of the adapter never imports the `eve`
 *    package directly. The runtime-eve driver talks only to
 *    `EveTransport`; a production deployment wires a
 *    `RealEveTransport` that imports the pinned `eve@0.11.7` peer
 *    dependency, and unit tests wire a `FakeEveTransport` that
 *    records calls and yields canned responses.
 *  - Keep the public surface narrow. The transport exposes only
 *    what ADR-004 needs from Eve:
 *      1. `defineAgent` (start)             — author a durable agent.
 *      2. `ctx.session.continuationToken`   — resume a paused session.
 *      3. `ctx.session.sessionId`           — inspect/stream.
 *      4. `ctx.getSandbox` / `defineSandbox` — sandboxed execution.
 *      5. `defineRemoteAgent`               — subagent delegation.
 *      6. `defineEval` / `defineEvalConfig` — evals for workflow behavior.
 *      7. `defineTool` + approval predicates — tool authority gates.
 *
 * The transport contract is intentionally synchronous-friendly so
 * the real implementation can wrap Eve's filesystem-first authoring
 * model without dragging Eve's full type tree into `@legion/core`.
 *
 * Per ADR-004's import-boundary rule (see
 * `scripts/scan-runtime-import-boundaries.mjs`): only this file in
 * the runtime-eve package is allowed to reference the `eve` module
 * via dynamic import. All other modules in the adapter must go
 * through the transport.
 */

/**
 * Stable, pinned Eve major.minor. Matches the version recorded in
 * `spikes/eve/public-contract-map.json` and `docs/next/spikes/EVE-COMPATIBILITY.md`.
 */
export const RUNTIME_EVE_PINNED_VERSION = "0.11.7" as const;

/**
 * Approval gate policies the adapter understands. Mapped to Eve's
 * `eve/tools/approval` predicates (`always`, `once`, `never`) at the
 * transport boundary so the core never imports the helper directly.
 */
export type EveApprovalPolicy =
  | { kind: "always" }
  | { kind: "once"; approvalId: string }
  | { kind: "never" };

/**
 * Provider-neutral sandbox description. The transport translates
 * this into a `defineSandbox` call against Eve.
 */
export interface EveSandboxSpec {
  readonly sandboxDriver: string;
  readonly worktreePath: string;
  readonly allowNetworkEgress: boolean;
  readonly readonlyFilesystem: boolean;
  readonly secretCanaryEnv?: string;
}

/**
 * Provider-neutral subagent spec. The transport translates this
 * into a `defineRemoteAgent` call against Eve.
 */
export interface EveSubagentSpec {
  readonly id: string;
  readonly instructionsPath: string;
  readonly capabilities: readonly string[];
  readonly sandbox?: EveSandboxSpec;
}

/**
 * Provider-neutral eval spec. The transport translates this into a
 * `defineEval` / `defineEvalConfig` call against Eve.
 */
export interface EveEvalSpec {
  readonly name: string;
  readonly fixture: string;
  readonly expectations: readonly string[];
  readonly reporter: "summary" | "json" | "junit";
}

/**
 * Provider-neutral eval report returned by the transport after a
 * `runEval` call. Mirrors the shape Eve's eval reporters return
 * without leaking their types.
 */
export interface EveEvalReport {
  readonly name: string;
  readonly status: "pass" | "fail" | "error";
  readonly assertions: ReadonlyArray<{
    readonly description: string;
    readonly status: "pass" | "fail";
    readonly note?: string;
  }>;
  readonly durationMs: number;
}

/**
 * Provider-neutral sandbox execution result. Mirrors the slice of
 * `ctx.getSandbox` output the adapter needs.
 */
export interface EveSandboxExecution {
  readonly sandboxDriver: string;
  readonly worktreePath: string;
  readonly networkEgressAllowed: boolean;
  readonly sealed: boolean;
  readonly observed: Readonly<Record<string, unknown>>;
}

/**
 * Provider-neutral stream events emitted by the transport while a
 * session is being driven by the adapter. The transport translates
 * Eve's session-stream events into the `EveTransportEvent` shape;
 * the adapter further normalises them into the Legion
 * `RuntimeStreamEvent` shape.
 */
export type EveTransportEvent =
  | { kind: "progress"; at: string; note: string; data?: Readonly<Record<string, unknown>> }
  | { kind: "tool_call"; at: string; tool: string; input: Readonly<Record<string, unknown>>; output?: Readonly<Record<string, unknown>> }
  | { kind: "approval_requested"; at: string; approvalId: string; reason: string }
  | { kind: "artifact_registered"; at: string; reference: string; sha256?: string }
  | { kind: "terminal"; at: string; status: "succeeded" | "failed" | "blocked" | "canceled"; error?: string };

/**
 * Authoring-time input for `start` (mirrors `defineAgent`).
 */
export interface EveAgentSpec {
  readonly agentId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly attempt: number;
  readonly workerBundleId: string;
  readonly workerBundleVersion: string;
  readonly policyTier: "R0" | "R1" | "R2" | "R3";
  readonly instructions: string;
  readonly approvalPolicy: EveApprovalPolicy;
  readonly sandbox: EveSandboxSpec;
  readonly subagents: readonly EveSubagentSpec[];
}

/**
 * Authoring result the transport returns to the adapter.
 */
export interface EveAgentAuthored {
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly manifestHash: string;
  readonly subagentIds: readonly string[];
}

/**
 * Resume-time result the transport returns to the adapter.
 */
export interface EveSessionResumed {
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly checkpointGeneration: number;
  readonly checkpointFingerprint: string;
}

/**
 * Session snapshot returned by the transport for `inspect`.
 */
export interface EveSessionSnapshot {
  readonly sessionId: string;
  readonly status: "created" | "started" | "succeeded" | "failed" | "blocked" | "canceled" | "superseded" | "needs_human";
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly checkpointGeneration: number;
  readonly checkpointFingerprint: string;
  readonly sandbox: EveSandboxExecution;
  readonly artifactPaths: readonly string[];
  readonly lastError?: { code: string; message: string } | undefined;
}

/**
 * Cancellation outcome.
 */
export interface EveSessionCanceled {
  readonly sessionId: string;
  readonly finishedAt: string;
}

/**
 * Approval outcome from the transport.
 */
export interface EveApprovalDelivered {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly deliveredAt: string;
}

/**
 * Artifact registration / fetch result.
 */
export interface EveArtifactResolved {
  readonly sessionId: string;
  readonly reference: string;
  readonly sha256: string;
  readonly resolvedAt: string;
  readonly kind: "register" | "fetch";
}

/**
 * The transport contract the runtime-eve driver talks to.
 *
 * Implementations:
 *  - `RealEveTransport` (see `real-transport.ts`) wraps Eve's
 *    public `defineAgent` / `ctx.getSandbox` / `defineRemoteAgent`
 *    / `defineEval` / `defineTool` helpers through a dynamic
 *    `import("eve")` so the `eve` peer dependency stays optional.
 *  - `FakeEveTransport` (see `fake-transport.ts`) is the in-memory
 *    recorder used by the public-contract test suite.
 */
export interface EveTransport {
  readonly id: "real" | "fake";
  readonly pinnedEveVersion: typeof RUNTIME_EVE_PINNED_VERSION;

  /** `defineAgent` equivalent. */
  defineAgent(spec: EveAgentSpec): Promise<EveAgentAuthored>;

  /** `ctx.session.continuationToken` resume equivalent. */
  resumeSession(
    sessionId: string,
    continuationToken: string,
    checkpointFingerprint: string
  ): Promise<EveSessionResumed>;

  /** `ctx.session` cancel equivalent. */
  cancelSession(sessionId: string, reason: { code: string; message: string }): Promise<EveSessionCanceled>;

  /** `ctx.session` snapshot equivalent. */
  inspectSession(sessionId: string): Promise<EveSessionSnapshot>;

  /** Session stream (the `sessionStream` described in Eve's README). */
  streamSession(sessionId: string): AsyncIterable<EveTransportEvent>;

  /** Approval delivery (translates into the provider-native resume signal). */
  deliverApproval(sessionId: string, approvalId: string, reason: string): Promise<EveApprovalDelivered>;

  /** Artifact register / fetch (single-reference). */
  resolveArtifact(
    sessionId: string,
    ref: { kind: "register" | "fetch"; reference: string; sha256?: string }
  ): Promise<EveArtifactResolved>;

  /** Final structured output bundle for a terminal session. */
  resolveFinalOutput(sessionId: string): Promise<{
    sessionId: string;
    status: "succeeded" | "failed" | "blocked" | "canceled";
    startedAt: string;
    finishedAt: string;
    files: ReadonlyArray<{ reference: string; sha256: string }>;
    metadata: Readonly<Record<string, unknown>>;
    checkpointFingerprint: string;
    checkpointGeneration: number;
  }>;

  // Subagent / sandbox / eval surfaces required by the P05-B001
  // acceptance criteria ("subagent, sandbox, and eval tests pass").

  /** `defineRemoteAgent` equivalent. */
  registerSubagent(sessionId: string, subagent: EveSubagentSpec): Promise<{ subagentId: string; agentPath: string }>;

  /** Subagent invocation that returns provider-neutral progress. */
  invokeSubagent(
    sessionId: string,
    subagentId: string,
    input: Readonly<Record<string, unknown>>
  ): Promise<{ subagentId: string; output: Readonly<Record<string, unknown>> }>;

  /** `ctx.getSandbox` / `defineSandbox` equivalent. */
  openSandbox(sessionId: string, spec: EveSandboxSpec): Promise<EveSandboxExecution>;

  /** `defineEval` runner. */
  runEval(sessionId: string, spec: EveEvalSpec): Promise<EveEvalReport>;
}
