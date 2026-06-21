import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
