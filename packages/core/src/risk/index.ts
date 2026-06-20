import { actorSchema, utcTimestampSchema } from "@legion/protocol";
import type { Actor, ArtifactReference, RiskProfile, RiskTier, UtcTimestamp } from "@legion/protocol";

import { deriveGateSet, isRiskGateId } from "../gates/index.js";
import type { DerivedRiskGate, GateAdjustment, GatePolicyByTier, RiskGateId } from "../gates/index.js";

export const NORMALIZED_RISK_SIGNAL_NAMES = [
  "security",
  "authorization",
  "data_migration",
  "external_side_effect",
  "public_api",
  "ui",
  "performance",
  "infrastructure",
  "irreversible_action",
  "scope_breadth",
  "novelty_uncertainty",
  "verification_quality"
] as const;

export type RiskSignalName = (typeof NORMALIZED_RISK_SIGNAL_NAMES)[number];
export type RiskSignalScore = 0 | 1 | 2 | 3;

export interface RiskSignalInput {
  readonly name: RiskSignalName;
  readonly score: RiskSignalScore;
  readonly rationale: string;
  readonly source: string;
}

export interface NormalizedRiskSignal extends RiskSignalInput {
  readonly scoreMeaning: string;
}

export interface RiskHardFloor {
  readonly signal: RiskSignalName;
  readonly tier: RiskTier;
  readonly reason: string;
}

export interface RiskScoreThreshold {
  readonly tier: RiskTier;
  readonly minScore: number;
  readonly maxScore?: number;
}

export interface RiskSignalFloorRule {
  readonly minScore: RiskSignalScore;
  readonly tier: RiskTier;
  readonly reason: string;
}

export interface RiskSignalDefinition {
  readonly name: RiskSignalName;
  readonly label: string;
  readonly scoreMeanings: readonly [string, string, string, string];
  readonly floorRules: readonly RiskSignalFloorRule[];
}

export interface ApprovedRiskPolicyArtifact {
  readonly kind: "approved_policy_artifact";
  readonly artifact: ArtifactReference;
  readonly approvedBy: Actor;
  readonly approvedAt: UtcTimestamp;
  readonly reason: string;
}

export interface RiskPolicy {
  readonly id: string;
  readonly version: string;
  readonly signalDefinitions: readonly RiskSignalDefinition[];
  readonly scoreThresholds: readonly RiskScoreThreshold[];
  readonly gatesByTier: GatePolicyByTier;
  readonly decisionOwnerIds: readonly string[];
  readonly approval?: ApprovedRiskPolicyArtifact;
}

export interface AddGateOverride {
  readonly kind: "add_gate";
  readonly gate: RiskGateId;
  readonly reason: string;
}

export interface WaiveGateOverride {
  readonly kind: "waive_gate";
  readonly gate: RiskGateId;
  readonly reason: string;
  readonly evidence: string;
  readonly approvedBy: Actor;
  readonly approvedAt: UtcTimestamp;
  readonly replacementEvidence: string;
}

export interface RaiseTierOverride {
  readonly kind: "raise_tier";
  readonly to: RiskTier;
  readonly reason: string;
  readonly approvedBy?: Actor;
  readonly approvedAt?: UtcTimestamp;
}

export interface LowerTierOverride {
  readonly kind: "lower_tier";
  readonly to: RiskTier;
  readonly reason: string;
  readonly evidence: string;
  readonly approvedBy: Actor;
  readonly approvedAt: UtcTimestamp;
  readonly protectionsRetained: readonly RiskGateId[];
}

export type RiskOverride = AddGateOverride | WaiveGateOverride | RaiseTierOverride | LowerTierOverride;

export interface RiskOverrideExplanation {
  readonly kind: RiskOverride["kind"];
  readonly reason: string;
  readonly from?: RiskTier;
  readonly to?: RiskTier;
  readonly gate?: RiskGateId;
  readonly approvedBy?: Actor;
  readonly approvedAt?: UtcTimestamp;
}

export interface RiskTierRuleExplanation {
  readonly rule: "score_threshold" | "hard_floor" | "override";
  readonly tier: RiskTier;
  readonly reason: string;
}

