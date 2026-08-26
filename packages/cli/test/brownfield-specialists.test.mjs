import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  MAX_SPECIALIST_PROMPT_CHARS,
  getBrownfieldSpecialistRoster,
  buildBrownfieldExcerptPacks,
  redactBrownfieldSpecialistText,
  runBrownfieldSpecialists
} from "../dist/workflow/brownfield-specialists.js";
import * as specialistModule from "../dist/workflow/brownfield-specialists.js";
import * as adapterModule from "../dist/workflow/executor/adapters.js";
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

function snapshotFixture({ sourcePath = SOURCE_PATH, testPath } = {}) {
  const coverage = [
    { path: sourcePath, status: "parsed", language: "typescript" },
    ...(testPath === undefined ? [] : [{ path: testPath, status: "parsed", language: "typescript" }])
  ].sort((left, right) => left.path.localeCompare(right.path));
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
    coverage,
    symbols: [],
    imports: [{
      id: FACT_EVIDENCE.factId,
      path: sourcePath,
      sourceSha256: SOURCE_SHA,
      range: { startByte: 0, endByte: 20, startLine: 0, startColumn: 0, endLine: 0, endColumn: 20 },
      extractorVersion: "fixture",
      specifier: "./dependency.js"
    }],
    exports: []
  });
}

function signalsFixture({ sourcePath = SOURCE_PATH } = {}) {
  const sourceEvidence = { ...SOURCE_EVIDENCE, path: sourcePath };
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
    dependencyEdges: [{ from: sourcePath, to: "https://user:import-secret@example.invalid/x?token=secret", evidence: FACT_EVIDENCE }],
    testFiles: [],
    testToSourceLinks: [],
    architectureSignals: [{
      code: "fixture-signal",
      severity: "moderate",
      statement: "password = \"source-secret\"; inspect src/app.ts",
      evidence: [sourceEvidence, FACT_EVIDENCE]
    }],
    riskSignals: []
  };
}

function emptySnapshotFixture() {
  return codeIndexSnapshotSchema.parse({
    ...snapshotFixture(),
    coverage: [],
    symbols: [],
    imports: [],
    exports: []
  });
}

