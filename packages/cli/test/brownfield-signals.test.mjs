import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import { fingerprintSourceFiles } from "../dist/workflow/codebase-map.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exampleCredentialUri() {
  return ["https://", "alice", ":", "super-secret", "@example.test/pkg?api_key=", "another-secret"].join("");
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

  const mapFiles = [...files.entries()]
    .map(([relativePath, text]) => ({
      path: relativePath,
      sha256: sha256(text),
      sizeBytes: Buffer.byteLength(text),
      lineCount: text.split(/\r?\n/u).length,
      symbols: [],
      headings: [],
      summary: "fixture"
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const sourceFingerprint = fingerprintSourceFiles(mapFiles);
  const fileInputs = mapFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    text: files.get(file.path)
  }));
  const draft = await buildStructuralCodeIndex({
    snapshotId: "idx_000000000000000000000001",
    mapRunId: "run_brownfield-signals",
    generatedAt: "2026-08-26T12:00:00.000Z",
    scope: ".",
    sourceFingerprint,
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
    sourceFingerprint,
    sourceFileCount: mapFiles.length,
    files: mapFiles
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
      reason: "parsed, supported, non-generated test-convention path; conventions: delimiter suffix; heuristic filename/path match; low confidence"
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
      "test-coverage-gap",
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

test("discloses bounded fan-out and fan-in hotspot evidence samples", async () => {
  const fanOutImports = Array.from({ length: 9 }, () => "import { shared } from \"./shared.ts\";").join("\n");
  const fanInFiles = Array.from({ length: 9 }, (_, index) => [
    `src/fan-in-${String(index).padStart(2, "0")}.ts`,
    "import { shared } from \"./shared.ts\";\nexport const value = shared;\n"
  ]);
  const fixture = await makeFixture([
    ["src/fan-out.ts", `${fanOutImports}\nexport const value = shared;\n`],
    ...fanInFiles
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const fanOut = result.architectureSignals.find((signal) =>
      signal.code === "fan-out-hotspot" && signal.statement.includes("src/fan-out.ts")
    );
    assert.ok(fanOut);
    assert.match(fanOut.statement, /bounded sample/iu);
    assert.ok(fanOut.evidence.length <= 64);
    assert.ok(fanOut.evidence.every((evidence) => /first 8 hotspot facts; global evidence cap is 64 references/iu.test(evidence.note)));

    const fanIn = result.architectureSignals.find((signal) =>
      signal.code === "fan-in-hotspot" && signal.statement.includes("./shared.ts")
    );
    assert.ok(fanIn);
    assert.match(fanIn.statement, /bounded sample/iu);
    assert.ok(fanIn.evidence.length <= 64);
    assert.ok(fanIn.evidence.every((evidence) => /first 8 hotspot facts; global evidence cap is 64 references/iu.test(evidence.note)));
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

test("does not mark directory index exports orphan when an extensionless import resolves to index module", async () => {
  const fixture = await makeFixture([
    ["src/foo/index.ts", "export function fromDirectory() { return 1; }\n"],
    ["src/foo-consumer.ts", "import { fromDirectory } from \"./foo\";\nexport const consumed = fromDirectory;\n"]
  ]);
  try {
    assert.ok(fixture.snapshot.imports.some((fact) =>
      fact.path === "src/foo-consumer.ts" && fact.specifier === "./foo"
    ));
    assert.ok(fixture.snapshot.exports.some((fact) =>
      fact.path === "src/foo/index.ts" && fact.name === "fromDirectory"
    ));
    const result = await collectBrownfieldSignals(fixture);
    const orphanSourcePaths = result.architectureSignals
      .filter((signal) => signal.code === "orphan-export")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    assert.equal(orphanSourcePaths.includes("src/foo/index.ts"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("links test files only to parsed, supported, non-generated source candidates", async () => {
  const fixture = await makeFixture([
    ["src/feature.py", "def feature():\n    return 1\n"],
    ["src/feature.ts", "export function feature() { return 1; }\n"],
    ["src/feature.test.ts", "test(\"feature\", () => feature());\n"],
    ["src/Foo.py", "def foo():\n    return 1\n"],
    ["tests/FooTest.py", "def test_foo():\n    return foo()\n"],
    ["tests/test_feature.py", "def test_feature():\n    return feature()\n"],
    ["tests/test-feature.py", "def test_feature_hyphenated():\n    return feature()\n"],
    ["src/FooTest.java", "class FooTest {}\n"],
    ["src/FooTests.swift", "final class FooTests {}\n"],
    ["src/FeatureSpec.scala", "class FeatureSpec\n"],
    ["src/contest.java", "class Contest {}\n"],
    ["src/main.ts", "export function main() { return 1; }\n"],
    ["tests/main_test.go", "package main\n\nfunc TestMain(t *testing.T) {}\n"],
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
      reason: "parsed, supported, non-generated test-convention path; conventions: delimiter suffix; heuristic filename/path match; low confidence"
    });
    assert.deepEqual(result.testFiles, [
      "ci/code-target.test.ts",
      "src/FeatureSpec.scala",
      "src/FooTest.java",
      "src/FooTests.swift",
      "src/build-&-config.test.ts",
      "src/feature.test.ts",
      "src/opaque-target.test.ts",
      "src/parser-only.test.ts",
      "src/size-target.test.ts",
      "tests/FooTest.py",
      "tests/ambiguous.test.ts",
      "tests/main_test.go",
      "tests/test-feature.py",
      "tests/test_feature.py"
    ]);
    const expectedLinkConventions = new Map([
      ["src/feature.test.ts", "delimiter suffix"],
      ["tests/FooTest.py", "directory, CamelCase suffix"],
      ["tests/test-feature.py", "directory, prefix"],
      ["tests/test_feature.py", "directory, prefix"]
    ]);
    for (const [testPath, sourcePath] of [
      ["src/feature.test.ts", "src/feature.ts"],
      ["tests/FooTest.py", "src/Foo.py"],
      ["tests/test-feature.py", "src/feature.py"],
      ["tests/test_feature.py", "src/feature.py"]
    ]) {
      assert.deepEqual(result.testToSourceLinks.find((link) => link.testPath === testPath), {
        testPath,
        sourcePath,
        reason: `parsed, supported, non-generated test-convention path; conventions: ${expectedLinkConventions.get(testPath)}; heuristic filename/path match; low confidence`
      });
    }
    for (const inventoryPath of ["src/FooTest.java", "src/FooTests.swift", "src/FeatureSpec.scala"]) {
      assert.ok(result.testFiles.includes(inventoryPath), inventoryPath);
      assert.equal(result.testToSourceLinks.some((link) => link.testPath === inventoryPath), false, inventoryPath);
    }
    assert.equal(result.testFiles.includes("src/contest.java"), false);
    assert.equal(result.testToSourceLinks.filter((link) => link.sourcePath === "src/feature.py").length, 2);
    assert.equal(result.testToSourceLinks.find((link) => link.testPath === "tests/FooTest.py")?.sourcePath, "src/Foo.py");
    assert.equal(result.testToSourceLinks.find((link) => link.testPath === "tests/test-feature.py")?.sourcePath, "src/feature.py");
    assert.equal(result.testToSourceLinks.find((link) => link.testPath === "tests/test_feature.py")?.sourcePath, "src/feature.py");
    assert.deepEqual(result.testToSourceLinks.find((link) => link.testPath === "ci/code-target.test.ts"), {
      testPath: "ci/code-target.test.ts",
      sourcePath: "ci/code-target.ts",
      reason: "parsed, supported, non-generated test-convention path; conventions: delimiter suffix; heuristic filename/path match; low confidence"
    });
    assert.equal(result.testToSourceLinks.some((link) => link.testPath === "tests/ambiguous.test.ts"), false);
    assert.equal(result.testToSourceLinks.some((link) => link.testPath === "tests/main_test.go"), false);
    for (const excludedTestPath of [
      "generated/only-target.test.ts",
      "src/parser-only.test.ts",
      "src/blob.test.bin",
      "src/opaque-target.test.ts",
      "src/size-target.test.ts",
      "package.test.json",
      ".github/workflows/ci.test.yml",
      "ci/build.test.yml",
      "docs/code-target.test.ts",
      "docs/guide-target.test.md"
    ]) {
      assert.equal(result.testToSourceLinks.some((link) => link.testPath === excludedTestPath), false, excludedTestPath);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("classifies test-looking CI paths as verification risk without inventorying them as tests", async () => {
  const fixture = await makeFixture([
    [".github/workflows/ci.test.yml", "name: test CI\njobs:\n  verify:\n    runs-on: ubuntu-latest\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    assert.equal(result.testFiles.includes(".github/workflows/ci.test.yml"), false);
    const verificationSignals = result.riskSignals.filter((signal) => signal.code === "verification-evidence-missing");
    assert.ok(verificationSignals.some((signal) => signal.evidence.some((evidence) =>
      evidence.kind === "source-file" && evidence.path === ".github/workflows/ci.test.yml" &&
      evidence.note.includes("Manifest or CI source file")
    )));
    const ordinaryTestPath = "src/build-&-config.test.ts";
    assert.equal(result.riskSignals
      .filter((signal) => signal.code !== "verification-evidence-missing")
      .some((signal) => signal.evidence.some((evidence) => evidence.kind === "source-file" && evidence.path === ordinaryTestPath)), false);
  } finally {
    await fixture.cleanup();
  }
});

test("classifies CircleCI and Travis config paths without misclassifying CircleCI source", async () => {
  const fixture = await makeFixture([
    [".circleci/config.yml", "version: 2.1\njobs: {}\n"],
    [".circleci/config.test.yml", "version: 2.1\njobs: {}\n"],
    [".circleci/config.yaml", "version: 2.1\njobs: {}\n"],
    [".circleci/runner.ts", "export const runner = true;\n"],
    [".travis.yml", "language: node_js\n"],
    [".travis.yaml", "language: node_js\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const verificationPaths = result.riskSignals
      .filter((signal) => signal.code === "verification-evidence-missing")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    for (const ciPath of [
      ".circleci/config.yml",
      ".circleci/config.test.yml",
      ".circleci/config.yaml",
      ".travis.yml",
      ".travis.yaml"
    ]) {
      assert.ok(verificationPaths.includes(ciPath), ciPath);
      assert.equal(result.testFiles.includes(ciPath), false, ciPath);
    }
    assert.equal(verificationPaths.includes(".circleci/runner.ts"), false);
    assert.equal(result.testFiles.includes(".circleci/runner.ts"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("classifies an exact parent relative import as cross-boundary without claiming resolution", async () => {
  const fixture = await makeFixture([
    ["src/parent-import.ts", "import \"..\";\nexport const parent = true;\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const signal = result.architectureSignals.find((candidate) =>
      candidate.code === "cross-boundary-import" && candidate.statement.includes("src/parent-import.ts")
    );
    assert.ok(signal);
    assert.match(signal.statement, /specifier \.\./u);
    assert.match(signal.statement, /not resolved here/u);
    assert.ok(signal.evidence.some((evidence) =>
      evidence.kind === "source-file" && evidence.path === "src/parent-import.ts"
    ));
    assert.deepEqual(result.dependencyEdges.find((edge) => edge.from === "src/parent-import.ts"), {
      from: "src/parent-import.ts",
      to: "..",
      evidence: signal.evidence.find((evidence) => evidence.kind === "structural-fact")
    });
  } finally {
    await fixture.cleanup();
  }
});

test("resolves a scaled duplicate-basename inventory with bounded links", async () => {
  const duplicateCount = 1_024;
  const duplicateFiles = Array.from({ length: duplicateCount }, (_, index) => {
    const directory = `duplicates/${String(index).padStart(4, "0")}`;
    return [
      [`${directory}/index.ts`, `export const value${index} = ${index};\n`],
      [`${directory}/index.test.ts`, `test("index ${index}", () => value${index});\n`]
    ];
  }).flat();
  const fixture = await makeFixture(duplicateFiles);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const links = result.testToSourceLinks.filter((link) => link.testPath.startsWith("duplicates/"));
    assert.equal(links.length, duplicateCount);
    assert.equal(new Set(links.map((link) => link.testPath)).size, duplicateCount);
    assert.equal(new Set(links.map((link) => link.sourcePath)).size, duplicateCount);
    for (const link of links) {
      assert.equal(link.sourcePath, link.testPath.replace(/\.test(?=\.ts$)/u, ""));
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

test("fails closed when a direct SQLite or map artifact is a symlink", async (t) => {
  const sqliteFixture = await makeFixture();
  try {
    const sqliteRealPath = `${sqliteFixture.sqlitePath}.real`;
    await rename(sqliteFixture.sqlitePath, sqliteRealPath);
    try {
      await symlink(sqliteRealPath, sqliteFixture.sqlitePath, "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => collectBrownfieldSignals(sqliteFixture),
      /symbolic link|regular file|unreadable/u
    );
  } finally {
    await sqliteFixture.cleanup();
  }

  const mapFixture = await makeFixture();
  try {
    const mapPath = path.join(path.dirname(mapFixture.sqlitePath), "map.json");
    const mapRealPath = `${mapPath}.real`;
    await rename(mapPath, mapRealPath);
    try {
      await symlink(mapRealPath, mapPath, "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => collectBrownfieldSignals(mapFixture),
      /symbolic link|regular file|unreadable/u
    );
  } finally {
    await mapFixture.cleanup();
  }
});

test("fails closed when an artifact parent symlink escapes the repository", async (t) => {
  const fixture = await makeFixture();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-outside-"));
  try {
    const repositoryLegionRoot = path.join(fixture.repositoryRoot, ".legion");
    const externalLegionRoot = path.join(outsideRoot, ".legion");
    await rename(repositoryLegionRoot, externalLegionRoot);
    try {
      await symlink(externalLegionRoot, repositoryLegionRoot, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /escapes repository root through a symlink|unsafe|symbolic link/u
    );
  } finally {
    await fixture.cleanup();
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("fails closed when a validated source file is a symlink even when target bytes match its hash", async (t) => {
  const fixture = await makeFixture();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-source-outside-"));
  try {
    const sourcePath = "src/shared.ts";
    const sourceAbsolutePath = path.join(fixture.repositoryRoot, ...sourcePath.split("/"));
    const outsidePath = path.join(outsideRoot, "shared.ts");
    const sourceBytes = await readFile(sourceAbsolutePath);
    const expectedHash = sha256(sourceBytes);
    await writeFile(outsidePath, sourceBytes);
    await rm(sourceAbsolutePath);
    try {
      await symlink(outsidePath, sourceAbsolutePath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.equal(sha256(await readFile(outsidePath)), expectedHash);
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /symbolic link|unsafe source path|outside repository/u
    );
  } finally {
    await fixture.cleanup();
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("fails closed when a validated source parent is a symlink even when target bytes match their hashes", async (t) => {
  const fixture = await makeFixture();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-source-parent-outside-"));
  try {
    const repositorySourceRoot = path.join(fixture.repositoryRoot, "src");
    const outsideSourceRoot = path.join(outsideRoot, "src");
    const sourceBytes = await readFile(path.join(repositorySourceRoot, "shared.ts"));
    const expectedHash = sha256(sourceBytes);
    await rename(repositorySourceRoot, outsideSourceRoot);
    assert.equal(sha256(await readFile(path.join(outsideSourceRoot, "shared.ts"))), expectedHash);
    try {
      await symlink(outsideSourceRoot, repositorySourceRoot, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /symbolic link|unsafe source path|outside repository/u
    );
  } finally {
    await fixture.cleanup();
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("fails closed when a validated source path is a non-regular file", async () => {
  const fixture = await makeFixture();
  try {
    const sourcePath = "src/shared.ts";
    const sourceAbsolutePath = path.join(fixture.repositoryRoot, ...sourcePath.split("/"));
    await rm(sourceAbsolutePath, { recursive: true, force: true });
    await mkdir(sourceAbsolutePath);
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /not a regular file|unsafe source path/u
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when a missing map inventory cannot be opened", async () => {
  const fixture = await makeFixture();
  try {
    await rm(path.join(path.dirname(fixture.sqlitePath), "map.json"));
    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /Snapshot source hash inventory is missing or unreadable|ENOENT/u
    );
  } finally {
    await fixture.cleanup();
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

test("fails closed when a changed coverage-only file is hidden by rewriting its map hash and fingerprint", async () => {
  const fixture = await makeFixture();
  try {
    const mapPath = path.join(path.dirname(fixture.sqlitePath), "map.json");
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const changedText = "# Changed after snapshot and rewritten map\n";
    await writeFile(path.join(fixture.repositoryRoot, "README.md"), changedText, "utf8");
    const readme = map.files.find((file) => file.path === "README.md");
    readme.sha256 = sha256(changedText);
    map.sourceFingerprint = fingerprintSourceFiles(map.files);
    await writeFile(mapPath, JSON.stringify(map), "utf8");

    await assert.rejects(
      () => collectBrownfieldSignals(fixture),
      /does not match the validated structural snapshot fingerprint/u
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed for every map inventory binding mismatch", async () => {
  const mutations = {
    path: (map) => {
      map.files[0].path = "renamed-source.ts";
    },
    hash: (map) => {
      map.files[0].sha256 = "b".repeat(64);
    },
    count: (map) => {
      map.sourceFileCount += 1;
    },
    scope: (map) => {
      map.scope = "src";
    },
    fingerprint: (map) => {
      map.sourceFingerprint = "c".repeat(64);
    }
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    const fixture = await makeFixture();
    try {
      const mapPath = path.join(path.dirname(fixture.sqlitePath), "map.json");
      const map = JSON.parse(await readFile(mapPath, "utf8"));
      mutate(map);
      await writeFile(mapPath, JSON.stringify(map), "utf8");
      await assert.rejects(() => collectBrownfieldSignals(fixture), undefined, label);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("does not emit test-coverage-gap for non-code or generated coverage", async () => {
  const fixture = await makeFixture([
    ["src/untested.ts", "export const untested = 1;\n"],
    ["generated/output.ts", "export const generated = 1;\n"],
    ["src/config.json", "{\"setting\":true}\n"],
    ["src/config.yml", "setting: true\n"],
    ["src/opaque.bin", "opaque content\n"],
    ["docs/guide.md", "# Guide\n"],
    ["ci/build.yml", "name: build\n"],
    ["ci/untested.ts", "export const ciUntested = 1;\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const missingTestPaths = result.riskSignals
      .filter((signal) => signal.code === "test-coverage-gap")
      .flatMap((signal) => signal.evidence)
      .filter((evidence) => evidence.kind === "source-file")
      .map((evidence) => evidence.path);
    assert.ok(missingTestPaths.includes("src/untested.ts"));
    assert.ok(missingTestPaths.includes("ci/untested.ts"));
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

test("redacts credential-bearing external import specifiers from serialized signals", async () => {
  const credentialUri = exampleCredentialUri();
  const fixture = await makeFixture([
    ["src/external-a.ts", `import ${JSON.stringify(credentialUri)};\n`],
    ["src/external-b.ts", `import ${JSON.stringify(credentialUri)};\n`],
    ["src/relative-external-a.ts", `import ${JSON.stringify(`./${credentialUri}`)};\n`],
    ["src/relative-external-b.ts", `import ${JSON.stringify(`./${credentialUri}`)};\n`]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret|another-secret|alice:|https:\/\/alice/u);
    assert.match(serialized, /opaque external import specifier \(redacted\)/u);
    assert.ok(result.dependencyEdges.some((edge) => edge.to === "opaque external import specifier (redacted)"));
    const fanIn = result.architectureSignals.find((signal) =>
      signal.code === "fan-in-hotspot" && signal.statement.includes("opaque external import specifier (redacted)")
    );
    assert.ok(fanIn);
    assert.match(fanIn.statement, /opaque external import specifier \(redacted\)/u);
  } finally {
    await fixture.cleanup();
  }
});

test("preserves readable builtin import specifiers in serialized signals", async () => {
  const fixture = await makeFixture([
    ["src/node-fs.ts", "import { readFile } from \"node:fs\";\nexport const read = readFile;\n"],
    ["src/fs.ts", "import { readFile } from \"fs\";\nexport const read = readFile;\n"]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const serialized = JSON.stringify(result);
    assert.match(serialized, /node:fs/u);
    assert.match(serialized, /"to":"fs"/u);
    assert.ok(result.dependencyEdges.some((edge) => edge.to === "node:fs"));
    assert.ok(result.dependencyEdges.some((edge) => edge.to === "fs"));
    assert.equal(serialized.includes("opaque external import specifier (redacted)"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("redacts percent-encoded URI, userinfo, and query secrets from serialized signals", async () => {
  const encodedUri = "./https%3A%2F%2Fexample.test%2Fpkg";
  const encodedCredentials = "./service%3A%2F%2Falice%3Asuper-secret%40example.test%2Fpkg%3Fapi_key%3Danother-secret%26password%3Dsuper-secret";
  const encodedBoundary = "../service%3A%2F%2Falice%3Asuper-secret%40example.test%2Fpkg%3Fapi_key%3Danother-secret";
  const fixture = await makeFixture([
    ["src/encoded-uri-a.ts", `import \"${encodedUri}\";\n`],
    ["src/encoded-uri-b.ts", `import \"${encodedUri}\";\n`],
    ["src/encoded-credentials-a.ts", `import \"${encodedCredentials}\";\n`],
    ["src/encoded-credentials-b.ts", `import \"${encodedCredentials}\";\n`],
    ["src/encoded-boundary.ts", `import \"${encodedBoundary}\";\n`]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret|another-secret|alice|api_key|password|https/u);
    assert.match(serialized, /opaque external import specifier \(redacted\)/u);
    assert.ok(result.dependencyEdges.filter((edge) => edge.to === "opaque external import specifier (redacted)").length >= 5);
    assert.ok(result.architectureSignals.some((signal) =>
      signal.code === "fan-in-hotspot" && signal.statement.includes("opaque external import specifier (redacted)")
    ));
    assert.ok(result.architectureSignals.some((signal) =>
      signal.code === "cross-boundary-import" && signal.statement.includes("opaque external import specifier (redacted)")
    ));
  } finally {
    await fixture.cleanup();
  }
});

test("redacts deeply percent-encoded credential URI secrets from serialized signals", async () => {
  const credentialUri = exampleCredentialUri();
  let deeplyEncodedCredentialUri = credentialUri;
  for (let depth = 0; depth < 4; depth += 1) deeplyEncodedCredentialUri = encodeURIComponent(deeplyEncodedCredentialUri);
  const deeplyEncodedSpecifier = `./${deeplyEncodedCredentialUri}`;
  const fixture = await makeFixture([
    ["src/deeply-encoded-a.ts", `import "${deeplyEncodedSpecifier}";\n`],
    ["src/deeply-encoded-b.ts", `import "${deeplyEncodedSpecifier}";\n`]
  ]);
  try {
    const result = await collectBrownfieldSignals(fixture);
    const serializedSignals = JSON.stringify({
      dependencyEdges: result.dependencyEdges,
      architectureStatements: result.architectureSignals.map((signal) => signal.statement)
    });
    assert.doesNotMatch(serializedSignals, /super-secret|another-secret|api_key/u);
    assert.match(serializedSignals, /opaque external import specifier \(redacted\)/u);
    assert.ok(result.dependencyEdges.some((edge) => edge.to === "opaque external import specifier (redacted)"));
    assert.ok(result.architectureSignals.some((signal) =>
      signal.code === "fan-in-hotspot" && signal.statement.includes("opaque external import specifier (redacted)")
    ));
  } finally {
    await fixture.cleanup();
  }
});

test("recognizes case-sensitive CamelCase test prefixes and links unique source neighbors", async () => {
  const fixture = await makeFixture([
    ["src/Foo.java", "class Foo {}\n"],
    ["src/Foo.cs", "class Foo {}\n"],
    ["src/TestFoo.java", "class TestFoo {}\n"],
    ["src/TestFoo.cs", "class TestFoo {}\n"],
    ["src/Bar.java", "class Bar {}\n"],
    ["src/TestsBar.java", "class TestsBar {}\n"],
    ["src/Baz.cs", "class Baz {}\n"],
    ["src/SpecBaz.cs", "class SpecBaz {}\n"],
    ["src/Contest.java", "class Contest {}\n"]
  ], {
    "src/Foo.java": "parsed",
    "src/Foo.cs": "parsed",
    "src/TestFoo.java": "parsed",
    "src/TestFoo.cs": "parsed",
    "src/Bar.java": "parsed",
    "src/TestsBar.java": "parsed",
    "src/Baz.cs": "parsed",
    "src/SpecBaz.cs": "parsed"
  });
  try {
    const result = await collectBrownfieldSignals(fixture);
    const expectedTestPaths = ["src/SpecBaz.cs", "src/TestFoo.cs", "src/TestFoo.java", "src/TestsBar.java"];
    for (const testPath of expectedTestPaths) assert.ok(result.testFiles.includes(testPath), testPath);
    assert.equal(result.testFiles.includes("src/Contest.java"), false);
    assert.deepEqual(
      result.testToSourceLinks.filter((link) => expectedTestPaths.includes(link.testPath)),
      [
        ["src/SpecBaz.cs", "src/Baz.cs"],
        ["src/TestFoo.cs", "src/Foo.cs"],
        ["src/TestFoo.java", "src/Foo.java"],
        ["src/TestsBar.java", "src/Bar.java"]
      ].map(([testPath, sourcePath]) => ({
        testPath,
        sourcePath,
        reason: "parsed, supported, non-generated test-convention path; conventions: prefix; heuristic filename/path match; low confidence"
      }))
    );
  } finally {
    await fixture.cleanup();
  }
});

test("bounds source evidence and transient reads for large polyglot inventories", async () => {
  const bulkTests = Array.from({ length: 1_025 }, (_, index) => [
    `tests/polyglot-${String(index).padStart(4, "0")}.test.ts`,
    "test(\"polyglot\", () => polyglot());\n"
  ]);
  const bulkSources = Array.from({ length: 1_025 }, (_, index) => [
    `src/polyglot-${String(index).padStart(4, "0")}.ts`,
    `export const polyglot${index} = ${index};\n`
  ]);
  const fixture = await makeFixture([
    ...bulkTests,
    ...bulkSources,
    ["src/large.ts", `// ${"x".repeat(400_000)}\nexport const large = 1;\n`]
  ]);
  try {
    const startedAt = performance.now();
    const result = await collectBrownfieldSignals(fixture);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 10_000, `collector took ${elapsedMs.toFixed(0)}ms for 1,025 source/test candidates`);
    assert.ok(result.summary.testFiles >= 1_025);
    assert.equal(result.testFiles.length, result.summary.testFiles);
    assert.ok(result.testFiles.includes("tests/polyglot-1024.test.ts"));
    assert.ok(result.testFiles.every((testPath) => testPath.endsWith(".go") || testPath.endsWith(".ts")));
    assert.equal(result.testToSourceLinks.filter((link) => link.testPath.startsWith("tests/polyglot-")).length, 1_025);
    assert.ok(result.testToSourceLinks.some((link) =>
      link.testPath === "tests/polyglot-1024.test.ts" && link.sourcePath === "src/polyglot-1024.ts"
    ));

    for (const signal of [...result.architectureSignals, ...result.riskSignals]) {
      assert.ok(signal.evidence.length <= 64, signal.code);
      if (signal.statement.includes("bounded sample")) {
        assert.ok(signal.evidence.length <= 64, signal.code);
        assert.ok(signal.evidence.every((evidence) => /bounded sample/iu.test(evidence.note)), signal.code);
      }
    }
    const verificationSignal = result.riskSignals.find((signal) => signal.code === "verification-evidence-missing");
    assert.ok(verificationSignal);
    assert.ok(verificationSignal.evidence.length <= 64);
    assert.match(verificationSignal.statement, /bounded sample/u);
    assert.doesNotMatch(JSON.stringify(result), /x{1000}/u);
    assert.doesNotMatch(JSON.stringify(result), /source contents|text:/u);
  } finally {
    await fixture.cleanup();
  }
});

test("retains only source metadata and risk booleans from one opened read", async () => {
  const implementation = await readFile(new URL("../src/workflow/brownfield-signals.ts", import.meta.url), "utf8");
  const riskCollectorStart = implementation.indexOf("async function collectRiskSignals");
  const publicCollectorStart = implementation.indexOf("export async function collectBrownfieldSignals");
  assert.ok(riskCollectorStart >= 0);
  assert.ok(publicCollectorStart > riskCollectorStart);
  const riskCollector = implementation.slice(riskCollectorStart, publicCollectorStart);

  assert.match(implementation, /async function inspectSourceFile/u);
  assert.match(implementation, /patternMatches: RiskPatternMatches/u);
  assert.match(riskCollector, /observation\.patternMatches/u);
  assert.doesNotMatch(implementation, /readonly text:\s*string/u);
});

test("wires the collector regression suite into the CLI package test script", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts?.test, "node --test \"test/**/*.test.mjs\"");
});
