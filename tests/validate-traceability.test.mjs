import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("an ad-hoc task resolves against its current spec", async (t) => {
  const { root, run } = await plannedProject(t);

  // `legion quick` authors a requirement into a current spec without adding it
  // to the intake set. Resolving against the set alone reported every ad-hoc
  // task as unresolved — and because those tasks verify with `legion validate`,
  // their builds could never complete. The requirement is real and typed; it
  // entered through a different door.
  const quick = await run("quick", "fix the failing tests", "--json");
  assert.equal(quick.exitCode, 0, quick.stderr);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 0, validated.stdout + validated.stderr);

  const payload = parseJsonOutput(validated);
  assert.equal(
    payload.diagnostics.filter((entry) => entry.code === "task_requirement_unresolved").length,
    0,
    `ad-hoc tasks must resolve: ${JSON.stringify(payload.diagnostics)}`
  );
  assert.ok(existsSync(path.join(root, ".legion/project/specs")));
});

test("a taskgraph with a valid-JSON but invalid shape is reported", async (t) => {
  const { run, taskgraphPath } = await plannedProject(t);

  // Parsed by hand, `{"tasks":"corrupt"}` read as a change with no tasks, so
  // validate reported success while every contract in it had disappeared.
  await writeFile(taskgraphPath, JSON.stringify({ tasks: "corrupt" }), "utf8");

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("taskgraph_unreadable"),
    `expected taskgraph_unreadable, got ${codes.join(", ")}`
  );
});

test("an oracle file that is not a valid oracle does not resolve", async (t) => {
  const { root, run, readTaskgraph } = await plannedProject(t);

  // Matching on basename alone meant a truncated, empty or ID-mismatched oracle
  // still counted as present.
  const taskgraph = await readTaskgraph();
  const oracleId = taskgraph.tasks[0].oracleRefs[0];
  const changeId = taskgraph.changeId ?? taskgraph.tasks[0].changeId;
  await writeFile(
    path.join(root, ".legion/project/changes", changeId, "oracle", `${oracleId}.yaml`),
    "",
    "utf8"
  );

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("task_oracle_unresolved"),
    `expected task_oracle_unresolved, got ${codes.join(", ")}`
  );
});

test("a traceability failure is not hidden behind a drift label", async (t) => {
  const { root, run, readTaskgraph, writeTaskgraph } = await plannedProject(t);

  // Both kinds of failure at once. The status is what dashboards filter on, and
  // a nested ternary let drift eclipse the more specific finding, so the label
  // excluded the traceability findings the payload was carrying.
  const taskgraph = await readTaskgraph();
  taskgraph.tasks[0].requirementIds = ["req_never-existed"];
  await writeTaskgraph(taskgraph);

  const indexPath = path.join(root, ".legion/project/requirements/index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.requirementSetHash = `sha256:${"0".repeat(64)}`;
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const payload = parseJsonOutput(validated);
  const codes = payload.diagnostics.map((entry) => entry.code);

  assert.ok(codes.includes("task_requirement_unresolved"), codes.join(", "));
  assert.ok(codes.some((code) => code.startsWith("requirement_")), codes.join(", "));
  assert.equal(
    payload.status,
    "traceability_broken",
    "the more specific failure must not be eclipsed by drift"
  );
});

test("a requirement proposed by a change delta resolves", async (t) => {
  const { root } = await plannedProject(t);
  const { resolvableRequirementIds } = await import(
    "../packages/cli/dist/workflow/traceability-check.js"
  );

  // A change with an `add` delta proposes a requirement that exists only under
  // that change until it ships. `packages/artifacts/src/traceability` already
  // treats those as real, so omitting them made a supported change report its
  // own task as unresolved.
  //
  // Asserted against the resolver directly: the fixture's delta proposes the
  // same requirement the intake set holds, so an end-to-end run cannot tell
  // which source resolved it.
  // Read through the change service: `change.yaml` records delta *pointers*, and
  // the proposed requirement lives in the per-delta spec the loader assembles.
  const { loadChangeBundle } = await import("../packages/artifacts/dist/index.js");
  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const change = await loadChangeBundle({ repositoryRoot: root, changeId });
  assert.equal(change.ok, true, "the planned change should load");

  const proposed = change.deltaSpecs
    .map((delta) => delta.proposedRequirement?.id)
    .find((id) => typeof id === "string");
  assert.ok(proposed !== undefined, "the planned change should propose a requirement");

  // The current spec has to go, or it supplies the same ID and the delta path is
  // never exercised. An `add` delta is precisely the case where the requirement
  // is not yet in current specs, so this is the real shape rather than a
  // convenience.
  //
  // A first version of this test omitted the removal and passed with the delta
  // lookup disabled — the third assertion in this project to pass for the wrong
  // reason, and the reason reverting the fix is worth doing every time.
  await rm(path.join(root, ".legion/project/specs"), { recursive: true, force: true });

  const ids = await resolvableRequirementIds(
    root,
    { ok: false, status: "not_found", reason: "none" },
    changeId
  );
  assert.ok(ids.has(proposed), `${proposed} should resolve from the change delta alone`);
});

test("an oracle that covers a different requirement does not satisfy the task", async (t) => {
  const { root, run, readTaskgraph } = await plannedProject(t);

  // Existing is not the same as covering. `validateChangeTraceability` rejects
  // this state as `task_missing_requirement_oracle`, so accepting it here would
  // let a project pass validation and fail later at archive.
  const taskgraph = await readTaskgraph();
  const changeId = taskgraph.tasks[0].changeId;
  const oracleId = taskgraph.tasks[0].oracleRefs[0];
  const oraclePath = path.join(
    root,
    ".legion/project/changes",
    changeId,
    "oracle",
    `${oracleId}.yaml`
  );

  const document = JSON.parse(await readFile(oraclePath, "utf8"));
  document.oracle.requirementCoverage[0].requirementId = "req_something-else-entirely";
  await writeFile(oraclePath, JSON.stringify(document), "utf8");

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("task_oracle_missing_coverage"),
    `expected task_oracle_missing_coverage, got ${codes.join(", ")}`
  );
});