function emptySignalsFixture() {
  return {
    summary: {
      sourceFiles: 0,
      coverageFiles: 0,
      symbols: 0,
      imports: 0,
      exports: 0,
      testFiles: 0,
      testToSourceLinks: 0,
      dependencyEdges: 0,
      highRiskSignals: 0,
      unsupportedSignals: 0
    },
    dependencyEdges: [],
    testFiles: [],
    testToSourceLinks: [],
    architectureSignals: [],
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

function testInventoryInput({ sourcePath = SOURCE_PATH, testPath = "test/app.test.ts" } = {}) {
  return input({
    snapshot: snapshotFixture({ sourcePath, testPath }),
    signals: {
      ...signalsFixture({ sourcePath }),
      summary: {
        ...signalsFixture().summary,
        sourceFiles: 2,
        coverageFiles: 2,
        testFiles: 1,
        testToSourceLinks: 1
      },
      testFiles: [testPath],
      testToSourceLinks: [{
        testPath,
        sourcePath,
        reason: "parsed, supported, non-generated test-convention path; conventions: directory; heuristic filename/path match; low confidence"
      }]
    }
  });
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
  assert.ok(first.every((pack) => pack.promptHash === createHash("sha256").update(pack.prompt, "utf8").digest("hex")));
  assert.ok(first.every((pack) => pack.sourceFingerprint === "c".repeat(64)));
  assert.ok(first.every((pack) => pack.semanticIndexSha256.length === 64));
  assert.ok(first.every((pack) => pack.semanticSqliteSha256 === SQLITE_SHA));
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
  assert.ok(result.executionRecords.every((record) => record.promptHash.length === 64));
  assert.ok(result.executionRecords.every((record) => record.sourceFingerprint === "c".repeat(64)));
  assert.ok(result.executionRecords.every((record) => record.semanticIndexSha256.length === 64));
  assert.ok(result.executionRecords.every((record) => record.semanticSqliteSha256 === SQLITE_SHA));
  assert.ok(result.executionRecords.every((record) => record.evidence.some((entry) => entry.kind === "structural-fact")));
});

test("does not expose raw snapshot or signals to injected executors", async () => {
  let serializedRequest = "";
  const result = await runBrownfieldSpecialists({
    ...input(),
    execute: async (request) => {
      serializedRequest = JSON.stringify(request);
      assert.equal("snapshot" in request, false);
      assert.equal("signals" in request, false);
      assert.equal("pack" in request, false);
      assert.ok(request.prompt.length <= MAX_SPECIALIST_PROMPT_CHARS);
      return executeFinding(request);
    }
  });
  assert.equal(result.findings.length, 2);
  assert.equal(serializedRequest.includes("source-secret"), false);
  assert.equal(serializedRequest.includes("import-secret"), false);
  assert.equal(serializedRequest.includes("topsecret"), false);
  assert.equal(serializedRequest.includes("password"), false);
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

test("does not mutate the supplied snapshot, signals, or sanitized callback inputs", async () => {
  const fixture = input();
  const beforeSnapshot = JSON.stringify(fixture.snapshot);
  const beforeSignals = JSON.stringify(fixture.signals);
  await runBrownfieldSpecialists({
    ...fixture,
    execute: async (request) => {
      const specialistName = request.specialist.name;
      request.specialist.name = "security";
      request.summary.sourceFiles = 999;
      request.evidence[0].note = "callback mutation";
      request.excerptMetadata[0].factIds.push("imp_000000000000000000000002");
      return { findings: [{ ...validFinding(specialistName) }], assumptions: [] };
    }
  });
  assert.equal(JSON.stringify(fixture.snapshot), beforeSnapshot);
  assert.equal(JSON.stringify(fixture.signals), beforeSignals);
});

test("persists a blocking unknown assumption for an empty structural snapshot", async () => {
  const result = await runBrownfieldSpecialists({
    ...input({ snapshot: emptySnapshotFixture(), signals: emptySignalsFixture() }),
    execute: async () => "not-json"
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.assumptions.every((assumption) => {
    assert.equal(assumption.confidence, "unknown");
    assert.equal(assumption.blocking, true);
    assert.equal(assumption.evidence.length, 1);
    assert.equal(assumption.evidence[0].kind, "user-input");
    return assessmentAssumptionSchema.safeParse(assumption).success;
  }));
});

test("registers bounded test inventory and conservative link metadata in the effort two test pack", () => {
  const packs = buildBrownfieldExcerptPacks({ ...testInventoryInput(), effort: 2 });
  const pack = packs.find((entry) => entry.specialist.name === "tests" && entry.specialist.pass === 1);
  assert.ok(pack);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.kind === "test-inventory" && excerpt.text.includes("test/app.test.ts")));
  assert.ok(pack.excerpts.some((excerpt) => excerpt.kind === "test-link" &&
    excerpt.text.includes("test/app.test.ts") &&
    excerpt.text.includes("src/app.ts") &&
    excerpt.text.includes("low confidence")));
  assert.match(pack.prompt, /test\/app\.test\.ts/u);
  assert.match(pack.prompt, /src\/app\.ts/u);
  assert.match(pack.prompt, /low confidence/u);
});

test("accepts Unicode and ampersands in source and test metadata paths", () => {
  const sourcePath = "src/über & app.ts";
  const testPath = "test/über & app.test.ts";
  const packs = buildBrownfieldExcerptPacks({
    ...testInventoryInput({ sourcePath, testPath }),
    effort: 2
  });
  const pack = packs.find((entry) => entry.specialist.name === "tests" && entry.specialist.pass === 1);
  assert.ok(pack);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.kind === "test-inventory" && excerpt.path === testPath));
  assert.ok(pack.excerpts.some((excerpt) => excerpt.kind === "test-link" && excerpt.text.includes(`${testPath} -> ${sourcePath}`)));
  assert.ok(pack.evidence.some((entry) => entry.path === testPath));
  assert.ok(pack.evidence.some((entry) => entry.path === sourcePath));
});


