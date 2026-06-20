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

export const decisionSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("decision"),
    id: decisionIdSchema,
    projectId: projectIdSchema,
    status: decisionStatusSchema,
    title: z.string().min(1).max(160),
    context: z.string().min(1).max(4_096),
    alternatives: z.array(decisionAlternativeSchema).min(2),
    rationale: z.string().min(1).max(4_096),
    approver: actorSchema.optional(),
    decidedAt: utcTimestampSchema.optional(),
    supersedes: z.array(decisionIdSchema),
    supersededBy: decisionIdSchema.optional(),
    affectedArtifacts: z.array(artifactReferenceSchema).min(1),
    traceRefs: z.array(traceReferenceSchema).min(1)
  })
  .superRefine((decision, context) => {
    if (decision.status !== "proposed" && decision.approver === undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-proposed decisions require an approver.",
        path: ["approver"]
      });
    }

    if (decision.status !== "proposed" && decision.decidedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-proposed decisions require a decision timestamp.",
        path: ["decidedAt"]
      });
    }

    if (decision.status === "superseded" && decision.supersededBy === undefined) {
      context.addIssue({
        code: "custom",
        message: "Superseded decisions require a replacement decision reference.",
        path: ["supersededBy"]
      });
    }
  });

export type Decision = z.infer<typeof decisionSchema>;
