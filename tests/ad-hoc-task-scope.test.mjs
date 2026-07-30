import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { reconcileDiff, summarizeObservation } from "../packages/cli/dist/workflow/diff-reconciliation.js";
import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion quick` and `legion polish` generate contracts through a second,
 * independent path from the phase planner. A rule applied to one generator says
 * nothing about the other, so the ad-hoc entrance needs its own coverage rather
 * than inheriting confidence from the planned one.
 */

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function initialized(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-adhoc-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "AdHoc", "--summary", "Ad-hoc scope", "--owner", "dasbl");
  return { root, run };
}

async function taskFrom(root, taskgraphArtifactPath) {
  const raw = await readFile(path.join(root, ...taskgraphArtifactPath.split("/")), "utf8");
  return JSON.parse(raw).tasks[0];
}

test("a quick task withholds control artifacts", async (t) => {
  const { root, run } = await initialized(t);

  const planned = await run("quick", "fix the failing tests", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  const task = await taskFrom(root, parseJsonOutput(planned).taskgraph.artifactPath);

  const observation = summarizeObservation(
    [
      {
        path: ".legion/project/changes/chg_x/taskgraph.json",
        linesChanged: 2,
        isNew: false,
        contentSha256: "tampered"
      }
    ],
    "0".repeat(40)
  );

  assert.equal(reconcileDiff({ observation, scope: task.scope })[0]?.code, "forbidden_path_touched");
});

test("a quick task can still write source files", async (t) => {
  const { root, run } = await initialized(t);

  const planned = await run("quick", "fix the failing tests", "--json");
  const task = await taskFrom(root, parseJsonOutput(planned).taskgraph.artifactPath);

  // Forbidding control artifacts must not make the contract unsatisfiable —
  // the same failure the planned generator had.
  const observation = summarizeObservation(
    [{ path: "src/app/main.ts", linesChanged: 10, isNew: false, contentSha256: "a" }],
    "0".repeat(40)
  );

  assert.deepEqual(reconcileDiff({ observation, scope: task.scope }), []);
});

test("polishing a control artifact is refused rather than planned", async (t) => {
  const { run } = await initialized(t);

  // Planning it would succeed — the schema's overlap check compares scope
  // entries for exact equality and cannot see a target nested under a forbidden
  // prefix — and then every edit would fail as forbidden_path_touched. Refusing
  // up front beats emitting a contract nothing can satisfy.
  const refused = await run("polish", ".legion/project/constitution.md", "--json");

  assert.notEqual(refused.exitCode, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /control artifacts/i);
});

test("polishing an ordinary path still plans", async (t) => {
  const { root, run } = await initialized(t);

  const planned = await run("polish", "src/app/main.ts", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  const task = await taskFrom(root, parseJsonOutput(planned).taskgraph.artifactPath);

  assert.deepEqual(task.scope.write, ["src/app/main.ts"]);
});
