import * as z from "zod";

import { projectIdSchema, runIdSchema } from "../primitives/ids.js";
import { schemaMetadataSchema } from "./common.js";
import { intakeNodeIdSchema, intakeSlotIdSchema } from "./intake-session.js";

/**
 * The product of a freeform pre-interview brainstorm.
 *
 * `legion start` is a hard-structured question graph, which presumes the shape
 * of the work is already known. When it is not, bounded choices arrive too
 * early and a model ends up inventing options for a space nobody has explored.
 * The fix is a deliberately loose divergent step before the graph — not a
 * looser graph. The leash lengths are opposite on purpose: exploration is where
 * wide latitude is correct, precisely because nothing it produces is
 * authoritative.
 *
 * Two invariants keep that safe, and both are structural here rather than
 * advisory:
 *
 *  1. **An exploration proposes; it never authors.** `status` is the literal
 *     `"exploratory"` with no other permitted value, so no code path can mark
 *     one accepted. Its `proposals` enter the intake graph as pre-filled
 *     suggestions that a human must still confirm per node.
 *  2. **An exploration adds questions; it never removes them.** Unresolved
 *     `openQuestions` become *required* intake nodes. A fuzzy idea therefore
 *     produces a longer interview, not a thinner contract — the inverse of the
 *     v8 behaviour, where exploration's open questions had no destination and
 *     silently evaporated at initialization.
 */

export const explorationEntrySchema = z.enum([
  "raw-idea",
  "pasted-spec",
  "existing-codebase",
  "link"
]);

export type ExplorationEntry = z.infer<typeof explorationEntrySchema>;

/**
 * A suggested answer for an intake slot.
 *
 * `slot` reuses the intake slot ID type so a proposal cannot name a slot shape
 * the graph could never accept, and `anchor` lets the recorded answer cite
 * exactly where in the exploration it came from.
 */
export const explorationProposalSchema = z.strictObject({
  slot: intakeSlotIdSchema,
  value: z.union([z.string().max(8_192), z.array(z.string().max(1_024)).max(64)]),
  rationale: z.string().min(1).max(2_048),
  anchor: z.string().min(1).max(128),
  /**
   * How much the exploration actually established this, as opposed to assumed
   * it. A low-confidence proposal is still only a proposal, but the operator
   * deserves to see which suggestions rest on nothing.
   */
  confidence: z.enum(["researched", "inferred", "assumed"])
});

export type ExplorationProposal = z.infer<typeof explorationProposalSchema>;

/**
 * A decision the exploration could not settle.
 *
 * `nodeId` is an intake node ID because that is what this becomes: a required
 * question appended to the graph.
 */
export const explorationOpenQuestionSchema = z.strictObject({
  nodeId: intakeNodeIdSchema,
  slot: intakeSlotIdSchema,
  question: z.string().min(1).max(1_024),
  why: z.string().min(1).max(1_024)
});

export type ExplorationOpenQuestion = z.infer<typeof explorationOpenQuestionSchema>;

export const explorationSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("exploration"),
    /** The guidance run that produced this exploration. */
    runId: runIdSchema,
    projectId: projectIdSchema.optional(),
    /**
     * Not a status enum. An exploration has exactly one status, forever: it is
     * a suggestion. Nothing downstream may treat it as a requirement.
     */
    status: z.literal("exploratory"),
    entry: explorationEntrySchema,
    topic: z.string().min(1).max(256),
    summary: z.string().min(1).max(4_096),
    proposals: z.array(explorationProposalSchema),
    openQuestions: z.array(explorationOpenQuestionSchema),
    /** Free prose from the brainstorm, kept for human reading. */
    notes: z.array(z.strictObject({
      heading: z.string().min(1).max(128),
      body: z.string().min(1).max(16_384)
    }))
  })
  .superRefine((exploration, context) => {
    const seenSlots = new Map<string, number>();
    for (const [index, proposal] of exploration.proposals.entries()) {
      const previous = seenSlots.get(proposal.slot);
      if (previous === undefined) {
        seenSlots.set(proposal.slot, index);
        continue;
      }
      context.addIssue({
        code: "custom",
        message: "An exploration may propose at most one value per intake slot.",
        path: ["proposals", index, "slot"]
      });
    }

    const seenNodes = new Map<string, number>();
    for (const [index, question] of exploration.openQuestions.entries()) {
      const previous = seenNodes.get(question.nodeId);
      if (previous === undefined) {
        seenNodes.set(question.nodeId, index);
        continue;
      }
      context.addIssue({
        code: "custom",
        message: "Open question node IDs must be unique within an exploration.",
        path: ["openQuestions", index, "nodeId"]
      });
    }

    // A slot cannot be both answered and asked. If the exploration left a
    // decision open, its proposal is not a proposal — it is a guess wearing
    // one, and accepting it would let the interview skip the question the
    // exploration itself said was unresolved.
    for (const [index, question] of exploration.openQuestions.entries()) {
      if (!seenSlots.has(question.slot)) continue;
      context.addIssue({
        code: "custom",
        message: "A slot cannot carry a proposal and remain an open question; resolve one or the other.",
        path: ["openQuestions", index, "slot"]
      });
    }
  });

export type Exploration = z.infer<typeof explorationSchema>;
