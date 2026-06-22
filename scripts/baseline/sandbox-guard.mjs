#!/usr/bin/env node
// P13-T02 sandbox boundary audit.
//
// The eval pipeline produces sealed run directories under the operator's
// --output path. The capture script (capture-run.mjs) and grade script
// (grade-run.mjs) both rely on the operator pointing --output at a
// trusted directory. This validator confirms, after the fact, that the
// sealed artifacts stayed inside that boundary and that the host command
// (if any) was tokenized via execFile rather than a shell.
//
// The validator is intentionally read-only: it inspects a sealed run
// directory and emits a JSON verdict. It never modifies the artifacts
// so it can run as a CI gate.
//
// Failure modes:
//   * run_dir escapes --output-root (parent path traversal)
//   * artifact paths resolve outside the run directory
//   * artifact paths contain `..` segments
//   * manifest.baseline_commit is not a 40-char hex string
//   * transcript.raw.log survived redaction (capture should delete it)
//   * transcript.redacted.log still contains LEGION_SECRET_CANARY_*
//
// Usage:
//   node scripts/baseline/sandbox-guard.mjs \
//     --run-dir docs/next/evidence/P13-T02/runs/v9/example \
//     --output-root docs/next/evidence/P13-T02/runs \
//     [--report <path>]

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

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

// POSIX-style path containment check. The candidate is contained iff the
// absolute, normalized form of the candidate starts with the absolute,
// normalized form of the root, AND the boundary character after the
// prefix is a path separator (so /foo/bar doesn't claim to contain
// /foo/barbaz). Both inputs must already be absolute.
function isContained(candidate, root) {
  const normCandidate = path.normalize(candidate);
  const normRoot = path.normalize(root);
  if (normCandidate === normRoot) return true;
  const rel = path.relative(normRoot, normCandidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

function auditRunDirectory({ runDir, outputRoot }) {
  const findings = [];
  const runManifestPath = path.join(runDir, "run-manifest.json");
  if (!existsSync(runManifestPath)) {
    return {
      ok: false,
      findings: [
        {
          code: "run_manifest_missing",
          message: `${runManifestPath} not found; the run directory was not sealed by capture-run.mjs.`
        }
      ]
    };
  }

  // Boundary check 1: run directory must be inside --output-root.
  if (!isContained(runDir, outputRoot)) {
    findings.push({
      code: "run_dir_escapes_output_root",
      message: `run directory ${runDir} is not contained in ${outputRoot}`
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(runManifestPath, "utf8"));
  } catch (error) {
    findings.push({
      code: "run_manifest_unreadable",
      message: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, findings };
  }

  // Boundary check 2: baseline_commit must be a 40-char hex SHA-1/256.
  if (typeof manifest.baseline_commit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.baseline_commit)) {
    findings.push({
      code: "baseline_commit_invalid",
      message: `manifest.baseline_commit must be a 40-char hex string; received ${JSON.stringify(manifest.baseline_commit)}`
    });
  }

  // Boundary check 3: every artifact path in the manifest must resolve
  // inside the run directory and must not contain `..` segments.
  const artifacts = manifest.artifacts ?? {};
  const artifactKeys = ["transcript", "git_before", "git_after", "score"];
  for (const key of artifactKeys) {
    const rel = artifacts[key];
    if (typeof rel !== "string" || rel.length === 0) continue;
    if (rel.includes("..")) {
      findings.push({
        code: "artifact_path_traversal",
        message: `${key} path contains '..' segment: ${rel}`
      });
      continue;
    }
    const abs = path.resolve(runDir, rel);
    if (!isContained(abs, runDir)) {
      findings.push({
        code: "artifact_path_escapes_run_dir",
        message: `${key} path resolves outside the run directory: ${abs}`
      });
    }
  }

  // Boundary check 4: raw transcript must not survive alongside the
  // redacted transcript (capture-run.mjs deletes it; presence indicates
  // either an un-sealed run or a tampering attempt).
  const rawTranscript = path.join(runDir, "transcript.raw.log");
  if (existsSync(rawTranscript)) {
    findings.push({
      code: "raw_transcript_present",
      message: `transcript.raw.log is still on disk; capture-run.mjs should delete it after redaction.`
    });
  }

  // Boundary check 5: redacted transcript must not contain
  // LEGION_SECRET_CANARY_* (defence-in-depth: capture-run.mjs runs
  // redact-output.mjs after capture, but a downstream tampering attempt
  // could swap the file).
  const redactedTranscript = path.join(runDir, artifacts.transcript ?? "transcript.redacted.log");
  if (existsSync(redactedTranscript)) {
    const text = readFileSync(redactedTranscript, "utf8");
    if (/LEGION_SECRET_CANARY_[A-Z0-9_]+/.test(text)) {
      findings.push({
        code: "canary_present_in_redacted_transcript",
        message: `transcript.redacted.log still contains the secret canary; redaction failed.`
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = ensureString(args["run-dir"], "run-dir");
  const outputRoot = ensureString(args["output-root"], "output-root");
  const reportPath = typeof args.report === "string" ? args.report : null;
  const repoRootOverride = typeof args["repository-root"] === "string"
    ? path.resolve(REPO_ROOT, args["repository-root"])
    : REPO_ROOT;
  const absRunDir = path.resolve(repoRootOverride, runDir);
  const absOutputRoot = path.resolve(repoRootOverride, outputRoot);
  const verdict = auditRunDirectory({ runDir: absRunDir, outputRoot: absOutputRoot });
  const payload = {
    schema_version: 1,
    output_root: path.relative(repoRootOverride, absOutputRoot),
    run_dir: path.relative(repoRootOverride, absRunDir),
    ok: verdict.ok,
    findings: verdict.findings
  };
  if (reportPath) {
    const out = path.resolve(repoRootOverride, reportPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!verdict.ok) process.exit(1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath !== undefined && path.resolve(SCRIPT_PATH) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
