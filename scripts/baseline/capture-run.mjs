#!/usr/bin/env node
// P13-T01 capture runner for release-grade behavioral evals.
//
// Mirrors scripts/baseline/capture-run.ps1 but is platform-neutral (no pwsh).
// Captures the public fixture into a sealed run directory, computes lowercase
// SHA-256 digests over LF-normalized UTF-8 text with POSIX-relative paths,
// copies redacted transcript, and writes a run-manifest.json that validates
// against evals/baseline/schema/run-manifest.schema.json.
//
// Usage:
//   node scripts/baseline/capture-run.mjs \
//     --scenario bug-fix.v1 \
//     --host codex-cli \
//     --repeat 1 \
//     --model unavailable \
//     --output docs/next/evidence/P13-T01/runs \
//     [--dry-run | --command "codex --no-color exec '...'"]
//
// Non-dry-run capture requires --command. The command is executed from the
// repository root via `node:child_process.execFile`, its stdout/stderr is
// captured into transcript.raw.log, and then run through redact-output.mjs
// to produce transcript.redacted.log. Raw output is deleted after redaction.

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { redactFile } from "./redact-output.mjs";

const execFile = promisify(execFileCb);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

const SCHEMA_PATH = path.join(REPO_ROOT, "evals", "baseline", "schema", "run-manifest.schema.json");
const CORPUS_PATH = path.join(REPO_ROOT, "evals", "baseline", "manifest.yaml");

function parseArgs(argv) {
  const out = { _: [], positional: new Set() };
  const positional = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(token);
      positional.add(token);
    }
  }
  out.positional = positional;
  return out;
}

function ensureString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument --${name}.`);
  }
  return value;
}

function ensureInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Argument --${name} must be an integer >= 1 (received ${value}).`);
  }
  return parsed;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "-");
}

async function loadCorpus() {
  // Lazy-load yaml to avoid a hard dependency at module top-level.
  const yamlMod = await import("yaml");
  const text = await readFile(CORPUS_PATH, "utf8");
  return yamlMod.parse(text);
}

async function loadRunManifestSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

function validateAgainstSchema(value, schema, label) {
  // Lightweight structural validation: confirm every required field exists
  // and `const` enums are respected. The capture script writes the manifest
  // itself, so we do not pull in a full JSON-Schema engine here — we only
  // guard against accidental field omissions and unintended renames.
  if (!schema || typeof schema !== "object") return;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`${label} missing required field: ${key}`);
    }
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in value)) continue;
      const inner = value[key];
      if (propSchema?.const !== undefined && inner !== propSchema.const) {
        throw new Error(`${label}.${key} must equal const ${JSON.stringify(propSchema.const)} (got ${JSON.stringify(inner)})`);
      }
      if (propSchema?.enum && Array.isArray(propSchema.enum) && !propSchema.enum.includes(inner)) {
        throw new Error(`${label}.${key} must be one of ${JSON.stringify(propSchema.enum)} (got ${JSON.stringify(inner)})`);
      }
    }
  }
  if (schema.$defs && typeof schema.$defs === "object") {
    for (const [defName, defSchema] of Object.entries(schema.$defs)) {
      if (!defSchema || typeof defSchema !== "object") continue;
      if (defSchema.required && defSchema.required.includes("status")) {
        // Recurse into telemetry blocks; we only check structural presence.
        const telemetry = value.telemetry;
        if (telemetry && typeof telemetry === "object") {
          for (const field of ["tokens", "cost"]) {
            const sub = telemetry[field];
            if (sub && typeof sub === "object" && !("status" in sub)) {
              throw new Error(`${label}.telemetry.${field} missing required status field (${defName})`);
            }
          }
        }
      }
    }
  }
}

async function hashFixtureFiles(publicFixtureRoot, repoRoot) {
  const out = [];
  async function visit(dir) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!item.isFile()) continue;
      const buffer = await readFile(full);
      const text = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const bytes = Buffer.from(text, "utf8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
      out.push({ hash: digest, path: rel, size: bytes.byteLength });
    }
  }
  await visit(publicFixtureRoot);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// Tokenize a POSIX-ish command string into an argv array, honoring single
