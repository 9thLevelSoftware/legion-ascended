import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function boardDatabasePath(repositoryRoot) {
  return path.join(repositoryRoot, ".legion", "var", "board.sqlite");
}

function taskCreateInput(overrides = {}) {
  return {
    projectId: "prj_cli_board",
    changeId: "chg_cli_board",
    taskId: "tsk_cli_board",
    contractId: "ctr_cli_board",
    contractRevision: 1,
    contractHash: "a".repeat(64),
    initialStatus: "ready",
    initialPriority: 500,
    ...overrides
  };
}

function claimCreateInput(overrides = {}) {
  return {
    taskId: "tsk_cli_board",
    expectedGeneration: 1,
    ownerId: "worker_cli_board",
    leaseDurationMs: 30_000,
    ...overrides
  };
}

function eventAppendInput(overrides = {}) {
  return {
    aggregateKind: "task",
    aggregateId: "tsk_cli_board",
    eventType: "task.transitioned",
    payload: { taskId: "tsk_cli_board" },
    ...overrides
  };
}

function approvalCreateInput(overrides = {}) {
  return {
    taskId: "tsk_cli_board",
    runId: "run_cli_board",
    scope: {
      effectClass: "S2",
      action: "promote.release",
      targetsJson: JSON.stringify([{ kind: "task", id: "tsk_cli_board" }]),
      justification: "Promoting task tsk_cli_board"
    },
    requestedBy: {
      id: "user_cli_board",
      displayName: "CLI Board User",
      kind: "human"
    },
    ...overrides
  };
}

