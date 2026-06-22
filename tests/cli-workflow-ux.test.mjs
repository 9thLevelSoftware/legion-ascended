import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-workflow-ux-"));
}

async function importWorkflowModule(name) {
  try {
    return await import(`../packages/cli/dist/workflow/${name}.js`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`workflow ${name} module should be importable: ${message}`);
  }
}

function git(repositoryRoot, args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

test("workflow helper input normalizes project metadata and paths", async () => {
  const input = await importWorkflowModule("input");
  const { actorSchema, projectSchema } = await import("../packages/protocol/dist/index.js");
  const root = await tempRepo();
  try {
    const timestamp = "2026-06-22T12:00:00.000Z";
    const context = {
      args: {
        positionals: [],
        options: new Map([["created-at", timestamp]])
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    };

    assert.equal(input.slugFromName("  Asset Mapper!!  "), "asset-mapper");
    assert.equal(input.slugFromName("!!!"), "legion-project");
    assert.equal(input.slugFromName("AI"), "legion-ai");
    assert.equal(projectSchema.shape.slug.safeParse(input.slugFromName("AI")).success, true);
    assert.equal(input.createdAtOption(context), timestamp);
    assert.equal(input.displayPath(context, path.join(root, "src", "index.ts")), "src/index.ts");

    const owner = input.ownerActor("DAS BL!");
    assert.deepEqual(actorSchema.parse(owner), {
      kind: "human",
      id: "das-bl",
      displayName: "DAS BL!"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper input derives repository references from git", async () => {
  const input = await importWorkflowModule("input");
  const root = await tempRepo();
  try {
    execFileSync("git", ["init", "-b", "trunk", root], { stdio: "ignore" });
    git(root, ["-c", "user.email=legion@example.com", "-c", "user.name=Legion Test", "commit", "--allow-empty", "-m", "init"]);
    git(root, ["remote", "add", "origin", "https://example.com/legion.git"]);

    assert.deepEqual(input.repositoryReference(root), {
      provider: "git",
      defaultBranch: "trunk",
      remoteUrl: "https://example.com/legion.git"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper render formats next actions and diagnostics", async () => {
  const render = await importWorkflowModule("render");

  const action = render.nextAction("legion plan 1", "Project is initialized.");
  assert.deepEqual(action, {
    command: "legion plan 1",
    reason: "Project is initialized."
  });
  assert.equal(render.renderNextAction(action), "Next: legion plan 1\nReason: Project is initialized.");
  assert.equal(render.renderDiagnostics([]), "");
  assert.equal(render.renderDiagnostics([{ message: "Project manifest is missing." }, "Plain diagnostic"]), "- Project manifest is missing.\n- Plain diagnostic");
});

test("workflow helper context and state load initialized and uninitialized projects", async () => {
  const contextHelpers = await importWorkflowModule("context");
  const state = await importWorkflowModule("state");
  const input = await importWorkflowModule("input");
  const { initProject } = await import("../packages/artifacts/dist/index.js");
  const root = await tempRepo();
  try {
    const cliContext = {
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    };

    const missing = await contextHelpers.loadWorkflowProject(cliContext);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "not_found");

    const uninitialized = await state.resolveWorkflowState(cliContext);
    assert.equal(uninitialized.stage, "uninitialized");
    assert.equal(uninitialized.projectId, null);
    assert.equal(uninitialized.currentSpecCount, 0);
    assert.deepEqual(uninitialized.nextAction, {
      command: "legion start",
      reason: "No .legion/project/project.json exists."
    });

    const initialized = await initProject({
      repositoryRoot: root,
      slug: input.slugFromName("Asset Mapper"),
      name: "Asset Mapper",
      description: "Metadata authoring and deterministic asset resolution",
      repository: {
        provider: "git",
        defaultBranch: "main"
      },
      decisionOwners: [input.ownerActor("dasbl")],
      createdAt: "2026-06-22T12:00:00.000Z"
    });
    assert.equal(initialized.ok, true);

    const loaded = await contextHelpers.loadWorkflowProject(cliContext);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.loaded.project.id, "prj_asset-mapper");

    const validation = await contextHelpers.validateWorkflowProject(cliContext);
    assert.equal(validation.ok, true);

    const initializedState = await state.resolveWorkflowState(cliContext);
    assert.equal(initializedState.stage, "started");
    assert.equal(initializedState.projectId, "prj_asset-mapper");
    assert.equal(initializedState.currentSpecCount, 0);
    assert.deepEqual(initializedState.nextAction, {
      command: "legion plan 1",
      reason: "Project is initialized and ready for the first planned change."
    });
    assert.deepEqual(initializedState.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root help leads with workflow commands and hides next namespace", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.match(result.stdout, /plan\s+Plan/);
  assert.match(result.stdout, /build\s+Execute/);
  assert.match(result.stdout, /review\s+Review/);
  assert.match(result.stdout, /dev\s+Advanced/);
  assert.doesNotMatch(result.stdout, /install\s+Install Legion workflows/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
  assert.doesNotMatch(result.stdout, /worker bundle manifest/i);
});

test("legacy next namespace remains a hidden dev compatibility alias", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture(["next", "--repository-root", root, "project", "status", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "not_found");
    assert.deepEqual(payload.warnings, [
      {
        code: "legacy_next_namespace",
        message: "Use legion dev project status. The legion next namespace is a hidden compatibility alias."
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion start initializes a project with friendly flags", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "initialized");
    assert.equal(payload.project.name, "Asset Mapper");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion status gives the next workflow action for a new project", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.workflowState.stage, "started");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker authoring is not in user help", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /instructionsHash/);
  assert.doesNotMatch(result.stdout, /promptContentContract/);
  assert.doesNotMatch(result.stdout, /bundles\/index\.json/);
});

test("dev help exposes engine commands for operators", async () => {
  const result = await runCliCapture(["dev", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion dev <command>/);
  assert.match(result.stdout, /project\s+Direct project artifact/);
  assert.match(result.stdout, /change\s+Direct change bundle/);
  assert.match(result.stdout, /board\s+Direct operational Kanban/);
  assert.match(result.stdout, /worker\s+Validate and inspect worker bundles/);
});

test("dev subcommand help delegates to the engine handler", async () => {
  const result = await runCliCapture(["dev", "project", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion dev project <command>/);
  assert.doesNotMatch(result.stdout, /legion next project/);
});

test("legacy next subcommand JSON help uses dev help and preserves warning", async () => {
  const result = await runCliCapture(["next", "project", "--help", "--json"]);
  assert.equal(result.exitCode, 0);
  const payload = parseJsonOutput(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "help");
  assert.match(payload.help, /legion dev project <command>/);
  assert.doesNotMatch(payload.help, /legion next project/);
  assert.deepEqual(payload.warnings, [
    {
      code: "legacy_next_namespace",
      message: "Use legion dev project. The legion next namespace is a hidden compatibility alias."
    }
  ]);
});
