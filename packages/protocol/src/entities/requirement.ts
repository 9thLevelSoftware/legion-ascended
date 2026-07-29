import * as z from "zod";

import { oracleIdSchema, projectIdSchema, requirementIdSchema } from "../primitives/ids.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const requirementCategorySchema = z.enum([
  "behavior",
  "constraint",
  "compatibility",
  "security",
  "migration",
  "quality",
  "documentation"
]);

export type RequirementCategory = z.infer<typeof requirementCategorySchema>;

export const requirementPrioritySchema = z.enum(["must", "should", "could", "wont"]);

export type RequirementPriority = z.infer<typeof requirementPrioritySchema>;

export const requirementStatusSchema = z.enum(["draft", "proposed", "accepted", "superseded", "rejected", "archived"]);

export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

/**
 * How a single acceptance criterion is proven.
 *
 * `executable` carries the command that decides it, so a runner — not a
 * reviewer's judgement — determines whether the criterion holds. `manual`
 * exists because some criteria genuinely cannot be scripted, but it must say
 * why, so that unscriptable criteria are a visible, countable choice rather
 * than the silent default.
 */
export const requirementCriterionProofSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("executable"),
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(256)).max(64),
    expectedExitCode: z.number().int().min(0).max(255),
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  }),
  z.strictObject({
    mode: z.literal("manual"),
    reason: z.string().min(1).max(1_024)
  })
]);

export type RequirementCriterionProof = z.infer<typeof requirementCriterionProofSchema>;

export const requirementCriterionIdSchema = z
  .string()
  .regex(/^ac_[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, "Invalid acceptance criterion ID");

export const requirementCriterionSchema = z.strictObject({
  id: requirementCriterionIdSchema,
  statement: z.string().min(1).max(1_024),
  proof: requirementCriterionProofSchema,
  oracleRef: oracleIdSchema.optional()
});

export type RequirementCriterion = z.infer<typeof requirementCriterionSchema>;

export const requirementAcceptanceSchema = z
  .strictObject({
    language: z.string().min(1).max(2_048),
    criteria: z.array(requirementCriterionSchema).min(1),
    oracleRefs: z.array(oracleIdSchema)
  })
  .superRefine((acceptance, context) => {
    const seen = new Map<string, number>();
    for (const [index, criterion] of acceptance.criteria.entries()) {
      const previous = seen.get(criterion.id);
      if (previous === undefined) {
        seen.set(criterion.id, index);
        continue;
      }
      context.addIssue({
        code: "custom",
        message: "Acceptance criterion IDs must be unique within a requirement.",
        path: ["criteria", index, "id"]
      });
    }
  });

export type RequirementAcceptance = z.infer<typeof requirementAcceptanceSchema>;

const requirementBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("requirement"),
  id: requirementIdSchema,
  projectId: projectIdSchema,
  priority: requirementPrioritySchema,
  category: requirementCategorySchema,
  statement: z.string().min(1).max(2_048),
  acceptance: requirementAcceptanceSchema,
  traceRefs: z.array(traceReferenceSchema).min(1),
  supersedes: z.array(requirementIdSchema)
});

export const requirementSchema = z.discriminatedUnion("status", [
  requirementBaseSchema.extend({
    status: z.literal("draft"),
    supersededBy: requirementIdSchema.optional()
  }),
  requirementBaseSchema.extend({
    status: z.literal("proposed"),
    supersededBy: requirementIdSchema.optional()
  }),
  requirementBaseSchema.extend({
    status: z.literal("accepted"),
    supersededBy: requirementIdSchema.optional()
  }),
  requirementBaseSchema.extend({
    status: z.literal("superseded"),
    supersededBy: requirementIdSchema
  }),
  requirementBaseSchema.extend({
    status: z.literal("rejected"),
    supersededBy: requirementIdSchema.optional()
  }),
  requirementBaseSchema.extend({
    status: z.literal("archived"),
    supersededBy: requirementIdSchema.optional()
  })
]);

export type Requirement = z.infer<typeof requirementSchema>;
