import * as z from "zod";

import {
  artifactPathSchema,
  riskTierSchema,
  contentHashSchema,
  intakeSessionIdSchema,
  projectIdSchema,
  requirementIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
  type SchemaVersion
} from "@legion/protocol";

export const REQUIREMENT_SET_SCHEMA_VERSION: SchemaVersion = schemaVersionSchema.parse("0.1.0");

export const requirementSetEntrySchema = z.strictObject({
  requirementId: requirementIdSchema,
  path: artifactPathSchema,
  sha256: contentHashSchema
});

export type RequirementSetEntry = z.infer<typeof requirementSetEntrySchema>;

/**
 * The index over a project's requirement set.
 *
 * `requirementSetHash` is a hash over the ordered requirement contents, not
 * over this file. That distinction is what makes it useful: a later command
 * recomputes the hash from the requirements on disk and compares, so an edit to
 * a requirement is detectable even when the index is rewritten to match. A
 * self-hash would only prove the index had not been corrupted.
 *
 * The ordering is significant and is the order the interview produced. Two
 * projects with the same requirements in a different order are different
 * projects — the first requirement is the one work starts from.
 */
export const requirementSetSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    kind: z.literal("requirement-set"),
    createdAt: utcTimestampSchema,
    projectId: projectIdSchema,
    /** The interview this set came from; absent for imported or generated sets. */
    intakeSessionId: intakeSessionIdSchema.optional(),
    /** The graph version the interview ran under, when there was one. */
    graphVersion: z
      .string()
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid graph version")
      .optional(),
    requirementSetHash: contentHashSchema,
    /**
     * The enforcement settings the interview collected.
     *
     * Recorded here rather than left in the session because planning has to read
     * them. An answer that is asked for, stored, and never consumed is the same
     * failure as a hash that is written and never checked: the operator believes
     * they set a limit, and nothing enforces it.
     *
     * Optional because a project initialized with `--name` never held an
     * interview. Consumers fall back to their own defaults and say so.
     */
    enforcement: z
      .strictObject({
        risk: z.strictObject({
          tier: riskTierSchema,
          reason: z.string().min(1).max(128)
        }),
        budget: z.strictObject({
          maxFilesChanged: z.number().int().positive(),
          maxLinesChanged: z.number().int().positive(),
          maxNewFiles: z.number().int().min(0)
        }),
        verification: z.strictObject({
          command: z.string().min(1).max(256),
          args: z.array(z.string().max(256)).max(64)
        })
      })
      .optional(),
    entries: z.array(requirementSetEntrySchema)
  })
  .superRefine((set, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of set.entries.entries()) {
      if (seen.has(entry.requirementId)) {
        context.addIssue({
          code: "custom",
          message: "Requirement IDs must be unique within a requirement set.",
          path: ["entries", index, "requirementId"]
        });
        continue;
      }
      seen.add(entry.requirementId);
    }

    if (set.enforcement !== undefined && set.enforcement.budget.maxNewFiles > set.enforcement.budget.maxFilesChanged) {
      context.addIssue({
        code: "custom",
        message: "A task cannot create more new files than it may change in total.",
        path: ["enforcement", "budget", "maxNewFiles"]
      });
    }

    if (set.intakeSessionId === undefined && set.graphVersion !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A graph version without an intake session has nothing to describe.",
        path: ["graphVersion"]
      });
    }
  });

export type RequirementSet = z.infer<typeof requirementSetSchema>;
