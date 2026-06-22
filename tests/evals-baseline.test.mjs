// P13-T01 regression test: the sealed Phase 0 evaluation baseline must stay
// aligned with the v9 eval harness. We assert:
//
//   1. Every entry in evals/baseline/manifest.yaml (plus the noop
//      calibration scenario) has a matching scenario JSON that validates
//      against evals/baseline/schema/scenario.schema.json.
//   2. Every sealed scenario JSON lists the seven deterministic rubric
//      dimensions and the two judged dimensions required by the Phase 0
//      SCORING-RUBRIC.md.
//   3. The held-out evaluator material referenced by each scenario exists
//      and validates against the oracle-assertions schema.
//   4. The fixture-hashes.sha256 index covers every scenario JSON, every
//      public fixture, and every evaluator fixture. This protects the
//      capture-run.mjs corpus lookup from silently drifting.
//
// Lightweight structural checks only — full JSON-Schema validation lives
// downstream in the capture/grade scripts so the test stays fast.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readText(filePath) {
  return await readFile(path.join(ROOT, filePath), "utf8");
}

const REQUIRED_DETERMINISTIC_CHECKS = [
  "build_integrity",
  "acceptance_behavior",
  "regression_control",
  "scope_discipline",
  "recovery_behavior",
  "duplicate_work_control",
  "artifact_traceability"
];
const REQUIRED_JUDGED_CHECKS = ["maintainability", "requirement_fidelity"];
const REQUIRED_SCENARIO_FAMILIES = [
  "greenfield-feature",
  "brownfield-feature",
  "bug-fix",
  "refactor",
  "api-change",
  "ui-flow",
  "security-sensitive",
  "interrupted-resumed",
  "noop-calibration"
];

function hasAll(values, required) {
  return required.every((entry) => values.includes(entry));
}

test("P13-T01 sealed scenario corpus exposes all Phase 0 scenario families", async () => {
  const yaml = await import("yaml");
  const parsed = yaml.parse(await readText("evals/baseline/manifest.yaml"));
  const families = parsed.scenarios.map((entry) => entry.family);
  assert.ok(hasAll(families, REQUIRED_SCENARIO_FAMILIES.filter((family) => family !== "noop-calibration")),
    `expected all production families present in manifest, got: ${families.join(", ")}`);
  assert.equal(parsed.scenarios.length, 8, "Phase 0 corpus must contain exactly 8 sealed scenarios");
  assert.ok(parsed.calibration?.noop_fixture, "manifest must declare a noop calibration fixture");
});

test("P13-T01 every sealed scenario JSON declares the seven deterministic and two judged checks", async () => {
  const yaml = await import("yaml");
  const parsed = yaml.parse(await readText("evals/baseline/manifest.yaml"));
  const scenarios = [...parsed.scenarios.map((entry) => entry.manifest), "evals/baseline/scenarios/noop-calibration.v1.json"];
  for (const manifestPath of scenarios) {
    const scenario = JSON.parse(await readText(manifestPath));
    assert.equal(scenario.schema_version, 1, `${manifestPath} must declare schema_version 1`);
    assert.ok(scenario.current_repository_state?.baseline_commit?.match(/^[0-9a-f]{40}$/), `${manifestPath} must pin the v8 baseline commit`);
    assert.ok(scenario.held_out_assertions?.visible_to_worker === false, `${manifestPath} must keep held-out assertions hidden from workers`);
    assert.ok(hasAll(scenario.deterministic_checks ?? [], REQUIRED_DETERMINISTIC_CHECKS), `${manifestPath} must list all seven deterministic checks`);
    assert.ok(hasAll(scenario.judged_checks ?? [], REQUIRED_JUDGED_CHECKS), `${manifestPath} must list both judged checks`);
  }
});

test("P13-T01 sealed scenario evaluator material exists for every scenario", async () => {
  const yaml = await import("yaml");
  const parsed = yaml.parse(await readText("evals/baseline/manifest.yaml"));
  const scenarios = [...parsed.scenarios.map((entry) => entry.evaluator_material), "evals/fixtures/evaluator/noop-calibration/assertions.yaml"];
  for (const evaluatorPath of scenarios) {
    const text = await readText(evaluatorPath);
    const assertions = yaml.parse(text);
    assert.equal(assertions.schema_version, 1);
    assert.equal(assertions.visible_to_worker, false);
    assert.ok(Array.isArray(assertions.critical_assertions) && assertions.critical_assertions.length >= 1, `${evaluatorPath} must declare at least one critical assertion`);
  }
});

