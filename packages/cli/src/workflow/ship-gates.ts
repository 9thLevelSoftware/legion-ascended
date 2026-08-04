import {
  DEFAULT_RISK_POLICY,
  deriveGateSet,
  type DerivedRiskGate,
  type RiskGateId
} from "@legion/core";
import type { EvidenceIndexEntry, ReviewDecisionSuccess } from "@legion/artifacts";
import type { TaskContract } from "@legion/protocol";

import { latestEvidencePerTask } from "./evidence-selection.js";

/**
 * Ship readiness derived from ADR-006 risk gates.
 *
 * `legion ship` previously asked one question: does an accepted review row
 * exist? That is a row-existence check, not a readiness gate — it says nothing
 * about which gates the change's risk tier actually demands. This module
 * derives the required gate set from `DEFAULT_RISK_POLICY` and reports each
 * gate's real status.
 *
 * Three statuses, deliberately distinct:
 *  - `satisfied`   — evidence exists and is positive.
 *  - `unsatisfied` — evidence exists and is negative. Blocks.
 *  - `unevaluable` — Legion does not yet produce evidence of this kind at all.
 *                    Also blocks.
 *
 * An unevaluable gate blocks because the alternative is a self-contradicting
 * verdict: an R2 or R3 change would report `status: "ready"` while the same
 * payload lists its security, acceptance, release-observation and rollback
 * gates as unproven. "Ready" has to mean the risk tier's gates were met, not
 * that nothing actively failed — a gate with no producer is unmet, and the
 * absence of evidence is not evidence of satisfaction.
 *
 * The consequence is that high-tier changes cannot be called ship-ready until
 * Phase D produces oracles, specs and integration checks. That is the honest
 * state of the product, and the report names exactly which gates are missing.
 * Lowering the tier through an audited `risk.override` is the supported way to
 * ship work whose gates genuinely do not apply.
 */

export type ShipGateStatus = "satisfied" | "unsatisfied" | "unevaluable";

export interface ShipGateResult {
  readonly gate: RiskGateId;
  readonly label: string;
  readonly status: ShipGateStatus;
  readonly reason: string;
  readonly taskId: string;
}

export interface ShipGateReport {
  readonly gates: readonly ShipGateResult[];
  readonly satisfied: number;
  readonly unsatisfied: number;
  readonly unevaluable: number;
  readonly ready: boolean;
}

/**
 * The verdict recorded by a task's *latest* attempt.
 *
 * Reading the first match in stored order would answer with the earliest
 * attempt, so an old passing bundle would mask a newer failure and the gate
 * would certify a task that most recently failed.
 */
function evidenceItemVerdict(
  entries: readonly EvidenceIndexEntry[],
  taskId: string,
  itemId: string
): "pass" | "fail" | undefined {
  const entry = latestEvidencePerTask(entries).get(taskId);
  if (entry === undefined) return undefined;
  for (const item of entry.evidence.items) {
    if (item.id !== itemId) continue;
    if (item.verdict === "pass") return "pass";
    if (item.verdict === "fail") return "fail";
  }
  return undefined;
}

function hasEvidence(entries: readonly EvidenceIndexEntry[], taskId: string): boolean {
  const entry = latestEvidencePerTask(entries).get(taskId);
  return entry !== undefined && entry.evidence.items.length > 0;
}

function hasAcceptedReview(reviews: readonly ReviewDecisionSuccess[], taskId: string): boolean {
  return reviews.some(
    (review) => review.document.status === "accepted" && review.document.taskId === taskId
  );
}

function fromVerdict(
  verdict: "pass" | "fail" | undefined,
  itemId: string
): { readonly status: ShipGateStatus; readonly reason: string } {
  if (verdict === "pass") return { status: "satisfied", reason: `Evidence records a passing ${itemId}.` };
  if (verdict === "fail") return { status: "unsatisfied", reason: `Evidence records a failed ${itemId}.` };
  return { status: "unevaluable", reason: `No ${itemId} evidence was recorded for this task.` };
}

