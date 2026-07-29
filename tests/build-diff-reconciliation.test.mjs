import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  diffDelta,
  observeWorkingTreeDiff,
  pathIsCoveredBy,
  reconcileDiff,
  reconcileTaskDiff,
  reconciliationBlocks
} from "../packages/cli/dist/workflow/diff-reconciliation.js";

const BUDGET = { maxFilesChanged: 3, maxLinesChanged: 100, maxNewFiles: 2 };

function scope(overrides = {}) {
  return {
    read: [],
    write: ["src/app"],
    forbidden: ["src/secrets"],
    sequentialFiles: [],
    budget: BUDGET,
    ...overrides
  };
}

function observation(overrides = {}) {
  return {
    changedFiles: [],
    newFiles: [],
    linesChanged: 0,
    baseGitSha: "0".repeat(40),
    ...overrides
  };
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function tempGitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "legion-diff-recon-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await mkdir(path.join(root, "src", "app"), { recursive: true });
  await writeFile(path.join(root, "src", "app", "base.txt"), "one\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "base"]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, head };
}

// --- scope coverage -------------------------------------------------------

test("scope entries cover exact files, directory prefixes, and the whole repo", () => {
  assert.equal(pathIsCoveredBy("src/app/main.ts", "src/app"), true);
  assert.equal(pathIsCoveredBy("src/app/main.ts", "src/app/main.ts"), true);
  assert.equal(pathIsCoveredBy("src/app/main.ts", "."), true);
  assert.equal(pathIsCoveredBy("src/other/main.ts", "src/app"), false);
  // A sibling directory sharing a name prefix must not be treated as covered.
  assert.equal(pathIsCoveredBy("src/application/main.ts", "src/app"), false);
});

// --- reconciliation rules -------------------------------------------------

test("a diff inside the write scope and budget is clean", () => {
  const violations = reconcileDiff({
    observation: observation({ changedFiles: ["src/app/main.ts"], linesChanged: 10 }),
    scope: scope()
  });
  assert.deepEqual(violations, []);
});

test("writing outside the declared scope is a violation that names the files", () => {
  const violations = reconcileDiff({
    observation: observation({ changedFiles: ["src/app/main.ts", "src/other/sneaky.ts"] }),
    scope: scope()
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "out_of_scope_write");
  assert.deepEqual(violations[0].paths, ["src/other/sneaky.ts"]);
});

test("touching a forbidden path is reported separately from out-of-scope writes", () => {
  const violations = reconcileDiff({
    observation: observation({ changedFiles: ["src/secrets/keys.env"] }),
    scope: scope()
  });
  // Forbidden must not also be double-counted as out-of-scope.
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "forbidden_path_touched");
  assert.deepEqual(violations[0].paths, ["src/secrets/keys.env"]);
});

test("exceeding the file, line, or new-file budget each violate independently", () => {
  const files = ["src/app/a.ts", "src/app/b.ts", "src/app/c.ts", "src/app/d.ts"];
  const violations = reconcileDiff({
    observation: observation({ changedFiles: files, newFiles: files, linesChanged: 500 }),
    scope: scope()
  });
  const codes = violations.map((entry) => entry.code).sort();
  assert.deepEqual(codes, [
    "budget_files_exceeded",
    "budget_lines_exceeded",
    "budget_new_files_exceeded"
  ]);
});

test("a budget boundary is inclusive — exactly at the limit is clean", () => {
  const violations = reconcileDiff({
    observation: observation({
      changedFiles: ["src/app/a.ts", "src/app/b.ts", "src/app/c.ts"],
      newFiles: ["src/app/a.ts", "src/app/b.ts"],
      linesChanged: 100
    }),
    scope: scope()
  });
  assert.deepEqual(violations, []);
});

// --- delta attribution ----------------------------------------------------

test("pre-existing edits are not attributed to the run", () => {
  const before = observation({
    changedFiles: ["src/app/dirty.ts"],
    newFiles: ["src/app/dirty.ts"],
    linesChanged: 40
  });
  const after = observation({
    changedFiles: ["src/app/dirty.ts", "src/app/new.ts"],
    newFiles: ["src/app/dirty.ts", "src/app/new.ts"],
    linesChanged: 65
  });

  const delta = diffDelta(before, after);
  assert.deepEqual(delta.changedFiles, ["src/app/new.ts"]);
  assert.deepEqual(delta.newFiles, ["src/app/new.ts"]);
  assert.equal(delta.linesChanged, 25);
});

test("a run that reverts more than it adds never reports a negative line count", () => {
  const delta = diffDelta(observation({ linesChanged: 80 }), observation({ linesChanged: 10 }));
  assert.equal(delta.linesChanged, 0);
});

// --- observation against a real repository --------------------------------

test("observation sees modified, created, and untracked files", async (t) => {
  const { root, head } = await tempGitRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  await writeFile(path.join(root, "src", "app", "base.txt"), "one\ntwo\n", "utf8");
  await writeFile(path.join(root, "src", "app", "untracked.txt"), "a\nb\nc\n", "utf8");

  const result = observeWorkingTreeDiff({ repositoryRoot: root, baseGitSha: head });

  assert.equal(result.status, "clean");
  assert.deepEqual(result.observation.changedFiles, ["src/app/base.txt", "src/app/untracked.txt"]);
  assert.deepEqual(result.observation.newFiles, ["src/app/untracked.txt"]);
  assert.ok(result.observation.linesChanged > 0);
});

test("a committed change is still attributed to the run", async (t) => {
  const { root, head } = await tempGitRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  // An executor that commits its work must not thereby escape reconciliation.
  await writeFile(path.join(root, "src", "app", "base.txt"), "one\ntwo\nthree\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "executor work"]);

  const result = observeWorkingTreeDiff({ repositoryRoot: root, baseGitSha: head });
  assert.deepEqual(result.observation.changedFiles, ["src/app/base.txt"]);
});

test("an out-of-contract write is caught end to end against a real repo", async (t) => {
  const { root, head } = await tempGitRepo();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  await mkdir(path.join(root, "src", "secrets"), { recursive: true });
  await writeFile(path.join(root, "src", "secrets", "keys.env"), "TOKEN=1\n", "utf8");

  const result = reconcileTaskDiff({ repositoryRoot: root, baseGitSha: head, scope: scope() });

  assert.equal(result.status, "violated");
  assert.equal(result.violations[0].code, "forbidden_path_touched");
});

test("a non-git project is not_applicable and does not block", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-diff-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const result = reconcileTaskDiff({ repositoryRoot: root, baseGitSha: "0".repeat(40), scope: scope() });

  // Not being under git is a property of the environment, not misbehaviour —
  // Legion stays usable, and the result is never reported as clean either.
  assert.equal(result.status, "not_applicable");
  assert.equal(reconciliationBlocks(result), false);
  assert.ok(result.unavailableReason.length > 0);
});

test("an unreadable diff in a git repo blocks, unlike a non-git project", () => {
  // The check that should have run did not, so the run is not proven in
  // contract. This is the case that must never be collapsed into the one above.
  assert.equal(reconciliationBlocks({ status: "unavailable", violations: [] }), true);
  assert.equal(reconciliationBlocks({ status: "violated", violations: [] }), true);
  assert.equal(reconciliationBlocks({ status: "clean", violations: [] }), false);
  assert.equal(reconciliationBlocks(undefined), false);
});

test("harness-written run artifacts are not blamed on the executor", () => {
  const runRoot = ".legion/project/changes/chg_x/runs/run_y";
  const violations = reconcileDiff({
    observation: observation({
      changedFiles: [`${runRoot}/executor-result.json`, `${runRoot}/executor-redacted.log`],
      newFiles: [`${runRoot}/executor-result.json`]
    }),
    scope: scope(),
    harnessPaths: [runRoot]
  });
  assert.deepEqual(violations, []);

  // The exclusion is scoped to the named directory, not to .legion generally.
  const leaked = reconcileDiff({
    observation: observation({ changedFiles: [".legion/project/changes/chg_x/taskgraph.json"] }),
    scope: scope(),
    harnessPaths: [runRoot]
  });
  assert.equal(leaked[0].code, "out_of_scope_write");
});
