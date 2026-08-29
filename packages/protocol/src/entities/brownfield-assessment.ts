import * as z from "zod";

import {
  codeIndexFactIdSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotIdSchema,
  codeIndexSourcePathSchema
} from "./code-index.js";
import { artifactPathSchema, utcTimestampSchema } from "../primitives/values.js";

export const assessmentEffortSchema = z.number().int().min(1).max(5);

export type AssessmentEffort = z.infer<typeof assessmentEffortSchema>;

export const assessmentPhaseSchema = z.enum([
  "setup",
  "signals",
  "specialists",
  "assumptions",
  "synthesis",
  "review",
  "complete",
  "blocked"
]);

export type AssessmentPhase = z.infer<typeof assessmentPhaseSchema>;

export const assessmentConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);

export type AssessmentConfidence = z.infer<typeof assessmentConfidenceSchema>;

export const assessmentEvidenceKindSchema = z.enum([
  "structural-fact",
  "source-file",
  "manifest",
  "test-result",
  "command-result",
  "git-metadata",
  "user-input"
]);

export type AssessmentEvidenceKind = z.infer<typeof assessmentEvidenceKindSchema>;

export const assessmentSeveritySchema = z.enum(["critical", "major", "moderate", "minor", "informational"]);

export type AssessmentSeverity = z.infer<typeof assessmentSeveritySchema>;

export const assessmentSpecialistSchema = z.enum([
  "architecture",
  "code",
  "tests",
  "security",
  "product-intent",
  "documentation"
]);

export type AssessmentSpecialist = z.infer<typeof assessmentSpecialistSchema>;

export const assessmentIdSchema = z
  .string()
  .regex(/^assess_[a-f0-9]{24}$/, "Invalid brownfield assessment ID")
  .brand<"AssessmentId">();

export type AssessmentId = z.infer<typeof assessmentIdSchema>;

export const assessmentAssumptionIdSchema = z
  .string()
  .regex(/^asm_[a-f0-9]{24}$/, "Invalid brownfield assessment assumption ID")
  .brand<"AssessmentAssumptionId">();

export type AssessmentAssumptionId = z.infer<typeof assessmentAssumptionIdSchema>;

export const assessmentFindingIdSchema = z
  .string()
  .regex(/^af_[a-f0-9]{24}$/, "Invalid brownfield assessment finding ID")
  .brand<"AssessmentFindingId">();

export type AssessmentFindingId = z.infer<typeof assessmentFindingIdSchema>;

const assessmentArtifactEvidenceFields = {
  path: artifactPathSchema,
  note: z.string().min(1).max(512)
} as const;

export const assessmentEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("structural-fact"),
    ...assessmentArtifactEvidenceFields,
    sha256: codeIndexSha256Schema.optional(),
    factId: codeIndexFactIdSchema
  }),
  z.strictObject({
    kind: z.literal("source-file"),
    path: codeIndexSourcePathSchema,
    sha256: codeIndexSha256Schema,
    note: assessmentArtifactEvidenceFields.note
  }),
  z.strictObject({ kind: z.literal("manifest"), ...assessmentArtifactEvidenceFields }),
  z.strictObject({ kind: z.literal("test-result"), ...assessmentArtifactEvidenceFields }),
  z.strictObject({ kind: z.literal("command-result"), ...assessmentArtifactEvidenceFields }),
  z.strictObject({ kind: z.literal("git-metadata"), ...assessmentArtifactEvidenceFields }),
  z.strictObject({ kind: z.literal("user-input"), ...assessmentArtifactEvidenceFields })
]);

export type AssessmentEvidenceRef = z.infer<typeof assessmentEvidenceRefSchema>;

export const assessmentAssumptionSchema = z.strictObject({
  id: assessmentAssumptionIdSchema,
  statement: z.string().min(1).max(2_000),
  confidence: assessmentConfidenceSchema,
  blocking: z.boolean(),
  resolution: z.string().min(1).max(1_000),
  evidence: z.array(assessmentEvidenceRefSchema).min(1).max(64)
});

