import * as z from "zod";

import {
  artifactPathSchema,
  artifactRevisionSchema,
  projectSchema,
  schemaVersionSchema,
  type ArtifactRevision,
  type Project,
  type SchemaVersion
} from "@legion/protocol";

import { PROJECT_ARTIFACT_PATHS } from "../paths.js";

export const PROJECT_MANIFEST_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const projectManifestSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("project-manifest"),
    revision: z.number().int().positive(),
    project: projectSchema,
    artifactRevisions: z.strictObject({
      constitution: artifactRevisionSchema
    })
  })
  .superRefine((manifest, context) => {
    if (manifest.project.policy.constitution.path !== PROJECT_ARTIFACT_PATHS.constitution) {
      context.addIssue({
        code: "custom",
        message: `Project constitution reference must point to ${PROJECT_ARTIFACT_PATHS.constitution}.`,
        path: ["project", "policy", "constitution", "path"]
      });
    }

    if (manifest.project.policy.currentSpecRoot !== PROJECT_ARTIFACT_PATHS.currentSpecs) {
      context.addIssue({
        code: "custom",
        message: `Current spec root must be ${PROJECT_ARTIFACT_PATHS.currentSpecs}.`,
        path: ["project", "policy", "currentSpecRoot"]
      });
    }

    if (manifest.project.policy.changeRoot !== PROJECT_ARTIFACT_PATHS.changes) {
      context.addIssue({
        code: "custom",
        message: `Change root must be ${PROJECT_ARTIFACT_PATHS.changes}.`,
        path: ["project", "policy", "changeRoot"]
      });
    }

    if (manifest.project.policy.adrRoot !== PROJECT_ARTIFACT_PATHS.adr) {
      context.addIssue({
        code: "custom",
        message: `ADR root must be ${PROJECT_ARTIFACT_PATHS.adr}.`,
        path: ["project", "policy", "adrRoot"]
      });
    }

    if (manifest.artifactRevisions.constitution.role !== "constitution") {
      context.addIssue({
        code: "custom",
        message: "Constitution artifact revision must use the constitution role.",
        path: ["artifactRevisions", "constitution", "role"]
      });
    }

    if (manifest.artifactRevisions.constitution.artifact.path !== manifest.project.policy.constitution.path) {
      context.addIssue({
        code: "custom",
        message: "Constitution artifact revision path must match the project policy reference.",
        path: ["artifactRevisions", "constitution", "artifact", "path"]
      });
    }

    if (manifest.artifactRevisions.constitution.artifact.sha256 !== manifest.project.policy.constitution.sha256) {
      context.addIssue({
        code: "custom",
        message: "Constitution artifact revision hash must match the project policy reference.",
        path: ["artifactRevisions", "constitution", "artifact", "sha256"]
      });
    }
  });

export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export interface LoadedProjectManifest {
  readonly manifest: ProjectManifest;
  readonly project: Project;
  readonly constitutionRevision: ArtifactRevision;
}

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const projectManifestJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/project-manifest.schema.json",
  "Legion project artifact manifest schema",
  projectManifestSchema
);

export const projectManifestPathSchema = artifactPathSchema.refine(
  (value) => value === PROJECT_ARTIFACT_PATHS.projectManifest,
  `Project manifest path must be ${PROJECT_ARTIFACT_PATHS.projectManifest}.`
);
