import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ENTITY_ID_KINDS,
  ENTITY_ID_PREFIXES,
  actorSchema,
  artifactPathSchema,
  artifactReferenceSchema,
  blockerSchema,
  buildIdempotencyKey,
  contentHashSchema,
  correlationIdSchema,
  createJsonValueSchema,
  formatEntityId,
  gitShaSchema,
  idempotencyKeySchema,
  metadataSchema,
  paginationCursorSchema,
  parseEntityId,
  primitiveFixtureCorpusSchema,
  primitiveJsonSchemas,
  provenanceSchema,
  protocolErrorSchema,
  schemaVersionSchema,
  utcTimestampSchema,
  validationResultSchema
} from "../dist/index.js";

const timeSortableId = "01jz8m2fj7q9k3vw5x6ybcdhnp";
const targetHash = `sha256:${"a".repeat(64)}`;

test("entity IDs are kind-prefixed and reject cross-kind parsing", () => {
  assert.equal(timeSortableId.length, 26);

  for (const kind of ENTITY_ID_KINDS) {
    const suffix = kind === "event" ? timeSortableId : `${kind}-alpha-001`;
    const id = `${ENTITY_ID_PREFIXES[kind]}_${suffix}`;

    assert.equal(formatEntityId(kind, suffix), id);
    assert.equal(parseEntityId(kind, id), id);

    for (const otherKind of ENTITY_ID_KINDS.filter((candidate) => candidate !== kind)) {
      assert.throws(() => parseEntityId(otherKind, id), /Invalid/);
    }
  }
});

test("canonical scalar primitives reject ambiguous representations", () => {
  assert.equal(utcTimestampSchema.parse("2026-06-19T19:33:27.123Z"), "2026-06-19T19:33:27.123Z");
  assert.throws(() => utcTimestampSchema.parse("2026-06-19T19:33:27Z"), /Invalid/);
  assert.throws(() => utcTimestampSchema.parse("2026-06-19T15:33:27.123-04:00"), /Invalid/);

  assert.equal(schemaVersionSchema.parse("1.2.3"), "1.2.3");
  assert.throws(() => schemaVersionSchema.parse("01.2.3"), /Invalid/);
  assert.throws(() => schemaVersionSchema.parse("1.2"), /Invalid/);

  assert.equal(contentHashSchema.parse(targetHash), targetHash);
  assert.throws(() => contentHashSchema.parse(`sha256:${"A".repeat(64)}`), /Invalid/);

  assert.equal(gitShaSchema.parse("b".repeat(40)), "b".repeat(40));
  assert.throws(() => gitShaSchema.parse("b".repeat(39)), /Invalid/);
});

test("artifact, correlation, cursor, and idempotency primitives are deterministic", () => {
  const projectId = formatEntityId("project", "legion-next");
  const changeId = formatEntityId("change", "phase-01");
  const taskId = formatEntityId("task", "p01-t03");
  const runId = formatEntityId("run", timeSortableId);

  assert.equal(artifactPathSchema.parse(".legion/project/changes/LEGION-NEXT/taskgraph.json"), ".legion/project/changes/LEGION-NEXT/taskgraph.json");
  assert.throws(() => artifactPathSchema.parse("../outside.json"), /Invalid/);
  assert.throws(() => artifactPathSchema.parse("C:\\temp\\artifact.json"), /Invalid/);

  assert.deepEqual(
    artifactReferenceSchema.parse({
      path: ".legion/project/changes/LEGION-NEXT/evidence-index.yaml",
      sha256: targetHash,
      mediaType: "application/yaml"
    }),
    {
      path: ".legion/project/changes/LEGION-NEXT/evidence-index.yaml",
      sha256: targetHash,
      mediaType: "application/yaml"
    }
  );
  assert.equal(artifactReferenceSchema.safeParse({ path: "a.txt", sha256: targetHash, extra: true }).success, false);

  assert.equal(correlationIdSchema.parse(`cor_${timeSortableId}`), `cor_${timeSortableId}`);
  assert.equal(paginationCursorSchema.parse("cur_cGFnZS0x"), "cur_cGFnZS0x");

  const key = buildIdempotencyKey({
    projectId,
    changeId,
    taskId,
    runId,
    effectKind: "git.commit",
    targetHash
  });

  assert.equal(key, `${projectId}:${changeId}:${taskId}:${runId}:git.commit:${targetHash}`);
  assert.equal(idempotencyKeySchema.parse(key), key);
  assert.throws(() => idempotencyKeySchema.parse(`${changeId}:${projectId}:${taskId}:${runId}:git.commit:${targetHash}`), /Invalid/);
});

