import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Planning against the requirement set the interview produced.
 *
 * `legion plan` minted its own `req_phase-*` ID and authored generic criteria,
 * so the typed contract intake had just written was not what got planned: the
 * executable acceptance proofs the operator supplied were replaced with
 * generated prose, and nothing downstream traced back to the requirement set.
 *
 * These tests were written before the code that satisfies them, and confirmed
 * failing first. Three features in the previous phase were written, persisted,
 * and never consumed — each looked finished because the write side worked.
 */

const CREATED_AT = "2026-07-30T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Asset Mapper",
  "project-summary": "Deterministic asset resolution.",
  "project-owner": "dasbl",
  "problem-statement": "Renames silently break downstream builds.",
  "problem-users": "Pipeline engineers.",
  "problem-success": "A broken reference fails at build time, loudly.",
  "req-1-statement": "Resolution fails loudly when an asset is missing",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "Resolving a missing asset exits non-zero",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "pnpm test --filter resolver",
  "req-1-ac-1-more": "true",
  "req-1-ac-2-statement": "The error names the referencing file",
  "req-1-ac-2-proof": "manual",
  "req-1-ac-2-detail": "Message wording is a judgement call that no assertion should freeze.",
  "req-1-ac-2-more": "false",
  "req-1-more": "false",
  "non-goals": "Automatic renaming",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "Every downstream consumer is affected.",
  "budget-files": "12",
  "budget-lines": "600",
  "budget-new-files": "4",
  "pref-verification": "pnpm test"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function plannedProject(t, answers = ANSWERS) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-plan-req-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  const payload = parseJsonOutput(planned);
  const readText = async (relative) => readFile(path.join(root, ...relative.split("/")), "utf8");

  return {
    root,
    run,
    requirementId: parseJsonOutput(finalize).requirementSet.paths[0]
      .split("/")
      .at(-1)
      .replace(/\.json$/, ""),
    taskgraph: JSON.parse(await readText(payload.taskgraph.artifactPath)),
    // The oracle is YAML, so it is asserted as text rather than parsed. The
    // assertions are about which criteria appear, which reads the same either
    // way and avoids adding a parser to the test suite.
    oracle: await readText(payload.oracle.artifactPath)
  };
}

test("the planned task traces to the requirement the interview wrote", async (t) => {
  const { taskgraph, requirementId } = await plannedProject(t);
  const task = taskgraph.tasks[0];

  // `phasePlanIds` minted `req_<phase-suffix>` regardless of what the roadmap
  // named, so the contract traced to a requirement nobody authored.
  assert.deepEqual(
    task.requirementIds,
    [requirementId],
    `expected the intake requirement, got ${task.requirementIds.join(", ")}`
  );
});

test("the oracle covers the interview's real acceptance criteria", async (t) => {
  const { oracle, requirementId } = await plannedProject(t);

  assert.match(oracle, new RegExp(requirementId), "the oracle must cover the intake requirement");

  // Previously a single line of prose: "Phase N acceptance criteria are
  // satisfied" — which is not a criterion, it is the phase restated as its own
  // answer, and it made every oracle indistinguishable from every other.
  assert.match(oracle, /Resolving a missing asset exits non-zero/);
  assert.match(oracle, /names the referencing file/);
  assert.doesNotMatch(oracle, /Phase 1 acceptance criteria are satisfied/);
});

test("an executable criterion becomes task verification", async (t) => {
  const { taskgraph } = await plannedProject(t);
  const commands = taskgraph.tasks[0].verification.map(
    (entry) => `${entry.command} ${entry.args.join(" ")}`.trim()
  );

  // The criterion the operator said decides this requirement has to be the
  // thing that runs. Verifying only the project-wide command would check that
  // nothing broke, not that the requirement holds.
  assert.ok(
    commands.some((entry) => entry === "pnpm test --filter resolver"),
    `expected the criterion command, got ${JSON.stringify(commands)}`
  );
});

test("a manual criterion is carried as an unproven gap, not as a command", async (t) => {
  const { oracle } = await plannedProject(t);

  // A manual criterion cannot be executed, and inventing a command for it would
  // be the fabrication the protocol revision exists to prevent. It stays visible
  // as unproven, named for whoever reviews the phase.
  assert.match(oracle, /judgement call/);
  assert.match(oracle, /no command can decide/i);
});

test("planning a project with no requirement set still works", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-plan-bare-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "Bare Project", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build it\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);

  // Direct initialization and the legacy `.planning` importer both produce
  // roadmaps with no requirement IDs. Planning must keep working for them
  // rather than requiring an interview that never happened.
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  const taskgraph = JSON.parse(
    await readFile(
      path.join(root, ...parseJsonOutput(planned).taskgraph.artifactPath.split("/")),
      "utf8"
    )
  );
  assert.equal(taskgraph.tasks.length, 1);
});
