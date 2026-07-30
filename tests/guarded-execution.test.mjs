import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * End-to-end enforcement, driven by an executor that actually misbehaves.
 *
 * Every earlier reconciliation test operated on synthetic observations, because
 * the `fake` executor wrote nothing. That gap is why an unsatisfiable task
 * contract, an unreconciled auto-fix path, a double-resolved base SHA and a
 * missing containment step all shipped through a green suite. These tests script
 * real writes and assert the harness catches them.
 */

const PLAN_ENV = "LEGION_FAKE_EXECUTOR_PLAN";
const TASKGRAPH = ".legion/project/changes/chg_phase-1-foundation/taskgraph.json";

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function plannedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-guarded-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  // Byte-exact checkout so restore assertions do not depend on platform
  // line-ending conversion.
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "Guarded", "--summary", "Guarded execution", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build it\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  await run("plan", "1", "--from-roadmap", "ROADMAP.md");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  return { root, run };
}

async function withPlan(plan, fn) {
  process.env[PLAN_ENV] = JSON.stringify(plan);
  try {
    return await fn();
  } finally {
    delete process.env[PLAN_ENV];
  }
}

test("an in-contract source edit is accepted", async (t) => {
  const { root, run } = await plannedProject(t);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(parseJsonOutput(build).status, "executed");
  assert.equal(await readFile(path.join(root, "src/app/main.ts"), "utf8"), "export const a = 1;\n");
});

test("a build that rewrites its own contract is blocked and reverted", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  const build = await withPlan(
    { writes: [{ path: TASKGRAPH, content: '{"tampered":true}\n' }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.equal(payload.status, "blocked");
  assert.ok(
    payload.diagnostics.some((entry) => /protected control artifact/i.test(entry.message)),
    `expected a protected-artifact diagnostic, got ${JSON.stringify(payload.diagnostics)}`
  );
  assert.ok(
    payload.diagnostics.some((entry) => /Restored 1 protected path/.test(entry.message)),
    "the diagnostic should say the artifact was restored, not merely that it was touched"
  );

  // Detection without containment would leave the rewrite for the next command.
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("committing the tampering does not launder it", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  // The case that defeats a re-resolved base SHA: diffing against the
  // executor's own commit would show a clean tree.
  const build = await withPlan(
    { writes: [{ path: TASKGRAPH, content: '{"tampered":true}\n' }], commit: true },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  assert.equal(parseJsonOutput(build).status, "blocked");
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("exceeding the file budget blocks the run", async (t) => {
  const { run } = await plannedProject(t);

  const writes = Array.from({ length: 40 }, (_, index) => ({
    path: `src/app/file-${index}.ts`,
    content: `export const v${index} = ${index};\n`
  }));

  const build = await withPlan({ writes }, () => run("build", "--executor", "fake", "--json"));

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.ok(
    payload.diagnostics.some((entry) => /budget/i.test(entry.message)),
    `expected a budget diagnostic, got ${JSON.stringify(payload.diagnostics)}`
  );
});

test("a false filesChanged report is recorded as a mismatch", async (t) => {
  const { root, run } = await plannedProject(t);

  const build = await withPlan(
    {
      writes: [{ path: "src/app/real.ts", content: "export const real = 1;\n" }],
      claimFilesChanged: ["src/app/imaginary.ts"]
    },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  const evidence = JSON.parse(
    await readFile(
      path.join(root, ".legion/project/changes/chg_phase-1-foundation/evidence-index.json"),
      "utf8"
    )
  );
  const ids = evidence.entries.at(-1).evidence.items.map((item) => item.id);
  assert.ok(
    ids.includes("claim-observation-mismatch"),
    `expected a claim/observation mismatch, got ${ids.join(", ")}`
  );
});

test("a large pre-existing control artifact survives a run", async (t) => {
  const { root, run } = await plannedProject(t);

  // Anything too big to snapshot was previously absent from the map, which
  // restoration read as "did not exist before" and deleted. A stale executor
  // log would be destroyed on every writable run.
  const bulky = ".legion/project/changes/chg_phase-1-foundation/bulky.log";
  const contents = `${"x".repeat(9 * 1024 * 1024)}\n`;
  await writeFile(path.join(root, ...bulky.split("/")), contents, "utf8");
  // Committed so the run starts from a clean worktree; the oversized path is
  // what is under test, not the dirty-worktree pre-flight.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "bulky log"]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal((await readFile(path.join(root, ...bulky.split("/")), "utf8")).length, contents.length);
});

test("a pre-existing symlink in the control tree is left alone", async (t) => {
  const { root, run } = await plannedProject(t);
  const planted = ".legion/project/planted-link";

  // Skipping symlinks made a planted link invisible to both the snapshot and
  // the post-run scan, so it survived containment for a later command to follow.
  try {
    await symlink(path.join(root, "ROADMAP.md"), path.join(root, ...planted.split("/")));
  } catch (error) {
    // Windows refuses symlink creation without elevation or developer mode.
    if (error?.code === "EPERM") return t.skip("symlink creation is not permitted here");
    throw error;
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "planted link"]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 2;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  // Present before dispatch, so it is part of the baseline and left alone.
  assert.equal(existsSync(path.join(root, ...planted.split("/"))), true);
});

test("a control artifact deleted by the run is restored", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  // Deletion leaves nothing in the post-run listing, so a scan that only walked
  // observed files would report clean.
  const build = await withPlan({ deletes: [TASKGRAPH] }, () =>
    run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("a symlink created by the run is detected and removed", async (t) => {
  const { root, run } = await plannedProject(t);
  const planted = ".legion/project/planted-link";

  // The case the previous test's name claimed but did not cover: the link is
  // created *during* dispatch, so it is absent from the snapshot and has to be
  // caught by the post-run scan and cleared without following it.
  const build = await withPlan(
    { symlinks: [{ path: planted, target: path.join(root, "ROADMAP.md") }] },
    () => run("build", "--executor", "fake", "--json")
  );

  if (!existsSync(path.join(root, ...planted.split("/"))) && build.exitCode === 0) {
    return t.skip("symlink creation is not permitted here");
  }

  assert.equal(build.exitCode, 1);
  assert.match(parseJsonOutput(build).diagnostics[0].message, /protected control artifact/i);
  assert.equal(existsSync(path.join(root, ...planted.split("/"))), false);
  // The link must be unlinked, never followed — its target stays intact.
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /Phase 1: Foundation/);
});
