import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Declaring a verification surface at intake, and following it all the way to a
 * ship gate.
 *
 * The surface is *declared*, never inferred from a command string: `pnpm test
 * --filter integration` may be a pure unit suite and `node scripts/smoke.mjs`
 * may drive a live database, so inference misclassifies in both directions and
 * does so silently. That decision is what makes this file necessary — the fact
 * has to survive an interview, a finalize, a plan, a build and a ship, through
 * five artifacts written by four commands, and nothing else in the tree joins
 * those spellings together.
 *
 * In particular this is the only thing that ties `build.ts`'s
 * `id: "integration-surface-check"` to `ship-gates.ts`'s reader. No schema
 * enumerates evidence item ids, so a typo between the two packages would leave
 * every unit suite green and the gate permanently `unevaluable` on a repository
 * that declared its surfaces correctly.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";

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
  "req-1-ac-1-statement": "A quote request reaches the running pricing service",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --version",
  "req-1-ac-1-surface-kind": "real-interface",
  "req-1-ac-1-surface-interface": "POST /v1/quote",
  "req-1-ac-1-surface-rationale":
    "The check starts the pricing service and posts a real quote, with no HTTP stub in the path.",
  "req-1-ac-1-surface-pins": COMPOSE_PATH,
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Currency conversion",
  constraints: "TypeScript only",
  // R2 is the tier whose gate set derives integration_or_real_interface_checks.
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
  const root = await mkdtemp(path.join(tmpdir(), "legion-surface-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  // The file the surface pins. A declaration pinning something that does not
  // exist is refused at finalize, which is its own test below.
  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(
    path.join(root, COMPOSE_PATH),
    "services:\n  pricing:\n    image: pricing:latest\n",
    "utf8"
  );

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  const intake = await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  return { root, run, intake };
}

async function finalized(t, answers) {
  const { root, run, intake } = await repository(t, answers);
  assert.equal(intake.exitCode, 0, intake.stdout + intake.stderr);
  const result = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  return { root, run, result };
}

async function plannedWith(t, answers) {
  const { root, run, result } = await finalized(t, answers);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const plan = await run("plan", "1", "--json");
  assert.equal(plan.exitCode, 0, plan.stdout + plan.stderr);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  return { root, run, changeId };
}

async function planned(t) {
  return plannedWith(t, ANSWERS);
}

async function readJson(root, ...segments) {
  return JSON.parse(await readFile(path.join(root, ...segments), "utf8"));
}

test("one authored surface reaches the requirement, the contract and the oracle unchanged", async (t) => {
  // Three copies, one author. `oracle-input.ts` records what a second derivation
  // cost the last time this rule was broken: the bundle named an inspection
  // oracle the file had stopped writing, so every plan of a command-decided
  // requirement referenced an artifact that did not exist. Compared including the
  // minted `sha256`, because a re-hash on either side is exactly the drift a
  // set-equal comparison would miss.
  const { root, changeId } = await planned(t);

  const requirementFiles = await readdir(path.join(root, ".legion/project/requirements"));
  const requirementFile = requirementFiles.find((name) => name.startsWith("req_"));
  const requirement = await readJson(root, ".legion/project/requirements", requirementFile);
  const authored = requirement.acceptance.criteria[0].proof.surface;

  assert.equal(authored.kind, "real-interface");
  assert.equal(authored.interface, "POST /v1/quote");
  assert.equal(authored.pinned.length, 1);
  assert.equal(authored.pinned[0].path, COMPOSE_PATH);
  assert.match(authored.pinned[0].sha256, /^sha256:[0-9a-f]{64}$/);

  const taskgraph = await readJson(root, ".legion/project/changes", changeId, "taskgraph.json");
  const declared = taskgraph.tasks[0].verification.filter((entry) => entry.surface !== undefined);
  assert.equal(declared.length, 1, "exactly the criterion's own command carries the declaration");
  assert.deepStrictEqual(declared[0].surface, authored);

  // The project-wide regression command nobody declared anything about must not
  // acquire a surface by being in the same array.
  assert.ok(
    taskgraph.tasks[0].verification.some(
      (entry) => entry.command === "legion" && entry.surface === undefined
    ),
    "the appended project verification command must carry no surface"
  );

  const oracleFiles = await readdir(path.join(root, ".legion/project/changes", changeId, "oracle"));
  const oracles = await Promise.all(
    oracleFiles.map(async (name) => readJson(root, ".legion/project/changes", changeId, "oracle", name))
  );
  const withSurface = oracles.filter((document) => document.oracle.surface !== undefined);
  assert.equal(withSurface.length, 1, "one executable oracle carries the declaration");
  assert.equal(withSurface[0].oracle.type, "executable");
  assert.deepStrictEqual(withSurface[0].oracle.surface, authored);
});

test("a declared integration surface is built, evidenced and satisfies the ship gate", async (t) => {
  // The whole chain, and the only place `integration-surface-check` is spelled by
  // both the writer and the reader in one run.
  const { root, run, changeId } = await planned(t);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);

  const index = await readJson(root, ".legion/project/changes", changeId, "evidence-index.json");
  const items = index.entries.at(-1).evidence.items;
  const surfaceItem = items.find((entry) => entry.id === "integration-surface-check");
  assert.ok(surfaceItem !== undefined, `no integration-surface-check in ${JSON.stringify(items.map((e) => e.id))}`);
  assert.equal(surfaceItem.verdict, "pass");
  assert.equal(surfaceItem.classification, "test-report");
  // Every item must carry an artifact or a command or the whole evidence index is
  // rejected with `missing_evidence_hash`.
  assert.ok(surfaceItem.artifact !== undefined);

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--json")).exitCode, 0);

  // R2 still blocks on three producerless gates, so ship exits 1. What this
  // asserts is that the integration gate is not one of them: a satisfied gate
  // emits no diagnostic.
  const shipped = await run("ship", "--json");
  const payload = parseJsonOutput(shipped);
  const blocked = (payload.diagnostics ?? []).filter(
    (entry) => entry.gate === "integration_or_real_interface_checks"
  );
  assert.deepEqual(blocked, [], `the integration gate should be satisfied: ${JSON.stringify(blocked)}`);
});

