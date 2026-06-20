import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import {
  approvalIdSchema,
  changeIdSchema,
  evidenceIdSchema,
  projectIdSchema,
  releaseIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import { artifactReferenceSchema, utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

export const releaseStatusSchema = z.enum([
  "requested",
  "staging",
  "deployed",
  "healthy",
  "failed",
  "rollback_required",
  "rolled_back",
  "forward_fix_required",
  "superseded"
]);

export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const releaseEnvironmentSchema = z.enum(["local", "test", "staging", "production"]);

export type ReleaseEnvironment = z.infer<typeof releaseEnvironmentSchema>;

export const releaseDeploymentSchema = z.strictObject({
  environment: releaseEnvironmentSchema,
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/, "Invalid deployment ID"),
  deployedAt: utcTimestampSchema
});

export type ReleaseDeployment = z.infer<typeof releaseDeploymentSchema>;

export const releaseRollbackPlanSchema = z.strictObject({
  strategy: z.enum(["revert", "disable", "restore", "manual"]),
  criteria: z.array(z.string().min(1).max(1_024)).min(1),
  evidenceRefs: z.array(evidenceIdSchema)
});

export type ReleaseRollbackPlan = z.infer<typeof releaseRollbackPlanSchema>;

export const releaseForwardFixPlanSchema = z.strictObject({
  owner: actorSchema,
  criteria: z.array(z.string().min(1).max(1_024)).min(1),
  taskRefs: z.array(taskIdSchema).min(1)
});

export type ReleaseForwardFixPlan = z.infer<typeof releaseForwardFixPlanSchema>;

const releaseBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("release"),
  id: releaseIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  environment: releaseEnvironmentSchema,
  releaseIntent: artifactReferenceSchema,
  deployment: releaseDeploymentSchema.optional(),
  taskRefs: z.array(taskIdSchema),
  approvalRefs: z.array(approvalIdSchema),
  evidenceRefs: z.array(evidenceIdSchema),
  healthCriteria: z.array(z.string().min(1).max(1_024)),
  rollbackPlan: releaseRollbackPlanSchema
});

const releaseOpenLoopFields = {
  forwardFixPlan: releaseForwardFixPlanSchema.optional(),
  rollbackEvidenceRefs: z.array(evidenceIdSchema).optional()
};

export const releaseSchema = z.discriminatedUnion("status", [
  releaseBaseSchema.extend({
    status: z.literal("requested"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("staging"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("deployed"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("healthy"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("failed"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("rollback_required"),
    ...releaseOpenLoopFields
  }),
  releaseBaseSchema.extend({
    status: z.literal("rolled_back"),
    forwardFixPlan: releaseForwardFixPlanSchema.optional(),
    rollbackEvidenceRefs: z.array(evidenceIdSchema).min(1)
  }),
  releaseBaseSchema.extend({
    status: z.literal("forward_fix_required"),
    forwardFixPlan: releaseForwardFixPlanSchema,
    rollbackEvidenceRefs: z.array(evidenceIdSchema).optional()
  }),
  releaseBaseSchema.extend({
    status: z.literal("superseded"),
    ...releaseOpenLoopFields
  })
]);

export type Release = z.infer<typeof releaseSchema>;
