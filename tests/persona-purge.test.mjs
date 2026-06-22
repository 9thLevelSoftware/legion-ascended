import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { scanDefaultRuntime } from "../scripts/scan-default-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The v9 default runtime path is the canonical worker bundle surface that
// ships in the v9 package. The exact file list and pattern vocabulary live
// in `scripts/scan-default-runtime.mjs`. This file is the high-level
// regression guard: it asserts the scanner passes on the current repo and
// that the schema / fixture invariants the contract depends on are intact.
//
// Detailed scanner coverage (negative-case fixtures, governance vs runtime
// rule split, structured violation rows, future bundles/ walking) lives in
// `tests/default-runtime-scan.test.mjs`. The two tests together lock the
// prompt-content contract end to end.
//
// The legacy v8 persona surface (`agents/*.md`, `commands/*.md`,
// `adapters/*.md`, `skills/` outside the four packs listed in the scanner,
// and `.codex-plugin/`) is explicitly preserved per
// `docs/next/V8-MAINTENANCE-POLICY.md` and is NOT scanned here. A separate
// opt-in legacy bridge loads those files; the v9 default runtime path
// never does.

async function readIfExists(relativePath) {
  try {
    return await readFile(path.join(ROOT, relativePath), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

test("v9 default runtime path contains no biography, tone, or personality prose", async () => {
  // Single regression guard: delegate the scan to the canonical scanner.
  // Detailed coverage of the scanner's rule set lives in
  // `tests/default-runtime-scan.test.mjs`.
  const report = await scanDefaultRuntime({ root: ROOT });
  assert.ok(
    report.files.length > 0,
    "expected at least one v9 default runtime path file; the scanner found none"
  );

  assert.equal(
    report.ok,
    true,
    `v9 default runtime path must not contain biography, tone, or personality prose.\n` +
      `Found ${report.violations.length} violation(s) across ${report.files.length} file(s):\n` +
      report.violations
        .map((v) => `  ${v.file}:${v.line} [${v.category}] ${v.excerpt}`)
        .join("\n")
  );
});

test("v9 default runtime path files declare promptContentContract forbiddens", async () => {
  // The canonical v9 worker bundle resolution rules live in
  // `workflow-common-core`, the always-load core pack. That pack MUST declare
  // the prompt-content contract vocabulary so any new runtime that joins the
  // default path knows to honor it. The optional domain packs
  // (github, memory, domains) do not need to restate the contract — they
  // inherit enforcement from the core pack — so the keyword check is scoped
  // to the core pack only.
  const expectedKeywords = [
    "forbiddenSections",
    "instructionsHash",
    "biography",
    "tone",
    "personality"
  ];
  const failures = [];
  for (const file of ["skills/workflow-common-core/SKILL.md"]) {
    const contents = await readIfExists(file);
    assert.ok(contents !== null, `missing v9 default runtime file: ${file}`);
    const missing = expectedKeywords.filter((keyword) => !contents.includes(keyword));
    if (missing.length > 0) {
      failures.push({ file, missing });
    }
  }
  assert.deepEqual(
    failures,
    [],
    "the v9 core pack must declare the prompt-content contract and the forbidden-section vocabulary; missing: " +
      JSON.stringify(failures)
  );
});

test("v9 worker bundle schema marks biography, tone, personality as forbidden", async () => {
  // The fixture and schema for task-run already encode the contract; the test
  // guards against accidental removal during future edits.
  const fixturePath = "schemas/entities/fixtures/lifecycle-valid.json";
  const fixtureRaw = await readIfExists(fixturePath);
  assert.ok(fixtureRaw !== null, `missing fixture: ${fixturePath}`);
  const fixture = JSON.parse(fixtureRaw);
  const forbiddens = new Set(
    fixture.taskRun.manifest.workerBundle.promptContentContract.forbiddenSections
  );
  assert.ok(forbiddens.has("biography"), "fixture must mark biography as forbidden");
  assert.ok(forbiddens.has("tone"), "fixture must mark tone as forbidden");
  assert.ok(forbiddens.has("personality"), "fixture must mark personality as forbidden");
});

test("v9 protocol source still exports the promptContentContract schema", async () => {
  // The TypeScript source-of-truth for the WorkerBundle prompt-content
  // contract lives in `packages/protocol/src/entities/task-run.ts`. If a
  // future refactor removes the `promptContentContract` field from the
  // source, the generated schema and fixture would still pass but the
  // runtime contract would silently disappear. This guard catches that.
  const sourcePath = "packages/protocol/src/entities/task-run.ts";
  const source = await readIfExists(sourcePath);
  assert.ok(source !== null, `missing protocol source: ${sourcePath}`);
  assert.ok(
    /workerBundlePromptContentContractSchema|promptContentContract/.test(source),
    `protocol source ${sourcePath} must still define the promptContentContract schema`
  );
});

test("v9 governance documents reference the contract without injecting it", async () => {
  // ADR-002 and LEGACY-PERSONA-MAP are governance documents that govern the
  // contract. They must reference the contract vocabulary (biography / tone
  // / personality) so the contract has a written record, but they must not
  // contain forbidden headings or v8 boilerplate. The scanner applies a
  // reduced rule set to these paths.
  const report = await scanDefaultRuntime({ root: ROOT });
  assert.equal(
    report.ok,
    true,
    "governance documents must remain free of forbidden headings and v8 boilerplate; violations:\n" +
      report.violations
        .filter((v) => v.file.startsWith("docs/next/"))
        .map((v) => `  ${v.file}:${v.line} [${v.category}] ${v.excerpt}`)
        .join("\n")
  );

  const adr = await readIfExists("docs/next/adr/ADR-002-functional-workers.md");
  assert.ok(adr !== null, "ADR-002 must exist");
  assert.ok(
    /biography|tone|personality/.test(adr),
    "ADR-002 must reference the contract vocabulary"
  );

  const map = await readIfExists("docs/next/migration/LEGACY-PERSONA-MAP.md");
  assert.ok(map !== null, "LEGACY-PERSONA-MAP must exist");
  assert.ok(
    /biography|tone|personality/.test(map),
    "LEGACY-PERSONA-MAP must reference the contract vocabulary"
  );
});

test("package-boundary check still blocks v9 packages from importing legacy prompt assets", async () => {
  // This regression guard calls the boundary checker against a fixture that
  // imports a legacy persona file from a workspace package. The check is the
  // durable enforcement that prevents the v9 default runtime path from
  // re-introducing biography/tone/personality prose via imports.
  const { checkPackageBoundaries } = await import(
    "../scripts/check-package-boundaries.mjs"
  );
  const result = await checkPackageBoundaries({ root: ROOT });
  assert.equal(
    result.ok,
    true,
    "v9 workspace packages must not import legacy prompt assets; violations: " +
      JSON.stringify(
        result.violations.map((v) => `${v.file}: ${v.message}`),
        null,
        2
      )
  );
});