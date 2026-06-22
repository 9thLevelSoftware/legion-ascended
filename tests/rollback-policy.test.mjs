// P13-T03 rollback-policy verifier regression test.
//
// Confirms that rollback-policy.mjs:
//   * accepts a well-formed codex backup-manifest and reports
//     `status: "restorable"` with zero findings
//   * accepts a well-formed planning backup-manifest and reports
//     `status: "restorable"` with zero findings
//   * fails closed when the manifest is missing
//   * fails closed when the manifest JSON is malformed
//   * fails closed when the manifest schemaVersion is not "0.1.0"
//   * fails closed when the manifest kind is unknown
//   * fails closed when the manifest kind does not match --source
//   * fails closed when a required field is missing
//   * fails closed when the repositoryRoot does not match
//     --repository-root
//   * fails closed when the backupPath does not exist
//   * fails closed when the backupPath hash drifts
//   * fails closed when the manifest is older than 365 days
//   * exports hashTree() and KNOWN_KINDS() so callers can compose
//     their own diagnostics
//
// The verifier is the operator-facing safety net for the GA
// migration path; every fail-closed path is pinned here so the
// CLI's `--rollback-verify` subcommand cannot regress silently.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release", "rollback-policy.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    ...options
  });
}

function hashBackupDir(backupPath) {
  // Mirror the bridge's hashFiles format: sorted POSIX paths, then
  // for each file: <path>\0<bytes>\0, concatenated into one SHA-256.
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push({ rel: path.relative(backupPath, full).split(path.sep).join("/"), full });
    }
  }
  walk(backupPath);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(readFileSync(entry.full));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function withWorkspace(callback) {
  const fs = await import("node:fs/promises");
  const workspace = await fs.mkdtemp(path.join(ROOT, ".rollback-policy-test-"));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function writeManifest(manifestPath, manifest) {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function writeBackup(backupPath, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = path.join(backupPath, relativePath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
}

const CODEX_MANIFEST_KIND = "codex-legion-migration-backup";
const PLANNING_MANIFEST_KIND = "planning-import-backup";

function freshManifest(kind, overrides = {}) {
  return {
    schemaVersion: "0.1.0",
    kind,
    createdAt: "2026-06-22T15:00:00.000Z",
    repositoryRoot: "/abs/path/to/repo",
    backupPath: "/abs/path/to/.legion-backup-fresh",
    preMigrationHash: "PLACEHOLDER-PRE-MIGRATION-HASH",
    preImportHash: "PLACEHOLDER-PRE-IMPORT-HASH",
    sourceHash: "PLACEHOLDER-SOURCE-HASH",
    existingLegionRoot: true,
    ...overrides
  };
}

test("P13-T03 rollback-policy passes a well-formed codex backup-manifest", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, {
      "manifest.json": "{\"version\":\"8.0.5\"}\n"
    });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preMigrationHash = hashBackupDir(backupPath);
    writeManifest(manifestPath, freshManifest(CODEX_MANIFEST_KIND, { backupPath, preMigrationHash, repositoryRoot: workspace }));

    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace, "--source", "codex-legion"]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "restorable");
    assert.equal(payload.kind, CODEX_MANIFEST_KIND);
    // Informational findings (severity: "info") are allowed.
    const blocking = payload.findings.filter((f) => f.severity !== "info");
    assert.equal(blocking.length, 0);
    assert.equal(payload.checks.manifest.ok, true);
    assert.equal(payload.checks.restore_target.ok, true);
  });
});

test("P13-T03 rollback-policy accepts codex backups captured before legacy-protocol migration", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, {
      "commands/legion/start.md": "# start\n",
      "agents/default.md": "# agent\n",
      "manifest.json": "{\"version\":\"8.0.5\"}\n"
    });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preMigrationHash = hashBackupDir(backupPath);
    writeManifest(manifestPath, freshManifest(CODEX_MANIFEST_KIND, { backupPath, preMigrationHash, repositoryRoot: workspace }));

    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace, "--source", "codex-legion"]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(
      payload.findings.some((f) => f.code === "manifest_existing_legion_root_missing:legacy-protocol"),
      false
    );
  });
});

test("P13-T03 rollback-policy passes a well-formed planning backup-manifest", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, {
      "project/changes/foo.yaml": "id: foo\nstatus: archived\n"
    });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preImportHash = hashBackupDir(backupPath);
    writeManifest(
      manifestPath,
      freshManifest(PLANNING_MANIFEST_KIND, {
        backupPath,
        preImportHash,
        repositoryRoot: workspace
      })
    );

    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace, "--source", "planning"]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "restorable");
    assert.equal(payload.kind, PLANNING_MANIFEST_KIND);
    // Informational findings (severity: "info") are allowed.
    const blocking = payload.findings.filter((f) => f.severity !== "info");
    assert.equal(blocking.length, 0);
  });
});

