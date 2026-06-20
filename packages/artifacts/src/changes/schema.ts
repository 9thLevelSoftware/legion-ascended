import * as z from "zod";

import {
  actorSchema,
  artifactPathSchema,
  artifactReferenceSchema,
  artifactRevisionSchema,
  changeIdSchema,
  changeSchema,
  contentHashSchema,
  decisionSchema,
  gitShaSchema,
  requirementIdSchema,
  requirementSchema,
  schemaVersionSchema,
  type SchemaVersion
} from "@legion/protocol";

import { currentSpecSectionsSchema } from "../specs/schema.js";

export const CHANGE_BUNDLE_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const deltaOperationSchema = z.enum(["add", "modify", "remove"]);

export type DeltaOperation = z.infer<typeof deltaOperationSchema>;

export const changeDeltaSpecSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("delta-spec"),
    changeId: changeIdSchema,
    requirementId: requirementIdSchema,
    operation: deltaOperationSchema,
    baseCurrentSpec: artifactReferenceSchema.optional(),
    baseCurrentSpecRevision: z.number().int().positive().optional(),
    baseRequirementHash: contentHashSchema.optional(),
    proposedRequirement: requirementSchema.optional(),
    sections: currentSpecSectionsSchema.optional(),
    rationale: z.string().min(1).max(4_096),
    dependencies: z.array(artifactReferenceSchema)
  })
  .superRefine((delta, context) => {
    if (delta.operation === "modify" || delta.operation === "remove") {
      if (delta.baseCurrentSpec === undefined) {
        context.addIssue({
          code: "custom",
          message: "Modified or removed deltas require a base current spec reference.",
          path: ["baseCurrentSpec"]
        });
      }
      if (delta.baseCurrentSpecRevision === undefined) {
        context.addIssue({
          code: "custom",
          message: "Modified or removed deltas require a base current spec revision.",
          path: ["baseCurrentSpecRevision"]
        });
      }
      if (delta.baseRequirementHash === undefined) {
        context.addIssue({
          code: "custom",
          message: "Modified or removed deltas require a base requirement hash.",
          path: ["baseRequirementHash"]
        });
      }
    }

    if (delta.operation === "add" || delta.operation === "modify") {
      if (delta.proposedRequirement === undefined) {
        context.addIssue({
          code: "custom",
          message: "Added or modified deltas require a proposed requirement.",
          path: ["proposedRequirement"]
        });
      }
      if (delta.sections === undefined) {
        context.addIssue({
          code: "custom",
          message: "Added or modified deltas require proposed sections.",
          path: ["sections"]
        });
      }
      if (delta.proposedRequirement !== undefined && delta.proposedRequirement.id !== delta.requirementId) {
        context.addIssue({
          code: "custom",
          message: "Added or modified deltas must propose the same requirement ID as the delta target.",
          path: ["proposedRequirement", "id"]
        });
      }
    }

    if (delta.operation === "remove" && (delta.proposedRequirement !== undefined || delta.sections !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Removed deltas cannot carry proposed requirement content.",
        path: ["operation"]
      });
    }
  });

export type ChangeDeltaSpec = z.infer<typeof changeDeltaSpecSchema>;

export const changeDesignDocumentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("change-design"),
  changeId: changeIdSchema,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(16_384),
  dependencies: z.array(artifactReferenceSchema)
});

export type ChangeDesignDocument = z.infer<typeof changeDesignDocumentSchema>;

export const changeDecisionLogSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("decision-log"),
  changeId: changeIdSchema,
  decisions: z.array(decisionSchema)
});

export type ChangeDecisionLog = z.infer<typeof changeDecisionLogSchema>;

export const changeBundleDeltaEntrySchema = z.strictObject({
  operation: deltaOperationSchema,
  requirementId: requirementIdSchema,
  path: artifactPathSchema,
  baseCurrentSpec: artifactReferenceSchema.optional(),
  baseCurrentSpecRevision: z.number().int().positive().optional(),
  baseRequirementHash: contentHashSchema.optional(),
  delta: artifactReferenceSchema
});

export type ChangeBundleDeltaEntry = z.infer<typeof changeBundleDeltaEntrySchema>;

export const changeBundlePathsSchema = z.strictObject({
  root: artifactPathSchema,
  proposal: artifactPathSchema,
  deltaSpecRoot: artifactPathSchema,
  design: artifactPathSchema,
  decisions: artifactPathSchema
});

export type ChangeBundlePaths = z.infer<typeof changeBundlePathsSchema>;

export const changeBundleSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("change-bundle"),
  revision: z.number().int().positive(),
  owners: z.array(actorSchema).min(1),
  baseGitSha: gitShaSchema,
  paths: changeBundlePathsSchema,
  change: changeSchema,
  deltas: z.array(changeBundleDeltaEntrySchema).min(1),
  artifactRevisions: z.array(artifactRevisionSchema).min(1)
});

export type ChangeBundle = z.infer<typeof changeBundleSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const changeBundleJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/change-bundle.schema.json",
  "Legion change bundle artifact schema",
  changeBundleSchema
);
