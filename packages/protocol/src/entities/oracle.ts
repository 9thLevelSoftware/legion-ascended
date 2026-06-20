import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import { oracleIdSchema, projectIdSchema, requirementIdSchema } from "../primitives/ids.js";
import { artifactPathSchema, artifactReferenceSchema } from "../primitives/values.js";
import { schemaMetadataSchema, traceReferenceSchema } from "./common.js";

export const oracleTypeSchema = z.enum(["executable", "inspectable", "hybrid"]);

export type OracleType = z.infer<typeof oracleTypeSchema>;

export const oracleCommandExecutionSchema = z.strictObject({
  mode: z.literal("command"),
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(256)),
  expectedExitCode: z.number().int().min(0).max(255),
  timeoutMs: z.number().int().positive().max(3_600_000)
});

export type OracleCommandExecution = z.infer<typeof oracleCommandExecutionSchema>;

export const oracleDriverExecutionSchema = z.strictObject({
  mode: z.literal("runtime-driver"),
  driver: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid oracle driver ID"),
  operation: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid oracle operation ID")
});

export type OracleDriverExecution = z.infer<typeof oracleDriverExecutionSchema>;

export const oracleInspectionExecutionSchema = z.strictObject({
  mode: z.literal("manual-inspection"),
  instructions: z.string().min(1).max(4_096)
});

export type OracleInspectionExecution = z.infer<typeof oracleInspectionExecutionSchema>;

export const oracleExecutionSchema = z.discriminatedUnion("mode", [
  oracleCommandExecutionSchema,
  oracleDriverExecutionSchema,
  oracleInspectionExecutionSchema
]);

export type OracleExecution = z.infer<typeof oracleExecutionSchema>;

export const oracleAutomatedExecutionSchema = z.discriminatedUnion("mode", [
  oracleCommandExecutionSchema,
  oracleDriverExecutionSchema
]);

export type OracleAutomatedExecution = z.infer<typeof oracleAutomatedExecutionSchema>;

export const oracleExpectedConditionsSchema = z.strictObject({
  preconditions: z.array(z.string().min(1).max(1_024)).min(1),
  postconditions: z.array(z.string().min(1).max(1_024)).min(1),
  evidence: z.array(z.string().min(1).max(256)).min(1)
});

export type OracleExpectedConditions = z.infer<typeof oracleExpectedConditionsSchema>;

export const oracleRequirementCoverageSchema = z.strictObject({
  requirementId: requirementIdSchema,
  coverage: z.enum(["primary", "partial", "regression"]),
  criteria: z.array(z.string().min(1).max(1_024)).min(1)
});

export type OracleRequirementCoverage = z.infer<typeof oracleRequirementCoverageSchema>;

const oracleBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("oracle"),
  id: oracleIdSchema,
  projectId: projectIdSchema,
  title: z.string().min(1).max(160),
  owner: actorSchema,
  protectedPaths: z.array(artifactPathSchema).min(1),
  sourceArtifacts: z.array(artifactReferenceSchema).min(1),
  expected: oracleExpectedConditionsSchema,
  requirementCoverage: z.array(oracleRequirementCoverageSchema).min(1),
  traceRefs: z.array(traceReferenceSchema).min(1)
});

export const oracleSchema = z.discriminatedUnion("type", [
  oracleBaseSchema.extend({
    type: z.literal("executable"),
    execution: oracleAutomatedExecutionSchema
  }),
  oracleBaseSchema.extend({
    type: z.literal("inspectable"),
    execution: oracleInspectionExecutionSchema
  }),
  oracleBaseSchema.extend({
    type: z.literal("hybrid"),
    execution: oracleExecutionSchema
  })
]);

export type Oracle = z.infer<typeof oracleSchema>;
