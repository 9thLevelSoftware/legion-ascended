import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_CONSTITUTION,
  PROJECT_MANIFEST_PATH,
  initProject,
  loadProject,
  projectManifestSchema,
  updateConstitution,
  validateProject
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-project-init-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(root, args) {
  return execFileAsync("git", args, { cwd: root });
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function initInput(repositoryRoot, overrides = {}) {
  return {
    repositoryRoot,
    slug: "legion-next",
    name: "Legion Next",
    decisionOwners: [OWNER],
    createdAt: FIXED_TIME,
    ...overrides
  };
}

test("P02-T02 initializes a committed project boundary idempotently and keeps var ignored", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await git(repositoryRoot, ["init"]);

    const first = await initProject(initInput(repositoryRoot));
    assert.equal(first.ok, true);
    assert.equal(first.status, "initialized");
    assert.equal(first.project.id, "prj_legion-next");
    assert.equal(first.manifestPath, PROJECT_MANIFEST_PATH);

    const projectJsonPath = path.join(repositoryRoot, ".legion", "project", "project.json");
    const constitutionPath = path.join(repositoryRoot, ".legion", "project", "constitution.md");
    const firstManifest = await readFile(projectJsonPath, "utf8");
    const firstConstitution = await readFile(constitutionPath, "utf8");

    assert.match(firstConstitution, /^# Legion Project Constitution/m);
    assert.match(firstConstitution, /^## Authority Order/m);
    assert.match(firstConstitution, /^## Security/m);
    assert.match(firstConstitution, /^## Human Approval/m);

    const second = await initProject(initInput(repositoryRoot));
    assert.equal(second.ok, true);
    assert.equal(second.status, "already_initialized");
    assert.equal(await readFile(projectJsonPath, "utf8"), firstManifest);
    assert.equal(await readFile(constitutionPath, "utf8"), firstConstitution);

    await git(repositoryRoot, ["check-ignore", ".legion/var/runtime.sqlite"]);
    await assert.rejects(git(repositoryRoot, ["check-ignore", ".legion/project/project.json"]));
  });
});

test("P02-T02 dry-run init reports planned writes and legacy .legion collisions preserve bytes", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const dryRun = await initProject(initInput(repositoryRoot, { dryRun: true }));

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.status, "dry_run");
    assert.deepEqual(dryRun.wouldWrite, [
      ".gitignore",
      ".legion/project/constitution.md",
      ".legion/project/project.json",
      ".legion/var/"
    ]);
    assert.equal(await exists(path.join(repositoryRoot, ".legion")), false);

    await mkdir(path.join(repositoryRoot, ".legion"), { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", "SKILL.md"), "legacy codex protocol\n", "utf8");

    const collided = await initProject(initInput(repositoryRoot));
    assert.equal(collided.ok, false);
    assert.equal(collided.status, "migration_required");
    assert.equal(collided.diagnostics[0].code, "migration_required");
    assert.equal(await readFile(path.join(repositoryRoot, ".legion", "SKILL.md"), "utf8"), "legacy codex protocol\n");
  });
});

test("P02-T02 manifest schema reports malformed input without throwing", () => {
  for (const input of [
    {
      schemaVersion: "0.1.0",
      kind: "project-manifest",
      revision: 1
    },
    {
      schemaVersion: "0.1.0",
      kind: "project-manifest",
      revision: 1,
      project: null,
      artifactRevisions: null
    },
    {
      schemaVersion: "0.1.0",
      kind: "project-manifest",
      revision: 1,
      project: {
        policy: {}
      },
      artifactRevisions: {
        constitution: {}
      }
    }
  ]) {
    let result;
    assert.doesNotThrow(() => {
      result = projectManifestSchema.safeParse(input);
    });
    assert.equal(result.success, false);
  }
});

test("P02-T02 init ignores hidden .legion metadata without hiding visible legacy collisions", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await mkdir(path.join(repositoryRoot, ".legion"), { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", ".DS_Store"), "finder metadata\n", "utf8");

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
    assert.equal(initialized.status, "initialized");
  });

  await withTempRepository(async (repositoryRoot) => {
    await mkdir(path.join(repositoryRoot, ".legion"), { recursive: true });
    await writeFile(path.join(repositoryRoot, ".legion", ".DS_Store"), "finder metadata\n", "utf8");
    await writeFile(path.join(repositoryRoot, ".legion", "SKILL.md"), "legacy codex protocol\n", "utf8");

    const collided = await initProject(initInput(repositoryRoot));
    assert.equal(collided.ok, false);
    assert.equal(collided.status, "migration_required");
    assert.equal(collided.diagnostics[0].code, "migration_required");
  });
});

test("P02-T02 accepts common .legion var ignore patterns without appending duplicates", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await writeFile(path.join(repositoryRoot, ".gitignore"), "/.legion/var\n", "utf8");

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);
    assert.equal(initialized.status, "initialized");
    assert.equal(await readFile(path.join(repositoryRoot, ".gitignore"), "utf8"), "/.legion/var\n");

    const validation = await validateProject({ repositoryRoot });
    assert.equal(validation.ok, true);
  });
});

test("P02-T02 validates constitution integrity and updates it with manifest revision checks", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await git(repositoryRoot, ["init"]);

    const initialized = await initProject(initInput(repositoryRoot));
    assert.equal(initialized.ok, true);

    const loaded = await loadProject({ repositoryRoot });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.manifest.revision, 1);

    const badUpdate = await updateConstitution({
      repositoryRoot,
      expectedManifestRevision: loaded.manifest.revision,
      updatedAt: "2026-06-20T00:01:00.000Z",
      content: "# Broken Constitution\n"
    });
    assert.equal(badUpdate.ok, false);
    assert.equal(badUpdate.diagnostics.some((diagnostic) => diagnostic.code === "constitution_missing_section"), true);

    const validUpdate = await updateConstitution({
      repositoryRoot,
      expectedManifestRevision: loaded.manifest.revision,
      updatedAt: "2026-06-20T00:02:00.000Z",
      content: `${DEFAULT_PROJECT_CONSTITUTION}\n## Project Notes\n\nLegion Next P02-T02 fixture note.\n`
    });
    assert.equal(validUpdate.ok, true);
    assert.equal(validUpdate.manifest.revision, 2);
    assert.equal(validUpdate.constitutionRevision.revision, 2);

    const staleUpdate = await updateConstitution({
      repositoryRoot,
      expectedManifestRevision: loaded.manifest.revision,
      updatedAt: "2026-06-20T00:03:00.000Z",
      content: `${DEFAULT_PROJECT_CONSTITUTION}\n## Project Notes\n\nStale update.\n`
    });
    assert.equal(staleUpdate.ok, false);
    assert.equal(staleUpdate.diagnostics[0].code, "stale_manifest_revision");

    await writeFile(path.join(repositoryRoot, ".legion", "project", "constitution.md"), "# Broken Constitution\n", "utf8");
    const validation = await validateProject({ repositoryRoot });
    assert.equal(validation.ok, false);
    assert.equal(validation.diagnostics.some((diagnostic) => diagnostic.code === "constitution_hash_mismatch"), true);
    assert.equal(validation.diagnostics.some((diagnostic) => diagnostic.code === "constitution_missing_section"), true);
  });
});
