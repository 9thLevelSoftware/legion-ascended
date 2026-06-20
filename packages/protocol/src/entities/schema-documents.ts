import * as z from "zod";

import { approvalSchema } from "./approval.js";
import { changeSchema } from "./change.js";
import { decisionSchema } from "./decision.js";
import { evidenceBundleSchema } from "./evidence.js";
import { observationSchema } from "./observation.js";
import { oracleSchema } from "./oracle.js";
import { projectSchema } from "./project.js";
import { releaseSchema } from "./release.js";
import { requirementSchema } from "./requirement.js";
import { reviewDecisionSchema } from "./review.js";
import { taskContractSchema } from "./task-contract.js";
import { taskRunSchema } from "./task-run.js";
import { taskSchema } from "./task.js";

export const entityFixtureCorpusSchema = z.strictObject({
  project: projectSchema,
  change: changeSchema,
  requirement: requirementSchema,
  decision: decisionSchema,
  oracle: oracleSchema
});

export type EntityFixtureCorpus = z.infer<typeof entityFixtureCorpusSchema>;

export const lifecycleFixtureCorpusSchema = z.strictObject({
  taskContract: taskContractSchema,
  task: taskSchema,
  taskRun: taskRunSchema,
  evidenceBundle: evidenceBundleSchema,
  reviewDecision: reviewDecisionSchema,
  approval: approvalSchema,
  release: releaseSchema,
  observation: observationSchema
});

export type LifecycleFixtureCorpus = z.infer<typeof lifecycleFixtureCorpusSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const lifecycleJsonSchemas = {
  taskContract: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/task-contract.schema.json",
    "Legion protocol task contract entity schema",
    taskContractSchema
  ),
  task: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/task.schema.json",
    "Legion protocol task entity schema",
    taskSchema
  ),
  taskRun: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/task-run.schema.json",
    "Legion protocol task run entity schema",
    taskRunSchema
  ),
  evidenceBundle: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/evidence.schema.json",
    "Legion protocol evidence bundle entity schema",
    evidenceBundleSchema
  ),
  reviewDecision: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/review.schema.json",
    "Legion protocol review decision entity schema",
    reviewDecisionSchema
  ),
  approval: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/approval.schema.json",
    "Legion protocol approval entity schema",
    approvalSchema
  ),
  release: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/release.schema.json",
    "Legion protocol release entity schema",
    releaseSchema
  ),
  observation: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/observation.schema.json",
    "Legion protocol observation entity schema",
    observationSchema
  )
} as const;

export const entityJsonSchemas = {
  project: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/project.schema.json",
    "Legion protocol project entity schema",
    projectSchema
  ),
  change: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/change.schema.json",
    "Legion protocol change entity schema",
    changeSchema
  ),
  requirement: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/requirement.schema.json",
    "Legion protocol requirement entity schema",
    requirementSchema
  ),
  decision: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/decision.schema.json",
    "Legion protocol decision entity schema",
    decisionSchema
  ),
  oracle: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/entities/oracle.schema.json",
    "Legion protocol oracle entity schema",
    oracleSchema
  ),
  ...lifecycleJsonSchemas
} as const;
