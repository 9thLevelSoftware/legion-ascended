import * as z from "zod";

import { intakeDraftIdSchema, runIdSchema } from "../primitives/ids.js";
import { artifactReferenceSchema } from "../primitives/values.js";
import {
  intakeInjectedNodeSchema,
  intakeNodeIdSchema,
  intakeSlotIdSchema
} from "./intake-session.js";
import { schemaMetadataSchema } from "./common.js";

const answerValueSchema = z.union([
  z.string().max(8_192),
  z.array(z.string().max(1_024)).max(64),
  z.boolean()
]);

const anchorSchema = z.string().min(1).max(128);

/** A SHA-256 digest emitted by the deterministic codebase-map workflow. */
export const codebaseMapFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Invalid codebase map source fingerprint");

/**
 * Evidence a draft used to make a proposal.
 *
 * Every reference carries the immutable artifact or file digest that the CLI
 * rechecks before accepting the draft. A map also carries its source-set
 * fingerprint, which detects drift even when the map artifact itself survives.
 */
export const intakeDraftExplorationEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("exploration"),
  runId: runIdSchema,
  artifact: artifactReferenceSchema,
  anchor: anchorSchema.optional()
});

export const intakeDraftCodebaseMapEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("codebase-map"),
  artifact: artifactReferenceSchema,
  sourceFingerprint: codebaseMapFingerprintSchema
});

export const intakeDraftRepositoryFileEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("repository-file"),
  artifact: artifactReferenceSchema,
  anchor: anchorSchema.optional()
});

export const intakeDraftEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  intakeDraftExplorationEvidenceReferenceSchema,
  intakeDraftCodebaseMapEvidenceReferenceSchema,
  intakeDraftRepositoryFileEvidenceReferenceSchema
]);

export type IntakeDraftEvidenceReference = z.infer<typeof intakeDraftEvidenceReferenceSchema>;

export const intakeDraftStatusSchema = z.enum(["draft", "accepted", "discarded", "invalidated"]);

export type IntakeDraftStatus = z.infer<typeof intakeDraftStatusSchema>;

export const intakeProjectModeSchema = z.enum(["greenfield", "documentation-only", "brownfield"]);

export type IntakeProjectMode = z.infer<typeof intakeProjectModeSchema>;

export const intakeDraftAnswerSchema = z.strictObject({
  nodeId: intakeNodeIdSchema,
  slot: intakeSlotIdSchema,
  value: answerValueSchema,
  confidence: z.enum(["researched", "inferred", "assumed"]),
  rationale: z.string().min(1).max(2_048),
  /** Stable anchor used by later `draft-accepted` answer provenance. */
  answerAnchor: anchorSchema,
  evidenceRefs: z.array(intakeDraftEvidenceReferenceSchema).max(32)
});

export type IntakeDraftAnswer = z.infer<typeof intakeDraftAnswerSchema>;

export const intakeDraftUnresolvedNodeSchema = z.strictObject({
  nodeId: intakeNodeIdSchema,
  slot: intakeSlotIdSchema,
  question: z.string().min(1).max(1_024),
  rationale: z.string().min(1).max(2_048),
  evidenceRefs: z.array(intakeDraftEvidenceReferenceSchema).max(32)
});

export type IntakeDraftUnresolvedNode = z.infer<typeof intakeDraftUnresolvedNodeSchema>;

/**
 * Durable, reviewable intake materialization before an intake session exists.
 *
 * It deliberately stores suggestions separately from the CLI-owned question
 * graph. The CLI can revalidate every evidence reference before acceptance,
 * then carry only valid answers into a graph-pinned session.
 */
export const intakeDraftSchema = schemaMetadataSchema
  .extend({
    kind: z.literal("intake-draft"),
    id: intakeDraftIdSchema,
    status: intakeDraftStatusSchema,
    graphVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid graph version"),
    projectMode: intakeProjectModeSchema,
    initiative: z.string().min(1).max(4_096),
    explorationRefs: z.array(intakeDraftExplorationEvidenceReferenceSchema).max(16),
    codebaseMapRef: intakeDraftCodebaseMapEvidenceReferenceSchema.optional(),
    proposedAnswers: z.array(intakeDraftAnswerSchema).max(512),
    injectedQuestions: z.array(intakeInjectedNodeSchema).max(128),
    unresolvedNodes: z.array(intakeDraftUnresolvedNodeSchema).max(128),
    diagnostics: z.array(z.string().min(1).max(1_024)).max(128)
  })
  .superRefine((draft, context) => {
    const answeredNodes = new Set<string>();
    const answeredSlots = new Set<string>();
    const answerAnchors = new Set<string>();
    for (const [index, answer] of draft.proposedAnswers.entries()) {
      if (answeredNodes.has(answer.nodeId)) {
        context.addIssue({ code: "custom", message: "A draft may propose at most one answer per intake node.", path: ["proposedAnswers", index, "nodeId"] });
      }
      if (answeredSlots.has(answer.slot)) {
        context.addIssue({ code: "custom", message: "A draft may propose at most one answer per intake slot.", path: ["proposedAnswers", index, "slot"] });
      }
      if (answerAnchors.has(answer.answerAnchor)) {
        context.addIssue({ code: "custom", message: "Draft answer anchors must be unique.", path: ["proposedAnswers", index, "answerAnchor"] });
      }
      answeredNodes.add(answer.nodeId);
      answeredSlots.add(answer.slot);
      answerAnchors.add(answer.answerAnchor);
    }

    const injectedNodes = new Set<string>();
    for (const [index, question] of draft.injectedQuestions.entries()) {
      if (injectedNodes.has(question.nodeId)) {
        context.addIssue({ code: "custom", message: "Injected draft question node IDs must be unique.", path: ["injectedQuestions", index, "nodeId"] });
      }
      injectedNodes.add(question.nodeId);
    }

    const unresolvedNodes = new Set<string>();
    const unresolvedSlots = new Set<string>();
    for (const [index, node] of draft.unresolvedNodes.entries()) {
      if (unresolvedNodes.has(node.nodeId)) {
        context.addIssue({ code: "custom", message: "Unresolved draft node IDs must be unique.", path: ["unresolvedNodes", index, "nodeId"] });
      }
      if (unresolvedSlots.has(node.slot)) {
        context.addIssue({ code: "custom", message: "Unresolved draft slots must be unique.", path: ["unresolvedNodes", index, "slot"] });
      }
      if (answeredNodes.has(node.nodeId) || answeredSlots.has(node.slot)) {
        context.addIssue({ code: "custom", message: "A draft node cannot be proposed and unresolved at the same time.", path: ["unresolvedNodes", index, "nodeId"] });
      }
      unresolvedNodes.add(node.nodeId);
      unresolvedSlots.add(node.slot);
    }
  });

export type IntakeDraft = z.infer<typeof intakeDraftSchema>;