test("editing a pinned file after the build blocks the ship the passing evidence would not", async (t) => {
  // The one test that can falsify a missing pin collector in `ship.ts`. A
  // reference nobody pre-resolves answers `unverified`, which the gate reports as
  // `unevaluable` — indistinguishable from "nothing declared a surface" — so a
  // ship that never collected these pins would look correctly conservative in
  // every other test in the tree while checking nothing at all. A unit test
  // injecting `verifyPin: () => "drift"` tests the gate and not the collector.
  const { root, run, changeId } = await planned(t);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--json")).exitCode, 0);

  const clean = parseJsonOutput(await run("ship", "--json"));
  assert.deepEqual(
    (clean.diagnostics ?? []).filter((entry) => entry.gate === "integration_or_real_interface_checks"),
    []
  );

  // Swapping the real service for an in-memory fake is exactly the edit a passing
  // suite hides and this gate exists to catch.
  await writeFile(
    path.join(root, COMPOSE_PATH),
    "services:\n  pricing:\n    image: pricing-inmemory:latest\n",
    "utf8"
  );

  const drifted = parseJsonOutput(await run("ship", "--json"));
  const diagnostics = (drifted.diagnostics ?? []).filter(
    (entry) => entry.gate === "integration_or_real_interface_checks"
  );
  assert.equal(diagnostics.length, 1, JSON.stringify(drifted.diagnostics));
  assert.equal(diagnostics[0].code, "risk_gate_unsatisfied");
  assert.match(diagnostics[0].message, new RegExp(COMPOSE_PATH));
  assert.match(diagnostics[0].message, /bytes have changed/);

  // The evidence still says the run passed, which is the point: the gate's answer
  // moved without the build's.
  const index = await readJson(root, ".legion/project/changes", changeId, "evidence-index.json");
  assert.equal(
    index.entries.at(-1).evidence.items.find((entry) => entry.id === "integration-surface-check").verdict,
    "pass"
  );
});

test("finalize refuses a surface that pins a file nobody can read, and writes nothing", async (t) => {
  // Recording the declaration anyway and letting the gate sort it out would give
  // an operator who explicitly said "this crosses a boundary" the same ship
  // verdict as one who said nothing — `unevaluable`. That is the fail-open this
  // gate closes, arriving through the authoring path before any gate runs.
  const { root, result } = await finalized(t, {
    ...ANSWERS,
    "req-1-ac-1-surface-pins": "ops/compose.nonexistent.yml"
  });

  assert.equal(result.exitCode, 1, result.stdout);
  const payload = parseJsonOutput(result);
  assert.equal(payload.status, "invalid");
  const diagnostic = payload.diagnostics.find((entry) => entry.code === "unpinnable_surface");
  assert.ok(diagnostic !== undefined, JSON.stringify(payload.diagnostics));
  assert.match(diagnostic.message, /ops\/compose\.nonexistent\.yml/);
  assert.equal(diagnostic.nodeId, "req-1-ac-1-surface-pins");

  // Nothing was written: the refusal happens inside the window where every check
  // runs before any artifact does, so one `--answer` repairs it and `--finalize`
  // runs again against a clean tree.
  await assert.rejects(readdir(path.join(root, ".legion/project/requirements")));
});

