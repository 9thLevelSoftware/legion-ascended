import * as z from "zod";

import {
  artifactRevisionSchema,
  changeIdSchema,
  contentHashSchema,
  oracleSchema,
  schemaVersionSchema,
  type SchemaVersion
} from "@legion/protocol";

export const ORACLE_ARTIFACT_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const oracleArtifactDocumentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("oracle-artifact"),
  revision: z.number().int().positive(),
  oracle: oracleSchema
});

export type OracleArtifactDocument = z.infer<typeof oracleArtifactDocumentSchema>;

export const oracleManifestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("oracle-manifest"),
  changeId: changeIdSchema,
  oracles: z.array(artifactRevisionSchema),
  manifestHash: contentHashSchema
});

export type OracleManifest = z.infer<typeof oracleManifestSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const oracleArtifactJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/oracle-artifact.schema.json",
  "Legion oracle artifact schema",
  oracleArtifactDocumentSchema
);

export const oracleManifestJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/oracle-manifest.schema.json",
  "Legion oracle manifest schema",
  oracleManifestSchema
);