test("strict JSON value and metadata schemas reject non-JSON or over-limit data", () => {
  const boundedJson = createJsonValueSchema({
    maxDepth: 2,
    maxStringLength: 8,
    maxArrayLength: 2,
    maxObjectKeys: 2
  });

  assert.deepEqual(boundedJson.parse({ a: ["ok", 1], b: null }), { a: ["ok", 1], b: null });
  assert.equal(boundedJson.safeParse(undefined).success, false);
  assert.equal(boundedJson.safeParse({ a: { b: { c: true } } }).success, false);
  assert.equal(boundedJson.safeParse(["one", "two", "three"]).success, false);
  assert.equal(boundedJson.safeParse("too-long-value").success, false);

  assert.deepEqual(
    metadataSchema.parse({
      labels: { risk: "r2" },
      annotations: { owner: "protocol" },
      attributes: { retryable: false, tags: ["schema"] }
    }),
    {
      labels: { risk: "r2" },
      annotations: { owner: "protocol" },
      attributes: { retryable: false, tags: ["schema"] }
    }
  );
  assert.equal(metadataSchema.safeParse({ labels: {}, unexpected: true }).success, false);
});

test("common protocol structures are strict and versioned", () => {
  const actor = actorSchema.parse({
    kind: "worker",
    id: "worker_protocol-schema-worker",
    displayName: "Protocol schema worker"
  });

  assert.deepEqual(actor, {
    kind: "worker",
    id: "worker_protocol-schema-worker",
    displayName: "Protocol schema worker"
  });
  assert.equal(actorSchema.safeParse({ ...actor, extra: true }).success, false);

  assert.equal(
    provenanceSchema.safeParse({
      actor,
      createdAt: "2026-06-19T19:33:27.123Z",
      source: "task-contract",
      schemaVersion: "1.0.0"
    }).success,
    true
  );

  assert.equal(protocolErrorSchema.safeParse({ code: "invalid_schema", message: "Schema failed", retryable: false }).success, true);
  assert.equal(blockerSchema.safeParse({ code: "missing_input", reason: "Required artifact is absent", severity: "critical" }).success, true);
  assert.equal(validationResultSchema.safeParse({ ok: true, issues: [] }).success, true);
  assert.equal(validationResultSchema.safeParse({ ok: false, issues: [{ code: "bad_id", message: "Bad ID" }] }).success, true);
  assert.equal(validationResultSchema.safeParse({ ok: false, issues: [], extra: true }).success, false);
});

test("generated primitive JSON schemas match committed artifacts", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaDirectory = join(testDirectory, "..", "..", "..", "schemas", "primitives");

  const expectedFiles = {
    ids: "ids.schema.json",
    values: "values.schema.json",
    common: "common.schema.json"
  };

  for (const [name, fileName] of Object.entries(expectedFiles)) {
    const committed = JSON.parse(await readFile(join(schemaDirectory, fileName), "utf8"));
    assert.deepEqual(committed, primitiveJsonSchemas[name]);
  }
});

test("fixture corpus captures valid and invalid primitive examples", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureDirectory = join(testDirectory, "..", "..", "..", "schemas", "primitives", "fixtures");
  const valid = JSON.parse(await readFile(join(fixtureDirectory, "valid.json"), "utf8"));
  const invalid = JSON.parse(await readFile(join(fixtureDirectory, "invalid.json"), "utf8"));

  assert.equal(primitiveFixtureCorpusSchema.safeParse(valid).success, true);

  for (const entry of invalid.cases) {
    assert.equal(primitiveFixtureCorpusSchema.safeParse(entry.value).success, false, entry.name);
  }
});
