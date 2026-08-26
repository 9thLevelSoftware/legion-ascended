import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessmentEvidenceRefSchema,
  codeIndexSnapshotSchema
} from "@legion/protocol";
import { writeCodeIndexStore } from "@legion/index-store";
import { buildStructuralCodeIndex } from "../dist/workflow/code-index.js";
import { collectBrownfieldSignals } from "../dist/workflow/brownfield-signals.js";

const HASH = "a".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeFixture(extraFiles = [], coverageStatusOverrides = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-signals-"));
  const files = new Map([
    ["src/build-&-config.ts", [
      "import { shared } from \"../shared/util.js\";",
      "import { shared } from \"../shared/util.js\";",
      "export function configure(request) {",
      "  const password = \"do-not-persist-this-secret\";",
      "  const payload = request.body; // TODO: bound this input",
      "  try { return shared(payload, password); } catch (error) {}",
      "}",
      "export function placeholder() {}"
    ].join("\n")],
    ["src/consumer-one.ts", "import { shared } from \"./shared.ts\";\nexport const one = shared;\n"],
    ["src/consumer-two.ts", "import { shared } from \"./shared.ts\";\nexport const two = shared;\n"],
    ["src/shared.ts", "export function shared(value) { return value; }\nexport const orphan = 1;\n"],
    ["shared/util.ts", "export function shared(value, secret) { return value; }\n"],
    ["src/build-&-config.test.ts", "import { configure } from \"./build-&-config.js\";\ntest(\"feature\", () => configure({ body: 1 }));\n"],
    ["duplicate/one/index.ts", "export const one = 1;\n"],
    ["duplicate/two/index.ts", "export const two = 2;\n"],
    ["src/parser-error.ts", "export function broken( {\n"],
    ["src/opaque.bin", "binary-ish content\n"],
    ["package.json", "{\"name\":\"fixture\",\"scripts\":{\"build\":\"tsc\"}}\n"],
    [".github/workflows/ci.yml", "name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n"],
    ["README.md", "# Fixture\n\nArchitecture notes are intentionally bounded metadata only.\n"]
  ]);
  for (const [relativePath, text] of extraFiles) files.set(relativePath, text);

  for (const [relativePath, text] of files) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }

  const fileInputs = [...files.entries()].map(([relativePath, text]) => ({
    path: relativePath,
    sha256: sha256(text),
    text
  }));
  const draft = await buildStructuralCodeIndex({
    snapshotId: "idx_000000000000000000000001",
    mapRunId: "run_brownfield-signals",
    generatedAt: "2026-08-26T12:00:00.000Z",
    scope: ".",
    sourceFingerprint: HASH,
    files: fileInputs
  });

  const sqliteRelativePath = ".legion/project/workflow/map/run-brownfield/semantic-index.sqlite";
  const sqlitePath = path.join(repositoryRoot, ...sqliteRelativePath.split("/"));
  await mkdir(path.dirname(sqlitePath), { recursive: true });
  writeCodeIndexStore({
    databasePath: sqlitePath,
    snapshot: {
      symbols: draft.symbols,
      imports: draft.imports,
      exports: draft.exports
    }
  });
  const sqliteBytes = await readFile(sqlitePath);
  const snapshot = codeIndexSnapshotSchema.parse({
    schemaVersion: 1,
    kind: "code_index_snapshot",
    ...draft,
    sqlite: { path: sqliteRelativePath, sha256: sha256(sqliteBytes) }
  });
  snapshot.coverage = snapshot.coverage.map((coverage) => coverageStatusOverrides[coverage.path] === undefined
    ? coverage
    : { ...coverage, status: coverageStatusOverrides[coverage.path] });
  await writeFile(path.join(path.dirname(sqlitePath), "map.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "codebase_map",
    generatedAt: "2026-08-26T12:00:00.000Z",
    scope: ".",
    sourceFingerprint: HASH,
    sourceFileCount: files.size,
    files: [...files.entries()].map(([relativePath, text]) => ({
      path: relativePath,
      sha256: sha256(text),
      sizeBytes: Buffer.byteLength(text),
      lineCount: text.split("\\n").length,
      symbols: [],
      headings: [],
      summary: "fixture"
    }))
  }), "utf8");

  return {
    repositoryRoot,
    sqlitePath,
    snapshot,
    async cleanup() {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  };
}

