import * as z from "zod";

import { changeIdSchema, decisionIdSchema, oracleIdSchema, projectIdSchema, requirementIdSchema } from "../primitives/ids.js";
import { artifactReferenceSchema, contentHashSchema, gitShaSchema, utcTimestampSchema } from "../primitives/values.js";
import { artifactRevisionSchema, riskProfileSchema, schemaMetadataSchema } from "./common.js";

export const changeStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "planned",
  "in_progress",
  "verifying",
  "accepted",
  "rejected",
  "blocked",
  "archived"
]);

export type ChangeStatus = z.infer<typeof changeStatusSchema>;

const acceptanceActorSchema = z.string().min(1).max(128);
const acceptanceReasonSchema = z.string().min(1).max(2_048);

export const acceptanceStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_ready"),
    acceptedAt: utcTimestampSchema.optional(),
    acceptedBy: acceptanceActorSchema.optional(),
    reason: acceptanceReasonSchema.optional()
  }),
  z.strictObject({
    status: z.literal("ready"),
    acceptedAt: utcTimestampSchema.optional(),
    acceptedBy: acceptanceActorSchema.optional(),
    reason: acceptanceReasonSchema.optional()
  }),
  z.strictObject({
    status: z.literal("accepted"),
    acceptedAt: utcTimestampSchema,
    acceptedBy: acceptanceActorSchema,
    reason: acceptanceReasonSchema.optional()
  }),
  z.strictObject({
    status: z.literal("rejected"),
    acceptedAt: utcTimestampSchema.optional(),
    acceptedBy: acceptanceActorSchema.optional(),
    reason: acceptanceReasonSchema
  }),
  z.strictObject({
    status: z.literal("blocked"),
    acceptedAt: utcTimestampSchema.optional(),
    acceptedBy: acceptanceActorSchema.optional(),
    reason: acceptanceReasonSchema
  }),
  z.strictObject({
    status: z.literal("superseded"),
    acceptedAt: utcTimestampSchema.optional(),
    acceptedBy: acceptanceActorSchema.optional(),
    reason: acceptanceReasonSchema.optional()
  })
]);

export type AcceptanceState = z.infer<typeof acceptanceStateSchema>;

export const currentTruthSchema = z.strictObject({
  specRefs: z.array(artifactReferenceSchema).min(1),
  baseSpecHash: contentHashSchema,
  baseGitSha: gitShaSchema,
  requirementIds: z.array(requirementIdSchema)
});

export type CurrentTruth = z.infer<typeof currentTruthSchema>;

export const proposedTruthSchema = z.strictObject({
  deltaSpecRefs: z.array(artifactReferenceSchema).min(1),
  targetSpecHash: contentHashSchema,
  requirementIds: z.array(requirementIdSchema)
});

export type ProposedTruth = z.infer<typeof proposedTruthSchema>;

export const changeSchema = schemaMetadataSchema.extend({
  kind: z.literal("change"),
  id: changeIdSchema,
  projectId: projectIdSchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2_048),
  status: changeStatusSchema,
  currentTruth: currentTruthSchema,
  proposedTruth: proposedTruthSchema,
  artifactRevisions: z.array(artifactRevisionSchema).min(1),
  risk: riskProfileSchema,
  acceptance: acceptanceStateSchema,
  decisionRefs: z.array(decisionIdSchema),
  oracleRefs: z.array(oracleIdSchema)
});

export type Change = z.infer<typeof changeSchema>;
