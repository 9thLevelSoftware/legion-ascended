import * as z from "zod";

import {
  changeIdSchema,
  contractIdSchema,
  oracleIdSchema,
  projectIdSchema,
  requirementIdSchema
} from "../primitives/ids.js";
import { artifactPathSchema, artifactReferenceSchema, type ArtifactReference } from "../primitives/values.js";
import { riskProfileSchema, schemaMetadataSchema } from "./common.js";

const taskContractAgentIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid agent ID");
const taskContractWaveIdSchema = z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/, "Invalid wave ID");

export const TASK_CONTRACT_LEGACY_WAVE = "LEGACY";
export const TASK_CONTRACT_LEGACY_AGENT = "legacy-agent";

export const taskContractDependencySchema = z.strictObject({
  contractId: contractIdSchema,
  revision: z.number().int().positive().optional(),
  reason: z.string().min(1).max(1_024).optional()
});

export type TaskContractDependency = z.infer<typeof taskContractDependencySchema>;

export const taskContractContextSchema = z.strictObject({
  specRefs: z.array(artifactReferenceSchema),
  designRefs: z.array(artifactReferenceSchema),
  predecessorArtifacts: z.array(artifactReferenceSchema)
});

export type TaskContractContext = z.infer<typeof taskContractContextSchema>;

export const taskContractScopePathSchema = z.union([artifactPathSchema, z.literal(".")]);

export const taskContractScopeSchema = z.strictObject({
  read: z.array(taskContractScopePathSchema),
  write: z.array(taskContractScopePathSchema).min(1),
  forbidden: z.array(taskContractScopePathSchema),
  sequentialFiles: z.array(taskContractScopePathSchema)
});

export type TaskContractScope = z.infer<typeof taskContractScopeSchema>;

export const taskContractInterfaceSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/, "Invalid interface name"),
  description: z.string().min(1).max(1_024)
});

export type TaskContractInterface = z.infer<typeof taskContractInterfaceSchema>;

export const taskContractInterfacesSchema = z.strictObject({
  consumes: z.array(taskContractInterfaceSchema),
  produces: z.array(taskContractInterfaceSchema).min(1)
});

export type TaskContractInterfaces = z.infer<typeof taskContractInterfacesSchema>;

export const taskContractVerificationSchema = z.strictObject({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(256)).max(64),
  expectedExitCode: z.number().int().min(0).max(255),
  timeoutMs: z.number().int().positive().max(3_600_000).optional()
});

export type TaskContractVerification = z.infer<typeof taskContractVerificationSchema>;

export const taskContractCompletionSchema = z.strictObject({
  expectedArtifacts: z.array(artifactReferenceSchema),
  requiredEvidence: z.array(z.string().min(1).max(128)).min(1),
  blockedConditions: z.array(z.string().min(1).max(1_024)).min(1)
});

export type TaskContractCompletion = z.infer<typeof taskContractCompletionSchema>;

export interface TaskContractPreflightContext {
  readonly availableContracts?: readonly TaskContractDependency[];
  readonly availableAgents?: readonly string[];
  readonly availableArtifacts?: readonly ArtifactReference[];
}

export type TaskContractPreflightIssueCode =
  | "dependency_unsatisfied"
  | "resource_unavailable"
  | "contract_incomplete";

