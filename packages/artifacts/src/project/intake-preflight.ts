import * as z from "zod";

import {
  artifactReferenceSchema,
  artifactPathSchema,
  intakeDraftIdSchema,
  intakeSessionIdSchema,
  runIdSchema,
  utcTimestampSchema
} from "@legion/protocol";

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u, "Invalid source fingerprint");
const guidanceDirectoryIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/u);

export const intakePreflightMapDiagnosticSchema = z.strictObject({
  runId: guidanceDirectoryIdSchema,
  code: z.enum([
    "map_artifact_path_invalid",
    "map_artifact_unreadable",
    "map_artifact_json_invalid",
    "map_artifact_schema_invalid",
    "map_artifact_duplicate_path",
    "map_artifact_unsafe_path",
    "map_artifact_count_mismatch",
    "map_artifact_fingerprint_mismatch"
  ]),
  message: z.string().min(1)
});

export const intakePreflightMapStateSchema = z.strictObject({
  freshness: z.enum(["fresh", "stale", "partial", "absent"]),
  reason: z.string().min(1),
  scope: z.string().min(1),
  sourceFingerprint: fingerprintSchema,
  sourceFileCount: z.number().int().nonnegative(),
  latestSourceFingerprint: fingerprintSchema.nullable(),
  generatedAt: utcTimestampSchema.nullable(),
  ageDays: z.number().finite().nullable(),
  mapArtifact: artifactReferenceSchema.nullable().optional(),
  diagnostics: z.array(intakePreflightMapDiagnosticSchema).optional()
});

export const intakePreflightExplorationCandidateSchema = z.strictObject({
  runId: guidanceDirectoryIdSchema,
  explorationRunId: runIdSchema,
  artifactPath: artifactPathSchema,
  createdAt: utcTimestampSchema,
  topic: z.string().min(1).max(256)
});

export const intakePreflightDiagnosticSchema = z.strictObject({
  runId: guidanceDirectoryIdSchema,
  code: z.enum(["not_completed", "unrelated_next_action", "unreadable", "competing_candidate"]),
  message: z.string().min(1)
});

export const intakePreflightInitiativeSchema = z.discriminatedUnion("source", [
  z.strictObject({
    value: z.string().min(1).max(4_096),
    source: z.literal("explicit")
  }),
  z.strictObject({
    value: z.string().min(1).max(4_096),
    source: z.literal("exploration"),
    explorationRunId: guidanceDirectoryIdSchema
  })
]);

export const intakePreflightMapFailureSchema = z.strictObject({
  message: z.string().min(1).max(2_048),
  reportedAt: utcTimestampSchema
});

export const intakePreflightExplorationSelectionIntentSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("automatic") }),
  z.strictObject({ mode: z.literal("explicit"), runId: guidanceDirectoryIdSchema }),
  z.strictObject({ mode: z.literal("none") })
]);

export const intakePreflightStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["preflight", "draft_review", "interview"]),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  projectMode: z.enum(["greenfield", "documentation-only", "brownfield"]),
  map: z.union([intakePreflightMapStateSchema, z.strictObject({ error: z.string().min(1) })]),
  compatibleExplorations: z.array(intakePreflightExplorationCandidateSchema),
  explorationSelectionIntent: intakePreflightExplorationSelectionIntentSchema,
  selectedExplorationRunId: guidanceDirectoryIdSchema.optional(),
  initiative: intakePreflightInitiativeSchema.optional(),
  mapFailure: intakePreflightMapFailureSchema.optional(),
  activeDraftId: intakeDraftIdSchema.optional(),
  activeSessionId: intakeSessionIdSchema.optional(),
  diagnostics: z.array(intakePreflightDiagnosticSchema)
});

export type IntakePreflightState = z.infer<typeof intakePreflightStateSchema>;

export function isIntakePreflightRecord(value: unknown): value is IntakePreflightState {
  return intakePreflightStateSchema.safeParse(value).success;
}
