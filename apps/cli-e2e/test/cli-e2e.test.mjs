import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { formatEntityId } from "@legion/protocol";
import { createCurrentSpec } from "@legion/artifacts";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "index.js");
const FIXED_TIME = "2026-06-21T12:00:00.000Z";
const LATER_TIME = "2026-06-21T13:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };
const PROJECT_ID = "prj_cli-e2e";
const BASE_GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), "legion-cli-e2e-"));
}

async function runCli(args, options = {}) {
  try {
    const result = await execFile(process.execPath, [CLI, "next", "--json", "--no-color", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      ...options
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: JSON.parse(result.stdout)
    };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      json: error.stdout ? JSON.parse(error.stdout) : undefined
    };
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
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

    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
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

async function copyFixture(kind, name, destination) {
  await cp(path.join(ROOT, "tests", "fixtures", "migration", kind, name), destination, { recursive: true });
}

function initInput(overrides = {}) {
  return {
    slug: "cli-e2e",
    name: "CLI E2E",
    description: "Project created through the v9 CLI E2E surface.",
    decisionOwners: [OWNER],
    createdAt: FIXED_TIME,
    ...overrides
  };
}

function requirement(slug, overrides = {}) {
  const id = formatEntityId("requirement", slug);
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "requirement",
    id,
    projectId: PROJECT_ID,
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: `${slug} behavior is deployed and reviewable.`,
    acceptance: {
      language: `${slug} acceptance is deterministic.`,
      criteria: [`${slug} criterion`],
      oracleRefs: []
    },
    traceRefs: [
      {
        path: `.legion/project/specs/${id}.md`,
        anchor: id,
        relation: "defines",
        entity: { kind: "requirement", id }
      }
    ],
    supersedes: [],
    ...overrides
  };
}

function specDocument(primaryRequirementId, overrides = {}) {
  const capabilityId = primaryRequirementId.replace(/^req_/, "");
  return {
    primaryRequirementId,
    capability: {
      id: capabilityId,
      title: `${capabilityId} capability`,
      status: "active"
    },
    requirements: [requirement(capabilityId)],
    sections: {
      purpose: "Defines deployed workflow behavior for the CLI E2E capability.",
      behaviors: "The workflow tool applies accepted behavior consistently.",
      constraints: "State ownership remains under .legion/project for committed intent.",
      scenarios: "A maintained project validates the current capability specification.",
      interfaces: "Artifact services expose typed operations for this capability.",
      compatibility: "Legacy migration remains read-only until explicit import.",
      failureModes: "Invalid, duplicate, stale, or unresolved requirements block acceptance.",
      traceIds: [primaryRequirementId]
    },
    ...overrides
  };
}

function acceptedDecision() {
  return {
    id: "dec_cli-e2e",
    status: "accepted",
    title: "Keep CLI routing thin",
    context: "The CLI should delegate artifact mutation to service packages.",
    alternatives: [
      {
        id: "thin-cli",
        title: "Thin CLI",
        summary: "Route parsed inputs into artifact services.",
        selected: true
      },
      {
        id: "duplicate-cli-logic",
        title: "Duplicate CLI logic",
        summary: "Reimplement mutation behavior in command handlers.",
        selected: false
      }
    ],
    rationale: "Service-owned behavior keeps validation and archive semantics consistent.",
    supersedes: [],
    approver: OWNER,
    decidedAt: LATER_TIME
  };
}

async function createBaselineSpec(repositoryRoot) {
  const requirementId = formatEntityId("requirement", "cli-workflow");
  const created = await createCurrentSpec({
    repositoryRoot,
    document: specDocument(requirementId)
  });
  assert.equal(created.ok, true);
  return created;
}

function changeInput(repositoryRoot, currentSpec) {
  const requirementId = currentSpec.document.primaryRequirementId;
  const proposedRequirement = {
    ...currentSpec.document.requirements[0],
    statement: "cli-workflow behavior is proposed through the v9 change command."
  };

  return {
    changeId: "chg_cli-e2e",
    projectId: PROJECT_ID,
    title: "Exercise CLI change flow",
    summary: "Create, validate, and diff a change bundle through the CLI.",
    owners: [OWNER],
    baseGitSha: BASE_GIT_SHA,
    risk: { tier: "R2", reasons: ["CLI-driven change bundle"] },
    createdAt: FIXED_TIME,
    currentSpecs: [{ requirementId, expectedRevision: currentSpec.document.revision }],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId,
        proposedRequirement,
        sections: {
          ...currentSpec.document.sections,
          purpose: "Defines proposed workflow behavior before archive."
        },
        rationale: "The proposed behavior should be reviewable before becoming current truth."
      }
    ],
    design: {
      title: "CLI change bundle",
      body: "The CLI delegates change bundle creation to artifact services."
    },
    decisions: [acceptedDecision()],
    repositoryRoot
  };
}