function seedTaskRun(databasePath, taskId, runId) {
  const database = new DatabaseSync(databasePath);
  try {
    const now = "2026-06-21T12:00:00.000Z";
    database
      .prepare(
        "INSERT INTO board_task_runs (run_id, task_id, generation, attempt, status, manifest_json, started_at, finished_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(runId, taskId, 1, 1, "started", JSON.stringify({ seeded: true }), now, null, now, now);
  } finally {
    database.close();
  }
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
  assert.match(script, /pnpm --filter @legion\/store-sqlite build/);
  assert.ok(
    script.indexOf("@legion/protocol build") < script.indexOf("@legion/artifacts build"),
    script
  );
  assert.ok(
    script.indexOf("@legion/board-store build") < script.indexOf("@legion/store-sqlite build"),
    script
  );
  assert.ok(
    script.indexOf("@legion/store-sqlite build") < script.indexOf("@legion/cli build"),
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

    const verified = await runCli([
      "--repository-root",
      repositoryRoot,
      "migrate",
      "--from-codex-legion",
      "--verify",
      "--staging-root",
      stagingRoot,
      "--run-id",
      "cli-codex-verify",
      "--created-at",
      FIXED_TIME
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.status, "dry_run");
    assert.ok(verified.json.report.moves.some((move) => move.sourcePath === ".legion/commands/legion/start.md"));
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

test("P03-T09 board CLI routes task, claim, event, and approval operations without prompts", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const taskInputPath = path.join(workspace, "task-create.json");
    const claimInputPath = path.join(workspace, "claim-create.json");
    const eventInputPath = path.join(workspace, "event-append.json");
    const approvalInputPath = path.join(workspace, "approval-create.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(taskInputPath, taskCreateInput());
    await writeJson(claimInputPath, claimCreateInput());
    await writeJson(eventInputPath, eventAppendInput());
    await writeJson(approvalInputPath, approvalCreateInput());

    const created = await runCli(["--repository-root", repositoryRoot, "board", "task", "create", "--input", taskInputPath]);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.status, "created");
    assert.equal(created.json.task.taskId, "tsk_cli_board");
    assert.equal(created.json.task.status, "ready");
    assert.equal(await exists(boardDatabasePath(repositoryRoot)), true);

    seedTaskRun(boardDatabasePath(repositoryRoot), created.json.task.taskId, "run_cli_board");

    const claimed = await runCli(["--repository-root", repositoryRoot, "board", "claim", "try", "--input", claimInputPath]);
    assert.equal(claimed.exitCode, 0, claimed.stderr);
    assert.equal(claimed.json.ok, true);
    assert.equal(claimed.json.status, "claimed");
    assert.equal(claimed.json.claim.taskId, "tsk_cli_board");
    assert.equal(claimed.json.claim.ownerId, "worker_cli_board");
    assert.ok(claimed.json.claim.leaseToken.length >= 16);

    const appended = await runCli(["--repository-root", repositoryRoot, "board", "event", "append", "--input", eventInputPath]);
    assert.equal(appended.exitCode, 0, appended.stderr);
    assert.equal(appended.json.ok, true);
    assert.equal(appended.json.status, "appended");
    assert.equal(appended.json.event.aggregateId, "tsk_cli_board");
    assert.equal(appended.json.event.eventType, "task.transitioned");

    const approved = await runCli(["--repository-root", repositoryRoot, "board", "approval", "create", "--input", approvalInputPath]);
    assert.equal(approved.exitCode, 0, approved.stderr);
    assert.equal(approved.json.ok, true);
    assert.equal(approved.json.status, "created");
    assert.equal(approved.json.approval.taskId, "tsk_cli_board");
    assert.equal(approved.json.approval.runId, "run_cli_board");
    assert.equal(approved.json.approval.status, "requested");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P03-T09 board CLI returns usage diagnostics for malformed board input and repository errors", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const nullInputPath = path.join(workspace, "null-input.json");
    const arrayInputPath = path.join(workspace, "array-input.json");
    const invalidTaskPath = path.join(workspace, "invalid-task.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeText(nullInputPath, "null\n");
    await writeText(arrayInputPath, "[]\n");
    await writeJson(invalidTaskPath, { changeId: "chg_cli_board" });

    for (const inputPath of [nullInputPath, arrayInputPath]) {
      const result = await runCli(["--repository-root", repositoryRoot, "board", "task", "get", "--input", inputPath]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.json.status, "usage_error");
      assert.equal(result.json.diagnostics[0].code, "usage_error");
      assert.match(result.json.diagnostics[0].message, /JSON input must be an object/);
    }

    const invalid = await runCli(["--repository-root", repositoryRoot, "board", "task", "create", "--input", invalidTaskPath]);
    assert.equal(invalid.exitCode, 1, invalid.stderr);
    assert.equal(invalid.json.status, "usage_error");
    assert.equal(invalid.json.diagnostics[0].code, "usage_error");
    assert.match(invalid.json.diagnostics[0].message, /taskId|projectId|contract/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function releaseObservationReportSha256(report) {
  return sha256ContentHash(canonicalJson({
    kind: "release-observation:report",
    schemaVersion: "1.0.0",
    changeId: report.changeId,
    mergeQueueHash: report.mergeQueueHash,
    decisionSha256: report.decisionSha256,
    tier: report.tier,
    releaseability: report.releaseability,
    status: report.status,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    observedAt: report.observedAt,
    observedBy: report.observedBy,
    canary: report.canary,
    healthCheck: report.healthCheck,
    regression: report.regression,
    alert: report.alert,
    failureReason: report.failureReason
  }));
}

function releaseObservationReportInput(overrides = {}) {
  const changeId = overrides.changeId ?? "chg_cli_release_observation";
  const mergeQueueHash =
    overrides.mergeQueueHash ?? sha256ContentHash(`release-observation-cli-e2e-${changeId}-mq`);
  const decisionSha256 = overrides.decisionSha256 ?? sha256ContentHash(`release-observation-cli-e2e-${changeId}-decision`);
  const status = overrides.status ?? "promoted";
  const reportDraft = {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    changeId,
    mergeQueueHash,
    decisionSha256,
    tier: overrides.tier ?? "R0",
    releaseability: overrides.releaseability ?? "releaseable",
    status,
    windowStart: "2026-06-22T05:00:00.000Z",
    windowEnd: "2026-06-22T05:30:00.000Z",
    observedAt: "2026-06-22T05:15:00.000Z",
    observedBy: {
      id: "ci-bot",
      type: "ci-bot",
      displayName: "ci-bot"
    },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    failureReason: null,
    ...(overrides.reportOverrides ?? {})
  };
  const reportSha256 = overrides.reportSha256 ?? releaseObservationReportSha256(reportDraft);
  const report = {
    ...reportDraft,
    reportSha256
  };
  return {
    changeId,
    mergeQueueHash,
    reportSha256,
    status,
    report,
    aggregateInput: {
      changeId,
      report,
      reporter: "ci-bot",
      correlationId: "corr-cli-e2e"
    },
    projectionInput: {
      changeId,
      mergeQueueHash
    }
  };
}

test("P10-T02 board CLI routes release-observation aggregate/status/rebuild/verify idempotently", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const aggregateInputPath = path.join(workspace, "release-observation-aggregate.json");
    const projectionInputPath = path.join(workspace, "release-observation-projection.json");
    await mkdir(repositoryRoot, { recursive: true });

    const fixture = releaseObservationReportInput();
    await writeJson(aggregateInputPath, fixture.aggregateInput);
    await writeJson(projectionInputPath, fixture.projectionInput);

    // Aggregate: build a BoardEvent from the report and append.
    const aggregated = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "aggregate",
      "--input",
      aggregateInputPath
    ]);
    assert.equal(aggregated.exitCode, 0, aggregated.stderr);
    assert.equal(aggregated.json.ok, true);
    assert.equal(aggregated.json.status, "appended");
    assert.equal(aggregated.json.changeId, fixture.changeId);
    assert.equal(aggregated.json.mergeQueueHash, fixture.mergeQueueHash);
    assert.equal(aggregated.json.reportSha256, fixture.reportSha256);
    assert.equal(aggregated.json.lastEventType, `release.${fixture.status}`);
    assert.equal(aggregated.json.idempotencyKey, `${fixture.changeId}:${fixture.mergeQueueHash}:${fixture.reportSha256}:release.${fixture.status}`);
    assert.equal(aggregated.json.eventIds.length, 1);
    assert.ok(aggregated.json.eventIds[0].length >= 16);

    // Re-running aggregate must be idempotent — same idempotencyKey, no new event id.
    const replayed = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "aggregate",
      "--input",
      aggregateInputPath
    ]);
    assert.equal(replayed.exitCode, 0, replayed.stderr);
    assert.equal(replayed.json.ok, true);
    assert.equal(replayed.json.eventIds[0], aggregated.json.eventIds[0]);

    // Status: replay returns the projection state without persisting.
    const status = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "status",
      "--input",
      projectionInputPath
    ]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.status, "replayed");
    assert.equal(status.json.lastEventType, `release.${fixture.status}`);
    assert.equal(status.json.state.lastEventType, `release.${fixture.status}`);
    assert.equal(status.json.projection.state?.changeId, fixture.changeId);
    assert.equal(status.json.projection.state?.mergeQueueHash, fixture.mergeQueueHash);

    // Rebuild: persist the projection.
    const rebuilt = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "rebuild",
      "--input",
      projectionInputPath
    ]);
    assert.equal(rebuilt.exitCode, 0, rebuilt.stderr);
    assert.equal(rebuilt.json.ok, true);
    assert.equal(rebuilt.json.status, "rebuilt");
    assert.ok(typeof rebuilt.json.projection.rebuiltThroughGlobalSequence === "number");
    assert.ok(rebuilt.json.projection.eventCount >= 1);
    assert.equal(rebuilt.json.state.lastEventType, `release.${fixture.status}`);

    // Verify: persisted projection must match a fresh replay.
    const verified = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "verify",
      "--input",
      projectionInputPath
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.status, "verified");
    assert.equal(verified.json.projection.stateHash, rebuilt.json.projection.stateHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P10-T02 board CLI release-observation aggregate surfaces validation failures", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const badInputPath = path.join(workspace, "release-observation-bad.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(badInputPath, {
      changeId: "chg_cli_release_observation_bad",
      report: {
        schemaVersion: "1.0.0",
        kind: "release-observation",
        changeId: "chg_cli_release_observation_mismatch",
        mergeQueueHash: sha256ContentHash("release-observation-cli-e2e-bad-mq"),
        decisionSha256: sha256ContentHash("release-observation-cli-e2e-bad-decision"),
        tier: "R0",
        releaseability: "releaseable",
        status: "promoted",
        windowStart: "2026-06-22T05:00:00.000Z",
        windowEnd: "2026-06-22T05:30:00.000Z",
        observedAt: "2026-06-22T05:15:00.000Z",
        observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
        canary: null,
        healthCheck: null,
        regression: null,
        alert: null,
        reportSha256: sha256ContentHash("release-observation-cli-e2e-bad-report"),
        failureReason: null
      }
    });

    const failure = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "aggregate",
      "--input",
      badInputPath
    ]);
    assert.equal(failure.exitCode, 1, failure.stderr);
    assert.equal(failure.json.ok, false);
    assert.equal(failure.json.status, "failed");
    assert.equal(failure.json.code, "aggregate_failed");
    assert.ok(failure.json.issues.some((issue) => issue.code === "change_id_mismatch"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P10-T02 board CLI release-observation verify fails closed on missing projection", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const projectionInputPath = path.join(workspace, "release-observation-empty.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(projectionInputPath, {
      changeId: "chg_cli_release_observation_missing",
      mergeQueueHash: sha256ContentHash("release-observation-cli-e2e-empty")
    });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "release-observation",
      "verify",
      "--input",
      projectionInputPath
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, "verify_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// =====================================================================
// P11-T01 — Dashboard CLI tests.
// =====================================================================

function dashboardAppendInput(overrides = {}) {
  return {
    aggregateKind: "task",
    aggregateId: `prj_cli_dashboard:chg_cli_dashboard:${overrides.taskId ?? "tsk_cli_dashboard"}`,
    eventType: overrides.eventType ?? "task.created",
    eventVersion: "0.1.0",
    payload: {
      projectId: "prj_cli_dashboard",
      changeId: "chg_cli_dashboard",
      taskId: overrides.taskId ?? "tsk_cli_dashboard",
      contractId: "ctr_cli_dashboard",
      contractRevision: 1,
      contractHash: "a".repeat(64),
      fromStatus: overrides.fromStatus ?? "queued",
      toStatus: overrides.toStatus,
      priority: overrides.priority ?? 500
    },
    occurredAt: overrides.occurredAt ?? "2026-06-22T05:00:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: overrides.idempotencyKey ?? `cli-e2e-dashboard-${overrides.taskId ?? "tsk_cli_dashboard"}-${overrides.eventType ?? "task.created"}`
  };
}

test("P11-T01 board CLI dashboard status/rebuild/verify round-trip a task event log", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const dashboardInputPath = path.join(workspace, "dashboard-input.json");
    await mkdir(repositoryRoot, { recursive: true });

    // Seed two task.* events so the dashboard projection has
    // a non-null state to surface.
    await writeJson(path.join(workspace, "dashboard-event-1.json"), dashboardAppendInput({
      taskId: "tsk_cli_dashboard_1",
      fromStatus: "queued"
    }));
    const append1 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "dashboard-event-1.json")
    ]);
    assert.equal(append1.exitCode, 0, append1.stderr);

    await writeJson(path.join(workspace, "dashboard-event-2.json"), dashboardAppendInput({
      taskId: "tsk_cli_dashboard_2",
      eventType: "task.created",
      fromStatus: "queued"
    }));
    const append2 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "dashboard-event-2.json")
    ]);
    assert.equal(append2.exitCode, 0, append2.stderr);

    await writeJson(dashboardInputPath, { projectId: "prj_cli_dashboard" });

    // status: replay without persisting.
    const status = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "dashboard",
      "status",
      "--input",
      dashboardInputPath
    ]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.status, "replayed");
    assert.equal(status.json.projectId, "prj_cli_dashboard");
    assert.equal(status.json.projectionKey, "dashboard:prj_cli_dashboard");
    assert.ok(status.json.state !== null);
    assert.equal(status.json.state.taskStatusCounts.queued, 2);
    assert.equal(status.json.state.aggregateKindCounts.task, 2);

    // rebuild: persist the projection.
    const rebuilt = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "dashboard",
      "rebuild",
      "--input",
      dashboardInputPath
    ]);
    assert.equal(rebuilt.exitCode, 0, rebuilt.stderr);
    assert.equal(rebuilt.json.ok, true);
    assert.equal(rebuilt.json.status, "rebuilt");
    assert.equal(rebuilt.json.state.taskStatusCounts.queued, 2);
    assert.ok(typeof rebuilt.json.projection.stateHash === "string");

    // verify: persisted projection matches the fresh replay.
    const verified = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "dashboard",
      "verify",
      "--input",
      dashboardInputPath
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.status, "verified");
    assert.equal(
      verified.json.projection.stateHash,
      rebuilt.json.projection.stateHash
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P11-T01 board CLI dashboard verify fails closed on missing projection", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "dashboard-empty.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(inputPath, { projectId: "prj_cli_dashboard_missing" });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "dashboard",
      "verify",
      "--input",
      inputPath
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, "verify_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// =====================================================================
// P11-T01 — Approval-gate CLI tests.
// =====================================================================

function approvalGateChangeAggregatedInput(overrides = {}) {
  const changeId = overrides.changeId ?? "chg_cli_approval_gate";
  const mergeQueueHash = overrides.mergeQueueHash ?? sha256ContentHash(`cli-e2e-gate-${changeId}-mq`);
  const decisionSha256 = overrides.decisionSha256 ?? sha256ContentHash(`cli-e2e-gate-${changeId}-decision`);
  const aggregatorHash = overrides.aggregatorHash ?? sha256ContentHash(`cli-e2e-gate-${changeId}-aggregator`);
  return {
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    eventType: "change.aggregated",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "1.0.0",
      kind: "whole_change",
      projectId: "prj_cli_approval_gate",
      changeId,
      mergeQueueHash,
      decisionSha256,
      aggregatorHash,
      status: overrides.status ?? "accepted",
      outcome: overrides.outcome ?? "integrated",
      reason: "cli-e2e acceptance",
      acceptedEntries: [1, 2, 3],
      rejectedEntries: [],
      escalatedEntries: [],
      conflictEntries: [],
      finalHeadRef: "abc123",
      acceptedAt: "2026-06-22T05:10:00.000Z",
      acceptedBy: "ci-bot",
      workerContextHashes: []
    },
    occurredAt: "2026-06-22T05:10:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: `${changeId}:${mergeQueueHash}:change.aggregated:cli-e2e`
  };
}

