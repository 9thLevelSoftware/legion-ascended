import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyPlanningImport,
  createPlanningImportDryRun,
  rollbackPlanningImport
} from "../dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "migration", "planning");
const OWNER = { kind: "human", id: "human:owner", displayName: "Owner" };
const FIXED_TIME = "2026-06-21T12:00:00.000Z";

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), "legion-planning-import-"));
}

async function copyFixture(name, destination) {
  await cp(path.join(FIXTURES, name), destination, { recursive: true });
}

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile()) files.push(path.relative(root, absolutePath).replaceAll("\\", "/"));
    }
  }

  await visit(root);
  return files.sort();
}

async function hashDirectory(root) {
  const hash = createHash("sha256");
  for (const file of await listFiles(root)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(root, ...file.split("/"))));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function importProject(overrides = {}) {
  return {
    slug: "legacy-planning-import",
    name: "Legacy Planning Import",
    description: "Imported from legacy .planning fixtures.",
    decisionOwners: [OWNER],
    createdAt: FIXED_TIME,
    ...overrides
  };
}

test("P02-T08 dry-run stages deterministic v9 artifacts without mutating legacy .planning", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const stagingA = path.join(workspace, "stage-a");
    const stagingB = path.join(workspace, "stage-b");
    await copyFixture("clean", sourceRoot);
    const sourceBefore = await hashDirectory(path.join(sourceRoot, ".planning"));

    const first = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target"),
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot: stagingA,
      runId: "planning-import-clean",
      project: importProject()
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, "dry_run");

    const second = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target"),
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot: stagingB,
      runId: "planning-import-clean",
      project: importProject()
    });
    assert.equal(second.ok, true);
    assert.equal(second.status, "dry_run");

    assert.equal(await hashDirectory(path.join(sourceRoot, ".planning")), sourceBefore);
    assert.equal(await hashDirectory(stagingA), await hashDirectory(stagingB));

    const stagedFiles = await listFiles(stagingA);
    assert.ok(stagedFiles.includes(".legion/project/project.json"));
    assert.ok(stagedFiles.includes(".legion/project/specs/req_dsc-01.md"));
    assert.ok(stagedFiles.includes(".legion/project/migration/planning-import-report.json"));

    const report = await readJson(path.join(stagingA, ".legion", "project", "migration", "planning-import-report.json"));
    assert.equal(report.runId, "planning-import-clean");
    assert.equal(report.requiresReview, true);
    assert.equal(report.policy.planningReadOnlyAfterApply, true);
    assert.ok(report.source.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.sha256)));
    assert.ok(report.mappings.some((mapping) =>
      mapping.sourcePath === ".planning/PROJECT.md" &&
      mapping.targetPath === ".legion/project/specs/req_dsc-01.md" &&
      mapping.classification === "direct"
    ));
    assert.ok(report.uncertainties.some((uncertainty) => uncertainty.code === "operational_state_not_authoritative"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 dry-run reports stale state, contradictory plan summaries, and missing requirements", async () => {
  const workspace = await tempRoot();
  try {
    const staleSource = path.join(workspace, "stale");
    const missingSource = path.join(workspace, "missing");
    await copyFixture("stale-contradictory", staleSource);
    await copyFixture("missing-requirements", missingSource);

    const stale = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target-a"),
      planningRoot: path.join(staleSource, ".planning"),
      stagingRoot: path.join(workspace, "stage-stale"),
      runId: "planning-import-stale",
      project: importProject()
    });
    assert.equal(stale.ok, true);
    assert.equal(stale.status, "dry_run");
    assert.ok(stale.report.uncertainties.some((entry) =>
      entry.code === "stale_operational_state" && entry.blocksAutomaticAcceptance
    ));
    assert.ok(stale.report.conflicts.some((entry) => entry.code === "plan_summary_mismatch"));

    const missing = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target-b"),
      planningRoot: path.join(missingSource, ".planning"),
      stagingRoot: path.join(workspace, "stage-missing"),
      runId: "planning-import-missing",
      project: importProject()
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "invalid");
    assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "missing_requirements"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 dry-run rejects staging paths that overlap repository or source roots", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    await copyFixture("clean", sourceRoot);
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    const markerPath = path.join(targetRoot, ".legion", "project", "project.json");
    await writeFile(markerPath, "{\"keep\":true}\n", "utf8");

    const underRepository = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot: path.join(targetRoot, ".legion", "project"),
      runId: "planning-import-unsafe-repo-stage",
      project: importProject()
    });
    assert.equal(underRepository.ok, false);
    assert.equal(underRepository.status, "invalid");
    assert.ok(underRepository.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_staging_root"));
    assert.equal(await readFile(markerPath, "utf8"), "{\"keep\":true}\n");

    const underSource = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot: path.join(sourceRoot, ".planning", "stage"),
      runId: "planning-import-unsafe-source-stage",
      project: importProject()
    });
    assert.equal(underSource.ok, false);
    assert.equal(underSource.status, "invalid");
    assert.ok(underSource.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_staging_root"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 dry-run handles EOF summaries, malformed YAML, and invalid timestamps as diagnostics", async () => {
  const workspace = await tempRoot();
  try {
    const eofSource = path.join(workspace, "eof-summary");
    const malformedYamlSource = path.join(workspace, "malformed-yaml");
    await copyFixture("stale-contradictory", eofSource);
    await copyFixture("clean", malformedYamlSource);

    await writeFile(
      path.join(eofSource, ".planning", "phases", "01-foundation", "01-01-SUMMARY.md"),
      "# Plan 01-01 Summary\n\n## Files Modified\n\n- `src/actual.ts`\n",
      "utf8"
    );

    const eof = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target-eof"),
      planningRoot: path.join(eofSource, ".planning"),
      stagingRoot: path.join(workspace, "stage-eof"),
      runId: "planning-import-eof-summary",
      project: importProject()
    });
    assert.equal(eof.ok, true);
    assert.ok(eof.report.conflicts.some((entry) => entry.code === "plan_summary_mismatch"));

    await writeFile(
      path.join(malformedYamlSource, ".planning", "phases", "01-foundation", "01-01-PLAN.md"),
      "---\nfiles_modified: [\n---\n\n# Bad YAML plan\n",
      "utf8"
    );

    const malformedYaml = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target-yaml"),
      planningRoot: path.join(malformedYamlSource, ".planning"),
      stagingRoot: path.join(workspace, "stage-yaml"),
      runId: "planning-import-malformed-yaml",
      project: importProject()
    });
    assert.equal(malformedYaml.ok, true);

    const invalidCreatedAt = await createPlanningImportDryRun({
      repositoryRoot: path.join(workspace, "target-created-at"),
      planningRoot: path.join(eofSource, ".planning"),
      stagingRoot: path.join(workspace, "stage-created-at"),
      runId: "planning-import-invalid-created-at",
      project: importProject({ createdAt: "not-a-timestamp" })
    });
    assert.equal(invalidCreatedAt.ok, false);
    assert.equal(invalidCreatedAt.status, "invalid");
    assert.ok(invalidCreatedAt.diagnostics.some((diagnostic) => diagnostic.code === "invalid_project_created_at"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 apply backs up destination and rollback restores exact pre-import .legion bytes", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("clean", sourceRoot);
    await mkdir(path.join(targetRoot, ".planning"), { recursive: true });
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(targetRoot, ".planning", "STATE.md"), "# Source policy marker\n", "utf8");
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"legacy\":true}\n", "utf8");
    const planningBefore = await hashDirectory(path.join(targetRoot, ".planning"));
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-apply",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    const blocked = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: false,
      allowReplaceExistingProject: true
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, "blocked");
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);

    const applied = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "applied");
    assert.equal(await hashDirectory(path.join(targetRoot, ".planning")), planningBefore);
    assert.notEqual(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);

    const backupManifest = await readJson(applied.backup.manifestPath);
    assert.equal(backupManifest.preImportHash, legionBefore);
    assert.equal(backupManifest.sourceHash, dryRun.report.source.treeHash);

    const rolledBack = await rollbackPlanningImport({
      repositoryRoot: targetRoot,
      backupManifestPath: applied.backup.manifestPath
    });
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
    assert.equal(await hashDirectory(path.join(targetRoot, ".planning")), planningBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 apply rejects tampered staging, bad reports, and invalid timestamps without mutating destination", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("clean", sourceRoot);
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-tamper",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    const invalidAppliedAt = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: "not-a-timestamp",
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(invalidAppliedAt.ok, false);
    assert.equal(invalidAppliedAt.status, "invalid");
    assert.ok(invalidAppliedAt.diagnostics.some((diagnostic) => diagnostic.code === "invalid_applied_at"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);

    await writeFile(path.join(stagingRoot, ".legion", "project", "project.json"), "{\"tampered\":true}\n", "utf8");
    const tampered = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.status, "invalid");
    assert.ok(tampered.diagnostics.some((diagnostic) => diagnostic.code === "staged_project_hash_mismatch"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);

    await writeFile(
      path.join(stagingRoot, ".legion", "project", "migration", "planning-import-report.json"),
      "{}",
      "utf8"
    );
    const badReport = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(badReport.ok, false);
    assert.equal(badReport.status, "invalid");
    assert.ok(badReport.diagnostics.some((diagnostic) => diagnostic.code === "invalid_dry_run_report"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 apply rejects backup roots that overlap .legion before copying", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const unsafeBackupRoot = path.join(targetRoot, ".legion", "project", "backups");
    await copyFixture("clean", sourceRoot);
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-unsafe-backup-root",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot: unsafeBackupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "invalid");
    assert.ok(applied.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_backup_root"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 apply rejects symlinked backup roots whose real path overlaps .legion", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const unsafeBackupTarget = path.join(targetRoot, ".legion", "project", "linked-backups");
    const unsafeBackupRoot = path.join(workspace, "external-backup-link");
    await copyFixture("clean", sourceRoot);
    await mkdir(unsafeBackupTarget, { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    await symlink(unsafeBackupTarget, unsafeBackupRoot, process.platform === "win32" ? "junction" : "dir");
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-symlinked-backup-root",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot: unsafeBackupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "invalid");
    assert.ok(applied.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_backup_root"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 apply rejects backup roots that overlap planning source or staging roots", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    await copyFixture("clean", sourceRoot);
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const planningBefore = await hashDirectory(path.join(sourceRoot, ".planning"));
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-backup-root-source-overlap",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    for (const backupRoot of [
      path.join(sourceRoot, ".planning", "backups"),
      path.join(stagingRoot, "backups")
    ]) {
      const applied = await applyPlanningImport({
        repositoryRoot: targetRoot,
        stagingRoot,
        backupRoot,
        appliedAt: FIXED_TIME,
        reviewAccepted: true,
        allowReplaceExistingProject: true
      });
      assert.equal(applied.ok, false);
      assert.equal(applied.status, "invalid");
      assert.ok(applied.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_backup_root"));
      assert.equal(await hashDirectory(path.join(sourceRoot, ".planning")), planningBefore);
      assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 rollback rejects malformed backup manifests without deleting current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const targetRoot = path.join(workspace, "target");
    const backupRoot = path.join(workspace, "backups");
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));
    const manifestPath = path.join(backupRoot, "backup-manifest.json");
    await writeFile(manifestPath, "{}", "utf8");

    const rolledBack = await rollbackPlanningImport({
      repositoryRoot: targetRoot,
      backupManifestPath: manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "invalid_backup_manifest"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 rollback rejects unusable backup manifests before deleting current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const targetRoot = path.join(workspace, "target");
    const backupRoot = path.join(workspace, "backups");
    await mkdir(path.join(targetRoot, ".legion", "project"), { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(targetRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const legionBefore = await hashDirectory(path.join(targetRoot, ".legion"));
    const manifestPath = path.join(backupRoot, "missing-backup-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "planning-import-backup",
        createdAt: FIXED_TIME,
        repositoryRoot: targetRoot,
        backupPath: path.join(backupRoot, "missing-legion-backup"),
        preImportHash: legionBefore,
        sourceHash: legionBefore,
        existingLegionRoot: true
      }, null, 2),
      "utf8"
    );

    const rolledBack = await rollbackPlanningImport({
      repositoryRoot: targetRoot,
      backupManifestPath: manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "invalid_backup_manifest"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 rollback rejects backup manifests from another repository before deleting current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const planningSourceRoot = path.join(workspace, "planning-source");
    const sourceRepositoryRoot = path.join(workspace, "source-repo");
    const targetRepositoryRoot = path.join(workspace, "target-repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("clean", planningSourceRoot);
    await mkdir(path.join(sourceRepositoryRoot, ".legion", "project"), { recursive: true });
    await mkdir(path.join(targetRepositoryRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(sourceRepositoryRoot, ".legion", "project", "project.json"), "{\"source\":true}\n", "utf8");
    await writeFile(path.join(targetRepositoryRoot, ".legion", "project", "project.json"), "{\"target\":true}\n", "utf8");
    const targetBefore = await hashDirectory(path.join(targetRepositoryRoot, ".legion"));

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: sourceRepositoryRoot,
      planningRoot: path.join(planningSourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-cross-repo-backup",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);
    const applied = await applyPlanningImport({
      repositoryRoot: sourceRepositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(applied.ok, true);

    const rolledBack = await rollbackPlanningImport({
      repositoryRoot: targetRepositoryRoot,
      backupManifestPath: applied.backup.manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "backup_repository_mismatch"));
    assert.equal(await hashDirectory(path.join(targetRepositoryRoot, ".legion")), targetBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 rollback rejects relative manifest repository roots before deleting current .legion", async () => {
  const workspace = await tempRoot();
  const previousCwd = process.cwd();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const backupRoot = path.join(workspace, "backups");
    await mkdir(path.join(repositoryRoot, ".legion", "project"), { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", "project", "project.json"), "{\"keep\":true}\n", "utf8");
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));
    const manifestPath = path.join(backupRoot, "relative-repository-root-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "planning-import-backup",
        createdAt: FIXED_TIME,
        repositoryRoot: ".",
        backupPath: path.join(backupRoot, "unused"),
        preImportHash: "sha256:unused",
        sourceHash: "sha256:unused",
        existingLegionRoot: false
      }),
      "utf8"
    );

    process.chdir(repositoryRoot);
    const rolledBack = await rollbackPlanningImport({
      repositoryRoot,
      backupManifestPath: manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "invalid_backup_manifest"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 rollback verifies backup hashes before replacing current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const planningSourceRoot = path.join(workspace, "planning-source");
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("clean", planningSourceRoot);
    await mkdir(path.join(repositoryRoot, ".legion", "project"), { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", "project", "project.json"), "{\"before\":true}\n", "utf8");

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot,
      planningRoot: path.join(planningSourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-corrupted-backup",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);
    const applied = await applyPlanningImport({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true,
      allowReplaceExistingProject: true
    });
    assert.equal(applied.ok, true);

    const currentBeforeRollback = await hashDirectory(path.join(repositoryRoot, ".legion"));
    await writeFile(path.join(applied.backup.backupPath, "project", "project.json"), "{\"corrupted\":true}\n", "utf8");

    const rolledBack = await rollbackPlanningImport({
      repositoryRoot,
      backupManifestPath: applied.backup.manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "backup_hash_mismatch"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), currentBeforeRollback);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T08 repeated apply is rejected without changing destination", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("clean", sourceRoot);

    const dryRun = await createPlanningImportDryRun({
      repositoryRoot: targetRoot,
      planningRoot: path.join(sourceRoot, ".planning"),
      stagingRoot,
      runId: "planning-import-repeat",
      project: importProject()
    });
    assert.equal(dryRun.ok, true);

    const first = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(first.ok, true);
    const afterFirst = await hashDirectory(path.join(targetRoot, ".legion"));

    const repeated = await applyPlanningImport({
      repositoryRoot: targetRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.status, "conflict");
    assert.ok(repeated.diagnostics.some((diagnostic) => diagnostic.code === "destination_contains_v9_project"));
    assert.equal(await hashDirectory(path.join(targetRoot, ".legion")), afterFirst);

    assert.equal((await stat(path.join(sourceRoot, ".planning"))).isDirectory(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