test("a Windows-style pinned path is refused at the question, not inside a schema parse", async (t) => {
  // `artifactPathSchema` forbids backslashes, drive letters, leading slashes and
  // `..`, which is every property of a path pasted out of a Windows shell.
  // Without a rule at the node it passed both validation layers and threw out of
  // `requirementSchema.parse` during --finalize, where the operator gets a stack
  // trace instead of the question back.
  const { intake } = await repository(t, {
    ...ANSWERS,
    "req-1-ac-1-surface-pins": "C:\\src\\ops\\compose.yml"
  });

  assert.equal(intake.exitCode, 1, intake.stdout);
  assert.match(intake.stdout + intake.stderr, /not a repository-relative path/);
});

test("an interview that declines the surface question still finalizes and plans", async (t) => {
  // The shape of every intake fixture in the tree and of every project that
  // predates this release. The surface nodes are optional, so an answer file that
  // never heard of them records a skip and the three follow-ups never become
  // applicable — and the ship gate reports `unevaluable`, which is the honest
  // answer rather than a manufactured `unit`.
  const undeclared = { ...ANSWERS };
  delete undeclared["req-1-ac-1-surface-kind"];
  delete undeclared["req-1-ac-1-surface-interface"];
  delete undeclared["req-1-ac-1-surface-rationale"];
  delete undeclared["req-1-ac-1-surface-pins"];

  const { root, run, result } = await finalized(t, undeclared);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);

  const requirementFiles = await readdir(path.join(root, ".legion/project/requirements"));
  const requirement = await readJson(
    root,
    ".legion/project/requirements",
    requirementFiles.find((name) => name.startsWith("req_"))
  );
  assert.equal(requirement.acceptance.criteria[0].proof.surface, undefined);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const taskgraph = await readJson(root, ".legion/project/changes", changeId, "taskgraph.json");
  assert.ok(taskgraph.tasks[0].verification.every((entry) => entry.surface === undefined));
});

