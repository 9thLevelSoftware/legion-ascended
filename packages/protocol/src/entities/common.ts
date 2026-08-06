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

/**
 * The control plane, spelled out here rather than imported.
 *
 * `@legion/artifacts` exports `LEGION_PROJECT_ROOT` and depends on this package,
 * so importing it would invert the dependency. Written as a literal with the
 * reason attached, on the rule this tree already applies to approval action
 * strings: a shared symbol lets a rename move every reader at once and leaves
 * every document already on disk unreadable.
 */
const CONTROL_PLANE_ROOT = ".legion/project";

/**
 * Whether a declared path names the control plane, **case-folded**.
 *
 * An exact-string comparison accepted `.Legion/project/change.yaml`, which on a
 * case-insensitive filesystem is the very control artifact the guarded harness
 * restores. The harness restores it *before* it compares, so before and after are
 * equal unconditionally, the run records `pass`, and the gate reports satisfied
 * over a declaration protecting no test — while the same document on a
 * case-sensitive CI reads as absent on both sides and answers `unevaluable`. A
 * schema whose stated invariant is "the two populations cannot overlap" cannot
 * hold it one letter at a time.
 *
 * Refused on every platform, because a document is authored once and judged
 * wherever the change ships. `toLowerCase`, not `toLocaleLowerCase`, which folds
 * the `i` of `.legion` differently under a Turkish locale.
 */
function namesControlPlane(entry: string): boolean {
  const folded = entry.toLowerCase();
  const root = CONTROL_PLANE_ROOT.toLowerCase();
  return folded === root || folded.startsWith(`${root}/`);
}

/** `acceptancePathsSchema` caps the array at eight, on `pinned`'s reasoning. */
export const MAX_ACCEPTANCE_PATHS = 8;

/**
 * The tests an implementer's run must not weaken, named by identity.
 *
 * **Deliberately not `Oracle.protectedPaths`, and the separation is the whole
 * design.** `protectedPaths` names the control artifacts the guarded harness
 * *rolls back*: every path that reaches `restoreProtectedFiles` is reverted and
 * makes the run out of contract. These paths get the opposite treatment — the
 * harness hashes them before dispatch, reports what moved, restores nothing, and
 * lets the ship gate decide. One field carrying two opposite enforcement
 * disciplines inside the single writable-dispatch path is the conflation
 * `guarded-execution.ts` has already paid for once.
 *
 * Three consequences follow from it being its own field, and each closes
 * something:
 *
 *  - **Absence is representable.** `protectedPaths` is `.min(1)`, so every oracle
 *    on disk carries one — the change artifact — and any quantifier over "the
 *    subset that is not a control artifact" is `[].every(...)`, which is `true`
 *    for every project in existence. This is `.optional()`, so "nobody declared
 *    one" is a state a gate can check positively and report `unevaluable` for.
 *  - **The two populations cannot overlap.** A path under the control plane is
 *    refused here, so no acceptance path can reach the restore machinery and no
 *    control artifact can be reported as a merely-observed change.
 *  - **`.min(1)` when present**, for `approvalBaseSchema.artifacts`' stated
 *    reason: an empty array is not "protects nothing", it is a list every check
 *    passes vacuously.
 *
 * A path may be named only once, on `verificationSurfaceSchema.pinned`'s rule.
 * These are *identities*, not bytes: nothing hashes them at authoring time,
 * because the harness hashes them per run and a digest minted at intake would
 * drift the first time the test was legitimately edited — before it was ever
 * protected.
 */
export const acceptancePathsSchema = z
  .array(artifactPathSchema)
  .min(1)
  .max(MAX_ACCEPTANCE_PATHS)
  .superRefine((paths, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of paths.entries()) {
      if (seen.has(entry)) {
        context.addIssue({
          code: "custom",
          message: "A protected acceptance path may be named only once.",
          path: [index]
        });
      }
      seen.add(entry);
      if (namesControlPlane(entry)) {
        context.addIssue({
          code: "custom",
          message:
            `${CONTROL_PLANE_ROOT} is the control plane, which the guarded harness restores rather than reports. ` +
            "A protected acceptance path names a test the implementer must not weaken, which lives in the repository.",
          path: [index]
        });
      }
    }
  });

export type AcceptancePaths = z.infer<typeof acceptancePathsSchema>;

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
  "attestation",
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
