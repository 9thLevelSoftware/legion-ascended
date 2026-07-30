import {
  artifactPathForRole,
  type ChangeBundleSuccess,
  type OracleArtifactSuccess,
  type WriteTaskGraphInput
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  taskContractSchema,
  type ArtifactRevision,
  type ArtifactRole,
  type GitSha,
  type Project,
  type UtcTimestamp
} from "@legion/protocol";

import type { RequirementSetEnforcement } from "./intake/finalize.js";

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
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly change: ChangeBundleSuccess;
  readonly oracle: OracleArtifactSuccess;
  readonly baseGitSha: GitSha;
  readonly createdAt?: UtcTimestamp;
}

export function buildTaskGraphInput(options: BuildTaskGraphInputOptions): WriteTaskGraphInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const taskgraphPath = artifactPathForRole({ role: "taskgraph", changeId: ids.changeId });
  const designRevision = revisionForRole(options.change.bundle.artifactRevisions, "design");
  const artifactInputs = [options.change.revision, options.oracle.revision];
  const task = taskContractSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "task-contract",
    id: ids.contractId,
    projectId: options.project.id,
    changeId: ids.changeId,
    revision: 1,
    title: `Build phase ${options.phase.number}: ${options.phase.name}`,
    objective: `Implement and verify phase ${options.phase.number}: ${options.phase.name}.`,
    requirementIds: [ids.requirementId],
    wave: "A",
    // Bundle IDs from bundles/index.json. An agent with no worker bundle
    // cannot be dispatched, so these must name real bundles.
    agents: ["implementer"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [designRevision.artifact],
      predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
    },
    scope: {
      read: [options.change.artifactPath, options.oracle.artifactPath],
      // This task's objective is to implement the phase, so its write scope has
      // to be the implementation surface. It previously listed only the
      // taskgraph artifact, which made the contract impossible to satisfy: any
      // source edit was an out-of-scope write and every real build blocked. The
      // test suite could not see it because the `fake` executor writes nothing.
      //
      // The stub planner cannot name that surface yet, so scope is
      // repository-wide with a finite budget — the same trade `legion quick`
      // already makes when the caller cannot enumerate files in advance.
      // Phase D narrows this to the files a decomposed task actually touches.
      write: ["."],
      // `.legion/project` holds the control artifacts `review` and `ship`
      // reload after the executor runs, so a contract must not let the party it
      // constrains rewrite them. Harness run artifacts share the prefix but are
      // excluded from attribution before the forbidden check.
      forbidden: [".git", "node_modules", ".legion/project", ".legion/var/runtime.sqlite"],
      sequentialFiles: [],
      // The operator's chosen blast radius, not a repository-wide default. A
      // budget that is asked for and then ignored is worse than not asking:
      // they believe a limit is in force and nothing enforces it.
      budget: options.enforcement?.budget ?? budgetForWriteScope(["."])
    },
    interfaces: {
      consumes: [
        {
          name: "ChangeBundle",
          description: "The phase change bundle created by legion plan."
        },
        {
          name: "OracleArtifact",
          description: "The phase acceptance oracle created by legion plan."
        }
      ],
      produces: [
        {
          name: "BuildEvidence",
          description: "Implementation and verification evidence for the planned phase."
        }
      ]
    },
    oracleRefs: [ids.oracleId],
    // The project's own verification command when the interview recorded one.
    // `legion validate` alone is a tautology — it checks the artifacts this
    // command just wrote, not the code the task changed.
    verification: [
      options.enforcement === undefined
        ? { command: "legion", args: ["validate"], expectedExitCode: 0, timeoutMs: 120_000 }
        : {
            command: options.enforcement.verification.command,
            args: [...options.enforcement.verification.args],
            expectedExitCode: 0,
            timeoutMs: 600_000
          }
    ],
    risk: phaseRiskProfile(options.phase, options.enforcement?.risk),
    approvals: [],
    completion: {
      expectedArtifacts: [options.change.reference],
      requiredEvidence: ["legion validate verification output"],
      blockedConditions: ["Build evidence is missing or fails oracle review."],
      diffReconciliation: { required: true, allowUnlistedReads: true }
    }
  });

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    tasks: [task],
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
