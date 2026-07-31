import {
  artifactPathForRole,
  type ChangeBundleSuccess,
  type OracleArtifactSuccess,
  type WriteTaskGraphInput
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  formatEntityId,
  taskContractSchema,
  type ArtifactRevision,
  type ArtifactRole,
  type ContractId,
  type GitSha,
  type Project,
  type TaskContractScopeBudget,
  type UtcTimestamp
} from "@legion/protocol";

import type { RequirementSetEnforcement } from "./intake/finalize.js";
import {
  describeCriterion,
  type ExecutableCriterion,
  type ResolvedPhaseRequirement
} from "./phase-requirement.js";

import { budgetForWriteScope } from "./budget.js";
import { currentUtcTimestamp, phasePlanIds, phaseRiskProfile } from "./change-input.js";
import type { PhaseSource } from "./phase-compat.js";

export interface BuildTaskGraphInputOptions {
  readonly repositoryRoot: string;
  /**
   * The enforcement settings the intake interview recorded, when there was one.
   *
   * Absent for a project initialized with `--name`, which held no interview and
   * therefore chose no limits; the repository-wide fallback applies then.
   */
  readonly enforcement?: RequirementSetEnforcement;
  /** The requirement this phase was rendered from, when the roadmap names one. */
  readonly requirement?: ResolvedPhaseRequirement;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly change: ChangeBundleSuccess;
  readonly oracles: readonly OracleArtifactSuccess[];
  readonly baseGitSha: GitSha;
  readonly createdAt?: UtcTimestamp;
}

/**
 * What the task has to run to be believed.
 *
 * The requirement's own executable criteria come first: they are what the
 * operator said decides this requirement, and a task that verified only the
 * project-wide command would prove nothing broke rather than that the
 * requirement holds. The project command follows as a regression check.
 *
 * Manual criteria are deliberately absent — they cannot be run, and inventing a
 * command for one would be the fabrication protocol 0.2.0 exists to prevent.
 * The oracle names them for a reviewer instead.
 *
 * Exported for direct testing: the intake graph pins every criterion to exit 0,
 * so the case where a criterion and the project command differ only in expected
 * exit code is unreachable through an interview and can only be exercised here.
 * A test that drove this through intake would pass whether or not the exit code
 * were part of the identity, which is no test at all.
 */
export interface TaskVerification {
  readonly command: string;
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly timeoutMs: number;
}

export function phaseVerification(
  options: BuildTaskGraphInputOptions,
  // The criteria this particular task proves. A decomposed task runs the one
  // criterion it exists for, not every criterion of the requirement — running
  // them all in each task would report the same proof once per task and make a
  // task that changed nothing relevant fail on somebody else's criterion.
  scoped: readonly ExecutableCriterion[] = options.requirement?.executable ?? []
): readonly TaskVerification[] {
  // `executable` is narrowed by `partitionCriteria`, so no runtime re-check is needed.
  const criteria = scoped.map((criterion) => ({
    command: criterion.proof.command,
    args: [...criterion.proof.args],
    expectedExitCode: criterion.proof.expectedExitCode,
    timeoutMs: criterion.proof.timeoutMs ?? 600_000
  }));

  const project =
    options.enforcement === undefined
      ? { command: "legion", args: ["validate"], expectedExitCode: 0, timeoutMs: 120_000 }
      : {
          command: options.enforcement.verification.command,
          args: [...options.enforcement.verification.args],
          expectedExitCode: 0,
          timeoutMs: 600_000
        };

  // De-duplicated: an operator whose criterion command is also the project
  // command should not have it run twice and reported as two proofs.
  //
  // The expected exit code is part of the identity. Without it, a criterion
  // asserting `pnpm test` exits 1 would suppress the project check asserting it
  // exits 0 — so a failing regression suite would satisfy the task, which is the
  // opposite of what adding project verification was for.
  // Keyed on the whole entry, not an enumerated subset of its fields.
  //
  // This key has now been wrong three times: it ignored the expected exit code,
  // then flattened argument boundaries, then ignored the timeout — each a field
  // the runner acts on that the identity had quietly excluded. Every fix added
  // one more field and left the next one out. Two verification entries are the
  // same proof exactly when they are the same entry, so that is what it compares.
  const key = (entry: TaskVerification) =>
    JSON.stringify({ ...entry, args: [...entry.args] }, Object.keys(entry).sort());
  const seen = new Set(criteria.map(key));
  return seen.has(key(project)) ? criteria : [...criteria, project];
}

