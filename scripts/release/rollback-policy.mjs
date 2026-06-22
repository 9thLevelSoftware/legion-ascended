#!/usr/bin/env node
// P13-T03 rollback policy verifier.
//
// Verifies that the on-disk backup manifest produced by `legion next
// migrate --apply` is restorable via `legion next migrate --rollback`
// without surprises. The verifier is intentionally read-only: it inspects
// the backup manifest, the backup directory it references, and the
// current `.legion` tree, and emits a JSON verdict.
//
// Checks enforced (each emits a stable `code`):
//   * manifest_present                 - the backup manifest exists.
//   * manifest_readable                - the manifest is valid JSON.
//   * manifest_schema_version          - schemaVersion === "0.1.0".
//   * manifest_kind_known              - kind is one of the documented
//                                        migration backup kinds.
//   * manifest_kind_supported          - kind matches the migration that
//                                        produced it (if --source is given).
//   * manifest_required_fields         - every required field is present
//                                        and well-typed.
//   * manifest_repository_root_match   - the manifest's repositoryRoot
//                                        matches the operator-supplied
//                                        --repository-root (or the cwd).
//   * manifest_backup_path_absolute    - backupPath is absolute.
//   * manifest_backup_path_present     - the backupPath directory exists.
//   * manifest_backup_hash_match       - the on-disk backup directory's
//                                        sha256:e3b0... prefix-free
//                                        tree hash matches preMigrationHash
//                                        or preImportHash.
//   * manifest_existing_legion_root_*  - if existingLegionRoot=true, the
//                                        .legion directory must exist
//                                        and contain the expected user
//                                        artefacts (legacy-protocol,
//                                        project, manifest.json).
//   * restore_target_writable          - the rollback would be able to
//                                        remove the current `.legion`
//                                        root (no read-only parent dir).
//   * manifest_created_at_recent       - the manifest.createdAt is a
//                                        well-formed ISO 8601 timestamp
//                                        within the last 365 days.
//
// Usage:
//   node scripts/release/rollback-policy.mjs \
//     --backup-manifest /path/to/backup-manifest.json \
//     [--repository-root /path/to/repo] \
//     [--source codex-legion|planning] \
//     [--report /path/to/rollback-policy.json]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

// Documented migration backup kinds. Each kind defines the set of
// required fields on the backup manifest, plus the field name for the
// pre-migration tree hash (the field is renamed per kind so the
// `apply` flow can keep a stable schemaVersion without colliding on
// hash semantics).
const KNOWN_KINDS = {
  "codex-legion-migration-backup": {
    preHashField: "preMigrationHash",
    sourceLabel: "codex-legion",
    expectedFileNames: ["legacy-protocol", "manifest.json"],
    backupSubpathHint: ".legion"
  },
  "planning-import-backup": {
    preHashField: "preImportHash",
    sourceLabel: "planning",
    expectedFileNames: ["project"],
    backupSubpathHint: ".legion"
  }
};

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

// Canonical sha256 tree hash used by @legion/legacy-bridge. The bridge
// hashes files with lowercase SHA-256 over LF-normalised UTF-8 bytes
// and POSIX-relative paths; we recompute that here so a tampered or
// drifted backup surfaces as a stable finding.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  out.sort();
  return out;
}

