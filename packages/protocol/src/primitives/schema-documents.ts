import * as z from "zod";

import {
  actorSchema,
  blockerSchema,
  protocolErrorSchema,
  provenanceSchema,
  validationResultSchema
} from "./common.js";
import {
  approvalIdSchema,
  changeIdSchema,
  contractIdSchema,
  decisionIdSchema,
  eventIdSchema,
  evidenceIdSchema,
  observationIdSchema,
  oracleIdSchema,
  projectIdSchema,
  releaseIdSchema,
  requirementIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema
} from "./ids.js";
import {
  artifactPathSchema,
  artifactReferenceSchema,
  contentHashSchema,
  correlationIdSchema,
  gitShaSchema,
  idempotencyKeySchema,
  metadataSchema,
  paginationCursorSchema,
  schemaVersionSchema,
  utcTimestampSchema
} from "./values.js";

const idsDocumentSchema = z.strictObject({
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  requirementId: requirementIdSchema,
  decisionId: decisionIdSchema,
  oracleId: oracleIdSchema,
  contractId: contractIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  evidenceId: evidenceIdSchema,
  reviewId: reviewIdSchema,
  approvalId: approvalIdSchema,
  releaseId: releaseIdSchema,
  observationId: observationIdSchema,
  eventId: eventIdSchema
});

const valuesDocumentSchema = z.strictObject({
  utcTimestamp: utcTimestampSchema,
  schemaVersion: schemaVersionSchema,
  contentHash: contentHashSchema,
  gitSha: gitShaSchema,
  artifactPath: artifactPathSchema,
  artifactReference: artifactReferenceSchema,
  idempotencyKey: idempotencyKeySchema,
  correlationId: correlationIdSchema,
  paginationCursor: paginationCursorSchema,
  metadata: metadataSchema
});

const commonDocumentSchema = z.strictObject({
  actor: actorSchema,
  provenance: provenanceSchema,
  protocolError: protocolErrorSchema,
  blocker: blockerSchema,
  validationResult: validationResultSchema
});

export const primitiveFixtureCorpusSchema = z.strictObject({
  ids: idsDocumentSchema,
  values: valuesDocumentSchema,
  common: commonDocumentSchema
});

export type PrimitiveFixtureCorpus = z.infer<typeof primitiveFixtureCorpusSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const primitiveJsonSchemas = {
  ids: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/primitives/ids.schema.json",
    "Legion protocol primitive ID schemas",
    idsDocumentSchema
  ),
  values: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/primitives/values.schema.json",
    "Legion protocol primitive scalar and metadata schemas",
    valuesDocumentSchema
  ),
  common: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/primitives/common.schema.json",
    "Legion protocol common actor, provenance, error, blocker, and validation schemas",
    commonDocumentSchema
  )
} as const;