export interface RiskDecisionExplanation {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly thresholdTier: RiskTier;
  readonly signals: readonly NormalizedRiskSignal[];
  readonly hardFloors: readonly RiskHardFloor[];
  readonly tierRules: readonly RiskTierRuleExplanation[];
  readonly overrides: readonly RiskOverrideExplanation[];
}

export interface RiskDecision {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly totalScore: number;
  readonly thresholdTier: RiskTier;
  readonly baseTier: RiskTier;
  readonly tier: RiskTier;
  readonly signals: readonly NormalizedRiskSignal[];
  readonly hardFloors: readonly RiskHardFloor[];
  readonly gates: readonly DerivedRiskGate[];
  readonly riskProfile: RiskProfile;
  readonly explanation: RiskDecisionExplanation;
}

export interface RiskDecisionInput {
  readonly signals: readonly RiskSignalInput[];
  readonly overrides?: readonly RiskOverride[];
  readonly policy?: RiskPolicy;
}

export const RISK_TIERS = ["R0", "R1", "R2", "R3"] as const;

const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3
};

const RISK_TIER_BY_RANK: Readonly<Record<number, RiskTier>> = {
  0: "R0",
  1: "R1",
  2: "R2",
  3: "R3"
};

const RISK_PROFILE_REASON_MAX_LENGTH = 128;

interface NormalizedRiskDecisionInput {
  readonly signals: readonly unknown[];
  readonly overrides?: readonly unknown[];
  readonly policy?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === "string" && RISK_TIERS.some((tier) => tier === value);
}