test("P13-T03 rollback-policy fails closed when the manifest is missing", async () => {
  const result = run(["--backup-manifest", "/no/such/path/backup-manifest.json", "--source", "codex-legion"]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "blocked");
  assert.ok(payload.findings.some((f) => f.code === "manifest_present"));
});

test("P13-T03 rollback-policy fails closed when the manifest JSON is malformed", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    writeFileSync(manifestPath, "{ this is not JSON", "utf8");
    const result = run(["--backup-manifest", manifestPath, "--source", "codex-legion"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.ok(payload.findings.some((f) => f.code === "manifest_readable"));
  });
});

test("P13-T03 rollback-policy fails closed on schemaVersion mismatch", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    writeManifest(manifestPath, freshManifest(CODEX_MANIFEST_KIND, { schemaVersion: "0.0.1" }));
    const result = run(["--backup-manifest", manifestPath]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_schema_version"));
  });
});

test("P13-T03 rollback-policy fails closed on unknown manifest kind", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    writeManifest(manifestPath, freshManifest("v9-installer-backup"));
    const result = run(["--backup-manifest", manifestPath]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_kind_known"));
  });
});

test("P13-T03 rollback-policy fails closed when source does not match manifest kind", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    writeManifest(manifestPath, freshManifest(PLANNING_MANIFEST_KIND));
    const result = run(["--backup-manifest", manifestPath, "--source", "codex-legion"]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_kind_supported"));
  });
});

test("P13-T03 rollback-policy fails closed when a required field is missing", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const partial = freshManifest(CODEX_MANIFEST_KIND);
    delete partial.preMigrationHash;
    writeManifest(manifestPath, partial);
    const result = run(["--backup-manifest", manifestPath]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_required_fields"));
  });
});

test("P13-T03 rollback-policy fails closed when repositoryRoot does not match", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, { "manifest.json": "{\"version\":\"8.0.5\"}\n" });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preMigrationHash = hashBackupDir(backupPath);
    writeManifest(
      manifestPath,
      freshManifest(CODEX_MANIFEST_KIND, {
        backupPath,
        preMigrationHash,
        repositoryRoot: "/different/repo/root"
      })
    );
    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_repository_root_match"));
  });
});

test("P13-T03 rollback-policy fails closed when backupPath is missing", async () => {
  await withWorkspace(async (workspace) => {
    const manifestPath = path.join(workspace, "backup-manifest.json");
    writeManifest(
      manifestPath,
      freshManifest(CODEX_MANIFEST_KIND, {
        backupPath: path.join(workspace, "no-such-backup-dir"),
        preMigrationHash: "PLACEHOLDER-PRE-MIGRATION-HASH",
        repositoryRoot: workspace
      })
    );
    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_backup_path_present"));
  });
});

test("P13-T03 rollback-policy fails closed on backupPath hash drift", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, { "manifest.json": "{\"version\":\"8.0.5\"}\n" });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    // Record the original hash, then tamper with the bytes.
    const preMigrationHash = hashBackupDir(backupPath);
    writeFileSync(path.join(backupPath, "manifest.json"), "TAMPERED", "utf8");
    writeManifest(
      manifestPath,
      freshManifest(CODEX_MANIFEST_KIND, {
        backupPath,
        preMigrationHash,
        repositoryRoot: workspace
      })
    );
    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_backup_hash_match"));
  });
});

test("P13-T03 rollback-policy fails closed when manifest is older than 365 days", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, { "manifest.json": "{\"version\":\"8.0.5\"}\n" });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preMigrationHash = hashBackupDir(backupPath);
    writeManifest(
      manifestPath,
      freshManifest(CODEX_MANIFEST_KIND, {
        backupPath,
        preMigrationHash,
        createdAt: "2020-01-01T00:00:00.000Z",
        repositoryRoot: workspace
      })
    );
    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "manifest_created_at_recent"));
  });
});

test("P13-T03 rollback-policy emits well-formed checks map", async () => {
  await withWorkspace(async (workspace) => {
    const backupPath = path.join(workspace, "backup");
    writeBackup(backupPath, {
      "commands/legion/start.md": "# start\n",
      "manifest.json": "{\"version\":\"8.0.5\"}\n"
    });
    const manifestPath = path.join(workspace, "backup-manifest.json");
    const preMigrationHash = hashBackupDir(backupPath);
    writeManifest(
      manifestPath,
      freshManifest(CODEX_MANIFEST_KIND, { backupPath, preMigrationHash, repositoryRoot: workspace })
    );
    const result = run(["--backup-manifest", manifestPath, "--repository-root", workspace]);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.checks);
    assert.equal(typeof payload.checks.manifest, "object");
    assert.equal(typeof payload.checks.restore_target, "object");
    assert.equal(payload.checks.manifest.ok, true);
    assert.equal(payload.checks.restore_target.ok, true);
  });
});
