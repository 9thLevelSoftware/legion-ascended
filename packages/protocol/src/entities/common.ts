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

/**
 * How far a verification command actually reaches.
 *
 * Four values, ordered by how much of the real system a passing run touched.
 * `unit` is a first-class answer and not a shrug: it records that this check
 * crosses no boundary, which is a *negative* answer to "did verification reach
 * the relevant integration or real interface" rather than an absent one.
 */
export const verificationSurfaceKindSchema = z.enum([
  "unit",
  "integration",
  "real-interface",
  "end-to-end"
]);

export type VerificationSurfaceKind = z.infer<typeof verificationSurfaceKindSchema>;

/**
 * What a verification command reaches, declared rather than inferred.
 *
 * The surface is authored once, at plan time, on the requirement's executable
 * acceptance criterion, and copied down mechanically onto the task contract's
 * verification entry and onto the oracle that criterion produces. It is never
 * derived from the command string: `pnpm test --filter integration` may be a
 * pure unit suite and `node scripts/smoke.mjs` may drive a live database, so
 * inference misclassifies in both directions and does so silently.
 *
 * `pinned` is what makes the declaration falsifiable. A claim that a check
 * reaches a real interface is unreviewable on its own; a claim that names the
 * compose file standing the service up, or the schema it is checked against, can
 * be re-hashed at ship time and stops being believed the moment those bytes
 * change. `.min(1)` for the reason `approvalBaseSchema.artifacts` carries it: an
 * empty array passes every pin check vacuously, which is a fail-open produced by
 * a shape rather than by a mistake.
 *
 * A path may be pinned only once. Nothing downstream takes the first match — the
 * consuming gate checks every pin — but a document pinning one path at two
 * digests asserts two different truths about the same bytes, and the honest place
 * to refuse that is here rather than in each reader.
 */
export const verificationSurfaceSchema = z
  .strictObject({
    kind: verificationSurfaceKindSchema,
    /** The boundary, as a design document would name it: "POST /v1/orders". */
    interface: z.string().min(1).max(256),
    /** Why reaching it catches something a smaller check would miss. */
    rationale: z.string().min(1).max(1_024),
    pinned: z.array(artifactReferenceSchema).min(1).max(8)
  })
  .superRefine((surface, context) => {
    const seen = new Set<string>();
    for (const [index, reference] of surface.pinned.entries()) {
      if (seen.has(reference.path)) {
        context.addIssue({
          code: "custom",
          message: "A verification surface may pin a path only once.",
          path: ["pinned", index, "path"]
        });
      }
      seen.add(reference.path);
    }
  });

export type VerificationSurface = z.infer<typeof verificationSurfaceSchema>;

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
  "evidence-index",
  "task-run",
  "review",
  "approval",
  "archive"
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