function approvalGateReleasePromotedInput(overrides = {}) {
  const changeId = overrides.changeId ?? "chg_cli_approval_gate";
  const mergeQueueHash = overrides.mergeQueueHash ?? sha256ContentHash(`cli-e2e-gate-${changeId}-mq`);
  const reportSha256 = overrides.reportSha256 ?? sha256ContentHash(`cli-e2e-gate-${changeId}-report`);
  return {
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    eventType: "release.promoted",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "1.0.0",
      kind: "release-observation",
      projectId: "prj_cli_approval_gate",
      changeId,
      mergeQueueHash,
      decisionSha256: sha256ContentHash(`cli-e2e-gate-${changeId}-decision`),
      reportSha256,
      status: "promoted",
      tier: "R0",
      releaseability: "releaseable",
      observedAt: "2026-06-22T05:30:00.000Z",
      observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
      canary: null,
      healthCheck: null,
      regression: null,
      alert: null,
      reason: "cli-e2e promotion",
      report: {
        schemaVersion: "1.0.0",
        kind: "release-observation",
        projectId: "prj_cli_approval_gate",
        changeId,
        mergeQueueHash,
        decisionSha256: sha256ContentHash(`cli-e2e-gate-${changeId}-decision`),
        tier: "R0",
        releaseability: "releaseable",
        status: "promoted",
        windowStart: "2026-06-22T05:00:00.000Z",
        windowEnd: "2026-06-22T05:30:00.000Z",
        observedAt: "2026-06-22T05:30:00.000Z",
        observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
        canary: null,
        healthCheck: null,
        regression: null,
        alert: null,
        reportSha256,
        failureReason: null
      },
      failureReason: null
    },
    occurredAt: "2026-06-22T05:30:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: `${changeId}:${mergeQueueHash}:${reportSha256}:release.promoted`
  };
}

