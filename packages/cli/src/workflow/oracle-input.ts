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

/** `oracleInspectionExecutionSchema` caps instructions at 4096 characters. */
const MAX_ORACLE_INSTRUCTIONS = 4_096;

/** Room kept for the "and N more" footer, so the count is never itself cut. */
const OMISSION_FOOTER_RESERVE = 160;

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
  // Clamping each criterion to 1024 bounded the elements and not the aggregate:
  // twenty criteria is a schema-valid interview, and the joined string then
  // exceeded the 4096-character instruction limit and threw from
  // `oracleSchema.parse` after the spec and change bundle were already written.
  // Fixing the element and not the sum is the same mistake one level up.
  const header = `Decide the criteria that no command can decide, for ${resolved.requirement.id}:`;
  const lines: string[] = [header];
  let budget = MAX_ORACLE_INSTRUCTIONS - header.length - OMISSION_FOOTER_RESERVE;
  let omitted = 0;

  for (const criterion of resolved.manual) {
    const line = `  - ${describeCriterion(criterion)}`;
    if (line.length + 1 > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    budget -= line.length + 1;
  }

  if (omitted > 0) {
    // Named rather than dropped: an unproven criterion that vanished from the
    // review instructions is exactly the gap this section exists to surface.
    lines.push(`  - and ${omitted} more, listed in ${resolved.requirement.id}.`);
  }
  return lines.join("\n");
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
