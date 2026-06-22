/**
 * P13-T01 — `legion dev evals` CLI adapter.
 *
 * Release-grade behavioral evals with v8/v9 A/B comparison on sealed
 * scenarios. Routes through the Node-based capture/grade/compare scripts
 * under `scripts/baseline/` (the .ps1 scaffolding from Phase 0 is replaced
 * with Node so macOS hosts can run the pipeline without PowerShell).
 *
 * Subcommands:
 *   capture        Seal a public fixture, copy fixture, write fixture hashes,
 *                  execute the operator-supplied host command (or run a
 *                  dry-run calibration), redact the transcript, and write a
 *                  run-manifest that validates against evals/baseline/schema/
 *                  run-manifest.
 *   grade          Score a sealed run directory against the seven
 *                  deterministic rubric dimensions and write score.json that
 *                  validates against evals/baseline/schema/score.schema.json.
 *                  Held-out evaluator assertions and judged dimensions remain
 *                  out of scope here.
 *   compare        Aggregate v8 and v9 sealed run directories into an A/B
 *                  report (JSON + Markdown) with cost/duration/intervention/
 *                  recovery/defect metrics. Missing v8 evidence surfaces as
 *                  `null` cells rather than being silently invented.
 *   threat-model   Run the fail-closed security validator against a sealed
 *                  run directory. Composes sandbox-guard.mjs (boundary +
 *                  redaction completeness), retention-audit.mjs (retained vs
 *                  discarded artifacts + hash drift), and an in-process
 *                  redaction audit (canary / bearer / credential-assignment
 *                  leak detector). Exits 0 only when every subcheck passes;
 *                  emits a JSON verdict so CI gates can surface findings
 *                  without parsing the runner stdout.
 *
 * The CLI never invents host telemetry — tokens and cost are recorded as
 * `{ status: "unavailable", value: null, reason: "host did not expose ..." }`
 * unless the upstream manifest carries a populated value. This matches the
 * Phase 0 SCORING-RUBRIC.md rule that token/cost are never estimated from
 * transcript length.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  failure,
  hasFlag,
  helpResult,
  requiredStringOption,
  stripCommand,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const execFile = promisify(execFileCb);

const EVALS_HELP = `legion dev evals <command>

Commands:
  capture        Seal a scenario into a run directory and write run-manifest.json.
  grade          Compute deterministic dimension scores for a sealed run directory.
  compare        Aggregate v8 and v9 sealed run directories into an A/B report.
  threat-model   Run the fail-closed security validator against a sealed run directory.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.

Capture required options:
  --scenario <id>           Sealed scenario id (e.g. bug-fix.v1).
  --host <name>             Host name (e.g. codex-cli, claude-code).
  --repeat <int>            Repeat count (>= 1).
  --output <path>           Output directory (run id appended automatically).
  --dry-run                 Calibration run; does not invoke the host command.
  --command "<argv>"        Operator-approved host invocation (required unless
                            --dry-run). Tokenized via a small POSIX shell parser
                            before execFile, so shell metacharacters are not
                            interpreted.

Capture optional:
  --model <name>            Model identifier (defaults to "unavailable").
  --adapter <name>          Adapter identifier (defaults to "v9-cli-surface").
  --baseline-commit <sha>   Pinned v8 baseline commit (defaults to 855e975...).
  --corpus-root <path>      Root for evals/baseline/manifest.yaml and public
                            fixtures (defaults to the v9 source tree).
  --fixture-root <path>     Public fixtures root relative to corpus-root
                            (defaults to evals/fixtures/public).
  --legion-source <path>    Working dir for the host command (defaults to corpus-root).

Grade required options:
  --run-directory <path>    Directory holding run-manifest.json.

Compare required options:
  --v8-dir <path>           Directory containing sealed v8 run subdirectories.
  --v9-dir <path>           Directory containing sealed v9 run subdirectories.
  --output <path>           Directory for ab-comparison.json + ab-comparison.md.

Compare optional:
  --label <text>            Heading for the Markdown report.

Threat-model required options:
  --run-dir <path>          Sealed run directory produced by \`evals capture\`.
  --output-root <path>      Trusted root that contains the run directory
                            (used for the boundary check).

Threat-model optional:
  --report <path>           Where to write the JSON verdict (in addition to stdout).`;

// The v9 source root for the scripts/ and evals/ trees. Computed from the
// compiled CLI's location (dist/commands/evals/index.js -> ../../../..).
// The scripts live alongside this CLI's source, so we pin them at the
// v9 source root rather than at the operator's --repository-root, which
// may be an empty e2e workspace.
const V9_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

export async function handleEvalsCommand(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help") || context.args.positionals.length === 0) {
    return helpResult(EVALS_HELP);
  }
  const [command] = context.args.positionals;
  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "capture":
      return capture(commandContext);
    case "grade":
      return grade(commandContext);
    case "compare":
      return compare(commandContext);
    case "threat-model":
      return threatModel(commandContext);
    default:
      return helpResult(EVALS_HELP);
  }
}

async function capture(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(EVALS_HELP);
  const required = ["scenario", "host", "repeat", "output"];
  for (const key of required) {
    const value = requiredStringOption(context, key);
    if (typeof value !== "string") return value;
  }
  const dryRun = hasFlag(context, "dry-run");
  const commandOption = context.args.options.get("command");
  if (!dryRun && typeof commandOption !== "string") {
    return failure(
      { ok: false, status: "usage_error", diagnostics: [{ code: "usage_error", message: "--command is required unless --dry-run is set." }] },
      "--command is required unless --dry-run is set."
    );
  }
  const args = ["scripts/baseline/capture-run.mjs"];
  if (context.repositoryRoot) args.push("--repository-root", context.repositoryRoot);
  args.push(
    "--scenario", context.args.options.get("scenario") as string,
    "--host", context.args.options.get("host") as string,
    "--repeat", String(context.args.options.get("repeat")),
    "--output", context.args.options.get("output") as string,
    "--corpus-root", V9_SOURCE_ROOT
  );
  for (const key of ["model", "adapter", "baseline-commit", "fixture-root", "legion-source"]) {
    const value = context.args.options.get(key);
    if (typeof value === "string") args.push(`--${key}`, value);
  }
  if (dryRun) args.push("--dry-run");
  if (typeof commandOption === "string") args.push("--command", commandOption);

  const result = await runScript(context, args);
  if (result.exitCode !== 0) return result.cliResult;
  const runDir = (result.stdout.trim().split(/\s+/).pop() ?? "").trim();
  if (!runDir) {
    return failure(
      { ok: false, status: "error", diagnostics: [{ code: "capture_failed", message: "capture script did not return a run directory." }] },
      "capture script did not return a run directory."
    );
  }
  const resolvedRunDir = path.isAbsolute(runDir) ? runDir : path.join(context.repositoryRoot, runDir);
  if (!existsSync(resolvedRunDir)) {
    return failure(
      { ok: false, status: "error", diagnostics: [{ code: "capture_failed", message: `captured run directory not found: ${resolvedRunDir}` }] },
      `captured run directory not found: ${resolvedRunDir}`
    );
  }
  const manifestPath = path.join(resolvedRunDir, "run-manifest.json");
  const scorePath = path.join(resolvedRunDir, "score.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return success(
    {
      ok: true,
      status: "captured",
      runDirectory: path.relative(context.repositoryRoot, resolvedRunDir),
      runManifest: path.relative(context.repositoryRoot, manifestPath),
      score: existsSync(scorePath) ? path.relative(context.repositoryRoot, scorePath) : null,
      manifest
    },
    `Captured run to ${resolvedRunDir}.`
  );
}

async function grade(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(EVALS_HELP);
  const runDirectory = requiredStringOption(context, "run-directory");
  if (typeof runDirectory !== "string") return runDirectory;
  const resolvedRunDirectory = path.resolve(context.repositoryRoot, runDirectory);
  const result = await runScript(context, ["scripts/baseline/grade-run.mjs", "--run-directory", resolvedRunDirectory]);
  if (result.exitCode !== 0) return result.cliResult;
  const scorePath = result.stdout.trim().split(/\s+/).pop() ?? "";
  return success(
    {
      ok: true,
      status: "graded",
      score: scorePath ? path.relative(context.repositoryRoot, scorePath) : scorePath
    },
    `Graded ${runDirectory} -> ${scorePath}.`
  );
}

async function compare(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(EVALS_HELP);
  for (const key of ["v8-dir", "v9-dir", "output"]) {
    const value = requiredStringOption(context, key);
    if (typeof value !== "string") return value;
  }
  const args = [
    "scripts/baseline/compare-runs.mjs",
    "--repository-root", context.repositoryRoot,
    "--v8-dir", path.resolve(context.repositoryRoot, context.args.options.get("v8-dir") as string),
    "--v9-dir", path.resolve(context.repositoryRoot, context.args.options.get("v9-dir") as string),
    "--output", path.resolve(context.repositoryRoot, context.args.options.get("output") as string)
  ];
  const label = context.args.options.get("label");
  if (typeof label === "string") args.push("--label", label);

  const result = await runScript(context, args);
  if (result.exitCode !== 0) return result.cliResult;
  const [jsonPath, mdPath] = result.stdout.trim().split(/\s+/);
  return success(
    {
      ok: true,
      status: "compared",
      abComparisonJson: jsonPath ? path.relative(context.repositoryRoot, jsonPath) : jsonPath,
      abComparisonMarkdown: mdPath ? path.relative(context.repositoryRoot, mdPath) : mdPath
    },
    `Compared v8/v9 sealed runs -> ${jsonPath}.`
  );
}

async function threatModel(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(EVALS_HELP);
  const runDir = requiredStringOption(context, "run-dir");
  if (typeof runDir !== "string") return runDir;
  const outputRoot = requiredStringOption(context, "output-root");
  if (typeof outputRoot !== "string") return outputRoot;

  const args = [
    "scripts/baseline/threat-model.mjs",
    "--run-dir", path.resolve(context.repositoryRoot, runDir),
    "--output-root", path.resolve(context.repositoryRoot, outputRoot)
  ];
  if (context.repositoryRoot) args.push("--repository-root", context.repositoryRoot);
  const report = context.args.options.get("report");
  if (typeof report === "string") args.push("--report", path.resolve(context.repositoryRoot, report));

  const result = await runScript(context, args);
  // Parse the JSON verdict regardless of exit code so the CLI surface can
  // return structured findings (CI gates need the findings array, not a
  // generic helper_failed error).
  const verdict = parseJsonVerdict(result.stdout);
  if (verdict && typeof verdict === "object") {
    const verdictOk = (verdict as { ok?: boolean }).ok === true;
    const payload = {
      ok: verdictOk,
      status: verdictOk ? "verified" : "violation",
      verdict
    };
    const message = verdictOk
      ? `Threat-model validator passed for ${runDir}.`
      : `Threat-model validator failed for ${runDir} — see findings.`;
    return verdictOk ? success(payload, message) : failure(payload, message);
  }
  if (result.exitCode !== 0) return result.cliResult;
  return failure(
    {
      ok: false,
      status: "error",
      diagnostics: [{ code: "threat_model_verdict_missing", message: "threat-model.mjs did not emit a JSON verdict" }]
    },
    "threat-model.mjs did not emit a JSON verdict"
  );
}

function parseJsonVerdict(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (candidate === undefined) continue;
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep scanning older lines.
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function runScript(context: CliContext, scriptArgs: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string; cliResult: CliResult }> {
  // The helper scripts under scripts/baseline/ live in the v9 source tree.
  // When the operator points --repository-root at a different directory
  // (the common case in CLI e2e tests), we still need to invoke the
  // scripts from their canonical location so the relative paths the scripts
  // emit remain repo-relative.
  const resolvedArgs = scriptArgs.map((arg) =>
    typeof arg === "string" && (arg === "scripts/baseline/capture-run.mjs" || arg === "scripts/baseline/grade-run.mjs" || arg === "scripts/baseline/compare-runs.mjs" || arg === "scripts/baseline/threat-model.mjs")
      ? path.join(V9_SOURCE_ROOT, arg)
      : arg
  );
  try {
    const result = await execFile(process.execPath, resolvedArgs, {
      cwd: V9_SOURCE_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      shell: false,
      env: { ...process.env, NO_COLOR: "1" }
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      cliResult: success({}, "")
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    const exitCode = typeof err.code === "number" ? err.code : 1;
    const message = stderr.trim() || stdout.trim() || `helper exited ${exitCode}`;
    return {
      exitCode,
      stdout,
      stderr,
      cliResult: failure(
        {
          ok: false,
          status: "error",
          diagnostics: [
            {
              code: "evals_helper_failed",
              message,
              helperArgs: scriptArgs
            }
          ]
        },
        message
      )
    };
  }
}
