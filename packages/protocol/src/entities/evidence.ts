import * as z from "zod";

import { changeIdSchema, evidenceIdSchema, projectIdSchema, runIdSchema, taskIdSchema } from "../primitives/ids.js";
import { artifactReferenceSchema, contentHashSchema, utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const evidenceStatusSchema = z.enum(["unknown", "collecting", "collected", "failed", "expired"]);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceSensitivitySchema = z.enum(["public", "internal", "confidential", "secret-redacted"]);

export type EvidenceSensitivity = z.infer<typeof evidenceSensitivitySchema>;

export const evidenceVerdictSchema = z.enum(["pass", "fail", "unknown", "not_verified", "not_applicable"]);

export type EvidenceVerdict = z.infer<typeof evidenceVerdictSchema>;

export const evidenceRetentionSchema = z.strictObject({
  class: z.enum(["ephemeral", "project", "release", "audit"]),
  retainUntil: utcTimestampSchema.optional()
});

export type EvidenceRetention = z.infer<typeof evidenceRetentionSchema>;

export const evidenceCommandResultSchema = z.strictObject({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(256)).max(64),
  exitCode: z.number().int().min(0).max(255),
  outputHash: contentHashSchema,
  startedAt: utcTimestampSchema.optional(),
  endedAt: utcTimestampSchema.optional()
});

export type EvidenceCommandResult = z.infer<typeof evidenceCommandResultSchema>;

export const evidenceItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/, "Invalid evidence item ID"),
  classification: z.enum([
    "test-report",
    "build-log",
    "schema-artifact",
    "review-note",
    "trace",
    "runtime-log",
    "manual-observation"
  ]),
  verdict: evidenceVerdictSchema,
  artifact: artifactReferenceSchema.optional(),
  command: evidenceCommandResultSchema.optional(),
  traceRefs: z.array(traceReferenceSchema)
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const evidenceBundleSchema = schemaMetadataSchema.extend({
  kind: z.literal("evidence"),
  id: evidenceIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  status: evidenceStatusSchema,
  sensitivity: evidenceSensitivitySchema,
  retention: evidenceRetentionSchema,
  items: z.array(evidenceItemSchema),
  traceRefs: z.array(traceReferenceSchema)
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
