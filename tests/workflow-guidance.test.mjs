import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-guidance-"));
}

async function initProject(root) {
  const result = await runCliCapture([
    "--repository-root", root,
    "start",
    "--name", "Asset Mapper",
    "--summary", "Metadata authoring and deterministic asset resolution",
    "--owner", "dasbl",
    "--created-at", "2026-06-23T12:00:00.000Z",
    "--json"
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  return parseJsonOutput(result);
}

async function readJson(root, artifactPath) {
  return JSON.parse(await readFile(path.join(root, ...artifactPath.split("/")), "utf8"));
}

async function assertFile(root, artifactPath) {
  const fileStat = await stat(path.join(root, ...artifactPath.split("/")));
  assert.equal(fileStat.isFile(), true, `${artifactPath} should exist`);
}

test("explore writes a guidance run before start and start accepts it", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture([
      "--repository-root", root,
      "explore", "asset metadata editor",
      "--executor", "fake",
      "--created-at", "2026-06-23T12:01:00.000Z",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "completed");
    assert.equal(payload.workflow, "explore");
    assert.match(payload.artifactPath, /^\.legion\/project\/workflow\/explore\/.+\/workflow-run\.json$/);
    assert.match(payload.markdownArtifactPath, /design\.md$/);

    const run = await readJson(root, payload.artifactPath);
    assert.equal(run.kind, "workflow_run");
    assert.equal(run.workflow, "explore");
    assert.equal(run.outputs.markdownArtifactPath, payload.markdownArtifactPath);
    await assertFile(root, payload.markdownArtifactPath);
    await assertFile(root, run.outputs.promptArtifactPath);
    await assertFile(root, run.outputs.resultArtifactPath);

    const start = await initProject(root);
    assert.equal(start.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("map refresh, check, and query produce deterministic codebase artifacts", async () => {
  const root = await tempRepo();
  try {
    await initProject(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "asset-service.ts"),
      [
        "export interface AssetRecord { id: string }\n",
        "export function resolveAsset(input: AssetRecord) { return input.id; }\n"
      ].join(""),
      "utf8"
    );
    await writeFile(path.join(root, "README.md"), "# Asset Mapper\n\nMetadata authoring.\n", "utf8");

    const refresh = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(refresh.exitCode, 0, refresh.stderr);
    const refreshPayload = parseJsonOutput(refresh);
    assert.equal(refreshPayload.status, "completed");
    assert.equal(refreshPayload.workflow, "map");
    assert.equal(refreshPayload.mode, "refresh");
    assert.equal(refreshPayload.sourceFileCount >= 2, true);
    await assertFile(root, refreshPayload.mapArtifactPath);
    const map = await readJson(root, refreshPayload.mapArtifactPath);
    assert.equal(map.kind, "codebase_map");
    assert.equal(map.files.some((file) => file.path === "src/asset-service.ts"), true);

    const check = await runCliCapture(["--repository-root", root, "map", "--check", "--json"]);
    assert.equal(check.exitCode, 0, check.stderr);
    const checkPayload = parseJsonOutput(check);
    assert.equal(checkPayload.status, "fresh");
    assert.equal(checkPayload.nextAction.command, "legion plan 1");

    const missingScope = await runCliCapture(["--repository-root", root, "map", "--check", "--scope", "missing", "--json"]);
    assert.equal(missingScope.exitCode, 1);
    const missingScopePayload = parseJsonOutput(missingScope);
    assert.equal(missingScopePayload.status, "usage_error");
    assert.match(missingScopePayload.diagnostics[0].message, /Unable to check codebase map/);

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--json"]);
    assert.equal(query.exitCode, 0, query.stderr);
    const queryPayload = parseJsonOutput(query);
    assert.equal(queryPayload.status, "completed");
    assert.equal(queryPayload.matches[0].path, "src/asset-service.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quick and polish create typed taskgraphs consumable by build", async () => {
  const root = await tempRepo();
  try {
    await initProject(root);
    await writeFile(path.join(root, "README.md"), "# Asset Mapper\n", "utf8");

    const quick = await runCliCapture([
      "--repository-root", root,
      "quick", "fix the failing tests",
      "--created-at", "2026-06-23T12:03:00.000Z",
      "--json"
    ]);
    assert.equal(quick.exitCode, 0, quick.stderr);
    const quickPayload = parseJsonOutput(quick);
    assert.equal(quickPayload.status, "planned");
    assert.equal(quickPayload.workflow, "quick");
    await assertFile(root, quickPayload.taskgraph.artifactPath);
    const quickTaskgraph = await readJson(root, quickPayload.taskgraph.artifactPath);
    assert.deepEqual(quickTaskgraph.tasks[0].scope.write, ["."], "quick tasks should be able to write implementation files");
    assert.deepEqual(
      quickTaskgraph.tasks[0].scope.read,
      [quickPayload.requestArtifactPath],
      "quick task text should not be parsed as a source path"
    );

    const quickBuild = await runCliCapture(["--repository-root", root, "build", "--executor", "fake", "--allow-dirty", "--json"]);
    assert.equal(quickBuild.exitCode, 0, quickBuild.stderr);
    assert.equal(parseJsonOutput(quickBuild).status, "executed");

    const polish = await runCliCapture([
      "--repository-root", root,
      "polish", "README.md",
      "--created-at", "2026-06-23T12:04:00.000Z",
      "--json"
    ]);
    assert.equal(polish.exitCode, 0, polish.stderr);
    const polishPayload = parseJsonOutput(polish);
    assert.equal(polishPayload.status, "planned");
    assert.equal(polishPayload.workflow, "polish");
    await assertFile(root, polishPayload.taskgraph.artifactPath);
    const polishTaskgraph = await readJson(root, polishPayload.taskgraph.artifactPath);
    assert.deepEqual(polishTaskgraph.tasks[0].scope.write, ["README.md"]);
    assert.deepEqual(polishTaskgraph.tasks[0].scope.read, ["README.md", polishPayload.requestArtifactPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advise learn retro and milestone write structured guidance state", async () => {
  const root = await tempRepo();
  try {
    await initProject(root);

    const advise = await runCliCapture(["--repository-root", root, "advise", "dependency risk", "--executor", "fake", "--json"]);
    assert.equal(advise.exitCode, 0, advise.stderr);
    const advisePayload = parseJsonOutput(advise);
    assert.equal(advisePayload.status, "completed");
    await assertFile(root, advisePayload.markdownArtifactPath);

    const learn = await runCliCapture(["--repository-root", root, "learn", "prefer artifact-backed plans", "--json"]);
    assert.equal(learn.exitCode, 0, learn.stderr);
    const learnPayload = parseJsonOutput(learn);
    assert.equal(learnPayload.status, "completed");
    const lessonIndex = await readJson(root, learnPayload.indexArtifactPath);
    assert.equal(lessonIndex.lessons.length, 1);

    const define = await runCliCapture(["--repository-root", root, "milestone", "--define", "MVP", "--phases", "1-3", "--json"]);
    assert.equal(define.exitCode, 0, define.stderr);
    assert.equal(parseJsonOutput(define).milestones[0].status, "defined");

    const complete = await runCliCapture(["--repository-root", root, "milestone", "--complete", "milestone-mvp", "--summary", "MVP complete", "--json"]);
    assert.equal(complete.exitCode, 0, complete.stderr);
    assert.equal(parseJsonOutput(complete).milestones[0].status, "completed");

    const archive = await runCliCapture(["--repository-root", root, "milestone", "--archive", "milestone-mvp", "--json"]);
    assert.equal(archive.exitCode, 0, archive.stderr);
    assert.equal(parseJsonOutput(archive).milestones[0].status, "archived");

    const missingComplete = await runCliCapture(["--repository-root", root, "milestone", "--complete", "milestone-missing", "--summary", "Nope", "--json"]);
    assert.equal(missingComplete.exitCode, 1);
    const missingCompletePayload = parseJsonOutput(missingComplete);
    assert.equal(missingCompletePayload.status, "usage_error");
    assert.equal(missingCompletePayload.diagnostics[0].message, "Milestone not found: milestone-missing");

    const missingArchive = await runCliCapture(["--repository-root", root, "milestone", "--archive", "milestone-missing", "--json"]);
    assert.equal(missingArchive.exitCode, 1);
    const missingArchivePayload = parseJsonOutput(missingArchive);
    assert.equal(missingArchivePayload.status, "usage_error");
    assert.equal(missingArchivePayload.diagnostics[0].message, "Milestone not found: milestone-missing");

    const retro = await runCliCapture(["--repository-root", root, "retro", "--executor", "fake", "--json"]);
    assert.equal(retro.exitCode, 0, retro.stderr);
    const retroPayload = parseJsonOutput(retro);
    assert.equal(retroPayload.status, "completed");
    await assertFile(root, retroPayload.markdownArtifactPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
