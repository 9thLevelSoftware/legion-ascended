import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion validate` checking the links between requirements, oracles and tasks.
 *
 * The artifacts reference each other by ID, and nothing checked that those IDs
 * resolve. A task could name a requirement that had been removed, or an oracle
 * from a change that no longer exists, and every command downstream would treat
 * the contract as intact — the traceability was a naming convention rather than
 * a checked property.
 *
 * Written before the implementation and confirmed failing first.
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
  "req-1-ac-1-more": "false",
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

/** A finalized, planned project — the state validate has the most to check. */
async function plannedProject(t, answers = ANSWERS) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-trace-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  const supplied = Object.fromEntries(
    Object.entries(answers).filter(([, value]) => value !== undefined)
  );
  await writeFile(path.join(root, "intake.json"), JSON.stringify(supplied), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  const taskgraphPath = path.join(
    root,
    ...parseJsonOutput(planned).taskgraph.artifactPath.split("/")
  );

  return {
    root,
    run,
    taskgraphPath,
    readTaskgraph: async () => JSON.parse(await readFile(taskgraphPath, "utf8")),
    writeTaskgraph: async (value) =>
      writeFile(taskgraphPath, `${JSON.stringify(value, undefined, 2)}\n`, "utf8")
  };
}

test("a freshly planned project validates", async (t) => {
  const { run } = await plannedProject(t);
  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 0, validated.stderr);
});

test("a task naming a requirement that does not exist is reported", async (t) => {
  const { run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  // The IDs are a naming convention until something resolves them. A requirement
  // removed from the set leaves every task that named it pointing at nothing,
  // and the contract still reads as intact.
  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].requirementIds = ["req_never-existed"];
  await writeTaskgraph(taskgraph);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("task_requirement_unresolved"),
    `expected task_requirement_unresolved, got ${codes.join(", ")}`
  );
});

test("a task naming an oracle that does not exist is reported", async (t) => {
  const { run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].oracleRefs = ["orc_never-existed"];
  await writeTaskgraph(taskgraph);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("task_oracle_unresolved"),
    `expected task_oracle_unresolved, got ${codes.join(", ")}`
  );
});

test("a task granting itself a wider blast radius than policy is reported", async (t) => {
  const { run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  // The interview recorded 12 files. A task contract that raises its own budget
  // has escaped the limit the operator set, and diff reconciliation would then
  // enforce the larger number while appearing to enforce the policy.
  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].scope.budget = {
    maxFilesChanged: 500,
    maxLinesChanged: 600,
    maxNewFiles: 4
  };
  await writeTaskgraph(taskgraph);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const diagnostics = parseJsonOutput(validated).diagnostics;
  assert.ok(
    diagnostics.some((entry) => entry.code === "task_budget_exceeds_policy"),
    `expected task_budget_exceeds_policy, got ${diagnostics.map((e) => e.code).join(", ")}`
  );
  assert.ok(
    diagnostics.some((entry) => /500/.test(entry.message) && /12/.test(entry.message)),
    "the diagnostic should name both the task's budget and the policy"
  );
});

test("a task budget at or under policy is accepted", async (t) => {
  const { run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  // Narrower than policy is the direction decomposition is supposed to move, so
  // it must not be reported.
  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].scope.budget = { maxFilesChanged: 3, maxLinesChanged: 90, maxNewFiles: 1 };
  await writeTaskgraph(taskgraph);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 0, validated.stderr);
});

test("unplanned requirements are reported as coverage, not as failure", async (t) => {
  const { run } = await plannedProject(t, {
    ...ANSWERS,
    "req-1-more": "true",
    "req-2-statement": "Renaming an asset updates every reference",
    "req-2-priority": "must",
    "req-2-category": "behavior",
    "req-2-ac-1-statement": "A rename rewrites dependent manifests",
    "req-2-ac-1-proof": "manual",
    "req-2-ac-1-detail": "Requires inspecting a real repository's history.",
    "req-2-ac-1-more": "false",
    "req-2-more": "false"
  });

  // Only phase 1 is planned. Having later phases unplanned is the normal state
  // of a project mid-flight, so reporting it as a failure would make validate
  // red for everyone and teach people to ignore it.
  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 0, validated.stderr);

  const payload = parseJsonOutput(validated);
  assert.equal(payload.coverage.requirements, 2);
  assert.equal(payload.coverage.planned, 1);
  assert.ok(
    payload.coverage.unplanned.some((id) => id.startsWith("req_renaming-an-asset")),
    `expected the unplanned requirement to be named, got ${JSON.stringify(payload.coverage)}`
  );
});

test("doctor reports the same traceability failures as validate", async (t) => {
  const { run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].requirementIds = ["req_never-existed"];
  await writeTaskgraph(taskgraph);

  // Two validation entrances that disagree teach operators to trust whichever
  // one is passing.
  assert.equal((await run("validate", "--json")).exitCode, 1);
  const doctored = await run("doctor", "--json");
  assert.equal(doctored.exitCode, 1, "doctor must not report a project validate refuses");
  assert.equal(parseJsonOutput(doctored).checks.traceability.ok, false);
});
