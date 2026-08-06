import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Declaring which tests the work must not weaken, and following the declaration
 * to the oracle a ship gate reads.
 *
 * The fact has to survive an interview, a finalize and a plan, through three
 * artifacts written by three commands, and nothing else in the tree joins those
 * spellings together. In particular this is the only thing that ties the intake
 * node `req-N-ac-M-acceptance-paths` to `oracle.acceptancePaths`: no schema
 * enumerates node ids, so a rename on one side would leave every unit suite
 * green while `protected_acceptance_tests` reported "nobody declared one" on a
 * repository that had declared one correctly.
 *
 * It also holds the *placement* claims, which are decisions rather than details.
 * The declaration lands on the oracle and deliberately not on the task contract:
 * `shipGatePinnedReferences` records, with measurement, that copying the
 * verification surface onto both made deleting either collector redden nothing
 * under mutation, and names this release's oracle work as the thing that could
 * reintroduce it. One authored home and one derived home is the answer.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const ACCEPTANCE_PATH = "tests/pricing.acceptance.test.mjs";

const ANSWERS = {
  "project-name": "Order Router",
  "project-summary": "Routes orders to the pricing service.",
  "project-owner": "dasbl",
  "problem-statement": "Orders are priced against a stub, so drift ships.",
  "problem-users": "Payments engineers.",
  "problem-success": "A pricing change that breaks the contract fails before release.",
  "req-1-statement": "Orders are priced against the real pricing service",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A quote request is priced by the pricing service",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --version",
  "req-1-ac-1-acceptance-paths": ACCEPTANCE_PATH,
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Currency conversion",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "A new surface other services depend on.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function repository(t, answers = ANSWERS) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-acceptpaths-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  return { root, run };
}

async function requirementDocument(root) {
  const dir = path.join(root, ".legion", "project", "requirements");
  const files = (await readdir(dir)).filter((name) => name.startsWith("req_")).sort();
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"));
}

async function oracleDocuments(root) {
  const changes = path.join(root, ".legion", "project", "changes");
  const [changeId] = await readdir(changes);
  const dir = path.join(changes, changeId, "oracle");
  const files = (await readdir(dir)).sort();
  const documents = [];
  for (const file of files) {
    documents.push(JSON.parse(await readFile(path.join(dir, file), "utf8")).oracle);
  }
  return { changeId, documents };
}

test("the question is asked once per executable criterion, and only for those", async (t) => {
  // `dependsOn` names the proof node and nothing else, and one condition buys
  // both exclusions: a `manual` criterion answers `manual` and fails the
  // `equals`, and a `wont` requirement never answers `-proof` at all and fails it
  // transitively. Expressing the wont-skip structurally instead would be the
  // second conditionality mechanism `materializeNodes` warns against, so the
  // claim is asserted rather than assumed.
  const { run } = await repository(t, {
    ...ANSWERS,
    "req-1-ac-1-proof": "manual",
    "req-1-ac-1-detail": "A human has to look at the rendered invoice and judge it.",
    "req-1-ac-1-acceptance-paths": undefined
  });

  const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
  assert.equal(applied.exitCode, 0, applied.stdout + applied.stderr);
  const payload = parseJsonOutput(applied);
  assert.equal(
    payload.applied.includes("req-1-ac-1-acceptance-paths"),
    false,
    "a criterion a human decides constrains no run, so the question is not asked"
  );
});

test("a declaration reaches the requirement's executable proof arm, and nothing else", async (t) => {
  const { root, run } = await repository(t);
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  const finalized = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalized.exitCode, 0, finalized.stdout + finalized.stderr);

  const requirement = await requirementDocument(root);
  const proof = requirement.acceptance.criteria[0].proof;
  assert.equal(proof.mode, "executable");
  assert.deepEqual(proof.acceptancePaths, [ACCEPTANCE_PATH]);
});

test("a declaration reaches the oracle, and deliberately not the task contract", async (t) => {
  // The placement claim. Copying it onto both would recreate the parity that made
  // a mutation of either surface collector redden nothing; with one derived home,
  // deleting the copy in `oracle-input.ts` reddens this.
  const { root, run } = await repository(t);
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  assert.equal((await run("start", "--finalize", "--created-at", CREATED_AT)).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);

  const { changeId, documents } = await oracleDocuments(root);
  const executable = documents.find((document) => document.type === "executable");
  assert.deepEqual(executable.acceptancePaths, [ACCEPTANCE_PATH]);

  // `protectedPaths` is untouched, and that separation is the design. It names
  // the control artifacts the guarded harness *restores*; widening it to hold
  // acceptance tests would make every entry eligible for rollback.
  assert.deepEqual(executable.protectedPaths, [
    `.legion/project/changes/${changeId}/change.yaml`
  ]);

  const taskgraph = JSON.parse(
    await readFile(path.join(root, ".legion", "project", "changes", changeId, "taskgraph.json"), "utf8")
  );
  assert.equal(
    JSON.stringify(taskgraph).includes(ACCEPTANCE_PATH),
    false,
    "the task contract carries no copy: one authored home and one derived home is what makes the mutant killable"
  );
});

test("a path that is not repository-relative is refused at the node, by name", async (t) => {
  const { run } = await repository(t, { ...ANSWERS, "req-1-ac-1-acceptance-paths": "C:\\tests\\a.test.mjs" });
  const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
  assert.equal(applied.exitCode, 1);
  assert.match(JSON.stringify(parseJsonOutput(applied).diagnostics), /invalid_acceptance_path/);
});

