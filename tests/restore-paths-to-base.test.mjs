import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { restorePathsToBase } from "../packages/cli/dist/workflow/diff-reconciliation.js";

/**
 * Detection is not containment.
 *
 * A forbidden write that is merely reported still sits on disk, and the control
 * artifacts are precisely the files `review` and `ship` reload next — so an
 * attack that is detected but not undone is still an attack that succeeds.
 */

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function repoWithBase(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-restore-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  // Keep checkout byte-exact so assertions do not depend on the platform's
  // line-ending conversion; matches the LF-preserving procedure the rewrite
  // charter uses for baseline validation.
  git(root, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(root, ".legion", "project"), { recursive: true });
  await writeFile(path.join(root, ".legion", "project", "taskgraph.json"), '{"tier":"R2"}\n', "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "base"]);

  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, base };
}

test("a tampered tracked file is restored to its pre-run contents", async (t) => {
  const { root, base } = await repoWithBase(t);
  const target = ".legion/project/taskgraph.json";

  await writeFile(path.join(root, target), '{"tier":"R0"}\n', "utf8");

  const failed = restorePathsToBase({ repositoryRoot: root, baseGitSha: base, paths: [target] });

  assert.deepEqual(failed, []);
  assert.equal(await readFile(path.join(root, target), "utf8"), '{"tier":"R2"}\n');
});

test("a file created by the run is removed", async (t) => {
  const { root, base } = await repoWithBase(t);
  const planted = ".legion/project/planted.json";

  await writeFile(path.join(root, planted), "{}\n", "utf8");

  const failed = restorePathsToBase({ repositoryRoot: root, baseGitSha: base, paths: [planted] });

  assert.deepEqual(failed, []);
  assert.equal(existsSync(path.join(root, planted)), false);
});

test("restoring survives a commit made by the run", async (t) => {
  const { root, base } = await repoWithBase(t);
  const target = ".legion/project/taskgraph.json";

  // Committing is the case that defeated the first version of the caller, which
  // re-resolved HEAD and diffed against the executor's own commit.
  await writeFile(path.join(root, target), '{"tier":"R0"}\n', "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "tampered"]);

  restorePathsToBase({ repositoryRoot: root, baseGitSha: base, paths: [target] });

  assert.equal(await readFile(path.join(root, target), "utf8"), '{"tier":"R2"}\n');
});

test("restoring reports paths it could not handle rather than claiming success", async (t) => {
  const { root, base } = await repoWithBase(t);

  // A directory cannot be removed by the file-removal fallback, so it must be
  // reported instead of silently treated as restored.
  await mkdir(path.join(root, ".legion", "project", "planted-dir"), { recursive: true });
  await writeFile(path.join(root, ".legion", "project", "planted-dir", "x.json"), "{}\n", "utf8");

  const failed = restorePathsToBase({
    repositoryRoot: root,
    baseGitSha: base,
    paths: [".legion/project/planted-dir"]
  });

  assert.deepEqual(failed, [".legion/project/planted-dir"]);
});

test("untouched files are left alone", async (t) => {
  const { root, base } = await repoWithBase(t);
  await writeFile(path.join(root, "src.txt"), "mine\n", "utf8");

  restorePathsToBase({
    repositoryRoot: root,
    baseGitSha: base,
    paths: [".legion/project/taskgraph.json"]
  });

  // Only the named forbidden paths are reverted; the operator's other work
  // stays put so it can be inspected.
  assert.equal(await readFile(path.join(root, "src.txt"), "utf8"), "mine\n");
});