test("P13-T01 fixture-hashes.sha256 covers every scenario, public fixture, and evaluator fixture", async () => {
  const hashLines = (await readText("evals/baseline/fixture-hashes.sha256")).trim().split("\n");
  const indexed = new Set();
  for (const line of hashLines) {
    const [hash, rel] = line.trim().split(/\s+/);
    assert.match(hash, /^[a-f0-9]{64}$/, `bad hash entry: ${line}`);
    assert.ok(rel && rel.startsWith("evals/"), `hash entry must be repo-relative under evals/: ${line}`);
    indexed.add(rel);
  }

  const yaml = await import("yaml");
  const parsed = yaml.parse(await readText("evals/baseline/manifest.yaml"));
  for (const entry of parsed.scenarios) {
    assert.ok(indexed.has(entry.manifest), `scenario manifest not in fixture-hashes: ${entry.manifest}`);
    assert.ok(indexed.has(entry.public_input), `public input not in fixture-hashes: ${entry.public_input}`);
    assert.ok(indexed.has(entry.evaluator_material), `evaluator material not in fixture-hashes: ${entry.evaluator_material}`);
  }
  assert.ok(indexed.has("evals/baseline/scenarios/noop-calibration.v1.json"));
  assert.ok(indexed.has("evals/fixtures/evaluator/noop-calibration/assertions.yaml"));

  // Sanity: the index must include the corpus manifest itself and the
  // deterministic rubric that grade-run.mjs uses.
  assert.ok(indexed.has("evals/baseline/manifest.yaml"));
  assert.ok(indexed.has("evals/baseline/rubrics/deterministic.yaml"));
});

test("P13-T01 fixture-hashes.sha256 digests are recomputable from the on-disk bytes", async () => {
  // Re-hashing a handful of representative files guards against the canonical
  // hash policy drifting (LF normalization, UTF-8, POSIX-relative paths).
  const yaml = await import("yaml");
  const parsed = yaml.parse(await readText("evals/baseline/manifest.yaml"));
  const representative = [
    "evals/baseline/manifest.yaml",
    "evals/baseline/scenarios/bug-fix.v1.json",
    parsed.scenarios[0].public_input,
    parsed.scenarios[0].evaluator_material
  ];
  const hashLines = (await readText("evals/baseline/fixture-hashes.sha256")).trim().split("\n");
  const expected = new Map();
  for (const line of hashLines) {
    const [hash, rel] = line.trim().split(/\s+/);
    expected.set(rel, hash);
  }
  for (const rel of representative) {
    const bytes = await readFile(path.join(ROOT, rel));
    const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const digest = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    assert.equal(digest, expected.get(rel), `fixture hash drifted for ${rel}`);
  }
});

test("P13-T02 security-sensitive.v1 held-out contract pins the three critical assertions", async () => {
  // The security-sensitive.v1 scenario is the contract that gates
  // P13-T02 hardening: held-out assertions must include
  //   * "configured secret canaries are redacted in retained logs"
  //   * "redaction does not hide command failures"
  //   * "no credential-like value is committed in evidence artifacts"
  // If any of these drift, the eval pipeline must fail closed rather
  // than pretending the contract still holds.
  const yaml = await import("yaml");
  const assertions = yaml.parse(
    await readText("evals/fixtures/evaluator/security-sensitive/assertions.yaml")
  );
  assert.equal(assertions.visible_to_worker, false, "held-out material must remain hidden from workers");
  const critical = assertions.critical_assertions ?? [];
  assert.ok(
    critical.some((entry) => entry.includes("secret canar") && entry.includes("redacted")),
    "must pin: configured secret canaries are redacted in retained logs"
  );
  assert.ok(
    critical.some((entry) => entry.includes("redaction") && entry.includes("hide command failures")),
    "must pin: redaction does not hide command failures"
  );
  assert.ok(
    critical.some((entry) => entry.includes("credential") && entry.includes("committed")),
    "must pin: no credential-like value is committed in evidence artifacts"
  );
  assert.equal(assertions.calibration?.known_bad, "Whole logs are dropped or evidence validation is weakened.");
});
