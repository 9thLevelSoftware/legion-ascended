import * as z from "zod";

import {
  artifactPathSchema,
  artifactReferenceSchema,
  contentHashSchema,
  requirementIdSchema,
  requirementSchema,
  schemaVersionSchema,
  utcTimestampSchema,
  type RequirementId,
  type SchemaVersion
} from "@legion/protocol";

export const CURRENT_SPEC_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

const capabilityIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Invalid capability ID");

export const currentSpecCapabilitySchema = z
  .strictObject({
    id: capabilityIdSchema,
    title: z.string().min(1).max(128),
    status: z.enum(["active", "deprecated"]),
    deprecatedAt: utcTimestampSchema.optional(),
    deprecationReason: z.string().min(1).max(512).optional()
  })
  .superRefine((capability, context) => {
    if (capability.status === "deprecated") {
      if (capability.deprecatedAt === undefined) {
        context.addIssue({
          code: "custom",
          message: "Deprecated capabilities require deprecatedAt.",
          path: ["deprecatedAt"]
        });
      }
      if (capability.deprecationReason === undefined) {
        context.addIssue({
          code: "custom",
          message: "Deprecated capabilities require deprecationReason.",
          path: ["deprecationReason"]
        });
      }
      return;
    }

    if (capability.deprecatedAt !== undefined || capability.deprecationReason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Active capabilities cannot carry deprecation metadata.",
        path: ["status"]
      });
    }
  });

export type CurrentSpecCapability = z.infer<typeof currentSpecCapabilitySchema>;

export const currentSpecSectionsSchema = z.strictObject({
  purpose: z.string().min(1).max(4_096),
  behaviors: z.string().min(1).max(8_192),
  constraints: z.string().min(1).max(8_192),
  scenarios: z.string().min(1).max(8_192),
  interfaces: z.string().min(1).max(8_192),
  compatibility: z.string().min(1).max(8_192),
  failureModes: z.string().min(1).max(8_192),
  traceIds: z.array(requirementIdSchema).min(1)
});

export type CurrentSpecSections = z.infer<typeof currentSpecSectionsSchema>;

export const currentSpecDocumentSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("current-spec"),
    revision: z.number().int().positive(),
    primaryRequirementId: requirementIdSchema,
    capability: currentSpecCapabilitySchema,
    requirements: z.array(requirementSchema).min(1),
    sections: currentSpecSectionsSchema
  })
  .superRefine((document, context) => {
    const requirementIds = new Set<RequirementId>();
    for (const [index, requirement] of document.requirements.entries()) {
      if (requirementIds.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate requirement ID in spec document: ${requirement.id}.`,
          path: ["requirements", index, "id"]
        });
      }
      requirementIds.add(requirement.id);
    }

    if (!requirementIds.has(document.primaryRequirementId)) {
      context.addIssue({
        code: "custom",
        message: "Primary requirement ID must be present in requirements.",
        path: ["primaryRequirementId"]
      });
    }
  });

export type CurrentSpecDocument = z.infer<typeof currentSpecDocumentSchema>;

export const currentSpecRequirementIndexEntrySchema = z.strictObject({
  id: requirementIdSchema,
  contentHash: contentHashSchema
});

export type CurrentSpecRequirementIndexEntry = z.infer<typeof currentSpecRequirementIndexEntrySchema>;

export const currentSpecIndexEntrySchema = z.strictObject({
  path: artifactPathSchema,
  revision: z.number().int().positive(),
  capability: currentSpecCapabilitySchema,
  primaryRequirementId: requirementIdSchema,
  requirements: z.array(currentSpecRequirementIndexEntrySchema).min(1),
  artifact: artifactReferenceSchema
});

export type CurrentSpecIndexEntry = z.infer<typeof currentSpecIndexEntrySchema>;

export const currentSpecIndexSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal("current-spec-index"),
  entries: z.array(currentSpecIndexEntrySchema)
});

export type CurrentSpecIndex = z.infer<typeof currentSpecIndexSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const currentSpecDocumentJsonSchema = jsonSchemaDocument(
  "https://schemas.9thlevelsoftware.com/legion/artifacts/spec-document.schema.json",
  "Legion current specification document schema",
  currentSpecDocumentSchema
);