test("an unreadable changes directory is reported, not treated as empty", async (t) => {
  const { root, run } = await plannedProject(t);

  // Swallowing every scan failure made an unreadable changes root
  // indistinguishable from a project with no changes, so validate reported
  // success having checked no task contract at all.
  await rm(path.join(root, ".legion/project/changes"), { recursive: true, force: true });
  await writeFile(path.join(root, ".legion/project/changes"), "not a directory\n", "utf8");

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1);
  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("artifact_root_unreadable"),
    `expected artifact_root_unreadable, got ${codes.join(", ")}`
  );
});

test("a requirement proposed by another change does not resolve", async (t) => {
  const { root, run } = await plannedProject(t);
  const { resolvableRequirementIds } = await import(
    "../packages/cli/dist/workflow/traceability-check.js"
  );

  // Pooling proposals from every pending change let a task in change A name a
  // requirement proposed only by change B. That validates here and is rejected
  // at archive, where the loader only ever sees one change's proposals.
  const quick = await run("quick", "fix the failing tests", "--json");
  assert.equal(quick.exitCode, 0, quick.stderr);

  const changes = (await readdir(path.join(root, ".legion/project/changes"))).sort();
  assert.equal(changes.length, 2, changes.join(", "));

  const { loadChangeBundle } = await import("../packages/artifacts/dist/index.js");
  const proposals = {};
  for (const changeId of changes) {
    const bundle = await loadChangeBundle({ repositoryRoot: root, changeId });
    proposals[changeId] = bundle.ok
      ? bundle.deltaSpecs.map((delta) => delta.proposedRequirement?.id).filter(Boolean)
      : [];
  }

  const [first, second] = changes;
  const foreign = proposals[second].find((id) => !proposals[first].includes(id));
  assert.ok(foreign !== undefined, JSON.stringify(proposals));

  // Current specs would otherwise supply the ID, which is the source being
  // isolated from.
  await rm(path.join(root, ".legion/project/specs"), { recursive: true, force: true });

  const ids = await resolvableRequirementIds(
    root,
    { ok: false, status: "not_found", reason: "none" },
    first
  );
  assert.equal(
    ids.has(foreign),
    false,
    `${foreign} belongs to ${second} and must not resolve for ${first}`
  );
});

test("an unreadable specs directory is reported, not thrown", async (t) => {
  const { root, run } = await plannedProject(t);

  // `listCurrentSpecs` handles only ENOENT, so an unreadable specs root
  // propagated ENOTDIR out of validate and doctor instead of producing their
  // structured payloads. The changes root was guarded and this one was not,
  // which is the same defect one directory over.
  await rm(path.join(root, ".legion/project/specs"), { recursive: true, force: true });
  await writeFile(path.join(root, ".legion/project/specs"), "not a directory\n", "utf8");

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 1, "an unreadable specs root must be reported");
  assert.doesNotMatch(validated.stderr, /ENOTDIR|Unhandled|not a function/);

  const codes = parseJsonOutput(validated).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("artifact_root_unreadable"),
    `expected artifact_root_unreadable, got ${codes.join(", ")}`
  );

  // Doctor must not disagree by crashing where validate reports.
  const doctored = await run("doctor", "--json");
  assert.equal(doctored.exitCode, 1);
  assert.doesNotMatch(doctored.stderr, /ENOTDIR|Unhandled/);
});
