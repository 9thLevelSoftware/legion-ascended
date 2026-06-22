#!/usr/bin/env node
// P13-T02 threat-model validator.
//
// Orchestrates the fail-closed checks that prove the eval pipeline
// honored the security-sensitive.v1 held-out contract and the Phase 0
// retention policy. The validator composes:
//
//   * sandbox-guard.mjs   (boundary + redaction completeness)
//   * retention-audit.mjs (retained vs discarded artifacts + hash drift)
//   * redact-output.mjs   (re-validate the redacted transcript in-place)
//
// All three subchecks must pass for the validator to emit ok=true. Any
// finding surfaces with a stable `code` so downstream CI gates and the
// docs/next/evidence/P13-T02/threat-model.json verdict can aggregate
// without re-implementing the policy.
//
// Usage:
//   node scripts/baseline/threat-model.mjs \
//     --run-dir docs/next/evidence/P13-T02/runs/v9/example \
//     --output-root docs/next/evidence/P13-T02/runs \
//     [--report <path>]

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

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

function ensureString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument --${name}.`);
  }
  return value;
}

// Invoke a sibling script under scripts/baseline/ as a subprocess. We use
// spawnSync rather than importing the modules so the verdict reflects
// each helper's own exit code (a process-level fail-closed gate). The
// helpers write JSON to stdout which we capture and surface verbatim.
function runHelper(scriptName, args) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Helper script not found: ${scriptPath}`);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json = null;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    json = null;
  }
  return {
    exit_code: result.status ?? 1,
    stdout,
    stderr,
    json
  };
}

function runRedactionAudit(runDir) {
  const redactedPath = path.join(runDir, "transcript.redacted.log");
  if (!existsSync(redactedPath)) {
    return {
      ok: false,
      findings: [
        {
          code: "redacted_transcript_missing",
          message: `transcript.redacted.log not found in ${runDir}`
        }
      ]
    };
  }
  const text = readFileSync(redactedPath, "utf8");
  const findings = [];
  // Defence-in-depth: even though capture-run.mjs runs redact-output.mjs
  // before writing the transcript, a downstream tampering attempt could
  // swap the file. We re-scan the file with the same canary + bearer +
  // credential patterns to confirm no secret leak survived.
  const canaryMatches = text.match(/LEGION_SECRET_CANARY_[A-Z0-9_]+/g);
  if (canaryMatches) {
    findings.push({
      code: "canary_present_after_redaction",
      message: `${canaryMatches.length} canary token(s) survived redaction`,
      count: canaryMatches.length
    });
  }
  const bearerMatches = text.match(/(?<!REDACTED_TOKEN\])\bBearer\s+[A-Za-z0-9._\-]{20,}/g);
  if (bearerMatches) {
    findings.push({
      code: "bearer_token_present_after_redaction",
      message: `${bearerMatches.length} unredacted bearer token(s) survived redaction`,
      count: bearerMatches.length
    });
  }
  const credentialAssignment = text.match(/(api[_-]?key|token|password|secret)(\s*[:=]\s*)['"]?(?!REDACTED)[^'"\s]+/gi);
  if (credentialAssignment) {
    findings.push({
      code: "credential_assignment_present_after_redaction",
      message: `${credentialAssignment.length} credential assignment(s) survived redaction`,
      count: credentialAssignment.length
    });
  }
  // Held-out contract: "redaction does not hide command failures". If the
  // transcript has zero non-empty lines after redaction, we treat that as
  // a signal that the redactor dropped the failure context. A failure
  // transcript from a non-passing host command should still contain the
  // exit_code / stderr lines.
  const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    findings.push({
      code: "redaction_dropped_all_context",
      message: `transcript.redacted.log is empty; redaction dropped the failure context`,
      count: 0
    });
  }
  return { ok: findings.length === 0, findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = ensureString(args["run-dir"], "run-dir");
  const outputRoot = ensureString(args["output-root"], "output-root");
  const reportPath = typeof args.report === "string" ? args.report : null;
  const repositoryRoot = typeof args["repository-root"] === "string"
    ? path.resolve(REPO_ROOT, args["repository-root"])
    : REPO_ROOT;
  const absRunDir = path.resolve(repositoryRoot, runDir);
  const absOutputRoot = path.resolve(repositoryRoot, outputRoot);

  const helperArgs = [
    "--run-dir",
    absRunDir,
    "--output-root",
    absOutputRoot,
    "--repository-root",
    repositoryRoot
  ];
  const sandbox = runHelper("sandbox-guard.mjs", helperArgs);
  const retention = runHelper("retention-audit.mjs", helperArgs);
  const redaction = runRedactionAudit(absRunDir);

  const findings = [
    ...(sandbox.json?.findings ?? []).map((f) => ({ source: "sandbox", ...f })),
    ...(retention.json?.findings ?? []).map((f) => ({ source: "retention", ...f })),
    ...redaction.findings.map((f) => ({ source: "redaction", ...f }))
  ];

  const ok =
    (sandbox.json?.ok === true) &&
    (retention.json?.ok === true) &&
    redaction.ok;

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_dir: path.relative(repositoryRoot, absRunDir),
    output_root: path.relative(repositoryRoot, absOutputRoot),
    ok,
    checks: {
      sandbox: {
        ok: sandbox.json?.ok === true,
        exit_code: sandbox.exit_code
      },
      retention: {
        ok: retention.json?.ok === true,
        exit_code: retention.exit_code
      },
      redaction: {
        ok: redaction.ok
      }
    },
    findings
  };

  if (reportPath) {
    const out = path.resolve(REPO_ROOT, reportPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}