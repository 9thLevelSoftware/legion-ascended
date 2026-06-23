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

import { currentUtcTimestamp, phasePlanIds, phaseRiskProfile } from "./change-input.js";
import type { PhaseSource } from "./phase-compat.js";

export interface BuildTaskGraphInputOptions {
  readonly repositoryRoot: string;
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
    agents: ["taskgraph-planner"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [designRevision.artifact],
      predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
    },
    scope: {
      read: [options.change.artifactPath, options.oracle.artifactPath],
      write: [taskgraphPath],
      forbidden: [".legion/var/runtime.sqlite"],
      sequentialFiles: [taskgraphPath]
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
    verification: [
      {
        command: "legion",
        args: ["validate"],
        expectedExitCode: 0,
        timeoutMs: 120_000
      }
    ],
    risk: phaseRiskProfile(options.phase),
    approvals: [],
    completion: {
      expectedArtifacts: [options.change.reference],
      requiredEvidence: ["legion validate verification output"],
      blockedConditions: ["Build evidence is missing or fails oracle review."]
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