function sha256OfString(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashTree(rootDir) {
  if (!existsSync(rootDir)) return `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
  const files = await listFilesRecursive(rootDir);
  if (files.length === 0) return `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = toPosixPath(path.relative(rootDir, file));
    const bytes = readFileSync(file);
    hash.update(rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function auditManifest({ backupManifestPath, repositoryRoot, source }) {
  const findings = [];
  if (!existsSync(backupManifestPath)) {
    findings.push({
      code: "manifest_present",
      message: `Backup manifest not found at ${backupManifestPath}.`
    });
    return { findings, manifest: null, kind: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(backupManifestPath, "utf8"));
  } catch (error) {
    findings.push({
      code: "manifest_readable",
      message: `Backup manifest is not valid JSON: ${error?.message ?? error}`
    });
    return { findings, manifest: null, kind: null };
  }
  if (!isRecord(manifest)) {
    findings.push({
      code: "manifest_readable",
      message: `Backup manifest must be a JSON object; got ${typeof manifest}.`
    });
    return { findings, manifest: null, kind: null };
  }
  if (manifest["schemaVersion"] !== "0.1.0") {
    findings.push({
      code: "manifest_schema_version",
      message: `Backup manifest schemaVersion must be "0.1.0" (got: ${JSON.stringify(manifest["schemaVersion"])}).`
    });
  }
  const kind = manifest["kind"];
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind)) {
    findings.push({
      code: "manifest_kind_known",
      message: `Backup manifest kind must be one of ${Object.keys(KNOWN_KINDS).join(", ")}; got ${JSON.stringify(kind)}.`
    });
    return { findings, manifest, kind: null };
  }
  if (typeof source === "string" && KNOWN_KINDS[kind].sourceLabel !== source) {
    findings.push({
      code: "manifest_kind_supported",
      message: `Backup manifest kind "${kind}" does not match the requested source "${source}".`
    });
  }
  // Required fields per kind. Both kinds share createdAt, backupPath,
  // repositoryRoot, existingLegionRoot; the pre-hash field differs.
  const requiredShared = ["createdAt", "backupPath", "repositoryRoot", "existingLegionRoot"];
  const requiredKind = [...requiredShared, KNOWN_KINDS[kind].preHashField, "sourceHash"];
  for (const field of requiredKind) {
    if (!(field in manifest)) {
      findings.push({
        code: "manifest_required_fields",
        message: `Backup manifest is missing required field "${field}".`
      });
    }
  }
  // Type checks on the known fields.
  const typeChecks = [
    ["createdAt", "string"],
    ["backupPath", "string"],
    ["repositoryRoot", "string"],
    [KNOWN_KINDS[kind].preHashField, "string"],
    ["sourceHash", "string"],
    ["existingLegionRoot", "boolean"]
  ];
  for (const [field, expectedType] of typeChecks) {
    if (typeof manifest[field] !== expectedType) {
      findings.push({
        code: "manifest_required_fields",
        message: `Backup manifest field "${field}" must be a ${expectedType} (got: ${typeof manifest[field]}).`
      });
    }
  }
  // createdAt sanity check (well-formed ISO 8601 within ±1 year).
  if (typeof manifest["createdAt"] === "string") {
    const parsed = Date.parse(manifest["createdAt"]);
    if (Number.isNaN(parsed)) {
      findings.push({
        code: "manifest_created_at_recent",
        message: `Backup manifest createdAt is not a valid ISO 8601 timestamp: ${JSON.stringify(manifest["createdAt"])}`
      });
    } else {
      const deltaDays = Math.abs(Date.now() - parsed) / (1000 * 60 * 60 * 24);
      if (deltaDays > 365) {
        findings.push({
          code: "manifest_created_at_recent",
          message: `Backup manifest createdAt is more than 365 days from now (delta: ${deltaDays.toFixed(1)} days); verify the backup is still authoritative.`
        });
      }
    }
  }
  // repositoryRoot match check (compare normalised absolute paths).
  if (typeof manifest["repositoryRoot"] === "string" && typeof repositoryRoot === "string") {
    if (path.resolve(manifest["repositoryRoot"]) !== path.resolve(repositoryRoot)) {
      findings.push({
        code: "manifest_repository_root_match",
        message: `Backup manifest repositoryRoot (${manifest["repositoryRoot"]}) does not match the operator-supplied --repository-root (${repositoryRoot}).`
      });
    }
  }
  // backupPath absolute + present + hash match.
  if (typeof manifest["backupPath"] === "string") {
    if (!path.isAbsolute(manifest["backupPath"])) {
      findings.push({
        code: "manifest_backup_path_absolute",
        message: `Backup manifest backupPath must be absolute: ${manifest["backupPath"]}`
      });
    } else if (!existsSync(manifest["backupPath"])) {
      findings.push({
        code: "manifest_backup_path_present",
        message: `Backup manifest backupPath does not exist on disk: ${manifest["backupPath"]}`
      });
    } else {
      const computed = await hashTree(manifest["backupPath"]);
      const expected = manifest[KNOWN_KINDS[kind].preHashField];
      if (expected && computed !== expected) {
        findings.push({
          code: "manifest_backup_hash_match",
          message: `Backup directory hash drift: expected ${expected}, computed ${computed}.`
        });
      }
    }
  }
  // existingLegionRoot=true means the migration found a pre-existing
  // .legion tree and backed it up. Surface the expected artefacts so
  // the operator sees what would be restored.
  if (manifest["existingLegionRoot"] === true && typeof manifest["backupPath"] === "string" && existsSync(manifest["backupPath"])) {
    const entries = readdirSyncSafe(manifest["backupPath"]);
    for (const expected of KNOWN_KINDS[kind].expectedFileNames) {
      if (!entries.includes(expected)) {
        findings.push({
          code: `manifest_existing_legion_root_missing:${expected}`,
          message: `Backup directory ${manifest["backupPath"]} is missing expected entry "${expected}"; restore would be partial.`
        });
      }
    }
  }
  return { findings, manifest, kind };
}

function readdirSyncSafe(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function auditRestoreTarget({ repositoryRoot, manifest, kind }) {
  const findings = [];
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (!existsSync(legionRoot)) {
    // No live .legion means there is nothing to restore over; rollback
    // would still succeed by recreating the directory from the backup.
    // We surface this as an informational finding (not a blocker) so
    // the operator knows what would happen.
    findings.push({
      code: "restore_target_absent",
      message: `No live .legion directory at ${legionRoot}; rollback would create one from the backup.`,
      severity: "info"
    });
    return findings;
  }
  // Confirm the parent directory is writable (best-effort: stat only;
  // the bridge's rollback will surface ENOENT/EACCES itself).
  try {
    const parent = path.dirname(legionRoot);
    const st = await stat(parent);
    if (!(st.mode & 0o200)) {
      findings.push({
        code: "restore_target_writable",
        message: `Parent of .legion (${parent}) is read-only; rollback cannot delete and replace the existing tree.`
      });
    }
  } catch {
    // Parent missing is a hard fail for any restore; surface it.
    findings.push({
      code: "restore_target_writable",
      message: `Parent of .legion (${path.dirname(legionRoot)}) is not accessible.`
    });
  }
  // If the manifest is a planning-import backup, the live .legion
  // must contain a `project` directory or rollback will silently drop
  // committed state.
  if (kind === "planning-import-backup" && manifest?.existingLegionRoot === true) {
    const projectDir = path.join(legionRoot, "project");
    if (!existsSync(projectDir)) {
      findings.push({
        code: "restore_target_missing_project",
        message: `Live .legion/project is absent; rolling back to ${manifest["backupPath"]} would discard any post-import changes.`
      });
    }
  }
  return findings;
}

function summarise(findings, name) {
  const blocking = findings.filter((f) => f.severity !== "info");
  return { name, ok: blocking.length === 0, findings };
}

async function audit({ backupManifestPath, repositoryRoot, source }) {
  const manifestAudit = await auditManifest({ backupManifestPath, repositoryRoot, source });
  const restoreAudit = await auditRestoreTarget({ repositoryRoot, manifest: manifestAudit.manifest, kind: manifestAudit.kind });

  const findings = [...manifestAudit.findings, ...restoreAudit];
  // Informational findings (severity === "info") are surfaced but do
  // not block the verdict; they tell the operator what would happen
  // when rollback runs.
  const blockingFindings = findings.filter((finding) => finding.severity !== "info");
  const ok = blockingFindings.length === 0;
  return {
    ok,
    status: ok ? "restorable" : "blocked",
    backup_manifest_path: backupManifestPath,
    repository_root: repositoryRoot,
    source: source ?? null,
    kind: manifestAudit.kind,
    manifest: manifestAudit.manifest,
    findings,
    checks: {
      manifest: summarise(manifestAudit.findings, "manifest"),
      restore_target: summarise(restoreAudit, "restore_target")
    }
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const backupManifestPath = path.resolve(ensureString(args["backup-manifest"], "backup-manifest"));
  const repositoryRoot = path.resolve(typeof args["repository-root"] === "string" ? args["repository-root"] : DEFAULT_REPO_ROOT);
  const source = typeof args.source === "string" ? args.source : undefined;
  const reportPath = typeof args.report === "string" ? args.report : undefined;

  const verdict = await audit({ backupManifestPath, repositoryRoot, source });

  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(verdict.ok ? 0 : 1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath !== undefined && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`rollback-policy failed: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { audit, hashTree, parseArgs, KNOWN_KINDS };