function evaluateGate(input: {
  readonly gate: DerivedRiskGate;
  readonly task: TaskContract;
  readonly taskId: string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly reviews: readonly ReviewDecisionSuccess[];
}): { readonly status: ShipGateStatus; readonly reason: string } {
  const { gate, taskId, entries, reviews } = input;

  switch (gate.id) {
    case "task_contract":
    case "current_task_contract_or_small_change_record":
      return { status: "satisfied", reason: "A typed task contract defines this work." };

    case "deterministic_verification":
      return fromVerdict(evidenceItemVerdict(entries, taskId, "declared-verification"), "declared-verification");

    case "scoped_implementer_run":
      return fromVerdict(evidenceItemVerdict(entries, taskId, "diff-reconciliation"), "diff-reconciliation");

    case "evidence_note":
    case "evidence_bundle_or_log":
      return hasEvidence(entries, taskId)
        ? { status: "satisfied", reason: "A reviewable evidence bundle was recorded." }
        : { status: "unsatisfied", reason: "No evidence bundle exists for this task." };

    case "lightweight_independent_review":
    case "task_level_independent_review":
    case "explicit_human_approval":
      return hasAcceptedReview(reviews, taskId)
        ? { status: "satisfied", reason: "An accepted review decision exists for this task." }
        : { status: "unsatisfied", reason: "No accepted review decision exists for this task." };

    case "protected_oracle":
      // Oracle satisfaction is its own evidence item. It was folded into
      // `declared-verification`, whose verdict answers a different question —
      // "did the contract's own commands pass", not "did the criteria the phase
      // was specified against hold" — so this gate had no producer and any R2+
      // change was structurally unshippable.
      //
      // The oracle artifact is content-hash pinned through `artifactInputs`, so
      // a passing run is a run against the recorded oracle, which is what
      // "protected" asks. `unevaluable` remains the answer for a task that names
      // no oracle, and for one whose referenced oracles were not all evaluated:
      // criteria that were never expressed, or never inspected, are not criteria
      // that held.
      return fromVerdict(evidenceItemVerdict(entries, taskId, "oracle-verification"), "oracle-verification");

    default:
      // `approved_spec_and_oracle` asks whether the spec and oracle were
      // approved *before* gated execution. A passing post-execution verdict does
      // not answer that: there is no approval record, approver, or ordering
      // timestamp to check, so satisfying it from the oracle result would claim
      // a governance gate was met when no such approval exists.
      //
      // Delta specs, integration checks, whole-change acceptance, independent
      // baselines, security/e2e evaluation, release observation and rollback
      // evidence have no producer in the workflow yet.
      return {
        status: "unevaluable",
        reason: "Legion does not yet produce evidence for this gate."
      };
  }
}

export function deriveShipGates(input: {
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly reviews: readonly ReviewDecisionSuccess[];
}): ShipGateReport {
  const gates: ShipGateResult[] = [];

  for (const task of input.tasks) {
    const taskId = input.taskIdFor(task);
    // A tier override is already audited at the protocol level (from/to,
    // reason, approver, timestamp), so deriving from the effective tier honours
    // an approved waiver without inventing a second waiver mechanism.
    const derived = deriveGateSet({
      tier: task.risk.tier,
      gatesByTier: DEFAULT_RISK_POLICY.gatesByTier
    });

    for (const gate of derived) {
      const outcome = evaluateGate({ gate, task, taskId, entries: input.entries, reviews: input.reviews });
      gates.push({ gate: gate.id, label: gate.label, taskId, ...outcome });
    }
  }

  const satisfied = gates.filter((entry) => entry.status === "satisfied").length;
  const unsatisfied = gates.filter((entry) => entry.status === "unsatisfied").length;
  const unevaluable = gates.filter((entry) => entry.status === "unevaluable").length;

  // Both unsatisfied and unevaluable block: a required gate that cannot be
  // evaluated has not been met.
  return { gates, satisfied, unsatisfied, unevaluable, ready: unsatisfied === 0 && unevaluable === 0 };
}
