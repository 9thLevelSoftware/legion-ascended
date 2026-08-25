import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

    // Pinned: the map was generated at 2026-06-23, and freshness now includes a
    // 30-day age limit, so checking with the wall clock would correctly report
    // stale and say nothing about the fingerprint comparison under test.
    const check = await runCliCapture([
      "--repository-root", root, "map", "--check", "--created-at", "2026-06-23T12:05:00.000Z", "--json"
    ]);
    assert.equal(check.exitCode, 0, check.stderr);
    const checkPayload = parseJsonOutput(check);
    assert.equal(checkPayload.status, "fresh");
    assert.equal(checkPayload.nextAction.command, "legion plan 1");

    const missingScope = await runCliCapture(["--repository-root", root, "map", "--check", "--scope", "missing", "--json"]);
    assert.equal(missingScope.exitCode, 1);
    const missingScopePayload = parseJsonOutput(missingScope);
    assert.equal(missingScopePayload.status, "usage_error");
    assert.match(missingScopePayload.diagnostics[0].message, /Unable to read the codebase map/);

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(query.exitCode, 0, query.stderr);
    const queryPayload = parseJsonOutput(query);
    assert.equal(queryPayload.status, "completed");
    assert.equal(queryPayload.matches[0].path, "src/asset-service.ts");

    // Neither a check nor a query is a change, so neither leaves a run record.
    // getLatestCodebaseMap scans the newest twenty map runs to find the map, so
    // recording reads evicted the refresh that produced it.
    const mapRuns = await readdir(path.join(root, ".legion", "project", "workflow", "map"));
    assert.equal(mapRuns.length, 1, `expected only the refresh to be recorded, found ${mapRuns.join(", ")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structural map refresh persists a semantic snapshot, supports query and why, and has profile-aware freshness", async () => {
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Structural Map\n", "utf8");
    await writeFile(
      path.join(root, "src", "asset-service.ts"),
      "export interface AssetRecord { id: string }\nexport function resolveAsset(input: AssetRecord) { return input.id; }\n",
      "utf8"
    );

    const absent = await runCliCapture(["--repository-root", root, "map", "--check", "--profile", "structural", "--json"]);
    assert.equal(absent.exitCode, 0, absent.stderr);
    assert.equal(parseJsonOutput(absent).status, "absent");

    const refresh = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(refresh.exitCode, 0, refresh.stderr);
    const refreshPayload = parseJsonOutput(refresh);
    assert.equal(refreshPayload.status, "completed");
    assert.equal(refreshPayload.indexProfile, "structural");
    assert.match(refreshPayload.artifactPath, /-refresh\/workflow-run\.json$/u);
    const run = await readJson(root, refreshPayload.artifactPath);
    assert.equal(run.input.profile, "structural");
    assert.equal(run.outputs.indexProfile, "structural");
    assert.equal(run.outputs.semanticIndexSha256, refreshPayload.semanticIndexSha256);
    assert.match(refreshPayload.snapshotId, /^idx_[0-9a-f]{24}$/);
    assert.match(refreshPayload.semanticIndexArtifactPath, /semantic-index\.json$/);
    assert.match(refreshPayload.semanticSqliteArtifactPath, /semantic-index\.sqlite$/);
    assert.match(refreshPayload.semanticIndexSha256, /^[0-9a-f]{64}$/u);
    await assertFile(root, refreshPayload.semanticIndexArtifactPath);
    await assertFile(root, refreshPayload.semanticSqliteArtifactPath);

    const map = await readJson(root, refreshPayload.mapArtifactPath);
    assert.equal(map.kind, "codebase_map");
    const snapshot = await readJson(root, refreshPayload.semanticIndexArtifactPath);
    assert.equal(snapshot.kind, "code_index_snapshot");
    assert.equal(snapshot.profile, "structural");
    assert.equal(snapshot.snapshotId, refreshPayload.snapshotId);
    assert.equal(snapshot.sqlite.path, refreshPayload.semanticSqliteArtifactPath);
    assert.equal(snapshot.symbols.some((symbol) => symbol.name === "resolveAsset"), true);

    const checkFresh = await runCliCapture(["--repository-root", root, "map", "--check", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(checkFresh.exitCode, 0, checkFresh.stderr);
    assert.equal(parseJsonOutput(checkFresh).status, "fresh");

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(query.exitCode, 0, query.stderr);
    const queryPayload = parseJsonOutput(query);
    assert.equal(queryPayload.indexProfile, "structural");
    assert.equal(queryPayload.snapshotId, refreshPayload.snapshotId);
    assert.equal(queryPayload.matches[0].path, "src/asset-service.ts");
    assert.equal(queryPayload.matches[0].name, "resolveAsset");
    assert.ok(["symbol", "export"].includes(queryPayload.matches[0].factKind));
    assert.equal(typeof queryPayload.matches[0].id, "string");
    assert.equal(typeof queryPayload.matches[0].range.startByte, "number");
    assert.equal(queryPayload.matches[0].sourceSha256.length, 64);
    assert.equal(queryPayload.matches[0].extractorVersion, "0.26.13");

    const why = await runCliCapture(["--repository-root", root, "map", "--why", queryPayload.matches[0].id, "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(why.exitCode, 0, why.stderr);
    const whyPayload = parseJsonOutput(why);
    assert.equal(whyPayload.mode, "why");
    assert.equal(whyPayload.indexProfile, "structural");
    assert.equal(whyPayload.snapshotId, refreshPayload.snapshotId);
    assert.equal(whyPayload.fact.name, "resolveAsset");
    assert.equal(whyPayload.fact.path, "src/asset-service.ts");
    assert.equal(typeof whyPayload.fact.range.startByte, "number");
    assert.equal(whyPayload.fact.sourceSha256.length, 64);
    assert.equal(whyPayload.fact.extractorVersion, "0.26.13");

    const unknown = await runCliCapture(["--repository-root", root, "map", "--why", "sym_ffffffffffffffffffffffff", "--json"]);
    assert.equal(unknown.exitCode, 1);
    assert.equal(parseJsonOutput(unknown).status, "blocked");
    const snapshotWhy = await runCliCapture(["--repository-root", root, "map", "--why", refreshPayload.snapshotId, "--json"]);
    assert.equal(snapshotWhy.exitCode, 1);
    assert.equal(parseJsonOutput(snapshotWhy).status, "usage_error");

    await writeFile(path.join(root, "src", "asset-service.ts"), "export function resolveAssetChanged() { return 2; }\n", "utf8");
    const stale = await runCliCapture(["--repository-root", root, "map", "--check", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(stale.exitCode, 0, stale.stderr);
    assert.equal(parseJsonOutput(stale).status, "stale");

    const staleQuery = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--profile", "structural", "--json"]);
    assert.equal(staleQuery.exitCode, 1);
    const staleQueryPayload = parseJsonOutput(staleQuery);
    assert.equal(staleQueryPayload.status, "blocked");
    assert.equal(staleQueryPayload.nextAction.command, "legion map --refresh --profile structural");
    assert.ok(staleQueryPayload.diagnostics.some(({ code }) => code === "map_structural_stale"));

    const staleWhy = await runCliCapture(["--repository-root", root, "map", "--why", queryPayload.matches[0].id, "--json"]);
    assert.equal(staleWhy.exitCode, 1);
    const staleWhyPayload = parseJsonOutput(staleWhy);
    assert.equal(staleWhyPayload.status, "blocked");
    assert.equal(staleWhyPayload.nextAction.command, "legion map --refresh --profile structural");
    assert.ok(staleWhyPayload.diagnostics.some(({ code }) => code === "map_structural_stale"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structural discovery rejects tampered latest output instead of falling back to an older snapshot", async () => {
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Structural Integrity\n", "utf8");
    await writeFile(path.join(root, "src", "asset.ts"), "export function resolveAsset() { return 1; }\n", "utf8");
    const first = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const firstPayload = parseJsonOutput(first);
    const second = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural",
      "--created-at", "2026-06-23T12:03:00.000Z",
      "--json"
    ]);
    assert.equal(second.exitCode, 0, second.stderr);
    const secondPayload = parseJsonOutput(second);
    const snapshotPath = path.join(root, ...secondPayload.semanticIndexArtifactPath.split("/"));
    const snapshot = await readJson(root, secondPayload.semanticIndexArtifactPath);
    await writeFile(snapshotPath, `${JSON.stringify({ ...snapshot, generatedAt: "2026-06-23T12:04:00.000Z" })}\n`, "utf8");

    const hashQuery = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(hashQuery.exitCode, 1);
    const hashPayload = parseJsonOutput(hashQuery);
    assert.equal(hashPayload.status, "blocked");
    assert.ok(hashPayload.diagnostics.some(({ message }) => message.includes("content hash")));

    await writeFile(snapshotPath, `${JSON.stringify({ ...snapshot, sourceFingerprint: "0".repeat(64) })}\n`, "utf8");

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(query.exitCode, 1);
    const payload = parseJsonOutput(query);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.matches, undefined);
    assert.ok(payload.diagnostics.some(({ message }) => message.includes(secondPayload.runId)));
    assert.equal(payload.diagnostics.some(({ message }) => message.includes(firstPayload.runId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed latest structural refresh blocks reads instead of serving an older snapshot", async () => {
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Structural Failure\n", "utf8");
    await writeFile(path.join(root, "src", "asset.ts"), "export function resolveAsset() { return 1; }\n", "utf8");
    const first = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const latest = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural",
      "--created-at", "2026-06-23T12:03:00.000Z",
      "--json"
    ]);
    assert.equal(latest.exitCode, 0, latest.stderr);
    const latestPayload = parseJsonOutput(latest);
    const runPath = path.join(root, ...latestPayload.artifactPath.split("/"));
    const run = await readJson(root, latestPayload.artifactPath);
    await writeFile(runPath, `${JSON.stringify({ ...run, status: "blocked" })}\n`, "utf8");

    const check = await runCliCapture(["--repository-root", root, "map", "--check", "--profile", "structural", "--json"]);
    assert.equal(check.exitCode, 0, check.stderr);
    const checkPayload = parseJsonOutput(check);
    assert.equal(checkPayload.status, "absent");
    assert.ok(checkPayload.diagnostics.some(({ code }) => code === "map_structural_latest_failure"));

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "resolveAsset", "--profile", "structural", "--created-at", "2026-06-23T12:05:00.000Z", "--json"]);
    assert.equal(query.exitCode, 1);
    const queryPayload = parseJsonOutput(query);
    assert.equal(queryPayload.status, "blocked");
    assert.ok(queryPayload.diagnostics.some(({ code }) => code === "map_structural_latest_failure"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("map refresh rejects an out-of-repository symlink scope before writing artifacts", async () => {
  const root = await tempRepo();
  const outside = await mkdtemp(path.join(tmpdir(), "legion-map-outside-"));
  try {
    await writeFile(path.join(outside, "secret.ts"), "export function outsideScope() { return 1; }\n", "utf8");
    await symlink(outside, path.join(root, "linked-scope"));
    const refresh = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "structural", "--scope", "linked-scope",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(refresh.exitCode, 1);
    const payload = parseJsonOutput(refresh);
    assert.equal(payload.status, "usage_error");
    assert.match(payload.diagnostics[0].message, /stay inside the repository/);
    await assert.rejects(readdir(path.join(root, ".legion", "project", "workflow", "map")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("inventory profile refresh keeps the v1-only map surface", async () => {
  const root = await tempRepo();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Inventory\n", "utf8");
    await writeFile(path.join(root, "src", "asset.ts"), "export function resolveAsset() { return 1; }\n", "utf8");
    const refresh = await runCliCapture([
      "--repository-root", root,
      "map", "--refresh", "--profile", "inventory",
      "--created-at", "2026-06-23T12:02:00.000Z",
      "--json"
    ]);
    assert.equal(refresh.exitCode, 0, refresh.stderr);
    const payload = parseJsonOutput(refresh);
    assert.equal(payload.status, "completed");
    assert.equal(Object.hasOwn(payload, "semanticIndexArtifactPath"), false);
    assert.equal(Object.hasOwn(payload, "semanticSqliteArtifactPath"), false);
    assert.equal(Object.hasOwn(payload, "snapshotId"), false);
    assert.equal(Object.hasOwn(payload, "indexProfile"), false);
    const run = await readJson(root, payload.artifactPath);
    assert.equal(Object.hasOwn(run.outputs, "semanticIndexArtifactPath"), false);
    assert.equal(Object.hasOwn(run.outputs, "semanticSqliteArtifactPath"), false);
    assert.equal(Object.hasOwn(run.outputs, "snapshotId"), false);
    assert.equal(Object.hasOwn(run.outputs, "indexProfile"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("map query falls back from a corrupt latest artifact and reports its validation diagnostic", async () => {
  const root = await tempRepo();
  try {
    await initProject(root);
    await writeFile(path.join(root, "README.md"), "# Asset Mapper\n\nMetadata authoring.\n", "utf8");
    const first = await runCliCapture([
      "--repository-root", root, "map", "--refresh", "--profile", "inventory", "--created-at", "2026-06-23T12:02:00.000Z", "--json"
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const second = await runCliCapture([
      "--repository-root", root, "map", "--refresh", "--profile", "inventory", "--created-at", "2026-06-23T12:03:00.000Z", "--json"
    ]);
    assert.equal(second.exitCode, 0, second.stderr);
    const secondPayload = parseJsonOutput(second);
    const latestMapPath = path.join(root, ...secondPayload.mapArtifactPath.split("/"));
    const latestMap = JSON.parse(await readFile(latestMapPath, "utf8"));
    await writeFile(latestMapPath, `${JSON.stringify({ ...latestMap, sourceFingerprint: "0".repeat(64) })}\n`, "utf8");

    const query = await runCliCapture(["--repository-root", root, "map", "--query", "metadata", "--json"]);

    assert.equal(query.exitCode, 0, query.stderr);
    const payload = parseJsonOutput(query);
    assert.equal(payload.matches[0].path, "README.md");
    assert.deepEqual(payload.diagnostics.map(({ code, message }) => ({ code, message })), [{
      code: "map_artifact_fingerprint_mismatch",
      message: `Ignored map run ${secondPayload.runId}: declared sourceFingerprint does not match the map file entries.`
    }]);
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
      [".", quickPayload.requestArtifactPath],
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

    // `--complete` gates on the phases the milestone covers. Phases 1-3 were
    // never planned here, so it refuses and names them — the command's stated
    // no-partial-completions rule, which previously only checked that the id
    // existed. Reaching a passing completion needs every covered phase's
    // evidence accepted, and acceptance cannot override the harness
    // observations a fake executor's build fails.
    const complete = await runCliCapture(["--repository-root", root, "milestone", "--complete", "milestone-mvp", "--summary", "MVP complete", "--json"]);
    assert.equal(complete.exitCode, 1);
    assert.match(parseJsonOutput(complete).diagnostics[0].message, /incomplete phase\(s\)/);

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

    // Retro stages; recording is the second step. The run's artifacts exist
    // either way, which is what this assertion was always about.
    const retro = await runCliCapture(["--repository-root", root, "retro", "--executor", "fake", "--json"]);
    assert.equal(retro.exitCode, 0, retro.stderr);
    const retroPayload = parseJsonOutput(retro);
    assert.equal(retroPayload.status, "staged");
    await assertFile(root, retroPayload.markdownArtifactPath);

    const saved = await runCliCapture([
      "--repository-root", root, "retro", "--save", retroPayload.runId, "--json"
    ]);
    assert.equal(saved.exitCode, 0, saved.stderr);
    assert.equal(parseJsonOutput(saved).status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
