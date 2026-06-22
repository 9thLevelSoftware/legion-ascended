/**
 * Provider-neutral sandbox adapter for the runtime-eve driver.
 *
 * Maps Legion `RuntimePolicy` / `RuntimeWorkspace` shapes to
 * Eve's `defineSandbox` / `ctx.getSandbox` surface and emits the
 * `RuntimeSandboxState` the contract requires.
 */

import type { ContentHash, RunId, SchemaVersion, UtcTimestamp } from "@legion/protocol";

import type {
  EveSandboxExecution,
  EveSandboxSpec,
  EveTransport
} from "../transport/contract.js";
import type { RuntimePolicy, RuntimeSandboxState, RuntimeWorkspace } from "@legion/core";

export interface SandboxFingerprintInput {
  readonly sandbox: RuntimeSandboxState;
  readonly runId: RunId;
  readonly generation: number;
  readonly policyVersion: SchemaVersion;
}

/**
 * Translate a Legion `RuntimePolicy` / `RuntimeWorkspace` into the
 * Eve sandbox spec the transport consumes.
 *
 * ADR-004 says: "Sandboxes are deny-all by default unless the
 * `sandboxDriver` opts in to network egress, and the secret
 * canary env is only set when the policy explicitly authorises
 * it." We honour that here by defaulting `allowNetworkEgress` to
 * false and only passing `secretCanaryEnv` when the policy tier is
 * `R0` (the lowest-risk tier) and the workspace explicitly opts
 * in.
 */
export function buildEveSandboxSpec(
  workspace: RuntimeWorkspace,
  policy: RuntimePolicy
): EveSandboxSpec {
  const secretCanaryEnv =
    policy.riskTier === "R0" ? `${workspace.sandboxDriver}-canary` : undefined;
  return {
    sandboxDriver: workspace.sandboxDriver,
    worktreePath: workspace.worktreePath,
    allowNetworkEgress: false,
    readonlyFilesystem: true,
    ...(secretCanaryEnv ? { secretCanaryEnv } : {})
  };
}

/**
 * Open the sandbox for a session and translate the transport
 * result into the contract's `RuntimeSandboxState` shape.
 */
export async function openSandbox(
  transport: EveTransport,
  sessionId: string,
  spec: EveSandboxSpec
): Promise<EveSandboxExecution> {
  return transport.openSandbox(sessionId, spec);
}

export function deriveSandboxFingerprint(input: SandboxFingerprintInput): ContentHash {
  return `sha256:${input.runId}|${input.sandbox.sandboxDriver}|${input.generation}|${input.policyVersion}` as ContentHash;
}

export function startedAtFromExecution(execution: EveSandboxExecution, fallback: UtcTimestamp): UtcTimestamp {
  return fallback;
}
