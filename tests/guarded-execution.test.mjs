import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    payload.diagnostics.some((entry) => /forbid/i.test(entry.message)),
    `expected a forbidden-path diagnostic, got ${JSON.stringify(payload.diagnostics)}`
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
