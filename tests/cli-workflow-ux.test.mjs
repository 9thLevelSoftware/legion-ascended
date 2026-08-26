import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";
import { requireFileSymlink } from "./helpers/symlink-capability.mjs";

const execFileAsync = promisify(execFile);
const TEST_ROOT = process.cwd();
const LEGION_BIN = path.join(TEST_ROOT, "bin", "legion.js");
const GROK_FIXTURE_ROOT = path.join(TEST_ROOT, "tests", "fixtures", "grok");

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-workflow-ux-"));
}

async function initializeAssetMapperProject(root) {
  // A source file, so `legion map --refresh` has something to map. Refreshing an
  // empty tree used to write five artifacts describing nothing and report
  // success; it now refuses, so a fixture with no source is no longer a valid
  // stand-in for a project.
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "resolve-asset.ts"), "export function resolveAsset() {\n  return 1;\n}\n");
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
    if (!requireFileSymlink(t)) return;
    await symlink(outsidePath, targetPath, "file");

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

// Installs a fake `claude` on PATH whose stdout is `stdout` verbatim. The shim
// is a node script behind a platform launcher so the fixture JSON never has to
// survive batch-file quoting.
async function installClaudeShim(root, { stdout = "", exitCode = 0, sleepMs = 0, writePath, writeContent = "" } = {}) {
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const implPath = path.join(binDir, "claude-impl.mjs");
  await writeFile(
    implPath,
    [
      "const sleepMs = " + String(sleepMs) + ";",
      "const stdout = " + JSON.stringify(stdout) + ";",
      "const writePath = " + JSON.stringify(writePath) + ";",
      "const writeContent = " + JSON.stringify(writeContent) + ";",
      "if (writePath !== undefined) { const { writeFile } = await import(\"node:fs/promises\"); await writeFile(writePath, writeContent, \"utf8\"); }",
      "await new Promise((resolve) => { setTimeout(resolve, sleepMs); });",
      "if (stdout.length > 0) process.stdout.write(stdout);",
      "process.exit(" + String(exitCode) + ");"
    ].join("\n"),
    "utf8"
  );
  if (process.platform === "win32") {
    await writeFile(path.join(binDir, "claude.cmd"), `@echo off\r\nnode "%~dp0claude-impl.mjs"\r\n`, "utf8");
  } else {
    const shim = path.join(binDir, "claude");
    await writeFile(shim, `#!/usr/bin/env sh\nexec node "$(dirname "$0")/claude-impl.mjs"\n`, "utf8");
    await chmod(shim, 0o755);
  }
  return binDir;
}

