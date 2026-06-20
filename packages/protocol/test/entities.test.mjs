import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  changeSchema,
  decisionSchema,
  entityFixtureCorpusSchema,
  entityJsonSchemas,
  oracleSchema,
  projectSchema,
  requirementSchema
} from "../dist/index.js";

async function readEntityFixture(name) {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureDirectory = join(testDirectory, "..", "..", "..", "schemas", "entities", "fixtures");
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

test("P01-T04 valid entity fixture corpus parses and serializes identically", async () => {
  const valid = await readEntityFixture("valid.json");

  assert.deepEqual(entityFixtureCorpusSchema.parse(valid), valid);
});

test("P01-T04 entity schemas reject mutable operational state and missing required fields", async () => {
  const valid = await readEntityFixture("valid.json");

  assert.equal(projectSchema.safeParse({ ...valid.project, activeLease: "lease_001" }).success, false);
  assert.equal(changeSchema.safeParse({ ...valid.change, queueState: { status: "claimed" } }).success, false);
  assert.equal(oracleSchema.safeParse({ ...valid.oracle, runtimeSession: "eve_session_001" }).success, false);

  const { baseSpecHash, ...changeWithoutBaseHash } = valid.change.currentTruth;
  assert.equal(changeSchema.safeParse({ ...valid.change, currentTruth: changeWithoutBaseHash }).success, false);

  const { acceptance, ...requirementWithoutAcceptance } = valid.requirement;
  assert.equal(requirementSchema.safeParse(requirementWithoutAcceptance).success, false);

  const { protectedPaths, ...oracleWithoutProtectedPaths } = valid.oracle;
  assert.equal(oracleSchema.safeParse(oracleWithoutProtectedPaths).success, false);
});

test("P01-T04 change schemas keep current truth and proposed metadata distinct", async () => {
  const { change } = await readEntityFixture("valid.json");

  assert.equal(changeSchema.safeParse(change).success, true);
  assert.equal(
    changeSchema.safeParse({
      ...change,
      proposedTruth: {
        ...change.proposedTruth,
        specRefs: change.currentTruth.specRefs
      }
    }).success,
    false
  );
  assert.equal(
    changeSchema.safeParse({
      ...change,
      currentTruth: {
        ...change.currentTruth,
        deltaSpecRefs: change.proposedTruth.deltaSpecRefs
      }
    }).success,
    false
  );
});

test("P01-T04 trace references bind entity kind to matching ID prefix", async () => {
  const { requirement } = await readEntityFixture("valid.json");

  assert.equal(
    requirementSchema.safeParse({
      ...requirement,
      traceRefs: [
        {
          ...requirement.traceRefs[0],
          entity: {
            kind: "requirement",
            id: "chg_phase-01-protocol"
          }
        }
      ]
    }).success,
    false
  );
});

test("P01-T04 oracle ownership and protection are explicit", async () => {
  const { oracle } = await readEntityFixture("valid.json");

  assert.equal(oracleSchema.safeParse(oracle).success, true);
  assert.equal(oracleSchema.safeParse({ ...oracle, owner: undefined }).success, false);
  assert.equal(oracleSchema.safeParse({ ...oracle, protectedPaths: [] }).success, false);
  assert.equal(oracleSchema.safeParse({ ...oracle, requirementCoverage: [] }).success, false);
});

test("P01-T04 decisions can be superseded without rewriting history", async () => {
  const { decision } = await readEntityFixture("valid.json");

  assert.equal(decisionSchema.safeParse(decision).success, true);
  assert.equal(
    decisionSchema.safeParse({
      ...decision,
      status: "superseded",
      supersededBy: undefined
    }).success,
    false
  );
});

test("P01-T04 invalid entity fixture cases are rejected", async () => {
  const invalid = await readEntityFixture("invalid.json");

  for (const entry of invalid.cases) {
    const schema = {
      project: projectSchema,
      change: changeSchema,
      requirement: requirementSchema,
      decision: decisionSchema,
      oracle: oracleSchema
    }[entry.schema];

    assert.ok(schema, `unknown invalid fixture schema ${entry.schema}`);
    assert.equal(schema.safeParse(entry.value).success, false, entry.name);
  }
});

test("P01-T04 generated entity JSON schemas match committed artifacts", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaDirectory = join(testDirectory, "..", "..", "..", "schemas", "entities");

  const expectedFiles = {
    project: "project.schema.json",
    change: "change.schema.json",
    requirement: "requirement.schema.json",
    decision: "decision.schema.json",
    oracle: "oracle.schema.json"
  };

  for (const [name, fileName] of Object.entries(expectedFiles)) {
    const committed = JSON.parse(await readFile(join(schemaDirectory, fileName), "utf8"));
    assert.deepEqual(committed, entityJsonSchemas[name]);
  }
});
