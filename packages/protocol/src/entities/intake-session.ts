import * as z from "zod";

import { intakeDraftIdSchema, intakeSessionIdSchema, projectIdSchema, runIdSchema } from "../primitives/ids.js";
import { artifactReferenceSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

/**
 * Durable state for a `legion start` intake session.
 *
 * The interview is a question graph owned by the CLI, not a conversation owned
 * by a model. This entity is what makes that true in practice: the cursor, the
 * answered slots, and any injected nodes live on disk, so the session survives
 * context loss and cannot be advanced by an agent that merely believes it
 * already asked something.
 */

export const intakeNodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,63}$/, "Invalid intake node ID");

export const intakeSlotIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{1,63}$/, "Invalid intake slot ID");

/**
 * Where an answer came from.
 *
 * `human` is a choice the operator made. `proposed-accepted` is a value a
 * brainstorm proposed that the operator accepted unchanged. Keeping them
 * distinct is the audit trail for where an unexamined assumption entered a
 * project — the question a retrospective actually needs to answer.
 */
export const intakeAnswerSourceSchema = z.enum(["human", "proposed-accepted", "draft-accepted"]);

export type IntakeAnswerSource = z.infer<typeof intakeAnswerSourceSchema>;

export const intakeProposalRefSchema = z.strictObject({
  runId: runIdSchema,
  anchor: z.string().min(1).max(128)
});

export type IntakeProposalRef = z.infer<typeof intakeProposalRefSchema>;

/** The immutable accepted draft and anchored answer that supplied a session value. */
export const intakeDraftAcceptanceRefSchema = z.strictObject({
  draftId: intakeDraftIdSchema,
  answerAnchor: z.string().min(1).max(128)
});

export type IntakeDraftAcceptanceRef = z.infer<typeof intakeDraftAcceptanceRefSchema>;

export const intakeAnswerSchema = z
  .strictObject({
    nodeId: intakeNodeIdSchema,
    slot: intakeSlotIdSchema,
    value: z.union([z.string().max(8_192), z.array(z.string().max(1_024)).max(64), z.boolean()]),
    answeredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    source: intakeAnswerSourceSchema,
    proposedFrom: intakeProposalRefSchema.optional(),
    draftAcceptedFrom: intakeDraftAcceptanceRefSchema.optional()
  })
  .superRefine((answer, context) => {
    // An accepted proposal must say what it came from, or the distinction
    // between "a human decided this" and "a model suggested it" is unprovable.
    if (answer.source === "proposed-accepted" && answer.proposedFrom === undefined) {
      context.addIssue({
        code: "custom",
        message: "An accepted proposal must record the exploration it came from.",
        path: ["proposedFrom"]
      });
    }
    if (answer.source === "draft-accepted" && answer.draftAcceptedFrom === undefined) {
      context.addIssue({
        code: "custom",
        message: "A draft-accepted answer must record the immutable accepted draft it came from.",
        path: ["draftAcceptedFrom"]
      });
    }
  });

export type IntakeAnswer = z.infer<typeof intakeAnswerSchema>;

/**
 * A question appended to the graph by a pre-interview brainstorm.
 *
 * Exploration may only ever *add* open questions. It cannot remove, reorder, or
 * alter a required node, so the invariant "every required node is asked"
 * survives a dynamic graph. A fuzzy idea therefore produces a longer interview,
 * not a thinner contract.
 */
export const intakeInjectedNodeSchema = z.strictObject({
  nodeId: intakeNodeIdSchema,
  slot: intakeSlotIdSchema,
  prompt: z.string().min(1).max(1_024),
  origin: intakeProposalRefSchema
});

export type IntakeInjectedNode = z.infer<typeof intakeInjectedNodeSchema>;

export const intakeExplorationRefSchema = z.strictObject({
  runId: runIdSchema,
  artifact: artifactReferenceSchema
});

export type IntakeExplorationRef = z.infer<typeof intakeExplorationRefSchema>;

export const intakeSessionStatusSchema = z.enum(["active", "finalized", "aborted"]);

export type IntakeSessionStatus = z.infer<typeof intakeSessionStatusSchema>;

export const intakeSessionSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("intake-session"),
    id: intakeSessionIdSchema,
    /** Absent until `--finalize` creates the project. */
    projectId: projectIdSchema.optional(),
    /** Pins the graph revision this session started under. */
    graphVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid graph version"),
    status: intakeSessionStatusSchema,
    explorationRef: intakeExplorationRefSchema.optional(),
    /** `undefined` once every required node has been answered. */
    cursor: intakeNodeIdSchema.optional(),
    answers: z.array(intakeAnswerSchema),
    injectedNodes: z.array(intakeInjectedNodeSchema),
    diagnostics: z.array(z.string().min(1).max(1_024))
  })
  .superRefine((session, context) => {
    const seenNodes = new Map<string, number>();
    for (const [index, answer] of session.answers.entries()) {
      const previous = seenNodes.get(answer.nodeId);
      if (previous === undefined) {
        seenNodes.set(answer.nodeId, index);
        continue;
      }
      context.addIssue({
        code: "custom",
        message: "Each intake node may be answered at most once; re-answering replaces the entry.",
        path: ["answers", index, "nodeId"]
      });
    }

    const injectedIds = new Set<string>();
    for (const [index, node] of session.injectedNodes.entries()) {
      if (injectedIds.has(node.nodeId)) {
        context.addIssue({
          code: "custom",
          message: "Injected intake node IDs must be unique.",
          path: ["injectedNodes", index, "nodeId"]
        });
        continue;
      }
      injectedIds.add(node.nodeId);
    }

    // A finalized session is the provenance record for a project's requirement
    // set. Leaving it finalized with an open cursor would mean the contract was
    // written before the interview finished.
    if (session.status === "finalized" && session.cursor !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A finalized intake session cannot still have an open cursor.",
        path: ["cursor"]
      });
    }

    if (session.status === "finalized" && session.projectId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A finalized intake session must record the project it created.",
        path: ["projectId"]
      });
    }
  });

export type IntakeSession = z.infer<typeof intakeSessionSchema>;