const DEFAULT_SIGNAL_DEFINITIONS: readonly RiskSignalDefinition[] = [
  {
    name: "security",
    label: "Security, privacy, and sensitive data",
    scoreMeanings: ["None", "Internal-only low sensitivity", "User data or permission-relevant", "Secrets, payment, regulated data, or privilege boundary"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Security or privacy relevance is at least material review surface." },
      { minScore: 3, tier: "R3", reason: "Security boundary, secrets, payment, or regulated data force R3." }
    ]
  },
  {
    name: "authorization",
    label: "Authorization and permission boundary",
    scoreMeanings: ["None", "Internal-only low sensitivity", "Permission-relevant behavior", "Privilege or authorization boundary"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Permission-relevant behavior is at least material review surface." },
      { minScore: 3, tier: "R3", reason: "Authorization boundary changes force R3." }
    ]
  },
  {
    name: "data_migration",
    label: "Persistent data or migration",
    scoreMeanings: ["None", "Local cache only", "User/project persistent state", "Destructive migration or irreversible state change"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Persistent project state is an R2 hard floor." },
      { minScore: 3, tier: "R3", reason: "Destructive migration or irreversible state change forces R3." }
    ]
  },
  {
    name: "external_side_effect",
    label: "External side effect",
    scoreMeanings: ["None", "Local Git only", "Reversible external effect", "Production, public, financial, destructive, or hard-to-reverse effect"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "External integration effect is at least R2." },
      { minScore: 3, tier: "R3", reason: "Production, public, financial, destructive, or hard-to-reverse side effect forces R3." }
    ]
  },
  {
    name: "public_api",
    label: "Public API or schema compatibility",
    scoreMeanings: ["None", "Internal-only", "User-visible API or schema", "Breaking public API, package, or migration contract"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Public schema or user-visible API is an R2 hard floor." },
      { minScore: 3, tier: "R3", reason: "Breaking public API, package, or migration contract forces R3." }
    ]
  },
  {
    name: "ui",
    label: "User-visible interface",
    scoreMeanings: ["None", "Inspectable copy or docs only", "User-facing behavior", "Release-channel user workflow"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "User-facing behavior is an R2 hard floor." },
      { minScore: 3, tier: "R3", reason: "Release-channel user workflow impact forces R3." }
    ]
  },
  {
    name: "performance",
    label: "Performance or capacity",
    scoreMeanings: ["None", "Local-only performance concern", "Material latency or capacity concern", "Production capacity, resource exhaustion, or performance SLO risk"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Material performance or capacity behavior requires integration evidence." },
      { minScore: 3, tier: "R3", reason: "Production capacity or SLO risk forces R3." }
    ]
  },
  {
    name: "infrastructure",
    label: "Infrastructure or deployment criticality",
    scoreMeanings: ["No deployment", "Local/dev only", "Preview/staging", "Production infrastructure or release-channel effect"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Preview or staging deployment is at least R2." },
      { minScore: 3, tier: "R3", reason: "Production infrastructure or release-channel effect forces R3." }
    ]
  },
  {
    name: "irreversible_action",
    label: "Reversibility",
    scoreMeanings: ["Fully revertible", "Revertible with minor cleanup", "Requires migration or coordinated rollback", "Hard to reverse or data-loss risk"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Coordinated rollback or migration need is at least R2." },
      { minScore: 3, tier: "R3", reason: "Hard-to-reverse or data-loss risk forces R3." }
    ]
  },
  {
    name: "scope_breadth",
    label: "Blast radius and scope breadth",
    scoreMeanings: ["One file or generated artifact", "Isolated module", "Multi-module or user-facing path", "Cross-system, release, infra, or many dependents"],
    floorRules: [
      { minScore: 2, tier: "R2", reason: "Multi-module or user-facing path is an R2 hard floor." },
      { minScore: 3, tier: "R3", reason: "Cross-system, release, infra, or many-dependent change forces R3." }
    ]
  },
  {
    name: "novelty_uncertainty",
    label: "Novelty and uncertainty",
    scoreMeanings: ["Known pattern", "Minor unknowns", "New integration or weak local knowledge", "New architecture, provider, or high ambiguity"],
    floorRules: [
      { minScore: 3, tier: "R3", reason: "New architecture, provider, or high ambiguity forces R3." }
    ]
  },
  {
    name: "verification_quality",
    label: "Existing verification quality",
    scoreMeanings: ["Strong targeted tests", "Some coverage", "Weak coverage", "No executable oracle for material behavior"],
    floorRules: [
      { minScore: 3, tier: "R3", reason: "No executable oracle for material behavior forces R3." }
    ]
  }
];

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  id: "adr-006-risk-adaptive-gates",
  version: "0.1.0",
  signalDefinitions: DEFAULT_SIGNAL_DEFINITIONS,
  scoreThresholds: [
    { tier: "R0", minScore: 0, maxScore: 2 },
    { tier: "R1", minScore: 3, maxScore: 5 },
    { tier: "R2", minScore: 6, maxScore: 8 },
    { tier: "R3", minScore: 9 }
  ],
  gatesByTier: {
    R0: [
      "current_task_contract_or_small_change_record",
      "deterministic_verification",
      "evidence_note"
    ],
    R1: [
      "task_contract",
      "scoped_implementer_run",
      "deterministic_verification",
      "evidence_bundle_or_log",
      "lightweight_independent_review"
    ],
    R2: [
      "approved_delta_spec",
      "protected_oracle",
      "task_contract",
      "deterministic_verification",
      "task_level_independent_review",
      "integration_or_real_interface_checks",
      "whole_change_acceptance_evidence"
    ],
    R3: [
      "independent_baseline",
      "approved_spec_and_oracle",
      "protected_oracle",
      "deterministic_verification",
      "architecture_or_security_review",
      "protected_acceptance_tests",
      "security_or_e2e_evaluator",
      "explicit_human_approval",
      "release_observation_plan",
      "rollback_or_forward_fix_evidence"
    ]
  },
  decisionOwnerIds: ["dasbl"]
};

export function riskTierRank(tier: RiskTier): number {
  return RISK_TIER_RANK[tier];
}

function tierForRank(rank: number): RiskTier {
  const clamped = Math.max(0, Math.min(3, rank));
  const tier = RISK_TIER_BY_RANK[clamped];
  if (tier === undefined) {
    throw new Error(`Unsupported risk tier rank ${rank}.`);
  }
  return tier;
}

function maxTier(left: RiskTier, right: RiskTier): RiskTier {
  return riskTierRank(left) >= riskTierRank(right) ? left : right;
}

function isRiskSignalName(value: string): value is RiskSignalName {
  return NORMALIZED_RISK_SIGNAL_NAMES.some((name) => name === value);
}

