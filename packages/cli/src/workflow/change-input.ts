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
  type Requirement,
  type RequirementId,
  type RiskProfile,
  type RiskTier,
  type UtcTimestamp
} from "@legion/protocol";

import { generatedCriteria } from "./criteria.js";
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
  /** The requirement this phase was rendered from, when the roadmap names one. */
  readonly requirement?: Requirement;
  readonly enforcement?: { readonly tier: RiskTier; readonly reason: string };
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

export function phaseRiskProfile(
  phase: PhaseSource,
  recorded?: { readonly tier: RiskTier; readonly reason: string }
): RiskProfile {
  // A hardcoded R2 silently overrode an operator who chose R3, weakening the
  // gate set on exactly the projects that asked for the strictest one.
  if (recorded !== undefined) {
    return riskProfileSchema.parse({
      tier: recorded.tier,
      reasons: [recorded.reason, `Phase ${phase.number} workflow plan creates a reviewable change.`]
    });
  }

  return riskProfileSchema.parse({
    tier: "R2",
    reasons: [`Phase ${phase.number} workflow plan creates a reviewable change.`]
  });
}

export function buildPhaseCurrentSpecInput(options: {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly requirement?: Requirement;
  readonly createdAt?: UtcTimestamp;
}): CreateCurrentSpecInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();

  // The requirement the interview wrote, when the roadmap names one. Authoring
  // a fresh `req_<phase-suffix>` instead replaced the operator's acceptance
  // proofs with generated prose and left the contract tracing to a requirement
  // nobody agreed to.
  if (options.requirement !== undefined) {
    // A current spec requires each requirement to anchor itself: a trace ref at
    // the spec's own path, anchored on the requirement ID. Intake requirements
    // trace to the interview that recorded them, which is a different and
    // equally necessary fact — so the spec anchor is added here, where the
    // requirement is being placed into a spec, rather than asserted at intake
    // time about a document that does not exist yet.
    const authored = requirementSchema.parse({
      ...options.requirement,
      traceRefs: withSpecAnchor(options.requirement)
    });
    return {
      repositoryRoot: options.repositoryRoot,
      document: {
        primaryRequirementId: authored.id,
        capability: {
          id: ids.suffix,
          title: `Phase ${options.phase.number}: ${options.phase.name}`,
          status: "active"
        },
        requirements: [authored],
        ...currentSpecTail(options, authored.id)
      }
    };
  }

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
      criteria: generatedCriteria([`${options.phase.name} source is available for typed planning.`]),
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
      ...currentSpecTail(options, ids.requirementId)
    }
  };
}

/**
 * The prose sections of a phase current spec.
 *
 * Shared so the authored-stub branch and the real-requirement branch cannot
 * drift apart; only `traceIds` differs, and it has to name whichever
 * requirement the document actually carries.
 */
function currentSpecTail(options: { readonly phase: PhaseSource }, traceRequirementId: string) {
  return {
    sections: {
      purpose: `Track phase ${options.phase.number} planning source as current project truth.`,
      behaviors: `The project can create a typed change proposal for ${options.phase.name}.`,
      constraints: "The baseline current spec is limited to planning-source availability.",
      scenarios: `A maintainer can run legion plan ${options.phase.number} from the roadmap source.`,
      interfaces: "legion plan",
      compatibility: "The current spec exists so change bundles have explicit current truth.",
      failureModes: "If the current spec cannot be read or created, planning fails with diagnostics.",
      traceIds: [traceRequirementId]
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

/**
 * A requirement's trace refs, guaranteed to include the spec self-anchor.
 *
 * Shared by the current-spec and delta paths, because a delta's proposed
 * requirement is validated against the same rule as the spec's.
 */
function withSpecAnchor(requirement: Requirement): Requirement["traceRefs"] {
  const specPath = artifactPathForRole({ role: "current-spec", requirementId: requirement.id });
  // The predicate has to match `createCurrentSpec`'s exactly, including the
  // entity. A trace ref with the right path, anchor and relation but no entity —
  // or one pointing at a different entity — read as anchored here and was then
  // rejected downstream as `missing_stable_anchor`, so a valid requirement set
  // could not be planned at all.
  const anchored = requirement.traceRefs.some(
    (traceRef) =>
      traceRef.path === specPath &&
      traceRef.anchor === requirement.id &&
      traceRef.relation === "defines" &&
      traceRef.entity?.kind === "requirement" &&
      traceRef.entity.id === requirement.id
  );
  if (anchored) return requirement.traceRefs;
  return [
    ...requirement.traceRefs,
    {
      path: specPath,
      anchor: requirement.id,
      relation: "defines",
      entity: { kind: "requirement", id: requirement.id }
    }
  ];
}

export function buildChangeBundleInput(options: BuildChangeInputOptions): CreateChangeBundleInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const baseGitSha = options.baseGitSha ?? resolveBaseGitSha(options.repositoryRoot);
  const sourcePath = phaseSourceArtifactPath(options.repositoryRoot, options.phase);
  const owner = firstDecisionOwner(options.project);

  // The delta has to modify the requirement the current spec actually carries.
  // Authoring a `req_phase-*` stub here while the spec held the intake
  // requirement produced a delta with no matching base, and the operator's
  // acceptance proofs were replaced with generated prose on the way past.
  const deltaRequirementId = options.requirement?.id ?? ids.requirementId;
  const requirement =
    options.requirement === undefined
      ? requirementSchema.parse({
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
            criteria: generatedCriteria(acceptanceCriteria(options.phase)),
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
        })
      : requirementSchema.parse({
          ...options.requirement,
          // The oracle that verifies this phase, appended rather than assigned.
          // Replacing the list dropped any coverage an imported requirement
          // already carried, and shipping the change installs this as current
          // truth — so the earlier links would be gone permanently.
          acceptance: {
            ...options.requirement.acceptance,
            oracleRefs: [
              ...options.requirement.acceptance.oracleRefs.filter((id) => id !== ids.oracleId),
              ids.oracleId
            ]
          },
          traceRefs: withSpecAnchor(options.requirement)
        });

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    projectId: options.project.id,
    title: `Plan phase ${options.phase.number}: ${options.phase.name}`,
    summary: summarizePhase(options.phase),
    owners: [owner],
    baseGitSha,
    risk: phaseRiskProfile(options.phase, options.enforcement),
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
        requirementId: deltaRequirementId,
        proposedRequirement: requirement,
        sections: {
          purpose: summarizePhase(options.phase),
          behaviors: options.phase.body || `Implement ${options.phase.name}.`,
          constraints: "Preserve initialized project truth and create reviewable Legion plan artifacts.",
          scenarios: `A maintainer runs legion plan ${options.phase.number} and receives a change, oracle, and taskgraph for ${options.phase.name}.`,
          interfaces: "legion plan",
          compatibility: "Dry-run planning remains preview-only; non-dry-run planning creates typed artifacts.",
          failureModes: "Artifact service validation failures are returned with typed diagnostics.",
          traceIds: [deltaRequirementId]
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
