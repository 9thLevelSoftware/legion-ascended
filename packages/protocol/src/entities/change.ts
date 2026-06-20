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

export const acceptanceStateSchema = z.strictObject({
  status: z.enum(["not_ready", "ready", "accepted", "rejected", "blocked", "superseded"]),
  acceptedAt: utcTimestampSchema.optional(),
  acceptedBy: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(2_048).optional()
});

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
