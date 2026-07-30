/**
 * Terminal rendering for intake.
 *
 * Rendering is the only part of the interview a host is allowed to own, and
 * even here the CLI ships a default so `legion start` is usable with nothing
 * but a terminal. The machine-readable payload beside this text is the contract
 * a richer host renders against; this is what a human sees when there is none.
 */

import type { IntakeNode } from "./graph.js";
import type { ExplorationProposal } from "./session.js";
import type { IntakeDiagnostic } from "./validators.js";

export interface RenderQuestionInput {
  readonly node: IntakeNode;
  readonly answered: number;
  readonly total: number;
  readonly proposal?: ExplorationProposal | undefined;
  readonly sessionId: string;
}

export function renderQuestion(input: RenderQuestionInput): string {
  const lines: string[] = [];
  lines.push(`[${input.answered}/${input.total}] ${input.node.prompt}`);

  if (input.node.help !== undefined) {
    lines.push(`  ${input.node.help}`);
  }

  if (input.node.options !== undefined && input.node.options.length > 0) {
    lines.push("");
    for (const option of input.node.options) {
      const description = option.description === undefined ? "" : ` — ${option.description}`;
      lines.push(`  ${option.value}: ${option.label}${description}`);
    }
  }

  if (input.node.kind === "confirm") {
    lines.push("");
    lines.push("  true / false");
  }

  if (input.proposal !== undefined) {
    lines.push("");
    // Shown as a suggestion and labelled as one. An accepted proposal is
    // recorded with `source: proposed-accepted`, so a later reader can tell
    // which decisions a human made from which ones a human merely did not
    // object to.
    const value = Array.isArray(input.proposal.value)
      ? input.proposal.value.join(", ")
      : input.proposal.value;
    lines.push(`  Exploration proposed (${input.proposal.confidence}): ${value}`);
    lines.push(`  Because: ${input.proposal.rationale}`);
    lines.push(`  Accept it with --session ${input.sessionId} --accept-proposal, or answer to override it.`);
  }

  if (input.node.injected === true) {
    lines.push("");
    lines.push("  This question exists because exploration left it unresolved.");
  }

  lines.push("");
  lines.push(`  legion start --session ${input.sessionId} --answer "${input.node.id}=<value>"`);

  if (!input.node.required) {
    lines.push(`  legion start --session ${input.sessionId} --skip   (this question is optional)`);
  }

  return lines.join("\n");
}

export function renderIntakeDiagnostics(diagnostics: readonly IntakeDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.nodeId === undefined ? "" : ` (${diagnostic.nodeId})`;
      return `  - ${diagnostic.message}${location}`;
    })
    .join("\n");
}

export interface RenderSessionStatusInput {
  readonly sessionId: string;
  readonly status: string;
  readonly answered: number;
  readonly total: number;
  readonly cursor: string | undefined;
  readonly injectedCount: number;
  readonly explorationRunId: string | undefined;
}

export function renderSessionStatus(input: RenderSessionStatusInput): string {
  const lines: string[] = [];
  lines.push(`${input.sessionId}: ${input.status}`);
  lines.push(`  answered ${input.answered} of ${input.total} questions`);
  if (input.cursor !== undefined) {
    lines.push(`  next: ${input.cursor}`);
  }
  if (input.explorationRunId !== undefined) {
    lines.push(`  seeded from exploration ${input.explorationRunId}`);
  }
  if (input.injectedCount > 0) {
    lines.push(`  ${input.injectedCount} question(s) added by that exploration's open questions`);
  }
  return lines.join("\n");
}
