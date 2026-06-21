import * as z from "zod";

import {
  artifactPathSchema,
  artifactReferenceSchema,
  artifactRevisionSchema,
  changeIdSchema,
  contentHashSchema,
  requirementIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
  type SchemaVersion
} from "@legion/protocol";

export const ARCHIVE_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const archiveCurrentSpecWriteSchema = z.strictObject({
  operation: z.enum(["create", "update"]),
  path: artifactPathSchema,
  expectedRevision: z.number().int().nonnegative(),
  nextRevision: z.number().int().positive(),
  before: artifactReferenceSchema.optional(),
  after: artifactReferenceSchema
});

export type ArchiveCurrentSpecWrite = z.infer<typeof archiveCurrentSpecWriteSchema>;

export const archiveSpecDiffSchema = z.strictObject({
  added: z.array(requirementIdSchema),
  modified: z.array(requirementIdSchema),
  removed: z.array(requirementIdSchema),
  moved: z.array(z.strictObject({
    id: requirementIdSchema,
    from: artifactPathSchema,
    to: artifactPathSchema
  }))
});

export type ArchiveSpecDiff = z.infer<typeof archiveSpecDiffSchema>;

export const archivePreviewSchema = z.strictObject({
  changeId: changeIdSchema,
  beforeSpecHash: contentHashSchema,
  afterSpecHash: contentHashSchema,
  diff: archiveSpecDiffSchema,
  currentSpecWrites: z.array(archiveCurrentSpecWriteSchema)
});

export type ArchivePreview = z.infer<typeof archivePreviewSchema>;

export const retainedArchiveArtifactsSchema = z.strictObject({
  proposal: artifactReferenceSchema,
  deltas: z.array(artifactReferenceSchema).min(1),
  design: artifactReferenceSchema,
  decisions: artifactReferenceSchema,
  oracles: z.array(artifactReferenceSchema),
  taskgraph: artifactReferenceSchema,
  evidenceIndex: artifactReferenceSchema
});

export type RetainedArchiveArtifacts = z.infer<typeof retainedArchiveArtifactsSchema>;

export const archiveRecordSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("change-archive"),
  revision: z.number().int().positive(),
  changeId: changeIdSchema,
  archivedAt: utcTimestampSchema,
  archivedBy: z.string().min(1).max(128),
  preview: archivePreviewSchema,
  retainedArtifacts: retainedArchiveArtifactsSchema,
  currentSpecRevisions: z.array(artifactRevisionSchema),
  archiveHash: contentHashSchema
});

export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const archiveRecordJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/archive-record.schema.json",
  "Legion change archive record schema",
  archiveRecordSchema
);
