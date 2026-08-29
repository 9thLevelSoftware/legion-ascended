import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { directoryLinkType, requireDirSymlink } from "../../../tests/helpers/symlink-capability.mjs";

const execFile = (file, args) => new Promise((resolve, reject) => {
  execFileCallback(file, args, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

const SOURCE_SHA = "a".repeat(64);
const TEST_SHA = "d".repeat(64);
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
    imports: [
      {
        id: FACT_EVIDENCE.factId,
        path: sourcePath,
        sourceSha256: SOURCE_SHA,
        range: { startByte: 0, endByte: 20, startLine: 0, startColumn: 0, endLine: 0, endColumn: 20 },
        extractorVersion: "fixture",
        specifier: "./dependency.js"
      },
      ...(testPath === undefined ? [] : [{
        id: "imp_000000000000000000000002",
        path: testPath,
        sourceSha256: TEST_SHA,
        range: { startByte: 0, endByte: 20, startLine: 0, startColumn: 0, endLine: 0, endColumn: 20 },
        extractorVersion: "fixture",
        specifier: "./subject.js"
      }])
    ],
    exports: []
  });
}

function coverageOnlySnapshotFixture() {
  const sourcePath = "src/coverage-only.ts";
  const testPath = "test/coverage-only.test.ts";
  const snapshot = {
    ...snapshotFixture(),
    coverage: [
      { path: sourcePath, status: "parsed", language: "typescript", sha256: SOURCE_SHA },
      { path: testPath, status: "parsed", language: "typescript", sha256: TEST_SHA }
    ],
    symbols: [],
    imports: [],
    exports: []
  };
  return { snapshot, sourcePath, testPath };
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

function oversizedPackInput(count = 140) {
  const sourcePaths = [SOURCE_PATH, ...Array.from({ length: count }, (_entry, index) => `src/overflow-${String(index).padStart(3, "0")}.ts`)];
  const baseSnapshot = snapshotFixture();
  const snapshot = codeIndexSnapshotSchema.parse({
    ...baseSnapshot,
    coverage: sourcePaths.map((sourcePath) => ({ path: sourcePath, status: "parsed", language: "typescript" })),
    imports: sourcePaths.map((sourcePath, index) => ({
      ...baseSnapshot.imports[0],
      id: index === 0 ? FACT_EVIDENCE.factId : `imp_${(index + 1).toString(16).padStart(24, "0")}`,
      path: sourcePath
    }))
  });
  const architectureSignals = sourcePaths.slice(1).map((sourcePath, index) => ({
    code: `overflow-${String(index).padStart(3, "0")}`,
    severity: "moderate",
    statement: `Inspect ${sourcePath}.`,
    evidence: [{
      kind: "source-file",
      path: sourcePath,
      sha256: SOURCE_SHA,
      note: `bounded overflow evidence ${index}`
    }]
  }));
  return input({
    snapshot,
    signals: {
      ...signalsFixture(),
      architectureSignals,
      dependencyEdges: []
    }
  });
}

function adapterModelResult(secret) {
  return {
    status: "succeeded",
    summary: `password=${secret}`,
    filesChanged: [`password=${secret}-claimed`],
    commandsRun: [],
    findings: []
  };
}

function claudeShimSource(result, exitCode) {
  const envelope = { type: "result", is_error: false, result: JSON.stringify(result) };
  return `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))}, () => process.exit(${exitCode}));\n`;
}

function codexShimSource(result, exitCode) {
  return `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst index = process.argv.indexOf("--output-last-message");\nfs.writeFileSync(process.argv[index + 1], ${JSON.stringify(JSON.stringify(result))}, "utf8");\nprocess.exitCode = ${exitCode};\n`;
}

function claudeSpecialistMutationShimSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const specialist = /You are the ([a-z-]+) assessor/u.exec(prompt)?.[1] ?? "architecture";
  const id = specialist === "architecture" ? "af_111111111111111111111111" : "af_222222222222222222222222";
  const root = process.cwd();
  fs.writeFileSync(path.join(root, "pwned.txt"), "pwned bytes\\n", "utf8");
  fs.chmodSync(path.join(root, "nested"), 0o000);
  fs.chmodSync(root, 0o000);
  const result = { findings: [{ id, specialist, title: "Bounded fixture finding", statement: "The supplied structural evidence identifies a review point.", severity: "moderate", confidence: "medium", evidence: [{ kind: "source-file", path: "src/app.ts", sha256: ${JSON.stringify(SOURCE_SHA)}, note: "bounded source fixture" }], assumptions: [], recommendation: "Review the referenced evidence with an approved verification command." }], assumptions: [] };
  const envelope = { type: "result", is_error: false, result: JSON.stringify(result) };
  process.stdout.write(JSON.stringify(envelope), () => process.exit(0));
});
`;
}

function grokSpecialistShimSource(type = "result", includeType = true, directPayload = false) {
  const typeField = includeType ? `type: ${JSON.stringify(type)}, ` : "";
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv;
const prompt = fs.readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
const specialist = /You are the ([a-z-]+) assessor/u.exec(prompt)?.[1] ?? "architecture";
const id = specialist === "architecture" ? "af_111111111111111111111111" : "af_222222222222222222222222";
const specialistOutput = { findings: [{ id, specialist, title: "Bounded fixture finding", statement: "The supplied structural evidence identifies a review point.", severity: "moderate", confidence: "medium", evidence: [{ kind: "source-file", path: "src/app.ts", sha256: ${JSON.stringify(SOURCE_SHA)}, note: "bounded source fixture" }], assumptions: [], recommendation: "Review the referenced evidence with an approved verification command." }], assumptions: [] };
const result = ${directPayload ? "specialistOutput" : "{ status: \"succeeded\", summary: \"Grok completed.\", filesChanged: [], commandsRun: [], findings: [], structuredOutput: JSON.stringify(specialistOutput) }"};
const envelope = { ${typeField}text: JSON.stringify(result), stopReason: "end_turn", sessionId: "session_fixture", requestId: "request_fixture" };
process.stdout.write(JSON.stringify(envelope));
`;
}

