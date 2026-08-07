import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import { changeIdSchema, evidenceIdSchema, projectIdSchema, reviewIdSchema, runIdSchema, taskIdSchema } from "../primitives/ids.js";
import { utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const reviewStatusSchema = z.enum(["requested", "submitted", "accepted", "rejected", "superseded", "unknown"]);

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewVerdictSchema = z.enum(["pass", "fail", "unknown", "not_verified", "not_applicable"]);

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/**
 * The competence a review was performed in.
 *
 * `verdicts` records three fixed axes and `reviewer` records which tool produced
 * the review; neither says what kind of expertise was brought to bear. ADR-006's
 * architecture-and-security gate asks exactly that, so before this field the only
 * available reading of it was "an accepted review exists" — which every change
 * has, and which is the fail-open `explicit_human_approval` closed one gate over.
 *
 * A closed enum in the protocol rather than free text, so `legion review
 * --domain` validates against this instead of a hand-written list — the argument
 * `legion attest` already makes for `attestationKindSchema`.
 */
export const reviewDomainSchema = z.enum([
  "implementation",
  "architecture",
  "security",
  "performance",
  "operability"
]);

export type ReviewDomain = z.infer<typeof reviewDomainSchema>;

export const reviewFindingSeveritySchema = z.enum(["minor", "major", "blocking"]);

export type ReviewFindingSeverity = z.infer<typeof reviewFindingSeveritySchema>;

export const reviewVerdictsSchema = z.strictObject({
  specification: reviewVerdictSchema,
  integration: reviewVerdictSchema,
  evidence: reviewVerdictSchema
});

export type ReviewVerdicts = z.infer<typeof reviewVerdictsSchema>;

const reviewFindingBaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/, "Invalid review finding ID"),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(4_096)
});

export const reviewFindingSchema = z.discriminatedUnion("severity", [
  reviewFindingBaseSchema.extend({
    severity: z.literal("minor"),
    evidenceRefs: z.array(evidenceIdSchema).optional()
  }),
  reviewFindingBaseSchema.extend({
    severity: z.literal("major"),
    evidenceRefs: z.array(evidenceIdSchema).optional()
  }),
  reviewFindingBaseSchema.extend({
    severity: z.literal("blocking"),
    evidenceRefs: z.array(evidenceIdSchema).min(1)
  })
]);

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

const reviewDecisionBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("review"),
  id: reviewIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  reviewer: actorSchema,
  verdicts: reviewVerdictsSchema,
  confidence: z.enum(["low", "medium", "high"]),
  findings: z.array(reviewFindingSchema),
  supersedes: z.array(reviewIdSchema),
  evidenceRefs: z.array(evidenceIdSchema).optional(),
  traceRefs: z.array(traceReferenceSchema).optional(),
  /**
   * Which domain competences performed this review.
   *
   * On the base schema rather than on the `accepted` member, on `acceptedBy`'s
   * rule below: `z.strictObject` would reject it everywhere else, and a review
   * that is later rejected or superseded must keep the record — the
   * architecture-and-security gate's `unsatisfied` arm reads a *rejected* domain
   * review, and it cannot read one that lost its domain on the way to being
   * rejected.
   *
   * Optional because every review artifact already on disk lacks it. A required
   * field would make `readReviewDecision` fail to parse an older review, and
   * `legion ship` would report a broken change rather than an older one — the
   * worst failure mode for a command whose job is honest reporting. Absent means
   * a legacy undifferentiated review, which the gate reports `unevaluable`,
   * never `satisfied`.
   *
   * `.min(1)` because `domains: []` is a present field asserting nothing: a
   * claim-shaped absence, over which every `some` is false and every `every` is
   * vacuously true. This tree has paid for a quantifier over a possibly-empty set
   * six times.
   */
  domains: z.array(reviewDomainSchema).min(1).optional(),
  /**
   * Who performed the *accept* transition, and when.
   *
   * `reviewer` records who produced the review, which for every review Legion
   * writes is a tool. Accepting one is a second act, by a second actor, and it
   * had nowhere to live — so a gate asking "did a human approve this" could only
   * consult `reviewer` or the existence of an accepted row, and both answer a
   * different question. These two fields are where the accept transition's actor
   * goes.
   *
   * On the base schema rather than on the `accepted` member because
   * `z.strictObject` would reject them everywhere else, and a review that is
   * later superseded must keep the record of who accepted it.
   *
   * Optional because every review artifact already on disk lacks them. A
   * required field would make `readReviewDecision` fail to parse an older
   * review, and `legion ship` would report a broken change rather than an older
   * one — the worst failure mode for a command whose job is honest reporting.
   */
  acceptedBy: actorSchema.optional(),
  acceptedAt: utcTimestampSchema.optional()
});

