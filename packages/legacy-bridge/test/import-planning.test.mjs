import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
