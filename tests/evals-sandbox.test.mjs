// P13-T02 sandbox boundary + retention policy regression test.
//
// Runs sandbox-guard.mjs and retention-audit.mjs against a synthetic
// sealed run directory. The test exercises both the positive case (a
// well-formed run directory passes) and the negative cases that the
// held-out security-sensitive contract requires us to fail closed on:
//
//   * run_dir escapes output_root  (sandbox)
//   * transcript.raw.log survived   (sandbox + retention)
//   * canary present in redacted transcript (sandbox)
//   * held-out evaluator material leaked into the run dir (retention)
//   * fixture-hashes.sha256 entry is recomputable from on-disk bytes
//
// The test is subprocess-based: it spawns the helper scripts so the
// fail-closed path (non-zero exit code) is exercised at the process
// level, matching how the threat-model.mjs orchestrator invokes them.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts", "baseline");

function runHelper(scriptName, args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, scriptName), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });
  return {
    exit_code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function writeFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8")).digest("hex");
}

async function withTempWorkspace(callback) {
  const workspace = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(ROOT, ".evals-sandbox-test-")));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const SEALED_RUN_FIXTURE = {
  schema_version: 1,
  run_id: "p13-t02-fixture-r1-20260622T000000Z",
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

const SCORE_FIXTURE = {
  schema_version: 1,
  run_id: "p13-t02-fixture-r1-20260622T000000Z",
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
  // Create a minimal but valid sealed run directory.
  writeFile(path.join(runDir, "run-manifest.json"), JSON.stringify(SEALED_RUN_FIXTURE, null, 2));
  writeFile(path.join(runDir, "score.json"), JSON.stringify(SCORE_FIXTURE, null, 2));
  writeFile(path.join(runDir, "transcript.redacted.log"), "[REDACTED_SECRET_CANARY]\nP13-T02 fixture transcript\nexit_code=0\n");
  writeFile(path.join(runDir, "git-before.txt"), "(fixture) nothing to record\n");
  writeFile(path.join(runDir, "git-after.txt"), "(fixture) nothing to record\n");
  const fixturePath = path.join(runDir, "workspace", "public-fixture", "task.md");
  const fixtureText = "# fixture task\n";
  writeFile(fixturePath, fixtureText);
  const rel = path.relative(ROOT, fixturePath);
  writeFile(path.join(runDir, "fixture-hashes.sha256"), `${sha256(fixtureText)}  ${rel}\n`);
}

test("P13-T02 sandbox-guard passes a well-formed sealed run", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-noop-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", runDir,
      "--output-root", outputRoot
    ]);
    assert.equal(result.exit_code, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.findings, []);
  });
});

test("P13-T02 sandbox-guard fails closed when run_dir escapes output_root", async () => {
  await withTempWorkspace(async (workspace) => {
    const runDir = path.join(workspace, "outside", "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", runDir,
      "--output-root", path.join(workspace, "inside")
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.ok(payload.findings.some((f) => f.code === "run_dir_escapes_output_root"));
  });
});

test("P13-T02 sandbox-guard fails closed when run_dir symlink escapes output_root", async (t) => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const externalRunDir = path.join(workspace, "outside", "v9", "p13-r1");
    const linkedRunDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(path.dirname(linkedRunDir), { recursive: true });
    mkdirSync(externalRunDir, { recursive: true });
    await buildSealedRun(externalRunDir);
    try {
      await symlink(externalRunDir, linkedRunDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }

    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", linkedRunDir,
      "--output-root", outputRoot
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.ok(payload.findings.some((f) => f.code === "run_dir_escapes_output_root"));
  });
});

test("P13-T02 sandbox-guard fails closed when manifest artifact symlink escapes run_dir", async (t) => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    const externalTranscript = path.join(workspace, "outside", "transcript.redacted.log");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    writeFile(externalTranscript, "external transcript\n");
    await rm(path.join(runDir, "transcript.redacted.log"), { force: true });
    try {
      await symlink(externalTranscript, path.join(runDir, "transcript.redacted.log"), "file");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }

    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", runDir,
      "--output-root", outputRoot
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.ok(payload.findings.some((f) => f.code === "artifact_path_escapes_run_dir"));
  });
});

test("P13-T02 sandbox-guard fails closed when raw_transcript.log survives", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    writeFile(path.join(runDir, "transcript.raw.log"), "[REDACTED]\n");
    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", runDir,
      "--output-root", outputRoot
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.ok(payload.findings.some((f) => f.code === "raw_transcript_present"));
  });
});

test("P13-T02 sandbox-guard fails closed when canary leaks into redacted transcript", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    writeFile(path.join(runDir, "transcript.redacted.log"), "LEGION_SECRET_CANARY_LEAKED_AAAA\n");
    const result = runHelper("sandbox-guard.mjs", [
      "--run-dir", runDir,
      "--output-root", outputRoot
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "canary_present_in_redacted_transcript"));
  });
});

test("P13-T02 retention-audit fails closed when held-out material is bundled into the run dir", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    // Drop a held-out evaluator fixture into the run dir; the audit must
    // catch this leak.
    writeFile(
      path.join(runDir, "evals", "fixtures", "evaluator", "noop-calibration", "assertions.yaml"),
      "schema_version: 1\nvisible_to_worker: false\n"
    );
    const result = runHelper("retention-audit.mjs", [
      "--run-dir", runDir
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "held_out_material_leaked"));
  });
});

test("P13-T02 retention-audit fails closed when fixture-hashes.sha256 is drifted", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    // Overwrite fixture-hashes.sha256 with a bogus digest that doesn't
    // match the on-disk bytes.
    const fixturePath = path.join(runDir, "workspace", "public-fixture", "task.md");
    const rel = path.relative(ROOT, fixturePath);
    writeFile(path.join(runDir, "fixture-hashes.sha256"), `${"0".repeat(64)}  ${rel}\n`);
    const result = runHelper("retention-audit.mjs", [
      "--run-dir", runDir
    ]);
    assert.notEqual(result.exit_code, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "fixture_hash_drifted"));
  });
});

test("P13-T02 retention-audit passes a well-formed sealed run", async () => {
  await withTempWorkspace(async (workspace) => {
    const outputRoot = path.join(workspace, "runs");
    const runDir = path.join(outputRoot, "v9", "p13-r1");
    mkdirSync(runDir, { recursive: true });
    await buildSealedRun(runDir);
    const result = runHelper("retention-audit.mjs", [
      "--run-dir", runDir
    ]);
    assert.equal(result.exit_code, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.findings, []);
  });
});