export interface TaskContractPreflightIssue {
  readonly code: TaskContractPreflightIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export interface TaskContractPreflightSuccess {
  readonly ok: true;
  readonly taskContract: TaskContract;
  readonly issues: readonly [];
}

export interface TaskContractPreflightFailure {
  readonly ok: false;
  readonly taskContract: TaskContract;
  readonly issues: readonly TaskContractPreflightIssue[];
}

export type TaskContractPreflightResult = TaskContractPreflightSuccess | TaskContractPreflightFailure;

function referenceKey(reference: ArtifactReference): string {
  return `${reference.path}|${reference.sha256}`;
}

export function preflightTaskContract(
  taskContract: TaskContract,
  context: TaskContractPreflightContext = {}
): TaskContractPreflightResult {
  const issues: TaskContractPreflightIssue[] = [];
  const availableContractIds = new Map<string, number | undefined>();
  for (const contract of context.availableContracts ?? []) {
    availableContractIds.set(contract.contractId, contract.revision);
  }
  const availableAgentIds = new Set(context.availableAgents ?? []);
  const availableArtifactKeys = new Set((context.availableArtifacts ?? []).map(referenceKey));

  for (const [index, dependency] of taskContract.dependencies.entries()) {
    const revision = availableContractIds.get(dependency.contractId);
    const revisionSatisfied = dependency.revision === undefined || revision === dependency.revision;
    if (!availableContractIds.has(dependency.contractId) || !revisionSatisfied) {
      const revisionText = dependency.revision === undefined ? "" : ` revision ${dependency.revision}`;
      issues.push({
        code: "dependency_unsatisfied",
        message: `Dependency ${dependency.contractId}${revisionText} is not available for execution.`,
        path: ["dependencies", index]
      });
    }
  }

  for (const [index, agentId] of taskContract.agents.entries()) {
    if (!availableAgentIds.has(agentId)) {
      issues.push({
        code: "resource_unavailable",
        message: `Agent resource ${agentId} is not available for execution.`,
        path: ["agents", index]
      });
    }
  }

  for (const [index, predecessorArtifact] of taskContract.context.predecessorArtifacts.entries()) {
    if (!availableArtifactKeys.has(referenceKey(predecessorArtifact))) {
      issues.push({
        code: "dependency_unsatisfied",
        message: `Predecessor artifact ${predecessorArtifact.path} is not available for execution.`,
        path: ["context", "predecessorArtifacts", index]
      });
    }
  }

  if (
    taskContract.context.specRefs.length === 0 &&
    taskContract.context.designRefs.length === 0 &&
    taskContract.context.predecessorArtifacts.length === 0
  ) {
    issues.push({
      code: "contract_incomplete",
      message: "Task contract context must include at least one source, design, or predecessor artifact reference.",
      path: ["context"]
    });
  }

  if (taskContract.completion.expectedArtifacts.length === 0) {
    issues.push({
      code: "contract_incomplete",
      message: "Task contract completion must declare at least one expected artifact.",
      path: ["completion", "expectedArtifacts"]
    });
  }

  return issues.length === 0
    ? { ok: true, taskContract, issues: [] }
    : { ok: false, taskContract, issues };
}

export const taskContractSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("task-contract"),
    id: contractIdSchema,
    projectId: projectIdSchema,
    changeId: changeIdSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(4_096),
    requirementIds: z.array(requirementIdSchema).min(1),
    wave: taskContractWaveIdSchema.optional().default(TASK_CONTRACT_LEGACY_WAVE),
    agents: z.array(taskContractAgentIdSchema).min(1).optional().default([TASK_CONTRACT_LEGACY_AGENT]),
    dependencies: z.array(taskContractDependencySchema),
    context: taskContractContextSchema,
    scope: taskContractScopeSchema,
    interfaces: taskContractInterfacesSchema,
    oracleRefs: z.array(oracleIdSchema).min(1),
    verification: z.array(taskContractVerificationSchema).min(1),
    risk: riskProfileSchema,
    approvals: z.array(z.string().min(1).max(128)),
    completion: taskContractCompletionSchema
  })
  .superRefine((taskContract, context) => {
    const forbidden = new Set(taskContract.scope.forbidden);
    const seenAgents = new Map<string, number>();

    for (const [index, agentId] of taskContract.agents.entries()) {
      const previousIndex = seenAgents.get(agentId);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Task contract agent assignments must be unique.",
          path: ["agents", index]
        });
      } else {
        seenAgents.set(agentId, index);
      }
    }

    for (const [index, writePath] of taskContract.scope.write.entries()) {
      if (forbidden.has(writePath)) {
        context.addIssue({
          code: "custom",
          message: "Task contract write scope cannot overlap forbidden scope.",
          path: ["scope", "write", index]
        });
      }
    }
  });

export type TaskContract = z.infer<typeof taskContractSchema>;
