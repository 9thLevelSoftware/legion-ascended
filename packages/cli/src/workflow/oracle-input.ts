import {
  artifactPathForRole,
  type ChangeBundleSuccess,
  type CreateOracleArtifactInput
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  oracleSchema,
  type GitSha,
  type Project,
  type UtcTimestamp
} from "@legion/protocol";

import { currentUtcTimestamp, firstDecisionOwner, phasePlanIds } from "./change-input.js";
import type { PhaseSource } from "./phase-compat.js";
import { describeCriterion, type ResolvedPhaseRequirement } from "./phase-requirement.js";

export interface BuildOracleInputOptions {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly change: ChangeBundleSuccess;
  /** The requirement this phase was rendered from, when the roadmap names one. */
  readonly requirement?: ResolvedPhaseRequirement;
  readonly baseGitSha: GitSha;
  readonly createdAt?: UtcTimestamp;
}

/**
 * What a reviewer is asked to decide.
 *
 * Manual criteria are named individually so the unproven surface is visible at
 * review time rather than buried in the requirement file. A phase whose criteria
 * are all executable says so, which is the case worth noticing.
 */
function inspectionInstructions(options: BuildOracleInputOptions): string {
  const resolved = options.requirement;
  if (resolved === undefined) {
    return `Review implementation and evidence for phase ${options.phase.number}: ${options.phase.name}.`;
  }
  if (resolved.manual.length === 0) {
    return `Every acceptance criterion for ${resolved.requirement.id} is executable and runs as task verification. Confirm the evidence records those runs.`;
  }
  return [
    `Decide the criteria that no command can decide, for ${resolved.requirement.id}:`,
    ...resolved.manual.map((criterion) => `  - ${describeCriterion(criterion)}`)
  ].join("\n");
}

export function buildOracleArtifactInput(options: BuildOracleInputOptions): CreateOracleArtifactInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const owner = firstDecisionOwner(options.project);
  const coveredRequirementId = options.requirement?.requirement.id ?? ids.requirementId;
  const oraclePath = artifactPathForRole({
    role: "oracle",
    changeId: ids.changeId,
    oracleId: ids.oracleId
  });

  const oracle = oracleSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "oracle",
    id: ids.oracleId,
    projectId: options.project.id,
    title: `Phase ${options.phase.number} acceptance oracle`,
    owner,
    protectedPaths: [options.change.artifactPath],
    sourceArtifacts: [options.change.reference],
    expected: {
      preconditions: ["The phase change bundle exists and validates."],
      postconditions:
        options.requirement === undefined
          ? [`Phase ${options.phase.number} build evidence addresses ${options.phase.name}.`]
          : options.requirement.requirement.acceptance.criteria.map(describeCriterion),
      evidence: ["Build and verification evidence is attached during legion build."]
    },
    // The operator's own criteria, not a restatement of the phase. "Phase N
    // acceptance criteria are satisfied" is not a criterion — it is the
    // question rephrased as its own answer, and it made every oracle
    // indistinguishable from every other.
    requirementCoverage: [
      {
        requirementId: coveredRequirementId,
        coverage: "primary",
        criteria:
          options.requirement === undefined
            ? [`Phase ${options.phase.number} acceptance criteria are satisfied.`]
            : options.requirement.requirement.acceptance.criteria.map(describeCriterion)
      }
    ],
    traceRefs: [
      {
        path: oraclePath,
        anchor: ids.oracleId,
        relation: "verifies",
        entity: { kind: "requirement", id: coveredRequirementId }
      }
    ],
    type: "inspectable",
    // Inspectable even when every criterion is executable: the task contract is
    // what runs those commands, and duplicating them here would make the same
    // proof pass twice while covering the manual criteria neither time. The
    // instructions name the unproven ones so a reviewer knows what is left to
    // them.
    execution: {
      mode: "manual-inspection",
      instructions: inspectionInstructions(options)
    }
  });

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    oracle,
    baseGitSha: options.baseGitSha
  };
}
