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

async function makeFixture(extraFiles = []) {
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

test("links test files only to unique or convention-compatible source candidates", async () => {
  const fixture = await makeFixture([
    ["src/feature.py", "def feature():\n    return 1\n"],
    ["src/feature.ts", "export function feature() { return 1; }\n"],
    ["src/feature.test.ts", "test(\"feature\", () => feature());\n"],
    ["src/ambiguous.ts", "export const source = 1;\n"],
    ["lib/ambiguous.ts", "export const source = 2;\n"],
    ["tests/ambiguous.test.ts", "test(\"ambiguous\", () => source);\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    assert.deepEqual(result.testToSourceLinks.find((link) => link.testPath === "src/feature.test.ts"), {
      testPath: "src/feature.test.ts",
      sourcePath: "src/feature.ts",
      reason: "heuristic filename/path match; low confidence"
    });
    assert.equal(result.testToSourceLinks.some((link) => link.testPath === "tests/ambiguous.test.ts"), false);
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