function assertScore(score: number, signalName: RiskSignalName): asserts score is RiskSignalScore {
  if (score !== 0 && score !== 1 && score !== 2 && score !== 3) {
    throw new TypeError(`Risk signal ${signalName} score must be 0, 1, 2, or 3.`);
  }
}

function normalizeRiskDecisionInput(input: unknown): NormalizedRiskDecisionInput {
  if (!isRecord(input)) {
    throw new TypeError("Input to deriveRiskDecision must be defined.");
  }

  const signals = input["signals"];
  if (!Array.isArray(signals)) {
    throw new TypeError("Input signals must be an array.");
  }

  const overrides = input["overrides"];
  if (overrides !== undefined && !Array.isArray(overrides)) {
    throw new TypeError("Input overrides must be an array.");
  }

  const policy = input["policy"];
  return {
    signals,
    ...(overrides === undefined ? {} : { overrides }),
    ...(policy === undefined ? {} : { policy })
  };
}

function assertDefaultOrApprovedPolicy(policy: unknown, inputPolicy: unknown): asserts policy is RiskPolicy {
  if (inputPolicy === undefined || policy === DEFAULT_RISK_POLICY) return;

  if (!isRecord(policy)) {
    throw new Error("custom risk policy must be a valid object");
  }

  const approval = policy["approval"];
  if (isRecord(approval) && approval["kind"] === "approved_policy_artifact") return;

  throw new Error("custom risk policy requires an approved policy artifact");
}

function assertRiskPolicyShape(policy: RiskPolicy): void {
  if (!Array.isArray(policy.signalDefinitions) || policy.signalDefinitions.length === 0) {
    throw new Error("risk policy must define signal definitions");
  }

  for (const definition of policy.signalDefinitions) {
    if (!isRecord(definition)) {
      throw new Error("risk policy signal definition must be a valid object");
    }

    const name = definition["name"];
    if (typeof name !== "string" || !isRiskSignalName(name)) {
      throw new Error(`risk policy contains unknown signal ${String(name)}`);
    }

    const scoreMeanings = definition["scoreMeanings"];
    if (!Array.isArray(scoreMeanings) || scoreMeanings.length !== 4 || scoreMeanings.some((meaning) => typeof meaning !== "string")) {
      throw new Error(`risk policy signal ${name} must define four score meanings`);
    }

    const floorRules = definition["floorRules"];
    if (!Array.isArray(floorRules)) {
      throw new Error(`risk policy signal ${name} must define floor rules`);
    }
  }

  if (!Array.isArray(policy.scoreThresholds) || policy.scoreThresholds.length === 0) {
    throw new Error("risk policy must define score thresholds");
  }

  if (!Array.isArray(policy.decisionOwnerIds)) {
    throw new Error("risk policy must define decision owner IDs");
  }

  if (!isRecord(policy.gatesByTier)) {
    throw new Error("risk policy gatesByTier must define gate arrays");
  }

  for (const tier of RISK_TIERS) {
    if (!Array.isArray(policy.gatesByTier[tier])) {
      throw new Error(`risk policy gatesByTier must define gate array for ${tier}`);
    }
  }
}

function signalDefinitionMap(policy: RiskPolicy): ReadonlyMap<RiskSignalName, RiskSignalDefinition> {
  const definitions = new Map<RiskSignalName, RiskSignalDefinition>();
  for (const definition of policy.signalDefinitions) {
    definitions.set(definition.name, definition);
  }
  return definitions;
}