// and double quotes (without interpolation) and backslash escapes outside
// quotes. Sufficient for the operator-supplied --command captured here.
function tokenizeShellCommand(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function fixtureHashLines(entries) {
  return entries.map((e) => `${e.hash}  ${e.path}`).join("\n");
}

function nowIso() {
  return new Date().toISOString();
}

function timestampStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function gitShortStatus(repoRoot) {
  try {
    const { stdout } = await execFile("git", ["status", "--short", "--branch"], { cwd: repoRoot, encoding: "utf8" });
    return stdout.replace(/\s+$/, "");
  } catch (error) {
    // Non-git repository (common in CLI e2e workspaces). Record an explicit
    // sentinel so downstream graders can detect the absence rather than treat
    // the absence as an artifact_traceability defect.
    return "(not a git repository)";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = ensureString(args.scenario, "scenario");
  const hostName = ensureString(args.host ?? args["host-name"], "host");
  const repeat = ensureInt(args.repeat, "repeat");
  const output = ensureString(args.output, "output");
  const model = typeof args.model === "string" ? args.model : "unavailable";
  const adapter = typeof args.adapter === "string" ? args.adapter : "v9-cli-surface";
  const baselineCommit = typeof args["baseline-commit"] === "string"
    ? args["baseline-commit"]
    : "855e975beec3bac6dc06db598081b6ac11ea8e14";
  const fixtureRoot = typeof args["fixture-root"] === "string"
    ? args["fixture-root"]
    : "evals/fixtures/public";
  const legionSource = typeof args["legion-source"] === "string"
    ? args["legion-source"]
    : REPO_ROOT;
  const corpusRoot = typeof args["corpus-root"] === "string"
    ? args["corpus-root"]
    : REPO_ROOT;
  const dryRun = args["dry-run"] === true;
  const commandLine = typeof args.command === "string" ? args.command : "";
  const repositoryRoot = typeof args["repository-root"] === "string" ? args["repository-root"] : REPO_ROOT;

  if (!dryRun && commandLine.length === 0) {
    throw new Error("Non-dry-run capture requires --command with the approved host invocation.");
  }

  const corpus = await loadCorpus();
  const corpusManifestPath = path.join(corpusRoot, "evals/baseline/manifest.yaml");
  // Re-parse the corpus from the corpus-root (CLI --corpus-root) so the
  // scenario lookup honors a corpus that lives outside the operator's
  // --repository-root.
  const yaml = await import("yaml");
  const corpusText = await readFile(corpusManifestPath, "utf8");
  const corpusLocal = yaml.parse(corpusText);
  const scenarios = Array.isArray(corpusLocal.scenarios) ? corpusLocal.scenarios : [];
  const calibrationNoop = corpusLocal.calibration?.noop_fixture;
  let matched = scenarios.find((entry) => entry.id === scenario);
  if (!matched && calibrationNoop && scenario.startsWith("noop")) {
    matched = {
      id: scenario,
      family: "noop-calibration",
      risk_tier: "R0",
      manifest: `evals/baseline/scenarios/${scenario}.json`,
      public_input: calibrationNoop,
      evaluator_material: calibrationNoop.replace("public", "evaluator").replace(/\/task\.md$/, "/assertions.yaml")
    };
  }
  if (!matched) {
    throw new Error(`Scenario ${scenario} not found in ${corpusManifestPath}.`);
  }
  const scenarioName = scenario.replace(/\.v\d+$/, "");
  const publicFixtureAbs = path.join(corpusRoot, fixtureRoot, scenarioName);
  if (!existsSync(publicFixtureAbs)) {
    throw new Error(`Public fixture not found: ${publicFixtureAbs}`);
  }

  const runId = `p13-${safeName(scenario)}-${safeName(hostName)}-r${repeat}-${timestampStamp()}`;
  const runDir = path.isAbsolute(output)
    ? path.join(output, runId)
    : path.join(repositoryRoot, output, runId);
  await mkdir(runDir, { recursive: true });

  const workspace = path.join(runDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const copiedFixture = path.join(workspace, "public-fixture");
  await cp(publicFixtureAbs, copiedFixture, { recursive: true });

  const fixtureEntries = await hashFixtureFiles(copiedFixture, repositoryRoot);
  const fixtureHashFile = path.join(runDir, "fixture-hashes.sha256");
  await writeFile(fixtureHashFile, `${fixtureHashLines(fixtureEntries)}\n`, "utf8");

  const gitBefore = path.join(runDir, "git-before.txt");
  const gitAfter = path.join(runDir, "git-after.txt");
  await writeFile(gitBefore, `${await gitShortStatus(repositoryRoot)}\n`, "utf8");

  const startedAt = nowIso();
  const events = [];
  events.push({ type: "run_started", at: startedAt, scenario, host: hostName, dry_run: dryRun });

  const rawTranscript = path.join(runDir, "transcript.raw.log");
  const redactedTranscript = path.join(runDir, "transcript.redacted.log");
  let terminalStatus = "dry-run";

  if (dryRun) {
    await writeFile(
      rawTranscript,
      [
        `P13-T01 dry-run calibration`,
        `Scenario: ${scenario}`,
        `Host: ${hostName}`,
        `Model: ${model}`,
        `LEGION_SECRET_CANARY_SHOULD_BE_REDACTED`,
        ""
      ].join("\n"),
      "utf8"
    );
    events.push({ type: "dry_run_completed", at: nowIso() });
  } else {
    events.push({ type: "host_command_started", at: nowIso(), host: hostName });
    // Tokenize the operator-supplied --command into argv tokens so we can
    // invoke the host CLI through execFile (no shell interpolation). The
    // operator controls --command end-to-end, but using execFile keeps
    // shell metacharacters in arguments from being interpreted.
    const argv = tokenizeShellCommand(commandLine);
    if (argv.length === 0) {
      throw new Error("--command could not be tokenized into an argv array.");
    }
    const [program, ...argsList] = argv;
    try {
      const result = await execFile(program, argsList, {
        cwd: legionSource,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        shell: false
      });
      const merged = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`;
      await writeFile(rawTranscript, merged, "utf8");
      events.push({ type: "host_command_completed", at: nowIso(), exit_code: 0 });
      terminalStatus = "passed";
    } catch (error) {
      const stdout = error?.stdout ?? "";
      const stderr = error?.stderr ?? "";
      await writeFile(rawTranscript, `${stdout}${stderr ? `\n${stderr}` : ""}`, "utf8");
      const exitCode = typeof error?.code === "number" ? error.code : 1;
      events.push({ type: "host_command_completed", at: nowIso(), exit_code: exitCode });
      terminalStatus = exitCode === 0 ? "passed" : "failed";
    }
  }

  await redactFile(rawTranscript, redactedTranscript);
  await rm(rawTranscript, { force: true });

  const endedAt = nowIso();
  events.push({ type: "run_completed", at: endedAt, terminal_status: terminalStatus });
  await writeFile(gitAfter, `${await gitShortStatus(repositoryRoot)}\n`, "utf8");

  const manifest = {
    schema_version: 1,
    run_id: runId,
    scenario_id: scenario,
    host: hostName,
    model,
    adapter,
    repeat,
    baseline_commit: baselineCommit,
    fixture_hashes: "fixture-hashes.sha256",
    timestamps: { started_at: startedAt, ended_at: endedAt },
    telemetry: {
      tokens: { status: "unavailable", value: null, reason: "host did not expose telemetry" },
      cost: { status: "unavailable", value: null, reason: "host did not expose telemetry" }
    },
    interventions: [],
    events,
    terminal_status: terminalStatus,
    artifacts: {
      transcript: "transcript.redacted.log",
      git_before: "git-before.txt",
      git_after: "git-after.txt",
      score: "score.json"
    }
  };

  const schema = await loadRunManifestSchema();
  validateAgainstSchema(manifest, schema, "run-manifest");

  const manifestPath = path.join(runDir, "run-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(`${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
