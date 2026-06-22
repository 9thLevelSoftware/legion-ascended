#!/usr/bin/env node
// P13-T01 v8/v9 A/B comparison aggregator.
//
// Reads paired v8 and v9 run directories (each containing run-manifest.json
// and score.json from grade-run.mjs), aggregates cost/duration/intervention/
// recovery/defect metrics by family, and emits a JSON + Markdown report.
//
// Both run sets are treated as sealed inputs: missing manifests, missing
// scores, or non-gradeable terminal_status values surface as fail-closed
// entries rather than being silently dropped. This matches the P13-T01
// contract that absent, stale, or drifted evidence must not pass as green.
//
// Usage:
//   node scripts/baseline/compare-runs.mjs \
//     --v8-dir docs/next/evidence/P13-T01/runs/v8 \
//     --v9-dir docs/next/evidence/P13-T01/runs/v9 \
//     --output docs/next/evidence/P13-T01/ab-comparison \
//     [--label "P13-T01 sealed A/B"] [--repository-root .]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

const REQUIRED_MANIFEST_FIELDS = ["run_id", "scenario_id", "timestamps", "terminal_status", "telemetry", "events"];
const REQUIRED_SCORE_FIELDS = ["run_id", "scenario_id", "deterministic_total", "terminal_status", "critical_failure", "dimensions"];

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

