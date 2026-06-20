import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import { decisionIdSchema, projectIdSchema } from "../primitives/ids.js";
import { artifactReferenceSchema, utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const decisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);

export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const decisionAlternativeSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "Invalid alternative ID"),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2_048),
  selected: z.boolean()
});

export type DecisionAlternative = z.infer<typeof decisionAlternativeSchema>;

const decisionBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("decision"),
  id: decisionIdSchema,
  projectId: projectIdSchema,
  title: z.string().min(1).max(160),
  context: z.string().min(1).max(4_096),
  alternatives: z.array(decisionAlternativeSchema).min(2),
  rationale: z.string().min(1).max(4_096),
  supersedes: z.array(decisionIdSchema),
  affectedArtifacts: z.array(artifactReferenceSchema).min(1),
  traceRefs: z.array(traceReferenceSchema).min(1)
});

export const decisionSchema = z
  .discriminatedUnion("status", [
    decisionBaseSchema.extend({
      status: z.literal("proposed"),
      approver: actorSchema.optional(),
      decidedAt: utcTimestampSchema.optional(),
      supersededBy: decisionIdSchema.optional()
    }),
    decisionBaseSchema.extend({
      status: z.literal("accepted"),
      approver: actorSchema,
      decidedAt: utcTimestampSchema,
      supersededBy: decisionIdSchema.optional()
    }),
    decisionBaseSchema.extend({
      status: z.literal("rejected"),
      approver: actorSchema,
      decidedAt: utcTimestampSchema,
      supersededBy: decisionIdSchema.optional()
    }),
    decisionBaseSchema.extend({
      status: z.literal("superseded"),
      approver: actorSchema,
      decidedAt: utcTimestampSchema,
      supersededBy: decisionIdSchema
    })
  ])
  .superRefine((decision, context) => {
    const selectedCount = decision.alternatives.filter((alternative) => alternative.selected).length;

    if (decision.status === "accepted" && selectedCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "Accepted decisions must have exactly one selected alternative.",
        path: ["alternatives"]
      });
    }

    if (decision.status === "proposed" && selectedCount > 1) {
      context.addIssue({
        code: "custom",
        message: "Proposed decisions cannot have more than one selected alternative.",
        path: ["alternatives"]
      });
    }
  });

export type Decision = z.infer<typeof decisionSchema>;
