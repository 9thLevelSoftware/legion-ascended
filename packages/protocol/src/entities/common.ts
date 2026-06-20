import * as z from "zod";

import { actorSchema, provenanceSchema } from "../primitives/common.js";
import {
  changeIdSchema,
  decisionIdSchema,
  oracleIdSchema,
  projectIdSchema,
  requirementIdSchema
} from "../primitives/ids.js";
import {
  artifactPathSchema,
  artifactReferenceSchema,
  contentHashSchema,
  gitShaSchema,
  metadataSchema,
  schemaVersionSchema,
  utcTimestampSchema
} from "../primitives/values.js";

export const intentEntityKindSchema = z.enum(["project", "change", "requirement", "decision", "oracle"]);

export type IntentEntityKind = z.infer<typeof intentEntityKindSchema>;

export const riskTierSchema = z.enum(["R0", "R1", "R2", "R3"]);

export type RiskTier = z.infer<typeof riskTierSchema>;

export const riskProfileSchema = z
  .strictObject({
    tier: riskTierSchema,
    reasons: z.array(z.string().min(1).max(128)).min(1),
    hardFloors: z.array(z.string().min(1).max(128)).optional(),
    override: z
      .strictObject({
        from: riskTierSchema,
        to: riskTierSchema,
        reason: z.string().min(1).max(2_048),
        approvedBy: actorSchema,
        approvedAt: utcTimestampSchema
      })
      .optional()
  })
  .superRefine((risk, context) => {
    if (risk.override === undefined) return;

    if (risk.tier !== risk.override.to) {
      context.addIssue({
        code: "custom",
        message: "The active risk tier must match the override target tier.",
        path: ["tier"]
      });
    }

    if (risk.override.from === risk.override.to) {
      context.addIssue({
        code: "custom",
        message: "Risk override source and target tiers must differ.",
        path: ["override", "to"]
      });
    }
  });

export type RiskProfile = z.infer<typeof riskProfileSchema>;

export const scopedEntityReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), id: projectIdSchema }),
  z.strictObject({ kind: z.literal("change"), id: changeIdSchema }),
  z.strictObject({ kind: z.literal("requirement"), id: requirementIdSchema }),
  z.strictObject({ kind: z.literal("decision"), id: decisionIdSchema }),
  z.strictObject({ kind: z.literal("oracle"), id: oracleIdSchema })
]);

export type ScopedEntityReference = z.infer<typeof scopedEntityReferenceSchema>;

export const traceReferenceSchema = z.strictObject({
  path: artifactPathSchema,
  anchor: z.string().min(1).max(128).optional(),
  relation: z.enum(["defines", "refines", "supersedes", "covers", "verifies", "records"]),
  entity: scopedEntityReferenceSchema.optional()
});

export type TraceReference = z.infer<typeof traceReferenceSchema>;

export const artifactRoleSchema = z.enum([
  "project-manifest",
  "constitution",
  "current-spec",
  "delta-spec",
  "proposal",
  "design",
  "decision-log",
  "oracle",
  "taskgraph",
  "evidence-index"
]);

export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

export const artifactRevisionSchema = z.strictObject({
  role: artifactRoleSchema,
  artifact: artifactReferenceSchema,
  revision: z.number().int().positive(),
  baseGitSha: gitShaSchema.optional(),
  supersedes: artifactReferenceSchema.optional()
});

export type ArtifactRevision = z.infer<typeof artifactRevisionSchema>;

export const schemaMetadataSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema.optional(),
  provenance: provenanceSchema.optional(),
  metadata: metadataSchema.optional()
});

export type SchemaMetadata = z.infer<typeof schemaMetadataSchema>;

export const truthRevisionSchema = z.strictObject({
  artifact: artifactReferenceSchema,
  contentHash: contentHashSchema,
  revision: z.number().int().positive()
});

export type TruthRevision = z.infer<typeof truthRevisionSchema>;
