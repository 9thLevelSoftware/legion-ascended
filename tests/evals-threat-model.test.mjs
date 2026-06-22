// P13-T02 threat-model orchestrator regression test.
//
// Confirms that threat-model.mjs composes sandbox-guard.mjs and
// retention-audit.mjs correctly: a well-formed sealed run passes all
// three subchecks, and a tampered run surfaces findings from the right
// source. This is the highest-level fail-closed gate the held-out
// security-sensitive contract depends on.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "baseline", "threat-model.mjs");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

async function withWorkspace(callback) {
  const fs = await import("node:fs/promises");
  const workspace = await fs.mkdtemp(path.join(ROOT, ".evals-threat-model-test-"));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const MANIFEST = {
  schema_version: 1,
  run_id: "p13-t02-orchestrator-r1-20260622T000000Z",
  scenario_id: "noop-calibration.v1",
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
  events: [{ type: "run_started", at: "2026-06-22T00:00:00.000Z", scenario: "noop-calibration.v1", host: "fixture", dry_run: true }],
  terminal_status: "dry-run",
  artifacts: {
    transcript: "transcript.redacted.log",
    git_before: "git-before.txt",
    git_after: "git-after.txt",
    score: "score.json"
  }
};

const SCORE = {
  schema_version: 1,
  run_id: "p13-t02-orchestrator-r1-20260622T000000Z",
  scenario_id: "noop-calibration.v1",
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

async function buildSealedRun(runDir) {
  writeJson(path.join(runDir, "run-manifest.json"), MANIFEST);
  writeJson(path.join(runDir, "score.json"), SCORE);
  writeText(path.join(runDir, "transcript.redacted.log"), "[REDACTED_SECRET_CANARY]\nexit_code=0\nstderr: ok\n");
  writeText(path.join(runDir, "git-before.txt"), "(fixture)\n");
  writeText(path.join(runDir, "git-after.txt"), "(fixture)\n");
  const fixtureText = "# fixture\n";
  writeText(path.join(runDir, "workspace", "public-fixture", "task.md"), fixtureText);
  const rel = path.relative(ROOT, path.join(runDir, "workspace", "public-fixture", "task.md"));
  writeText(
    path.join(runDir, "fixture-hashes.sha256"),
    `${createHash("sha256").update(Buffer.from(fixtureText, "utf8")).digest("hex")}  ${rel}\n`
  );
}

test("P13-T02 threat-model orchestrator passes a well-formed sealed run", async () => {
  await withWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    await buildSealedRun(runDir);
    const result = run(["--run-dir", runDir, "--output-root", outputRoot]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const verdict = JSON.parse(result.stdout.trim());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.checks.sandbox.ok, true);
    assert.equal(verdict.checks.retention.ok, true);
    assert.equal(verdict.checks.redaction.ok, true);
    assert.equal(verdict.findings.length, 0);
  });
});

test("P13-T02 threat-model orchestrator fails closed when canary leaks", async () => {
  await withWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    await buildSealedRun(runDir);
    // Tamper with the redacted transcript to re-introduce the canary.
    writeText(
      path.join(runDir, "transcript.redacted.log"),
      "LEGION_SECRET_CANARY_LEAKED_AAAA_BBBB\nexit_code=1\nstderr: tampered\n"
    );
    const result = run(["--run-dir", runDir, "--output-root", outputRoot]);
    assert.notEqual(result.status, 0);
    const verdict = JSON.parse(result.stdout.trim());
    assert.equal(verdict.ok, false);
    assert.equal(verdict.checks.sandbox.ok, false);
    assert.equal(verdict.checks.redaction.ok, false);
    const codes = verdict.findings.map((f) => f.code);
    assert.ok(codes.includes("canary_present_in_redacted_transcript"));
    assert.ok(codes.includes("canary_present_after_redaction"));
  });
});

test("P13-T02 threat-model orchestrator fails closed when raw_transcript.log survives", async () => {
  await withWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    await buildSealedRun(runDir);
    writeText(path.join(runDir, "transcript.raw.log"), "raw survivor\n");
    const result = run(["--run-dir", runDir, "--output-root", outputRoot]);
    assert.notEqual(result.status, 0);
    const verdict = JSON.parse(result.stdout.trim());
    assert.equal(verdict.ok, false);
    const codes = verdict.findings.map((f) => f.code);
    assert.ok(codes.includes("raw_transcript_present"));
  });
});