function claudeDescendantShimSource() {
  const descendantSource = "const fs = require('node:fs'); const path = require('node:path'); setTimeout(() => fs.writeFileSync(path.join(process.cwd(), 'late-descendant.txt'), 'late descendant mutation\\n', 'utf8'), 500);";
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { detached: false, stdio: "ignore" });
descendant.on("spawn", () => process.stdout.write("descendant-ready\\n"));
setTimeout(() => {}, 10_000);
`;
}

function claudeNormalExitDescendantShimSource() {
  const descendantSource = "const fs = require('node:fs'); const path = require('node:path'); setTimeout(() => fs.writeFileSync(path.join(process.cwd(), 'late-normal-exit-descendant.txt'), 'late descendant mutation\\n', 'utf8'), 500);";
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { detached: false, stdio: "ignore" });
descendant.on("spawn", () => {
  fs.writeFileSync(path.join(process.cwd(), "descendant.pid"), String(descendant.pid), "utf8");
  process.stdout.write("normal-exit-descendant-ready\\n", () => process.exit(0));
});
`;
}

function claudeSymlinkTargetMutationShimSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "linked-outside", "pwned.txt"), "outside mutation\\n", "utf8");
`;
}

function hugeClaudeShimSource() {
  return `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(2_000_000));\n`;
}

function hugeGrokShimSource() {
  return `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(2_000_000));\n`;
}

function hugeCodexLastMessageShimSource() {
  return `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst index = process.argv.indexOf("--output-last-message");\nfs.writeFileSync(process.argv[index + 1], "x".repeat(2_000_000), "utf8");\n`;
}

async function withExecutableShim(name, source, callback) {
  const shimRoot = await mkdtemp(path.join(tmpdir(), `legion-${name}-shim-`));
  const shimPath = path.join(shimRoot, name);
  await writeFile(shimPath, source, "utf8");
  await chmod(shimPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimRoot}${path.delimiter}${previousPath ?? ""}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(shimRoot, { recursive: true, force: true });
  }
}

async function readAllFiles(root) {
  const contents = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) contents.push(...await readAllFiles(entryPath));
    else contents.push(await readFile(entryPath, "utf8"));
  }
  return contents;
}

function directAdapterRequest(repositoryRoot, executor) {
  return {
    repositoryRoot,
    artifactRepositoryRoot: repositoryRoot,
    changeId: "chg_fixture",
    runId: "run_fixture",
    task: {},
    mode: "review",
    executor,
    readOnly: true,
    prompt: "bounded specialist prompt",
    contextPackArtifactPath: ".legion/project/context-pack.json",
    contextPackAbsolutePath: path.join(repositoryRoot, ".legion/project/context-pack.json"),
    promptArtifactPath: ".legion/project/executor-prompt.md",
    promptAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-prompt.md"),
    resultArtifactPath: ".legion/project/executor-result.json",
    resultAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-result.json"),
    rawLogArtifactPath: ".legion/project/executor-raw.log",
    rawLogAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-raw.log"),
    redactedLogArtifactPath: ".legion/project/executor-redacted.log",
    redactedLogAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-redacted.log")
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

function hasSyntheticUserInput(assumption) {
  return assumption.evidence.some((entry) =>
    entry.kind === "user-input" &&
    entry.path.startsWith(".legion/project/workflow/brownfield-specialists/")
  );
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
  assert.ok(malformed.assumptions.every(hasSyntheticUserInput));
  assert.ok(malformed.executionRecords.every((record) => record.status === "failed"));

  const failed = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => { throw new Error("executor unavailable"); }
  });
  assert.equal(failed.assumptions.length, 2);
  assert.match(failed.assumptions[0].statement, /executor unavailable/u);
  assert.ok(failed.executionRecords.every((record) => record.status === "failed"));
  assert.ok(failed.executionRecords.every((record) => record.outputSize >= Buffer.byteLength("executor unavailable", "utf8")));
  assert.ok(failed.assumptions.every(hasSyntheticUserInput));
});

test("rejects missing or out-of-bounds evidence and records the specialist failure", async () => {
  const missingEvidence = await runBrownfieldSpecialists({
    ...input(),
    execute: async ({ specialist }) => ({ findings: [{ ...validFinding(specialist.name), evidence: [] }], assumptions: [] })
  });
  assert.equal(missingEvidence.findings.length, 0);
  assert.equal(missingEvidence.assumptions.length, 2);
  assert.match(missingEvidence.executionRecords[0].diagnostic, /evidence|invalid|failed/iu);
  assert.ok(missingEvidence.assumptions.every(hasSyntheticUserInput));

  const outOfBounds = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => ({ findings: [{ ...validFinding(), evidence: [{ ...SOURCE_EVIDENCE, path: "src/not-supplied.ts" }] }], assumptions: [] })
  });
  assert.equal(outOfBounds.findings.length, 0);
  assert.equal(outOfBounds.assumptions.length, 2);
  assert.ok(outOfBounds.assumptions.every(hasSyntheticUserInput));
});

test("rejects source evidence whose digest does not match the structural snapshot", () => {
  const fixture = input();
  const wrongSha256 = "e".repeat(64);
  assert.throws(() => buildBrownfieldExcerptPacks({
    ...fixture,
    signals: {
      ...fixture.signals,
      architectureSignals: [{
        ...fixture.signals.architectureSignals[0],
        evidence: [{ ...SOURCE_EVIDENCE, sha256: wrongSha256 }, FACT_EVIDENCE]
      }]
    }
  }), /source.*hash|digest/iu);
});

test("binds source evidence and test metadata to hashes from coverage-only entries", () => {
  const { snapshot, sourcePath, testPath } = coverageOnlySnapshotFixture();
  const signals = {
    ...emptySignalsFixture(),
    summary: {
      ...emptySignalsFixture().summary,
      sourceFiles: 2,
      coverageFiles: 2,
      testFiles: 1,
      highRiskSignals: 1
    },
    testFiles: [testPath],
    architectureSignals: [{
      code: "coverage-only-source",
      severity: "moderate",
      statement: "Coverage-only source evidence is valid.",
      evidence: [{ kind: "source-file", path: sourcePath, sha256: SOURCE_SHA, note: "coverage-only source" }]
    }]
  };
  const packs = buildBrownfieldExcerptPacks({ ...input({ snapshot, signals }), effort: 2 });
  assert.ok(packs.length > 0);
  assert.ok(packs.some((pack) => pack.evidence.some((entry) =>
    entry.kind === "source-file" && entry.path === sourcePath && entry.sha256 === SOURCE_SHA
  )));
  const testPacks = packs.filter((pack) => pack.specialist.name === "tests");
  assert.ok(testPacks.length > 0);
  assert.ok(testPacks.every((pack) => pack.evidence.some((entry) =>
    entry.kind === "source-file" && entry.path === testPath && entry.sha256 === TEST_SHA
  )));

  assert.throws(() => buildBrownfieldExcerptPacks({
    ...input({
      snapshot,
      signals: {
        ...signals,
        architectureSignals: [{
          ...signals.architectureSignals[0],
          evidence: [{ ...signals.architectureSignals[0].evidence[0], sha256: "e".repeat(64) }]
        }]
      }
    }),
    effort: 2
  }), /source.*hash|digest/iu);
});

test("drains a timed-out callback before the next specialist and before returning", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-timeout-"));
  const delayedFile = path.join(repositoryRoot, "late.txt");
  let active = 0;
  let maxActive = 0;
  let callbackCount = 0;
  let firstCallbackSettled = false;
  let mutationAfterResult = false;
  let resultReturned = false;
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      timeoutMs: 5,
      execute: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const callbackNumber = callbackCount += 1;
        try {
          if (callbackNumber === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (resultReturned) mutationAfterResult = true;
            await writeFile(delayedFile, "late callback mutation\\n", "utf8");
          }
          if (callbackNumber > 1) assert.equal(firstCallbackSettled, true);
          return executeFinding(request);
        } finally {
          if (callbackNumber === 1) firstCallbackSettled = true;
          active -= 1;
        }
      }
    });
    resultReturned = true;
    assert.equal(maxActive, 1);
    assert.equal(mutationAfterResult, false);
    assert.equal(firstCallbackSettled, true);
    assert.equal(active, 0);
    assert.equal(result.assumptions.length, 1);
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
    assert.ok(result.executionRecords.some((record) => record.status === "blocked"));
    assert.equal(result.executionRecords[0].status, "blocked");
    assert.match(result.executionRecords[0].diagnostic, /timed out|read-only|changed/iu);
    assert.equal(result.executionRecords[1].status, "succeeded");
    await assert.rejects(readFile(delayedFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("bounds the timeout drain when an in-process callback never settles", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-timeout-drain-"));
  let callbackCount = 0;
  try {
    const result = await Promise.race([
      runBrownfieldSpecialists({
        ...input({ repositoryRoot }),
        timeoutMs: 50,
        execute: async () => {
          callbackCount += 1;
          return new Promise(() => {});
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("specialist timeout drain remained unbounded")), 2_500))
    ]);
    assert.equal(callbackCount, 1);
    assert.equal(result.executionRecords.length, 2);
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.match(result.executionRecords[0].diagnostic, /timed out/iu);
    assert.match(result.executionRecords[1].diagnostic, /halted|blocked/iu);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("redacts encoded credential JSON after the bounded decode budget", () => {
  const secret = "json-secret-seventeen-times";
  const credentialJson = JSON.stringify({ password: secret, apiKey: "api-key-seventeen-times" });
  const encodedSeventeenTimes = Array.from({ length: 17 }, () => 0)
    .reduce((value) => encodeURIComponent(value), credentialJson);
  for (const redact of [redactBrownfieldSpecialistText, adapterModule.redactAdapterTranscript]) {
    const redacted = redact(encodedSeventeenTimes);
    assert.equal(redacted.includes(secret), false);
    assert.equal(redacted.includes("api-key-seventeen-times"), false);
    assert.equal(redacted.includes("password"), false);
    assert.equal(redacted.includes("apiKey"), false);
    assert.match(redacted, /REDACTED/iu);
  }
});

test("redacts literal, backslash-escaped, and deeply escaped credential JSON", () => {
  const cases = [
    String.raw`\{"password":"nested-secret"\}`,
    String.raw`\{\"password\":\"quoted-secret\",\"nested\":\{\"apiKey\":\"deep-api-secret\"\}\}`,
    JSON.stringify(JSON.stringify({ nested: { password: "deep-json-secret", secret: "deep-json-token" } })),
    JSON.stringify(JSON.stringify(JSON.stringify({ deeper: { password: "deepest-json-secret" } }))),
    encodeURIComponent(encodeURIComponent(String.raw`\{\"password\":\"percent-escaped-secret\"\}`))
  ];
  for (const redact of [redactBrownfieldSpecialistText, adapterModule.redactAdapterTranscript]) {
    for (const value of cases) {
      const redacted = redact(value);
      for (const secret of ["nested-secret", "quoted-secret", "deep-api-secret", "deep-json-secret", "deep-json-token", "deepest-json-secret", "percent-escaped-secret"]) {
        assert.equal(redacted.includes(secret), false, `${secret} leaked in ${JSON.stringify(redacted)}`);
      }
      for (const key of ["password", "apiKey", "secret"]) assert.equal(redacted.includes(key), false, `${key} leaked in ${JSON.stringify(redacted)}`);
      assert.match(redacted, /REDACTED/iu);
    }
  }
});

