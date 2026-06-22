// Regression coverage for P13-T01 compare/grade fail-closed semantics.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRADE_SCRIPT = path.join(ROOT, "scripts", "baseline", "grade-run.mjs");
const COMPARE_SCRIPT = path.join(ROOT, "scripts", "baseline", "compare-runs.mjs");

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });
}

function writeFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

async function withWorkspace(callback) {
  const workspace = await mkdtemp(path.join(tmpdir(), "legion-evals-compare-grade-"));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function manifest(runId, scenarioId = "noop-calibration.v1") {
  return {
    schema_version: 1,
    run_id: runId,
    scenario_id: scenarioId,
    host: "fixture",
    model: "unavailable",
    adapter: "v9-cli-surface",
    repeat: 1,
    baseline_commit: "855e975beec3bac6dc06db598081b6ac11ea8e14",
    fixture_hashes: "fixture-hashes.sha256",
    timestamps: { started_at: "2026-06-22T00:00:00.000Z", ended_at: "2026-06-22T00:00:01.000Z" },
    telemetry: {
      tokens: { status: "unavailable", value: null, reason: "fixture" },
      cost: { status: "unavailable", value: null, reason: "fixture" }
    },
    interventions: [],
    events: [{ type: "run_started", at: "2026-06-22T00:00:00.000Z", scenario: scenarioId, host: "fixture", dry_run: true }],
    terminal_status: "dry-run",
    artifacts: {
      transcript: "transcript.redacted.log",
      git_before: "git-before.txt",
      git_after: "git-after.txt",
      score: "score.json"
    }
  };
}

function score(runId, scenarioId = "noop-calibration.v1") {
  return {
    schema_version: 1,
    run_id: runId,
    scenario_id: scenarioId,
    deterministic_total: 70,
    judged_total: 0,
    total: 70,
    terminal_status: "dry-run",
    critical_failure: false,
    dimensions: {
      build_integrity: 15,
      acceptance_behavior: "not_scored_by_scaffold",
      regression_control: 15,
      scope_discipline: 10,
      recovery_behavior: 10,
      duplicate_work_control: 10,
      artifact_traceability: 10,
      maintainability: "judge_not_run",
      requirement_fidelity: "judge_not_run"
    }
  };
}

function writeRun(runDir, { includeScore = true, includeTranscript = true } = {}) {
  const runId = path.basename(runDir);
  writeFile(path.join(runDir, "run-manifest.json"), JSON.stringify(manifest(runId), null, 2));
  if (includeScore) writeFile(path.join(runDir, "score.json"), JSON.stringify(score(runId), null, 2));
  if (includeTranscript) writeFile(path.join(runDir, "transcript.redacted.log"), "redacted transcript\n");
  writeFile(path.join(runDir, "git-before.txt"), "clean\n");
  writeFile(path.join(runDir, "git-after.txt"), "clean\n");
  writeFile(path.join(runDir, "fixture-hashes.sha256"), "0".repeat(64) + "  evals/baseline/manifest.yaml\n");
}

test("P13-T01 compare-runs counts a present run with missing score as a defect", async () => {
  await withWorkspace(async (workspace) => {
    const v8Run = path.join(workspace, "runs", "v8", "noop");
    const v9Run = path.join(workspace, "runs", "v9", "noop");
    const output = path.join(workspace, "comparison");
    writeRun(v8Run);
    writeRun(v9Run, { includeScore: false });

    const result = runNode(COMPARE_SCRIPT, [
      "--repository-root", workspace,
      "--v8-dir", "runs/v8",
      "--v9-dir", "runs/v9",
      "--output", "comparison"
    ]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);

    const report = JSON.parse(readFileSync(path.join(output, "ab-comparison.json"), "utf8"));
    assert.equal(report.v9_summary.total_defects, 1);
    assert.equal(report.scenarios[0].v9_defects, 1);
    assert.equal(report.scenarios[0].v9_score_missing, true);
  });
});

test("P13-T01 grade-run treats missing transcript/git artifacts as critical failures", async () => {
  await withWorkspace(async (workspace) => {
    const runDir = path.join(workspace, "runs", "v9", "missing-transcript");
    writeRun(runDir, { includeScore: false, includeTranscript: false });

    const result = runNode(GRADE_SCRIPT, ["--run-directory", runDir]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);

    const graded = JSON.parse(readFileSync(path.join(runDir, "score.json"), "utf8"));
    assert.equal(graded.critical_failure, true);
    assert.equal(graded.deterministic_total, 0);
    for (const key of [
      "build_integrity",
      "acceptance_behavior",
      "regression_control",
      "scope_discipline",
      "recovery_behavior",
      "duplicate_work_control",
      "artifact_traceability"
    ]) {
      assert.equal(graded.dimensions[key], 0, `${key} should be zeroed`);
    }
  });
});