export type AssessmentAssumption = z.infer<typeof assessmentAssumptionSchema>;

export const assessmentFindingSchema = z.strictObject({
  id: assessmentFindingIdSchema,
  specialist: assessmentSpecialistSchema,
  title: z.string().min(1).max(256),
  statement: z.string().min(1).max(4_000),
  severity: assessmentSeveritySchema,
  confidence: assessmentConfidenceSchema,
  evidence: z.array(assessmentEvidenceRefSchema).min(1).max(128),
  assumptions: z.array(assessmentAssumptionIdSchema).max(32),
  recommendation: z.string().min(1).max(4_000)
});

export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>;

export const assessmentSignalSummarySchema = z.strictObject({
  sourceFiles: z.number().int().nonnegative(),
  coverageFiles: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  imports: z.number().int().nonnegative(),
  exports: z.number().int().nonnegative(),
  testFiles: z.number().int().nonnegative(),
  testToSourceLinks: z.number().int().nonnegative(),
  dependencyEdges: z.number().int().nonnegative(),
  highRiskSignals: z.number().int().nonnegative(),
  unsupportedSignals: z.number().int().nonnegative()
});

export type AssessmentSignalSummary = z.infer<typeof assessmentSignalSummarySchema>;

export const brownfieldAssessmentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("brownfield_assessment"),
    assessmentId: assessmentIdSchema,
    generatedAt: utcTimestampSchema,
    effort: assessmentEffortSchema,
    phase: assessmentPhaseSchema,
    repositoryRoot: artifactPathSchema,
    scope: z.union([z.literal("."), codeIndexSourcePathSchema]),
    snapshotId: codeIndexSnapshotIdSchema,
    sourceFingerprint: codeIndexSha256Schema,
    semanticIndexSha256: codeIndexSha256Schema,
    semanticSqliteSha256: codeIndexSha256Schema,
    signals: assessmentSignalSummarySchema,
    assumptions: z.array(assessmentAssumptionSchema).max(256),
    findings: z.array(assessmentFindingSchema).max(2_000),
    nextActions: z.array(z.string().min(1).max(1_000)).max(64)
  })
  .describe(
    "Runtime validation requires unique assumption and finding IDs; every finding assumption reference must resolve to an assumption in the same assessment and must not repeat within a finding."
  )
  .superRefine((assessment, context) => {
    const assumptionIds = new Set<string>();
    for (const [index, assumption] of assessment.assumptions.entries()) {
      if (assumptionIds.has(assumption.id)) {
        context.addIssue({
          code: "custom",
          message: "Brownfield assessment assumption IDs must be unique.",
          path: ["assumptions", index, "id"]
        });
      }
      assumptionIds.add(assumption.id);
    }

    const findingIds = new Set<string>();
    for (const [index, finding] of assessment.findings.entries()) {
      if (findingIds.has(finding.id)) {
        context.addIssue({
          code: "custom",
          message: "Brownfield assessment finding IDs must be unique.",
          path: ["findings", index, "id"]
        });
      }
      findingIds.add(finding.id);

      const assumptionRefs = new Set<string>();
      for (const [assumptionIndex, assumptionId] of finding.assumptions.entries()) {
        if (assumptionRefs.has(assumptionId)) {
          context.addIssue({
            code: "custom",
            message: "Finding assumption references must be unique within a finding.",
            path: ["findings", index, "assumptions", assumptionIndex]
          });
        }
        if (!assumptionIds.has(assumptionId)) {
          context.addIssue({
            code: "custom",
            message: "Finding assumption references must resolve within the same assessment.",
            path: ["findings", index, "assumptions", assumptionIndex]
          });
        }
        assumptionRefs.add(assumptionId);
      }
    }
  });

export type BrownfieldAssessment = z.infer<typeof brownfieldAssessmentSchema>;
