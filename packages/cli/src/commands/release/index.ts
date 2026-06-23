/**
 * P13-T03 — `legion dev release` CLI adapter.
 *
 * Routes the fail-closed GA gates through the operator-facing CLI:
 *
 *   checklist          Run the GA release checklist against the current
 *                      repository. The verifier confirms CHANGELOG,
 *                      every companion document under docs/next/ga/,
 *                      the Phase 13 ledger state, the P13-T02 threat
 *                      model verdict, the P13-T01 A/B comparison, and
 *                      the validate-next log. Non-zero exit when any
 *                      precondition is missing.
 *
 *   rollback-verify    Run the backup-manifest verifier against a path
 *                      supplied by `legion dev migrate --apply`. The
 *                      verifier re-hashes the backup directory and
 *                      fails closed on schema drift, hash mismatch, or
 *                      missing backup directory. Non-zero exit when the
 *                      manifest is not restorable.
 *
 * Both subcommands emit JSON verdicts regardless of exit code so CI
 * gates can surface structured findings without parsing free-form
 * text.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { resolveCliSourceRoot } from "../../source-root.js";
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

const RELEASE_HELP = `legion dev release <command>

Commands:
  checklist          Run the fail-closed GA release checklist verifier.
  rollback-verify    Run the backup-manifest verifier against a single
                     backup-manifest.json produced by \`legion dev migrate --apply\`.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.

Checklist required options:
  --release-version <semver>   Release version (e.g. 9.0.0). Must match the
                               \`## [<version>]\` heading in CHANGELOG.md.

Checklist optional:
  --validate-next-log <path>   Path to a validate-next log that contains the
                               \`validate-next PASS\` marker. The checklist
                               fails closed when the log is missing or does
                               not contain the marker.
  --report <path>              Where to write the JSON verdict (in addition to stdout).

Rollback-verify required options:
  --backup-manifest <path>     Path to the backup-manifest.json produced by
                               \`legion dev migrate --apply\`.

Rollback-verify optional:
  --source codex-legion|planning   Confirms the manifest kind matches the
                                   source the operator used during apply.
  --report <path>                  Where to write the JSON verdict.`;

// The release scripts live beside the packaged CLI root, not under the
// operator's --repository-root.
const V9_SOURCE_ROOT = resolveCliSourceRoot(import.meta.url, "scripts/release/release-checklist.mjs");

export async function handleReleaseCommand(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help") || context.args.positionals.length === 0) {
    return helpResult(RELEASE_HELP);
  }
  const [command] = context.args.positionals;
  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "checklist":
      return checklist(commandContext);
    case "rollback-verify":
      return rollbackVerify(commandContext);
    default:
      return helpResult(RELEASE_HELP);
  }
}

async function checklist(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(RELEASE_HELP);
  const releaseVersion = requiredStringOption(context, "release-version");
  if (typeof releaseVersion !== "string") return releaseVersion;

  const args = ["scripts/release/release-checklist.mjs", "--release-version", releaseVersion];
  args.push("--repository-root", context.repositoryRoot);
  const validateNextLog = context.args.options.get("validate-next-log");
  if (typeof validateNextLog === "string") {
    args.push("--validate-next-log", path.resolve(context.repositoryRoot, validateNextLog));
  }
  const report = context.args.options.get("report");
  if (typeof report === "string") args.push("--report", path.resolve(context.repositoryRoot, report));

  const result = await runScript(context, args);
  // Parse the JSON verdict regardless of helper exit code so CI gates
  // surface structured findings.
  const verdict = parseJsonVerdict(result.stdout);
  if (verdict && typeof verdict === "object") {
    const verdictOk = (verdict as { ok?: boolean }).ok === true;
    const payload = {
      ok: verdictOk,
      status: verdictOk ? "ready" : "blocked",
      verdict
    };
    const message = verdictOk
      ? `Release checklist ready for ${releaseVersion}.`
      : `Release checklist blocked for ${releaseVersion} — see findings.`;
    return verdictOk ? success(payload, message) : failure(payload, message);
  }
  if (result.exitCode !== 0) return result.cliResult;
  return failure(
    {
      ok: false,
      status: "error",
      diagnostics: [{ code: "release_checklist_verdict_missing", message: "release-checklist.mjs did not emit a JSON verdict" }]
    },
    "release-checklist.mjs did not emit a JSON verdict"
  );
}

async function rollbackVerify(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(RELEASE_HELP);
  const backupManifest = requiredStringOption(context, "backup-manifest");
  if (typeof backupManifest !== "string") return backupManifest;

  const resolvedManifest = path.resolve(context.repositoryRoot, backupManifest);
  const args = ["scripts/release/rollback-policy.mjs", "--backup-manifest", resolvedManifest];
  args.push("--repository-root", context.repositoryRoot);
  const source = context.args.options.get("source");
  if (typeof source === "string") args.push("--source", source);
  const report = context.args.options.get("report");
  if (typeof report === "string") args.push("--report", path.resolve(context.repositoryRoot, report));

  const result = await runScript(context, args);
  const verdict = parseJsonVerdict(result.stdout);
  if (verdict && typeof verdict === "object") {
    const verdictOk = (verdict as { ok?: boolean }).ok === true;
    const payload = {
      ok: verdictOk,
      status: verdictOk ? "restorable" : "blocked",
      verdict
    };
    const message = verdictOk
      ? `Backup manifest ${backupManifest} is restorable.`
      : `Backup manifest ${backupManifest} is blocked — see findings.`;
    return verdictOk ? success(payload, message) : failure(payload, message);
  }
  if (result.exitCode !== 0) return result.cliResult;
  return failure(
    {
      ok: false,
      status: "error",
      diagnostics: [{ code: "rollback_policy_verdict_missing", message: "rollback-policy.mjs did not emit a JSON verdict" }]
    },
    "rollback-policy.mjs did not emit a JSON verdict"
  );
}

function parseJsonVerdict(stdout: string): unknown {
  // The release-checklist and rollback-policy helpers emit pretty JSON.
  // Prefer the whole document, then tolerate diagnostic lines before or
  // after the object.
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

async function runScript(
  context: CliContext,
  scriptArgs: readonly string[]
): Promise<{ exitCode: number; stdout: string; stderr: string; cliResult: CliResult }> {
  const resolvedArgs = scriptArgs.map((arg) =>
    typeof arg === "string" &&
    (arg === "scripts/release/release-checklist.mjs" || arg === "scripts/release/rollback-policy.mjs")
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
              code: "release_helper_failed",
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
