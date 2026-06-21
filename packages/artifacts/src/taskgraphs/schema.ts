import * as z from "zod";

import {
  artifactReferenceSchema,
  artifactRevisionSchema,
  changeIdSchema,
  contentHashSchema,
  schemaVersionSchema,
  taskContractSchema,
  type SchemaVersion
} from "@legion/protocol";

export const TASKGRAPH_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const changeArtifactManifestSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("change-artifact-manifest"),
    changeId: changeIdSchema,
    inputs: z.array(artifactRevisionSchema).min(1),
    evidenceRefs: z.array(artifactReferenceSchema),
    manifestHash: contentHashSchema
  });

export type ChangeArtifactManifest = z.infer<typeof changeArtifactManifestSchema>;

export const taskGraphDocumentSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("taskgraph"),
    changeId: changeIdSchema,
    revision: z.number().int().positive(),
    artifactInputs: z.array(artifactRevisionSchema).min(1),
    tasks: z.array(taskContractSchema).min(1),
    artifactManifest: changeArtifactManifestSchema
  })
  .superRefine((document, context) => {
    if (document.artifactManifest.changeId !== document.changeId) {
      context.addIssue({
        code: "custom",
        message: "Taskgraph artifact manifest must use the taskgraph change ID.",
        path: ["artifactManifest", "changeId"]
      });
    }

    for (const [index, task] of document.tasks.entries()) {
      if (task.changeId !== document.changeId) {
        context.addIssue({
          code: "custom",
          message: "Task contract change ID must match the taskgraph change ID.",
          path: ["tasks", index, "changeId"]
        });
      }
    }
  });

export type TaskGraphDocument = z.infer<typeof taskGraphDocumentSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const changeArtifactManifestJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/change-artifact-manifest.schema.json",
  "Legion change artifact manifest schema",
  changeArtifactManifestSchema
);

export const taskGraphJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/taskgraph.schema.json",
  "Legion taskgraph artifact schema",
  taskGraphDocumentSchema
);
