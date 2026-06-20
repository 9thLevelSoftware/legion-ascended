import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import {
  approvalIdSchema,
  changeIdSchema,
  contractIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  observationIdSchema,
  oracleIdSchema,
  projectIdSchema,
  releaseIdSchema,
  requirementIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import { idempotencyKeySchema, utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

export const approvalStatusSchema = z.enum(["requested", "granted", "denied", "expired", "revoked"]);

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalTargetReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), id: projectIdSchema }),
  z.strictObject({ kind: z.literal("change"), id: changeIdSchema }),
  z.strictObject({ kind: z.literal("requirement"), id: requirementIdSchema }),
  z.strictObject({ kind: z.literal("decision"), id: decisionIdSchema }),
  z.strictObject({ kind: z.literal("oracle"), id: oracleIdSchema }),
  z.strictObject({ kind: z.literal("contract"), id: contractIdSchema }),
  z.strictObject({ kind: z.literal("task"), id: taskIdSchema }),
  z.strictObject({ kind: z.literal("run"), id: runIdSchema }),
  z.strictObject({ kind: z.literal("evidence"), id: evidenceIdSchema }),
  z.strictObject({ kind: z.literal("review"), id: reviewIdSchema }),
  z.strictObject({ kind: z.literal("approval"), id: approvalIdSchema }),
  z.strictObject({ kind: z.literal("release"), id: releaseIdSchema }),
  z.strictObject({ kind: z.literal("observation"), id: observationIdSchema })
]);

export type ApprovalTargetReference = z.infer<typeof approvalTargetReferenceSchema>;

export const approvalScopeSchema = z.strictObject({
  effectClass: z.enum(["S0", "S1", "S2", "S3", "S4"]),
  action: z.string().regex(/^[a-z][a-z0-9._:-]{1,127}$/, "Invalid approval action"),
  targets: z.array(approvalTargetReferenceSchema).min(1)
});

export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

const approvalBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("approval"),
  id: approvalIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  requestedBy: actorSchema,
  requestedAt: utcTimestampSchema,
  scope: approvalScopeSchema,
  idempotencyKey: idempotencyKeySchema,
  expiresAt: utcTimestampSchema.optional()
});

const undecidedApprovalFields = {
  decidedBy: actorSchema.optional(),
  decidedAt: utcTimestampSchema.optional(),
  decisionReason: z.string().min(1).max(2_048).optional()
};

const decidedApprovalFields = {
  decidedBy: actorSchema,
  decidedAt: utcTimestampSchema,
  decisionReason: z.string().min(1).max(2_048)
};

export const approvalSchema = z
  .discriminatedUnion("status", [
    approvalBaseSchema.extend({
      status: z.literal("requested"),
      ...undecidedApprovalFields
    }),
    approvalBaseSchema.extend({
      status: z.literal("granted"),
      ...decidedApprovalFields
    }),
    approvalBaseSchema.extend({
      status: z.literal("denied"),
      ...decidedApprovalFields
    }),
    approvalBaseSchema.extend({
      status: z.literal("expired"),
      ...undecidedApprovalFields
    }),
    approvalBaseSchema.extend({
      status: z.literal("revoked"),
      ...decidedApprovalFields
    })
  ])
  .superRefine((approval, context) => {
    const requestedAt = new Date(approval.requestedAt).getTime();

    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < requestedAt) {
      context.addIssue({
        code: "custom",
        message: "expiresAt cannot be before requestedAt.",
        path: ["expiresAt"]
      });
    }

    if (approval.decidedAt && new Date(approval.decidedAt).getTime() < requestedAt) {
      context.addIssue({
        code: "custom",
        message: "decidedAt cannot be before requestedAt.",
        path: ["decidedAt"]
      });
    }
  });

export type Approval = z.infer<typeof approvalSchema>;
