import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessmentFindingSchema,
  assessmentAssumptionSchema,
  codeIndexSnapshotSchema
} from "@legion/protocol";
import {
  BROWNFIELD_SPECIALIST_SAFETY_CONTRACT,
  getBrownfieldSpecialistRoster,
  buildBrownfieldExcerptPacks,
  runBrownfieldSpecialists
} from "../dist/workflow/brownfield-specialists.js";
import { selectExecutionAdapterKind } from "../dist/workflow/executor/adapters.js";

const SOURCE_SHA = "a".repeat(64);
const SQLITE_SHA = "b".repeat(64);
const SNAPSHOT_ID = "idx_000000000000000000000001";
const ASSESSMENT_ID = "assess_000000000000000000000001";
const SQLITE_PATH = ".legion/project/workflow/map/run-fixture/semantic-index.sqlite";
const SOURCE_PATH = "src/app.ts";
const SOURCE_EVIDENCE = {
  kind: "source-file",
  path: SOURCE_PATH,
  sha256: SOURCE_SHA,
  note: "bounded source fixture"
};
const FACT_EVIDENCE = {
  kind: "structural-fact",
  path: SQLITE_PATH,
  sha256: SQLITE_SHA,
  factId: "imp_000000000000000000000001",
  note: "bounded import fixture"
};

function snapshotFixture() {
  return codeIndexSnapshotSchema.parse({
    schemaVersion: 1,
    kind: "code_index_snapshot",
    snapshotId: SNAPSHOT_ID,
    mapRunId: "run_fixture-map",
    generatedAt: "2026-08-26T12:00:00.000Z",
    profile: "structural",
    scope: ".",
    sourceFingerprint: "c".repeat(64),
    extractor: { name: "tree-sitter", version: "fixture" },
    sqlite: { path: SQLITE_PATH, sha256: SQLITE_SHA },
    coverage: [{ path: SOURCE_PATH, status: "parsed", language: "typescript" }],
    symbols: [],
    imports: [{
      id: FACT_EVIDENCE.factId,
      path: SOURCE_PATH,
      sourceSha256: SOURCE_SHA,
      range: { startByte: 0, endByte: 20, startLine: 0, startColumn: 0, endLine: 0, endColumn: 20 },
      extractorVersion: "fixture",
      specifier: "./dependency.js"
    }],
    exports: []
  });
}

function signalsFixture() {
  return {
    summary: {
      sourceFiles: 1,
      coverageFiles: 1,
      symbols: 0,
      imports: 1,
      exports: 0,
      testFiles: 0,
      testToSourceLinks: 0,
      dependencyEdges: 1,
      highRiskSignals: 1,
      unsupportedSignals: 0
    },
    dependencyEdges: [{ from: SOURCE_PATH, to: "https://user:import-secret@example.invalid/x?token=secret", evidence: FACT_EVIDENCE }],
    testFiles: [],
    testToSourceLinks: [],
    architectureSignals: [{
      code: "fixture-signal",
      severity: "moderate",
      statement: "password = \"source-secret\"; inspect src/app.ts",
      evidence: [SOURCE_EVIDENCE, FACT_EVIDENCE]
    }],
    riskSignals: []
  };
}

function input(overrides = {}) {
  return {
    repositoryRoot: "/tmp/brownfield-specialist-fixture",
    assessmentId: ASSESSMENT_ID,
    snapshot: snapshotFixture(),
    signals: signalsFixture(),
    effort: 1,
    executor: "fake",
    ...overrides
  };
}

function validFinding(specialist = "architecture") {
  const id = specialist === "architecture" ? "af_111111111111111111111111" : "af_222222222222222222222222";
  return {
    id,
    specialist,
    title: "Bounded fixture finding",
    statement: "The supplied structural evidence identifies a review point.",
    severity: "moderate",
    confidence: "medium",
    evidence: [SOURCE_EVIDENCE],
    assumptions: [],
    recommendation: "Review the referenced evidence with an approved verification command."
  };
}

function executeFinding({ specialist }) {
  return {
    findings: [{ ...validFinding(specialist.name) }],
    assumptions: []
  };
}

test("scales the stable roster from effort one through five", () => {
  assert.deepEqual(getBrownfieldSpecialistRoster(1).map((entry) => [entry.name, entry.pass]), [
    ["architecture", 1], ["code", 1]
  ]);
  assert.deepEqual(getBrownfieldSpecialistRoster(2).map((entry) => [entry.name, entry.pass]), [
    ["architecture", 1], ["code", 1], ["tests", 1]
  ]);
  assert.deepEqual(getBrownfieldSpecialistRoster(3).map((entry) => [entry.name, entry.pass]), [
    ["architecture", 1], ["code", 1], ["tests", 1], ["documentation", 1], ["product-intent", 1]
  ]);
  assert.deepEqual(getBrownfieldSpecialistRoster(4).map((entry) => [entry.name, entry.pass]), [
    ["architecture", 1], ["code", 1], ["tests", 1], ["documentation", 1], ["product-intent", 1], ["security", 1]
  ]);
  assert.deepEqual(getBrownfieldSpecialistRoster(5).map((entry) => [entry.name, entry.pass]), [
    ["architecture", 1], ["code", 1], ["tests", 1], ["documentation", 1], ["product-intent", 1], ["security", 1],
    ["code", 2], ["tests", 2]
  ]);
});

