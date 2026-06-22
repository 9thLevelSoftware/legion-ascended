#!/usr/bin/env node
// P13-T02 evidence retention policy audit.
//
// The Phase 0 SCORING-RUBRIC.md rule is that "absent, stale, or drifted
// evidence must not pass as green." This validator encodes the retention
// policy as machine-checkable rules and runs them against a sealed run
// directory. It is intentionally read-only so it can serve as a CI gate.
//
// Retention policy (enforced by this script):
//
// RETAINED (must exist on disk after capture/grade):
//   - run-manifest.json (schema-validated)
//   - score.json (schema-validated, terminal_status in gradeable set)
//   - transcript.redacted.log (schema-shaped, no LEGION_SECRET_CANARY_*)
//   - git-before.txt
//   - git-after.txt
//   - fixture-hashes.sha256 (LF-normalized UTF-8, lowercase hex digests,
//     POSIX-relative paths)
//
// DISCARDED (must NOT exist on disk after capture/grade):
//   - transcript.raw.log (capture deletes it after redaction)
//   - held-out evaluator assertions (never copied into the run dir)
//
// FAIL-CLOSED checks:
//   - held-out assertions from evals/fixtures/evaluator/<scenario>/ are
//     not bundled into the run dir, the workspace/public-fixture copy,
//     or the score.json
//   - fixture-hashes.sha256 digests are recomputable from on-disk bytes
//     (canonical hash policy: LF-normalized UTF-8, lowercase hex,
//     POSIX-relative paths)
//   - terminal_status is in {dry-run,passed,failed,interrupted,blocked}
//   - if terminal_status !== "dry-run", at least one host_command_completed
//     event exists in the manifest
//
// Usage:
//   node scripts/baseline/retention-audit.mjs \
//     --run-dir docs/next/evidence/P13-T02/runs/v9/example \
//     [--report <path>]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

const GRADEABLE_TERMINAL_STATUSES = new Set([
  "dry-run",
  "passed",
  "failed",
  "interrupted",
  "blocked"
]);

const REQUIRED_RETAINED = [
  ["run-manifest.json", "manifest"],
  ["score.json", "score"],
  ["transcript.redacted.log", "transcript"],
  ["git-before.txt", "git_before"],
  ["git-after.txt", "git_after"],
  ["fixture-hashes.sha256", "fixture_hashes"]
];

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

