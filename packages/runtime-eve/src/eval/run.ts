/**
 * Provider-neutral eval adapter for the runtime-eve driver.
 *
 * Maps Legion workflow expectations to Eve's
 * `defineEval` / `defineEvalConfig` / `eve/evals` reporter surface
 * and produces the assertions the driver records as evidence.
 */

import type { Actor, EvidenceId, RunId, UtcTimestamp } from "@legion/protocol";

import type { EveEvalReport, EveEvalSpec, EveTransport } from "../transport/contract.js";

export interface EvalDefinition {
  readonly name: string;
  readonly fixture: string;
  readonly expectations: readonly string[];
  readonly reporter: "summary" | "json" | "junit";
  readonly runBy: Actor;
  readonly at: UtcTimestamp;
}

export interface EvalExecutionResult {
  readonly report: EveEvalReport;
  readonly evidenceId: EvidenceId;
  readonly runId: RunId;
}

/**
 * Translate a Legion eval definition into the Eve eval spec the
 * transport consumes.
 */
export function buildEveEvalSpec(definition: EvalDefinition): EveEvalSpec {
  return {
    name: definition.name,
    fixture: definition.fixture,
    expectations: [...definition.expectations],
    reporter: definition.reporter
  };
}

/**
 * Run the eval against Eve's eval runner. The transport returns
 * an `EveEvalReport` we surface to the caller alongside a
 * deterministic evidence id derived from the run id, the eval
 * name, and the report status.
 */
export async function runEval(
  transport: EveTransport,
  runId: RunId,
  sessionId: string,
  definition: EvalDefinition
): Promise<EvalExecutionResult> {
  const spec = buildEveEvalSpec(definition);
  const report = await transport.runEval(sessionId, spec);
  const evidenceId = `evd_${runId}-${definition.name}-${report.status}` as EvidenceId;
  return { report, evidenceId, runId };
}