test("times out an executor without losing a typed record", async () => {
  const result = await runBrownfieldSpecialists({
    ...input(),
    timeoutMs: 10,
    execute: async () => new Promise((resolve) => setTimeout(() => resolve("not-json"), 25))
  });
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.assumptions.every(hasSyntheticUserInput));
  assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
  assert.ok(result.executionRecords.every((record) => /timed out/u.test(record.diagnostic)));
});

test("rejects oversized in-process callback output before parsing or hashing it", async () => {
  const oversized = "x".repeat(adapterModule.MAX_ADAPTER_OUTPUT_BYTES + 1);
  const result = await runBrownfieldSpecialists({
    ...input(),
    execute: async () => oversized
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.executionRecords.every((record) => record.status === "failed"));
  assert.ok(result.executionRecords.every((record) => /output|bounded|limit/iu.test(record.diagnostic)));
  assert.ok(result.executionRecords.every((record) => record.outputSize === Buffer.byteLength(oversized, "utf8")));
});

test("returns failed records instead of rejecting when the in-process baseline is oversized", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-oversized-baseline-"));
  const oversizedFile = path.join(repositoryRoot, "oversized.bin");
  let callbackCount = 0;
  try {
    await writeFile(oversizedFile, Buffer.alloc(16 * 1024 * 1024 + 1));
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async () => {
        callbackCount += 1;
        return executeFinding({ specialist: { name: "architecture" } });
      }
    });
    assert.equal(callbackCount, 0);
    assert.equal(result.executionRecords.length, 2);
    assert.ok(result.executionRecords.every((record) => record.status === "failed"));
    assert.ok(result.executionRecords.every((record) => /bounded|snapshot|limit/iu.test(record.diagnostic)));
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
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
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
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
  assert.ok(result.assumptions.every(hasSyntheticUserInput));
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

test("binds test inventory metadata to the test source digest in the snapshot", () => {
  const testPath = "test/app.test.ts";
  const packs = buildBrownfieldExcerptPacks({ ...testInventoryInput({ testPath }), effort: 2 });
  const testPacks = packs.filter((pack) => pack.specialist.name === "tests");
  assert.ok(testPacks.length > 0);
  for (const pack of testPacks) {
    const testEvidence = pack.evidence.filter((entry) => entry.kind === "source-file" && entry.path === testPath);
    assert.ok(testEvidence.length > 0);
    assert.ok(testEvidence.every((entry) => entry.sha256 === TEST_SHA));
  }
});

test("preserves Unicode and ampersand source evidence in blocking assumptions after malformed effort two output", async () => {
  const testPath = "test/über & only.test.ts";
  const fixture = testInventoryInput({ testPath });
  const result = await runBrownfieldSpecialists({
    ...fixture,
    effort: 2,
    signals: {
      ...fixture.signals,
      summary: { ...fixture.signals.summary, testToSourceLinks: 0 },
      testToSourceLinks: []
    },
    execute: async () => "not-json"
  });
  assert.equal(result.assumptions.length, 3);
  assert.ok(result.assumptions.every((assumption) => {
    assert.equal(assumption.confidence, "unknown");
    assert.equal(assumption.blocking, true);
    return assessmentAssumptionSchema.safeParse(assumption).success;
  }));
  assert.ok(result.assumptions.every(hasSyntheticUserInput));
  assert.ok(result.assumptions.some((assumption) => assumption.evidence.some((entry) =>
    entry.kind === "source-file" && entry.path === testPath
  )));
});

test("sanitizes direct Claude and Codex result artifacts before cleanup can fail", async () => {
  for (const kind of ["claude", "codex"]) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), `legion-brownfield-${kind}-persistence-`));
    const retainedRoots = [];
    specialistModule.setBrownfieldSpecialistCleanupForTests(async (root) => {
      retainedRoots.push(root);
      throw new Error(`cleanup unavailable password=${kind}-cleanup-secret`);
    });
    try {
      await withExecutableShim(kind, kind === "claude"
        ? claudeShimSource(adapterModelResult(`${kind}-persistence-secret`), 0)
        : codexShimSource(adapterModelResult(`${kind}-persistence-secret`), 0), async () => {
        const result = await runBrownfieldSpecialists({
          ...input({ repositoryRoot }),
          executor: kind,
          execute: undefined
        });
        assert.equal(result.ok, false);
        assert.ok(result.assumptions.every(hasSyntheticUserInput));
        assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
      });
      assert.ok(retainedRoots.length > 0);
      for (const root of retainedRoots) {
        const contents = await readAllFiles(root);
        assert.ok(contents.length > 0);
        assert.ok(contents.every((content) => !content.includes(`${kind}-persistence-secret`)));
        assert.ok(contents.every((content) => !content.includes("password")));
      }
    } finally {
      specialistModule.setBrownfieldSpecialistCleanupForTests(undefined);
      for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("sanitizes direct adapter artifacts even when no isolated artifact root is supplied", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-adapter-default-privacy-"));
  const previousPlan = process.env.LEGION_FAKE_EXECUTOR_PLAN;
  const secret = "default-artifact-secret";
  process.env.LEGION_FAKE_EXECUTOR_PLAN = JSON.stringify({ status: "succeeded", summary: `password=${secret}` });
  try {
    const request = directAdapterRequest(repositoryRoot, "fake");
    delete request.artifactRepositoryRoot;
    const result = await adapterModule.adapterForKind("fake").run(request);
    assert.equal(result.status, "succeeded");
    const raw = await readFile(request.rawLogAbsolutePath, "utf8");
    const persisted = await readFile(request.resultAbsolutePath, "utf8");
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes("password"), false);
    assert.equal(persisted.includes(secret), false);
    assert.equal(persisted.includes("password"), false);
  } finally {
    if (previousPlan === undefined) delete process.env.LEGION_FAKE_EXECUTOR_PLAN;
    else process.env.LEGION_FAKE_EXECUTOR_PLAN = previousPlan;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("sanitizes escaped credential JSON in direct Claude and Codex raw and result artifacts", async () => {
  for (const kind of ["claude", "codex"]) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), `legion-brownfield-${kind}-escaped-json-`));
    const secret = `${kind}-nested-json-secret`;
    const deepSecret = `${kind}-deep-json-secret`;
    const escapedJson = String.raw`\{\"nested\":\{\"password\":\"${secret}\",\"secret\":\"${deepSecret}\"\}\}`;
    try {
      await withExecutableShim(kind, kind === "claude"
        ? claudeShimSource(adapterModelResult(escapedJson), 0)
        : codexShimSource(adapterModelResult(escapedJson), 0), async () => {
        const request = directAdapterRequest(repositoryRoot, kind);
        const result = await adapterModule.adapterForKind(kind).run(request);
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        const raw = await readFile(request.rawLogAbsolutePath, "utf8");
        const persisted = await readFile(request.resultAbsolutePath, "utf8");
        for (const content of [raw, persisted]) {
          assert.equal(content.includes(secret), false, `${kind} leaked ${secret}`);
          assert.equal(content.includes(deepSecret), false, `${kind} leaked ${deepSecret}`);
          assert.equal(content.includes("password"), false, `${kind} leaked password`);
          assert.equal(content.includes("secret"), false, `${kind} leaked secret`);
        }
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("does not let a nonzero Claude or Codex exit report a succeeded model envelope", async () => {
  for (const kind of ["claude", "codex"]) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), `legion-brownfield-${kind}-exit-`));
    try {
      await withExecutableShim(kind, kind === "claude"
        ? claudeShimSource(adapterModelResult(`${kind}-exit-secret`), 7)
        : codexShimSource(adapterModelResult(`${kind}-exit-secret`), 7), async () => {
        const result = await adapterModule.adapterForKind(kind).run(directAdapterRequest(repositoryRoot, kind));
        assert.equal(result.ok, false);
        assert.equal(result.status, "failed");
        assert.equal(result.exitCode, 7);
        assert.equal(result.structuredOutput, undefined);
        assert.ok(result.findings.some((finding) => finding.id === `${kind}-executor-failed`));
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
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

test("records pack truncation and rejects evidence omitted from the specialist pack", async () => {
  const fixture = oversizedPackInput();
  const packs = buildBrownfieldExcerptPacks(fixture);
  assert.ok(packs.every((pack) => pack.excerpts.length <= 64));
  assert.ok(packs.every((pack) => pack.evidence.length <= 128));
  assert.ok(packs.some((pack) => pack.truncation.excerptsTruncated || pack.truncation.evidenceTruncated));
  assert.ok(packs.some((pack) => pack.prompt.includes("[BOUNDED_PACK_TRUNCATED]")));
  const omitted = fixture.signals.architectureSignals.at(-1).evidence[0];
  const result = await runBrownfieldSpecialists({
    ...fixture,
    execute: async ({ specialist }) => ({
      findings: [{ ...validFinding(specialist.name), evidence: [omitted] }],
      assumptions: []
    })
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.executionRecords.every((record) => record.status === "failed"));
  assert.ok(result.assumptions.every(hasSyntheticUserInput));
  assert.ok(result.executionRecords.every((record) => record.truncation.evidenceTruncated));
  assert.ok(result.executionRecords.every((record) => /supplied signal pack|supported conclusion/iu.test(record.diagnostic)));
});

test("rejects evidence omitted from a command-result pack", async () => {
  const commandResults = Array.from({ length: 129 }, (_entry, index) => ({
    kind: "command-result",
    path: `.legion/project/workflow/command-results/${String(index).padStart(3, "0")}.json`,
    note: `bounded command result ${index}`
  }));
  const fixture = input({ commandResults });
  const packs = buildBrownfieldExcerptPacks(fixture);
  assert.ok(packs.every((pack) => pack.truncation.evidenceTruncated));
  const omitted = commandResults.at(-1);
  assert.ok(omitted);
  assert.ok(packs.every((pack) => !pack.evidence.some((entry) => entry.kind === "command-result" && entry.path === omitted.path)));
  const result = await runBrownfieldSpecialists({
    ...fixture,
    execute: async ({ specialist }) => ({
      findings: [{ ...validFinding(specialist.name), evidence: [omitted] }],
      assumptions: []
    })
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.assumptions.length, 2);
  assert.ok(result.executionRecords.every((record) => record.status === "failed"));
  assert.ok(result.assumptions.every(hasSyntheticUserInput));
  assert.ok(result.executionRecords.every((record) => record.truncation.evidenceTruncated));
  assert.ok(result.executionRecords.every((record) => /supplied signal pack|supported conclusion/iu.test(record.diagnostic)));
});

test("rejects in-process callbacks that mutate supplied source files", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-read-only-"));
  const sourceFile = path.join(repositoryRoot, "src", "app.ts");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, "original source bytes\\n", "utf8");
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        await writeFile(request.repositoryRoot + "/src/app.ts", "mutated source bytes\\n", "utf8");
        return executeFinding(request);
      }
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
    assert.ok(result.executionRecords.every((record) => record.status === "failed"));
    assert.ok(result.executionRecords.every((record) => /read-only|mutat|changed|source/iu.test(record.diagnostic)));
    assert.equal(await readFile(sourceFile, "utf8"), "original source bytes\\n");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects in-process callbacks that add repository files", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-read-only-add-"));
  const addedFile = path.join(repositoryRoot, "generated.txt");
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        await writeFile(addedFile, "callback-created bytes\\n", "utf8");
        return executeFinding(request);
      }
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
    assert.ok(result.executionRecords.every((record) => record.status === "failed"));
    assert.ok(result.executionRecords.every((record) => /read-only|add|changed|source/iu.test(record.diagnostic)));
    await assert.rejects(readFile(addedFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("aborts the remaining roster when repository restoration fails", async () => {
  if (process.platform === "win32") return;
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-restore-abort-"));
  const specialFile = path.join(repositoryRoot, "special-entry");
  let callbackCount = 0;
  try {
    await execFile("mkfifo", [specialFile]);
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        callbackCount += 1;
        await rm(specialFile);
        await writeFile(specialFile, "replacement bytes\\n", "utf8");
        return executeFinding(request);
      }
    });
    assert.equal(callbackCount, 1);
    assert.equal(result.executionRecords.length, 2);
    assert.ok(["failed", "blocked"].includes(result.executionRecords[0].status));
    assert.equal(result.executionRecords[1].status, "blocked");
    assert.match(result.executionRecords[0].diagnostic, /restore|non-regular/iu);
    assert.match(result.executionRecords[1].diagnostic, /halted|remaining|blocked/iu);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("redacts URLs, credential values, bearer tokens, controls, and encoded secrets", () => {
  const encodedAssignment = encodeURIComponent("password=topsecret");
  const encodedJsonTwice = encodeURIComponent(encodeURIComponent("{\"password\":\"json-secret-twice\",\"apiKey\":\"api-key-twice\"}"));
  const encodedJsonFourTimes = [1, 2, 3, 4].reduce((value) => encodeURIComponent(value), "{\"password\":\"json-secret-four-times\",\"apiKey\":\"api-key-four-times\"}");
  const encodedJsonEightTimes = [1, 2, 3, 4, 5, 6, 7, 8].reduce((value) => encodeURIComponent(value), "{\"password\":\"json-secret-eight-times\",\"apiKey\":\"api-key-eight-times\"}");
  const deeplyEncodedUrl = encodeURIComponent(encodeURIComponent("https://user:topsecret@example.invalid/private?api_key=topsecret"));
  const longScheme = `${"s".repeat(33)}://long-user:long-scheme-secret@example.invalid/private?token=long-query-secret`;
  const raw = [
    "https://example.invalid/public/path",
    "postgresql://db-user:postgres-secret@example.invalid:5432/app?sslpassword=query-secret#fragment-secret",
    "ftp://ftp-user:ftp-secret@example.invalid/private",
    "git://git-user:git-secret@example.invalid/repository",
    "custom+scheme://scheme-user:scheme-secret@example.invalid/private",
    longScheme,
    "{\"password\":\"topsecret\",\"apiKey\":\"api-secret\"}",
    "Authorization: Bearer bearer-secret-token-123456",
    "password = source-secret",
    "api_token=api-token-secret",
    "x=%70assword%3Dpartial-key-secret",
    encodedAssignment,
    encodedJsonTwice,
    encodedJsonFourTimes,
    encodedJsonEightTimes,
    deeplyEncodedUrl,
    "safe" + String.fromCharCode(1) + "text"
  ].join(String.fromCharCode(10));
  const redacted = redactBrownfieldSpecialistText(raw);
  assert.equal(redacted.includes("https://example.invalid/public/path"), false);
  assert.equal(redacted.includes("postgresql://db-user:postgres-secret@example.invalid"), false);
  assert.equal(redacted.includes("postgres-secret"), false);
  assert.equal(redacted.includes("query-secret"), false);
  assert.equal(redacted.includes("fragment-secret"), false);
  assert.equal(redacted.includes("ftp-secret"), false);
  assert.equal(redacted.includes("git-secret"), false);
  assert.equal(redacted.includes("scheme-secret"), false);
  assert.equal(redacted.includes("long-scheme-secret"), false);
  assert.equal(redacted.includes("long-query-secret"), false);
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
  assert.equal(redacted.includes("json-secret-eight-times"), false);
  assert.equal(redacted.includes("api-key-eight-times"), false);
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
    assert.equal(transcript.includes("postgres-secret"), false);
    assert.equal(transcript.includes("ftp-secret"), false);
    assert.equal(transcript.includes("git-secret"), false);
    assert.equal(transcript.includes("scheme-secret"), false);
    assert.equal(transcript.includes("long-scheme-secret"), false);
    assert.equal(transcript.includes("long-query-secret"), false);
    assert.equal(transcript.includes("partial-key-secret"), false);
    assert.equal(transcript.includes("json-secret-twice"), false);
    assert.equal(transcript.includes("api-key-four-times"), false);
    assert.equal(transcript.includes("json-secret-eight-times"), false);
    assert.equal(transcript.includes("api-key-eight-times"), false);
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
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
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
    assert.ok(result.assumptions.every(hasSyntheticUserInput));
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

test("contains external adapters that mutate repository files and directory modes", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-external-mutation-"));
  const nested = path.join(repositoryRoot, "nested");
  const sourceFile = path.join(repositoryRoot, "src", "app.ts");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await mkdir(nested);
  await writeFile(sourceFile, "original source bytes\\n", "utf8");
  const rootMode = (await stat(repositoryRoot)).mode & 0o7777;
  const nestedMode = (await stat(nested)).mode & 0o7777;
  try {
    await withExecutableShim("claude", claudeSpecialistMutationShimSource(), async () => {
      const result = await runBrownfieldSpecialists({
        ...input({ repositoryRoot }),
        executor: "claude",
        execute: undefined
      });
      assert.equal(result.ok, false);
      assert.equal(result.findings.length, 0);
      assert.equal(result.assumptions.length, 2);
      assert.ok(result.executionRecords.every((record) => record.status === "blocked"), JSON.stringify(result.executionRecords));
      assert.ok(result.executionRecords.every((record) => /read-only|mutat|changed|cleanup|restore/iu.test(record.diagnostic)));
    });
    await assert.rejects(readFile(path.join(repositoryRoot, "pwned.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(sourceFile, "utf8"), "original source bytes\\n");
    assert.equal((await stat(repositoryRoot)).mode & 0o7777, rootMode);
    assert.equal((await stat(nested)).mode & 0o7777, nestedMode);
  } finally {
    await chmod(repositoryRoot, 0o700).catch(() => {});
    await chmod(nested, nestedMode).catch(() => {});
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("restores root and nested directory modes after an in-process callback chmods them", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-directory-modes-"));
  const nested = path.join(repositoryRoot, "nested");
  const sourceFile = path.join(repositoryRoot, "src", "app.ts");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await mkdir(nested);
  await writeFile(sourceFile, "original source bytes\\n", "utf8");
  const rootMode = (await stat(repositoryRoot)).mode & 0o7777;
  const nestedMode = (await stat(nested)).mode & 0o7777;
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        await chmod(nested, 0o000);
        await chmod(repositoryRoot, 0o000);
        return executeFinding(request);
      }
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.executionRecords.every((record) => record.status === "failed"));
    assert.equal(await readFile(sourceFile, "utf8"), "original source bytes\\n");
    assert.equal((await stat(repositoryRoot)).mode & 0o7777, rootMode);
    assert.equal((await stat(nested)).mode & 0o7777, nestedMode);
  } finally {
    await chmod(repositoryRoot, 0o700).catch(() => {});
    await chmod(nested, nestedMode).catch(() => {});
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("kills a descendant in the POSIX process group before returning from timeout", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-descendant-"));
  const previousTimeout = process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS;
  process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS = "150";
  try {
    await withExecutableShim("claude", claudeDescendantShimSource(), async () => {
      const result = await adapterModule.adapterForKind("claude").run(directAdapterRequest(repositoryRoot, "claude"));
      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.ok(result.findings.some((finding) => finding.id === "claude-executor-timeout"));
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assert.rejects(readFile(path.join(repositoryRoot, "late-descendant.txt"), "utf8"), { code: "ENOENT" });
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS;
    else process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS = previousTimeout;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("terminates a surviving descendant after a normal leader exit before returning", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-normal-exit-descendant-"));
  try {
    await withExecutableShim("claude", claudeNormalExitDescendantShimSource(), async () => {
      const request = directAdapterRequest(repositoryRoot, "claude");
      const result = await adapterModule.adapterForKind("claude").run(request);
      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.ok(result.findings.some((finding) => finding.id === "claude-executor-process-not-quiescent"));
      const descendantPid = Number.parseInt(await readFile(path.join(repositoryRoot, "descendant.pid"), "utf8"), 10);
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assert.rejects(readFile(path.join(repositoryRoot, "late-normal-exit-descendant.txt"), "utf8"), { code: "ENOENT" });
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("blocks external specialist execution before a repository symlink can reach outside", async (t) => {
  if (!requireDirSymlink(t)) return;
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-symlink-repository-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-symlink-outside-"));
  try {
    await symlink(outsideRoot, path.join(repositoryRoot, "linked-outside"), directoryLinkType());
    await withExecutableShim("claude", claudeSymlinkTargetMutationShimSource(), async () => {
      const result = await runBrownfieldSpecialists({
        ...input({ repositoryRoot }),
        executor: "claude",
        execute: undefined
      });
      assert.equal(result.ok, false);
      assert.equal(result.findings.length, 0);
      assert.equal(result.assumptions.length, 2);
      assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
      assert.ok(result.executionRecords.every((record) => /symlink/iu.test(record.diagnostic)));
    });
    await assert.rejects(readFile(path.join(outsideRoot, "pwned.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("blocks an in-process specialist callback before a repository symlink can reach outside", async (t) => {
  if (!requireDirSymlink(t)) return;
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-in-process-symlink-repository-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-in-process-symlink-outside-"));
  let callbackInvoked = false;
  try {
    await symlink(outsideRoot, path.join(repositoryRoot, "linked-outside"), directoryLinkType());
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        callbackInvoked = true;
        await writeFile(path.join(request.repositoryRoot, "linked-outside", "pwned.txt"), "outside mutation\\n", "utf8");
        return executeFinding(request);
      }
    });
    assert.equal(callbackInvoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 0);
    assert.equal(result.assumptions.length, 2);
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.ok(result.executionRecords.every((record) => /symlink/iu.test(record.diagnostic)));
    await assert.rejects(readFile(path.join(outsideRoot, "pwned.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("blocks an in-process specialist callback that creates a symlink mid-run", async (t) => {
  if (!requireDirSymlink(t)) return;
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-mid-run-symlink-repository-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-mid-run-outside-"));
  let callbackInvoked = false;
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        callbackInvoked = true;
        // The callback creates the symlink after the baseline snapshot, then
        // writes through it to the outside target. Restoration removes the
        // repository-side symlink, but the external write is already done.
        await symlink(outsideRoot, path.join(request.repositoryRoot, "linked-outside"), directoryLinkType());
        await writeFile(path.join(request.repositoryRoot, "linked-outside", "pwned.txt"), "outside mutation\n", "utf8");
        return executeFinding(request);
      }
    });
    assert.equal(callbackInvoked, true);
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 0);
    assert.ok(result.assumptions.length > 0);
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.ok(result.executionRecords.every((record) => /symlink/iu.test(record.diagnostic)));
    // The repository-side symlink is restored away; the outside write is the
    // known residual risk of the test-only in-process seam and is documented.
    assert.equal(await lstat(path.join(repositoryRoot, "linked-outside")).then(() => true, () => false), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("blocks with symlink status even when the mid-run callback also throws", async (t) => {
  if (!requireDirSymlink(t)) return;
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-mid-run-symlink-error-repository-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-mid-run-symlink-error-outside-"));
  try {
    const result = await runBrownfieldSpecialists({
      ...input({ repositoryRoot }),
      execute: async (request) => {
        await symlink(outsideRoot, path.join(request.repositoryRoot, "linked-outside"), directoryLinkType());
        await writeFile(path.join(request.repositoryRoot, "linked-outside", "pwned.txt"), "outside mutation\n", "utf8");
        throw new Error("callback failed");
      }
    });
    assert.equal(result.ok, false);
    // The symlink violation is the most severe failure; the record must be
    // blocked with a symlink diagnostic, not downgraded to a generic failure.
    assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
    assert.ok(result.executionRecords.every((record) => /symlink/iu.test(record.diagnostic)));
    assert.equal(await lstat(path.join(repositoryRoot, "linked-outside")).then(() => true, () => false), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("returns a typed blocked result before spawning when process-group containment is unavailable", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-containment-capability-"));
  const markerPath = path.join(repositoryRoot, "spawned.txt");
  assert.equal(typeof adapterModule.setAdapterProcessContainmentForTests, "function");
  try {
    adapterModule.setAdapterProcessContainmentForTests(false);
    await withExecutableShim("claude", `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", "utf8");
`, async () => {
      const result = await adapterModule.adapterForKind("claude").run(directAdapterRequest(repositoryRoot, "claude"));
      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.ok(result.findings.some((finding) => finding.id === "claude-process-containment-unavailable"));
      await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
    });
  } finally {
    adapterModule.setAdapterProcessContainmentForTests(undefined);
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("fails closed for unknown and missing Grok result discriminators", async () => {
  for (const [label, type, includeType] of [["unknown", "bogus", true], ["missing", "result", false]]) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), `legion-brownfield-grok-${label}-type-`));
    const request = directAdapterRequest(repositoryRoot, "grok");
    try {
      await mkdir(path.dirname(request.promptAbsolutePath), { recursive: true });
      await writeFile(request.promptAbsolutePath, "bounded specialist prompt", "utf8");
      await withExecutableShim("grok", grokSpecialistShimSource(type, includeType), async () => {
        const result = await adapterModule.adapterForKind("grok").run(request);
        assert.equal(result.ok, false);
        assert.equal(result.status, "failed");
        assert.ok(result.findings.some((finding) => /invalid result/iu.test(finding.title)));
        assert.ok(result.findings.some((finding) => /discriminator|type/iu.test(finding.body)));
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("accepts a valid Grok result envelope with direct specialist payload", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-grok-direct-payload-"));
  const request = directAdapterRequest(repositoryRoot, "grok");
  try {
    await mkdir(path.dirname(request.promptAbsolutePath), { recursive: true });
    await writeFile(request.promptAbsolutePath, "You are the architecture assessor.", "utf8");
    await withExecutableShim("grok", grokSpecialistShimSource("result", true, true), async () => {
      const result = await adapterModule.adapterForKind("grok").run(request);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, "succeeded");
      assert.equal(typeof result.structuredOutput, "string");
      assert.equal(JSON.parse(result.structuredOutput).findings.length, 1);
      assert.deepEqual(JSON.parse(result.structuredOutput).assumptions, []);
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("blocks external Grok specialist orchestration without strict containment", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-specialist-grok-"));
  try {
    await withExecutableShim("grok", grokSpecialistShimSource(), async () => {
      const result = await runBrownfieldSpecialists({
        ...input({ repositoryRoot }),
        executor: "grok",
        execute: undefined
      });
      assert.equal(result.ok, false);
      assert.equal(result.findings.length, 0);
      assert.equal(result.assumptions.length, 2);
      assert.ok(result.executionRecords.every((record) => record.status === "blocked"));
      assert.ok(result.executionRecords.every((record) => /strict OS-level read-only containment/iu.test(record.diagnostic)));
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("bounds large Claude and Grok process output before result accumulation", async () => {
  assert.equal(typeof adapterModule.MAX_ADAPTER_OUTPUT_BYTES, "number");
  for (const [kind, source] of [["claude", hugeClaudeShimSource()], ["grok", hugeGrokShimSource()]]) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), `legion-brownfield-${kind}-output-limit-`));
    try {
      await withExecutableShim(kind, source, async () => {
        const result = await adapterModule.adapterForKind(kind).run(directAdapterRequest(repositoryRoot, kind));
        assert.equal(result.ok, false);
        assert.equal(result.status, "failed");
        assert.ok(result.findings.some((finding) => finding.id === `${kind}-executor-output-limit`));
        assert.ok(Buffer.byteLength(result.rawOutput ?? "", "utf8") <= adapterModule.MAX_ADAPTER_OUTPUT_BYTES);
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("bounds the Codex last-message file before parsing and persistence", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-codex-last-message-limit-"));
  try {
    await withExecutableShim("codex", hugeCodexLastMessageShimSource(), async () => {
      const result = await adapterModule.adapterForKind("codex").run(directAdapterRequest(repositoryRoot, "codex"));
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.ok(result.findings.some((finding) => finding.id === "codex-executor-output-limit"));
      assert.ok(Buffer.byteLength(result.rawOutput ?? "", "utf8") <= adapterModule.MAX_ADAPTER_OUTPUT_BYTES);
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
