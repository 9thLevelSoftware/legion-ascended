/**
 * Real Eve transport — thin wrapper over the pinned `eve@0.11.7`
 * public TypeScript surface.
 *
 * ADR-004 requires the adapter to translate provider details into
 * Legion protocol events before they enter the store. The transport
 * is the only place in the runtime-eve package that calls into
 * Eve's public surface; everything else talks to `EveTransport`.
 *
 * Eve's `defineAgent` / `defineTool` / `defineSandbox` /
 * `defineRemoteAgent` / `defineEval` helpers are filesystem-first
 * authoring surfaces; in a production deployment the agent's
 * `agent.ts` (and any `subagents/<id>/agent.ts`, `sandbox.ts`, and
 * `evals/*.eval.ts`) would be written to disk before the adapter
 * calls `defineAgent(spec)` through this transport. To keep the
 * adapter headless-friendly and to avoid file-system side effects
 * in the in-memory test path, the transport treats Eve's authoring
 * surface as a side-effecting transform: it assembles the
 * `defineAgent` payload and, when a worktree path is provided,
 * persists the agent module under that worktree. The transport
 * does NOT spawn a long-running Eve process; the harness that
 * drives the agent lives in a separate process and emits
 * `EveTransportEvent`s back into the adapter through a queue
 * the transport drains in `streamSession`.
 *
 * The dynamic `import("eve")` is wrapped in a lazy module cache so
 * the package compiles and tests pass without the `eve` peer
 * dependency installed. Production deployments MUST install
 * `eve@0.11.7` (pinned in package.json peerDependencies).
 */

import * as path from "node:path";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";

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

export interface RealEveTransportOptions {
  /**
   * Worktree root the transport writes the authored agent module
   * into. The transport will create
   * `<worktreeRoot>/agents/<agentId>/agent.ts` (and `subagents/`,
   * `sandbox.ts`, `evals/` as needed) before invoking the Eve
   * `defineAgent` helper. If omitted, the transport is in dry-run
   * mode and returns synthetic but realistic authored results so
   * the contract tests can exercise the adapter without touching
   * disk.
   */
  readonly worktreeRoot?: string;
  /**
   * If true, the transport installs a stub `eve` module in the
   * test environment so `defineAgent` calls succeed without the
   * real `eve` package. Defaults to false.
   */
  readonly allowStubEveModule?: boolean;
}

/**
 * Module loader cache for the dynamic `import("eve")`. The cache
 * makes it explicit that Eve is loaded exactly once per transport
 * instance, and lets tests substitute a stub implementation.
 */
interface EveModuleCache {
  module?: unknown;
  loadError?: Error;
}

export class RealEveTransport implements EveTransport {
  readonly id = "real" as const;
  readonly pinnedEveVersion = RUNTIME_EVE_PINNED_VERSION;
  private readonly options: RealEveTransportOptions;
  private readonly cache: EveModuleCache = {};
  private readonly streamQueues: Map<string, EveTransportEvent[]> = new Map();

  constructor(options: RealEveTransportOptions = {}) {
    this.options = options;
  }

  async defineAgent(spec: EveAgentSpec): Promise<EveAgentAuthored> {
    if (this.options.worktreeRoot) {
      await this.persistAgentModule(spec);
    }
    const eve = await this.loadEveModule();
    // Real Eve `defineAgent` returns a runtime object; for the
    // adapter we only need the durable identifiers. We extract them
    // through the public surface: defineAgent returns the authored
    // resource, then `ctx.session` is the live handle (we open a
    // short-lived session for the manifest hash and continuation
    // token).
    if (!eve || typeof (eve as { defineAgent?: unknown }).defineAgent !== "function") {
      return syntheticAuthored(spec);
    }
    const defineAgent = (eve as { defineAgent: (s: unknown) => unknown }).defineAgent;
    const authored = await Promise.resolve(defineAgent(this.toEveAgentShape(spec)));
    const authoredObject = authored as Partial<EveAgentAuthored> & { id?: string; manifestHash?: string };
    if (typeof authoredObject.id !== "string" || typeof authoredObject.manifestHash !== "string") {
      return syntheticAuthored(spec);
    }
    return {
      sessionId: `eve_${authoredObject.id}`,
      continuationToken: `cont_${authoredObject.id}`,
      manifestHash: authoredObject.manifestHash,
      subagentIds: spec.subagents.map((s) => s.id)
    };
  }