const openReviewDecisionFields = {
  submittedAt: utcTimestampSchema.optional()
};

const terminalReviewDecisionFields = {
  submittedAt: utcTimestampSchema
};

export const reviewDecisionSchema = z
  .discriminatedUnion("status", [
    reviewDecisionBaseSchema.extend({
      status: z.literal("requested"),
      ...openReviewDecisionFields
    }),
    reviewDecisionBaseSchema.extend({
      status: z.literal("submitted"),
      ...terminalReviewDecisionFields
    }),
    reviewDecisionBaseSchema.extend({
      status: z.literal("accepted"),
      ...terminalReviewDecisionFields
    }),
    reviewDecisionBaseSchema.extend({
      status: z.literal("rejected"),
      ...terminalReviewDecisionFields
    }),
    reviewDecisionBaseSchema.extend({
      status: z.literal("superseded"),
      ...terminalReviewDecisionFields
    }),
    reviewDecisionBaseSchema.extend({
      status: z.literal("unknown"),
      ...openReviewDecisionFields
    })
  ])
  .superRefine((reviewDecision, context) => {
    if (reviewDecision.submittedAt && new Date(reviewDecision.submittedAt).getTime() < new Date(reviewDecision.createdAt).getTime()) {
      context.addIssue({
        code: "custom",
        message: "submittedAt cannot be before createdAt.",
        path: ["submittedAt"]
      });
    }

    // A domain listed twice is one claim wearing two entries, and the gate
    // quantifies over this array and reports its length back to the operator —
    // so `["architecture", "architecture"]` would read as two competences having
    // looked. Mirrors `attestationSchema`'s duplicate guards on `sources` and
    // `covers`, and carries the same bound: unreachable through `legion review`,
    // which dedupes before it writes, and reachable through a hand-written
    // document, which is this schema's threat model.
    if (reviewDecision.domains !== undefined) {
      const seenDomains = new Set<string>();
      for (const [index, domain] of reviewDecision.domains.entries()) {
        if (seenDomains.has(domain)) {
          context.addIssue({
            code: "custom",
            message: `domains lists ${domain} more than once.`,
            path: ["domains", index]
          });
        }
        seenDomains.add(domain);
      }
    }

    // Both or neither. A gate reads `acceptedBy` to decide whether the accept
    // transition was performed by a human, so a document carrying only
    // `acceptedAt` would be an acceptance with no actor — a shape a reader has
    // to guess about, and the guesses are "nobody accepted it" and "somebody
    // did and we lost who", which lead to opposite verdicts.
    if ((reviewDecision.acceptedBy === undefined) !== (reviewDecision.acceptedAt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "acceptedBy and acceptedAt must be recorded together.",
        path: ["acceptedBy"]
      });
    }

    if (
      reviewDecision.acceptedAt &&
      reviewDecision.submittedAt &&
      new Date(reviewDecision.acceptedAt).getTime() < new Date(reviewDecision.submittedAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        message: "acceptedAt cannot be before submittedAt.",
        path: ["acceptedAt"]
      });
    }
  });

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
