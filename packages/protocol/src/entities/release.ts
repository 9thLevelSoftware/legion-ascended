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

/**
 * How a release is taken back.
 *
 * Extracted from the inline enum it used to be so that `legion release plan`
 * validates `--rollback-strategy` against the protocol rather than against a
 * hand-written list beside it. `attestationKindSchema.options` is the precedent:
 * a CLI list that drifts from the schema refuses a value the artifact would
 * accept, or accepts one it would not.
 */
export const releaseRollbackStrategySchema = z.enum(["revert", "disable", "restore", "manual"]);

export type ReleaseRollbackStrategy = z.infer<typeof releaseRollbackStrategySchema>;

export const releaseRollbackPlanSchema = z.strictObject({
  strategy: releaseRollbackStrategySchema,
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
  // **`taskRefs` and `healthCriteria` are deliberately not `.min(1)`, and the
  // gate does not inherit its truth claim from that.** `release_observation_plan`
  // requires at least one health criterion and coverage of every deriving task,
  // and it checks both itself — `[].every(...)` is `true`, so a quantifier over
  // either of these arrays is vacuous at zero length. Tightening the published
  // schema would change the shape of an entity for a check the gate and
  // `legion release plan` have to make anyway, and `attestationGateStatus` keeps
  // its own `sources.length === 0` guard for exactly this reason even though
  // `.min(1)` forbids it there.
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

export const releaseSchema = z
  .discriminatedUnion("status", [
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
  ])
  .superRefine((release, context) => {
    if (release.deployment && new Date(release.deployment.deployedAt).getTime() < new Date(release.createdAt).getTime()) {
      context.addIssue({
        code: "custom",
        message: "deployedAt cannot be before createdAt.",
        path: ["deployment", "deployedAt"]
      });
    }
  });

export type Release = z.infer<typeof releaseSchema>;
