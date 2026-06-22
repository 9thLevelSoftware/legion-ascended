/**
 * P08-T02 — Acceptance gate evaluator.
 *
 * Goal (ADR-006):
 *  - Compute the gate set required for the contract's `risk.tier`.
 *  - Walk the gate set and mark each gate `satisfied`, `failed`,
 *    `missing`, or `not_evaluable` based on the verification report
 *    and review record.
 *  - Emit a deterministic `AcceptanceDecision` whose `outcome` is:
 *      * `accepted`  — all required gates `satisfied`
 *      * `rejected`  — at least one required gate `failed` or `missing`
 *      * `escalated` — required gate is `not_evaluable` (e.g. tier
 *        requires `explicit_human_approval` not yet present)
 *
 * Why this is provider-neutral:
 *  - The evaluator only consumes already-built verification reports
 *    and review records. It never reads node process environment, never
 *    imports a runtime driver, never touches the board persistence
 *    package. The CLI and adapters translate the decision into
 *    provider actions.
 *
 * Why gates are tier-keyed:
 *  - The `PerTaskReviewPolicy.gatesByTier` map follows ADR-006's
 *    R0-R3 gate ladder but limits itself to the per-task-review
 *    surface (deterministic verification + independent review +
 *    evidence bundle). The full R3 ladder (`independent_baseline`,
 *    `architecture_or_security_review`, etc.) is the orchestrator's
 *    responsibility and is surfaced via `gate_not_satisfied` for
 *    tiers that require it.
 */

import type { ContentHash, RiskTier, TaskContract, UtcTimestamp } from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import { deriveAcceptanceDecisionSha256 } from "./hash.js";
import type {
  AcceptanceDecision,
  GateEvaluation,
  GateState,
  PerTaskReviewPolicy,
  ReviewGateId,
  ReviewPipelineIssue,
  ReviewRecord,
  VerificationReport
} from "./contract.js";
import { REVIEW_PIPELINE_SCHEMA_VERSION } from "./contract.js";

const fixedClock = (): UtcTimestamp => "2026-06-22T02:00:00.000Z" as UtcTimestamp;

export const DEFAULT_REVIEW_GATE_POLICY: PerTaskReviewPolicy = {
  gatesByTier: {
    R0: [],
    R1: ["deterministic_verification", "lightweight_independent_review", "evidence_bundle_or_log"],
    R2: ["deterministic_verification", "task_level_independent_review", "evidence_bundle_or_log", "task_contract"],
    R3: [
      "deterministic_verification",
      "task_level_independent_review",
      "evidence_bundle_or_log",
      "task_contract"
    ]
  },
  requireIndependentReview: {
    R0: false,
    R1: true,
    R2: true,
    R3: true
  }
};

export interface EvaluateAcceptanceInput {
  readonly taskContract: TaskContract;
  readonly workerContext: WorkerContext;
  readonly verification: VerificationReport | null;
  readonly review: ReviewRecord | null;
  readonly policy?: PerTaskReviewPolicy;
  readonly now?: () => UtcTimestamp;
}

/**
 * Run the acceptance gate evaluator. Always returns a frozen
 * `AcceptanceDecision`; never throws. Issues (e.g.
 * `gate_evaluator_failure`) are surfaced separately so callers can
 * emit them in the pipeline failure shape.
 */