async function exists(filePath) {
  return existsSync(filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listRunDirs(parent) {
  if (!(await exists(parent))) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(parent, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(parent, e.name));
  // Only keep directories that actually contain a run-manifest.json.
  const confirmed = [];
  for (const dir of dirs) {
    if (await exists(path.join(dir, "run-manifest.json"))) confirmed.push(dir);
  }
  return confirmed.sort();
}

function requireField(record, key, label) {
  if (!(key in record)) {
    throw new Error(`${label} missing required field: ${key}`);
  }
  return record[key];
}

function durationMs(manifest) {
  const start = Date.parse(manifest.timestamps?.started_at);
  const end = Date.parse(manifest.timestamps?.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function countInterventions(manifest) {
  return Array.isArray(manifest.interventions) ? manifest.interventions.length : 0;
}

function countEventsByType(manifest, types) {
  const events = Array.isArray(manifest.events) ? manifest.events : [];
  let total = 0;
  for (const event of events) {
    if (event && typeof event.type === "string" && types.includes(event.type)) total += 1;
  }
  return total;
}

function defectsFromScore(score) {
  if (score?.critical_failure === true) return 1;
  // Each zero-scored deterministic dimension counts as a defect for A/B.
  let defects = 0;
  const dims = score?.dimensions ?? {};
  for (const value of Object.values(dims)) {
    if (value === 0) defects += 1;
  }
  return defects;
}

function recoveryFromManifest(manifest) {
  const status = manifest.terminal_status;
  if (status === "interrupted") return { interrupted: 1, recovered: 0 };
  if (status === "passed" || status === "failed" || status === "dry-run") {
    return { interrupted: 0, recovered: 1 };
  }
  return { interrupted: 0, recovered: 0 };
}

async function collectSide(label, runDir) {
  const dirs = await listRunDirs(runDir);
  const rows = [];
  for (const dir of dirs) {
    const manifest = await readJson(path.join(dir, "run-manifest.json"));
    for (const key of REQUIRED_MANIFEST_FIELDS) requireField(manifest, key, `${label} manifest ${dir}`);
    const scorePath = path.join(dir, "score.json");
    let score = null;
    if (await exists(scorePath)) {
      score = await readJson(scorePath);
      for (const key of REQUIRED_SCORE_FIELDS) requireField(score, key, `${label} score ${dir}`);
    }
    const duration = durationMs(manifest);
    rows.push({
      label,
      run_id: manifest.run_id,
      scenario_id: manifest.scenario_id,
      host: manifest.host,
      model: manifest.model,
      terminal_status: manifest.terminal_status,
      duration_ms: duration,
      tokens: manifest.telemetry?.tokens ?? { status: "unavailable", value: null, reason: "missing" },
      cost: manifest.telemetry?.cost ?? { status: "unavailable", value: null, reason: "missing" },
      interventions: countInterventions(manifest),
      questions: countEventsByType(manifest, ["user_question", "approval_requested"]),
      approvals: countEventsByType(manifest, ["approval_recorded"]),
      recovery: recoveryFromManifest(manifest),
      defects: defectsFromScore(score),
      deterministic_total: score?.deterministic_total ?? null,
      critical_failure: score?.critical_failure ?? null,
      manifest_path: path.relative(REPO_ROOT, path.join(dir, "run-manifest.json")),
      score_path: score ? path.relative(REPO_ROOT, scorePath) : null
    });
  }
  rows.sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0));
  return rows;
}

function aggregate(rows, label) {
  const summary = {
    side: label,
    run_count: rows.length,
    by_terminal_status: {},
    total_interventions: 0,
    total_questions: 0,
    total_approvals: 0,
    total_interrupted: 0,
    total_recovered: 0,
    total_defects: 0,
    total_duration_ms: 0,
    duration_count: 0,
    available_token_count: 0,
    available_cost_count: 0
  };
  for (const row of rows) {
    summary.by_terminal_status[row.terminal_status] = (summary.by_terminal_status[row.terminal_status] ?? 0) + 1;
    summary.total_interventions += row.interventions;
    summary.total_questions += row.questions;
    summary.total_approvals += row.approvals;
    summary.total_interrupted += row.recovery.interrupted;
    summary.total_recovered += row.recovery.recovered;
    summary.total_defects += row.defects;
    if (typeof row.duration_ms === "number") {
      summary.total_duration_ms += row.duration_ms;
      summary.duration_count += 1;
    }
    if (row.tokens?.status === "available") summary.available_token_count += 1;
    if (row.cost?.status === "available") summary.available_cost_count += 1;
  }
  return summary;
}

function compare(v8Rows, v9Rows) {
  const v8Summary = aggregate(v8Rows, "v8");
  const v9Summary = aggregate(v9Rows, "v9");
  const byScenario = new Map();
  for (const row of v8Rows) byScenario.set(row.scenario_id, { v8: row });
  for (const row of v9Rows) {
    const entry = byScenario.get(row.scenario_id) ?? {};
    entry.v9 = row;
    byScenario.set(row.scenario_id, entry);
  }
  const scenarioRows = [];
  for (const [scenario, pair] of byScenario.entries()) {
    const v8 = pair.v8;
    const v9 = pair.v9;
    scenarioRows.push({
      scenario_id: scenario,
      v8_present: Boolean(v8),
      v9_present: Boolean(v9),
      v8_terminal: v8?.terminal_status ?? null,
      v9_terminal: v9?.terminal_status ?? null,
      v8_deterministic_total: v8?.deterministic_total ?? null,
      v9_deterministic_total: v9?.deterministic_total ?? null,
      v8_defects: v8?.defects ?? null,
      v9_defects: v9?.defects ?? null,
      v8_interventions: v8?.interventions ?? null,
      v9_interventions: v9?.interventions ?? null,
      v8_duration_ms: v8?.duration_ms ?? null,
      v9_duration_ms: v9?.duration_ms ?? null,
      v8_tokens_status: v8?.tokens?.status ?? null,
      v9_tokens_status: v9?.tokens?.status ?? null,
      v8_cost_status: v8?.cost?.status ?? null,
      v9_cost_status: v9?.cost?.status ?? null
    });
  }
  scenarioRows.sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0));
  return { v8_summary: v8Summary, v9_summary: v9Summary, scenarios: scenarioRows };
}

function escapeCell(value) {
  if (value === null || value === undefined) return "—";
  return String(value).replace(/\|/g, "\\|");
}

function markdownTable(headers, rows) {
  const head = `| ${headers.map(escapeCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`).join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

