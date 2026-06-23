import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  artifactPathForRole,
  type CreateChangeBundleInput,
  type CreateCurrentSpecInput,
  type CurrentSpecSuccess
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  artifactPathSchema,
  formatEntityId,
  gitShaSchema,
  requirementSchema,
  riskProfileSchema,
  utcTimestampSchema,
  type ArtifactPath,
  type ChangeId,
  type ContractId,
  type GitSha,
  type OracleId,
  type Actor,
  type Project,
  type RequirementId,
  type RiskProfile,
  type UtcTimestamp
} from "@legion/protocol";

import type { PhaseSource } from "./phase-compat.js";

export interface PhasePlanIds {
  readonly suffix: string;
  readonly changeId: ChangeId;
  readonly requirementId: RequirementId;
  readonly oracleId: OracleId;
  readonly contractId: ContractId;
}

export interface BuildChangeInputOptions {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly currentSpec: CurrentSpecSuccess;
  readonly baseGitSha?: GitSha;
  readonly createdAt?: UtcTimestamp;
}

const ZERO_GIT_SHA = "0000000000000000000000000000000000000000";

export function phasePlanIds(phase: PhaseSource): PhasePlanIds {
  const suffix = phaseIdSuffix(phase);
  return {
    suffix,
    changeId: formatEntityId("change", suffix),
    requirementId: formatEntityId("requirement", suffix),
    oracleId: formatEntityId("oracle", suffix),
    contractId: formatEntityId("contract", suffix)
  };
}

export function phaseRiskProfile(phase: PhaseSource): RiskProfile {
  return riskProfileSchema.parse({
    tier: "R2",
    reasons: [`Phase ${phase.number} workflow plan creates a reviewable change.`]
  });
}

export function buildPhaseCurrentSpecInput(options: {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly createdAt?: UtcTimestamp;
}): CreateCurrentSpecInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const currentSpecPath = artifactPathForRole({
    role: "current-spec",
    requirementId: ids.requirementId
  });
  const requirement = requirementSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "requirement",
    id: ids.requirementId,
    projectId: options.project.id,
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: `Phase ${options.phase.number} (${options.phase.name}) has a resolved planning source.`,
    acceptance: {
      language: `Phase ${options.phase.number} planning starts from a resolved source artifact.`,
      criteria: [`${options.phase.name} source is available for typed planning.`],
      oracleRefs: []
    },
    traceRefs: [
      {
        path: currentSpecPath,
        anchor: ids.requirementId,
        relation: "defines",
        entity: { kind: "requirement", id: ids.requirementId }
      }
    ],
    supersedes: []
  });

  return {
    repositoryRoot: options.repositoryRoot,
    document: {
      primaryRequirementId: ids.requirementId,
      capability: {
        id: ids.suffix,
        title: `Phase ${options.phase.number}: ${options.phase.name}`,
        status: "active"
      },
      requirements: [requirement],
      sections: {
        purpose: `Track phase ${options.phase.number} planning source as current project truth.`,
        behaviors: `The project can create a typed change proposal for ${options.phase.name}.`,
        constraints: "The baseline current spec is limited to planning-source availability.",
        scenarios: `A maintainer can run legion plan ${options.phase.number} from the roadmap source.`,
        interfaces: "legion plan",
        compatibility: "The current spec exists so change bundles have explicit current truth.",
        failureModes: "If the current spec cannot be read or created, planning fails with diagnostics.",
        traceIds: [ids.requirementId]
      }
    }
  };
}

export function currentUtcTimestamp(): UtcTimestamp {
  return utcTimestampSchema.parse(new Date().toISOString());
}

export function resolveBaseGitSha(repositoryRoot: string): GitSha {
  try {
    const value = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    return gitShaSchema.parse(value);
  } catch {
    return gitShaSchema.parse(ZERO_GIT_SHA);
  }
}

