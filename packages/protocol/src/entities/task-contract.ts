import * as z from "zod";

import {
  changeIdSchema,
  contractIdSchema,
  oracleIdSchema,
  projectIdSchema,
  requirementIdSchema
} from "../primitives/ids.js";
import { artifactPathSchema, artifactReferenceSchema } from "../primitives/values.js";
import { riskProfileSchema, schemaMetadataSchema } from "./common.js";

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

export const taskContractScopeSchema = z.strictObject({
  read: z.array(artifactPathSchema),
  write: z.array(artifactPathSchema).min(1),
  forbidden: z.array(artifactPathSchema),
  sequentialFiles: z.array(artifactPathSchema)
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