/**
 * The work a single task exists to do.
 *
 * One unit per executable acceptance criterion, plus one for the criteria no
 * command can decide. That grouping is the only decomposition the CLI can make
 * honestly: the operator said which criteria decide this requirement, so each
 * one is a coherent piece of work with its own proof. Splitting by file or by
 * component would need a mapping nobody supplied.
 */
interface TaskUnit {
  readonly contractId: ContractId;
  readonly oracleId: string;
  readonly title: string;
  readonly objective: string;
  readonly criteria: readonly ExecutableCriterion[];
}

/** `slugSuffixSchema` accepts at most 64 characters. */
const MAX_ID_SUFFIX = 64;

function contractIdWithRoom(suffix: string, tail: string): ContractId {
  const base =
    suffix.length + tail.length <= MAX_ID_SUFFIX
      ? suffix
      : suffix.slice(0, MAX_ID_SUFFIX - tail.length).replace(/-+$/, "");
  return formatEntityId("contract", `${base}${tail}`) as ContractId;
}

/**
 * Divide the operator's blast radius across the tasks that share it.
 *
 * The budget is the limit they chose for the phase, and it is enforced per
 * task. Giving every task the full figure would let a three-task phase change
 * three times what was agreed to — each task inside the limit and the phase well
 * outside it. A budget that is asked for and then multiplied is no better than
 * one that is ignored.
 *
 * Rounded up, and never below one file: a task permitted to change no files
 * cannot be satisfied at all.
 */
function shareOfBudget(budget: TaskContractScopeBudget, tasks: number): TaskContractScopeBudget {
  if (tasks <= 1) return budget;
  const share = (value: number, floor: number) => Math.max(Math.ceil(value / tasks), floor);
  const maxFilesChanged = share(budget.maxFilesChanged, 1);
  return {
    maxFilesChanged,
    maxLinesChanged: share(budget.maxLinesChanged, 1),
    // `maxNewFiles` may legitimately be zero, and the schema refuses a value
    // above `maxFilesChanged`.
    maxNewFiles: Math.min(share(budget.maxNewFiles, 0), maxFilesChanged)
  };
}

/**
 * Split the phase into the tasks its acceptance criteria describe.
 *
 * A project with no interviewed requirement keeps the single task it always
 * had: there are no criteria to divide, and manufacturing a decomposition from
 * the phase heading would be the fabrication protocol 0.2.0 exists to prevent.
 */
function taskUnits(options: BuildTaskGraphInputOptions): readonly TaskUnit[] {
  const ids = phasePlanIds(options.phase);
  const resolved = options.requirement;
  const oracleIds = options.oracles.map((entry) => entry.document.id);

  if (resolved === undefined || oracleIds.length === 0) {
    return [
      {
        contractId: ids.contractId,
        oracleId: oracleIds[0] ?? ids.oracleId,
        title: `Build phase ${options.phase.number}: ${options.phase.name}`,
        objective: `Implement and verify phase ${options.phase.number}: ${options.phase.name}.`,
        criteria: []
      }
    ];
  }

  // `buildOracleArtifactInputs` writes the executable oracles first and the
  // inspection oracle last, so positions line up with the criteria they prove.
  const units: TaskUnit[] = resolved.executable.map((criterion, index) => ({
    contractId: contractIdWithRoom(ids.suffix, `-c${index + 1}`),
    oracleId: oracleIds[index] ?? ids.oracleId,
    title: `Satisfy acceptance criterion ${index + 1} of ${resolved.requirement.id}`,
    objective: describeCriterion(criterion),
    criteria: [criterion]
  }));

  if (resolved.manual.length > 0) {
    units.push({
      contractId: ids.contractId,
      oracleId: ids.oracleId,
      title: `Satisfy the reviewed criteria of ${resolved.requirement.id}`,
      // No criterion command to run: this task is decided by the inspection
      // oracle, and its verification is the project's own regression check.
      objective: `Implement the criteria of ${resolved.requirement.id} that a reviewer decides.`,
      criteria: []
    });
  }

  return units;
}

