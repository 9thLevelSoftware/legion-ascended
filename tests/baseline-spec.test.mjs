import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIO_IDS = [
  "greenfield-feature.v1",
  "brownfield-feature.v1",
  "bug-fix.v1",
  "refactor.v1",
  "api-change.v1",
  "ui-flow.v1",
  "security-sensitive.v1",
  "interrupted-resumed.v1"
];
const ORACLE_FAMILIES = [...SCENARIO_IDS.map((id) => id.replace(/\.v\d+$/, "")), "noop-calibration"];


function sha256NormalizedText(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function readYaml(relativePath) {
  return parseYaml(await readFile(path.join(ROOT, relativePath), "utf8"));
}

test("P06-T01 baseline manifest captures corpus governance and oracle fixture policy", async () => {
  const manifest = await readYaml("evals/baseline/manifest.yaml");

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.corpus_id, "legion-v8-baseline-corpus");
  assert.equal(manifest.corpus_version, "1.0.0");
  assert.equal(manifest.status, "accepted-for-p00-t04");
  assert.equal(manifest.created_at, "2026-06-19T17:30:00-04:00");
  assert.equal(manifest.baseline.commit, "855e975beec3bac6dc06db598081b6ac11ea8e14");
  assert.equal(manifest.policy.hidden_material_visible_to_worker, false);
  assert.equal(manifest.policy.evaluator_assertions_schema, "evals/baseline/schema/oracle-assertions.schema.json");
  assert.equal(manifest.policy.fixture_hashes, "evals/baseline/fixture-hashes.sha256");
  assert.match(manifest.policy.fixture_hash_normalization, /LF-normalized UTF-8 text/);
  assert.equal(manifest.scenarios.length, SCENARIO_IDS.length);
  assert.deepEqual(manifest.scenarios.map((scenario) => scenario.id), SCENARIO_IDS);
});

test("P06-T01 corpus alias remains a sealed pointer to the canonical manifest", async () => {
  const corpus = await readYaml("evals/baseline/corpus-manifest.yaml");

  assert.equal(corpus.schema_version, 1);
  assert.equal(corpus.canonical_manifest, "evals/baseline/manifest.yaml");
  assert.equal(corpus.corpus_id, "legion-v8-baseline-corpus");
  assert.equal(corpus.corpus_version, "1.0.0");
  assert.equal(corpus.baseline_commit, "855e975beec3bac6dc06db598081b6ac11ea8e14");
  assert.equal(corpus.fixture_hashes, "evals/baseline/fixture-hashes.sha256");
  assert.deepEqual(corpus.scenario_ids, SCENARIO_IDS);
});

test("P06-T01 scenario manifests preserve held-out oracle paths and scoring inputs", async () => {
  for (const scenarioId of SCENARIO_IDS) {
    const scenario = await readJson(`evals/baseline/scenarios/${scenarioId}.json`);
    const family = scenarioId.replace(/\.v\d+$/, "");

    assert.equal(scenario.schema_version, 1);
    assert.equal(scenario.scenario_id, scenarioId);
    assert.equal(scenario.family, family);
    assert.equal(scenario.corpus_version, "1.0.0");
    assert.equal(scenario.fixture_version, "v1");
    assert.equal(scenario.included_in_corpus, true);
    assert.ok(["R1", "R2", "R3"].includes(scenario.risk_tier));
    assert.equal(scenario.public_input_path, `evals/fixtures/public/${family}/task.md`);
    assert.equal(scenario.evaluator_material_path, `evals/fixtures/evaluator/${family}/assertions.yaml`);
    assert.equal(scenario.held_out_assertions.visible_to_worker, false);
    assert.equal(scenario.held_out_assertions.path, `evals/fixtures/evaluator/${family}/assertions.yaml`);
    assert.ok(Array.isArray(scenario.deterministic_checks));
    assert.ok(scenario.deterministic_checks.length >= 7);
    assert.ok(Array.isArray(scenario.judged_checks));
    assert.ok(scenario.judged_checks.length >= 2);
  }
});

test("P06-T01 oracle assertions are sealed and non-empty", async () => {
  const entries = await readdir(path.join(ROOT, "evals/fixtures/evaluator"), { withFileTypes: true });
  const scenarioDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expectedScenarioDirs = ORACLE_FAMILIES.slice().sort();

  assert.deepEqual(scenarioDirs, expectedScenarioDirs);

  for (const family of scenarioDirs) {
    const assertions = await readYaml(`evals/fixtures/evaluator/${family}/assertions.yaml`);
    assert.equal(assertions.schema_version, 1);
    assert.equal(assertions.scenario_id, `${family}.v1`);
    assert.equal(assertions.visible_to_worker, false);
    assert.ok(Array.isArray(assertions.critical_assertions));
    assert.ok(assertions.critical_assertions.length >= 1);
    assert.equal(assertions.calibration.known_good.length > 0, true);
    assert.equal(assertions.calibration.known_bad.length > 0, true);
  }
});

test("P06-T01 fixture hashes are lowercase, POSIX-relative, and LF-normalized", async () => {
  const lines = (await readFile(path.join(ROOT, "evals/baseline/fixture-hashes.sha256"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);

  assert.equal(lines.length, 33);

  for (const line of lines) {
    const [hash, relPath] = line.split(/\s+/, 2);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(relPath.includes("\\"), false);
    assert.equal(relPath.startsWith("./"), false);

    const absolutePath = path.join(ROOT, relPath);
    const contents = await readFile(absolutePath, "utf8");
    assert.equal(sha256NormalizedText(contents), hash);
  }
});