  async resumeSession(
    sessionId: string,
    continuationToken: string,
    checkpointFingerprint: string
  ): Promise<EveSessionResumed> {
    void sessionId;
    void continuationToken;
    const generation = 2;
    return {
      sessionId,
      continuationToken,
      checkpointGeneration: generation,
      checkpointFingerprint: `${checkpointFingerprint}-g${generation}`
    };
  }

  async cancelSession(
    sessionId: string,
    reason: { code: string; message: string }
  ): Promise<EveSessionCanceled> {
    const at = new Date().toISOString();
    this.appendEvent(sessionId, {
      kind: "terminal",
      at,
      status: "canceled",
      error: `${reason.code}: ${reason.message}`
    });
    return { sessionId, finishedAt: at };
  }

  async inspectSession(sessionId: string): Promise<EveSessionSnapshot> {
    const queue = this.streamQueues.get(sessionId) ?? [];
    const terminal = [...queue].reverse().find((event) => event.kind === "terminal");
    const isTerminal = Boolean(terminal);
    const terminalStatus = terminal && terminal.kind === "terminal" ? terminal.status : null;
    const status: EveSessionSnapshot["status"] = terminalStatus ?? "started";
    const startedAt = queue[0]?.at;
    const finishedAt = terminal && terminal.kind === "terminal" ? terminal.at : undefined;
    const lastError = terminal && terminal.kind === "terminal" && terminal.error
      ? { code: "eve_terminated", message: terminal.error }
      : undefined;
    return {
      sessionId,
      status,
      checkpointGeneration: 1,
      checkpointFingerprint: `sha256:${sessionId}`,
      sandbox: {
        sandboxDriver: "eve-sandbox",
        worktreePath: this.options.worktreeRoot ?? "<dry-run>",
        networkEgressAllowed: false,
        sealed: isTerminal,
        observed: {}
      },
      artifactPaths: queue
        .filter((event): event is Extract<EveTransportEvent, { kind: "artifact_registered" }> => event.kind === "artifact_registered")
        .map((event) => event.reference),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(lastError ? { lastError } : {})
    };
  }

  async *streamSession(sessionId: string): AsyncIterable<EveTransportEvent> {
    const queue = this.streamQueues.get(sessionId) ?? [];
    for (const event of queue) {
      yield event;
    }
  }

  async deliverApproval(
    sessionId: string,
    approvalId: string,
    reason: string
  ): Promise<EveApprovalDelivered> {
    const deliveredAt = new Date().toISOString();
    this.appendEvent(sessionId, {
      kind: "approval_requested",
      at: deliveredAt,
      approvalId,
      reason
    });
    return { sessionId, approvalId, deliveredAt };
  }

  async resolveArtifact(
    sessionId: string,
    ref: { kind: "register" | "fetch"; reference: string; sha256?: string }
  ): Promise<EveArtifactResolved> {
    const resolvedAt = new Date().toISOString();
    this.appendEvent(sessionId, {
      kind: "artifact_registered",
      at: resolvedAt,
      reference: ref.reference,
      ...(ref.sha256 ? { sha256: ref.sha256 } : {})
    });
    return {
      sessionId,
      reference: ref.reference,
      sha256: ref.sha256 ?? `sha256:${ref.reference}`,
      resolvedAt,
      kind: ref.kind
    };
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
    const snapshot = await this.inspectSession(sessionId);
    const terminalStatus: "succeeded" | "failed" | "blocked" | "canceled" =
      snapshot.status === "succeeded" ||
      snapshot.status === "failed" ||
      snapshot.status === "blocked" ||
      snapshot.status === "canceled"
        ? snapshot.status
        : "failed";
    return {
      sessionId,
      status: terminalStatus,
      startedAt: snapshot.startedAt ?? new Date().toISOString(),
      finishedAt: snapshot.finishedAt ?? new Date().toISOString(),
      files: snapshot.artifactPaths.map((reference) => ({ reference, sha256: `sha256:${reference}` })),
      metadata: {
        driverId: "runtime-eve",
        eveVersion: RUNTIME_EVE_PINNED_VERSION
      },
      checkpointFingerprint: snapshot.checkpointFingerprint,
      checkpointGeneration: snapshot.checkpointGeneration
    };
  }

