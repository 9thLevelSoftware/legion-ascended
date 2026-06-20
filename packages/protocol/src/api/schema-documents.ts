import * as z from "zod";

import {
  apiFixtureCorpusSchema,
  commandEnvelopeSchema,
  commandResultSchema,
  queryRequestSchema,
  queryResponseSchema
} from "./contracts.js";

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const apiJsonSchemas = {
  commandEnvelope: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/api/command-envelope.schema.json",
    "Legion protocol command envelope schema",
    commandEnvelopeSchema
  ),
  commandResult: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/api/command-result.schema.json",
    "Legion protocol command result schema",
    commandResultSchema
  ),
  queryRequest: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/api/query-request.schema.json",
    "Legion protocol query request schema",
    queryRequestSchema
  ),
  queryResponse: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/api/query-response.schema.json",
    "Legion protocol query response schema",
    queryResponseSchema
  ),
  fixtureCorpus: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/api/fixture-corpus.schema.json",
    "Legion protocol API fixture corpus schema",
    apiFixtureCorpusSchema
  )
} as const;
