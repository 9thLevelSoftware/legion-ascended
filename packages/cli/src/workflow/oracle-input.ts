import {
  artifactPathForRole,
  type ChangeBundleSuccess,
  type CreateOracleArtifactInput
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  formatEntityId,
  oracleSchema,
  type GitSha,
  type Project,
  type UtcTimestamp
} from "@legion/protocol";

import { currentUtcTimestamp, firstDecisionOwner, phasePlanIds } from "./change-input.js";
import type { PhaseSource } from "./phase-compat.js";
import {
  describeCriterion,
  type ExecutableCriterion,
  type ResolvedPhaseRequirement
} from "./phase-requirement.js";

/** `oracleInspectionExecutionSchema` caps instructions at 4096 characters. */
const MAX_ORACLE_INSTRUCTIONS = 4_096;

/** Room kept for the "and N more" footer, so the count is never itself cut. */
const OMISSION_FOOTER_RESERVE = 160;

/** `oracleCommandExecutionSchema` allows no longer timeout than an hour. */
const MAX_ORACLE_TIMEOUT_MS = 3_600_000;

const DEFAULT_ORACLE_TIMEOUT_MS = 600_000;

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
 * Only the criteria no command can decide reach here now that each executable
 * criterion has an oracle of its own, so this is the unproven surface and
 * nothing else. A phase with no manual criteria produces no inspection oracle at
 * all rather than one that asks a reviewer to confirm what a command already
 * decided.
 */
function inspectionInstructions(options: BuildOracleInputOptions): string {
  const resolved = options.requirement;
  if (resolved === undefined) {
    return `Review implementation and evidence for phase ${options.phase.number}: ${options.phase.name}.`;
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

/**
 * The oracle ID for the criterion at `index`.
 *
 * Positional rather than derived from the criterion text: a criterion the
 * operator rewords keeps its oracle, and two criteria that happen to read alike
 * do not collide into one. The trade is that reordering criteria reassigns
 * oracles, which replanning rewrites anyway.
 */
export function criterionOracleId(phase: PhaseSource, index: number): string {
  return formatEntityId("oracle", `${phasePlanIds(phase).suffix}-c${index + 1}`);
}

/**
 * One oracle per executable criterion.
 *
 * A single `inspectable` oracle asserting "phase N acceptance criteria are
 * satisfied" made every phase's acceptance identical and left a reviewer to
 * decide, by hand, things a command had already decided. An executable
 * criterion carries the command the operator said decides it, so it becomes an
 * oracle a runner can execute — which is what `type: "executable"` is for and
 * what nothing in this repository has ever emitted.
 */
function executableOracles(
  options: BuildOracleInputOptions,
  criteria: readonly ExecutableCriterion[]
): readonly CreateOracleArtifactInput[] {
  const resolved = options.requirement;
  if (resolved === undefined) return [];
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const owner = firstDecisionOwner(options.project);

  return criteria.map((criterion, index) => {
    const oracleId = criterionOracleId(options.phase, index);
    const oraclePath = artifactPathForRole({ role: "oracle", changeId: ids.changeId, oracleId });
    const description = describeCriterion(criterion);

    const oracle = oracleSchema.parse({
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "oracle",
      id: oracleId,
      projectId: options.project.id,
      title: `Acceptance criterion ${index + 1} for ${resolved.requirement.id}`,
      owner,
      protectedPaths: [options.change.artifactPath],
      sourceArtifacts: [options.change.reference],
      expected: {
        preconditions: ["The phase change bundle exists and validates."],
        postconditions: [description],
        evidence: ["The criterion command runs during legion build and exits as expected."]
      },
      requirementCoverage: [
        {
          requirementId: resolved.requirement.id,
          // `partial`, not `primary`: this oracle decides one criterion of the
          // requirement. Claiming primary coverage from each of several oracles
          // would report the requirement fully covered by any one of them.
          coverage: "partial",
          criteria: [description]
        }
      ],
      traceRefs: [
        {
          path: oraclePath,
          anchor: oracleId,
          relation: "verifies",
          entity: { kind: "requirement", id: resolved.requirement.id }
        }
      ],
      type: "executable",
      execution: {
        mode: "command",
        command: criterion.proof.command,
        args: [...criterion.proof.args],
        expectedExitCode: criterion.proof.expectedExitCode,
        // The schema's ceiling is an hour; an interview can ask for longer.
        // Clamping keeps a legal interview from throwing here, after the change
        // bundle is already on disk.
        timeoutMs: Math.min(criterion.proof.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS, MAX_ORACLE_TIMEOUT_MS)
      }
    });

    return {
      repositoryRoot: options.repositoryRoot,
      changeId: ids.changeId,
      oracle,
      baseGitSha: options.baseGitSha
    };
  });
}

function inspectionOracle(options: BuildOracleInputOptions): CreateOracleArtifactInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const owner = firstDecisionOwner(options.project);
  const coveredRequirementId = options.requirement?.requirement.id ?? ids.requirementId;
  const oraclePath = artifactPathForRole({
    role: "oracle",
    changeId: ids.changeId,
    oracleId: ids.oracleId
  });
  const manual = options.requirement?.manual ?? [];

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
          : manual.map(describeCriterion),
      evidence: ["Build and verification evidence is attached during legion build."]
    },
    // The operator's own criteria, not a restatement of the phase. "Phase N
    // acceptance criteria are satisfied" is not a criterion — it is the
    // question rephrased as its own answer, and it made every oracle
    // indistinguishable from every other.
    requirementCoverage: [
      {
        requirementId: coveredRequirementId,
        coverage: options.requirement === undefined ? "primary" : "partial",
        criteria:
          options.requirement === undefined
            ? [`Phase ${options.phase.number} acceptance criteria are satisfied.`]
            : manual.map(describeCriterion)
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

/**
 * Every oracle this phase needs, in write order.
 *
 * An executable criterion gets an oracle a runner can execute; the manual
 * criteria share one a reviewer decides. A phase with no manual criteria emits
 * no inspection oracle, and a project with no interview emits only the
 * inspection oracle — there are no criteria to derive commands from, and
 * inventing one would be the fabrication protocol 0.2.0 exists to prevent.
 */
export function buildOracleArtifactInputs(
  options: BuildOracleInputOptions
): readonly CreateOracleArtifactInput[] {
  const resolved = options.requirement;
  if (resolved === undefined) return [inspectionOracle(options)];

  const executable = executableOracles(options, resolved.executable);
  // A requirement whose criteria are all executable still needs somewhere for a
  // reviewer to land, but not a manufactured one: `legion review` reads the
  // inspection oracle when there is one, and the executable oracles carry the
  // decision when there is not.
  return resolved.manual.length === 0 && executable.length > 0
    ? executable
    : [...executable, inspectionOracle(options)];
}