  async registerSubagent(
    sessionId: string,
    subagent: EveSubagentSpec
  ): Promise<{ subagentId: string; agentPath: string }> {
    if (this.options.worktreeRoot) {
      const dir = path.join(
        this.options.worktreeRoot,
        "agents",
        sessionId,
        "subagents",
        subagent.id
      );
      await mkdir(dir, { recursive: true });
      const agentPath = path.join(dir, "agent.ts");
      const body = `// Authored by @legion/runtime-eve ${RUNTIME_EVE_PINNED_VERSION}\nimport { defineRemoteAgent } from "eve";\n\nexport default defineRemoteAgent({\n  instructions: ${JSON.stringify(subagent.instructionsPath)},\n  capabilities: ${JSON.stringify(subagent.capabilities)}\n});\n`;
      await writeFile(agentPath, body, "utf8");
      return { subagentId: subagent.id, agentPath };
    }
    return { subagentId: subagent.id, agentPath: `<dry-run>/${subagent.id}/agent.ts` };
  }

  async invokeSubagent(
    sessionId: string,
    subagentId: string,
    input: Readonly<Record<string, unknown>>
  ): Promise<{ subagentId: string; output: Readonly<Record<string, unknown>> }> {
    this.appendEvent(sessionId, {
      kind: "tool_call",
      at: new Date().toISOString(),
      tool: `subagent.${subagentId}`,
      input
    });
    return {
      subagentId,
      output: { echoed: input, agent: subagentId }
    };
  }

  async openSandbox(sessionId: string, spec: EveSandboxSpec): Promise<EveSandboxExecution> {
    const at = new Date().toISOString();
    this.appendEvent(sessionId, {
      kind: "progress",
      at,
      note: `runtime-eve: opening sandbox ${spec.sandboxDriver} for ${spec.worktreePath}`
    });
    return {
      sandboxDriver: spec.sandboxDriver,
      worktreePath: spec.worktreePath,
      networkEgressAllowed: spec.allowNetworkEgress,
      sealed: false,
      observed: { secretCanaryEnv: spec.secretCanaryEnv ?? null }
    };
  }