function normalizeSignals(inputSignals: readonly unknown[], policy: RiskPolicy): readonly NormalizedRiskSignal[] {
  const definitions = signalDefinitionMap(policy);
  const supplied = new Map<RiskSignalName, RiskSignalInput>();

  for (const input of inputSignals) {
    if (!isRecord(input)) {
      throw new TypeError("Each risk signal input must be a valid object.");
    }

    const nameValue = input["name"];
    if (typeof nameValue !== "string" || !isRiskSignalName(nameValue)) {
      throw new TypeError(`Unknown normalized risk signal ${String(nameValue)}.`);
    }

    const scoreValue = input["score"];
    if (typeof scoreValue !== "number") {
      throw new TypeError(`Risk signal ${nameValue} score must be 0, 1, 2, or 3.`);
    }
    assertScore(scoreValue, nameValue);

    const rationaleValue = input["rationale"];
    if (typeof rationaleValue !== "string" || rationaleValue.length === 0) {
      throw new TypeError(`Risk signal ${nameValue} rationale must be a non-empty string.`);
    }

    const sourceValue = input["source"];
    if (typeof sourceValue !== "string" || sourceValue.length === 0) {
      throw new TypeError(`Risk signal ${nameValue} source must be a non-empty string.`);
    }

    const normalizedInput: RiskSignalInput = {
      name: nameValue,
      score: scoreValue,
      rationale: rationaleValue,
      source: sourceValue
    };

    const existing = supplied.get(nameValue);
    if (existing === undefined || scoreValue > existing.score) {
      supplied.set(nameValue, normalizedInput);
    }
  }

  const normalized: NormalizedRiskSignal[] = [];
  for (const name of NORMALIZED_RISK_SIGNAL_NAMES) {
    const definition = definitions.get(name);
    if (definition === undefined) {
      throw new Error(`Risk policy ${policy.id}@${policy.version} does not define signal ${name}.`);
    }

    const suppliedSignal = supplied.get(name);
    const score = suppliedSignal?.score ?? 0;
    const scoreMeaning = definition.scoreMeanings[score];
    normalized.push({
      name,
      score,
      rationale: suppliedSignal?.rationale ?? "No risk signal supplied.",
      source: suppliedSignal?.source ?? "policy-default",
      scoreMeaning
    });
  }

  return normalized;
}

function thresholdTierForScore(totalScore: number, policy: RiskPolicy): RiskTier {
  const threshold = policy.scoreThresholds.find((entry) => {
    if (totalScore < entry.minScore) return false;
    return entry.maxScore === undefined || totalScore <= entry.maxScore;
  });

  if (threshold === undefined) {
    throw new Error(`Risk policy ${policy.id}@${policy.version} has no threshold for score ${totalScore}.`);
  }

  return threshold.tier;
}

function deriveHardFloors(signals: readonly NormalizedRiskSignal[], policy: RiskPolicy): readonly RiskHardFloor[] {
  const definitions = signalDefinitionMap(policy);
  const floors: RiskHardFloor[] = [];

  for (const signal of signals) {
    const definition = definitions.get(signal.name);
    if (definition === undefined) {
      throw new Error(`Risk policy ${policy.id}@${policy.version} does not define signal ${signal.name}.`);
    }

    for (const floorRule of definition.floorRules) {
      if (signal.score >= floorRule.minScore) {
        floors.push({
          signal: signal.name,
          tier: floorRule.tier,
          reason: floorRule.reason
        });
      }
    }
  }

  return floors;
}

function highestFloorTier(floors: readonly RiskHardFloor[]): RiskTier {
  return floors.reduce<RiskTier>((tier, floor) => maxTier(tier, floor.tier), "R0");
}

function deriveBaseTier(thresholdTier: RiskTier, floors: readonly RiskHardFloor[], signals: readonly NormalizedRiskSignal[]): RiskTier {
  const singleScoreTwoTier = signals.some((signal) => signal.score === 2) ? "R1" : "R0";
  return maxTier(maxTier(thresholdTier, highestFloorTier(floors)), singleScoreTwoTier);
}

function assertDecisionOwnerApproval(
  override: { readonly approvedBy?: Actor },
  policy: RiskPolicy
): asserts override is { readonly approvedBy: Actor } {
  const isDecisionOwner = override.approvedBy?.kind === "human" && policy.decisionOwnerIds.includes(override.approvedBy.id);
  if (!isDecisionOwner) {
    throw new Error("lower-tier override requires decision owner approval");
  }
}

