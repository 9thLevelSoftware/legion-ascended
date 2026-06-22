/**
 * P09-T01 — Whole-change integration gate.
 *
 * Aggregates per-task `AcceptanceDecision.outcome` plus per-step
 * sequencer outcomes into a single `MergeIntegrationDecision`.
 *
 * Gate rules (fail-closed):
 *  - If ANY entry has outcome `rejected` OR ANY step is `conflict`,
 *    the whole-change integration is `rejected`.
 *  - If ANY entry has outcome `escalated` OR ANY step is
 *    `escalated`, the whole-change integration is `escalated` for
 *    explicit human approval.
 *  - If any step is still `queued` (no rebase runner was wired), the
 *    decision is `blocked` so the orchestrator surfaces a board
 *    blocker and the integration cannot silently succeed.
 *  - Otherwise every entry is `accepted` AND every step is
 *    `rebased`, so the decision is `integrated`.
 *
 * Gate invariants:
 *  - The decision carries the same `mergeQueueHash` as the snapshot
 *    so audit consumers can correlate the two records.
 *  - The decision is deeply frozen and carries a deterministic
 *    `decisionSha256`.
 *  - The gate is pure: no IO, no clock reading (the caller injects
 *    `now`), no provider state.
 */

import type { ContentHash, SchemaVersion, UtcTimestamp } from "@legion/protocol";

import type {
  MergeIntegrationDecision,
  MergeIntegrationOutcome,
  MergeQueueIssue,
  MergeQueueSnapshot,
  MergeQueueStep
} from "./contract.js";

import { deriveMergeIntegrationDecisionSha256 } from "./hash.js";

function fixedClock(): UtcTimestamp {
  return "2026-06-22T03:30:00.000Z" as UtcTimestamp;
}

export interface EvaluateMergeIntegrationInput {
  readonly snapshot: MergeQueueSnapshot;
  readonly mergeQueueHash: ContentHash;
  readonly now?: () => UtcTimestamp;
}

export interface EvaluateMergeIntegrationResult {
  readonly decision: MergeIntegrationDecision;
  readonly issues: readonly MergeQueueIssue[];
}

/**
 * Aggregate the per-task acceptance decisions and per-step outcomes
 * into a single whole-change decision.
 */
export function evaluateMergeIntegration(
  input: EvaluateMergeIntegrationInput
): EvaluateMergeIntegrationResult {
  const now = input.now ?? fixedClock;
  const acceptedEntries: number[] = [];
  const rejectedEntries: number[] = [];
  const escalatedEntries: number[] = [];
  const conflictEntries: number[] = [];
  const issues: MergeQueueIssue[] = [];

  // Pass 1: collect per-entry outcomes from the snapshot's steps.
  // Each step carries the originating entry's `sequenceIndex` and
  // the resulting outcome; we project that into the per-entry
  // buckets.
  for (const step of input.snapshot.steps) {
    switch (step.outcome) {
      case "rebased":
        acceptedEntries.push(step.sequenceIndex);
        break;
      case "rejected":
        rejectedEntries.push(step.sequenceIndex);
        break;
      case "escalated":
        escalatedEntries.push(step.sequenceIndex);
        break;
      case "conflict":
        conflictEntries.push(step.sequenceIndex);
        break;
      case "queued":
        issues.push({
          code: "integration_pending_escalation",
          message: `Entry ${step.sequenceIndex} is queued (no rebase runner); integration cannot complete.`,
          path: ["snapshot", "steps", step.sequenceIndex, "outcome"],
          entrySequenceIndex: step.sequenceIndex
        });
        break;
      case "integrated":
        // "integrated" is reserved for the whole-change aggregate
        // and is never produced at the per-step layer.
        break;
    }
  }

  // Pass 2: derive the whole-change outcome from the buckets.
  let outcome: MergeIntegrationOutcome;
  const rationale: string[] = [];
  if (rejectedEntries.length > 0 || conflictEntries.length > 0) {
    outcome = "rejected";
    rationale.push(
      `Rejected: ${rejectedEntries.length} entry-level rejection(s), ${conflictEntries.length} conflict(s).`
    );
    for (const seq of rejectedEntries) {
      issues.push({
        code: "integration_outcome_rejected",
        message: `Whole-change integration rejected because entry ${seq} decision was rejected.`,
        path: ["decision", "rejectedEntries"],
        entrySequenceIndex: seq
      });
    }
    for (const seq of conflictEntries) {
      issues.push({
        code: "path_conflict_detected",
        message: `Whole-change integration rejected because entry ${seq} had path conflicts.`,
        path: ["decision", "conflictEntries"],
        entrySequenceIndex: seq
      });
    }
  } else if (escalatedEntries.length > 0) {
    outcome = "escalated";
    rationale.push(
      `Escalated: ${escalatedEntries.length} entry-level escalation(s) require explicit human approval.`
    );
    for (const seq of escalatedEntries) {
      issues.push({
        code: "integration_pending_escalation",
        message: `Whole-change integration escalated because entry ${seq} decision was escalated.`,
        path: ["decision", "escalatedEntries"],
        entrySequenceIndex: seq
      });
    }
  } else if (issues.some((issue) => issue.code === "integration_pending_escalation")) {
    outcome = "blocked";
    rationale.push("Blocked: one or more entries are still queued (no rebase runner wired).");
  } else if (acceptedEntries.length === 0) {
    outcome = "rejected";
    rationale.push("Rejected: merge queue produced zero accepted entries.");
  } else {
    outcome = "integrated";
    rationale.push(`Integrated: ${acceptedEntries.length} entry(ies) rebased sequentially.`);
  }

  const finalHeadRef = input.snapshot.steps.length > 0
    ? input.snapshot.steps[input.snapshot.steps.length - 1]!.headRefAfter
    : "HEAD";

  const decisionOmitHash = {
    schemaVersion: "1.0.0" as SchemaVersion,
    kind: "merge-integration-decision" as const,
    mergeQueueHash: input.mergeQueueHash,
    finalHeadRef,
    outcome,
    acceptedEntries: [...new Set(acceptedEntries)].sort((a, b) => a - b),
    rejectedEntries: [...new Set(rejectedEntries)].sort((a, b) => a - b),
    escalatedEntries: [...new Set(escalatedEntries)].sort((a, b) => a - b),
    conflictEntries: [...new Set(conflictEntries)].sort((a, b) => a - b),
    createdAt: now(),
    rationale: rationale.join(" ")
  } satisfies Omit<MergeIntegrationDecision, "decisionSha256">;

  const decisionSha256 = deriveMergeIntegrationDecisionSha256(decisionOmitHash);
  const decision: MergeIntegrationDecision = {
    ...decisionOmitHash,
    decisionSha256
  };

  return { decision, issues };
}

/**
 * Convenience helper: classify a single step's outcome into the
 * appropriate bucket for the integration gate. Exposed so the
 * orchestrator can re-use the gate's classification when building
 * the issue list.
 */
export function classifyStepOutcome(step: MergeQueueStep): MergeIntegrationOutcome {
  switch (step.outcome) {
    case "rebased":
      return "integrated";
    case "rejected":
      return "rejected";
    case "conflict":
      return "rejected";
    case "escalated":
      return "escalated";
    case "queued":
      return "blocked";
    case "integrated":
      return "integrated";
  }
}
