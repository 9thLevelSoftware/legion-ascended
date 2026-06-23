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

export interface BuildOracleInputOptions {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly change: ChangeBundleSuccess;
  readonly baseGitSha: GitSha;
  readonly createdAt?: UtcTimestamp;
}

export function buildOracleArtifactInput(options: BuildOracleInputOptions): CreateOracleArtifactInput {
  const ids = phasePlanIds(options.phase);
  const createdAt = options.createdAt ?? currentUtcTimestamp();
  const owner = firstDecisionOwner(options.project);
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
      postconditions: [`Phase ${options.phase.number} build evidence addresses ${options.phase.name}.`],
      evidence: ["Build and verification evidence is attached during legion build."]
    },
    requirementCoverage: [
      {
        requirementId: ids.requirementId,
        coverage: "primary",
        criteria: [`Phase ${options.phase.number} acceptance criteria are satisfied.`]
      }
    ],
    traceRefs: [
      {
        path: oraclePath,
        anchor: ids.oracleId,
        relation: "verifies",
        entity: { kind: "requirement", id: ids.requirementId }
      }
    ],
    type: "inspectable",
    execution: {
      mode: "manual-inspection",
      instructions: `Review implementation and evidence for phase ${options.phase.number}: ${options.phase.name}.`
    }
  });

  return {
    repositoryRoot: options.repositoryRoot,
    changeId: ids.changeId,
    oracle,
    baseGitSha: options.baseGitSha
  };
}