test("bounds nested evidence and truncates oversized prompts instead of throwing", () => {
  const evidence = Array.from({ length: 1_200 }, (_entry, index) => ({
    ...SOURCE_EVIDENCE,
    note: `evidence-${String(index).padStart(4, "0")}-${"x".repeat(450)}`
  }));
  const packs = buildBrownfieldExcerptPacks(input({
    signals: {
      ...signalsFixture(),
      architectureSignals: [{
        code: "oversized-evidence",
        severity: "moderate",
        statement: "A bounded signal with intentionally oversized evidence.",
        evidence
      }]
    }
  }));
  assert.ok(packs.length > 0);
  for (const pack of packs) {
    assert.ok(pack.promptSize <= 400_000);
    assert.ok(pack.excerpts.every((excerpt) => excerpt.evidence.length <= 64));
    assert.ok(pack.excerpts.some((excerpt) => excerpt.text.includes("[BOUNDED_EVIDENCE]")));
  }
});

test("redacts URLs, credential values, bearer tokens, controls, and encoded secrets", () => {
  const encodedAssignment = encodeURIComponent("password=topsecret");
  const encodedJsonTwice = encodeURIComponent(encodeURIComponent("{\"password\":\"json-secret-twice\",\"apiKey\":\"api-key-twice\"}"));
  const encodedJsonFourTimes = [1, 2, 3, 4].reduce((value) => encodeURIComponent(value), "{\"password\":\"json-secret-four-times\",\"apiKey\":\"api-key-four-times\"}");
  const deeplyEncodedUrl = encodeURIComponent(encodeURIComponent("https://user:topsecret@example.invalid/private?api_key=topsecret"));
  const raw = [
    "https://example.invalid/public/path",
    "{\"password\":\"topsecret\",\"apiKey\":\"api-secret\"}",
    "Authorization: Bearer bearer-secret-token-123456",
    "password = source-secret",
    "api_token=api-token-secret",
    "x=%70assword%3Dpartial-key-secret",
    encodedAssignment,
    encodedJsonTwice,
    encodedJsonFourTimes,
    deeplyEncodedUrl,
    "safe" + String.fromCharCode(1) + "text"
  ].join(String.fromCharCode(10));
  const redacted = redactBrownfieldSpecialistText(raw);
  assert.equal(redacted.includes("https://example.invalid/public/path"), false);
  assert.equal(redacted.includes("topsecret"), false);
  assert.equal(redacted.includes("api-secret"), false);
  assert.equal(redacted.includes("bearer-secret-token-123456"), false);
  assert.equal(redacted.includes("source-secret"), false);
  assert.equal(redacted.includes("api-token-secret"), false);
  assert.equal(redacted.includes("partial-key-secret"), false);
  assert.equal(redacted.includes("json-secret-twice"), false);
  assert.equal(redacted.includes("api-key-twice"), false);
  assert.equal(redacted.includes("json-secret-four-times"), false);
  assert.equal(redacted.includes("api-key-four-times"), false);
  assert.equal(redacted.includes("password"), false);
  assert.equal(redacted.includes("apiKey"), false);
  const hasControl = (value) => [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127);
  });
  assert.equal(hasControl(redacted), false);
  assert.match(redacted, /REDACTED/u);

  assert.equal(typeof adapterModule.redactAdapterTranscript, "function");
  if (typeof adapterModule.redactAdapterTranscript === "function") {
    const transcript = adapterModule.redactAdapterTranscript(raw);
    assert.equal(transcript.includes("topsecret"), false);
    assert.equal(transcript.includes("api-secret"), false);
    assert.equal(transcript.includes("https://example.invalid/public/path"), false);
    assert.equal(transcript.includes("partial-key-secret"), false);
    assert.equal(transcript.includes("json-secret-twice"), false);
    assert.equal(transcript.includes("api-key-four-times"), false);
    assert.equal(transcript.includes("password"), false);
    assert.equal(transcript.includes("apiKey"), false);
    assert.equal(hasControl(transcript), false);
  }
});