test("collects deterministic architecture, dependency, test, documentation, and risk signals", async () => {
  const fixture = await makeFixture();
  try {
    const first = await collectBrownfieldSignals(fixture);
    const second = await collectBrownfieldSignals(fixture);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(first.summary.sourceFiles, fixture.snapshot.coverage.length);
    assert.equal(first.summary.coverageFiles, fixture.snapshot.coverage.length);
    assert.equal(first.summary.imports, fixture.snapshot.imports.length);
    assert.equal(first.summary.exports, fixture.snapshot.exports.length);
    assert.equal(first.summary.dependencyEdges, fixture.snapshot.imports.length);
    assert.ok(first.summary.symbols > 0);
    assert.ok(first.summary.testFiles >= 1);
    assert.ok(first.summary.testToSourceLinks >= 1);
    assert.ok(first.summary.highRiskSignals >= 1);
    assert.ok(first.summary.unsupportedSignals >= 1);

    assert.deepEqual(first.testFiles, ["src/build-&-config.test.ts"]);
    assert.deepEqual(first.testToSourceLinks, [{
      testPath: "src/build-&-config.test.ts",
      sourcePath: "src/build-&-config.ts",
      reason: "heuristic filename/path match; low confidence"
    }]);
    assert.ok(first.dependencyEdges.some((edge) =>
      edge.from === "src/build-&-config.ts" && edge.to === "../shared/util.js"
    ));

    const architectureCodes = new Set(first.architectureSignals.map((signal) => signal.code));
    for (const code of [
      "fan-out-hotspot",
      "fan-in-hotspot",
      "orphan-export",
      "duplicate-module-basename",
      "parser-error",
      "unsupported-file",
      "cross-boundary-import",
      "documentation-metadata"
    ]) {
      assert.ok(architectureCodes.has(code), `missing architecture signal ${code}`);
    }

    const riskCodes = new Set(first.riskSignals.map((signal) => signal.code));
    for (const code of [
      "todo-fixme",
      "empty-function",
      "catch-and-ignore",
      "credential-like-string",
      "unbounded-input",
      "missing-test-neighbor",
      "verification-evidence-missing"
    ]) {
      assert.ok(riskCodes.has(code), `missing risk signal ${code}`);
    }

    for (const signal of [...first.architectureSignals, ...first.riskSignals]) {
      assert.ok(signal.evidence.length >= 1, signal.code);
      for (const evidence of signal.evidence) {
        assert.equal(assessmentEvidenceRefSchema.safeParse(evidence).success, true);
        if (evidence.kind === "source-file") {
          assert.match(evidence.path, /^(?!\/)[^\\]+$/u);
          assert.match(evidence.sha256, /^[0-9a-f]{64}$/u);
        }
      }
    }
    for (const edge of first.dependencyEdges) {
      assert.equal(assessmentEvidenceRefSchema.safeParse(edge.evidence).success, true);
      assert.equal(edge.evidence.kind, "structural-fact");
      assert.equal(edge.evidence.path, fixture.snapshot.sqlite.path);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("does not mark exports orphan when an import resolves to the exported module", async () => {
  const fixture = await makeFixture([
    ["src/api.ts", "export function run() {}\nexport default function fallback() {}\n"],
    ["src/api-consumer.ts", "import { run } from \"./api.js\";\nexport const consumed = run;\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const orphanExportPaths = result.architectureSignals
      .filter((signal) => signal.code === "orphan-export")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    assert.equal(orphanExportPaths.includes("src/api.ts"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("links test files only to parsed, supported, non-generated source candidates", async () => {
  const fixture = await makeFixture([
    ["src/feature.py", "def feature():\n    return 1\n"],
    ["src/feature.ts", "export function feature() { return 1; }\n"],
    ["src/feature.test.ts", "test(\"feature\", () => feature());\n"],
    ["src/ambiguous.ts", "export const source = 1;\n"],
    ["lib/ambiguous.ts", "export const source = 2;\n"],
    ["tests/ambiguous.test.ts", "test(\"ambiguous\", () => source);\n"],
    ["generated/only-target.ts", "export const generated = 1;\n"],
    ["generated/only-target.test.ts", "test(\"generated\", () => onlyTarget);\n"],
    ["src/parser-only.ts", "export function broken( {\n"],
    ["src/parser-only.test.ts", "test(\"parser\", () => broken());\n"],
    ["src/blob.bin", "opaque source\n"],
    ["src/blob.test.bin", "test fixture\n"],
    ["src/opaque-target.ts", "opaque target\n"],
    ["src/opaque-target.test.ts", "test(\"opaque\", () => opaqueTarget);\n"],
    ["src/size-target.ts", "size-limited target\n"],
    ["src/size-target.test.ts", "test(\"size\", () => sizeTarget);\n"],
    ["package.test.json", "{\"test\":true}\n"],
    [".github/workflows/ci.test.yml", "name: test CI\n"],
    ["ci/build.yml", "name: build\n"],
    ["ci/build.test.yml", "name: test build\n"],
    ["ci/code-target.ts", "export const ciCode = 1;\n"],
    ["ci/code-target.test.ts", "test(\"ci code\", () => ciCode);\n"],
    ["docs/code-target.ts", "export const docsCode = 1;\n"],
    ["docs/code-target.test.ts", "test(\"docs code\", () => docsCode);\n"],
    ["docs/guide-target.md", "# Guide\n"],
    ["docs/guide-target.test.md", "# Test guide\n"]
  ], {
    "src/opaque-target.ts": "opaque",
    "src/size-target.ts": "size-limited"
  });
  try {
    const result = await collectBrownfieldSignals(fixture);
    assert.deepEqual(result.testToSourceLinks.find((link) => link.testPath === "src/feature.test.ts"), {
      testPath: "src/feature.test.ts",
      sourcePath: "src/feature.ts",
      reason: "heuristic filename/path match; low confidence"
    });
    assert.equal(result.testToSourceLinks.some((link) => link.testPath === "tests/ambiguous.test.ts"), false);
    for (const excludedTestPath of [
      "generated/only-target.test.ts",
      "src/parser-only.test.ts",
      "src/blob.test.bin",
      "src/opaque-target.test.ts",
      "src/size-target.test.ts",
      "package.test.json",
      ".github/workflows/ci.test.yml",
      "ci/build.test.yml",
      "ci/code-target.test.ts",
      "docs/code-target.test.ts",
      "docs/guide-target.test.md"
    ]) {
      assert.equal(result.testToSourceLinks.some((link) => link.testPath === excludedTestPath), false, excludedTestPath);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("keeps ambiguous JavaScript-to-TypeScript module resolution conservative", async () => {
  const fixture = await makeFixture([
    ["src/ambiguous-resolution.ts", "export function typescriptCandidate() { return 1; }\n"],
    ["src/ambiguous-resolution.tsx", "export function tsxCandidate() { return 2; }\n"],
    ["src/ambiguous-resolution-consumer.ts", "import { typescriptCandidate } from \"./ambiguous-resolution.js\";\nexport const consumed = typescriptCandidate;\n"],
    ["src/unreferenced-module.ts", "export const onlyHere = 1;\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const orphanSourcePaths = result.architectureSignals
      .filter((signal) => signal.code === "orphan-export")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    assert.equal(orphanSourcePaths.includes("src/ambiguous-resolution.ts"), false);
    assert.equal(orphanSourcePaths.includes("src/ambiguous-resolution.tsx"), false);
    const unreferencedSignal = result.architectureSignals.find((signal) =>
      signal.code === "orphan-export" && signal.statement.includes("src/unreferenced-module.ts")
    );
    assert.ok(unreferencedSignal);
    assert.match(unreferencedSignal.statement, /unreferenced module-level export heuristic/u);
    assert.doesNotMatch(unreferencedSignal.statement, /matching persisted import name/u);
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when the validated SQLite materialization is missing or tampered", async () => {
  const missing = await makeFixture();
  try {
    await rm(missing.sqlitePath);
    await assert.rejects(
      () => collectBrownfieldSignals(missing),
      /SQLite materialization is missing or unreadable|ENOENT/u
    );
  } finally {
    await missing.cleanup();
  }

  const tampered = await makeFixture();
  try {
    await writeFile(tampered.sqlitePath, "tampered sqlite", "utf8");
    await assert.rejects(
      () => collectBrownfieldSignals(tampered),
      /SQLite materialization hash does not match/u
    );
  } finally {
    await tampered.cleanup();
  }
});

test("fails closed when a coverage-only source file changes after the snapshot", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(path.join(fixture.repositoryRoot, "README.md"), "# Changed after snapshot\n", "utf8");
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /Source file README\.md changed after the validated structural snapshot/u
    );
  } finally {
    await fixture.cleanup();
  }
});

test("does not emit missing-test-neighbor for non-code or generated coverage", async () => {
  const fixture = await makeFixture([
    ["src/untested.ts", "export const untested = 1;\n"],
    ["generated/output.ts", "export const generated = 1;\n"],
    ["src/config.json", "{\"setting\":true}\n"],
    ["src/config.yml", "setting: true\n"],
    ["src/opaque.bin", "opaque content\n"],
    ["docs/guide.md", "# Guide\n"],
    ["ci/build.yml", "name: build\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const missingTestPaths = result.riskSignals
      .filter((signal) => signal.code === "missing-test-neighbor")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    assert.ok(missingTestPaths.includes("src/untested.ts"));
    for (const excludedPath of [
      "generated/output.ts",
      "src/config.json",
      "src/config.yml",
      "src/opaque.bin",
      "docs/guide.md",
      "ci/build.yml"
    ]) {
      assert.equal(missingTestPaths.includes(excludedPath), false, excludedPath);
    }
  } finally {
    await fixture.cleanup();
  }
});
