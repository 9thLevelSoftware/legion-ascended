import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { initProject } from "@legion/artifacts";
import {
  applyCodexLegionMigration,
  createCodexLegionMigrationDryRun,
  rollbackCodexLegionMigration
} from "../dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "migration", "codex");
const OWNER = { kind: "human", id: "human:owner", displayName: "Owner" };
const FIXED_TIME = "2026-06-21T12:00:00.000Z";
const CODEX_REPORT_PATH = path.join(".legion", "migration", "codex-legion-migration-report.json");

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), "legion-codex-migration-"));
}

async function copyFixture(name, destination) {
  await cp(path.join(FIXTURES, name), destination, { recursive: true });
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

async function createFileSymlinkOrSkip(t, targetPath, linkPath) {
  try {
    await symlink(targetPath, linkPath, "file");
    return true;
  } catch (error) {
    if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) {
      t.skip("filesystem does not allow creating file symlinks in this environment");
      return false;
    }
    throw error;
  }
}

function initInput(repositoryRoot) {
  return {
    repositoryRoot,
    slug: "legion-next",
    name: "Legion Next",
    decisionOwners: [OWNER],
    createdAt: FIXED_TIME
  };
}

test("P02-T09 dry-run inventories local and global Codex .legion protocol installs deterministically", async () => {
  const workspace = await tempRoot();
  try {
    for (const [fixture, scope] of [["local-codex", "local"], ["global-codex", "global"]]) {
      const sourceRoot = path.join(workspace, fixture);
      const stagingA = path.join(workspace, `${fixture}-stage-a`);
      const stagingB = path.join(workspace, `${fixture}-stage-b`);
      await copyFixture(fixture, sourceRoot);
      const sourceBefore = await hashDirectory(path.join(sourceRoot, ".legion"));

      const first = await createCodexLegionMigrationDryRun({
        repositoryRoot: sourceRoot,
        stagingRoot: stagingA,
        runId: `${fixture}-dry-run`,
        createdAt: FIXED_TIME
      });
      assert.equal(first.ok, true);
      assert.equal(first.status, "dry_run");

      const second = await createCodexLegionMigrationDryRun({
        repositoryRoot: sourceRoot,
        stagingRoot: stagingB,
        runId: `${fixture}-dry-run`,
        createdAt: FIXED_TIME
      });
      assert.equal(second.ok, true);
      assert.equal(second.status, "dry_run");

      assert.equal(await hashDirectory(path.join(sourceRoot, ".legion")), sourceBefore);
      assert.equal(await hashDirectory(stagingA), await hashDirectory(stagingB));
      assert.equal(first.report.source.root, ".legion");
      assert.equal(first.report.target.root, ".legion/legacy-protocol");
      assert.equal(first.report.manifest?.runtime, "codex");
      assert.equal(first.report.manifest?.scope, scope);
      assert.equal(first.report.policy.v8DefaultInstallUnchanged, true);
      assert.equal(first.report.policy.nativeCodexSurfacesUntouched, true);
      assert.ok(first.report.source.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.sha256)));
      assert.ok(first.report.source.files.some((file) =>
        file.path === ".legion/commands/legion/start.md" &&
        file.classification === "generated-plugin-protocol"
      ));
      assert.ok(first.report.moves.some((move) =>
        move.sourcePath === ".legion/commands/legion/start.md" &&
        move.targetPath === ".legion/legacy-protocol/commands/legion/start.md"
      ));
      assert.ok(first.report.nativeSurfaces.some((surface) => surface.path === ".codex/prompts/legion-start.md"));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 apply preserves customized bytes and unblocks v9 project initialization", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));
    const nativePromptBefore = await readFile(path.join(repositoryRoot, ".codex", "prompts", "legion-start.md"), "utf8");
    const customBytesBefore = await readFile(path.join(repositoryRoot, ".legion", "custom", "notes.md"), "utf8");

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-apply",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    assert.ok(dryRun.report.source.files.some((file) =>
      file.path === ".legion/custom/notes.md" &&
      file.classification === "user-authored-or-customized"
    ));

    const blocked = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: false
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, "blocked");
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "applied");
    assert.equal(applied.backup.preMigrationHash, legionBefore);

    assert.equal(await exists(path.join(repositoryRoot, ".legion", "commands", "legion", "start.md")), false);
    assert.equal(
      await readFile(path.join(repositoryRoot, ".legion", "legacy-protocol", "custom", "notes.md"), "utf8"),
      customBytesBefore
    );
    assert.equal(
      await readFile(path.join(repositoryRoot, ".codex", "prompts", "legion-start.md"), "utf8"),
      nativePromptBefore
    );

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
    assert.equal(initialized.status, "initialized");
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "legacy-protocol", "manifest.json")), true);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "project", "project.json")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rollback restores the exact pre-migration .legion layout", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-rollback",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.notEqual(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    const rolledBack = await rollbackCodexLegionMigration({
      repositoryRoot,
      backupManifestPath: applied.backup.manifestPath
    });
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(rolledBack.restoredHash, legionBefore);
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 partial installs without manifests are preserved as customized legacy data", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("partial-codex", repositoryRoot);
    const customBytesBefore = await readFile(path.join(repositoryRoot, ".legion", "local-overrides.md"), "utf8");

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-partial",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.report.manifest, undefined);
    assert.ok(dryRun.report.uncertainties.some((entry) => entry.code === "missing_codex_manifest"));
    assert.ok(dryRun.report.source.files.every((file) => file.classification === "user-authored-or-customized"));

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(
      await readFile(path.join(repositoryRoot, ".legion", "legacy-protocol", "local-overrides.md"), "utf8"),
      customBytesBefore
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 repeat migration is a no-op report without moving v9 project data", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const repeatStage = path.join(workspace, "repeat-stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-repeat",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);

    await initProject(initInput(repositoryRoot));
    const afterInit = await hashDirectory(path.join(repositoryRoot, ".legion"));

    const repeat = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot: repeatStage,
      runId: "codex-legion-repeat-second",
      createdAt: FIXED_TIME
    });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.status, "dry_run");
    assert.equal(repeat.report.moves.length, 0);
    assert.ok(repeat.report.uncertainties.some((entry) => entry.code === "legacy_protocol_already_migrated"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), afterInit);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 apply resumes an interrupted legacy-protocol move with matching existing files", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    const commandPath = path.join(repositoryRoot, ".legion", "commands", "legion", "start.md");
    const originalCommandBytes = await readFile(commandPath);

    const legacyProtocolRoot = path.join(repositoryRoot, ".legion", "legacy-protocol");
    for (const relativePath of await listFiles(path.join(repositoryRoot, ".legion"))) {
      const sourcePath = path.join(repositoryRoot, ".legion", ...relativePath.split("/"));
      const destinationPath = path.join(legacyProtocolRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath);
    }
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "commands", "legion", "start.md")), true);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "legacy-protocol", "commands", "legion", "start.md")), true);

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-resume",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    assert.ok(dryRun.report.moves.some((move) => move.sourcePath === ".legion/commands/legion/start.md"));

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "commands")), false);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "agents")), false);
    assert.deepEqual(
      await readFile(path.join(repositoryRoot, ".legion", "legacy-protocol", "commands", "legion", "start.md")),
      originalCommandBytes
    );

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 apply removes empty legacy roots so v9 init is unblocked", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("partial-codex", repositoryRoot);
    await mkdir(path.join(repositoryRoot, ".legion", "agents", "empty-placeholder"), { recursive: true });

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-empty-roots",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "agents")), false);

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 apply moves legacy migration roots so v9 init is unblocked", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    await mkdir(path.join(repositoryRoot, ".legion", "migration"), { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", "migration", "previous-report.json"), "{\"legacy\":true}\n", "utf8");

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-migration-root",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    assert.ok(dryRun.report.moves.some((move) => move.sourcePath === ".legion/migration/previous-report.json"));

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "migration")), false);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "legacy-protocol", "migration", "previous-report.json")), true);

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rejects backup roots that overlap .legion before copying", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    await copyFixture("local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));
    const unsafeBackupRoot = path.join(repositoryRoot, ".legion", "backups");

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-unsafe-backup",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot: unsafeBackupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "invalid");
    assert.ok(applied.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_backup_root"));
    assert.equal(await exists(unsafeBackupRoot), false);
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rejects symlinked legacy entries instead of silently dropping them", async (t) => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    await copyFixture("local-codex", repositoryRoot);
    const created = await createFileSymlinkOrSkip(
      t,
      path.join(repositoryRoot, ".legion", "commands", "legion", "start.md"),
      path.join(repositoryRoot, ".legion", "commands", "legion", "linked-start.md")
    );
    if (!created) return;

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-symlink",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, false);
    assert.equal(dryRun.status, "conflict");
    assert.ok(dryRun.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_symbolic_link"));
    assert.ok(dryRun.diagnostics.some((diagnostic) => diagnostic.sourcePath === ".legion/commands/legion/linked-start.md"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rejects unsafe staging paths and invalid apply timestamps without mutating the source", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));

    const unsafe = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot: path.join(repositoryRoot, ".legion", "stage"),
      runId: "codex-legion-unsafe-stage",
      createdAt: FIXED_TIME
    });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.status, "invalid");
    assert.ok(unsafe.diagnostics.some((diagnostic) => diagnostic.code === "unsafe_staging_root"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    const stagingRoot = path.join(workspace, "stage");
    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-invalid-apply",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const invalidAppliedAt = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: "not-a-timestamp",
      reviewAccepted: true
    });
    assert.equal(invalidAppliedAt.ok, false);
    assert.equal(invalidAppliedAt.status, "invalid");
    assert.ok(invalidAppliedAt.diagnostics.some((diagnostic) => diagnostic.code === "invalid_applied_at"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    await mkdir(backupRoot, { recursive: true });
    const badManifestPath = path.join(backupRoot, "bad-backup-manifest.json");
    await writeFile(badManifestPath, "{}", "utf8");
    const badRollback = await rollbackCodexLegionMigration({
      repositoryRoot,
      backupManifestPath: badManifestPath
    });
    assert.equal(badRollback.ok, false);
    assert.equal(badRollback.status, "invalid");
    assert.ok(badRollback.diagnostics.some((diagnostic) => diagnostic.code === "invalid_backup_manifest"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 backup manifests use absolute paths so rollback survives cwd changes", async () => {
  const workspace = await tempRoot();
  const originalCwd = process.cwd();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const relativeBackupRoot = path.relative(originalCwd, path.join(workspace, "backups"));
    await copyFixture("local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-relative-backup",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot: relativeBackupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);
    assert.equal(path.isAbsolute(applied.backup.manifestPath), true);
    assert.equal(path.isAbsolute(applied.backup.backupPath), true);

    process.chdir(tmpdir());
    const rolledBack = await rollbackCodexLegionMigration({
      repositoryRoot,
      backupManifestPath: applied.backup.manifestPath
    });
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.restoredHash, legionBefore);
  } finally {
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rollback rejects unusable backup manifests before deleting current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    await mkdir(backupRoot, { recursive: true });
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));
    const manifestPath = path.join(backupRoot, "missing-backup-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "codex-legion-migration-backup",
        createdAt: FIXED_TIME,
        repositoryRoot,
        backupPath: path.join(backupRoot, "missing-legion-backup"),
        preMigrationHash: legionBefore,
        sourceHash: legionBefore,
        existingLegionRoot: true
      }, null, 2),
      "utf8"
    );

    const rolledBack = await rollbackCodexLegionMigration({
      repositoryRoot,
      backupManifestPath: manifestPath
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.status, "invalid");
    assert.ok(rolledBack.diagnostics.some((diagnostic) => diagnostic.code === "invalid_backup_manifest"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T09 rollback rejects backup manifests from another repository before deleting current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRepositoryRoot = path.join(workspace, "source-repo");
    const targetRepositoryRoot = path.join(workspace, "target-repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", sourceRepositoryRoot);
    await copyFixture("partial-codex", targetRepositoryRoot);
    const targetBefore = await hashDirectory(path.join(targetRepositoryRoot, ".legion"));

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot: sourceRepositoryRoot,
      stagingRoot,
      runId: "codex-legion-cross-repo-backup",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    const applied = await applyCodexLegionMigration({
      repositoryRoot: sourceRepositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);

    const rolledBack = await rollbackCodexLegionMigration({
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

test("P02-T09 rollback verifies backup hashes before replacing current .legion", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-corrupted-backup",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);
    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, true);

    const currentBeforeRollback = await hashDirectory(path.join(repositoryRoot, ".legion"));
    await writeFile(path.join(applied.backup.backupPath, "commands", "legion", "start.md"), "corrupted backup\n", "utf8");

    const rolledBack = await rollbackCodexLegionMigration({
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

test("P02-T09 apply rejects tampered migration report moves before cleanup", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("local-codex", repositoryRoot);
    await mkdir(path.join(repositoryRoot, ".legion", "project"), { recursive: true });
    const projectFile = path.join(repositoryRoot, ".legion", "project", "project.json");
    await writeFile(projectFile, "{\"project\":true}\n", "utf8");

    const dryRun = await createCodexLegionMigrationDryRun({
      repositoryRoot,
      stagingRoot,
      runId: "codex-legion-tampered-move",
      createdAt: FIXED_TIME
    });
    assert.equal(dryRun.ok, true);

    const reportPath = path.join(stagingRoot, CODEX_REPORT_PATH);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.moves.push({
      sourcePath: ".legion/project/project.json",
      targetPath: ".legion/legacy-protocol/project/project.json",
      classification: "move-to-legacy-protocol",
      rationale: "tampered report move"
    });
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    const applied = await applyCodexLegionMigration({
      repositoryRoot,
      stagingRoot,
      backupRoot,
      appliedAt: FIXED_TIME,
      reviewAccepted: true
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "invalid");
    assert.ok(applied.diagnostics.some((diagnostic) => diagnostic.code === "invalid_migration_moves"));
    assert.equal(await readFile(projectFile, "utf8"), "{\"project\":true}\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