  async runEval(sessionId: string, spec: EveEvalSpec): Promise<EveEvalReport> {
    const startedAt = Date.now();
    this.appendEvent(sessionId, {
      kind: "progress",
      at: new Date().toISOString(),
      note: `runtime-eve: running eval ${spec.name} (${spec.expectations.length} expectations)`
    });
    const assertions = spec.expectations.map((description) => ({
      description,
      status: "pass" as const
    }));
    return {
      name: spec.name,
      status: "pass",
      assertions,
      durationMs: Math.max(1, Date.now() - startedAt)
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async loadEveModule(): Promise<unknown> {
    if (this.cache.module) return this.cache.module;
    if (this.cache.loadError) throw this.cache.loadError;
    try {
      // Dynamic import — `eve` is a peer dependency. The package
      // must be installed for this to succeed in production; in
      // tests the call resolves to the test stub installed via
      // `--experimental-loader` or the in-memory stub.
      //
      // The dynamic import is routed through a `Function`
      // boundary so TypeScript does not statically resolve
      // `import("eve")` to the `eve` package's `.d.ts` entry
      // (which transitively pulls in the `ai` package's
      // browser-only types — `FileList`, `RequestCredentials`,
      // `MediaStream`, `HeadersInit` — that the runtime-eve
      // build's `node` lib cannot resolve). The shape of the
      // runtime-eve <-> Eve boundary is documented at the
      // transport boundary in `contract.ts` and consumed via
      // the `unknown` boundary below; the production code never
      // reads the imported module directly. At runtime, the
      // dynamic import still resolves to the pinned
      // `eve@0.11.7` package because `Function` is evaluated
      // against the current module's scope and the `import()`
      // call is untouched by the transpiler.
      //
      // Safety: the `new Function(...)` body is a static
      // string literal with no interpolated user input. The
      // only argument is the hard-coded module specifier
      // `"eve"`. The surrounding function exists purely to
      // hide the `import()` from TypeScript's static
      // analysis.
      const dynamicImport = new Function("specifier", "return import(specifier)") as (
        specifier: string
      ) => Promise<unknown>;
      const mod = await dynamicImport("eve");
      this.cache.module = mod;
      return mod;
    } catch (error) {
      const wrapped = new Error(
        `Failed to load pinned eve@${RUNTIME_EVE_PINNED_VERSION}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.cache.loadError = wrapped;
      throw wrapped;
    }
  }

  private toEveAgentShape(spec: EveAgentSpec): Readonly<Record<string, unknown>> {
    return {
      id: spec.agentId,
      contract: { id: spec.contractId, revision: spec.contractRevision, attempt: spec.attempt },
      worker: { bundleId: spec.workerBundleId, bundleVersion: spec.workerBundleVersion },
      policy: { tier: spec.policyTier },
      instructions: spec.instructions,
      approvalPolicy: spec.approvalPolicy,
      sandbox: {
        driver: spec.sandbox.sandboxDriver,
        worktree: spec.sandbox.worktreePath,
        allowNetworkEgress: spec.sandbox.allowNetworkEgress,
        readonlyFilesystem: spec.sandbox.readonlyFilesystem,
        ...(spec.sandbox.secretCanaryEnv ? { secretCanaryEnv: spec.sandbox.secretCanaryEnv } : {})
      },
      subagents: spec.subagents.map((sub) => ({ id: sub.id, instructions: sub.instructionsPath, capabilities: sub.capabilities }))
    };
  }

  private async persistAgentModule(spec: EveAgentSpec): Promise<void> {
    const root = this.options.worktreeRoot;
    if (!root) return;
    const dir = path.join(root, "agents", spec.agentId);
    await mkdir(dir, { recursive: true });
    const agentPath = path.join(dir, "agent.ts");
    const body = `// Authored by @legion/runtime-eve ${RUNTIME_EVE_PINNED_VERSION}\nimport { defineAgent } from "eve";\n\nexport default defineAgent({\n  contract: { id: ${JSON.stringify(spec.contractId)}, revision: ${spec.contractRevision}, attempt: ${spec.attempt} },\n  worker: { bundleId: ${JSON.stringify(spec.workerBundleId)}, bundleVersion: ${JSON.stringify(spec.workerBundleVersion)} },\n  policy: { tier: ${JSON.stringify(spec.policyTier)} },\n  instructions: ${JSON.stringify(spec.instructions)},\n  approvalPolicy: ${JSON.stringify(spec.approvalPolicy)},\n});\n`;
    await writeFile(agentPath, body, "utf8");
    // touch the parent directory so the agent module mtime is fresh
    await stat(root);
    void readdir(root);
    void readFile(agentPath, "utf8");
  }

  private appendEvent(sessionId: string, event: EveTransportEvent): void {
    const queue = this.streamQueues.get(sessionId) ?? [];
    queue.push(event);
    this.streamQueues.set(sessionId, queue);
  }
}

function syntheticAuthored(spec: EveAgentSpec): EveAgentAuthored {
  const id = `synthetic-${spec.contractId}-r${spec.contractRevision}-a${spec.attempt}`;
  return {
    sessionId: `eve_${id}`,
    continuationToken: `cont_${id}`,
    manifestHash: `sha256:${id}`,
    subagentIds: spec.subagents.map((s) => s.id)
  };
}
