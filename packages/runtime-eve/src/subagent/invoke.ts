/**
 * Provider-neutral subagent adapter for the runtime-eve driver.
 *
 * Maps Legion worker bundles (ADR-002) to Eve's
 * `defineRemoteAgent` surface and produces the events the driver
 * must emit when a subagent is invoked.
 */

import type { Actor, RunId, UtcTimestamp } from "@legion/protocol";
import type { WorkerBundle } from "@legion/protocol";

import type { EveSubagentSpec, EveTransport } from "../transport/contract.js";

export interface SubagentInvocation {
  readonly subagentId: string;
  readonly workerBundle: WorkerBundle;
  readonly input: Readonly<Record<string, unknown>>;
  readonly invokedBy: Actor;
  readonly at: UtcTimestamp;
}

export interface SubagentInvocationResult {
  readonly subagentId: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly at: UtcTimestamp;
  readonly runId: RunId;
}

/**
 * Author a subagent against Eve's `defineRemoteAgent` surface.
 * The transport handles the actual `defineRemoteAgent` call; this
 * helper translates the Legion worker bundle into the Eve
 * subagent spec.
 */
export function buildEveSubagentSpec(
  workerBundle: WorkerBundle,
  instructionsPath: string
): EveSubagentSpec {
  return {
    id: workerBundle.id,
    instructionsPath,
    capabilities: [...workerBundle.capabilities]
  };
}

/**
 * Register the subagent with Eve, run the invocation, and surface
 * the result as a provider-neutral `SubagentInvocationResult`.
 */
export async function invokeSubagent(
  transport: EveTransport,
  runId: RunId,
  sessionId: string,
  invocation: SubagentInvocation
): Promise<SubagentInvocationResult> {
  const spec = buildEveSubagentSpec(invocation.workerBundle, `${sessionId}/subagents/${invocation.subagentId}/instructions.md`);
  await transport.registerSubagent(sessionId, spec);
  const { output } = await transport.invokeSubagent(sessionId, invocation.subagentId, invocation.input);
  return {
    subagentId: invocation.subagentId,
    output,
    at: new Date().toISOString() as UtcTimestamp,
    runId
  };
}