test("P11-T01 board CLI approval-gate status/rebuild/verify surface an approved verdict", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });

    // Seed whole-change accepted + release promoted events
    // for the (prj_cli_approval_gate, chg_cli_approval_gate) pair.
    await writeJson(
      path.join(workspace, "gate-event-1.json"),
      approvalGateChangeAggregatedInput()
    );
    await writeJson(
      path.join(workspace, "gate-event-2.json"),
      approvalGateReleasePromotedInput()
    );

    const append1 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "gate-event-1.json")
    ]);
    assert.equal(append1.exitCode, 0, append1.stderr);

    const append2 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "gate-event-2.json")
    ]);
    assert.equal(append2.exitCode, 0, append2.stderr);

    const inputPath = path.join(workspace, "approval-gate-input.json");
    await writeJson(inputPath, {
      projectId: "prj_cli_approval_gate",
      changeId: "chg_cli_approval_gate"
    });

    // status
    const status = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "approval-gate",
      "status",
      "--input",
      inputPath
    ]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.status, "replayed");
    assert.equal(status.json.state.verdict, "approved");
    assert.equal(status.json.state.wholeChangeStatus, "accepted");
    assert.equal(status.json.state.releaseObservationStatus, "promoted");

    // rebuild
    const rebuilt = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "approval-gate",
      "rebuild",
      "--input",
      inputPath
    ]);
    assert.equal(rebuilt.exitCode, 0, rebuilt.stderr);
    assert.equal(rebuilt.json.ok, true);
    assert.equal(rebuilt.json.status, "rebuilt");
    assert.equal(rebuilt.json.state.verdict, "approved");

    // verify
    const verified = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "approval-gate",
      "verify",
      "--input",
      inputPath
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.status, "verified");
    assert.equal(
      verified.json.projection.stateHash,
      rebuilt.json.projection.stateHash
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P11-T01 board CLI approval-gate status surfaces pending on no events", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "approval-gate-empty.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(inputPath, {
      projectId: "prj_cli_approval_gate_empty",
      changeId: "chg_cli_approval_gate_empty"
    });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "approval-gate",
      "status",
      "--input",
      inputPath
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "replayed");
    assert.equal(result.json.state, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// =====================================================================
// P11-T02 — Portfolio CLI tests.
// =====================================================================

function portfolioTaskCreatedInput(overrides = {}) {
  return {
    aggregateKind: "task",
    aggregateId: `prj_cli_portfolio:chg_cli_portfolio:${overrides.taskId ?? "tsk_cli_portfolio"}`,
    eventType: "task.created",
    eventVersion: "0.1.0",
    payload: {
      projectId: "prj_cli_portfolio",
      changeId: "chg_cli_portfolio",
      taskId: overrides.taskId ?? "tsk_cli_portfolio",
      contractId: "ctr_cli_portfolio",
      contractRevision: 1,
      contractHash: "a".repeat(64),
      fromStatus: overrides.fromStatus ?? "queued",
      toStatus: overrides.toStatus,
      priority: overrides.priority ?? 500
    },
    occurredAt: overrides.occurredAt ?? "2026-06-22T05:00:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: overrides.idempotencyKey ?? `cli-e2e-portfolio-${overrides.taskId ?? "tsk_cli_portfolio"}-${overrides.eventType ?? "task.created"}`
  };
}

function portfolioTaskLinkedInput(overrides = {}) {
  return {
    aggregateKind: "task_link",
    aggregateId: `prj_cli_portfolio:chg_cli_portfolio:${overrides.taskId ?? "tsk_cli_portfolio_a"}:${overrides.dependsOnTaskId ?? "tsk_cli_portfolio_b"}`,
    eventType: "task.linked",
    eventVersion: "0.1.0",
    payload: {
      projectId: "prj_cli_portfolio",
      changeId: "chg_cli_portfolio",
      taskId: overrides.taskId ?? "tsk_cli_portfolio_a",
      contractId: "ctr_cli_portfolio",
      contractRevision: 1,
      contractHash: "a".repeat(64),
      dependsOnTaskId: overrides.dependsOnTaskId ?? "tsk_cli_portfolio_b",
      toProjectId: overrides.toProjectId ?? "prj_cli_portfolio_b",
      relation: overrides.relation ?? "depends_on"
    },
    occurredAt: overrides.occurredAt ?? "2026-06-22T05:01:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: overrides.idempotencyKey ?? `cli-e2e-portfolio-${overrides.taskId ?? "tsk_cli_portfolio_a"}-${overrides.eventType ?? "task.linked"}`
  };
}

function portfolioProjectBTaskCreatedInput(overrides = {}) {
  return {
    aggregateKind: "task",
    aggregateId: `prj_cli_portfolio_b:chg_cli_portfolio_b:${overrides.taskId ?? "tsk_cli_portfolio_b"}`,
    eventType: "task.created",
    eventVersion: "0.1.0",
    payload: {
      projectId: "prj_cli_portfolio_b",
      changeId: "chg_cli_portfolio_b",
      taskId: overrides.taskId ?? "tsk_cli_portfolio_b",
      contractId: "ctr_cli_portfolio_b",
      contractRevision: 1,
      contractHash: "b".repeat(64),
      fromStatus: "queued",
      priority: 200
    },
    occurredAt: "2026-06-22T05:02:00.000Z",
    correlationId: null,
    causationId: null,
    idempotencyKey: `cli-e2e-portfolio-${overrides.taskId ?? "tsk_cli_portfolio_b"}-project-b-task.created`
  };
}

test("P11-T02 board CLI portfolio status/rebuild/verify round-trip a multi-project event log", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const portfolioInputPath = path.join(workspace, "portfolio-input.json");
    await mkdir(repositoryRoot, { recursive: true });

    // Seed two project task events plus a cross-project link.
    await writeJson(
      path.join(workspace, "portfolio-event-1.json"),
      portfolioTaskCreatedInput({ taskId: "tsk_cli_portfolio_a_1", priority: 800 })
    );
    const append1 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "portfolio-event-1.json")
    ]);
    assert.equal(append1.exitCode, 0, append1.stderr);

    await writeJson(
      path.join(workspace, "portfolio-event-2.json"),
      portfolioProjectBTaskCreatedInput({ taskId: "tsk_cli_portfolio_b_1" })
    );
    const append2 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "portfolio-event-2.json")
    ]);
    assert.equal(append2.exitCode, 0, append2.stderr);

    await writeJson(
      path.join(workspace, "portfolio-event-3.json"),
      portfolioTaskLinkedInput({ taskId: "tsk_cli_portfolio_a_1" })
    );
    const append3 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "portfolio-event-3.json")
    ]);
    assert.equal(append3.exitCode, 0, append3.stderr);

    await writeJson(portfolioInputPath, { tenantId: "tnt_cli_portfolio" });

    // status
    const status = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "status",
      "--input",
      portfolioInputPath
    ]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.status, "replayed");
    assert.equal(status.json.tenantId, "tnt_cli_portfolio");
    assert.equal(status.json.projectionKey, "portfolio:tnt_cli_portfolio");
    assert.equal(status.json.eventCount, 3);
    assert.ok(status.json.state !== null);
    assert.ok(status.json.state.projectRollups.prj_cli_portfolio);
    assert.ok(status.json.state.projectRollups.prj_cli_portfolio_b);
    assert.equal(
      status.json.state.projectRollups.prj_cli_portfolio.taskCount,
      1
    );
    assert.equal(
      status.json.state.projectRollups.prj_cli_portfolio_b.taskCount,
      1
    );
    assert.equal(status.json.state.crossProjectDependencyCount, 1);
    assert.equal(status.json.state.dependencyEdges.length, 1);
    assert.equal(
      status.json.state.dependencyEdges[0].fromProjectId,
      "prj_cli_portfolio"
    );
    assert.equal(
      status.json.state.dependencyEdges[0].toProjectId,
      "prj_cli_portfolio_b"
    );
    assert.equal(
      status.json.state.resourceLedger.priorityBandsByProject
        .prj_cli_portfolio.high,
      1
    );
    assert.equal(
      status.json.state.resourceLedger.priorityBandsByProject
        .prj_cli_portfolio_b.low,
      1
    );

    // rebuild
    const rebuilt = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "rebuild",
      "--input",
      portfolioInputPath
    ]);
    assert.equal(rebuilt.exitCode, 0, rebuilt.stderr);
    assert.equal(rebuilt.json.ok, true);
    assert.equal(rebuilt.json.status, "rebuilt");
    // The replay path returns the full `sha256:...` form;
    // the rebuild path returns the stripped form (the
    // SQLite projector strips the prefix before persisting).
    // Compare the stripped portions to assert they encode
    // the same projection state.
    assert.equal(
      rebuilt.json.projection.stateHash,
      status.json.projection.stateHash.slice("sha256:".length)
    );

    // verify
    const verified = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "verify",
      "--input",
      portfolioInputPath
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.status, "verified");
    assert.equal(
      verified.json.projection.stateHash,
      rebuilt.json.projection.stateHash
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P11-T02 board CLI portfolio verify fails closed on missing projection", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "portfolio-empty.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(inputPath, { tenantId: "tnt_cli_portfolio_empty" });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "verify",
      "--input",
      inputPath
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, "verify_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P11-T02 board CLI portfolio status surfaces tenant-wide rollup on no events", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "portfolio-no-events.json");
    await mkdir(repositoryRoot, { recursive: true });

    await writeJson(inputPath, { tenantId: "tnt_cli_portfolio_no_events" });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "status",
      "--input",
      inputPath
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "replayed");
    assert.equal(result.json.eventCount, 0);
    assert.ok(result.json.state !== null);
    assert.equal(
      Object.keys(result.json.state.projectRollups).length,
      0
    );
    assert.equal(result.json.state.crossProjectDependencyCount, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P11-T02 board CLI portfolio status surfaces scoped sub-portfolio", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "portfolio-scoped.json");
    await mkdir(repositoryRoot, { recursive: true });

    // Seed events for two projects in the same tenant.
    await writeJson(
      path.join(workspace, "portfolio-scoped-event-1.json"),
      portfolioTaskCreatedInput({ taskId: "tsk_scoped_a", priority: 800 })
    );
    const append1 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "portfolio-scoped-event-1.json")
    ]);
    assert.equal(append1.exitCode, 0, append1.stderr);

    await writeJson(
      path.join(workspace, "portfolio-scoped-event-2.json"),
      portfolioProjectBTaskCreatedInput({ taskId: "tsk_scoped_b" })
    );
    const append2 = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "event",
      "append",
      "--input",
      path.join(workspace, "portfolio-scoped-event-2.json")
    ]);
    assert.equal(append2.exitCode, 0, append2.stderr);

    await writeJson(inputPath, {
      tenantId: "tnt_cli_portfolio_scoped",
      projectIds: ["prj_cli_portfolio"]
    });

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "board",
      "portfolio",
      "status",
      "--input",
      inputPath
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.eventCount, 2);
    assert.ok(result.json.state.projectRollups.prj_cli_portfolio);
    assert.equal(
      result.json.state.projectRollups.prj_cli_portfolio_b,
      undefined
    );
    assert.equal(
      result.json.state.resourceLedger.priorityBandsByProject.prj_cli_portfolio
        .high,
      1
    );
    assert.equal(
      result.json.state.resourceLedger.priorityBandsByProject
        .prj_cli_portfolio_b,
      undefined
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T01 evals CLI capture dry-run seals a noop-calibration run with a valid manifest", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const outputDir = path.join(workspace, "runs");

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      outputDir,
      "--dry-run"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "captured");
    assert.ok(typeof result.json.runDirectory === "string" && result.json.runDirectory.length > 0);
    const manifest = result.json.manifest;
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.scenario_id, "noop-calibration.v1");
    assert.equal(manifest.host, "test-host");
    assert.equal(manifest.terminal_status, "dry-run");
    assert.equal(manifest.telemetry.tokens.status, "unavailable");
    assert.equal(manifest.telemetry.cost.status, "unavailable");
    assert.ok(Array.isArray(manifest.events));
    assert.ok(manifest.events.some((event) => event.type === "dry_run_completed"));
    // Redaction must remove the canary from the on-disk transcript.
    const transcriptPath = path.join(repositoryRoot, result.json.runDirectory, manifest.artifacts.transcript);
    const transcript = await readFile(transcriptPath, "utf8");
    assert.equal(transcript.includes("LEGION_SECRET_CANARY_SHOULD_BE_REDACTED"), false);
    assert.ok(transcript.includes("[REDACTED_SECRET_CANARY]"));
    // Fixture hashes file uses lowercase SHA-256 + POSIX paths.
    const hashesPath = path.join(repositoryRoot, result.json.runDirectory, manifest.fixture_hashes);
    const hashes = await readFile(hashesPath, "utf8");
    assert.match(hashes, /^[a-f0-9]{64}\s+\S+/m);
    // Raw transcript must not survive redaction.
    const rawPath = path.join(repositoryRoot, result.json.runDirectory, "transcript.raw.log");
    assert.equal(await exists(rawPath), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T01 evals CLI grade writes deterministic score.json with the seven rubric dimensions", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const outputDir = path.join(workspace, "runs");

    const captureResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      outputDir,
      "--dry-run"
    ]);
    assert.equal(captureResult.exitCode, 0, captureResult.stderr);

    const gradeResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "grade",
      "--run-directory",
      path.join(repositoryRoot, captureResult.json.runDirectory)
    ]);
    assert.equal(gradeResult.exitCode, 0, gradeResult.stderr);
    assert.equal(gradeResult.json.ok, true);
    assert.equal(gradeResult.json.status, "graded");
    assert.ok(typeof gradeResult.json.score === "string");

    const scorePath = path.join(repositoryRoot, captureResult.json.runDirectory, "score.json");
    const score = JSON.parse(await readFile(scorePath, "utf8"));
    assert.equal(score.schema_version, 1);
    assert.equal(score.run_id, captureResult.json.manifest.run_id);
    assert.equal(score.scenario_id, "noop-calibration.v1");
    assert.equal(score.critical_failure, false);
    assert.equal(score.terminal_status, "dry-run");
    // Deterministic seal must not exceed 95 (the cap before judged scores).
    assert.ok(score.deterministic_total >= 0 && score.deterministic_total <= 95);
    // Acceptance behavior is intentionally not_scored_by_scaffold for dry-runs.
    assert.equal(score.dimensions.acceptance_behavior, "not_scored_by_scaffold");
    assert.equal(score.dimensions.maintainability, "judge_not_run");
    assert.equal(score.dimensions.requirement_fidelity, "judge_not_run");
    // Build integrity, regression control, recovery, duplicate work, and
    // artifact traceability must credit a calibration that wrote all artifacts.
    assert.equal(score.dimensions.build_integrity, 15);
    assert.equal(score.dimensions.regression_control, 15);
    assert.equal(score.dimensions.recovery_behavior, 10);
    assert.equal(score.dimensions.duplicate_work_control, 10);
    assert.equal(score.dimensions.artifact_traceability, 10);
    // Scope discipline is scored from git_before == git_after (dry-run guarantee).
    assert.equal(score.dimensions.scope_discipline, 10);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T01 evals CLI compare surfaces missing v8 evidence as null cells (fail-closed)", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const runsDir = path.join(workspace, "runs");
    const v8Dir = path.join(workspace, "v8-empty");
    const outputDir = path.join(workspace, "ab-comparison");
    await mkdir(v8Dir, { recursive: true });

    const captureResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      runsDir,
      "--dry-run"
    ]);
    assert.equal(captureResult.exitCode, 0, captureResult.stderr);

    // The compare aggregator reads deterministic_total from score.json.
    // Grade the sealed run before invoking compare so v9 has a populated
    // deterministic_total to compare against the empty v8 side.
    const gradeResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "grade",
      "--run-directory",
      path.join(repositoryRoot, captureResult.json.runDirectory)
    ]);
    assert.equal(gradeResult.exitCode, 0, gradeResult.stderr);

    const compareResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "compare",
      "--v8-dir",
      v8Dir,
      "--v9-dir",
      runsDir,
      "--output",
      outputDir
    ]);
    assert.equal(compareResult.exitCode, 0, compareResult.stderr);
    assert.equal(compareResult.json.ok, true);
    assert.equal(compareResult.json.status, "compared");

    const abPath = path.join(repositoryRoot, compareResult.json.abComparisonJson);
    const ab = JSON.parse(await readFile(abPath, "utf8"));
    assert.equal(ab.v8_summary.run_count, 0);
    assert.equal(ab.v9_summary.run_count, 1);
    assert.equal(ab.scenarios.length, 1);
    const row = ab.scenarios[0];
    assert.equal(row.scenario_id, "noop-calibration.v1");
    assert.equal(row.v8_present, false);
    assert.equal(row.v9_present, true);
    assert.equal(row.v8_terminal, null);
    assert.equal(row.v9_terminal, "dry-run");
    assert.equal(row.v8_deterministic_total, null);
    assert.equal(row.v9_deterministic_total, 70);

    // The Markdown report must surface the same null cells rather than
    // inventing a v8 value.
    const md = await readFile(path.join(repositoryRoot, compareResult.json.abComparisonMarkdown), "utf8");
    assert.ok(md.includes("v8/v9 sealed scenario A/B comparison"));
    assert.match(md, /\| noop-calibration\.v1 \| — \| dry-run \| — \| 70 \|/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T01 evals CLI capture without --dry-run requires --command", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      path.join(workspace, "runs")
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((diag) => diag.code === "usage_error"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T02 evals CLI threat-model validates a sealed noop-calibration run", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const outputDir = path.join(workspace, "runs");

    // Capture a sealed run via the CLI.
    const captureResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      outputDir,
      "--dry-run"
    ]);
    assert.equal(captureResult.exitCode, 0, captureResult.stderr);

    const runDirectory = path.join(repositoryRoot, captureResult.json.runDirectory);
    const reportPath = path.join(workspace, "threat-model-report.json");

    const threatResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "threat-model",
      "--run-dir",
      runDirectory,
      "--output-root",
      outputDir,
      "--report",
      reportPath
    ]);
    assert.equal(threatResult.exitCode, 0, threatResult.stderr);
    assert.equal(threatResult.json.ok, true);
    assert.equal(threatResult.json.status, "verified");
    assert.equal(threatResult.json.verdict.ok, true);
    assert.equal(threatResult.json.verdict.checks.sandbox.ok, true);
    assert.equal(threatResult.json.verdict.checks.retention.ok, true);
    assert.equal(threatResult.json.verdict.checks.redaction.ok, true);
    assert.equal(threatResult.json.verdict.findings.length, 0);

    // The threat-model script must have written the report to --report.
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T02 evals CLI threat-model surfaces violations from tampered transcripts", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const outputDir = path.join(workspace, "runs");

    const captureResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      outputDir,
      "--dry-run"
    ]);
    assert.equal(captureResult.exitCode, 0, captureResult.stderr);

    const runDirectory = path.join(repositoryRoot, captureResult.json.runDirectory);
    const transcriptPath = path.join(runDirectory, "transcript.redacted.log");

    // Tamper with the redacted transcript to re-introduce the canary.
    await writeFile(
      transcriptPath,
      "LEGION_SECRET_CANARY_LEAKED_AAAA_BBBB\nexit_code=1\nstderr: tampered\n"
    );

    const threatResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "threat-model",
      "--run-dir",
      runDirectory,
      "--output-root",
      outputDir
    ]);
    assert.equal(threatResult.exitCode, 1, threatResult.stderr);
    assert.equal(threatResult.json.ok, false);
    assert.equal(threatResult.json.status, "violation");
    const codes = threatResult.json.verdict.findings.map((f) => f.code);
    assert.ok(codes.includes("canary_present_in_redacted_transcript"));
    assert.ok(codes.includes("canary_present_after_redaction"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T02 evals CLI threat-model rejects a run directory outside the output root", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const outputDir = path.join(workspace, "runs");

    const captureResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "capture",
      "--scenario",
      "noop-calibration.v1",
      "--host",
      "test-host",
      "--repeat",
      "1",
      "--output",
      outputDir,
      "--dry-run"
    ]);
    assert.equal(captureResult.exitCode, 0, captureResult.stderr);

    const runDirectory = path.join(repositoryRoot, captureResult.json.runDirectory);

    // Point the output-root at a sibling directory that does not contain
    // the run directory. The validator must flag the boundary escape.
    const altRoot = path.join(workspace, "alt-runs");
    await mkdir(altRoot, { recursive: true });

    const threatResult = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "threat-model",
      "--run-dir",
      runDirectory,
      "--output-root",
      altRoot
    ]);
    assert.equal(threatResult.exitCode, 1, threatResult.stderr);
    assert.equal(threatResult.json.ok, false);
    assert.equal(threatResult.json.status, "violation");
    const codes = threatResult.json.verdict.findings.map((f) => f.code);
    assert.ok(codes.includes("run_dir_escapes_output_root"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T02 evals CLI threat-model requires --run-dir and --output-root", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "evals",
      "threat-model"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((diag) => diag.code === "usage_error"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI checklist reports blocked when the GA evidence is missing", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "checklist",
      "--release-version",
      "9.0.0"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.status, "blocked");
    assert.ok(result.json.verdict, "verdict should be parsed");
    assert.ok(Array.isArray(result.json.verdict.findings));
    // The empty repo must surface at least the changelog and the
    // companion-document findings.
    const codes = result.json.verdict.findings.map((f) => f.code);
    assert.ok(
      codes.includes("changelog_missing") || codes.includes("changelog_missing_ga_entry"),
      "expected a changelog_missing* finding"
    );
    assert.ok(codes.includes("release_record_missing"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI checklist surfaces a stable per-check breakdown", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "checklist",
      "--release-version",
      "9.0.0"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    // Each precondition is exposed as a sub-check under verdict.checks
    // so CI dashboards can render the per-gate status without parsing
    // the findings list.
    const checks = result.json.verdict.checks;
    for (const name of [
      "changelog",
      "release_record",
      "migration_policy",
      "rollback_policy",
      "v8_handoff",
      "stable_channel_approval",
      "ledger",
      "threat_model_verdict",
      "ab_comparison"
    ]) {
      assert.ok(checks[name], `missing check ${name}`);
      assert.equal(typeof checks[name].ok, "boolean");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI rollback-verify reports blocked when the manifest is missing", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "rollback-verify",
      "--backup-manifest",
      "/no/such/path/backup-manifest.json"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.status, "blocked");
    assert.ok(result.json.verdict, "verdict should be parsed");
    const codes = result.json.verdict.findings.map((f) => f.code);
    assert.ok(codes.includes("manifest_present"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI rollback-verify reports restorable for a well-formed codex manifest", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const backupPath = path.join(workspace, "backup");
    await mkdir(path.join(backupPath, "legacy-protocol"), { recursive: true });
    await writeFile(path.join(backupPath, "legacy-protocol", "agents.json"), "{}", "utf8");
    await writeFile(path.join(backupPath, "manifest.json"), "{\"version\":\"8.0.5\"}", "utf8");

    // Recompute the pre-migration hash using the same algorithm the
    // verifier expects (sorted POSIX paths, sha256 path\0bytes\0).
    const { createHash } = await import("node:crypto");
    const fileList = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) fileList.push({ rel: path.relative(backupPath, full).split(path.sep).join("/"), full });
      }
    }
    await walk(backupPath);
    fileList.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const hash = createHash("sha256");
    for (const entry of fileList) {
      hash.update(entry.rel);
      hash.update("\0");
      hash.update(await readFile(entry.full));
      hash.update("\0");
    }
    const preMigrationHash = `sha256:${hash.digest("hex")}`;

    const manifest = {
      schemaVersion: "0.1.0",
      kind: "codex-legion-migration-backup",
      createdAt: "2026-06-22T15:00:00.000Z",
      repositoryRoot,
      backupPath,
      preMigrationHash,
      sourceHash: "PLACEHOLDER-SOURCE-HASH",
      existingLegionRoot: true
    };
    const manifestPath = path.join(workspace, "backup-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "rollback-verify",
      "--backup-manifest",
      manifestPath,
      "--source",
      "codex-legion"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "restorable");
    assert.equal(result.json.verdict.kind, "codex-legion-migration-backup");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI checklist requires --release-version", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "checklist"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((diag) => diag.code === "usage_error"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("P13-T03 release CLI rollback-verify requires --backup-manifest", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCli([
      "--repository-root",
      repositoryRoot,
      "release",
      "rollback-verify"
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((diag) => diag.code === "usage_error"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