// Installs a fake `grok` whose argv, stdin state, and output are deterministic.
// The executable is only placed on PATH for the duration of an individual test.
async function installGrokShim(root, {
  stdout = "",
  exitCode = 0,
  sleepMs = 0,
  version = "grok 1.0.10",
  recordPath
} = {}) {
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const implPath = path.join(binDir, "grok-impl.mjs");
  await writeFile(
    implPath,
    [
      "const args = process.argv.slice(2);",
      "const version = " + JSON.stringify(version) + ";",
      "const stdout = " + JSON.stringify(stdout) + ";",
      "const exitCode = " + String(exitCode) + ";",
      "const sleepMs = " + String(sleepMs) + ";",
      "const recordPath = " + JSON.stringify(recordPath) + ";",
      "if (recordPath !== undefined) { const { writeFile } = await import(\"node:fs/promises\"); await writeFile(recordPath, JSON.stringify({ args, stdinReadable: process.stdin.readable, stdinLength: process.stdin.readableLength }) + \"\\n\", \"utf8\"); }",
      "await new Promise((resolve) => { setTimeout(resolve, sleepMs); });",
      "if (args[0] === \"--version\") process.stdout.write(version); else if (stdout.length > 0) process.stdout.write(stdout);",
      "process.exit(exitCode);"
    ].join("\n"),
    "utf8"
  );
  if (process.platform === "win32") {
    await writeFile(path.join(binDir, "grok.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0grok-impl.mjs" %*\r\n`, "utf8");
  } else {
    const shim = path.join(binDir, "grok");
    await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "${binDir}/grok-impl.mjs" "$@"\n`, "utf8");
    await chmod(shim, 0o755);
  }
  return binDir;
}

function grokRunRequest(root, { readOnly = false, base = "chg_grok", run = "run_grok" } = {}) {
  const baseArtifactPath = `.legion/project/changes/${base}/runs/${run}`;
  const absolute = (name) => path.join(root, ".legion", "project", "changes", base, "runs", run, name);
  return {
    repositoryRoot: root,
    changeId: base,
    runId: run,
    task: { id: "ctr_grok" },
    mode: "build",
    executor: "grok",
    readOnly,
    prompt: "Return a Legion executor result.\nWith quotes: \"$`",
    contextPackArtifactPath: `${baseArtifactPath}/context-pack.md`,
    contextPackAbsolutePath: absolute("context-pack.md"),
    promptArtifactPath: `${baseArtifactPath}/executor-prompt.md`,
    promptAbsolutePath: absolute("executor-prompt.md"),
    resultArtifactPath: `${baseArtifactPath}/executor-result.json`,
    resultAbsolutePath: absolute("executor-result.json"),
    rawLogArtifactPath: `${baseArtifactPath}/executor-raw.log`,
    rawLogAbsolutePath: absolute("executor-raw.log"),
    redactedLogArtifactPath: `${baseArtifactPath}/executor-redacted.log`,
    redactedLogAbsolutePath: absolute("executor-redacted.log")
  };
}

function grokEnvelope(text, overrides = {}) {
  return JSON.stringify({
    text,
    stopReason: "completed",
    sessionId: "sess_grok_test",
    requestId: "req_grok_test",
    ...overrides
  });
}

async function withGrokShim(options, run) {
  const root = await tempRepo();
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.LEGION_GROK_EXEC_TIMEOUT_MS;
  const previousAgent = process.env.GROK_AGENT;
  const previousSession = process.env.GROK_SESSION_ID;
  const previousNoWarnings = process.env.NODE_NO_WARNINGS;
  try {
    const binDir = await installGrokShim(root, options);
    process.env.PATH = process.platform === "win32"
      ? `${binDir}${path.delimiter}${previousPath ?? ""}`
      : binDir;
    if (options.timeoutMs !== undefined) process.env.LEGION_GROK_EXEC_TIMEOUT_MS = String(options.timeoutMs);
    // Node 26 emits an expected SQLite ExperimentalWarning; isolate it for portable child stderr assertions.
    process.env.NODE_NO_WARNINGS = "1";
    delete process.env.GROK_AGENT;
    delete process.env.GROK_SESSION_ID;
    return await run(root, binDir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.LEGION_GROK_EXEC_TIMEOUT_MS;
    else process.env.LEGION_GROK_EXEC_TIMEOUT_MS = previousTimeout;
    if (previousAgent === undefined) delete process.env.GROK_AGENT;
    else process.env.GROK_AGENT = previousAgent;
    if (previousSession === undefined) delete process.env.GROK_SESSION_ID;
    else process.env.GROK_SESSION_ID = previousSession;
    if (previousNoWarnings === undefined) delete process.env.NODE_NO_WARNINGS;
    else process.env.NODE_NO_WARNINGS = previousNoWarnings;
    await rm(root, { recursive: true, force: true });
  }
}

async function installFixtureGrok(root, {
  responseFile,
  recordPath,
  mode = "success",
  sleepMs = 0
} = {}) {
  const binDir = path.join(root, "fake-grok-bin");
  await mkdir(binDir, { recursive: true });
  const fixture = path.join(GROK_FIXTURE_ROOT, "fake-grok.cjs");
  if (process.platform === "win32") {
    await writeFile(
      path.join(binDir, "grok.cmd"),
      `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\nexit /b %errorlevel%\r\n`,
      "utf8"
    );
  } else {
    const shim = path.join(binDir, "grok");
    await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, "utf8");
    await chmod(shim, 0o755);
  }
  return {
    binDir,
    env: {
      FAKE_GROK_RESPONSE_FILE: responseFile,
      FAKE_GROK_RECORD_FILE: recordPath,
      FAKE_GROK_MODE: mode,
      FAKE_GROK_SLEEP_MS: String(sleepMs)
    }
  };
}

async function withGrokFixture(root, options, run) {
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const recordPath = options.recordPath ?? path.join(root, "grok-invocations.jsonl");
  const fake = await installFixtureGrok(root, { ...options, recordPath });
  const pathValue = process.platform === "win32"
    ? `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`
    : `${fake.binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  const env = {
    ...process.env,
    ...fake.env,
    HOME: home,
    USERPROFILE: home,
    PATH: pathValue,
    NO_COLOR: "1",
    // Node 26 emits an expected SQLite ExperimentalWarning; keep it out of local Grok CLI stderr assertions.
    NODE_NO_WARNINGS: "1"
  };
  delete env.XAI_API_KEY;
  return run({ env, home, recordPath, fake });
}

test("installed Grok skill drives a real CLI build through the fake Grok executable", async () => {
  const root = await tempRepo();
  try {
    await withGrokFixture(
      root,
      { responseFile: path.join(GROK_FIXTURE_ROOT, "json-success.json") },
      async ({ env, recordPath }) => {
        const install = await execFileAsync(
          process.execPath,
          [LEGION_BIN, "install", "--target", "grok", "--local"],
          { cwd: root, env, encoding: "utf8", timeout: 30_000 }
        );
        assert.match(install.stdout, /Grok Build/);
        const skillPath = path.join(root, ".grok", "skills", "legion", "SKILL.md");
        assert.equal(existsSync(skillPath), true);
        assert.match(await readFile(skillPath, "utf8"), /legion build --json/);

        execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
        git(root, ["config", "user.email", "legion@example.com"]);
        git(root, ["config", "user.name", "Legion Test"]);
        await initializeAssetMapperProject(root);
        await writeValidRoadmap(root);
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", "initial workflow"]);
        const plan = await execFileAsync(
          process.execPath,
          [LEGION_BIN, "plan", "1", "--from-roadmap", "ROADMAP.md", "--json"],
          { cwd: root, env, encoding: "utf8", timeout: 30_000 }
        );
        assert.equal(plan.stderr, "");
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", "planned workflow"]);

        const build = await execFileAsync(
          process.execPath,
          [LEGION_BIN, "build", "--executor", "grok", "--allow-dirty", "--json"],
          { cwd: root, env, encoding: "utf8", timeout: 30_000 }
        );
        const buildPayload = JSON.parse(build.stdout.trim());
        assert.equal(buildPayload.status, "executed");

        const changeId = (await readdir(path.join(root, ".legion", "project", "changes")))[0];
        const runId = (await readdir(path.join(root, ".legion", "project", "changes", changeId, "runs")))[0];
        const result = JSON.parse(await readFile(
          path.join(root, ".legion", "project", "changes", changeId, "runs", runId, "executor-result.json"),
          "utf8"
        ));
        assert.equal(result.status, "succeeded");
        assert.equal(result.summary, "Fake Grok completed the resolver task.");
        assert.deepEqual(result.filesChanged, ["src/resolve-asset.ts"]);
        assert.match(await readFile(path.join(root, ".legion", "project", "changes", changeId, "runs", runId, "executor-raw.log"), "utf8"), /session_fake_grok/);

        const records = (await readFile(recordPath, "utf8"))
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.equal(records.length, 1);
        const canonicalRoot = await realpath(root);
        assert.deepEqual(records[0].args, [
          "--prompt-file",
          path.join(canonicalRoot, ".legion", "project", "changes", changeId, "runs", runId, "executor-prompt.md"),
          "--cwd",
          canonicalRoot,
          "--output-format",
          "json",
          "--permission-mode",
          "bypassPermissions"
        ]);
        assert.equal(records[0].stdinLength, 0);
        assert.equal(records[0].xaiApiKeyPresent, false);
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("workflow grok executor args are argv-safe and add read-only sandboxing", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const promptPath = "/tmp/prompt with \"quotes\"/$value/line\nnext.md";
  assert.deepEqual(adapters.grokExecArgs({ repositoryRoot: "/repo with spaces", prompt: promptPath }), [
    "--prompt-file",
    promptPath,
    "--cwd",
    "/repo with spaces",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions"
  ]);
  assert.deepEqual(adapters.grokExecArgs({ repositoryRoot: "/repo", prompt: promptPath, readOnly: true }), [
    "--prompt-file",
    promptPath,
    "--cwd",
    "/repo",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--sandbox",
    "read-only"
  ]);
});

test("workflow grok executor normalizes the JSON envelope and never sends prompt stdin", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const contract = JSON.stringify({
    status: "succeeded",
    summary: "Implemented the resolver.",
    filesChanged: ["src/resolve-asset.ts"],
    commandsRun: [{ command: "pnpm", args: ["test"], exitCode: 0 }],
    findings: [],
    reviewVerdicts: { specification: "pass", integration: "pass", evidence: "pass" }
  });
  await withGrokShim({ stdout: grokEnvelope(contract) }, async (root) => {
    const recordPath = path.join(root, "grok-record.json");
    // Install a second shim with a fixture-local record destination; this keeps
    // the invocation evidence inside the temporary repository.
    const binDir = await installGrokShim(root, { stdout: grokEnvelope(contract), recordPath });
    process.env.PATH = process.platform === "win32" ? `${binDir}${path.delimiter}${process.env.PATH ?? ""}` : binDir;
    const result = await adapters.adapterForKind("grok").run(grokRunRequest(root));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "succeeded");
    assert.equal(result.summary, "Implemented the resolver.");
    assert.deepEqual(result.filesChanged, ["src/resolve-asset.ts"]);
    assert.deepEqual(result.commandsRun, [{ command: "pnpm", args: ["test"], exitCode: 0 }]);
    assert.equal(result.structuredOutput, contract);
    const invocation = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(invocation.args, [
      "--prompt-file",
      grokRunRequest(root).promptAbsolutePath,
      "--cwd",
      root,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions"
    ]);
    assert.equal(invocation.stdinLength, 0);
    const written = await readJsonArtifact(root, ".legion/project/changes/chg_grok/runs/run_grok/executor-result.json");
    assert.equal(written.parsed.summary, "Implemented the resolver.");
  });
});

test("workflow grok executor fails closed for error, malformed, empty, and partial envelopes", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const cases = [
    { name: "error", stdout: grokEnvelope("", { type: "error", error: "rate limited" }) },
    { name: "malformed", stdout: "{\"text\":\"unterminated" },
    { name: "empty", stdout: "" },
    { name: "partial-envelope", stdout: JSON.stringify({ text: "{}", stopReason: "completed" }) },
    { name: "partial-result", stdout: grokEnvelope(JSON.stringify({ status: "succeeded", summary: "partial" })) }
  ];
  for (const [index, entry] of cases.entries()) {
    await withGrokShim({ stdout: entry.stdout }, async (root) => {
      const result = await adapters.adapterForKind("grok").run(grokRunRequest(root, { base: `chg_grok_${index}`, run: `run_grok_${index}` }));
      assert.equal(result.ok, false, entry.name);
      assert.equal(result.status === "failed" || result.status === "blocked", true, entry.name);
      assert.equal(result.findings.some((finding) => finding.severity === "blocking"), true, entry.name);
    });
  }
});

test("workflow grok executor fails nonzero and timeout runs closed", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  await withGrokShim({ stdout: grokEnvelope(JSON.stringify({ status: "succeeded", summary: "Done.", filesChanged: [], commandsRun: [], findings: [] })), exitCode: 7 }, async (root) => {
    const result = await adapters.adapterForKind("grok").run(grokRunRequest(root, { base: "chg_grok_nonzero", run: "run_grok_nonzero" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 7);
    assert.equal(result.findings.some((finding) => finding.id === "grok-executor-failed"), true);
  });
  await withGrokShim({ sleepMs: 5_000, timeoutMs: 50 }, async (root) => {
    const result = await adapters.adapterForKind("grok").run(grokRunRequest(root, { base: "chg_grok_timeout", run: "run_grok_timeout" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.exitCode, 124);
    assert.equal(result.findings.some((finding) => finding.id === "grok-executor-timeout"), true);
  });
});

test("workflow grok availability validates semver and nested auto-selection guard", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  await withGrokShim({ version: "grok 1.0.10" }, async () => {
    assert.equal(await adapters.grokAvailable(), true);
    assert.equal(await adapters.selectExecutionAdapterKind(undefined), "grok");
    process.env.GROK_AGENT = "1";
    assert.equal(await adapters.selectExecutionAdapterKind(undefined), "manual");
    assert.equal(await adapters.selectExecutionAdapterKind("grok"), "grok");
    delete process.env.GROK_AGENT;
    process.env.GROK_SESSION_ID = "session-1";
    assert.equal(await adapters.selectExecutionAdapterKind(undefined), "manual");
    assert.equal(await adapters.selectExecutionAdapterKind("grok"), "grok");
  });
  for (const version of [
    "grok 1.0.10.11",
    "grok 1.0",
    "grok 1.0.10 extra semver 2.3.4",
    "unrelated 1.0.10",
    "version 1.0.10",
    "grok unknown"
  ]) {
    await withGrokShim({ version }, async () => {
      assert.equal(await adapters.grokAvailable(), false, `malformed Grok version accepted: ${version}`);
    });
  }
  for (const version of [
    "grok 1.0.10-alpha.1",
    "grok 1.0.10+build.7",
    "grok 1.0.10-alpha.1+build.7",
    "grok 1.0.10 (5992780042ca) [alpha]"
  ]) {
    await withGrokShim({ version }, async () => {
      assert.equal(await adapters.grokAvailable(), true, `valid Grok version rejected: ${version}`);
    });
  }
});

function claudeRunRequest(root, { readOnly = false, base = "chg_claude", run = "run_claude" } = {}) {
  const baseArtifactPath = `.legion/project/changes/${base}/runs/${run}`;
  const absolute = (name) => path.join(root, ".legion", "project", "changes", base, "runs", run, name);
  return {
    repositoryRoot: root,
    changeId: base,
    runId: run,
    task: { id: "ctr_claude" },
    mode: "build",
    executor: "claude",
    readOnly,
    prompt: "Return a Legion executor result.",
    contextPackArtifactPath: `${baseArtifactPath}/context-pack.md`,
    contextPackAbsolutePath: absolute("context-pack.md"),
    promptArtifactPath: `${baseArtifactPath}/executor-prompt.md`,
    promptAbsolutePath: absolute("executor-prompt.md"),
    resultArtifactPath: `${baseArtifactPath}/executor-result.json`,
    resultAbsolutePath: absolute("executor-result.json"),
    rawLogArtifactPath: `${baseArtifactPath}/executor-raw.log`,
    rawLogAbsolutePath: absolute("executor-raw.log"),
    redactedLogArtifactPath: `${baseArtifactPath}/executor-redacted.log`,
    redactedLogAbsolutePath: absolute("executor-redacted.log")
  };
}

function claudeEnvelope(overrides = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess_test",
    num_turns: 1,
    permission_denials: [],
    api_error_status: null,
    ...overrides
  });
}

async function withClaudeShim(options, run) {
  const root = await tempRepo();
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS;
  try {
    const binDir = await installClaudeShim(root, options);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    if (options.timeoutMs !== undefined) process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS = String(options.timeoutMs);
    return await run(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS;
    else process.env.LEGION_CLAUDE_EXEC_TIMEOUT_MS = previousTimeout;
    await rm(root, { recursive: true, force: true });
  }
}

test("workflow claude executor args match the claude print surface", async () => {
  const adapters = await importWorkflowModule("executor/adapters");

  assert.deepEqual(adapters.claudeExecArgs({ readOnly: false }), [
    "--print",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions"
  ]);

  // Read-only has no OS sandbox behind it, so the denial list is the whole of
  // the guarantee and the test names it rather than checking a flag is present.
  assert.deepEqual(adapters.claudeExecArgs({ readOnly: true }), [
    "--print",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "Edit Write NotebookEdit Bash"
  ]);

  const writeArgs = adapters.claudeExecArgs({ readOnly: false });
  assert.equal(writeArgs.includes("--dangerously-skip-permissions"), false);
  assert.equal(writeArgs.includes("--allow-dangerously-skip-permissions"), false);
});

test("workflow claude executor reads the contract reply out of the result envelope", async () => {
  const contract = JSON.stringify({
    status: "succeeded",
    summary: "Implemented the resolver.",
    filesChanged: ["src/resolve-asset.ts"],
    commandsRun: [{ command: "pnpm", args: ["test"], exitCode: 0 }],
    findings: []
  });
  const adapters = await importWorkflowModule("executor/adapters");

  await withClaudeShim({ stdout: claudeEnvelope({ result: contract }) }, async (root) => {
    const result = await adapters.adapterForKind("claude").run(claudeRunRequest(root));

    assert.equal(result.ok, true);
    assert.equal(result.status, "succeeded");
    assert.equal(result.summary, "Implemented the resolver.");
    assert.deepEqual(result.filesChanged, ["src/resolve-asset.ts"]);
    // The envelope's `result` field, not the whole transcript.
    assert.equal(result.structuredOutput, contract);

    const written = await readJsonArtifact(root, ".legion/project/changes/chg_claude/runs/run_claude/executor-result.json");
    assert.equal(written.parsed.status, "succeeded");
  });
});

test("workflow claude executor fails an in-band API error that exits zero", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  // claude exits 0 and reports the failure inside the envelope, so a status
  // taken from the exit code alone would record this run as a success.
  const stdout = claudeEnvelope({
    is_error: true,
    subtype: "error_during_execution",
    api_error_status: "429",
    result: "Rate limited."
  });

  await withClaudeShim({ stdout, exitCode: 0 }, async (root) => {
    const result = await adapters.adapterForKind("claude").run(claudeRunRequest(root));

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /API status 429/u);
  });
});

test("workflow claude executor records a denied tool as a blocking finding", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  // A denial is how a run reports success having been stopped from doing the
  // work, so it has to reach the result rather than only the transcript.
  const stdout = claudeEnvelope({
    result: JSON.stringify({ status: "succeeded", summary: "Done." }),
    permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_1" }]
  });

  await withClaudeShim({ stdout }, async (root) => {
    const result = await adapters.adapterForKind("claude").run(claudeRunRequest(root, { readOnly: true }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    const denial = result.findings.find((finding) => finding.id === "claude-executor-permission-denied");
    assert.ok(denial, "a denied tool should be recorded as a finding");
    assert.equal(denial.severity, "blocking");
    assert.match(denial.body, /Write/u);
  });
});

test("workflow claude executor times out with a blocked result", async () => {
  const adapters = await importWorkflowModule("executor/adapters");

  await withClaudeShim({ sleepMs: 5_000, timeoutMs: 50 }, async (root) => {
    const result = await adapters.adapterForKind("claude").run(claudeRunRequest(root));

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.exitCode, 124);
    assert.equal(result.findings.some((finding) => finding.id === "claude-executor-timeout"), true);
    const written = await readJsonArtifact(root, ".legion/project/changes/chg_claude/runs/run_claude/executor-result.json");
    assert.equal(written.parsed.status, "blocked");
  });
});

test("workflow executor selection accepts claude and names it when rejecting", async () => {
  const adapters = await importWorkflowModule("executor/adapters");

  assert.equal(await adapters.selectExecutionAdapterKind("claude"), "claude");
  assert.equal(adapters.adapterForKind("claude").kind, "claude");

  const rejected = await adapters.selectExecutionAdapterKind("bogus");
  assert.equal(typeof rejected, "object");
  assert.equal(rejected.diagnostic.code, "invalid_executor");
  assert.match(rejected.diagnostic.message, /claude, codex, hermes, grok, manual, or fake/u);
});

test("workflow executor selection accepts hermes and adapter returns correct kind", async () => {
  const adapters = await importWorkflowModule("executor/adapters");

  assert.equal(await adapters.selectExecutionAdapterKind("hermes"), "hermes");
  assert.equal(adapters.adapterForKind("hermes").kind, "hermes");
});

test("workflow executor auto-selection does not nest a claude run inside Claude Code", async () => {
  const adapters = await importWorkflowModule("executor/adapters");
  const previousMarker = process.env["CLAUDECODE"];
  const previousPath = process.env.PATH;

  const root = await tempRepo();
  try {
    // A claude that is unambiguously installed, so the only thing that can keep
    // auto-selection off it is the session marker.
    const binDir = await installClaudeShim(root, { stdout: claudeEnvelope() });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    process.env["CLAUDECODE"] = "1";
    assert.notEqual(
      await adapters.selectExecutionAdapterKind(undefined),
      "claude",
      "auto-selection inside a Claude Code session must not spawn a nested claude run"
    );
    // Named explicitly it still runs — the guard is on the default, not the verb.
    assert.equal(await adapters.selectExecutionAdapterKind("claude"), "claude");

    delete process.env["CLAUDECODE"];
    assert.equal(await adapters.selectExecutionAdapterKind(undefined), "claude");
  } finally {
    if (previousMarker === undefined) delete process.env["CLAUDECODE"];
    else process.env["CLAUDECODE"] = previousMarker;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("core workflow commands expose command-specific help", async () => {
  const cases = [
    ["start", /legion start --name <name>/],
    ["plan", /legion plan <phase-number>/],
    ["build", /legion build \[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["review", /legion review \[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["advise", /legion advise <topic> \[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["explore", /legion explore <topic> .*\[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["retro", /legion retro .*\[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["council", /legion council <topic> \[--executor claude\|codex\|hermes\|grok\|manual\|fake\]/],
    ["approve", /legion approve <subject>/],
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

    // Accepting a review advances the workflow to ship_ready; it does not make
    // the change shippable. An R2 phase still requires approved delta specs, a
    // protected oracle, integration checks and a whole-change sign-off, and this
    // fixture runs neither `legion approve spec` nor an accept with an
    // `--approver`, declares no verification surface and names no oracle — so
    // four gates block and the payload names each of them.
    //
    // This assertion used to be `some(entry => entry.code === "risk_gate_unevaluable")`
    // — a shrug at "something is unproven". That was as much as could be said
    // while no gate had a producer and the blocked payload carried no gate id.
    // Now that `approved_delta_spec` has one and the diagnostic carries `gate`,
    // the fixture names it. The difference matters: with the loose assertion, a
    // later change that satisfied `approved_delta_spec` and broke a different
    // gate would leave this test green for the wrong reason, and so would one
    // that stopped deriving R2's gates entirely.
    //
    // This fixture is now also the counterweight to the dogfood, which certifies
    // `ready` for an R2 change from this release onward. Nothing here may be
    // relaxed to match it: the difference between the two is the whole claim —
    // an interviewed R2 change with an approved spec, a declared surface and a
    // named approver ships, and this one, which has none of those, does not.
    const ship = await runCliCapture(["--repository-root", root, "ship", "--json"]);
    assert.equal(ship.exitCode, 1);
    const shipPayload = parseJsonOutput(ship);
    assert.equal(shipPayload.status, "blocked");
    assert.ok(shipPayload.diagnostics.length > 0, "blocked ship should name unproven gates");

    const deltaSpecGate = shipPayload.diagnostics.filter((entry) => entry.gate === "approved_delta_spec");
    // One, not one per task. This fixture has a single task, so it passes with
    // or without the change-scoped collapse — tests/ship-gate-diagnostics holds
    // that rule against a two-task list, and this only checks that nothing here
    // duplicates it.
    assert.equal(deltaSpecGate.length, 1, "the delta-spec gate should be named once, for the change");
    assert.equal(deltaSpecGate[0].code, "risk_gate_unevaluable");
    assert.match(deltaSpecGate[0].message, /No approval records anyone approving the delta spec for req_/);

    // The integration gate now has a producer too, and this fixture's interview
    // declares no verification surface — so it must report the *absent* answer
    // and not the negative one. That distinction is the whole point of the gate:
    // `unevaluable` says nobody declared anything, `unsatisfied` would say
    // somebody declared that nothing crosses a boundary. It also proves the
    // absent-declaration path is a verdict rather than a crash, which is the
    // failure mode a gate reading `task.verification` invites.
    //
    // Change-scoped, like `approved_delta_spec` above: ADR-006 asks whether
    // verification reaches the relevant interface *for the change*, and
    // `legion plan` materializes one task per executable criterion — so a
    // task-scoped version would let one honestly-declared `unit` criterion block
    // a change that does reach a real interface. One task here, so this passes
    // with or without the collapse; the witness is in
    // tests/verification-surface-gate against a three-task list.
    const integrationGate = shipPayload.diagnostics.filter(
      (entry) => entry.gate === "integration_or_real_interface_checks"
    );
    assert.equal(integrationGate.length, 1, "the integration gate should be named once, for the change");
    assert.equal(integrationGate[0].code, "risk_gate_unevaluable");
    assert.match(integrationGate[0].message, /declares a verification surface/);
    assert.match(
      integrationGate[0].message,
      /is not satisfied for chg_/,
      "a change-scoped verdict names the change as its subject, not the task"
    );

    // And whole-change acceptance, which this fixture reaches by the one route
    // that produces its *honest* middle answer: `legion review --accept` with no
    // `--approver`. Every task's evidence is accepted and nobody named signed
    // off on the change as a whole, so the bundle records `{status: "ready"}` —
    // short of accepted, and reported as `unevaluable` rather than as a
    // negative, because nobody was asked.
    //
    // This is also where the R2 answer to "what did the accept actually write"
    // is pinned. Before this release the gate had no producer at all and this
    // sentence read "Legion does not yet produce evidence for this gate."
    const acceptanceGate = shipPayload.diagnostics.filter(
      (entry) => entry.gate === "whole_change_acceptance_evidence"
    );
    assert.equal(acceptanceGate.length, 1, "the acceptance gate should be named once, for the change");
    assert.equal(acceptanceGate[0].code, "risk_gate_unevaluable");
    assert.match(acceptanceGate[0].message, /no named approver signed off on the change as a whole/);
    assert.match(
      acceptanceGate[0].message,
      /is not satisfied for chg_/,
      "a change-scoped verdict names the change as its subject, not the task"
    );

    // The block has a route out, and this is the assertion that could not be
    // made before: `legion build` cannot produce an approval, so a blocked ship
    // that advised only a build sent the operator round a loop. Four gates are
    // unmet here with three distinct repairs, so the advice cannot claim one
    // command unblocks the ship — but the command it dispatches must still be one
    // of the three, not the fallback. That last part is this release's correction:
    // `nextAction.command` was `legion build` in every mixed state, which is a
    // command no unmet gate here claims can produce anything.
    assert.equal(shipPayload.nextAction.command, "legion approve spec --approver <id>");
    assert.match(shipPayload.nextAction.reason, /legion approve spec/);
    assert.match(shipPayload.nextAction.reason, /No single command unblocks this ship/);
    // `legion review`, not `legion review --accept --approver`, and the
    // difference is the point. This fixture reached `ready` by running the accept
    // *without* `--approver`, which flipped the covering review from `submitted`
    // to `accepted` — and `legion review --accept` refuses evidence no clean
    // submitted review covers, so re-running it here exits 1 with
    // `review_not_clean`. The gate used to name it anyway, in this exact state,
    // which is the highest-frequency operator mistake this release introduces.
    // The route out is a fresh review first, then the accept.
    assert.match(shipPayload.nextAction.reason, /legion start --intake, legion review\./);
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
    // Staged, not completed: recording is the second step, and the next action
    // names the run to save, so it varies per invocation.
    status: "staged",
    nextAction: /^legion retro --save .+-retro$/,
    outputKey: "markdownArtifactPath",
    slug: "retro"
  },
  {
    // --define rather than --status: status is a read and writes no run record,
    // which is what P16-B012 fixed. Reading state used to append a run on every
    // invocation, so this case was asserting the defect.
    name: "milestone",
    args: ["milestone", "--define", "MVP", "--phases", "1-3", "--json"],
    workflow: "milestone",
    status: "completed",
    nextAction: "legion status",
    outputKey: "markdownArtifactPath",
    slug: "milestone-mvp"
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
      if (recordCase.nextAction instanceof RegExp) {
        assert.match(payload.nextAction.command, recordCase.nextAction);
      } else {
        assert.equal(payload.nextAction.command, recordCase.nextAction);
      }
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

test("legion map --check reports freshness and writes nothing", async () => {
  const root = await tempRepo();
  try {
    await initializeAssetMapperProject(root);

    const result = await runCliCapture(["--repository-root", root, "map", "--check", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "absent", "no map has been generated in this fixture");
    assert.equal(payload.workflow, "map");
    assert.equal(payload.mode, "check");
    assert.equal(payload.nextAction.command, "legion map --refresh");
    // A check compares two fingerprints. Recording it evicted the refresh that
    // produced the map from the twenty-run window getLatestCodebaseMap scans.
    assert.equal(Object.hasOwn(payload, "artifactPath"), false, "a check must not write a run record");
    await assertPathMissing(path.join(root, ".legion", "project", "workflow", "map"));
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

for (const command of ["explore", "map", "quick", "advise", "polish", "learn", "milestone", "retro", "ship", "approve", "council"]) {
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
      // --auto was passed here and plan has never read it: the sweep found it
      // advertised in commands/plan.md and echoed into the payload without
      // affecting anything. Declared options refuse it now, so the test no
      // longer asserts a flag the command ignores.
      "plan", "--auto-refine", "1",
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
    // A project with no interview has no criteria to derive commands from, so
    // its acceptance surface is the single inspection oracle.
    assert.deepEqual(
      payload.oracles.map((entry) => entry.oracleId),
      ["orc_phase-1-editor-mvp"]
    );
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
    // `legion start` with no arguments used to be a usage error. It is now the
    // preparation entrance. It persists the project classification before a
    // session exists and asks exactly one initiative question when no goal or
    // compatible exploration can supply one.
    const bare = await runCliCapture(["--repository-root", root, "start", "--json"]);
    assert.equal(bare.exitCode, 0, bare.stderr);
    const barePayload = parseJsonOutput(bare);
    assert.equal(barePayload.status, "preflight");
    assert.equal(barePayload.preparation.status, "initiative_required");
    assert.equal(barePayload.preparation.initiativeQuestion.kind, "free-text");
    assert.equal(barePayload.session, undefined, "preparation must not allocate a throwaway session");

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

test("read-only guidance runs contain Claude writes outside the artifact scope", async (t) => {
  const guidance = await importWorkflowModule("guidance-run");
  const root = await tempRepo();
  const previousPath = process.env.PATH;
  const unauthorizedPath = path.join(root, "unauthorized.txt");
  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await writeFile(path.join(root, "README.md"), "before\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initial"]);

    const binDir = await installClaudeShim(root, {
      stdout: claudeEnvelope({ result: JSON.stringify({ status: "succeeded", summary: "Done." }) }),
      writePath: unauthorizedPath,
      writeContent: "must not survive\n"
    });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    const paths = await guidance.createGuidanceRunPaths({
      repositoryRoot: root,
      workflow: "advise",
      slugSource: "unsafe guidance",
      createdAt: "2026-06-22T12:00:00.000Z"
    });
    const executed = await guidance.runGuidanceExecutor({
      context: {
        args: { options: new Map() },
        repositoryRoot: root,
        json: true,
        noColor: true,
        cwd: root
      },
      paths,
      workflow: "advise",
      topic: "unsafe guidance",
      prompt: "Review the repository.",
      readOnly: true,
      explicitExecutor: "claude"
    });

    assert.equal("exitCode" in executed, false);
    assert.equal(executed.result.ok, false);
    assert.equal(executed.result.status, "blocked");
    assert.match(executed.result.summary, /protected|contract|reconciliation/i);
    // The guarded harness blocks the result and leaves ordinary worktree
    // changes for the operator to inspect; its automatic restoration boundary
    // is the Legion control plane, not arbitrary source files.
    assert.equal(existsSync(unauthorizedPath), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("legion start help presents preparation decisions without calling bare start and --next equivalent", async () => {
  const result = await runCliCapture(["start", "--help"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--goal <text>/);
  assert.match(result.stdout, /--without-exploration/);
  assert.match(result.stdout, /--stage-draft <file>/);
  assert.match(result.stdout, /--accept-draft(?:\s|$)/m);
  assert.match(result.stdout, /--discard-draft(?:\s|$)/m);
  assert.match(result.stdout, /accept.*revise.*discard/is);
  assert.doesNotMatch(result.stdout, /the same question/i);
});

test("legion explore help describes the live start handoff instead of the stale disconnected flow", async () => {
  const result = await runCliCapture(["explore", "--help"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /start automatically selects a compatible completed exploration/i);
  assert.match(result.stdout, /--from-exploration <id>/);
  assert.match(result.stdout, /--without-exploration/);
  assert.doesNotMatch(result.stdout, /does not read explorations|handoff is not wired/i);
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