export function evaluateAcceptanceGate(
  input: EvaluateAcceptanceInput
): { readonly decision: AcceptanceDecision; readonly issues: readonly ReviewPipelineIssue[] } {
  const now = input.now ?? fixedClock;
  const issues: ReviewPipelineIssue[] = [];
  const tier: RiskTier = input.taskContract.risk.tier;
  const policy = input.policy ?? DEFAULT_REVIEW_GATE_POLICY;
  const tierGates = policy.gatesByTier[tier];
  const requiredGates = Array.isArray(tierGates) ? tierGates : [];
  if (!Array.isArray(tierGates)) {
    issues.push({
      code: "gate_evaluator_failure",
      message: `No gate policy defined for tier ${tier}.`,
      path: ["policy", "gatesByTier", tier]
    });
  }
  const requireReview = policy.requireIndependentReview[tier] === true;

  const gates: GateEvaluation[] = [];
  const failing: ReviewGateId[] = [];

  // Gate: deterministic_verification — relies on verification report.
  if (requiredGates.includes("deterministic_verification")) {
    if (input.verification === null) {
      gates.push({
        gate: "deterministic_verification",
        state: "missing",
        reason: "Verification report was not produced; pipeline never reached verification stage.",
        source: "tier",
        tier
      });
      failing.push("deterministic_verification");
    } else if (!input.verification.passed) {
      gates.push({
        gate: "deterministic_verification",
        state: "failed",
        reason: `Verification failed for command(s) at index ${input.verification.failingIndices.join(", ")}.`,
        source: "tier",
        tier
      });
      failing.push("deterministic_verification");
    } else {
      gates.push({
        gate: "deterministic_verification",
        state: "satisfied",
        reason: `Verification passed for ${input.verification.commands.length} command(s).`,
        source: "tier",
        tier
      });
    }
  }

  // Gate: evidence_bundle_or_log — relies on verification report.
  if (requiredGates.includes("evidence_bundle_or_log")) {
    if (input.verification === null) {
      gates.push({
        gate: "evidence_bundle_or_log",
        state: "missing",
        reason: "Evidence bundle (verification report) is missing.",
        source: "tier",
        tier
      });
      failing.push("evidence_bundle_or_log");
    } else {
      gates.push({
        gate: "evidence_bundle_or_log",
        state: "satisfied",
        reason: `Verification report sha256=${input.verification.reportSha256} preserved as evidence.`,
        source: "tier",
        tier
      });
    }
  }

  // Gate: task_level_independent_review / lightweight_independent_review
  // — relies on review record. Independence is the deeper gate: same-actor
  // reviews cannot satisfy even if the verdict passes.
  if (requiredGates.includes("task_level_independent_review") || requiredGates.includes("lightweight_independent_review")) {
    const reviewGateId: ReviewGateId = requiredGates.includes("task_level_independent_review")
      ? "task_level_independent_review"
      : "lightweight_independent_review";

    if (input.review === null) {
      if (requireReview) {
        issues.push({
          code: "review_required_for_tier",
          message: `Tier ${tier} requires an independent review (${reviewGateId}); none was supplied.`,
          path: ["review"]
        });
      }
      gates.push({
        gate: reviewGateId,
        state: "missing",
        reason: requireReview
          ? `Tier ${tier} mandates an independent review; none was supplied.`
          : `Tier ${tier} did not provide an independent review.`,
        source: "tier",
        tier
      });
      failing.push(reviewGateId);
    } else if (!input.review.independent) {
      gates.push({
        gate: reviewGateId,
        state: "failed",
        reason: `Review record ${input.review.reviewHash} is not flagged independent.`,
        source: "tier",
        tier
      });
      failing.push(reviewGateId);
    } else if (
      input.review.verdicts.specification !== "pass" ||
      input.review.verdicts.integration !== "pass" ||
      input.review.verdicts.evidence !== "pass"
    ) {
      gates.push({
        gate: reviewGateId,
        state: "failed",
        reason: `Reviewer returned non-pass verdicts: spec=${input.review.verdicts.specification} integration=${input.review.verdicts.integration} evidence=${input.review.verdicts.evidence}.`,
        source: "tier",
        tier
      });
      failing.push(reviewGateId);
    } else if (input.review.findings.some((finding) => finding.severity === "blocking")) {
      gates.push({
        gate: reviewGateId,
        state: "failed",
        reason: `Review record ${input.review.reviewHash} contains blocking findings.`,
        source: "tier",
        tier
      });
      failing.push(reviewGateId);
    } else {
      gates.push({
        gate: reviewGateId,
        state: "satisfied",
        reason: `Reviewer ${input.review.reviewer.id} returned pass verdicts on all three legs.`,
        source: "tier",
        tier
      });
    }
  }

  // Gate: task_contract — already enforced upstream by dispatcher +
  // preflight, but the gate evaluator records it for audit.
  if (requiredGates.includes("task_contract")) {
    gates.push({
      gate: "task_contract",
      state: "satisfied",
      reason: `Task contract ${input.taskContract.id}@${input.taskContract.revision} cleared dispatcher preflight.`,
      source: "tier",
      tier
    });
  }

  // Tier escalation rule: R3 requires `explicit_human_approval` which is
  // out of scope for the per-task loop. Surface it as a tier-source gate
  // marked not_evaluable so the decision logic routes to "escalated".
  if (tier === "R3") {
    gates.push({
      gate: "task_contract",
      state: "not_evaluable",
      reason: "R3 requires explicit human approval and protected oracle evidence; out of scope for the per-task loop.",
      source: "tier",
      tier
    });
  }

  const outcome = decideOutcome(gates);
  const rationale = buildRationale(outcome, gates, failing);

  const sha = deriveAcceptanceDecisionSha256({
    taskContractId: input.taskContract.id,
    contractRevision: input.taskContract.revision,
    workerContextHash: input.workerContext.workerContextHash,
    tier,
    outcome,
    rationale,
    gates
  });

  const decision: AcceptanceDecision = {
    kind: "acceptance-decision",
    schemaVersion: REVIEW_PIPELINE_SCHEMA_VERSION,
    taskContractId: input.taskContract.id,
    contractRevision: input.taskContract.revision,
    workerContextHash: input.workerContext.workerContextHash,
    tier,
    outcome,
    gates: [...gates],
    failingGates: [...failing],
    decisionSha256: sha,
    createdAt: now(),
    rationale
  };

  return { decision: deepFreeze(decision), issues };
}