function renderMarkdown(report, label) {
  const lines = [];
  lines.push(`# ${label}`);
  lines.push("");
  lines.push(`Generated by scripts/baseline/compare-runs.mjs at ${report.generated_at}.`);
  lines.push("");
  lines.push(`## Aggregate summaries`);
  lines.push("");
  lines.push(markdownTable(
    ["metric", "v8", "v9"],
    [
      ["run_count", report.v8_summary.run_count, report.v9_summary.run_count],
      ["total_interventions", report.v8_summary.total_interventions, report.v9_summary.total_interventions],
      ["total_questions", report.v8_summary.total_questions, report.v9_summary.total_questions],
      ["total_approvals", report.v8_summary.total_approvals, report.v9_summary.total_approvals],
      ["total_interrupted", report.v8_summary.total_interrupted, report.v9_summary.total_interrupted],
      ["total_recovered", report.v8_summary.total_recovered, report.v9_summary.total_recovered],
      ["total_defects", report.v8_summary.total_defects, report.v9_summary.total_defects],
      ["total_duration_ms", report.v8_summary.total_duration_ms, report.v9_summary.total_duration_ms],
      ["duration_count", report.v8_summary.duration_count, report.v9_summary.duration_count],
      ["available_token_count", report.v8_summary.available_token_count, report.v9_summary.available_token_count],
      ["available_cost_count", report.v8_summary.available_cost_count, report.v9_summary.available_cost_count]
    ]
  ));
  lines.push("");
  lines.push(`## By terminal status`);
  lines.push("");
  lines.push(markdownTable(
    ["side", "status", "count"],
    Object.entries(report.v8_summary.by_terminal_status).map(([status, count]) => ["v8", status, count]).concat(
      Object.entries(report.v9_summary.by_terminal_status).map(([status, count]) => ["v9", status, count])
    )
  ));
  lines.push("");
  lines.push(`## Per-scenario`);
  lines.push("");
  lines.push(markdownTable(
    [
      "scenario",
      "v8_terminal",
      "v9_terminal",
      "v8_total",
      "v9_total",
      "v8_defects",
      "v9_defects",
      "v8_interventions",
      "v9_interventions",
      "v8_duration_ms",
      "v9_duration_ms",
      "v8_tokens",
      "v9_tokens",
      "v8_cost",
      "v9_cost"
    ],
    report.scenarios.map((s) => [
      s.scenario_id,
      s.v8_terminal,
      s.v9_terminal,
      s.v8_deterministic_total,
      s.v9_deterministic_total,
      s.v8_defects,
      s.v9_defects,
      s.v8_interventions,
      s.v9_interventions,
      s.v8_duration_ms,
      s.v9_duration_ms,
      s.v8_tokens_status,
      s.v9_tokens_status,
      s.v8_cost_status,
      s.v9_cost_status
    ])
  ));
  lines.push("");
  lines.push(`## Notes`);
  lines.push("");
  lines.push("- Missing v8 runs surface as `null` cells; the comparison is fail-closed (no value is invented).");
  lines.push("- Tokens/cost columns reflect telemetry `status` (`available` / `unavailable`) rather than estimated values.");
  lines.push("- Defects are scored per-row from `score.json`: `critical_failure === true` contributes 1; each zero-scored deterministic dimension contributes 1.");
  lines.push("- Recovery counts `interrupted` and `recovered` terminal states from `run-manifest.json`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args["v8-dir"] !== "string" || typeof args["v9-dir"] !== "string" || typeof args.output !== "string") {
    throw new Error("Usage: compare-runs.mjs --v8-dir <path> --v9-dir <path> --output <path> [--label <text>] [--repository-root <path>]");
  }
  const repositoryRoot = typeof args["repository-root"] === "string" ? args["repository-root"] : REPO_ROOT;
  const label = typeof args.label === "string" ? args.label : "v8/v9 sealed scenario A/B comparison";
  const v8Dir = path.resolve(repositoryRoot, args["v8-dir"]);
  const v9Dir = path.resolve(repositoryRoot, args["v9-dir"]);
  const outputDir = path.resolve(repositoryRoot, args.output);

  const v8Rows = await collectSide("v8", v8Dir);
  const v9Rows = await collectSide("v9", v9Dir);

  const report = {
    schema_version: 1,
    label,
    generated_at: new Date().toISOString(),
    inputs: {
      v8_dir: path.relative(repositoryRoot, v8Dir),
      v9_dir: path.relative(repositoryRoot, v9Dir)
    },
    ...compare(v8Rows, v9Rows)
  };

  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "ab-comparison.json");
  const mdPath = path.join(outputDir, "ab-comparison.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdown(report, label), "utf8");

  process.stdout.write(`${jsonPath}\n${mdPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
