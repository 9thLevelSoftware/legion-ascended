import * as z from "zod";

import {
  eventCompatibilityFixtureSchema,
  eventEnvelopeSchema,
  eventFixtureCorpusSchema
} from "./envelope.js";

function jsonSchemaDocument(id: string, title: string, schema: z.ZodType) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...z.toJSONSchema(schema)
  };
}

export const eventJsonSchemas = {
  envelope: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/events/envelope.schema.json",
    "Legion protocol append-only event envelope schema",
    eventEnvelopeSchema
  ),
  fixtureCorpus: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/events/fixture-corpus.schema.json",
    "Legion protocol event fixture corpus schema",
    eventFixtureCorpusSchema
  ),
  compatibilityFixture: jsonSchemaDocument(
    "https://schemas.9thlevelsoftware.com/legion/events/compatibility-fixture.schema.json",
    "Legion protocol prior-minor event compatibility fixture schema",
    eventCompatibilityFixtureSchema
  )
} as const;