export function buildTaskGraphInput(options: BuildTaskGraphInputOptions): WriteTaskGraphInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const designRevision = revisionForRole(options.change.bundle.artifactRevisions, "design");
  const artifactInputs = [options.change.revision, ...options.oracles.map((entry) => entry.revision)];
  const units = taskUnits(options);
  const budget = shareOfBudget(
    options.enforcement?.budget ?? budgetForWriteScope(["."]),
    units.length
  );

  const tasks = units.map((unit) =>
    taskContractSchema.parse({
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "task-contract",
      id: unit.contractId,
      projectId: options.project.id,
      changeId: ids.changeId,
      revision: 1,
      title: unit.title,
      objective: unit.objective,
      // The requirement the interview wrote, so the contract traces to something
      // the operator actually agreed to rather than to a stub minted from the
      // phase heading.
      requirementIds: [options.requirement?.requirement.id ?? ids.requirementId],
      wave: "A",
      // Bundle IDs from bundles/index.json. An agent with no worker bundle
      // cannot be dispatched, so these must name real bundles.
      agents: ["implementer"],
      // Independent by construction: each task proves a different criterion of
      // the same requirement, and nothing in the criteria states an order.
      // Asserting a chain the operator did not describe would serialize work
      // that can run together.
      dependencies: [],
      context: {
        specRefs: [],
        designRefs: [designRevision.artifact],
        predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
      },
      scope: {
        read: [options.change.artifactPath, ...options.oracles.map((entry) => entry.artifactPath)],
        // This task's objective is to implement the phase, so its write scope has
        // to be the implementation surface. It previously listed only the
        // taskgraph artifact, which made the contract impossible to satisfy: any
        // source edit was an out-of-scope write and every real build blocked. The
        // test suite could not see it because the `fake` executor writes nothing.
        //
        // Still repository-wide with a finite budget. Decomposing by criterion
        // does not tell the CLI which files a criterion touches, and the plan's
        // answer for that — an executor proposing scope in a planning mode, the
        // CLI validating it, the human confirming — is separate work. Narrowing
        // by guesswork would block real builds on a boundary nobody drew.
        write: ["."],
        // `.legion/project` holds the control artifacts `review` and `ship`
        // reload after the executor runs, so a contract must not let the party it
        // constrains rewrite them. Harness run artifacts share the prefix but are
        // excluded from attribution before the forbidden check.
        forbidden: [".git", "node_modules", ".legion/project", ".legion/var/runtime.sqlite"],
        sequentialFiles: [],
        // The operator's chosen blast radius, divided across the tasks that
        // share it. A budget that is asked for and then ignored is worse than
        // not asking: they believe a limit is in force and nothing enforces it.
        budget
      },
      interfaces: {
        consumes: [
          {
            name: "ChangeBundle",
            description: "The phase change bundle created by legion plan."
          },
          {
            name: "OracleArtifact",
            description: "The acceptance oracle this task is decided by."
          }
        ],
        produces: [
          {
            name: "BuildEvidence",
            description: "Implementation and verification evidence for the planned phase."
          }
        ]
      },
      // The one oracle that decides this task. Every task naming every oracle
      // would make each claim to prove criteria it does not run, and leave the
      // evidence unable to say which criterion a given run decided.
      oracleRefs: [unit.oracleId],
      // The task's own criterion, plus the project's verification command as a
      // regression check. `legion validate` alone is a tautology — it checks the
      // artifacts this command just wrote, not the code the task changed.
      verification: phaseVerification(options, unit.criteria),
      risk: phaseRiskProfile(options.phase, options.enforcement?.risk),
      approvals: [],
      completion: {
        expectedArtifacts: [options.change.reference],
        requiredEvidence: ["legion validate verification output"],
        blockedConditions: ["Build evidence is missing or fails oracle review."],
        diffReconciliation: { required: true, allowUnlistedReads: true }
      }
    })
  );

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    tasks,
    artifactInputs,
    baseGitSha: options.baseGitSha
  };
}

function revisionForRole(
  revisions: readonly ArtifactRevision[],
  role: ArtifactRole
): ArtifactRevision {
  const revision = revisions.find((entry) => entry.role === role);
  if (revision === undefined) {
    throw new Error(`Change bundle is missing a ${role} artifact revision.`);
  }
  return revision;
}