test("a criterion whose command is also the project command is planned once, with its surface", async (t) => {
  // The dedupe key in `phaseVerification` used a `JSON.stringify` replacer array,
  // which filters property names at every nesting level — so the moment a
  // verification entry gained a nested `surface`, that object serialized as `{}`
  // and its key list stopped matching the project entry's. A criterion whose
  // command *is* the project verification command therefore stopped colliding
  // with it and the same command was planned twice, under two entries, one of
  // which carried the declaration. Exactly the duplication that key exists to
  // prevent, reintroduced by the shape of the field being added.
  const { root, run, result } = await finalized(t, {
    ...ANSWERS,
    // The criterion command and the project verification command, identical.
    "req-1-ac-1-detail": "legion validate",
    "pref-verification": "legion validate"
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const taskgraph = await readJson(root, ".legion/project/changes", changeId, "taskgraph.json");

  assert.deepEqual(
    taskgraph.tasks[0].verification.map((entry) => [entry.command, ...entry.args].join(" ")),
    ["legion validate"],
    "one command, planned once"
  );
  // And the survivor is the criterion's entry, the one carrying the declaration —
  // not the undeclared project entry.
  assert.equal(taskgraph.tasks[0].verification[0].surface.kind, "real-interface");
});

test("a failing declared integration command is recorded fail by the producer itself", async (t) => {
  // Nothing in the tree drove a *failing* declared non-unit surface through
  // `legion build`: the producer only ever emitted `pass`, and `fail` was
  // injected as a literal at the gate. So the branch that turns a failing
  // command into `integration-surface-check: fail` — the one an operator's
  // broken integration check actually travels — was never executed by any test,
  // and could have been inverted without a single assertion noticing.
  const { root, run, changeId } = await plannedWith(t, {
    ...ANSWERS,
    // Node exits non-zero on an unknown option, which is a failing command on
    // every platform without shipping a script to fail.
    "req-1-ac-1-detail": "node --this-option-does-not-exist"
  });

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 1, "a failing verification command blocks the build");

  const index = await readJson(root, ".legion/project/changes", changeId, "evidence-index.json");
  const items = index.entries.at(-1).evidence.items;
  const surfaceItem = items.find((entry) => entry.id === "integration-surface-check");
  assert.ok(surfaceItem !== undefined, `no integration-surface-check in ${JSON.stringify(items.map((e) => e.id))}`);
  assert.equal(surfaceItem.verdict, "fail");
});

test("a build run against bytes the declaration does not describe is not recorded as a pass", async (t) => {
  // The swap-and-revert. The pins were hashed when the declaration was authored
  // and again at ship time, never while the command ran — so `satisfied`
  // established "the declared bytes are on disk now" and "a command passed at
  // some point", and never that the command passed against the declared bytes.
  //
  // Overwrite the compose file so it names an in-memory fake, build (the
  // declared command runs against the fake and passes), then restore the file.
  // Every later hash agrees; the run provably executed against the fake. This is
  // the same shape without any adversarial intent: an operator who experiments
  // with a stub during development, builds, then reverts the experiment.
  const { root, run, changeId } = await planned(t);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  const original = await readFile(path.join(root, COMPOSE_PATH), "utf8");
  await writeFile(
    path.join(root, COMPOSE_PATH),
    "services:\n  pricing:\n    image: pricing-inmemory-fake:latest\n",
    "utf8"
  );
  // Committed, so this is an ordinary source edit rather than an uncommitted
  // working-tree change the guarded execution refuses on its own.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "swap the pricing service for a fake"]);
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);
  await writeFile(path.join(root, COMPOSE_PATH), original, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "restore the real pricing service"]);

  const index = await readJson(root, ".legion/project/changes", changeId, "evidence-index.json");
  const surfaceItem = index.entries
    .at(-1)
    .evidence.items.find((entry) => entry.id === "integration-surface-check");
  assert.equal(surfaceItem.verdict, "unknown", "the command passed, but not against the declared bytes");

  // The persisted report says which file and what it actually held, so an
  // auditor following the item's reference can substantiate the verdict rather
  // than take it on trust.
  const runDirectories = await readdir(path.join(root, ".legion/project/changes", changeId, "runs"));
  const reportPath = path.join(
    root,
    ".legion/project/changes",
    changeId,
    "runs",
    runDirectories.at(-1),
    "verification-report.json"
  );
  const persisted = JSON.parse(await readFile(reportPath, "utf8"));
  const mismatched = persisted.surfaceChecks.find((check) => check.outcome === "mismatched");
  assert.ok(mismatched !== undefined, JSON.stringify(persisted.surfaceChecks));
  assert.equal(mismatched.pins[0].path, COMPOSE_PATH);
  assert.notEqual(mismatched.pins[0].observed, mismatched.pins[0].declared);

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--json")).exitCode, 0);

  // And the gate refuses to certify it, with every pin on disk matching.
  const shipped = parseJsonOutput(await run("ship", "--json"));
  const diagnostics = (shipped.diagnostics ?? []).filter(
    (entry) => entry.gate === "integration_or_real_interface_checks"
  );
  assert.equal(diagnostics.length, 1, JSON.stringify(shipped.diagnostics));
  assert.equal(diagnostics[0].code, "risk_gate_unevaluable");
});

