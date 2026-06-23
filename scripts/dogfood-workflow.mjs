#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGION_BIN = path.join(REPO_ROOT, "bin", "legion.js");
const DOGFOOD_ROADMAP = "LEGION-DOGFOOD-ROADMAP.md";
const CODEX_SMOKE_ARTIFACT = ".legion/project/workflow/build/2026-06-23T120000Z-codex-smoke.md";
const CREATED_AT = "2026-06-23T12:00:00.000Z";
const LIVE_CODEX_COMMAND_TIMEOUT_MS = 360_000;
const LIVE_CODEX_EXEC_TIMEOUT_MS = 300_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.executor === "codex" && !options.liveCodex) {
    throw new DogfoodError("Refusing to run the live Codex executor without --live-codex.");
  }
  if (options.executor === "codex") {
    const codex = runProcess("codex", ["exec", "--help"], { cwd: REPO_ROOT, timeoutMs: 10_000, allowFailure: true });
    if (codex.exitCode !== 0) {
      throw new DogfoodError(`Codex executor is unavailable: ${firstNonEmpty(codex.stderr, codex.stdout, "codex exec --help failed")}`);
    }
    process.env.LEGION_CODEX_EXEC_TIMEOUT_MS ??= String(LIVE_CODEX_EXEC_TIMEOUT_MS);
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "legion-dogfood-"));
  const workspace = path.join(tempRoot, "workspace");
  let ok = false;
  try {
    if (options.target === undefined) {
      await createSyntheticWorkspace(workspace);
    } else {
      cloneTarget(options.target, workspace);
    }
    if (options.executor === "codex") {
      await installLegionShim(tempRoot);
    }

    const initialStatus = runLegion(workspace, ["status"], { expectExitCode: 0 });
    assertEqual(initialStatus?.workflowState?.stage, "uninitialized", "initial status should be uninitialized", initialStatus);
    assertEqual(initialStatus?.nextAction?.command, "legion start", "initial next action should be legion start", initialStatus);

    const projectName = options.target === undefined ? "Legion Dogfood" : path.basename(path.resolve(options.target));
    const explore = runLegion(workspace, ["explore", "dogfood workflow guidance", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(explore.status, "completed", "explore should complete");
    assertArtifact(workspace, explore.markdownArtifactPath, "explore design artifact");

    const start = runLegion(workspace, [
      "start",
      "--name", projectName,
      "--summary", "Dogfood validation for the workflow-first Legion CLI",
      "--owner", "dogfood",
      "--created-at", CREATED_AT
    ], { expectExitCode: 0 });
    assertEqual(start.ok, true, "start should succeed");
    assertEqual(start.nextAction.command, "legion plan 1", "start should route to planning");
    assertFile(path.join(workspace, ".legion", "project", "project.json"), "project artifact");

    const mapRefresh = runLegion(workspace, ["map", "--refresh"], { expectExitCode: 0 });
    assertEqual(mapRefresh.status, "completed", "map refresh should complete");
    assertArtifact(workspace, mapRefresh.mapArtifactPath, "codebase map artifact");

    const mapCheck = runLegion(workspace, ["map", "--check"], { expectExitCode: 0 });
    assertEqual(mapCheck.status, "fresh", "map check should report fresh map");

    const advise = runLegion(workspace, ["advise", "dogfood release risk", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(advise.status, "completed", "advise should complete");
    assertArtifact(workspace, advise.markdownArtifactPath, "advice artifact");

    const learn = runLegion(workspace, ["learn", "dogfood runs must preserve the human review boundary"], { expectExitCode: 0 });
    assertEqual(learn.status, "completed", "learn should complete");
    assertArtifact(workspace, learn.indexArtifactPath, "learn index artifact");

    await writeDogfoodRoadmap(workspace);

    const plan = runLegion(workspace, ["plan", "1", "--from-roadmap", DOGFOOD_ROADMAP], { expectExitCode: 0 });
    assertEqual(plan.status, "planned", "plan should create a typed taskgraph");
    assertEqual(plan.nextAction.command, "legion build", "plan should route to build");
    assertArtifact(workspace, plan.taskgraph.artifactPath, "taskgraph artifact");
    if (options.executor === "codex") {
      await prepareCodexSmokeTask(workspace, plan.taskgraph.artifactPath);
    }

    const blockedBuild = runLegion(workspace, ["build", "--executor", options.executor], { expectExitCode: 1 });
    assertEqual(blockedBuild.status, "blocked", "dirty build should block");
    assertEqual(blockedBuild.diagnostics[0]?.code, "dirty_worktree", "dirty build should report dirty_worktree", blockedBuild.diagnostics);
    assertEqual(blockedBuild.nextAction.command, "legion build --allow-dirty", "dirty build should route to --allow-dirty");

    const build = runLegion(workspace, ["build", "--executor", options.executor, "--allow-dirty"], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(build.status, "executed", "build should execute");
    assertEqual(build.nextAction.command, "legion review", "build should route to review");
    assertEqual(Array.isArray(build.taskRuns), true, "build should report task runs");
    assertEqual(build.taskRuns.length > 0, true, "build should produce at least one task run");
    const firstRun = build.taskRuns[0];
    assertArtifact(workspace, firstRun.artifactPath, "task run artifact");
    const runRoot = path.dirname(path.join(workspace, ...firstRun.artifactPath.split("/")));
    assertFile(path.join(runRoot, "context-pack.md"), "context pack");
    assertFile(path.join(runRoot, "executor-result.json"), "executor result");
    if (options.executor === "codex") {
      assertArtifact(workspace, CODEX_SMOKE_ARTIFACT, "Codex smoke output");
    }
    assertArtifact(workspace, build.evidenceIndex.artifactPath, "evidence index");
    const evidenceBeforeReview = await readJson(path.join(workspace, ...build.evidenceIndex.artifactPath.split("/")));
    assertEqual(evidenceBeforeReview.entries.length > 0, true, "evidence index should contain entries");
    assertEqual(evidenceBeforeReview.entries.every((entry) => entry.acceptance.status === "pending"), true, "evidence should start pending");

    const review = runLegion(workspace, ["review", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(review.status, "submitted", "review should submit");
    assertEqual(review.nextAction.command, "legion review --accept", "passing review should require manual acceptance");
    const reviewArtifactPath = review.review?.artifactPath ?? review.reviews?.[0]?.artifactPath;
    assertEqual(typeof reviewArtifactPath, "string", "review should report an artifact path");
    assertArtifact(workspace, reviewArtifactPath, "review decision");

    const accepted = runLegion(workspace, ["review", "--accept"], { expectExitCode: 0 });
    assertEqual(accepted.status, "accepted", "review acceptance should succeed");
    assertEqual(accepted.nextAction.command, "legion ship", "accepted review should route to ship");

    const finalStatus = runLegion(workspace, ["status"], { expectExitCode: 0 });
    assertEqual(finalStatus.workflowState.stage, "ship_ready", "workflow should reach ship_ready");

    const ship = runLegion(workspace, ["ship"], { expectExitCode: 0 });
    assertEqual(ship.status, "ready", "ship readiness should pass");

    const retro = runLegion(workspace, ["retro", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(retro.status, "completed", "retro should complete");
    assertArtifact(workspace, retro.markdownArtifactPath, "retro artifact");

    const summary = {
      ok: true,
      executor: options.executor,
      source: options.target === undefined ? "synthetic" : path.resolve(options.target),
      workspace,
      projectId: start.project.id,
      changeId: plan.change.changeId,
      taskRuns: build.taskRuns.length,
      guidanceRuns: 6,
      finalStage: finalStatus.workflowState.stage,
      shipStatus: ship.status
    };
    ok = true;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write([
        "Legion dogfood workflow passed.",
        `Executor: ${summary.executor}`,
        `Source: ${summary.source}`,
        `Final stage: ${summary.finalStage}`,
        `Temp workspace: ${summary.workspace}`
      ].join("\n") + "\n");
    }
  } finally {
    if ((ok || !options.keepTemp) && !options.keepTemp) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        process.stderr.write(`Warning: Failed to clean up temp directory ${tempRoot}: ${errorMessage(cleanupError)}\n`);
      }
    } else if (!ok) {
      process.stderr.write(`Dogfood workspace preserved for debugging: ${workspace}\n`);
    }
  }
}

function parseArgs(args) {
  const options = {
    executor: "fake",
    target: undefined,
    liveCodex: false,
    keepTemp: false,
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--target":
        options.target = requiredValue(args, ++index, "--target");
        break;
      case "--executor":
        options.executor = requiredValue(args, ++index, "--executor");
        break;
      case "--live-codex":
        options.liveCodex = true;
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
        process.stdout.write(helpText());
        process.exit(0);
        break;
      default:
        throw new DogfoodError(`Unknown option: ${arg}`);
    }
  }
  if (!["fake", "manual", "codex"].includes(options.executor)) {
    throw new DogfoodError(`Unsupported executor "${options.executor}". Use fake, manual, or codex.`);
  }
  if (options.executor === "manual") {
    throw new DogfoodError("The manual executor intentionally blocks and cannot complete dogfood. Use --executor fake or --executor codex --live-codex.");
  }
  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new DogfoodError(`Missing required value for ${flag}.`);
  }
  return value;
}

function helpText() {
  return `Usage: pnpm workflow:dogfood -- [--target <repo>] [--executor fake|codex] [--live-codex] [--json] [--keep-temp]\n\nRuns the workflow-first Legion CLI loop in a temporary workspace.\n`;
}

async function createSyntheticWorkspace(workspace) {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Legion Dogfood Fixture\n", "utf8");
  runProcess("git", ["init", "-b", "main", workspace], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.email", "legion-dogfood@example.test"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.name", "Legion Dogfood"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "add", "."], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "commit", "-m", "initial dogfood fixture"], { cwd: REPO_ROOT });
}

async function installLegionShim(tempRoot) {
  const shimRoot = path.join(tempRoot, "bin");
  await mkdir(shimRoot, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(
      path.join(shimRoot, "legion.cmd"),
      `@echo off\r\n"${process.execPath}" "${LEGION_BIN}" %*\r\n`,
      "utf8"
    );
  } else {
    const shimPath = path.join(shimRoot, "legion");
    await writeFile(
      shimPath,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "${LEGION_BIN}" "$@"\n`,
      "utf8"
    );
    await chmod(shimPath, 0o755);
  }
  process.env.PATH = `${shimRoot}${path.delimiter}${process.env.PATH ?? ""}`;
}

function cloneTarget(target, workspace) {
  const source = path.resolve(target);
  if (!existsSync(source)) {
    throw new DogfoodError(`Target repository does not exist: ${source}`);
  }
  runProcess("git", ["clone", "--local", "--no-hardlinks", source, workspace], { cwd: REPO_ROOT, timeoutMs: 120_000 });
  runProcess("git", ["-C", workspace, "config", "user.email", "legion-dogfood@example.test"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.name", "Legion Dogfood"], { cwd: REPO_ROOT });
}

async function writeDogfoodRoadmap(workspace) {
  await writeFile(
    path.join(workspace, DOGFOOD_ROADMAP),
    [
      "# Legion Dogfood Roadmap",
      "",
      "## Phase 1: Dogfood Workflow",
      "Validate that Legion can guide a human-in-loop change from planning through ship readiness.",
      "",
      "### Acceptance",
      "- The CLI records a typed taskgraph.",
      "- The build step captures pending evidence.",
      "- The review step requires manual acceptance before ship readiness."
    ].join("\n") + "\n",
    "utf8"
  );
}

async function prepareCodexSmokeTask(workspace, taskgraphArtifactPath) {
  const taskgraphPath = path.join(workspace, ...taskgraphArtifactPath.split("/"));
  const taskgraph = await readJson(taskgraphPath);
  const task = taskgraph.tasks?.[0];
  if (task === undefined) {
    throw new DogfoodError("Planned taskgraph did not contain a task to adapt for live Codex smoke.");
  }
  task.title = "Create Legion dogfood Codex smoke artifact";
  task.objective = [
    `Create or update ${CODEX_SMOKE_ARTIFACT} with one short sentence saying the Legion Codex smoke task ran in this temporary clone.`,
    "Do not edit the taskgraph or any source files.",
    "Run legion validate before reporting."
  ].join(" ");
  task.scope = {
    ...task.scope,
    read: [DOGFOOD_ROADMAP, ".legion/project/project.json"],
    write: [CODEX_SMOKE_ARTIFACT],
    forbidden: [
      ...new Set([
        ...(Array.isArray(task.scope?.forbidden) ? task.scope.forbidden : []),
        taskgraphArtifactPath,
        ".legion/var/runtime.sqlite"
      ])
    ],
    sequentialFiles: [CODEX_SMOKE_ARTIFACT]
  };
  task.verification = [
    {
      command: "legion",
      args: ["validate"],
      expectedExitCode: 0,
      timeoutMs: 120000
    }
  ];
  task.completion = {
    ...task.completion,
    requiredEvidence: ["legion validate verification output"],
    blockedConditions: ["Codex smoke output is missing or legion validate fails."]
  };
  await writeFile(taskgraphPath, `${JSON.stringify(taskgraph, null, 2)}\n`, "utf8");
}

function runLegion(workspace, args, options) {
  const result = runProcess(process.execPath, [
    LEGION_BIN,
    "--repository-root", workspace,
    ...args,
    "--json"
  ], {
    cwd: REPO_ROOT,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowFailure: true
  });
  if (result.exitCode !== options.expectExitCode) {
    throw new DogfoodError([
      `legion ${args.join(" ")} exited ${result.exitCode}; expected ${options.expectExitCode}.`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter((line) => line.length > 0).join("\n"));
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new DogfoodError(`legion ${args.join(" ")} did not emit JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
  }
}

function runProcess(command, args, options) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const useWindowsShell = process.platform === "win32" && command === "codex";
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: useWindowsShell,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const output = {
    exitCode: timedOut ? 124 : result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
  if (result.error !== undefined) {
    const stderr = firstNonEmpty(
      output.stderr,
      timedOut ? `${command} ${args.join(" ")} timed out after ${timeoutMs}ms.` : result.error.message
    );
    if (options.allowFailure) {
      return {
        ...output,
        stderr
      };
    }
    throw new DogfoodError(stderr);
  }
  if (!options.allowFailure && output.exitCode !== 0) {
    throw new DogfoodError([
      `${command} ${args.join(" ")} exited ${output.exitCode}.`,
      output.stdout.trim(),
      output.stderr.trim()
    ].filter((line) => line.length > 0).join("\n"));
  }
  return output;
}

function assertArtifact(workspace, artifactPath, label) {
  assertFile(path.join(workspace, ...artifactPath.split("/")), label);
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new DogfoodError(`Missing ${label}: ${filePath}`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertEqual(actual, expected, message, context) {
  if (actual !== expected) {
    const contextText = context === undefined ? "" : `\nContext: ${JSON.stringify(context, null, 2)}`;
    throw new DogfoodError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${contextText}`);
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && String(value).trim().length > 0) ?? "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class DogfoodError extends Error {
  constructor(message) {
    super(message);
    this.name = "DogfoodError";
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
