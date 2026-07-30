import * as z from "zod";

import {
  artifactPathSchema,
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

    if (set.intakeSessionId === undefined && set.graphVersion !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A graph version without an intake session has nothing to describe.",
        path: ["graphVersion"]
      });
    }
  });

export type RequirementSet = z.infer<typeof requirementSetSchema>;