test("a legitimately edited pin is unblocked by a named human, and by nothing else", async (t) => {
  // The blocking defect this release corrects. A verification-surface pin was
  // minted only at `legion start --finalize`, and no command in Legion could
  // re-mint it: a second interview cannot finalize over the first
  // (`requirement_set_conflict`), a finalized session cannot be aborted, and
  // `legion plan` refuses to re-plan a change with evidence. So the first byte
  // changed in an integration harness — the honest maintenance the whole
  // declaration exists to encourage — permanently unsatisfied this gate, and
  // `GATE_RECOVERY` named no way back.
  const { root, run, changeId } = await planned(t);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--json")).exitCode, 0);

  // Bumping the pinned image tag: the edit that keeps an integration check real.
  await writeFile(
    path.join(root, COMPOSE_PATH),
    "services:\n  pricing:\n    image: pricing:2\n",
    "utf8"
  );

  const blocked = parseJsonOutput(await run("ship", "--json"));
  const before = (blocked.diagnostics ?? []).filter(
    (entry) => entry.gate === "integration_or_real_interface_checks"
  );
  assert.equal(before.length, 1);
  assert.equal(before[0].code, "risk_gate_unsatisfied");
  // The blocked ship routes to the cure. Nine gates in this series are still
  // producerless, so ship keeps its own fallback command and names the one that
  // can produce the missing evidence — which is the third arm of
  // `shipGateRecovery` and the honest answer while the other gates cannot be
  // satisfied by anything.
  assert.match(blocked.nextAction?.reason ?? "", /legion approve surface --approver <id>/);

  // The dry run writes nothing and says so.
  const dry = parseJsonOutput(await run("approve", "surface", "--approver", "dasbl", "--dry-run", "--json"));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.drifted, [COMPOSE_PATH]);
  const approvalsBefore = await readdir(path.join(root, ".legion/project/changes", changeId, "approvals")).catch(
    () => []
  );
  assert.equal(
    approvalsBefore.filter((name) => name.includes("approval")).length,
    approvalsBefore.length,
    "a dry run writes nothing"
  );

  const reaffirmed = parseJsonOutput(await run("approve", "surface", "--approver", "dasbl", "--json"));
  assert.equal(reaffirmed.status, "approved");
  assert.deepEqual(reaffirmed.drifted, []);
  assert.equal(reaffirmed.reaffirmations[0].path, COMPOSE_PATH);
  assert.equal(reaffirmed.reaffirmations[0].decidedBy.kind, "human");
  assert.equal(reaffirmed.reaffirmations[0].decidedBy.id, "dasbl");

  const after = parseJsonOutput(await run("ship", "--json"));
  assert.deepEqual(
    (after.diagnostics ?? []).filter((entry) => entry.gate === "integration_or_real_interface_checks"),
    [],
    "the gate is satisfied once a named human has re-affirmed the declaration"
  );

  // A second run decides nothing: `decidedAt` is what a later ordering gate
  // compares against a run's start, so a harmless rerun must not move it.
  const rerun = parseJsonOutput(await run("approve", "surface", "--approver", "dasbl", "--json"));
  assert.equal(rerun.status, "unchanged");

  // And the cure is one revision deep, not a blanket exemption: edit again and
  // the gate blocks again.
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:3\n", "utf8");
  const blockedAgain = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    (blockedAgain.diagnostics ?? []).filter(
      (entry) => entry.gate === "integration_or_real_interface_checks"
    ).length,
    1
  );
});

test("re-affirming requires a named human, and refuses a file nobody can hash", async (t) => {
  // The three properties that make this a decision rather than a laundering
  // mechanism: it needs `--approver`, the approver must be a recorded decision
  // owner, and it records the digest of a file that is actually there.
  const { root, run } = await planned(t);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:2\n", "utf8");

  const noApprover = await run("approve", "surface", "--json");
  assert.equal(noApprover.exitCode, 1);
  assert.match(parseJsonOutput(noApprover).diagnostics[0].code, /approver_required/);

  const unknownApprover = await run("approve", "surface", "--approver", "nobody", "--json");
  assert.equal(unknownApprover.exitCode, 1);

  await rm(path.join(root, COMPOSE_PATH));
  const gone = await run("approve", "surface", "--approver", "dasbl", "--json");
  assert.equal(gone.exitCode, 1);
  assert.equal(parseJsonOutput(gone).diagnostics[0].code, "unreadable_surface_pin");
});

test("a pinned path named twice is refused at the question, not as a zod stack trace", async (t) => {
  // `verificationSurfaceSchema.superRefine` forbids pinning a path twice and
  // `buildRequirements` calls `requirementSchema.parse` rather than `safeParse`,
  // so a repeated path — what listing files by hand produces — escaped both
  // intake layers and surfaced at `--finalize` as a raw zod issue array with no
  // nodeId, no slot and no recovery, one line away from the named
  // `invalid_surface_path` diagnostic for every other property of the same
  // answer. That is exactly what `mintPinnedReferences` says it exists to
  // prevent.
  const { intake } = await repository(t, {
    ...ANSWERS,
    "req-1-ac-1-surface-pins": `${COMPOSE_PATH}, ${COMPOSE_PATH}`
  });

  assert.equal(intake.exitCode, 1, intake.stdout);
  assert.match(intake.stdout + intake.stderr, /named twice/);
  assert.doesNotMatch(intake.stdout + intake.stderr, /unhandled_error/);
});
