import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import {
  attestationIdSchema,
  changeIdSchema,
  projectIdSchema,
  requirementIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import { artifactReferenceSchema, utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

/**
 * A named actor asserting, at a recorded time, that specific hash-pinned bytes
 * are this change's evidence for one thing ADR-006 asks about.
 *
 * **The problem this entity exists for is re-keying, and the honesty of the
 * re-keying is the whole design.** Three R3 gates — `independent_baseline`,
 * `security_or_e2e_evaluator` and `rollback_or_forward_fix_evidence` — ask
 * questions whose answers already exist in this repository as JSON, produced by
 * `scripts/baseline/threat-model.mjs` and `scripts/release/rollback-policy.mjs`.
 * Every one of those files is keyed by *phase* or by *release*, and none of them
 * has any concept of a change: `grep -rniE "changeid|change-id" scripts/baseline
 * scripts/release` returns nothing, and nothing under `scripts/` reads
 * `.legion/project/changes/`.
 *
 * So the link from a verdict to a change has to come from somewhere, and there
 * are only two places it can come from: an inference, or a person. An inference
 * — a naming convention, a path heuristic, a directory-layout rule — is a link
 * nobody took responsibility for and nobody can be shown to have been wrong
 * about. `scripts/release/release-checklist.mjs` already does exactly that,
 * building `path.join(evidenceRoot, "P13-T02", "threat-model.json")` by hand,
 * and it is the anti-pattern rather than the precedent.
 *
 * This record is the other answer. A human says "these bytes are this change's
 * evidence for this question", their identity and the instant are recorded, and
 * the bytes are pinned by content hash so `legion ship` can re-verify that
 * nothing moved underneath the assertion. The link is an explicit act that is
 * itself auditable; what it cannot do is make the underlying artifact into a
 * per-change one, and no field here pretends otherwise.
 *
 * It is a plain object rather than a discriminated union like `approvalSchema`,
 * and it carries no `idempotencyKey`. There is no lifecycle: the whole record is
 * one assertion, taken once, replaced in place when it is retaken. Its id is
 * derived from `(changeId, attests)` and from nothing else, so the id *is* the
 * idempotency key — see `attestationIdForKind` in the CLI, whose doc comment
 * records why one record per kind per change is the storage model and why an
 * accumulating plane would be a fail-open.
 */

/**
 * What is being attested.
 *
 * A closed enum in the protocol rather than an ad-hoc CLI-local list, because
 * `legion attest <kind>` validates its positional against exactly this and three
 * ship gates select records by it. Seven members, of which this release's gates
 * read five; `architecture-review` and `release-observation` are recorded for
 * the gates PR 7 and PR 9 add, and `legion attest` warns — from the gate
 * module's own exported set, never from a second hand-maintained list — when a
 * kind it just wrote has no reader yet.
 */
export const attestationKindSchema = z.enum([
  "independent-baseline",
  "security-evaluation",
  "e2e-evaluation",
  "architecture-review",
  "rollback-evidence",
  "forward-fix-evidence",
  "release-observation"
]);

export type AttestationKind = z.infer<typeof attestationKindSchema>;

/**
 * The verdict recorded.
 *
 * `unknown` is not decoration. `legion attest` refuses `pass` over a source it
 * cannot recognise, and without a third value the only ways out would be to lie
 * (`pass`) or to assert a negative nobody established (`fail`). A gate reads
 * `unknown` as `unevaluable`: a record exists for this kind and asserts nothing.
 */
export const attestationVerdictSchema = z.enum(["pass", "fail", "unknown", "not_applicable"]);

export type AttestationVerdict = z.infer<typeof attestationVerdictSchema>;

/**
 * What the attestation claims to cover.
 *
 * Requirement and task ids only. There is deliberately no `{kind: "change"}`
 * member: "this attestation covers the change" restates the record's own
 * `changeId` key and can never be wrong, so a `.min(1)` array satisfiable by it
 * would look like a coverage guarantee and guarantee nothing. That is the
 * failure `oracle.protectedPaths` already has in this tree, and adding a second
 * instance of it is not a neutral act.
 *
 * `covers` has a reader in the same release that adds it: the three gates
 * require it to name every task of the change that derived the gate, so an
 * attester who covers one criterion-task cannot satisfy a change-scoped gate.
 */
export const attestationCoverageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("requirement"), id: requirementIdSchema }),
  z.strictObject({ kind: z.literal("task"), id: taskIdSchema })
]);

export type AttestationCoverage = z.infer<typeof attestationCoverageSchema>;

/** The shortest waiver reason that can be disagreed with rather than nodded at. */
export const WAIVER_REASON_MIN_LENGTH = 24;

/**
 * Is this a reason, or a token long enough to clear a length check?
 *
 * A raw character floor made the refusal's own sentence — "A single word is not
 * a reason" — false for any word of 24 characters, and
 * `--waiver-reason aaaaaaaaaaaaaaaaaaaaaaaaaa` satisfied an R3 risk gate with
 * that string quoted verbatim into ship's warning. So the floor is stated as
 * what it was always meant to mean: at least two whitespace-separated tokens, on
 * a trimmed string.
 *
 * Exported and called by `legion attest` rather than restated there, on PR 2's
 * rule. The two checks exist for different audiences — the schema's message
 * names a field, the command's names the decision the operator is being asked to
 * take — but a command whose idea of an acceptable waiver is looser than the
 * schema's writes nothing and reports success, and one that is tighter refuses a
 * record the plane would have accepted. Neither is allowed to drift, so there is
 * one predicate.
 */