export function phaseSourceArtifactPath(repositoryRoot: string, phase: PhaseSource): ArtifactPath {
  const relative = path.relative(repositoryRoot, phase.sourcePath).replace(/\\/g, "/");
  const candidate = relative.length > 0 && !relative.startsWith("../") && !path.isAbsolute(relative)
    ? relative
    : ".legion/project/project.json";
  return artifactPathSchema.parse(candidate);
}

export function buildChangeBundleInput(options: BuildChangeInputOptions): CreateChangeBundleInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const baseGitSha = options.baseGitSha ?? resolveBaseGitSha(options.repositoryRoot);
  const sourcePath = phaseSourceArtifactPath(options.repositoryRoot, options.phase);
  const owner = firstDecisionOwner(options.project);
  const requirement = requirementSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "requirement",
    id: ids.requirementId,
    projectId: options.project.id,
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: requirementStatement(options.phase),
    acceptance: {
      language: `Phase ${options.phase.number} is complete when ${options.phase.name} is implemented and verified.`,
      criteria: acceptanceCriteria(options.phase),
      oracleRefs: [ids.oracleId]
    },
    traceRefs: [
      {
        path: sourcePath,
        anchor: `phase-${options.phase.number}`,
        relation: "defines",
        entity: { kind: "requirement", id: ids.requirementId }
      }
    ],
    supersedes: []
  });

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    projectId: options.project.id,
    title: `Plan phase ${options.phase.number}: ${options.phase.name}`,
    summary: summarizePhase(options.phase),
    owners: [owner],
    baseGitSha,
    risk: phaseRiskProfile(options.phase),
    createdAt,
    currentSpecs: [
      {
        requirementId: options.currentSpec.document.primaryRequirementId,
        expectedRevision: options.currentSpec.document.revision
      }
    ],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId: ids.requirementId,
        proposedRequirement: requirement,
        sections: {
          purpose: summarizePhase(options.phase),
          behaviors: options.phase.body || `Implement ${options.phase.name}.`,
          constraints: "Preserve initialized project truth and create reviewable Legion plan artifacts.",
          scenarios: `A maintainer runs legion plan ${options.phase.number} and receives a change, oracle, and taskgraph for ${options.phase.name}.`,
          interfaces: "legion plan",
          compatibility: "Dry-run planning remains preview-only; non-dry-run planning creates typed artifacts.",
          failureModes: "Artifact service validation failures are returned with typed diagnostics.",
          traceIds: [ids.requirementId]
        },
        rationale: `Phase ${options.phase.number} needs typed artifacts before build can execute.`
      }
    ],
    design: {
      title: `Phase ${options.phase.number} implementation plan`,
      body: [
        `Source: ${sourcePath}`,
        "",
        options.phase.body || `Implement ${options.phase.name}.`
      ].join("\n")
    }
  };
}

export function firstDecisionOwner(project: Project): Actor {
  const owner = project.policy.decisionOwners[0];
  if (owner === undefined) {
    throw new Error("Project policy must include at least one decision owner.");
  }
  return owner;
}

function phaseIdSuffix(phase: PhaseSource): string {
  const prefix = `phase-${phase.number}-`;
  const maxNameLength = Math.max(1, 63 - prefix.length);
  const nameSlug = slugFromText(phase.name).slice(0, maxNameLength).replace(/-+$/g, "");
  return `${prefix}${nameSlug || "plan"}`;
}

function slugFromText(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "plan";
}

function requirementStatement(phase: PhaseSource): string {
  return truncate(`Phase ${phase.number} (${phase.name}) must deliver: ${phase.body || phase.name}`, 2_048);
}

function summarizePhase(phase: PhaseSource): string {
  return truncate(phase.body || `Implement ${phase.name}.`, 512);
}

function acceptanceCriteria(phase: PhaseSource): readonly string[] {
  const bullets = phase.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  return bullets.length > 0 ? bullets : [`${phase.name} is implemented and reviewable.`];
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1).trimEnd();
}