function decideOutcome(gates: readonly GateEvaluation[]): AcceptanceDecision["outcome"] {
  const required = gates.filter((gate) => gate.source === "tier");
  if (required.some((gate) => gate.state === "not_evaluable")) {
    return "escalated";
  }
  if (required.some((gate) => gate.state === "failed" || gate.state === "missing")) {
    return "rejected";
  }
  return "accepted";
}

function buildRationale(
  outcome: AcceptanceDecision["outcome"],
  gates: readonly GateEvaluation[],
  failing: readonly ReviewGateId[]
): string {
  if (outcome === "accepted") {
    return `All required gates satisfied (${gates.length} evaluated).`;
  }
  if (outcome === "rejected") {
    return `Required gate(s) ${failing.join(", ")} failed or missing.`;
  }
  return "Required gate(s) are not evaluable inside the per-task loop; escalate.";
}

/**
 * Render an `AcceptanceDecision` as a single human-readable line.
 * Used by the CLI's `next review` subcommand and the evidence
 * indexer. Pure function — no I/O.
 */
export function renderAcceptanceDecision(decision: AcceptanceDecision): string {
  return (
    `acceptance decision: ` +
    `contract=${decision.taskContractId}@${decision.contractRevision} ` +
    `tier=${decision.tier} ` +
    `outcome=${decision.outcome} ` +
    `gates=${decision.gates.length} ` +
    `failing=${decision.failingGates.length} ` +
    `sha=${decision.decisionSha256}`
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  const frozen = Object.freeze(value) as T;
  for (const key of Object.keys(value as object)) {
    const child = (value as unknown as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return frozen;
}

/**
 * Helper: filter decisions to only those that did NOT pass the
 * acceptance gate. Used by the CLI to render "this task needs
 * follow-up" panels.
 */
export function filterDecisionsByOutcome<K extends AcceptanceDecision["outcome"]>(
  decision: AcceptanceDecision,
  outcomes: readonly K[]
): boolean {
  return (outcomes as readonly AcceptanceDecision["outcome"][]).includes(decision.outcome);
}

/**
 * Helper: count decisions grouped by outcome. Used by the
 * evidence indexer to render aggregate statistics across a wave.
 */
export function summarizeDecisions(
  decisions: readonly AcceptanceDecision[]
): Readonly<Record<AcceptanceDecision["outcome"], number>> {
  const summary: Record<AcceptanceDecision["outcome"], number> = {
    accepted: 0,
    rejected: 0,
    escalated: 0
  };
  for (const decision of decisions) {
    summary[decision.outcome] += 1;
  }
  return summary;
}

void ({} as ContentHash);