test("a control-plane path is refused, because that population is restored rather than reported", async (t) => {
  // The two populations get opposite treatment, so an overlap would be a control
  // artifact reported as a mere observation. Refused at authoring so the
  // disjointness is a property of the documents rather than of the walkers.
  const { run } = await repository(t, {
    ...ANSWERS,
    "req-1-ac-1-acceptance-paths": ".legion/project/changes/chg_x/change.yaml"
  });
  const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
  assert.equal(applied.exitCode, 1);
  assert.match(JSON.stringify(parseJsonOutput(applied).diagnostics), /control_plane_acceptance_path/);
});

test("a control-plane path spelled in another case is refused too, on every filesystem", async (t) => {
  // The refusal above was an exact string comparison, at all four layers that
  // make it: this node validator, the answer-set validator, the schema's
  // `superRefine`, and the harness's `classifyAcceptancePath`. So
  // `.Legion/project/project.json` passed every one of them, and on Windows or
  // macOS it then resolved to the real control artifact — which the harness
  // restores *before* it compares, making before and after equal
  // unconditionally, the verdict `pass`, and the gate satisfied by a declaration
  // that protected no test at all. The identical document on a case-sensitive CI
  // reads absent on both sides and answers `unevaluable`, so the gate's verdict
  // depended on the filesystem rather than on the record. Driven through the
  // real intake because the point is that all four layers now agree.
  for (const spelling of [".Legion/project/project.json", ".LEGION/PROJECT/changes/chg_x/change.yaml"]) {
    const { run } = await repository(t, { ...ANSWERS, "req-1-ac-1-acceptance-paths": spelling });
    const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
    assert.equal(applied.exitCode, 1, `${spelling} must be refused`);
    assert.match(JSON.stringify(parseJsonOutput(applied).diagnostics), /control_plane_acceptance_path/);
  }
});

test("the schema refuses a case-folded control-plane path, so a hand-written oracle cannot carry one", async () => {
  // The intake refusal above is the operator's route. A planned oracle is a file
  // on disk, so the schema is the layer that has to hold for a document nobody
  // typed at an interview — and it is the layer whose docblock claims "the two
  // populations cannot overlap".
  const { acceptancePathsSchema } = await import("../packages/protocol/dist/index.js");
  assert.equal(acceptancePathsSchema.safeParse([".legion/project/change.yaml"]).success, false);
  assert.equal(acceptancePathsSchema.safeParse([".Legion/project/change.yaml"]).success, false);
  assert.equal(acceptancePathsSchema.safeParse([".LEGION/PROJECT/change.yaml"]).success, false);
  assert.equal(acceptancePathsSchema.safeParse([".legionx/project/change.yaml"]).success, true);
  assert.equal(acceptancePathsSchema.safeParse(["tests/pricing.test.mjs"]).success, true);
});

test("a path named twice is refused rather than counted twice", async (t) => {
  // The schema's own rule, checked here as well because `buildRequirements`
  // parses rather than safe-parses — so without it the answer "a, a", which is
  // what listing files by hand produces, reaches `--finalize` as a raw zod issue
  // array with no nodeId, no slot and no recovery.
  const { run } = await repository(t, {
    ...ANSWERS,
    "req-1-ac-1-acceptance-paths": `${ACCEPTANCE_PATH}, ${ACCEPTANCE_PATH}`
  });
  const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
  assert.equal(applied.exitCode, 1);
  assert.match(JSON.stringify(parseJsonOutput(applied).diagnostics), /duplicate_acceptance_path/);
});

test("more paths than the schema admits is refused at the node, not at finalize", async (t) => {
  const many = Array.from({ length: 9 }, (_, index) => `tests/case-${index}.test.mjs`).join("\n");
  const { run } = await repository(t, { ...ANSWERS, "req-1-ac-1-acceptance-paths": many });
  const applied = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT, "--json");
  assert.equal(applied.exitCode, 1);
  assert.match(JSON.stringify(parseJsonOutput(applied).diagnostics), /too_many_acceptance_paths/);
});

test("a declaration on a manual criterion is refused rather than dropped", async (t) => {
  // The half-declared-becomes-absent fail-open, arriving through the authoring
  // path before a gate ever runs. The manual proof arm has nowhere to put a
  // declaration, so without this refusal `criterionFor` would drop it in silence
  // and "these tests must not be weakened" would become the same answer as
  // "nobody said". Unreachable through the graph, which asks the question only
  // for an executable criterion, and reachable through a hand-edited session file
  // — which is what this drives.
  const { root, run } = await repository(t);
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);

  const sessions = path.join(root, ".legion", "project", "intake");
  const [sessionId] = await readdir(sessions);
  const target = path.join(sessions, sessionId, "session.json");
  const session = JSON.parse(await readFile(target, "utf8"));
  for (const answer of session.answers) {
    if (answer.nodeId === "req-1-ac-1-proof") answer.value = "manual";
    if (answer.nodeId === "req-1-ac-1-detail") {
      answer.value = "A human has to look at the rendered invoice and judge it.";
    }
  }
  await writeFile(target, JSON.stringify(session, null, 2), "utf8");

  const finalized = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalized.exitCode, 1, finalized.stdout);
  assert.match(
    JSON.stringify(parseJsonOutput(finalized).diagnostics),
    /acceptance_paths_on_manual_criterion/
  );
});