test("P02-T10 CLI E2E script builds protocol before packages that resolve protocol dist", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "apps", "cli-e2e", "package.json"), "utf8"));
  const script = packageJson.scripts.test;
  assert.equal(typeof script, "string");
  assert.match(script, /pnpm --filter @legion\/protocol build/);
  assert.ok(
    script.indexOf("@legion/protocol build") < script.indexOf("@legion/artifacts build"),
    script
  );
});

test("P02-T10 valueless global flags remain flags before positional commands", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(inputPath, initInput());

    assert.equal((await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", inputPath])).exitCode, 0);

    const status = await runCli(["project", "status"], { cwd: repositoryRoot });
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.project.id, PROJECT_ID);
    assert.equal(status.json.currentSpecCount, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 valueless command flags remain flags before positional arguments", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const initPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(initPath, initInput());
    assert.equal((await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", initPath])).exitCode, 0);

    const currentSpec = await createBaselineSpec(repositoryRoot);
    const changePath = path.join(workspace, "change.json");
    await writeJson(changePath, changeInput(repositoryRoot, currentSpec));
    assert.equal((await runCli(["--repository-root", repositoryRoot, "change", "create", "--input", changePath])).exitCode, 0);

    const dryRunArchive = await runCli([
      "--repository-root",
      repositoryRoot,
      "change",
      "archive",
      "--dry-run",
      "chg_cli-e2e",
      "--output-branch",
      "codex/cli-e2e-archive"
    ]);
    assert.notEqual(dryRunArchive.exitCode, 0);
    assert.equal(dryRunArchive.json.ok, false);
    assert.equal(dryRunArchive.json.status, "invalid");
    assert.ok(
      dryRunArchive.json.diagnostics.some((diagnostic) => diagnostic.code === "change_not_accepted"),
      JSON.stringify(dryRunArchive.json, null, 2)
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 command subcommands honor help flags without requiring inputs", async () => {
  const projectInit = await runCli(["--repository-root", ROOT, "project", "init", "--help"]);
  assert.equal(projectInit.exitCode, 0, projectInit.stderr);
  assert.equal(projectInit.json.status, "help");
  assert.match(projectInit.json.help, /legion next project/);

  const changeCreate = await runCli(["--repository-root", ROOT, "change", "create", "--help"]);
  assert.equal(changeCreate.exitCode, 0, changeCreate.stderr);
  assert.equal(changeCreate.json.status, "help");
  assert.match(changeCreate.json.help, /legion next change/);
});

test("P02-T10 JSON input boundary failures return usage diagnostics", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const malformedPath = path.join(workspace, "malformed.json");
    const scalarPath = path.join(workspace, "scalar.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeText(malformedPath, "{not json");
    await writeText(scalarPath, "\"not an object\"\n");

    const projectMalformed = await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", malformedPath]);
    assert.notEqual(projectMalformed.exitCode, 0);
    assert.equal(projectMalformed.json.status, "usage_error");
    assert.equal(projectMalformed.json.diagnostics[0].code, "usage_error");
    assert.match(projectMalformed.json.diagnostics[0].message, /Failed to read or parse JSON input/);

    const changeMissing = await runCli(["--repository-root", repositoryRoot, "change", "create", "--input", path.join(workspace, "missing.json")]);
    assert.notEqual(changeMissing.exitCode, 0);
    assert.equal(changeMissing.json.status, "usage_error");
    assert.equal(changeMissing.json.diagnostics[0].code, "usage_error");
    assert.match(changeMissing.json.diagnostics[0].message, /Failed to read or parse JSON input/);

    const planningScalar = await runCli([
      "--repository-root",
      repositoryRoot,
      "migrate",
      "--from-planning",
      "--dry-run",
      "--planning-root",
      path.join(workspace, ".planning"),
      "--staging-root",
      path.join(workspace, "stage"),
      "--run-id",
      "bad-json",
      "--project",
      scalarPath
    ]);
    assert.notEqual(planningScalar.exitCode, 0);
    assert.equal(planningScalar.json.status, "usage_error");
    assert.equal(planningScalar.json.diagnostics[0].code, "usage_error");
    assert.match(planningScalar.json.diagnostics[0].message, /JSON input must be an object/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 project commands initialize, validate, and report status as JSON without prompts", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(inputPath, initInput());

    const initialized = await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", inputPath]);
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    assert.equal(initialized.json.ok, true);
    assert.equal(initialized.json.status, "initialized");
    assert.equal(initialized.json.project.id, PROJECT_ID);
    assert.equal(initialized.stderr, "");

    const validation = await runCli(["--repository-root", repositoryRoot, "project", "validate"]);
    assert.equal(validation.exitCode, 0, validation.stderr);
    assert.equal(validation.json.ok, true);
    assert.deepEqual(validation.json.diagnostics, []);

    const status = await runCli(["--repository-root", repositoryRoot, "project", "status"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.project.id, PROJECT_ID);
    assert.equal(status.json.currentSpecCount, 0);
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "project", "project.json")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 change commands create, validate, diff, and refuse unaccepted archive", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const initPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(initPath, initInput());
    assert.equal((await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", initPath])).exitCode, 0);

    const currentSpec = await createBaselineSpec(repositoryRoot);
    const changePath = path.join(workspace, "change.json");
    await writeJson(changePath, changeInput(repositoryRoot, currentSpec));

    const created = await runCli(["--repository-root", repositoryRoot, "change", "create", "--input", changePath]);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.status, "created");
    assert.equal(created.json.change.id, "chg_cli-e2e");

    const validation = await runCli(["--repository-root", repositoryRoot, "change", "validate", "chg_cli-e2e"]);
    assert.equal(validation.exitCode, 0, validation.stderr);
    assert.equal(validation.json.ok, true);

    const diff = await runCli(["--repository-root", repositoryRoot, "change", "diff", "chg_cli-e2e"]);
    assert.equal(diff.exitCode, 0, diff.stderr);
    assert.deepEqual(diff.json.diff, {
      added: [],
      modified: [currentSpec.document.primaryRequirementId],
      removed: []
    });

    const archive = await runCli([
      "--repository-root",
      repositoryRoot,
      "change",
      "archive",
      "chg_cli-e2e",
      "--archived-by",
      OWNER.id,
      "--archived-at",
      LATER_TIME,
      "--output-branch",
      "codex/cli-e2e-archive"
    ]);
    assert.notEqual(archive.exitCode, 0);
    assert.equal(archive.json.ok, false);
    assert.equal(archive.json.status, "invalid");
    assert.ok(
      archive.json.diagnostics.some((diagnostic) => diagnostic.code === "change_not_accepted"),
      JSON.stringify(archive.json, null, 2)
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 migrate planning commands dry-run, apply, and rollback without mutating source", async () => {
  const workspace = await tempRoot();
  try {
    const sourceRoot = path.join(workspace, "source");
    const targetRoot = path.join(workspace, "target");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    const projectInputPath = path.join(workspace, "project.json");
    await copyFixture("planning", "clean", sourceRoot);
    await writeJson(projectInputPath, {
      slug: "planning-cli-e2e",
      name: "Planning CLI E2E",
      decisionOwners: [OWNER],
      createdAt: FIXED_TIME
    });
    const planningBefore = await hashDirectory(path.join(sourceRoot, ".planning"));

    const dryRun = await runCli([
      "--repository-root",
      targetRoot,
      "migrate",
      "--from-planning",
      "--dry-run",
      "--planning-root",
      path.join(sourceRoot, ".planning"),
      "--staging-root",
      stagingRoot,
      "--run-id",
      "cli-planning-dry-run",
      "--project",
      projectInputPath
    ]);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal(dryRun.json.ok, true);
    assert.equal(dryRun.json.status, "dry_run");
    assert.equal(await hashDirectory(path.join(sourceRoot, ".planning")), planningBefore);

    const applied = await runCli([
      "--repository-root",
      targetRoot,
      "migrate",
      "--from-planning",
      "--apply",
      "--staging-root",
      stagingRoot,
      "--backup-root",
      backupRoot,
      "--applied-at",
      FIXED_TIME,
      "--review-accepted"
    ]);
    assert.equal(applied.exitCode, 0, applied.stderr);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.status, "applied");
    assert.equal(await exists(path.join(targetRoot, ".legion", "project", "project.json")), true);

    const rolledBack = await runCli([
      "--repository-root",
      targetRoot,
      "migrate",
      "--from-planning",
      "--rollback",
      "--backup-manifest",
      applied.json.backup.manifestPath
    ]);
    assert.equal(rolledBack.exitCode, 0, rolledBack.stderr);
    assert.equal(rolledBack.json.ok, true);
    assert.equal(rolledBack.json.status, "rolled_back");
    assert.equal(await hashDirectory(path.join(sourceRoot, ".planning")), planningBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P02-T10 migrate Codex Legion commands dry-run, apply, and rollback legacy protocol data", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const stagingRoot = path.join(workspace, "stage");
    const backupRoot = path.join(workspace, "backups");
    await copyFixture("codex", "local-codex", repositoryRoot);
    const legionBefore = await hashDirectory(path.join(repositoryRoot, ".legion"));

    const dryRun = await runCli([
      "--repository-root",
      repositoryRoot,
      "migrate",
      "--from-codex-legion",
      "--dry-run",
      "--staging-root",
      stagingRoot,
      "--run-id",
      "cli-codex-dry-run",
      "--created-at",
      FIXED_TIME
    ]);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal(dryRun.json.ok, true);
    assert.equal(dryRun.json.status, "dry_run");
    assert.ok(dryRun.json.report.moves.some((move) => move.sourcePath === ".legion/commands/legion/start.md"));
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    const applied = await runCli([
      "--repository-root",
      repositoryRoot,
      "migrate",
      "--from-codex-legion",
      "--apply",
      "--staging-root",
      stagingRoot,
      "--backup-root",
      backupRoot,
      "--applied-at",
      FIXED_TIME,
      "--review-accepted"
    ]);
    assert.equal(applied.exitCode, 0, applied.stderr);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.status, "applied");
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "legacy-protocol", "commands", "legion", "start.md")), true);
    assert.notEqual(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);

    const rolledBack = await runCli([
      "--repository-root",
      repositoryRoot,
      "migrate",
      "--from-codex-legion",
      "--rollback",
      "--backup-manifest",
      applied.json.backup.manifestPath
    ]);
    assert.equal(rolledBack.exitCode, 0, rolledBack.stderr);
    assert.equal(rolledBack.json.ok, true);
    assert.equal(rolledBack.json.status, "rolled_back");
    assert.equal(await hashDirectory(path.join(repositoryRoot, ".legion")), legionBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