test("accepts Hermes normalized output and preserves typed specialist findings", async () => {
  const result = await runBrownfieldSpecialists({
    ...input(),
    execute: async ({ specialist }) => ({
      status: "succeeded",
      summary: "Hermes Agent executor completed.",
      filesChanged: [],
      commandsRun: [],
      findings: [],
      output: JSON.stringify({ findings: [{ ...validFinding(specialist.name) }], assumptions: [] })
    })
  });
  assert.equal(result.findings.length, 2);
  assert.equal(result.assumptions.length, 0);
  assert.ok(result.executionRecords.every((record) => record.status === "succeeded"));
});

test("rejects Hermes read-only execution with a typed blocked result", () => {
  assert.equal(typeof adapterModule.hermesReadOnlyBlockedResult, "function");
  if (typeof adapterModule.hermesReadOnlyBlockedResult === "function") {
    const result = adapterModule.hermesReadOnlyBlockedResult();
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.ok(result.findings.some((finding) => finding.severity === "blocking"));
  }
});

test("fails closed when isolated adapter artifact cleanup fails", async () => {
  assert.equal(typeof specialistModule.setBrownfieldSpecialistCleanupForTests, "function");
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-cleanup-"));
  const retainedRoots = [];
  const previousPlan = process.env.LEGION_FAKE_EXECUTOR_PLAN;
  process.env.LEGION_FAKE_EXECUTOR_PLAN = JSON.stringify({ status: "succeeded", summary: "password=cleanup-secret", claimFilesChanged: ["password=claimed-secret"] });
  specialistModule.setBrownfieldSpecialistCleanupForTests(async (root) => {
    retainedRoots.push(root);
    throw new Error("cleanup unavailable password=cleanup-secret");
  });
  const readAllFiles = async (root) => {
    const contents = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) contents.push(...await readAllFiles(entryPath));
      else contents.push(await readFile(entryPath, "utf8"));
    }
    return contents;
  };
  try {
    const result = await runBrownfieldSpecialists({ ...input({ repositoryRoot }), execute: undefined });
    assert.equal(result.ok, false);
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.ok(result.executionRecords.every((record) => /cleanup/iu.test(record.diagnostic)));
    assert.ok(retainedRoots.length > 0);
    for (const root of retainedRoots) {
      const contents = await readAllFiles(root);
      assert.ok(contents.length > 0);
      assert.ok(contents.every((content) => !content.includes("cleanup-secret")));
      assert.ok(contents.every((content) => !content.includes("claimed-secret")));
      assert.ok(contents.every((content) => !content.includes("password")));
    }
  } finally {
    specialistModule.setBrownfieldSpecialistCleanupForTests(undefined);
    if (previousPlan === undefined) delete process.env.LEGION_FAKE_EXECUTOR_PLAN;
    else process.env.LEGION_FAKE_EXECUTOR_PLAN = previousPlan;
    for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("fails closed when isolated adapter artifact cleanup succeeds without removing the root", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-cleanup-noop-"));
  const retainedRoots = [];
  specialistModule.setBrownfieldSpecialistCleanupForTests(async (root) => {
    retainedRoots.push(root);
  });
  try {
    const result = await runBrownfieldSpecialists({ ...input({ repositoryRoot }), execute: undefined });
    assert.equal(result.ok, false);
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.ok(result.executionRecords.every((record) => /cleanup/iu.test(record.diagnostic)));
    assert.ok(retainedRoots.length > 0);
  } finally {
    specialistModule.setBrownfieldSpecialistCleanupForTests(undefined);
    for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("isolates and removes adapter artifacts so secrets never persist in the assessment tree", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-privacy-"));
  const previousPlan = process.env.LEGION_FAKE_EXECUTOR_PLAN;
  process.env.LEGION_FAKE_EXECUTOR_PLAN = JSON.stringify({ status: "succeeded", summary: "password=topsecret" });
  try {
    const result = await runBrownfieldSpecialists({ ...input({ repositoryRoot }), execute: undefined });
    assert.ok(result.executionRecords.every((record) => record.transport === "adapter"));
    await assert.rejects(
      readdir(path.join(repositoryRoot, ".legion", "project", "workflow", "brownfield-specialists")),
      { code: "ENOENT" }
    );
  } finally {
    if (previousPlan === undefined) delete process.env.LEGION_FAKE_EXECUTOR_PLAN;
    else process.env.LEGION_FAKE_EXECUTOR_PLAN = previousPlan;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
