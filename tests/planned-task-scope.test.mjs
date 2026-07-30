import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathIsCoveredBy, reconcileDiff, summarizeObservation } from "../packages/cli/dist/workflow/diff-reconciliation.js";
import { runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * A planned task must be able to do the work it says it will.
 *
 * The generated phase contract once declared `scope.write: [taskgraphPath]`
 * while its objective was to implement the phase, with diff reconciliation
 * required. Every real build was therefore blocked on the first source edit.
 * Nothing caught it: the `fake` executor writes no files, so the whole suite
 * passed against a contract no executor could satisfy.
 *
 * These tests check the contract against the work, not the harness against
 * itself.
 */

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function plannedTaskgraph(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-scope-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "Scope", "--summary", "Planned scope", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build the thing\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  await run("plan", "1", "--from-roadmap", "ROADMAP.md");

  const raw = await readFile(
    path.join(root, ".legion/project/changes/chg_phase-1-foundation/taskgraph.json"),
    "utf8"
  );
  return JSON.parse(raw).tasks[0];
}

test("a planned implementation task may write source files", async (t) => {
  const task = await plannedTaskgraph(t);

  // The objective is to implement, so the scope has to permit implementing.
  assert.match(task.objective, /Implement/i);
  const covered = task.scope.write.some((entry) => pathIsCoveredBy("src/app/main.ts", entry));
  assert.equal(covered, true, `scope.write ${JSON.stringify(task.scope.write)} cannot reach source files`);
});

test("a source edit reconciles cleanly against the planned contract", async (t) => {
  const task = await plannedTaskgraph(t);

  const observation = summarizeObservation(
    [
      { path: "src/app/main.ts", linesChanged: 40, isNew: false, contentSha256: "a" },
      { path: "src/app/helper.ts", linesChanged: 20, isNew: true, contentSha256: "b" }
    ],
    "0".repeat(40)
  );

  assert.deepEqual(reconcileDiff({ observation, scope: task.scope }), []);
});

test("the planned contract still forbids the paths it should", async (t) => {
  const task = await plannedTaskgraph(t);

  const observation = summarizeObservation(
    [{ path: ".git/config", linesChanged: 1, isNew: false, contentSha256: "c" }],
    "0".repeat(40)
  );

  const violations = reconcileDiff({ observation, scope: task.scope });
  assert.equal(violations[0].code, "forbidden_path_touched");
});

test("control artifacts are withheld from implementation work", async (t) => {
  const task = await plannedTaskgraph(t);

  // The escalation this closes: `review` and `ship` reload the taskgraph from
  // disk after the executor runs, so a writable control artifact lets the
  // executor lower its own risk.tier and shrink the gate set ship derives. A
  // contract must not be amendable by the party it constrains.
  //
  // The first version of this file asserted `.git` was forbidden and never
  // checked `.legion/project`: it proved the contract permitted the work, but
  // not that it withheld the authority to change itself.
  for (const controlPath of [
    ".legion/project/changes/chg_phase-1-foundation/taskgraph.json",
    ".legion/project/project.json",
    ".legion/project/changes/chg_phase-1-foundation/change.yaml",
    ".legion/project/changes/chg_phase-1-foundation/oracle/orc_phase-1-foundation.yaml",
    ".legion/project/changes/chg_phase-1-foundation/evidence-index.json",
    ".legion/project/constitution.md"
  ]) {
    const observation = summarizeObservation(
      [{ path: controlPath, linesChanged: 1, isNew: false, contentSha256: "x" }],
      "0".repeat(40)
    );
    const violations = reconcileDiff({ observation, scope: task.scope });
    assert.equal(
      violations[0]?.code,
      "forbidden_path_touched",
      `${controlPath} should be forbidden to implementation work`
    );
  }
});

test("a legacy contract cannot grant control-artifact access", async (t) => {
  const task = await plannedTaskgraph(t);

  // `scope.forbidden` is contract data, so a taskgraph persisted before control
  // artifacts were forbidden keeps the old list and the rule would not apply to
  // it. The harness supplies the invariant instead, so vintage cannot opt out.
  const legacyScope = {
    ...task.scope,
    forbidden: [".git", "node_modules", ".legion/var/runtime.sqlite"]
  };
  const observation = summarizeObservation(
    [
      {
        path: ".legion/project/changes/chg_phase-1-foundation/taskgraph.json",
        linesChanged: 3,
        isNew: false,
        contentSha256: "tampered"
      }
    ],
    "0".repeat(40)
  );

  assert.deepEqual(reconcileDiff({ observation, scope: legacyScope }), []);
  const guarded = reconcileDiff({
    observation,
    scope: legacyScope,
    alwaysForbidden: [".legion/project"]
  });
  assert.equal(guarded[0].code, "forbidden_path_touched");
});

test("the planned contract keeps a finite budget despite repository-wide scope", async (t) => {
  const task = await plannedTaskgraph(t);

  // Repository-wide write scope is only acceptable because the budget bounds it.
  assert.ok(task.scope.budget.maxFilesChanged > 0);
  assert.ok(task.scope.budget.maxFilesChanged < 10_000);

  const runaway = summarizeObservation(
    Array.from({ length: task.scope.budget.maxFilesChanged + 1 }, (_, index) => ({
      path: `src/app/file-${index}.ts`,
      linesChanged: 1,
      isNew: false,
      contentSha256: `h${index}`
    })),
    "0".repeat(40)
  );

  const codes = reconcileDiff({ observation: runaway, scope: task.scope }).map((entry) => entry.code);
  assert.ok(codes.includes("budget_files_exceeded"));
});
