import * as z from "zod";

import {
  changeIdSchema,
  evidenceBundleSchema,
  reviewIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
  type SchemaVersion
} from "@legion/protocol";

import { changeArtifactManifestSchema } from "../taskgraphs/schema.js";

export const EVIDENCE_INDEX_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const evidenceAcceptanceSchema = z.strictObject({
  status: z.enum(["pending", "accepted", "rejected"]),
  reviewId: reviewIdSchema.optional(),
  acceptedAt: utcTimestampSchema.optional(),
  reason: z.string().min(1).max(1_024).optional()
});

export type EvidenceAcceptance = z.infer<typeof evidenceAcceptanceSchema>;

export const evidenceIndexEntrySchema = z.strictObject({
  evidence: evidenceBundleSchema,
  acceptance: evidenceAcceptanceSchema
});

export type EvidenceIndexEntry = z.infer<typeof evidenceIndexEntrySchema>;

export const evidenceIndexDocumentSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("evidence-index"),
    changeId: changeIdSchema,
    revision: z.number().int().positive(),
    entries: z.array(evidenceIndexEntrySchema),
    artifactManifest: changeArtifactManifestSchema
  })
  .superRefine((document, context) => {
    if (document.artifactManifest.changeId !== document.changeId) {
      context.addIssue({
        code: "custom",
        message: "Evidence index artifact manifest must use the evidence index change ID.",
        path: ["artifactManifest", "changeId"]
      });
    }

    for (const [index, entry] of document.entries.entries()) {
      if (entry.evidence.changeId !== document.changeId) {
        context.addIssue({
          code: "custom",
          message: "Evidence bundle change ID must match the evidence index change ID.",
          path: ["entries", index, "evidence", "changeId"]
        });
      }
    }
  });

export type EvidenceIndexDocument = z.infer<typeof evidenceIndexDocumentSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const evidenceIndexJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/evidence-index.schema.json",
  "Legion evidence index artifact schema",
  evidenceIndexDocumentSchema
);
