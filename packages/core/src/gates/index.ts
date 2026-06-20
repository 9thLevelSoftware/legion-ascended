import type { RiskTier } from "@legion/protocol";

export const RISK_GATE_IDS = [
  "current_task_contract_or_small_change_record",
  "deterministic_verification",
  "evidence_note",
  "task_contract",
  "scoped_implementer_run",
  "evidence_bundle_or_log",
  "lightweight_independent_review",
  "approved_delta_spec",
  "protected_oracle",
  "task_level_independent_review",
  "integration_or_real_interface_checks",
  "whole_change_acceptance_evidence",
  "independent_baseline",
  "approved_spec_and_oracle",
  "architecture_or_security_review",
  "protected_acceptance_tests",
  "security_or_e2e_evaluator",
  "explicit_human_approval",
  "release_observation_plan",
  "rollback_or_forward_fix_evidence"
] as const;

export type RiskGateId = (typeof RISK_GATE_IDS)[number];

export interface RiskGateDefinition {
  readonly id: RiskGateId;
  readonly label: string;
  readonly description: string;
}

export interface DerivedRiskGate extends RiskGateDefinition {
  readonly source: "tier" | "override";
  readonly tier?: RiskTier;
  readonly overrideReason?: string;
}

export interface GateAdjustment {
  readonly kind: "add" | "waive";
  readonly gate: RiskGateId;
  readonly reason: string;
}

export type GatePolicyByTier = Readonly<Record<RiskTier, readonly RiskGateId[]>>;

export const RISK_GATE_DEFINITIONS: Readonly<Record<RiskGateId, RiskGateDefinition>> = {
  current_task_contract_or_small_change_record: {
    id: "current_task_contract_or_small_change_record",
    label: "Task Contract Or Small-Change Record",
    description: "A current task contract or approved small-change record identifies the authorized work."
  },
  deterministic_verification: {
    id: "deterministic_verification",
    label: "Deterministic Verification",
    description: "The work records deterministic verification appropriate to the task surface."
  },
  evidence_note: {
    id: "evidence_note",
    label: "Evidence Note",
    description: "The run records a concise evidence note or pointer."
  },
  task_contract: {
    id: "task_contract",
    label: "Task Contract",
    description: "A typed task contract defines objective, scope, oracles, and completion evidence."
  },
  scoped_implementer_run: {
    id: "scoped_implementer_run",
    label: "Scoped Implementer Run",
    description: "Implementation executes inside the approved task scope."
  },
  evidence_bundle_or_log: {
    id: "evidence_bundle_or_log",
    label: "Evidence Bundle Or Log",
    description: "The task preserves a reviewable evidence bundle or raw verification log."
  },
  lightweight_independent_review: {
    id: "lightweight_independent_review",
    label: "Lightweight Independent Review",
    description: "A reviewer checks the scoped change before acceptance."
  },
  approved_delta_spec: {
    id: "approved_delta_spec",
    label: "Approved Delta Spec",
    description: "A reviewed delta spec records the intended behavior change."
  },
  protected_oracle: {
    id: "protected_oracle",
    label: "Protected Oracle",
    description: "Protected acceptance criteria define the required evidence and cannot be waived by risk scoring."
  },
  task_level_independent_review: {
    id: "task_level_independent_review",
    label: "Task-Level Independent Review",
    description: "The task receives an independent review against its contract and evidence."
  },
  integration_or_real_interface_checks: {
    id: "integration_or_real_interface_checks",
    label: "Integration Or Real-Interface Checks",
    description: "Verification reaches the relevant integration or real interface for the change."
  },
  whole_change_acceptance_evidence: {
    id: "whole_change_acceptance_evidence",
    label: "Whole-Change Acceptance Evidence",
    description: "Acceptance evidence covers the complete change rather than only an isolated task."
  },
  independent_baseline: {
    id: "independent_baseline",
    label: "Independent Baseline",
    description: "A baseline exists independently of the implementation run."
  },
  approved_spec_and_oracle: {
    id: "approved_spec_and_oracle",
    label: "Approved Spec And Oracle",
    description: "The spec and oracle are both approved before gated execution proceeds."
  },
  architecture_or_security_review: {
    id: "architecture_or_security_review",
    label: "Architecture Or Security Review",
    description: "A domain review checks architecture or security impact as applicable."
  },
  protected_acceptance_tests: {
    id: "protected_acceptance_tests",
    label: "Protected Acceptance Tests",
    description: "Acceptance tests are protected from unilateral weakening by the implementer."
  },
  security_or_e2e_evaluator: {
    id: "security_or_e2e_evaluator",
    label: "Security Or E2E Evaluator",
    description: "A security or end-to-end evaluator validates high-risk behavior."
  },
  explicit_human_approval: {
    id: "explicit_human_approval",
    label: "Explicit Human Approval",
    description: "A human approval record is required before gated high-risk action."
  },
  release_observation_plan: {
    id: "release_observation_plan",
    label: "Release Observation Plan",
    description: "Release work includes a canary or observation plan."
  },
  rollback_or_forward_fix_evidence: {
    id: "rollback_or_forward_fix_evidence",
    label: "Rollback Or Forward-Fix Evidence",
    description: "Release or migration work records rollback or forward-fix evidence where practical."
  }
};

export function isRiskGateId(value: string): value is RiskGateId {
  return RISK_GATE_IDS.some((gateId) => gateId === value);
}

function assertKnownGateId(value: unknown): asserts value is RiskGateId {
  if (typeof value !== "string" || !isRiskGateId(value)) {
    throw new Error(`Missing definition for risk gate ID: ${String(value)}`);
  }
}

function appendGate(gates: DerivedRiskGate[], gateId: unknown, source: "tier" | "override", tier?: RiskTier, overrideReason?: string): void {
  assertKnownGateId(gateId);
  if (gates.some((gate) => gate.id === gateId)) return;

  const definition = RISK_GATE_DEFINITIONS[gateId];
  gates.push({
    ...definition,
    source,
    ...(tier === undefined ? {} : { tier }),
    ...(overrideReason === undefined ? {} : { overrideReason })
  });
}

export function deriveGateSet(input: {
  readonly tier: RiskTier;
  readonly gatesByTier: GatePolicyByTier;
  readonly adjustments?: readonly GateAdjustment[];
}): readonly DerivedRiskGate[] {
  const gates: DerivedRiskGate[] = [];
  const requiredGateIds = input.gatesByTier[input.tier];
  if (!Array.isArray(requiredGateIds)) {
    throw new Error(`risk policy gatesByTier must define gate array for ${input.tier}`);
  }

  for (const gateId of requiredGateIds) {
    appendGate(gates, gateId, "tier", input.tier);
  }

  for (const adjustment of input.adjustments ?? []) {
    if (adjustment.kind === "add") {
      appendGate(gates, adjustment.gate, "override", undefined, adjustment.reason);
      continue;
    }

    assertKnownGateId(adjustment.gate);
    const index = gates.findIndex((gate) => gate.id === adjustment.gate);
    if (index >= 0) {
      gates.splice(index, 1);
    }
  }

  return gates;
}
