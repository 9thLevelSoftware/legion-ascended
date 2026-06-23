import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-workflow-ux-"));
}

async function initializeAssetMapperProject(root) {
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
  return parseJsonOutput(result);
}

async function writeValidRoadmap(root) {
  const roadmapPath = path.join(root, "ROADMAP.md");
  await writeFile(
    roadmapPath,
    [
      "# Roadmap\n",
      "\n",
      "## Phase 1: Editor MVP\n",
      "Build the editor surface.\n",
      "\n",
      "### Acceptance\n",
      "- Asset metadata can be edited.\n",
      "\n",
      "## Phase 2: Package\n",
      "Ship the app.\n"
    ].join(""),
    "utf8"
  );
  return roadmapPath;
}

async function planPhaseOne(root) {
  await initializeAssetMapperProject(root);
  await writeValidRoadmap(root);
  const plan = await runCliCapture([
    "--repository-root", root,
    "plan", "1",
    "--from-roadmap", "ROADMAP.md",
    "--json"
  ]);
  assert.equal(plan.exitCode, 0, plan.stderr);
  return parseJsonOutput(plan);
}

async function assertFileExists(filePath) {
  const fileStat = await stat(filePath);
  assert.equal(fileStat.isFile(), true, `${filePath} should be a file`);
}

async function assertPathMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${filePath} should not exist`);
}

async function writeChangeCreatedAt(root, changeId, createdAt) {
  const changePath = path.join(root, ".legion", "project", "changes", changeId, "change.yaml");
  const change = JSON.parse(await readFile(changePath, "utf8"));
  change.change.createdAt = createdAt;
  await writeFile(changePath, `${JSON.stringify(change, null, 2)}\n`, "utf8");
}

async function readJsonArtifact(root, artifactPath) {
  const absolutePath = path.join(root, ...artifactPath.split("/"));
  const raw = await readFile(absolutePath, "utf8");
  return { raw, parsed: JSON.parse(raw) };
}

async function appendSecondTaskToTaskgraph(root, taskgraphArtifactPath) {
  const absolutePath = path.join(root, ...taskgraphArtifactPath.split("/"));
  const raw = await readFile(absolutePath, "utf8");
  const taskgraph = JSON.parse(raw);
  const firstTask = taskgraph.tasks[0];
  assert.ok(firstTask, "planned taskgraph should have a task to duplicate");
  const secondTask = structuredClone(firstTask);
  secondTask.id = "ctr_phase-1-editor-mvp-review";
  secondTask.title = "Review phase 1: Editor MVP";
  secondTask.objective = "Implement and verify the secondary phase 1 review task.";
  secondTask.completion = {
    ...secondTask.completion,
    requiredEvidence: ["legion build secondary verification output"]
  };
  taskgraph.tasks.push(secondTask);
  await writeFile(absolutePath, `${JSON.stringify(taskgraph)}\n`, "utf8");
}

async function writeValidWorkflowRecord(root, workflow = "explore", fileName = "record.json") {
  const recordPath = path.join(root, ".legion", "project", "workflow", workflow, fileName);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(
    recordPath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "workflow_record",
      workflow,
      createdAt: "2026-06-22T12:00:00.000Z",
      input: { text: "asset metadata editor" },
      nextAction: {
        command: "legion start",
        reason: "Use the exploration record to initialize the project workflow."
      }
    }, null, 2)}\n`,
    "utf8"
  );
  return recordPath;
}