export function isSubstantiveWaiverReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= WAIVER_REASON_MIN_LENGTH && trimmed.split(/\s+/).length >= 2;
}

export const attestationSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("attestation"),
    id: attestationIdSchema,
    projectId: projectIdSchema,
    changeId: changeIdSchema,
    attests: attestationKindSchema,
    verdict: attestationVerdictSchema,
    attestedBy: actorSchema,
    attestedAt: utcTimestampSchema,
    /**
     * The exact bytes the assertion is about.
     *
     * `.min(1)` for `approvalBaseSchema.artifacts`' recorded reason and one
     * sharper one. An empty array is not "pinned nothing" to a reader — it is a
     * list every quantifier passes vacuously, which is the fail-open this series
     * has now paid for five times. And an attestation with no sources is the
     * whole entity's premise removed: the assertion *is* "these bytes are this
     * change's evidence", so a record with no bytes asserts a link to nothing.
     *
     * Required for `not_applicable` too, and that is deliberate rather than
     * inherited. The waiver arm is the one `satisfied` verdict in all three
     * gates with no falsifiable evidence behind it, so it is the last place to
     * relax a requirement: a waiver cites the ADR, design note or decision
     * record that supports "this check does not apply here", pinned so it cannot
     * be edited afterwards.
     *
     * `.max(8)` mirrors `verificationSurfaceSchema.pinned`.
     */
    sources: z.array(artifactReferenceSchema).min(1).max(8),
    covers: z.array(attestationCoverageSchema).min(1).max(64),
    statement: z.string().min(1).max(2_048),
    /**
     * Why the check does not apply, on the `not_applicable` verdict and nowhere
     * else.
     *
     * ADR-006 permits a waived gate only as an audited waiver: a named human, a
     * recorded time, and a reason a reviewer can disagree with. The first two are
     * the `attestedBy`/`attestedAt` pair and the refinement below; this is the
     * third, and `isSubstantiveWaiverReason` is what stops it being "n/a" — or a
     * single 24-character token, which a bare `.min()` accepted.
     */
    // `.min()` is kept beside the refinement rather than subsumed by it: the
    // generated JSON Schema can express a length floor and cannot express a word
    // count, so dropping it would silently weaken `schemas/entities/
    // attestation.schema.json` for every consumer outside this process.
    waiverReason: z
      .string()
      .min(WAIVER_REASON_MIN_LENGTH)
      .max(2_048)
      .refine(isSubstantiveWaiverReason, {
        message: `waiverReason must be at least ${WAIVER_REASON_MIN_LENGTH} characters and more than one word: ADR-006 permits a waived gate only as an audited waiver, and a reason a reviewer can disagree with is a sentence rather than a token.`
      })
      .optional()
  })
  .superRefine((attestation, context) => {
    // Duplicate-path refusal, copied from `verificationSurfaceSchema` and for
    // its reason: one path pinned at two digests asserts two truths about the
    // same bytes, and the honest refusal belongs here rather than repeated in
    // each of three gates.
    const seenPaths = new Set<string>();
    for (const [index, reference] of attestation.sources.entries()) {
      if (seenPaths.has(reference.path)) {
        context.addIssue({
          code: "custom",
          message: "An attestation may pin a source path only once.",
          path: ["sources", index, "path"]
        });
      }
      seenPaths.add(reference.path);
    }

    const seenCovers = new Set<string>();
    for (const [index, entry] of attestation.covers.entries()) {
      const key = `${entry.kind}:${entry.id}`;
      if (seenCovers.has(key)) {
        context.addIssue({
          code: "custom",
          message: "An attestation may name a covered subject only once.",
          path: ["covers", index, "id"]
        });
      }
      seenCovers.add(key);
    }

    // Positive on both sides, never a residual arm. `not_applicable` is the one
    // verdict that satisfies a gate with no evidence behind it, so both of its
    // conditions are required rather than defaulted; and a `waiverReason` on any
    // other verdict is refused, because a waiver sentence sitting on a `fail`
    // reads as a waiver of that failure to anything rendering the record.
    if (attestation.verdict === "not_applicable") {
      if (attestation.waiverReason === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "A not_applicable attestation requires waiverReason: ADR-006 permits a waived gate only as an audited waiver, which is a named human, a recorded time and a reason a reviewer can disagree with.",
          path: ["waiverReason"]
        });
      }
      if (attestation.attestedBy.kind !== "human") {
        context.addIssue({
          code: "custom",
          message: `A not_applicable attestation must be made by a human; attestedBy.kind is "${attestation.attestedBy.kind}". A waiver is a person's acceptance of risk, and an automation cannot accept it on their behalf.`,
          path: ["attestedBy", "kind"]
        });
      }
    } else if (attestation.waiverReason !== undefined) {
      context.addIssue({
        code: "custom",
        message: `waiverReason is only meaningful on a not_applicable attestation; this one records "${attestation.verdict}". A waiver sentence on any other verdict reads as a waiver of that verdict.`,
        path: ["waiverReason"]
      });
    }

    // `approval.ts`'s sanity rule, on the pair that exists here. `createdAt` is
    // the write instant; an `attestedAt` before it is a record claiming to
    // predate the act of recording it.
    if (new Date(attestation.attestedAt).getTime() < new Date(attestation.createdAt).getTime()) {
      context.addIssue({
        code: "custom",
        message: "attestedAt cannot be before createdAt.",
        path: ["attestedAt"]
      });
    }
  });

export type Attestation = z.infer<typeof attestationSchema>;
