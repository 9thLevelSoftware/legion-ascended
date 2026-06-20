import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import { changeIdSchema, evidenceIdSchema, projectIdSchema, reviewIdSchema, runIdSchema, taskIdSchema } from "../primitives/ids.js";
import { utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const reviewStatusSchema = z.enum(["requested", "submitted", "accepted", "rejected", "superseded", "unknown"]);

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewVerdictSchema = z.enum(["pass", "fail", "unknown", "not_verified", "not_applicable"]);

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const reviewFindingSeveritySchema = z.enum(["minor", "major", "blocking"]);

export type ReviewFindingSeverity = z.infer<typeof reviewFindingSeveritySchema>;

export const reviewVerdictsSchema = z.strictObject({
  specification: reviewVerdictSchema,
  integration: reviewVerdictSchema,
  evidence: reviewVerdictSchema
});

export type ReviewVerdicts = z.infer<typeof reviewVerdictsSchema>;

const reviewFindingBaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/, "Invalid review finding ID"),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(4_096)
});

export const reviewFindingSchema = z.discriminatedUnion("severity", [
  reviewFindingBaseSchema.extend({
    severity: z.literal("minor"),
    evidenceRefs: z.array(evidenceIdSchema).optional()
  }),
  reviewFindingBaseSchema.extend({
    severity: z.literal("major"),
    evidenceRefs: z.array(evidenceIdSchema).optional()
  }),
  reviewFindingBaseSchema.extend({
    severity: z.literal("blocking"),
    evidenceRefs: z.array(evidenceIdSchema).min(1)
  })
]);

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewDecisionSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("review"),
    id: reviewIdSchema,
    projectId: projectIdSchema,
    changeId: changeIdSchema,
    taskId: taskIdSchema.optional(),
    runId: runIdSchema.optional(),
    status: reviewStatusSchema,
    reviewer: actorSchema,
    submittedAt: utcTimestampSchema.optional(),
    verdicts: reviewVerdictsSchema,
    confidence: z.enum(["low", "medium", "high"]),
    findings: z.array(reviewFindingSchema),
    supersedes: z.array(reviewIdSchema),
    evidenceRefs: z.array(evidenceIdSchema).optional(),
    traceRefs: z.array(traceReferenceSchema).optional()
  })
  .superRefine((reviewDecision, context) => {
    if (reviewDecision.status === "submitted" && !reviewDecision.submittedAt) {
      context.addIssue({
        code: "custom",
        message: "Submitted reviews require submittedAt.",
        path: ["submittedAt"]
      });
    }
  });

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