function assertNoInternalWorkflowNouns(text) {
  assert.doesNotMatch(text, /worker bundle manifest/i);
  assert.doesNotMatch(text, /legion next/);
  assert.doesNotMatch(text, /project\/runtime support/i);
  assert.doesNotMatch(text, /implementation tasks/i);
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
    assert.throws(
      () => input.createdAtOption({
        ...context,
        args: {
          positionals: [],
          options: new Map([["created-at", "2026-06-22T12:00:00Z"]])
        }
      }),
      /Invalid canonical UTC timestamp/
    );
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

test("workflow helper input prefers remote default branch over feature worktree branch", async () => {
  const input = await importWorkflowModule("input");
  const root = await tempRepo();
  try {
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    git(root, ["-c", "user.email=legion@example.com", "-c", "user.name=Legion Test", "commit", "--allow-empty", "-m", "init"]);
    git(root, ["remote", "add", "origin", "https://example.com/legion.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(root, ["checkout", "-b", "codex/task"]);

    assert.deepEqual(input.repositoryReference(root), {
      provider: "git",
      defaultBranch: "main",
      remoteUrl: "https://example.com/legion.git"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper input falls back to main for non-git, detached, and feature branches without remote defaults", async () => {
  const input = await importWorkflowModule("input");
  const nonGitRoot = await tempRepo();
  const detachedRoot = await tempRepo();
  const featureRoot = await tempRepo();
  try {
    assert.deepEqual(input.repositoryReference(nonGitRoot), {
      provider: "git",
      defaultBranch: "main"
    });

    execFileSync("git", ["init", "-b", "main", detachedRoot], { stdio: "ignore" });
    git(detachedRoot, ["-c", "user.email=legion@example.com", "-c", "user.name=Legion Test", "commit", "--allow-empty", "-m", "init"]);
    git(detachedRoot, ["checkout", "--detach"]);

    assert.deepEqual(input.repositoryReference(detachedRoot), {
      provider: "git",
      defaultBranch: "main"
    });

    execFileSync("git", ["init", "-b", "main", featureRoot], { stdio: "ignore" });
    git(featureRoot, ["-c", "user.email=legion@example.com", "-c", "user.name=Legion Test", "commit", "--allow-empty", "-m", "init"]);
    git(featureRoot, ["checkout", "-b", "codex/task"]);

    assert.deepEqual(input.repositoryReference(featureRoot), {
      provider: "git",
      defaultBranch: "main"
    });
  } finally {
    await rm(nonGitRoot, { recursive: true, force: true });
    await rm(detachedRoot, { recursive: true, force: true });
    await rm(featureRoot, { recursive: true, force: true });
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

test("workflow helper run artifacts reserve suffix space for attempts and review sequence", async () => {
  const runArtifacts = await importWorkflowModule("run-artifacts");
  const { formatEntityId, reviewIdSchema, runIdSchema } = await import("../packages/protocol/dist/index.js");
  const longSuffix = `${"a".repeat(63)}z`;
  const taskId = formatEntityId("task", longSuffix);
  const changeId = formatEntityId("change", longSuffix);

  const runId = runArtifacts.runIdForTask({ taskId, attempt: 1 });
  assert.equal(runIdSchema.safeParse(runId).success, true);
  assert.equal(runId.endsWith("-attempt-1"), true);

  const reviewId = runArtifacts.reviewIdForChange({ changeId, sequence: 1 });
  assert.equal(reviewIdSchema.safeParse(reviewId).success, true);
  assert.equal(reviewId.endsWith("-review-1"), true);
});

test("workflow executor text writes reject symlinked artifact paths", async (t) => {
  const result = await importWorkflowModule("executor/result");
  const root = await tempRepo();
  try {
    const artifactPath = ".legion/project/changes/chg_phase-1-editor-mvp/runs/run_phase-1-editor-mvp-attempt-1/context-pack.md";
    const targetPath = path.join(root, ...artifactPath.split("/"));
    const outsidePath = path.join(root, "..", `${path.basename(root)}-outside.txt`);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(outsidePath, "outside\n", "utf8");
    try {
      await symlink(outsidePath, targetPath, "file");
    } catch (error) {
      if (error && typeof error === "object" && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip(`symlink creation unavailable: ${error.message}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => result.writeProjectTextFile({
        repositoryRoot: root,
        artifactPath,
        text: "escaped\n"
      }),
      /symlink|symbolic link/u
    );
    assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, "..", `${path.basename(root)}-outside.txt`), { force: true });
  }
});

test("workflow codex executor args match current codex exec surface", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const args = adapters.codexExecArgs({
    repositoryRoot: "C:\\repo\\asset-mapper",
    sandbox: "workspace-write",
    outputLastMessagePath: "C:\\tmp\\executor-last-message.txt"
  });

  assert.deepEqual(args, [
    "exec",
    "-c",
    "approval_policy=\"never\"",
    "-C",
    "C:\\repo\\asset-mapper",
    "--sandbox",
    "workspace-write",
    "--json",
    "--output-last-message",
    "C:\\tmp\\executor-last-message.txt",
    "-"
  ]);
  assert.equal(args.includes("approval_policy=\"never\""), true);
  assert.equal(args.includes("--ask-for-approval"), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(args.includes("--dangerously-bypass-hook-trust"), false);
});

test("workflow codex executor times out with a blocked result", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const root = await tempRepo();
  const fakeBin = path.join(root, "bin");
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.LEGION_CODEX_EXEC_TIMEOUT_MS;
  const baseArtifactPath = ".legion/project/changes/chg_timeout/runs/run_timeout";

  try {
    await mkdir(fakeBin, { recursive: true });
    if (process.platform === "win32") {
      await writeFile(path.join(fakeBin, "codex.cmd"), "@echo off\r\nping -n 10 127.0.0.1 >nul\r\n", "utf8");
    } else {
      const shim = path.join(fakeBin, "codex");
      await writeFile(shim, "#!/usr/bin/env sh\nsleep 5\n", "utf8");
      await chmod(shim, 0o755);
    }
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    process.env.LEGION_CODEX_EXEC_TIMEOUT_MS = "50";

    const adapter = adapters.adapterForKind("codex");
    const result = await adapter.run({
      repositoryRoot: root,
      changeId: "chg_timeout",
      runId: "run_timeout",
      task: { id: "ctr_timeout" },
      mode: "build",
      executor: "codex",
      readOnly: true,
      prompt: "Return a successful Legion executor result.",
      contextPackArtifactPath: `${baseArtifactPath}/context-pack.md`,
      contextPackAbsolutePath: path.join(root, ".legion", "project", "changes", "chg_timeout", "runs", "run_timeout", "context-pack.md"),
      promptArtifactPath: `${baseArtifactPath}/executor-prompt.md`,
      promptAbsolutePath: path.join(root, ".legion", "project", "changes", "chg_timeout", "runs", "run_timeout", "executor-prompt.md"),
      resultArtifactPath: `${baseArtifactPath}/executor-result.json`,
      resultAbsolutePath: path.join(root, ".legion", "project", "changes", "chg_timeout", "runs", "run_timeout", "executor-result.json"),
      rawLogArtifactPath: `${baseArtifactPath}/executor-raw.log`,
      rawLogAbsolutePath: path.join(root, ".legion", "project", "changes", "chg_timeout", "runs", "run_timeout", "executor-raw.log"),
      redactedLogArtifactPath: `${baseArtifactPath}/executor-redacted.log`,
      redactedLogAbsolutePath: path.join(root, ".legion", "project", "changes", "chg_timeout", "runs", "run_timeout", "executor-redacted.log")
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.exitCode, 124);
    assert.equal(result.findings.some((finding) => finding.id === "codex-executor-timeout"), true);
    const written = await readJsonArtifact(root, `${baseArtifactPath}/executor-result.json`);
    assert.equal(written.parsed.status, "blocked");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.LEGION_CODEX_EXEC_TIMEOUT_MS;
    else process.env.LEGION_CODEX_EXEC_TIMEOUT_MS = previousTimeout;
    await rm(root, { recursive: true, force: true });
  }
});

test("core workflow commands expose command-specific help", async () => {
  const cases = [
    ["start", /legion start --name <name>/],
    ["plan", /legion plan <phase-number>/],
    ["build", /legion build \[--executor codex\|manual\|fake\]/],
    ["review", /legion review \[--executor codex\|manual\|fake\]/],
    ["status", /legion status/],
    ["validate", /legion validate/],
    ["doctor", /legion doctor/]
  ];

  for (const [command, expected] of cases) {
    const result = await runCliCapture([command, "--help"]);
    assert.equal(result.exitCode, 0, `${command} help should succeed`);
    assert.match(result.stdout, expected);
    assert.doesNotMatch(result.stdout, /legion <workflow>/);
  }
});

test("workflow review fails verdicts when the review executor fails", async () => {
  const review = await import("../packages/cli/dist/commands/workflow/review.js");
  const { formatEntityId } = await import("../packages/protocol/dist/index.js");
  const projectId = formatEntityId("project", "asset-mapper");
  const changeId = formatEntityId("change", "phase-1-editor-mvp");
  const taskId = formatEntityId("task", "phase-1-editor-mvp");
  const runId = formatEntityId("run", "phase-1-editor-mvp-attempt-1");
  const reviewId = formatEntityId("review", "phase-1-editor-mvp-review-1");

  const decision = review.reviewDecisionForExecution({
    reviewId,
    task: {
      projectId,
      changeId
    },
    taskId,
    runId,
    result: {
      ok: false,
      status: "failed",
      summary: "Executor failed after emitting pass verdicts.",
      filesChanged: [],
      commandsRun: [],
      findings: [],
      reviewVerdicts: {
        specification: "pass",
        integration: "pass",
        evidence: "pass"
      }
    },
    evidenceEntries: [],
    evidenceIndexPath: ".legion/project/changes/chg_phase-1-editor-mvp/evidence-index.json",
    createdAt: "2026-06-23T12:00:00.000Z",
    executor: "fake",
    supersedes: []
  });

  assert.deepEqual(decision.verdicts, {
    specification: "fail",
    integration: "fail",
    evidence: "fail"
  });
});

test("workflow helper phase compatibility resolves an explicit roadmap phase", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const root = await tempRepo();
  try {
    const roadmapPath = path.join(root, "ROADMAP.md");
    await writeFile(
      roadmapPath,
      [
        "# Roadmap\r\n",
        "\r\n",
        "## Phase 1: Editor MVP\r\n",
        "Build the editor surface.\r\n",
        "\r\n",
        "### Acceptance\r\n",
        "- Asset metadata can be edited.\r\n",
        "\r\n",
        "## Phase 2: Package\r\n",
        "Ship the app.\r\n"
      ].join(""),
      "utf8"
    );

    const result = await phaseCompat.resolvePhaseSource(
      {
        args: {
          positionals: [],
          options: new Map([["from-roadmap", "ROADMAP.md"]])
        },
        repositoryRoot: root,
        json: false,
        noColor: false,
        cwd: root
      },
      1
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.phase, {
      number: 1,
      name: "Editor MVP",
      body: "Build the editor surface.\n\n### Acceptance\n- Asset metadata can be edited.",
      sourcePath: roadmapPath
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper phase compatibility parses legacy phase details headings", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const phase = phaseCompat.parseRoadmapPhase(
    [
      "# Roadmap\n",
      "\n",
      "## Phase Details\n",
      "\n",
      "### Phase 1: Editor MVP\n",
      "Build the editor surface.\n",
      "\n",
      "#### Acceptance\n",
      "- Asset metadata can be edited.\n",
      "\n",
      "### Phase 2: Package\n",
      "Ship the app.\n"
    ].join(""),
    1,
    "ROADMAP.md"
  );

  assert.deepEqual(phase, {
    number: 1,
    name: "Editor MVP",
    body: "Build the editor surface.\n\n#### Acceptance\n- Asset metadata can be edited.",
    sourcePath: "ROADMAP.md"
  });
});

test("workflow helper phase compatibility treats missing explicit roadmap as authoritative", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const root = await tempRepo();
  try {
    await writeFile(
      path.join(root, "ROADMAP.md"),
      "## Phase 1: Root Source\nUse the root roadmap.\n",
      "utf8"
    );

    const result = await phaseCompat.resolvePhaseSource(
      {
        args: {
          positionals: [],
          options: new Map([["from-roadmap", "missing.md"]])
        },
        repositoryRoot: root,
        json: false,
        noColor: false,
        cwd: root
      },
      1
    );

    assert.deepEqual(result, {
      ok: false,
      diagnostic: {
        code: "phase_source_missing",
        message: "No phase 1 source was found. Run legion explore or pass --from-roadmap <path>."
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper phase compatibility treats explicit roadmap without phase as authoritative", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const root = await tempRepo();
  try {
    await writeFile(
      path.join(root, "other.md"),
      "## Phase 2: Other Source\nUse another phase.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "ROADMAP.md"),
      "## Phase 1: Root Source\nUse the root roadmap.\n",
      "utf8"
    );

    const result = await phaseCompat.resolvePhaseSource(
      {
        args: {
          positionals: [],
          options: new Map([["from-roadmap", "other.md"]])
        },
        repositoryRoot: root,
        json: false,
        noColor: false,
        cwd: root
      },
      1
    );

    assert.deepEqual(result, {
      ok: false,
      diagnostic: {
        code: "phase_source_missing",
        message: "No phase 1 source was found. Run legion explore or pass --from-roadmap <path>."
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper phase compatibility prefers planning roadmap before root roadmap", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, ".planning"), { recursive: true });
    const planningRoadmapPath = path.join(root, ".planning", "ROADMAP.md");
    await writeFile(
      planningRoadmapPath,
      "## Phase 1: Planning Source\nUse the planning roadmap.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "ROADMAP.md"),
      "## Phase 1: Root Source\nUse the root roadmap.\n",
      "utf8"
    );

    const result = await phaseCompat.resolvePhaseSource(
      {
        args: {
          positionals: [],
          options: new Map()
        },
        repositoryRoot: root,
        json: false,
        noColor: false,
        cwd: root
      },
      1
    );

    assert.equal(result.ok, true);
    assert.equal(result.phase.name, "Planning Source");
    assert.equal(result.phase.body, "Use the planning roadmap.");
    assert.equal(result.phase.sourcePath, planningRoadmapPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper phase compatibility reports a missing phase source", async () => {
  const phaseCompat = await importWorkflowModule("phase-compat");
  const root = await tempRepo();
  try {
    const result = await phaseCompat.resolvePhaseSource(
      {
        args: {
          positionals: [],
          options: new Map()
        },
        repositoryRoot: root,
        json: false,
        noColor: false,
        cwd: root
      },
      1
    );

    assert.deepEqual(result, {
      ok: false,
      diagnostic: {
        code: "phase_source_missing",
        message: "No phase 1 source was found. Run legion explore or pass --from-roadmap <path>."
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("workflow helper state advances to build readiness after planning", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const plan = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(plan.exitCode, 0, plan.stderr);

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "planned");
    assert.equal(workflowState.projectId, "prj_asset-mapper");
    assert.equal(workflowState.currentSpecCount, 1);
    assert.deepEqual(workflowState.nextAction, {
      command: "legion build",
      reason: "Latest planned change is ready for guided build execution."
    });
    assert.deepEqual(workflowState.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks invalid project state instead of suggesting start", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, ".legion", "project"), { recursive: true });
    await writeFile(path.join(root, ".legion", "project", "project.json"), "{ invalid json", "utf8");

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

    const workflowState = await state.resolveWorkflowState(cliContext);
    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, null);
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.match(workflowState.nextAction.reason, /repair.*before planning/i);
    assert.notEqual(workflowState.nextAction.command, "legion start");
    assert.ok(workflowState.diagnostics.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks initialized project truth with missing constitution", async () => {
  const state = await importWorkflowModule("state");
  const input = await importWorkflowModule("input");
  const { initProject } = await import("../packages/artifacts/dist/index.js");
  const root = await tempRepo();
  try {
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
    await rm(path.join(root, ".legion", "project", "constitution.md"), { force: true });

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, "prj_asset-mapper");
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.match(workflowState.nextAction.reason, /repaired before planning/i);
    assert.equal(workflowState.diagnostics[0]?.code, "constitution_missing");
    assert.equal(workflowState.diagnostics[0]?.source?.path, ".legion/project/constitution.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks invalid current specs instead of recommending planning", async () => {
  const state = await importWorkflowModule("state");
  const input = await importWorkflowModule("input");
  const { initProject } = await import("../packages/artifacts/dist/index.js");
  const root = await tempRepo();
  try {
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

    await mkdir(path.join(root, ".legion", "project", "specs"), { recursive: true });
    await writeFile(path.join(root, ".legion", "project", "specs", "req_bad.md"), "Malformed current spec", "utf8");

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, "prj_asset-mapper");
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.equal(workflowState.diagnostics[0]?.code, "missing_frontmatter");
    assert.equal(workflowState.diagnostics[0]?.source?.path, ".legion/project/specs/req_bad.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks unknown .legion entries before start", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, ".legion", "unexpected"), { recursive: true });

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, null);
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.equal(workflowState.diagnostics[0]?.code, "migration_required");
    assert.equal(typeof workflowState.diagnostics[0]?.source?.path, "string");
    assert.equal(
      workflowState.diagnostics[0]?.message,
      "Existing .legion entries require explicit migration before initialization: unexpected."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks .legion project data without manifest before start", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, ".legion", "project"), { recursive: true });

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, null);
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.equal(workflowState.diagnostics[0]?.code, "migration_required");
    assert.equal(typeof workflowState.diagnostics[0]?.source?.path, "string");
    assert.equal(
      workflowState.diagnostics[0]?.message,
      "Existing .legion/project data has no project manifest; explicit migration or reconciliation is required before initialization."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state allows pre-start workflow records", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await writeValidWorkflowRecord(root);

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "uninitialized");
    assert.equal(workflowState.projectId, null);
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state blocks arbitrary pre-start workflow files", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    const legacyPath = path.join(root, ".legion", "project", "workflow", "legacy-system", "legacy.txt");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "legacy workflow bytes\n", "utf8");

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "blocked");
    assert.equal(workflowState.projectId, null);
    assert.equal(workflowState.currentSpecCount, 0);
    assert.equal(workflowState.nextAction.command, "legion validate");
    assert.equal(workflowState.diagnostics[0]?.code, "migration_required");
    assert.equal(
      workflowState.diagnostics[0]?.message,
      "Existing .legion/project data has no project manifest; explicit migration or reconciliation is required before initialization."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow helper state treats .legion var alone as uninitialized", async () => {
  const state = await importWorkflowModule("state");
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, ".legion", "var"), { recursive: true });

    const workflowState = await state.resolveWorkflowState({
      args: {
        positionals: [],
        options: new Map()
      },
      repositoryRoot: root,
      json: false,
      noColor: false,
      cwd: root
    });

    assert.equal(workflowState.stage, "uninitialized");
    assert.equal(workflowState.nextAction.command, "legion start");
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
  assert.match(result.stdout, /doctor\s+Validate project state plus shallow \.legion\/var and bundle-index path presence\./);
  assert.doesNotMatch(result.stdout, /doctor\s+Validate project, operational, runtime, and packaging health\./);
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

test("legion start supports an explicit project slug", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--slug", "asset-mapper-cli",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.project.slug, "asset-mapper-cli");
    assert.equal(payload.project.id, "prj_asset-mapper-cli");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion status gives the next workflow action for a new project", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
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

test("legion build blocks clearly when no planned change exists", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "build", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.diagnostics[0]?.code, "change_missing");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build blocks when change directories are not valid typed bundles", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await mkdir(path.join(root, ".legion", "project", "changes", "chg_invalid"), { recursive: true });

    const result = await runCliCapture(["--repository-root", root, "build", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.diagnostics[0]?.code, "change_discovery_failed");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build dry-run reports readiness for the latest typed taskgraph", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const plan = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(plan.exitCode, 0, plan.stderr);

    const result = await runCliCapture([
      "--repository-root", root,
      "build",
      "--dry-run",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.driver.driver, "runtime-local");
    assert.equal(payload.taskgraph.taskCount, 1);
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build dry-run selects the latest change by metadata timestamp", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeFile(
      path.join(root, "ROADMAP.md"),
      [
        "# Roadmap\n",
        "\n",
        "## Phase 2: Two\n",
        "Implement the second phase.\n",
        "\n",
        "## Phase 10: Ten\n",
        "Implement the tenth phase.\n"
      ].join(""),
      "utf8"
    );

    const phaseTwo = await runCliCapture([
      "--repository-root", root,
      "plan", "2",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(phaseTwo.exitCode, 0, phaseTwo.stderr);

    const phaseTen = await runCliCapture([
      "--repository-root", root,
      "plan", "10",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(phaseTen.exitCode, 0, phaseTen.stderr);

    await writeChangeCreatedAt(root, "chg_phase-2-two", "2026-06-22T12:00:00.000Z");
    await writeChangeCreatedAt(root, "chg_phase-10-ten", "2026-06-22T12:00:01.000Z");

    const result = await runCliCapture([
      "--repository-root", root,
      "build",
      "--dry-run",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.change.changeId, "chg_phase-10-ten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build --executor fake writes task-run artifacts and pending evidence", async () => {
  const root = await tempRepo();
  try {
    await planPhaseOne(root);

    const result = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "executed");
    assert.equal(payload.executor, "fake");
    assert.equal(payload.nextAction.command, "legion review");
    assert.equal(payload.taskRuns.length, 1);

    const run = payload.taskRuns[0];
    await assertFileExists(path.join(root, ...run.artifactPath.split("/")));
    const runArtifact = await readJsonArtifact(root, run.artifactPath);
    assert.equal(runArtifact.parsed.kind, "task-run");
    assert.equal(runArtifact.parsed.status, "succeeded");
    assert.equal(runArtifact.parsed.evidenceRefs[0], run.evidenceId);

    const runRoot = path.dirname(path.join(root, ...run.artifactPath.split("/")));
    await assertFileExists(path.join(runRoot, "context-pack.md"));
    await assertFileExists(path.join(runRoot, "executor-result.json"));
    await assertFileExists(path.join(runRoot, "executor-redacted.log"));

    const evidence = await readJsonArtifact(root, payload.evidenceIndex.artifactPath);
    assert.equal(evidence.parsed.entries.length, 1);
    assert.equal(evidence.parsed.entries[0].acceptance.status, "pending");

    const status = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = parseJsonOutput(status);
    assert.equal(statusPayload.workflowState.stage, "built");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build --executor manual blocks but records failed evidence", async () => {
  const root = await tempRepo();
  try {
    await planPhaseOne(root);

    const result = await runCliCapture(["--repository-root", root, "build", "--executor", "manual", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.taskRuns.length, 1);
    assert.equal(payload.taskRuns[0].status, "blocked");
    assert.equal(payload.evidenceIndex.entries, 1);

    const evidence = await readJsonArtifact(root, payload.evidenceIndex.artifactPath);
    assert.equal(evidence.parsed.entries[0].evidence.status, "failed");
    assert.equal(evidence.parsed.entries[0].acceptance.status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build retry uses the next task attempt after a blocked run", async () => {
  const root = await tempRepo();
  try {
    await planPhaseOne(root);

    const blocked = await runCliCapture(["--repository-root", root, "build", "--executor", "manual", "--json"]);
    assert.equal(blocked.exitCode, 1);
    const blockedPayload = parseJsonOutput(blocked);
    assert.equal(blockedPayload.taskRuns[0].runId.endsWith("attempt-1"), true);

    const retry = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(retry.exitCode, 0, retry.stderr);
    const payload = parseJsonOutput(retry);
    assert.equal(payload.status, "executed");
    assert.equal(payload.taskRuns[0].runId.endsWith("attempt-2"), true);

    const evidence = await readJsonArtifact(root, payload.evidenceIndex.artifactPath);
    assert.equal(evidence.parsed.entries.length, 2);
    assert.equal(evidence.parsed.entries.some((entry) => entry.evidence.status === "failed"), true);
    assert.equal(evidence.parsed.entries.some((entry) => entry.evidence.runId.endsWith("attempt-2") && entry.evidence.status === "collected"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review blocks clearly when no planned change exists", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "review", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.diagnostics[0]?.code, "change_missing");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review blocks clearly when the latest change has no taskgraph", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const plan = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(plan.exitCode, 0, plan.stderr);
    const planPayload = parseJsonOutput(plan);
    await rm(path.join(root, ...planPayload.taskgraph.artifactPath.split("/")), { force: true });

    const result = await runCliCapture(["--repository-root", root, "review", "--dry-run", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.diagnostics[0]?.code, "not_found");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review dry-run reports review gates for the latest taskgraph", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const plan = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(plan.exitCode, 0, plan.stderr);

    const result = await runCliCapture([
      "--repository-root", root,
      "review",
      "--dry-run",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.taskgraph.taskCount, 1);
    assert.equal(payload.nextAction.command, "legion review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review submits, accepts, advances status, and unlocks ship readiness", async () => {
  const root = await tempRepo();
  try {
    await planPhaseOne(root);

    const build = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(build.exitCode, 0, build.stderr);

    const result = await runCliCapture(["--repository-root", root, "review", "--executor", "fake", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "submitted");
    assert.equal(payload.review.verdicts.specification, "pass");
    assert.equal(payload.nextAction.command, "legion review --accept");

    const submitted = await readJsonArtifact(root, payload.review.artifactPath);
    assert.equal(submitted.parsed.kind, "review");
    assert.equal(submitted.parsed.status, "submitted");

    const reviewArtifactRoot = path.join(root, ...payload.review.artifactPath.replace(/\.json$/u, "").split("/"));
    const reviewContextPack = await readFile(path.join(reviewArtifactRoot, "context-pack.md"), "utf8");
    assert.match(reviewContextPack, /## Build Evidence/);
    assert.match(reviewContextPack, /executor-result\.json/);
    const reviewPrompt = await readFile(path.join(reviewArtifactRoot, "executor-prompt.md"), "utf8");
    assert.match(reviewPrompt, /Review the collected build evidence/);
    assert.match(reviewPrompt, /Do not modify files/);
    assert.doesNotMatch(reviewPrompt, /Verify before report/);

    const evidenceBeforeAccept = await readJsonArtifact(root, payload.evidenceIndex);
    assert.equal(evidenceBeforeAccept.parsed.entries[0].acceptance.status, "pending");

    const accepted = await runCliCapture(["--repository-root", root, "review", "--accept", "--json"]);
    assert.equal(accepted.exitCode, 0, accepted.stderr);
    const acceptedPayload = parseJsonOutput(accepted);
    assert.equal(acceptedPayload.status, "accepted");
    assert.equal(acceptedPayload.nextAction.command, "legion ship");

    const status = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = parseJsonOutput(status);
    assert.equal(statusPayload.workflowState.stage, "ship_ready");

    const ship = await runCliCapture(["--repository-root", root, "ship", "--json"]);
    assert.equal(ship.exitCode, 0, ship.stderr);
    const shipPayload = parseJsonOutput(ship);
    assert.equal(shipPayload.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review covers every task before accepting multi-task evidence", async () => {
  const root = await tempRepo();
  try {
    const plan = await planPhaseOne(root);
    await appendSecondTaskToTaskgraph(root, plan.taskgraph.artifactPath);

    const build = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(build.exitCode, 0, build.stderr);
    const buildPayload = parseJsonOutput(build);
    assert.equal(buildPayload.taskRuns.length, 2);

    const result = await runCliCapture(["--repository-root", root, "review", "--executor", "fake", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "submitted");
    assert.equal(payload.reviews.length, 2);
    assert.deepEqual(
      payload.reviews.map((review) => review.taskId).sort(),
      ["tsk_phase-1-editor-mvp", "tsk_phase-1-editor-mvp-review"]
    );

    const accepted = await runCliCapture(["--repository-root", root, "review", "--accept", "--json"]);
    assert.equal(accepted.exitCode, 0, accepted.stderr);
    const acceptedPayload = parseJsonOutput(accepted);
    assert.equal(acceptedPayload.status, "accepted");
    assert.equal(acceptedPayload.reviews.length, 2);

    const evidence = await readJsonArtifact(root, acceptedPayload.evidenceIndex.artifactPath);
    assert.equal(evidence.parsed.entries.length, 2);
    assert.equal(evidence.parsed.entries.every((entry) => entry.acceptance.status === "accepted"), true);
    assert.equal(new Set(evidence.parsed.entries.map((entry) => entry.acceptance.reviewId)).size, 2);

    const status = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(parseJsonOutput(status).workflowState.stage, "ship_ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review --auto --executor fake accepts a clean review", async () => {
  const root = await tempRepo();
  try {
    await planPhaseOne(root);
    const build = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(build.exitCode, 0, build.stderr);

    const auto = await runCliCapture(["--repository-root", root, "review", "--auto", "--executor", "fake", "--json"]);
    assert.equal(auto.exitCode, 0, auto.stderr);
    const payload = parseJsonOutput(auto);
    assert.equal(payload.status, "accepted");

    const status = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(parseJsonOutput(status).workflowState.stage, "ship_ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion build blocks on dirty git worktrees unless --allow-dirty is set", async () => {
  const root = await tempRepo();
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "codex@example.test"]);
    git(root, ["config", "user.name", "Codex"]);
    await planPhaseOne(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);
    await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Editor MVP\nDirty change.\n", "utf8");

    const blocked = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--json"]);
    assert.equal(blocked.exitCode, 1);
    const blockedPayload = parseJsonOutput(blocked);
    assert.equal(blockedPayload.status, "blocked");
    assert.equal(blockedPayload.diagnostics[0]?.code, "dirty_worktree");

    const allowed = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--allow-dirty", "--json"]);
    assert.equal(allowed.exitCode, 0, allowed.stderr);
    assert.equal(parseJsonOutput(allowed).status, "executed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion ship blocks until accepted review evidence exists", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "ship", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion quick creates a typed ad-hoc taskgraph", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "quick", "fix the failing tests", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assertNoInternalWorkflowNouns(result.stdout);

    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "planned");
    assert.equal(payload.workflow, "quick");
    assert.equal(payload.nextAction.command, "legion build");
    assert.match(payload.artifactPath, /^\.legion\/project\/workflow\/quick\/.+-fix-the-failing-tests\/workflow-run\.json$/);
    assert.doesNotMatch(payload.artifactPath, /^\.legion\/var\//);
    assert.match(payload.requestArtifactPath, /request\.md$/);
    assert.match(payload.taskgraph.artifactPath, /^\.legion\/project\/changes\/.+\/taskgraph\.json$/);

    const artifact = await readJsonArtifact(root, payload.artifactPath);
    assert.equal(artifact.raw.endsWith("\n"), true);
    assert.equal(artifact.parsed.kind, "workflow_run");
    assert.equal(artifact.parsed.workflow, "quick");
    assert.equal(artifact.parsed.status, "planned");
    assert.equal(artifact.parsed.outputs.requestArtifactPath, payload.requestArtifactPath);
    await assertFileExists(path.join(root, ...payload.taskgraph.artifactPath.split("/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion quick preserves repeated timestamp and slug runs", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const args = [
      "--repository-root", root,
      "quick", "fix the failing tests",
      "--created-at", "2026-06-22T12:34:56.000Z",
      "--json"
    ];
    const first = await runCliCapture(args);
    const second = await runCliCapture(args);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(second.exitCode, 0, second.stderr);

    const firstPayload = parseJsonOutput(first);
    const secondPayload = parseJsonOutput(second);
    assert.notEqual(secondPayload.artifactPath, firstPayload.artifactPath);
    assert.match(firstPayload.artifactPath, /2026-06-22t12-34-56-000z-fix-the-failing-tests\/workflow-run\.json$/);
    assert.match(secondPayload.artifactPath, /2026-06-22t12-34-56-000z-fix-the-failing-tests-2\/workflow-run\.json$/);
    assert.notEqual(secondPayload.change.changeId, firstPayload.change.changeId);

    const firstArtifact = await readJsonArtifact(root, firstPayload.artifactPath);
    const secondArtifact = await readJsonArtifact(root, secondPayload.artifactPath);
    assert.equal(firstArtifact.parsed.input.text, "fix the failing tests");
    assert.equal(secondArtifact.parsed.input.text, "fix the failing tests");
    const files = await readdir(path.join(root, ".legion", "project", "workflow", "quick"));
    assert.deepEqual(files.sort(), [
      "2026-06-22t12-34-56-000z-fix-the-failing-tests",
      "2026-06-22t12-34-56-000z-fix-the-failing-tests-2"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion explore writes a design guidance run before project start", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture(["--repository-root", root, "explore", "asset metadata editor", "--executor", "fake", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assertNoInternalWorkflowNouns(result.stdout);

    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "completed");
    assert.equal(payload.workflow, "explore");
    assert.equal(payload.nextAction.command, "legion start");
    assert.match(payload.artifactPath, /^\.legion\/project\/workflow\/explore\/.+-asset-metadata-editor\/workflow-run\.json$/);
    assert.match(payload.markdownArtifactPath, /design\.md$/);
    assert.doesNotMatch(payload.artifactPath, /^\.legion\/var\//);

    const artifact = await readJsonArtifact(root, payload.artifactPath);
    assert.equal(artifact.raw.endsWith("\n"), true);
    assert.equal(artifact.parsed.kind, "workflow_run");
    assert.equal(artifact.parsed.workflow, "explore");
    assert.equal(artifact.parsed.outputs.markdownArtifactPath, payload.markdownArtifactPath);

    const start = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--owner", "dasbl",
      "--json"
    ]);
    assert.equal(start.exitCode, 0, start.stderr);
    assert.equal(parseJsonOutput(start).nextAction.command, "legion plan 1");
    await assertFileExists(path.join(root, ...payload.artifactPath.split("/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion start blocks arbitrary files in the pre-start workflow directory", async () => {
  const root = await tempRepo();
  try {
    const legacyPath = path.join(root, ".legion", "project", "workflow", "legacy-system", "legacy.txt");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "legacy workflow bytes\n", "utf8");

    const result = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--owner", "dasbl",
      "--json"
    ]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "migration_required");
    assert.equal(payload.diagnostics[0]?.code, "migration_required");
    assert.equal(payload.nextAction.command, "legion validate");
    await assertFileExists(legacyPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const guidanceCommandCases = [
  {
    name: "advise",
    args: ["advise", "dependency risk", "--executor", "fake", "--json"],
    workflow: "advise",
    status: "completed",
    nextAction: "legion status",
    outputKey: "markdownArtifactPath",
    slug: "dependency-risk"
  },
  {
    name: "polish",
    args: ["polish", "README.md", "--json"],
    workflow: "polish",
    status: "planned",
    nextAction: "legion build",
    outputKey: "requestArtifactPath",
    slug: "readme-md"
  },
  {
    name: "learn",
    args: ["learn", "prefer artifact-backed plans", "--json"],
    workflow: "learn",
    status: "completed",
    nextAction: "legion status",
    outputKey: "lessonArtifactPath",
    slug: "prefer-artifact-backed-plans"
  },
  {
    name: "map refresh",
    args: ["map", "--refresh", "--json"],
    workflow: "map",
    status: "completed",
    nextAction: "legion plan 1",
    outputKey: "mapArtifactPath",
    slug: "refresh"
  },
  {
    name: "retro",
    args: ["retro", "--executor", "fake", "--json"],
    workflow: "retro",
    status: "completed",
    nextAction: "legion plan 1",
    outputKey: "markdownArtifactPath",
    slug: "retro"
  },
  {
    name: "milestone",
    args: ["milestone", "--status", "--json"],
    workflow: "milestone",
    status: "completed",
    nextAction: "legion status",
    outputKey: "markdownArtifactPath",
    slug: "status"
  },
  {
    name: "council",
    args: ["council", "release readiness", "--executor", "fake", "--json"],
    workflow: "council",
    status: "completed",
    nextAction: "legion status",
    outputKey: "markdownArtifactPath",
    slug: "release-readiness"
  }
];

for (const recordCase of guidanceCommandCases) {
  test(`legion ${recordCase.name} writes a guidance workflow run`, async () => {
    const root = await tempRepo();
    try {
      await initializeAssetMapperProject(root);

      const result = await runCliCapture(["--repository-root", root, ...recordCase.args]);
      assert.equal(result.exitCode, 0, result.stderr);
      const payload = parseJsonOutput(result);
      assert.equal(payload.ok, true);
      assert.equal(payload.status, recordCase.status);
      assert.equal(payload.workflow, recordCase.workflow);
      assert.equal(payload.nextAction.command, recordCase.nextAction);
      assert.match(
        payload.artifactPath,
        new RegExp(`^\\.legion/project/workflow/${recordCase.workflow}/.+-${recordCase.slug}/workflow-run\\.json$`)
      );
      assert.equal(typeof payload[recordCase.outputKey], "string");

      const artifact = await readJsonArtifact(root, payload.artifactPath);
      assert.equal(artifact.raw.endsWith("\n"), true);
      assert.equal(artifact.parsed.kind, "workflow_run");
      assert.equal(artifact.parsed.workflow, recordCase.workflow);
      assert.equal(artifact.parsed.status, recordCase.status);
      await assertFileExists(path.join(root, ...payload[recordCase.outputKey].split("/")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("legion map --check reports stale state and writes a guidance run", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "map", "--check", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "stale");
    assert.equal(payload.workflow, "map");
    assert.equal(payload.mode, "check");
    assert.equal(payload.nextAction.command, "legion map --refresh");
    await assertFileExists(path.join(root, ...payload.artifactPath.split("/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion map help advertises implemented modes", async () => {
  const result = await runCliCapture(["map", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--refresh/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--query <text>/);
});

for (const command of ["quick", "advise", "learn", "explore", "council"]) {
  test(`legion ${command} requires text input without writing records`, async () => {
    const root = await tempRepo();
    try {
      const result = await runCliCapture(["--repository-root", root, command, "--json"]);
      assert.equal(result.exitCode, 1);
      const payload = parseJsonOutput(result);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "usage_error");
      assert.equal(payload.diagnostics[0]?.code, "usage_error");
      assert.match(payload.diagnostics[0]?.message, /requires/i);
      await assertPathMissing(path.join(root, ".legion", "project", "workflow", command));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("legion polish rejects non-path target text without writing records", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    const result = await runCliCapture(["--repository-root", root, "polish", "README cleanup", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "usage_error");
    assert.equal(payload.diagnostics[0]?.code, "usage_error");
    assert.match(payload.diagnostics[0]?.message, /Invalid polish target path/);
    await assertPathMissing(path.join(root, ".legion", "project", "workflow", "polish"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const retroCase of [
  { name: "valueless phase", args: ["retro", "--phase", "--json"], option: "phase" },
  { name: "blank phase", args: ["retro", "--phase=", "--json"], option: "phase" },
  { name: "valueless milestone", args: ["retro", "--milestone", "--json"], option: "milestone" },
  { name: "blank milestone", args: ["retro", "--milestone=", "--json"], option: "milestone" }
]) {
  test(`legion retro rejects ${retroCase.name} without writing records`, async () => {
    const root = await tempRepo();
    try {
      const result = await runCliCapture(["--repository-root", root, ...retroCase.args]);
      assert.equal(result.exitCode, 1);
      const payload = parseJsonOutput(result);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "usage_error");
      assert.match(payload.diagnostics[0]?.message, new RegExp(`--${retroCase.option}`));
      await assertPathMissing(path.join(root, ".legion", "project", "workflow", "retro"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const command of ["explore", "map", "quick", "advise", "polish", "learn", "milestone", "retro", "ship", "council"]) {
  test(`legion ${command} has a user-facing contract`, async () => {
    const result = await runCliCapture([command, "--help"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`legion ${command}`));
    assert.doesNotMatch(result.stdout, /worker bundle manifest/i);
    assert.doesNotMatch(result.stdout, /legion next/);
  });
}

test("legion plan phase blocks initialized projects without a roadmap source", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "plan", "1", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion explore");
    assert.equal(payload.diagnostics[0].code, "phase_source_missing");
    assert.match(payload.diagnostics[0].message, /No phase 1 source was found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase blocks uninitialized projects before using a roadmap source", async () => {
  const root = await tempRepo();
  try {
    await writeValidRoadmap(root);

    const result = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion start");
    assert.ok(payload.diagnostics.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase blocks invalid project state before using a roadmap source", async () => {
  const root = await tempRepo();
  try {
    await writeValidRoadmap(root);
    await mkdir(path.join(root, ".legion", "project"), { recursive: true });

    const result = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion validate");
    assert.equal(payload.diagnostics[0]?.code, "migration_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase dry-run resolves phase 1 from an explicit roadmap", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    const roadmapPath = await writeValidRoadmap(root);

    const result = await runCliCapture([
      "--repository-root", root,
      "plan", "--auto", "--auto-refine", "1",
      "--from-roadmap", "ROADMAP.md",
      "--dry-run",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "planned");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.autoRefine, true);
    assert.deepEqual(payload.diagnostics, []);
    assert.deepEqual(payload.phase, {
      number: 1,
      name: "Editor MVP",
      body: "Build the editor surface.\n\n### Acceptance\n- Asset metadata can be edited.",
      sourcePath: roadmapPath
    });
    assert.equal(payload.nextAction.command, "legion build");
    await assertPathMissing(path.join(root, ".legion", "project", "specs", "req_phase-1-editor-mvp.md"));
    await assertPathMissing(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "change.yaml"));
    await assertPathMissing(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "oracle", "orc_phase-1-editor-mvp.yaml"));
    await assertPathMissing(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "taskgraph.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase creates typed artifacts from an explicit roadmap", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const result = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "planned");
    assert.equal(payload.change.changeId, "chg_phase-1-editor-mvp");
    assert.equal(payload.oracle.oracleId, "orc_phase-1-editor-mvp");
    assert.equal(payload.taskgraph.artifactPath, ".legion/project/changes/chg_phase-1-editor-mvp/taskgraph.json");
    assert.equal(payload.nextAction.command, "legion build");
    assert.deepEqual(payload.diagnostics, []);

    await assertFileExists(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "change.yaml"));
    await assertFileExists(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "oracle", "orc_phase-1-editor-mvp.yaml"));
    await assertFileExists(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "taskgraph.json"));
    const taskgraph = await readJsonArtifact(root, payload.taskgraph.artifactPath);
    assert.deepEqual(taskgraph.parsed.tasks[0].verification[0], {
      command: "legion",
      args: ["validate"],
      expectedExitCode: 0,
      timeoutMs: 120000
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase reports repeat change conflict and reuses current spec", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    const first = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const firstPayload = parseJsonOutput(first);
    assert.equal(firstPayload.ok, true);
    assert.equal(firstPayload.status, "planned");

    const currentSpecPath = path.join(root, ".legion", "project", "specs", "req_phase-1-editor-mvp.md");
    await assertFileExists(currentSpecPath);

    const second = await runCliCapture([
      "--repository-root", root,
      "plan", "1",
      "--from-roadmap", "ROADMAP.md",
      "--json"
    ]);
    assert.equal(second.exitCode, 1);
    const secondPayload = parseJsonOutput(second);
    assert.equal(secondPayload.ok, false);
    assert.equal(secondPayload.status, "conflict");
    assert.equal(secondPayload.failedStep, "change");
    assert.equal(secondPayload.diagnostics[0]?.code, "artifact_already_exists");
    assert.equal(secondPayload.nextAction.command, "legion build");

    await assertFileExists(currentSpecPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase rejects missing or blank from-roadmap values", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);
    await writeValidRoadmap(root);

    for (const [label, roadmapArgs] of [
      ["valueless from-roadmap", ["--from-roadmap"]],
      ["empty from-roadmap", ["--from-roadmap="]],
      ["blank from-roadmap", ["--from-roadmap", "   "]]
    ]) {
      const result = await runCliCapture([
        "--repository-root", root,
        "plan", "1",
        ...roadmapArgs,
        "--json"
      ]);
      assert.equal(result.exitCode, 1, `${label} should be rejected`);
      const payload = parseJsonOutput(result);
      assert.equal(payload.status, "usage_error");
      assert.equal(payload.diagnostics[0]?.code, "usage_error");
      assert.match(payload.diagnostics[0]?.message, /--from-roadmap/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan phase requires a strict positive integer", async () => {
  const missing = await runCliCapture(["plan", "--json"]);
  assert.equal(missing.exitCode, 1);
  const missingPayload = parseJsonOutput(missing);
  assert.equal(missingPayload.status, "usage_error");
  assert.equal(missingPayload.diagnostics[0].message, "Missing phase number. Use: legion plan 1");

  for (const value of ["0", "-1", "1abc"]) {
    const result = await runCliCapture(["plan", value, "--json"]);
    assert.equal(result.exitCode, 1, `${value} should be rejected`);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "usage_error");
    assert.match(payload.diagnostics[0].message, /Invalid phase number/);
  }
});

test("legion start reports friendly usage and supports dry-run", async () => {
  const root = await tempRepo();
  try {
    const missingName = await runCliCapture(["--repository-root", root, "start", "--json"]);
    assert.equal(missingName.exitCode, 1);
    const missingNamePayload = parseJsonOutput(missingName);
    assert.equal(missingNamePayload.status, "usage_error");
    assert.match(missingNamePayload.diagnostics[0].message, /legion start --name "My Project"/);

    const valuelessName = await runCliCapture(["--repository-root", root, "start", "--name", "--dry-run", "--json"]);
    assert.equal(valuelessName.exitCode, 1);
    const valuelessNamePayload = parseJsonOutput(valuelessName);
    assert.equal(valuelessNamePayload.status, "usage_error");
    assert.equal(valuelessNamePayload.diagnostics[0].code, "usage_error");
    assert.match(valuelessNamePayload.diagnostics[0].message, /legion start --name "My Project"/);

    for (const option of ["owner", "created-at", "slug"]) {
      const result = await runCliCapture([
        "--repository-root", root,
        "start",
        "--name", "Asset Mapper",
        `--${option}`,
        "--dry-run",
        "--json"
      ]);
      assert.equal(result.exitCode, 1, `--${option} should require an explicit value`);
      const payload = parseJsonOutput(result);
      assert.equal(payload.status, "usage_error");
      assert.equal(payload.diagnostics[0].code, "usage_error");
    }

    const invalidOwner = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--owner", "a".repeat(129),
      "--dry-run",
      "--json"
    ]);
    assert.equal(invalidOwner.exitCode, 1);
    const invalidOwnerPayload = parseJsonOutput(invalidOwner);
    assert.equal(invalidOwnerPayload.status, "usage_error");
    assert.equal(invalidOwnerPayload.diagnostics[0].code, "usage_error");
    assert.match(invalidOwnerPayload.diagnostics[0].message, /Invalid --owner value/);

    for (const [label, ownerArgs] of [
      ["empty owner", ["--owner="]],
      ["blank owner", ["--owner", "   "]]
    ]) {
      const result = await runCliCapture([
        "--repository-root", root,
        "start",
        "--name", "Asset Mapper",
        ...ownerArgs,
        "--dry-run",
        "--json"
      ]);
      assert.equal(result.exitCode, 1, `${label} should reject explicit blank owner input`);
      const payload = parseJsonOutput(result);
      assert.equal(payload.status, "usage_error");
      assert.equal(payload.diagnostics[0].code, "usage_error");
      assert.match(payload.diagnostics[0].message, /Invalid --owner value/);
    }

    const invalidSlug = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--slug", "Invalid Slug",
      "--dry-run",
      "--json"
    ]);
    assert.equal(invalidSlug.exitCode, 1);
    const invalidSlugPayload = parseJsonOutput(invalidSlug);
    assert.equal(invalidSlugPayload.status, "usage_error");
    assert.equal(invalidSlugPayload.diagnostics[0].code, "usage_error");
    assert.match(invalidSlugPayload.diagnostics[0].message, /Invalid --slug value/);

    const omittedOwner = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--dry-run",
      "--json"
    ]);
    assert.equal(omittedOwner.exitCode, 0, omittedOwner.stderr);
    const omittedOwnerPayload = parseJsonOutput(omittedOwner);
    assert.equal(omittedOwnerPayload.status, "dry_run");
    assert.equal(omittedOwnerPayload.project.policy.decisionOwners[0].id, "operator");
    assert.equal(omittedOwnerPayload.project.policy.decisionOwners[0].displayName, "operator");

    const dryRun = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--dry-run",
      "--json"
    ]);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    const dryRunPayload = parseJsonOutput(dryRun);
    assert.equal(dryRunPayload.status, "dry_run");
    assert.equal(dryRunPayload.nextAction.command, "legion start");

    const status = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    const statusPayload = parseJsonOutput(status);
    assert.equal(statusPayload.workflowState.stage, "uninitialized");
    assert.equal(statusPayload.nextAction.command, "legion start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion validate and doctor report project and shallow path checks", async () => {
  const root = await tempRepo();
  try {
    const missing = await runCliCapture(["--repository-root", root, "validate", "--json"]);
    assert.equal(missing.exitCode, 1);
    const missingPayload = parseJsonOutput(missing);
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.status, "not_found");

    const start = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(start.exitCode, 0, start.stderr);

    const valid = await runCliCapture(["--repository-root", root, "validate", "--json"]);
    assert.equal(valid.exitCode, 0, valid.stderr);
    const validPayload = parseJsonOutput(valid);
    assert.equal(validPayload.ok, true);
    assert.equal(validPayload.status, "valid");

    const doctor = await runCliCapture(["--repository-root", root, "doctor", "--json"]);
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorPayload = parseJsonOutput(doctor);
    assert.equal(doctorPayload.ok, true);
    assert.equal(doctorPayload.checks.project.ok, true);
    assert.equal(doctorPayload.checks.operationalStore.ok, true);
    assert.equal(doctorPayload.checks.workerBundles.path, "bundles/index.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion doctor checks worker bundles from repository root when cwd differs", async () => {
  const root = await tempRepo();
  const otherCwd = await tempRepo();
  try {
    const start = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(start.exitCode, 0, start.stderr);

    await mkdir(path.join(root, "bundles"), { recursive: true });
    await writeFile(path.join(root, "bundles", "index.json"), "[]\n", "utf8");

    const doctor = await runCliCapture(["--repository-root", root, "doctor", "--json"], { cwd: otherCwd });
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorPayload = parseJsonOutput(doctor);
    assert.equal(doctorPayload.checks.workerBundles.ok, true);
    assert.equal(doctorPayload.checks.workerBundles.status, "present");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("legion doctor returns structured diagnostics for path check errors", async () => {
  const validateCommand = await import("../packages/cli/dist/commands/workflow/validate.js");
  const check = await validateCommand.pathCheck(`invalid\u0000root`, ".legion/var");

  assert.equal(check.ok, false);
  assert.equal(check.status, "error");
  assert.equal(check.path, ".legion/var");
  assert.match(check.message, /Failed to check \.legion\/var:/);
});

test("unknown workflow commands return usage errors", async () => {
  const result = await runCliCapture(["frobnicate", "--json"]);
  assert.equal(result.exitCode, 1);
  const payload = parseJsonOutput(result);
  assert.equal(payload.status, "usage_error");
  assert.match(payload.diagnostics[0].message, /Unknown workflow command: legion frobnicate/);
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
