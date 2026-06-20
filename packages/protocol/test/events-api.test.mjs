import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  API_COMMAND_TYPES,
  COMMAND_CATALOG,
  EVENT_CATALOG,
  EVENT_TYPES,
  STATE_CHANGING_COMMAND_TYPES,
  apiContractDocumentation,
  apiFixtureCorpusSchema,
  apiJsonSchemas,
  assertEventHandlerCoverage,
  commandEnvelopeSchema,
  commandResultSchema,
  eventCompatibilityFixtureSchema,
  eventContractDocumentation,
  eventEnvelopeSchema,
  eventFixtureCorpusSchema,
  eventJsonSchemas,
  isDuplicateEventEnvelope,
  normalizeEventEnvelope,
  queryRequestSchema,
  queryResponseSchema
} from "../dist/index.js";

async function readFixture(group, name) {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureDirectory = join(testDirectory, "..", "..", "..", "schemas", group, "fixtures");
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

test("P01-T06 event fixture corpus parses and serializes identically", async () => {
  const valid = await readFixture("events", "valid.json");

  assert.deepEqual(eventFixtureCorpusSchema.parse(valid), valid);

  for (const event of valid.events) {
    assert.deepEqual(eventEnvelopeSchema.parse(event), event);
  }
});

test("P01-T06 event catalog is closed, factual, and exhaustively coverable", () => {
  assert.ok(EVENT_TYPES.includes("task.claimed.v1"));
  assert.ok(EVENT_TYPES.includes("integration.effect_succeeded.v1"));
  assert.ok(EVENT_TYPES.includes("migration.applied.v1"));

  assert.deepEqual(
    EVENT_CATALOG.map((entry) => entry.type),
    EVENT_TYPES
  );

  for (const type of EVENT_TYPES) {
    assert.match(type, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v1$/);
    assert.doesNotMatch(type, /\.(create|claim|block|complete|retry|invalidate|run|deploy)\.v1$/);
  }

  assert.doesNotThrow(() => assertEventHandlerCoverage(new Set(EVENT_TYPES)));
  assert.throws(() => assertEventHandlerCoverage(new Set(EVENT_TYPES.slice(1))), /Missing event handler coverage/);
});

test("P01-T06 event envelopes reject transport details and imperative payloads", async () => {
  const valid = await readFixture("events", "valid.json");
  const taskClaimed = valid.events.find((event) => event.type === "task.claimed.v1");

  assert.ok(taskClaimed, "valid fixtures must include task.claimed.v1");
  assert.equal(eventEnvelopeSchema.safeParse({ ...taskClaimed, httpStatus: 202 }).success, false);
  assert.equal(
    eventEnvelopeSchema.safeParse({
      ...taskClaimed,
      payload: {
        ...taskClaimed.payload,
        command: "claim"
      }
    }).success,
    false
  );
  assert.equal(eventEnvelopeSchema.safeParse({ ...taskClaimed, version: 2 }).success, false);
});

test("P01-T06 duplicate events are recognized by event ID or idempotency key", async () => {
  const valid = await readFixture("events", "valid.json");
  const [first, second] = valid.events;

  assert.equal(isDuplicateEventEnvelope(first, { ...second, id: first.id }), true);
  assert.equal(isDuplicateEventEnvelope(first, { ...second, idempotencyKey: first.idempotencyKey }), true);
  assert.equal(
    isDuplicateEventEnvelope(first, {
      ...second,
      id: "evt_01k0abcdfghjkmnpqrstvwxyza",
      idempotencyKey: "prj_legion-next:chg_phase-01-protocol:tsk_p01-t06-events:run_p01-t06-events:git.push:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }),
    false
  );
});

test("P01-T06 prior minor event compatibility fixtures normalize to current envelopes", async () => {
  const legacy = await readFixture("events", "compat-v0.0.json");

  assert.equal(eventCompatibilityFixtureSchema.safeParse(legacy).success, true);

  const normalized = normalizeEventEnvelope(legacy);
  assert.equal(normalized.schemaVersion, "0.1.0");
  assert.deepEqual(eventEnvelopeSchema.parse(normalized), normalized);
});

test("P01-T06 API fixture corpus parses commands, results, and queries", async () => {
  const valid = await readFixture("api", "valid.json");

  assert.deepEqual(apiFixtureCorpusSchema.parse(valid), valid);

  for (const command of valid.commands) {
    assert.deepEqual(commandEnvelopeSchema.parse(command), command);
  }

  for (const result of valid.commandResults) {
    assert.deepEqual(commandResultSchema.parse(result), result);
  }

  for (const request of valid.queryRequests) {
    assert.deepEqual(queryRequestSchema.parse(request), request);
  }

  for (const response of valid.queryResponses) {
    assert.deepEqual(queryResponseSchema.parse(response), response);
  }
});

test("P01-T06 every state-changing command has success and typed rejection results", () => {
  assert.ok(API_COMMAND_TYPES.includes("task.claim.v1"));

  for (const type of STATE_CHANGING_COMMAND_TYPES) {
    const entry = COMMAND_CATALOG[type];
    assert.ok(entry, `missing command catalog entry for ${type}`);
    assert.equal(entry.stateChanging, true);
    assert.match(entry.result.successType, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.accepted\.v1$/);
    assert.match(entry.result.rejectionType, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.rejected\.v1$/);
    assert.ok(entry.result.rejectionCodes.length > 0, `missing rejection codes for ${type}`);
  }
});

test("P01-T06 API contracts reject transport-specific response fields", async () => {
  const valid = await readFixture("api", "valid.json");
  const command = valid.commands[0];
  const responseWithCursor = valid.queryResponses.find((response) => response.pagination?.nextCursor);

  assert.ok(responseWithCursor, "valid fixtures must include cursor pagination");
  assert.equal(commandEnvelopeSchema.safeParse({ ...command, method: "POST" }).success, false);
  assert.equal(queryRequestSchema.safeParse({ ...valid.queryRequests[0], path: "/api/board" }).success, false);
  assert.equal(queryResponseSchema.safeParse({ ...responseWithCursor, httpStatus: 200 }).success, false);
});

test("P01-T06 generated event and API JSON schemas match committed artifacts", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const rootDirectory = join(testDirectory, "..", "..", "..");

  const eventFiles = {
    envelope: "envelope.schema.json",
    fixtureCorpus: "fixture-corpus.schema.json",
    compatibilityFixture: "compatibility-fixture.schema.json"
  };
  const apiFiles = {
    commandEnvelope: "command-envelope.schema.json",
    commandResult: "command-result.schema.json",
    queryRequest: "query-request.schema.json",
    queryResponse: "query-response.schema.json",
    fixtureCorpus: "fixture-corpus.schema.json"
  };

  for (const [name, fileName] of Object.entries(eventFiles)) {
    const committed = JSON.parse(await readFile(join(rootDirectory, "schemas", "events", fileName), "utf8"));
    assert.deepEqual(committed, eventJsonSchemas[name]);
  }

  for (const [name, fileName] of Object.entries(apiFiles)) {
    const committed = JSON.parse(await readFile(join(rootDirectory, "schemas", "api", fileName), "utf8"));
    assert.deepEqual(committed, apiJsonSchemas[name]);
  }
});

test("P01-T06 generated contract documentation snapshots describe ordering and duplicates", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const rootDirectory = join(testDirectory, "..", "..", "..");

  assert.equal(
    await readFile(join(rootDirectory, "schemas", "events", "README.md"), "utf8"),
    `${eventContractDocumentation}\n`
  );
  assert.equal(
    await readFile(join(rootDirectory, "schemas", "api", "README.md"), "utf8"),
    `${apiContractDocumentation}\n`
  );
});
