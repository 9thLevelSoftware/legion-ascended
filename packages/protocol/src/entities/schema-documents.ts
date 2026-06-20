import * as z from "zod";

import { changeSchema } from "./change.js";
import { decisionSchema } from "./decision.js";
import { oracleSchema } from "./oracle.js";
import { projectSchema } from "./project.js";
import { requirementSchema } from "./requirement.js";

export const entityFixtureCorpusSchema = z.strictObject({
  project: projectSchema,
  change: changeSchema,
  requirement: requirementSchema,
  decision: decisionSchema,
  oracle: oracleSchema
});

export type EntityFixtureCorpus = z.infer<typeof entityFixtureCorpusSchema>;

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

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
  )
} as const;
