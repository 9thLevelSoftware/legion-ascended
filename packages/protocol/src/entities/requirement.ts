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

export const requirementAcceptanceSchema = z.strictObject({
  language: z.string().min(1).max(2_048),
  criteria: z.array(z.string().min(1).max(1_024)).min(1),
  oracleRefs: z.array(oracleIdSchema)
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
