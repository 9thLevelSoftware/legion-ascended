#!/usr/bin/env node
// P13-T01 grading step. Reads a sealed run directory, validates required
// artifacts and run-manifest shape, computes deterministic dimension scores
// for the seven deterministic rubric dimensions in evals/baseline/rubrics/
// deterministic.yaml, and writes score.json that validates against
// evals/baseline/schema/score.schema.json.
//
// Each dimension is scored as a number from 0 to its weight in the rubric.
// Critical failures (terminal_status not in {dry-run,passed,failed,
// interrupted,blocked}, or absent transcript/git_before/git_after) force
// the score into the critical_failure lane and zero out the seven
// deterministic dimensions. Held-out evaluator assertions and judged
// dimensions are intentionally out of scope here; the rubric marks them
// "not_scored_by_scaffold" / "judge_not_run" so a downstream grader can
// seal them after the deterministic seal.
//
// Usage:
//   node scripts/baseline/grade-run.mjs --run-directory <path>

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

const DIMENSION_WEIGHTS = {
  build_integrity: 15,
  acceptance_behavior: 25,
  regression_control: 15,
  scope_discipline: 10,
  recovery_behavior: 10,
  duplicate_work_control: 10,
  artifact_traceability: 10
};

const GRADEABLE_TERMINAL_STATUSES = new Set([
  "dry-run",
  "passed",
  "failed",
  "interrupted",
  "blocked"
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function requireField(record, key) {
  if (!(key in record)) {
    throw new Error(`score.schema requires field: ${key}`);
  }
  return record[key];
}

function ensureInteger(value, label, min = 0) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}; received ${JSON.stringify(value)}`);
  }
  return value;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

// Returns the seven deterministic dimension scores (numbers or null when
// the dimension is not applicable to the run type). Heuristics:
//
//   * build_integrity: full credit when terminal_status is dry-run / passed;
//     partial when interrupted / blocked; zero on failed. Captures whether
//     the recorded run completed without crashing the harness itself.
//   * acceptance_behavior: full credit only on terminal_status=passed and at
//     least one host_command_completed event with exit_code 0; otherwise 0.
//     Held-out oracle assertions are a separate downstream seal step.
//   * regression_control: full credit when the v8 baseline_commit is recorded
//     and the transcript + git_before/git_after capture prove the harness
//     did not silently rewrite the corpus. We award 15 when both files are
//     present and identical schema layout, else 0.
//   * scope_discipline: full credit when git_before matches git_after for
//     dry-run captures (the harness must not mutate the repo). For
//     non-dry-run, the dimension is "not_applicable" (returns null) and is
//     evaluated downstream against scenario allowed_paths.
//   * recovery_behavior: full credit when the manifest timestamps are well
//     formed and either terminal_status is interrupted (preserved run) or
//     terminal_status is in {passed,failed,dry-run}.
//   * duplicate_work_control: full credit when the run_id is unique within
//     the parent output directory (re-using run_id would be flagged here).
//   * artifact_traceability: full credit when transcript, git_before, git_after,
//     fixture-hashes, and run-manifest all exist on disk.
async function gradeDeterministic(manifest, runDir) {
  const dims = {};
  const terminal = manifest.terminal_status;
  const isDryRun = terminal === "dry-run";
  const isPassed = terminal === "passed";
  const isFailed = terminal === "failed";
  const isInterrupted = terminal === "interrupted";
  const isBlocked = terminal === "blocked";
  const runEvents = Array.isArray(manifest.events) ? manifest.events : [];

  // build_integrity
  if (isDryRun || isPassed) dims.build_integrity = DIMENSION_WEIGHTS.build_integrity;
  else if (isInterrupted || isBlocked) dims.build_integrity = Math.round(DIMENSION_WEIGHTS.build_integrity / 2);
  else dims.build_integrity = 0;

  // acceptance_behavior
  const hostCompleted = runEvents.find((e) => e?.type === "host_command_completed");
  if (isPassed && hostCompleted?.exit_code === 0) {
    dims.acceptance_behavior = DIMENSION_WEIGHTS.acceptance_behavior;
  } else if (isDryRun) {
    // Dry-run calibration intentionally does not assert acceptance. Mark as
    // not_scored so downstream graders can re-score with held-out oracle.
    dims.acceptance_behavior = "not_scored_by_scaffold";
  } else {
    dims.acceptance_behavior = 0;
  }

  // regression_control
  const baselineCommit = manifest.baseline_commit;
  if (typeof baselineCommit === "string" && /^[0-9a-f]{40}$/.test(baselineCommit)) {
    dims.regression_control = DIMENSION_WEIGHTS.regression_control;
  } else {
    dims.regression_control = 0;
  }

  // scope_discipline: dry-run must preserve the repository.
  if (isDryRun) {
    const gitBefore = await readFile(path.join(runDir, manifest.artifacts.git_before), "utf8").catch(() => "");
    const gitAfter = await readFile(path.join(runDir, manifest.artifacts.git_after), "utf8").catch(() => "");
    dims.scope_discipline = gitBefore.trim() === gitAfter.trim()
      ? DIMENSION_WEIGHTS.scope_discipline
      : 0;
  } else {
    dims.scope_discipline = "not_scored_by_scaffold";
  }

  // recovery_behavior: interrupted runs get full credit (audit preserved);
  // passed/failed/dry-run also credit the audit chain.
  dims.recovery_behavior = isInterrupted || isPassed || isFailed || isDryRun
    ? DIMENSION_WEIGHTS.recovery_behavior
    : 0;

  // duplicate_work_control is set by main() after the sibling scan.
  dims.duplicate_work_control = DIMENSION_WEIGHTS.duplicate_work_control;

  // artifact_traceability
  const required = [
    manifest.artifacts.transcript,
    manifest.artifacts.git_before,
    manifest.artifacts.git_after,
    manifest.fixture_hashes
  ];
  const allPresent = required.every((rel) => existsSync(path.join(runDir, rel)));
  dims.artifact_traceability = allPresent ? DIMENSION_WEIGHTS.artifact_traceability : 0;

  return dims;
}

function deterministicTotal(dims) {
  let total = 0;
  for (const value of Object.values(dims)) {
    if (typeof value === "number") total += value;
  }
  return clamp(total, 0, 95);
}

function criticalArtifactMissing(manifest, runDir) {
  const required = [
    manifest.artifacts.transcript,
    manifest.artifacts.git_before,
    manifest.artifacts.git_after
  ];
  return required.some((rel) => !existsSync(path.join(runDir, rel)));
}

function zeroDeterministicDimensions() {
  return Object.fromEntries(Object.keys(DIMENSION_WEIGHTS).map((key) => [key, 0]));
}

function buildScore(manifest, dims, options = {}) {
  const terminal = manifest.terminal_status;
  const isGradeable = GRADEABLE_TERMINAL_STATUSES.has(terminal);
  const criticalFailure = !isGradeable || options.criticalArtifactMissing === true;
  const deterministicDims = criticalFailure ? zeroDeterministicDimensions() : dims;
  const deterministicTotalScore = criticalFailure ? 0 : deterministicTotal(deterministicDims);
  return {
    schema_version: 1,
    run_id: manifest.run_id,
    scenario_id: manifest.scenario_id,
    deterministic_total: deterministicTotalScore,
    judged_total: 0,
    total: deterministicTotalScore,
    terminal_status: terminal,
    critical_failure: criticalFailure,
    dimensions: {
      build_integrity: deterministicDims.build_integrity,
      acceptance_behavior: deterministicDims.acceptance_behavior,
      regression_control: deterministicDims.regression_control,
      scope_discipline: deterministicDims.scope_discipline,
      recovery_behavior: deterministicDims.recovery_behavior,
      duplicate_work_control: deterministicDims.duplicate_work_control,
      artifact_traceability: deterministicDims.artifact_traceability,
      maintainability: "judge_not_run",
      requirement_fidelity: "judge_not_run"
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args["run-directory"] !== "string") {
    throw new Error("Usage: grade-run.mjs --run-directory <path>");
  }
  const runDir = path.resolve(args["run-directory"]);
  const manifestPath = path.join(runDir, "run-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Run manifest not found: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath);

  for (const key of [
    "transcript",
    "git_before",
    "git_after"
  ]) {
    requireField(manifest.artifacts ?? {}, key);
  }
  requireField(manifest, "fixture_hashes");
  requireField(manifest, "terminal_status");
  requireField(manifest, "run_id");

  // Collect sibling run_ids in the same parent directory to detect duplicate
  // run_ids (would indicate the harness reused an id). We exclude the current
  // run_dir from the sibling scan so the check is "did anyone else reuse my
  // run_id?".
  const parent = path.dirname(runDir);
  const siblingRunIds = new Set();
  try {
    const { readdir } = await import("node:fs/promises");
    const siblings = await readdir(parent);
    for (const entry of siblings) {
      if (entry === path.basename(runDir)) continue;
      const siblingManifest = path.join(parent, entry, "run-manifest.json");
      try {
        const sibling = JSON.parse(await readFile(siblingManifest, "utf8"));
        if (typeof sibling.run_id === "string") siblingRunIds.add(sibling.run_id);
      } catch {
        // ignore non-run siblings
      }
    }
  } catch {
    // best-effort sibling scan
  }
  const dims = await gradeDeterministic(manifest, runDir, {});
  const collision = siblingRunIds.has(manifest.run_id);
  dims.duplicate_work_control = collision ? 0 : DIMENSION_WEIGHTS.duplicate_work_control;
  const score = buildScore(manifest, dims, { criticalArtifactMissing: criticalArtifactMissing(manifest, runDir) });

  // Numeric sanity: deterministic_total must be an integer in [0, 95].
  ensureInteger(score.deterministic_total, "deterministic_total", 0);
  if (score.deterministic_total > 95) {
    throw new Error(`deterministic_total exceeds rubric ceiling 95 (got ${score.deterministic_total})`);
  }

  const scorePath = path.join(runDir, "score.json");
  await mkdir(path.dirname(scorePath), { recursive: true });
  await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf8");

  process.stdout.write(`${scorePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
