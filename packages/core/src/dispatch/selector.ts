/**
 * Worker bundle selection for fresh-context dispatch.
 *
 * P08-T01 contract: the dispatcher MUST resolve exactly one
 * (agent → bundle, model) pair per dispatch. Two distinct agents on
 * the same contract yield two distinct selections (one per agent);
 * for now we select the FIRST agent in `taskContract.agents` and
 * return the first registry entry for that agent. Future work
 * (P09+) can fan out one selection per agent.
 *
 * Why this is its own module:
 *  - Mirrors `runtime/selector.ts` precedence pattern.
 *  - Keeps `dispatcher.ts` focused on preflight + freeze, not
 *    selection policy.
 *  - Lets tests pin every branch independently of the dispatcher.
 *
 * Selection rules:
 *  1. If `taskContract.agents` is empty, return
 *     `{ ok: false, reason: "agent_not_registered", agentId: "" }`
 *     (a TaskContract with no agents should already have failed
 *     schema validation, but defensive selection is required).
 *  2. Use the first agent id from `taskContract.agents` as the
 *     primary key.
 *  3. If the registry returns zero entries for that agent, return
 *     `{ ok: false, reason: "agent_not_registered", agentId }`.
 *  4. If the registry returns more than one entry (rare; e.g.
 *     rolling upgrade with multiple bundles for the same agent),
 *     return `{ ok: false, reason: "agent_ambiguous", agentId,
 *     candidates }` so the caller can decide rather than silently
 *     picking one.
 *  5. Otherwise return the lone entry.
 */

import type {
  TaskContract,
  WorkerBundle,
  ModelManifest
} from "@legion/protocol";

import type {
  WorkerBundleRegistry,
  WorkerBundleSelectionResult
} from "./contract.js";

export function selectWorkerBundleForTask(
  taskContract: TaskContract,
  registry: WorkerBundleRegistry
): WorkerBundleSelectionResult {
  const firstAgent = taskContract.agents[0];
  if (firstAgent === undefined || firstAgent.length === 0) {
    return {
      ok: false,
      agentId: "",
      reason: "agent_not_registered"
    };
  }

  const entries = registry.forAgent(firstAgent);
  if (entries.length === 0) {
    return {
      ok: false,
      agentId: firstAgent,
      reason: "agent_not_registered"
    };
  }

  if (entries.length > 1) {
    return {
      ok: false,
      agentId: firstAgent,
      reason: "agent_ambiguous",
      candidates: entries.map((entry) => `${entry.bundle.id}@${entry.bundle.version}`)
    };
  }

  const sole = entries[0]!;
  return {
    ok: true,
    agentId: firstAgent,
    bundle: sole.bundle,
    model: sole.model
  };
}

/**
 * Convenience constructor for an in-memory bundle registry. Tests and
 * CLI adapters use this; production callers can plug in their own
 * `WorkerBundleRegistry` (e.g. a YAML manifest reader).
 */
export function createStaticWorkerBundleRegistry(
  entries: readonly { agentId: string; bundle: WorkerBundle; model: ModelManifest }[]
): WorkerBundleRegistry {
  const byAgent = new Map<string, { agentId: string; bundle: WorkerBundle; model: ModelManifest }[]>();
  for (const entry of entries) {
    const bucket = byAgent.get(entry.agentId);
    if (bucket === undefined) {
      byAgent.set(entry.agentId, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return {
    forAgent(agentId: string) {
      return byAgent.get(agentId) ?? [];
    }
  };
}