test("constructs deterministic bounded packs and redacts source/import data", () => {
  const first = buildBrownfieldExcerptPacks(input());
  const second = buildBrownfieldExcerptPacks(input());
  assert.deepEqual(second, first);
  assert.ok(first.every((pack) => pack.promptSize <= 400_000));
  assert.ok(first.every((pack) => pack.prompt.includes(BROWNFIELD_SPECIALIST_SAFETY_CONTRACT)));
  for (const pack of first) {
    assert.equal(pack.prompt.includes("source-secret"), false);
    assert.equal(pack.prompt.includes("import-secret"), false);
    assert.equal(pack.prompt.includes("token=secret"), false);
    assert.match(pack.prompt, /src\/app\.ts/u);
    assert.match(pack.prompt, /imp_000000000000000000000001/u);
  }
});

test("normalizes a fake executor finding through protocol schemas", async () => {
  const result = await runBrownfieldSpecialists({
    ...input(),
    execute: executeFinding
  });
  assert.equal(result.roster.length, 2);
  assert.equal(result.findings.length, 2);
  assert.equal(result.assumptions.length, 0);
  for (const finding of result.findings) assert.equal(assessmentFindingSchema.safeParse(finding).success, true);
  assert.ok(result.executionRecords.every((record) => record.executor === "fake"));
  assert.ok(result.executionRecords.every((record) => record.snapshotId === SNAPSHOT_ID));
  assert.ok(result.executionRecords.every((record) => record.resultHash.length === 64));
  assert.ok(result.executionRecords.every((record) => record.promptSize > 0));
  assert.ok(result.executionRecords.every((record) => record.evidence.some((entry) => entry.kind === "structural-fact")));
});

test("converts malformed JSON and executor failures into blocking unknown assumptions", async () => {
  const malformed = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => "not-json"
  });
  assert.equal(malformed.findings.length, 0);
  assert.equal(malformed.assumptions.length, 2);
  assert.ok(malformed.assumptions.every((assumption) => assumption.confidence === "unknown" && assumption.blocking));
  assert.ok(malformed.assumptions.every((assumption) => assessmentAssumptionSchema.safeParse(assumption).success));
  assert.ok(malformed.executionRecords.every((record) => record.status === "failed"));

  const failed = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => { throw new Error("executor unavailable"); }
  });
  assert.equal(failed.assumptions.length, 2);
  assert.match(failed.assumptions[0].statement, /executor unavailable/u);
  assert.ok(failed.executionRecords.every((record) => record.status === "failed"));
});

test("rejects missing or out-of-bounds evidence and records the specialist failure", async () => {
  const missingEvidence = await runBrownfieldSpecialists({
    ...input(),
    execute: async ({ specialist }) => ({ findings: [{ ...validFinding(specialist.name), evidence: [] }], assumptions: [] })
  });
  assert.equal(missingEvidence.findings.length, 0);
  assert.equal(missingEvidence.assumptions.length, 2);
  assert.match(missingEvidence.executionRecords[0].diagnostic, /evidence|invalid|failed/iu);

  const outOfBounds = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => ({ findings: [{ ...validFinding(), evidence: [{ ...SOURCE_EVIDENCE, path: "src/not-supplied.ts" }] }], assumptions: [] })
  });
  assert.equal(outOfBounds.findings.length, 0);
  assert.equal(outOfBounds.assumptions.length, 2);
});

test("times out an executor without losing a typed record", async () => {
  const result = await runBrownfieldSpecialists({
    ...input(),
    timeoutMs: 10,
    execute: async () => new Promise(() => {})
  });
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
  assert.ok(result.executionRecords.every((record) => /timed out/u.test(record.diagnostic)));
});

test("honors explicit fake selection and inherited Grok nested-session guards", async () => {
  const previousAgent = process.env.GROK_AGENT;
  const previousSession = process.env.GROK_SESSION_ID;
  process.env.GROK_AGENT = "1";
  process.env.GROK_SESSION_ID = "nested-session";
  try {
    assert.equal(await selectExecutionAdapterKind("fake"), "fake");
    const result = await runBrownfieldSpecialists({
      ...input(),
      executor: undefined,
      execute: executeFinding
    });
    assert.ok(result.executionRecords.every((record) => record.executor !== "grok"));
  } finally {
    if (previousAgent === undefined) delete process.env.GROK_AGENT;
    else process.env.GROK_AGENT = previousAgent;
    if (previousSession === undefined) delete process.env.GROK_SESSION_ID;
    else process.env.GROK_SESSION_ID = previousSession;
  }
});

test("uses the real fake adapter boundary and preserves the source tree", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-adapter-"));
  const sourcePath = path.join(repositoryRoot, "source.txt");
  await writeFile(sourcePath, "source bytes\n", "utf8");
  try {
    const result = await runBrownfieldSpecialists({ ...input({ repositoryRoot }) });
    assert.equal(result.ok, false);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.executionRecords.every((record) => record.transport === "adapter"));
    assert.equal(await readFile(sourcePath, "utf8"), "source bytes\n");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("does not mutate the supplied snapshot or signals", async () => {
  const fixture = input();
  const beforeSnapshot = JSON.stringify(fixture.snapshot);
  const beforeSignals = JSON.stringify(fixture.signals);
  await runBrownfieldSpecialists({ ...fixture, execute: executeFinding });
  assert.equal(JSON.stringify(fixture.snapshot), beforeSnapshot);
  assert.equal(JSON.stringify(fixture.signals), beforeSignals);
});
