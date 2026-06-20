import * as z from "zod";

import {
  artifactReferenceSchema,
  metadataSchema,
  schemaVersionSchema,
  utcTimestampSchema
} from "./values.js";

export const actorSchema = z.strictObject({
  kind: z.enum(["human", "worker", "system", "runtime", "tool"]),
  id: z.string().regex(/^[a-z][a-z0-9_.:-]{1,127}$/, "Invalid actor ID"),
  displayName: z.string().min(1).max(128).optional()
});

export type Actor = z.infer<typeof actorSchema>;

export const provenanceSchema = z.strictObject({
  actor: actorSchema,
  createdAt: utcTimestampSchema,
  source: z.enum(["task-contract", "runtime", "worker", "review", "system", "migration", "user"]),
  schemaVersion: schemaVersionSchema,
  artifact: artifactReferenceSchema.optional()
});

export type Provenance = z.infer<typeof provenanceSchema>;

export const protocolErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Invalid protocol error code"),
  message: z.string().min(1).max(2_048),
  retryable: z.boolean(),
  metadata: metadataSchema.optional()
});

export type ProtocolError = z.infer<typeof protocolErrorSchema>;

export const blockerSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Invalid blocker code"),
  reason: z.string().min(1).max(2_048),
  severity: z.enum(["minor", "major", "critical"]),
  metadata: metadataSchema.optional()
});

export type Blocker = z.infer<typeof blockerSchema>;

export const validationIssueSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "Invalid validation issue code"),
  message: z.string().min(1).max(2_048),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional()
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const validationResultSchema = z.strictObject({
  ok: z.boolean(),
  issues: z.array(validationIssueSchema)
});

export type ValidationResult = z.infer<typeof validationResultSchema>;