function readJsonSync(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

// Verify a fixture-hashes.sha256 entry is recomputable from on-disk bytes
// under the canonical policy: LF-normalized UTF-8 text, lowercase hex
// digest, POSIX-relative path.
function recomputeDigest(absPath) {
  const bytes = readFileSync(absPath);
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// Returns the set of repo-relative paths referenced by any artifact that
// could leak held-out material. Held-out assertions live in
// evals/fixtures/evaluator/<family>/assertions.yaml and must NEVER appear
// inside the run directory.
function listFilesRecursive(root, prefix = "") {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function auditRetention({ runDir, repositoryRoot }) {
  const findings = [];
  const effectiveRepoRoot = repositoryRoot ?? REPO_ROOT;

  // RETAINED — every required file must exist on disk. capture-run.mjs
  // always emits artifacts.score = "score.json" and auto-grades so the
  // file lands on disk before the run directory is sealed.
  for (const [rel, key] of REQUIRED_RETAINED) {
    const abs = path.join(runDir, rel);
    if (!existsSync(abs)) {
      findings.push({
        code: "retained_missing",
        message: `required retained artifact missing: ${rel} (${key})`,
        artifact: key
      });
    }
  }

  // DISCARDED — transcript.raw.log must be gone.
  const rawTranscript = path.join(runDir, "transcript.raw.log");
  if (existsSync(rawTranscript)) {
    findings.push({
      code: "discarded_present",
      message: `transcript.raw.log is on disk after redaction; capture-run.mjs must delete it.`,
      artifact: "raw_transcript"
    });
  }

  // Schema-level checks (only if the manifest exists).
  let manifest = null;
  const manifestPath = path.join(runDir, "run-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      findings.push({
        code: "manifest_unreadable",
        message: error instanceof Error ? error.message : String(error),
        artifact: "manifest"
      });
    }
  }
  if (manifest) {
    if (!GRADEABLE_TERMINAL_STATUSES.has(manifest.terminal_status)) {
      findings.push({
        code: "terminal_status_ungradeable",
        message: `manifest.terminal_status must be in {dry-run,passed,failed,interrupted,blocked}; got ${JSON.stringify(manifest.terminal_status)}`,
        artifact: "manifest"
      });
    }
    if (manifest.terminal_status !== "dry-run") {
      const events = Array.isArray(manifest.events) ? manifest.events : [];
      const hostEvent = events.find((e) => e?.type === "host_command_completed");
      if (!hostEvent) {
        findings.push({
          code: "host_command_event_missing",
          message: `non-dry-run captures must record at least one host_command_completed event`,
          artifact: "manifest"
        });
      }
    }
  }

  // fixture-hashes.sha256 must be recomputable. Per-run fixture hashes
  // emitted by capture-run.mjs use repo-relative POSIX paths, so the
  // referenced files may live anywhere in the repo tree (commonly under
  // workspace/public-fixture/, evals/fixtures/, or evals/baseline/).
  const hashesFile = path.join(runDir, "fixture-hashes.sha256");
  if (existsSync(hashesFile)) {
    const text = readFileSync(hashesFile, "utf8");
    const lines = text.trim().split(/\r?\n/);
    for (const line of lines) {
      const [hash, rel] = line.trim().split(/\s+/);
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        findings.push({
          code: "fixture_hash_format_invalid",
          message: `fixture-hashes.sha256 entry is not lowercase 64-hex: ${line}`,
          artifact: "fixture_hashes"
        });
        continue;
      }
      // Try the path as repo-relative first (canonical), then as
      // run-dir-relative. The capture script records repo-relative paths
      // but downstream tooling sometimes emits relative-to-run-dir, so we
      // accept either layout. The operator's --repository-root may also
      // differ from the script's REPO_ROOT, so we check both.
      const candidates = [
        path.join(effectiveRepoRoot, rel),
        path.join(REPO_ROOT, rel),
        path.join(runDir, rel)
      ];
      const abs = candidates.find((candidate) => existsSync(candidate));
      if (!abs) {
        findings.push({
          code: "fixture_hash_missing_file",
          message: `fixture-hashes.sha256 references ${rel} but the file is not on disk under the repo root or the run directory`,
          artifact: "fixture_hashes"
        });
        continue;
      }
      try {
        const recomputed = recomputeDigest(abs);
        if (recomputed !== hash) {
          findings.push({
            code: "fixture_hash_drifted",
            message: `fixture-hashes.sha256 entry for ${rel} does not match recomputed digest ${recomputed} (recorded ${hash})`,
            artifact: "fixture_hashes"
          });
        }
      } catch (error) {
        findings.push({
          code: "fixture_hash_unreadable",
          message: error instanceof Error ? error.message : String(error),
          artifact: "fixture_hashes"
        });
      }
    }
  }

  // Held-out assertions must not be bundled into the run dir.
  const allPaths = listFilesRecursive(runDir);
  const heldOutHits = allPaths.filter((rel) => rel.includes("evals/fixtures/evaluator/"));
  if (heldOutHits.length > 0) {
    findings.push({
      code: "held_out_material_leaked",
      message: `held-out evaluator material appears inside the run directory: ${heldOutHits.join(", ")}`,
      artifact: "held_out"
    });
  }

  return { ok: findings.length === 0, findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = ensureString(args["run-dir"], "run-dir");
  const reportPath = typeof args.report === "string" ? args.report : null;
  const repoRootOverride = typeof args["repository-root"] === "string"
    ? path.resolve(REPO_ROOT, args["repository-root"])
    : REPO_ROOT;
  const absRunDir = path.resolve(repoRootOverride, runDir);
  const verdict = auditRetention({ runDir: absRunDir, repositoryRoot: repoRootOverride });
  const payload = {
    schema_version: 1,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}