function assertGateId(gate: RiskGateId): void {
  if (!isRiskGateId(gate)) {
    throw new Error(`Unknown risk gate ${gate}.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeRiskGateId(value: unknown): RiskGateId {
  if (typeof value !== "string" || !isRiskGateId(value)) {
    throw new Error(`Unknown risk gate ${String(value)}.`);
  }
  return value;
}

function normalizeActor(value: unknown, label: string): Actor {
  try {
    return actorSchema.parse(value);
  } catch {
    throw new Error(`${label} must be a valid actor`);
  }
}

function normalizeTimestamp(value: unknown, label: string): UtcTimestamp {
  try {
    return utcTimestampSchema.parse(value);
  } catch {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
}

function normalizeOverrides(overrides: readonly unknown[] | undefined): readonly RiskOverride[] {
  if (overrides === undefined) return [];

  return overrides.map((override, index) => {
    if (!isRecord(override)) {
      throw new Error(`risk override ${index} must be a valid object`);
    }

    const kind = override["kind"];
    if (kind === "add_gate") {
      return {
        kind,
        gate: normalizeRiskGateId(override["gate"]),
        reason: requireString(override["reason"], "add-gate override reason")
      };
    }

    if (kind === "waive_gate") {
      return {
        kind,
        gate: normalizeRiskGateId(override["gate"]),
        reason: requireString(override["reason"], "waive-gate override reason"),
        evidence: requireString(override["evidence"], "waive-gate override evidence"),
        approvedBy: normalizeActor(override["approvedBy"], "waive-gate override approvedBy"),
        approvedAt: normalizeTimestamp(override["approvedAt"], "waive-gate override approvedAt"),
        replacementEvidence: requireString(override["replacementEvidence"], "waive-gate override replacementEvidence")
      };
    }

    if (kind === "raise_tier") {
      const to = override["to"];
      if (!isRiskTier(to)) {
        throw new Error(`raise-tier override target must be a risk tier`);
      }

      const approvedBy = override["approvedBy"];
      const approvedAt = override["approvedAt"];
      return {
        kind,
        to,
        reason: requireString(override["reason"], "raise-tier override reason"),
        ...(approvedBy === undefined ? {} : { approvedBy: normalizeActor(approvedBy, "raise-tier override approvedBy") }),
        ...(approvedAt === undefined ? {} : { approvedAt: normalizeTimestamp(approvedAt, "raise-tier override approvedAt") })
      };
    }

    if (kind === "lower_tier") {
      const to = override["to"];
      if (!isRiskTier(to)) {
        throw new Error("lower-tier override target must be a risk tier");
      }

      const reason = override["reason"];
      const evidence = override["evidence"];
      const protectionsRetained = override["protectionsRetained"];
      if (
        typeof reason !== "string" ||
        reason.length === 0 ||
        typeof evidence !== "string" ||
        evidence.length === 0 ||
        !Array.isArray(protectionsRetained) ||
        protectionsRetained.length === 0
      ) {
        throw new Error("lower-tier override requires reason, evidence, and retained protections");
      }

      return {
        kind,
        to,
        reason,
        evidence,
        approvedBy: normalizeActor(override["approvedBy"], "lower-tier override approvedBy"),
        approvedAt: normalizeTimestamp(override["approvedAt"], "lower-tier override approvedAt"),
        protectionsRetained: protectionsRetained.map((gate) => normalizeRiskGateId(gate))
      };
    }

    throw new Error(`unsupported risk override kind ${String(kind)}`);
  });
}

function applyTierOverrides(input: {
  readonly baseTier: RiskTier;
  readonly hardFloorTier: RiskTier;
  readonly overrides: readonly RiskOverride[];
  readonly policy: RiskPolicy;
}): {
  readonly tier: RiskTier;
  readonly explanations: readonly RiskOverrideExplanation[];
  readonly profileOverride?: RiskProfile["override"];
} {
  let tier = input.baseTier;
  const explanations: RiskOverrideExplanation[] = [];
  let profileOverride: RiskProfile["override"] | undefined;

  for (const override of input.overrides) {
    if (override.kind === "add_gate" || override.kind === "waive_gate") continue;

    if (override.kind === "raise_tier") {
      if (riskTierRank(override.to) <= riskTierRank(tier)) {
        throw new Error(`raise-tier override must target a higher tier than ${tier}.`);
      }

      const from = tier;
      tier = override.to;
      explanations.push({
        kind: override.kind,
        reason: override.reason,
        from,
        to: override.to,
        ...(override.approvedBy === undefined ? {} : { approvedBy: override.approvedBy }),
        ...(override.approvedAt === undefined ? {} : { approvedAt: override.approvedAt })
      });
      continue;
    }

    assertDecisionOwnerApproval(override, input.policy);

    if (riskTierRank(override.to) >= riskTierRank(tier)) {
      throw new Error(`lower-tier override must target a lower tier than ${tier}.`);
    }

    if (riskTierRank(override.to) < riskTierRank(input.hardFloorTier)) {
      throw new Error(`cannot lower below hard floor ${input.hardFloorTier}`);
    }

    if (override.reason.length === 0 || override.evidence.length === 0 || override.protectionsRetained.length === 0) {
      throw new Error("lower-tier override requires reason, evidence, and retained protections");
    }

    for (const gate of override.protectionsRetained) {
      assertGateId(gate);
    }

    const from = tier;
    tier = override.to;
    explanations.push({
      kind: override.kind,
      reason: override.reason,
      from,
      to: override.to,
      approvedBy: override.approvedBy,
      approvedAt: override.approvedAt
    });
    profileOverride = {
      from,
      to: override.to,
      reason: override.reason,
      approvedBy: override.approvedBy,
      approvedAt: override.approvedAt
    };
  }

  return {
    tier,
    explanations,
    ...(profileOverride === undefined ? {} : { profileOverride })
  };
}

function deriveGateAdjustments(overrides: readonly RiskOverride[], policy: RiskPolicy): {
  readonly adjustments: readonly GateAdjustment[];
  readonly explanations: readonly RiskOverrideExplanation[];
} {
  const adjustments: GateAdjustment[] = [];
  const explanations: RiskOverrideExplanation[] = [];

  for (const override of overrides) {
    if (override.kind === "add_gate") {
      assertGateId(override.gate);
      adjustments.push({ kind: "add", gate: override.gate, reason: override.reason });
      explanations.push({ kind: override.kind, gate: override.gate, reason: override.reason });
      continue;
    }

    if (override.kind !== "waive_gate") continue;

    assertGateId(override.gate);
    assertDecisionOwnerApproval(override, policy);
    if (override.gate === "protected_oracle" || override.gate === "explicit_human_approval") {
      throw new Error(`cannot waive protected gate ${override.gate}`);
    }

    adjustments.push({ kind: "waive", gate: override.gate, reason: override.reason });
    explanations.push({
      kind: override.kind,
      gate: override.gate,
      reason: override.reason,
      approvedBy: override.approvedBy,
      approvedAt: override.approvedAt
    });
  }

  for (const override of overrides) {
    if (override.kind !== "lower_tier") continue;

    for (const gate of override.protectionsRetained) {
      adjustments.push({
        kind: "add",
        gate,
        reason: `Retained by lower-tier override: ${override.reason}`
      });
    }
  }

  return { adjustments, explanations };
}

function protocolReason(value: string): string {
  if (value.length <= RISK_PROFILE_REASON_MAX_LENGTH) return value;
  return `${value.slice(0, RISK_PROFILE_REASON_MAX_LENGTH - 3)}...`;
}

function profileReasons(signals: readonly NormalizedRiskSignal[], thresholdTier: RiskTier, baseTier: RiskTier): string[] {
  const reasons = signals
    .filter((signal) => signal.score > 0)
    .map((signal) => protocolReason(`${signal.name}:${signal.score}:${signal.rationale}`));

  if (reasons.length > 0) {
    return [protocolReason(`score_threshold:${thresholdTier}`), protocolReason(`base_tier:${baseTier}`), ...reasons];
  }

  return [protocolReason(`score_threshold:${thresholdTier}`), protocolReason(`base_tier:${baseTier}`), "all_normalized_signals_zero"];
}

function profileHardFloorReasons(floors: readonly RiskHardFloor[]): string[] | undefined {
  if (floors.length === 0) return undefined;
  return floors.map((floor) => protocolReason(`${floor.signal}:${floor.tier}:${floor.reason}`));
}

function riskProfileFor(input: {
  readonly tier: RiskTier;
  readonly baseTier: RiskTier;
  readonly thresholdTier: RiskTier;
  readonly signals: readonly NormalizedRiskSignal[];
  readonly hardFloors: readonly RiskHardFloor[];
  readonly override?: RiskProfile["override"];
}): RiskProfile {
  const hardFloorReasons = profileHardFloorReasons(input.hardFloors);

  return {
    tier: input.tier,
    reasons: profileReasons(input.signals, input.thresholdTier, input.baseTier),
    ...(hardFloorReasons === undefined ? {} : { hardFloors: hardFloorReasons }),
    ...(input.override === undefined ? {} : { override: input.override })
  };
}

function tierRuleExplanations(input: {
  readonly totalScore: number;
  readonly thresholdTier: RiskTier;
  readonly hardFloors: readonly RiskHardFloor[];
  readonly baseTier: RiskTier;
  readonly finalTier: RiskTier;
}): readonly RiskTierRuleExplanation[] {
  const rules: RiskTierRuleExplanation[] = [
    {
      rule: "score_threshold",
      tier: input.thresholdTier,
      reason: `Total score ${input.totalScore} maps to ${input.thresholdTier}.`
    }
  ];

  for (const floor of input.hardFloors) {
    rules.push({
      rule: "hard_floor",
      tier: floor.tier,
      reason: `${floor.signal}: ${floor.reason}`
    });
  }

  if (input.finalTier !== input.baseTier) {
    rules.push({
      rule: "override",
      tier: input.finalTier,
      reason: `Authorized override changed tier from ${input.baseTier} to ${input.finalTier}.`
    });
  }

  return rules;
}

export function deriveRiskDecision(input: RiskDecisionInput): RiskDecision;
export function deriveRiskDecision(input: unknown): RiskDecision {
  const normalizedInput = normalizeRiskDecisionInput(input);
  const policy = normalizedInput.policy === undefined ? DEFAULT_RISK_POLICY : normalizedInput.policy;
  assertDefaultOrApprovedPolicy(policy, normalizedInput.policy);
  assertRiskPolicyShape(policy);

  const signals = normalizeSignals(normalizedInput.signals, policy);
  const totalScore = signals.reduce((total, signal) => total + signal.score, 0);
  const thresholdTier = thresholdTierForScore(totalScore, policy);
  const hardFloors = deriveHardFloors(signals, policy);
  const baseTier = deriveBaseTier(thresholdTier, hardFloors, signals);
  const hardFloorTier = highestFloorTier(hardFloors);
  const overrides = normalizeOverrides(normalizedInput.overrides);
  const tierOverrideResult = applyTierOverrides({
    baseTier,
    hardFloorTier,
    overrides,
    policy
  });
  const gateOverrideResult = deriveGateAdjustments(overrides, policy);
  const gates = deriveGateSet({
    tier: tierOverrideResult.tier,
    gatesByTier: policy.gatesByTier,
    adjustments: gateOverrideResult.adjustments
  });
  const riskProfile = riskProfileFor({
    tier: tierOverrideResult.tier,
    baseTier,
    thresholdTier,
    signals,
    hardFloors,
    ...(tierOverrideResult.profileOverride === undefined ? {} : { override: tierOverrideResult.profileOverride })
  });
  const overrideExplanations = [...tierOverrideResult.explanations, ...gateOverrideResult.explanations];
  const explanation: RiskDecisionExplanation = {
    policyId: policy.id,
    policyVersion: policy.version,
    thresholdTier,
    signals,
    hardFloors,
    tierRules: tierRuleExplanations({
      totalScore,
      thresholdTier,
      hardFloors,
      baseTier,
      finalTier: tierOverrideResult.tier
    }),
    overrides: overrideExplanations
  };

  return {
    policyId: policy.id,
    policyVersion: policy.version,
    totalScore,
    thresholdTier,
    baseTier,
    tier: tierOverrideResult.tier,
    signals,
    hardFloors,
    gates,
    riskProfile,
    explanation
  };
}

export function riskTierFromScore(totalScore: number): RiskTier {
  if (typeof totalScore !== "number" || !Number.isFinite(totalScore)) {
    throw new TypeError("Risk score must be a valid number.");
  }

  if (totalScore < 0) {
    throw new RangeError("Risk score cannot be negative.");
  }

  if (totalScore <= 2) return "R0";
  if (totalScore <= 5) return "R1";
  if (totalScore <= 8) return "R2";
  return tierForRank(3);
}
