import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { deriveShipGates } from "../packages/cli/dist/workflow/ship-gates.js";
import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * An R3 change, driven end to end, with every one of its ten gates satisfied.
 *
 * `approved_spec_and_oracle` is ADR-006's ordering gate: the spec and the oracle
 * are both approved **before** gated execution proceeds. Until this release
 * nothing anywhere recorded a decision about an oracle, so the gate fell through
 * `evaluateGate`'s `default:` arm and every R3 change was structurally
 * unshippable for a reason no command could move.
 *
 * **This file now claims R3 ships, and the last test in it is that claim driven
 * through the real CLI.** All ten of R3's gates have producers: `protected_oracle`
 * and `deterministic_verification` from the evidence items,
 * `explicit_human_approval` from the approval plane, `approved_spec_and_oracle`
 * from its ordering, `independent_baseline`, `security_or_e2e_evaluator` and
 * `rollback_or_forward_fix_evidence` from the attestation plane,
 * `architecture_or_security_review` from review domains,
 * `protected_acceptance_tests` from the guarded harness's acceptance-path
 * observation, and `release_observation_plan` from the release plan this release
 * adds. The producerless set is still **derived from the compiled gate module**
 * rather than typed out here, for a reason that outlives its original job: a list
 * edited by hand stays true when a gate silently regresses to `evaluateGate`'s
 * `default:` arm, and the derivation reddens when it does. It is empty now, and
 * it stays as the tripwire.
 *
 * The two things this file can prove that no unit test can: that the real
 * command sequence produces the ordering the gate needs, and that the verdict
 * for an ordering that went the other way names a recovery which does not make it
 * worse.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";
const ACCEPTANCE_PATH = "acceptance.test.mjs";

/** The sentence `evaluateGate`'s `default:` arm answers with, matched exactly. */
const NO_PRODUCER_REASON = "Legion does not yet produce evidence for this gate.";

/**
 * The R3 gates that still answer from `evaluateGate`'s `default:` arm, derived
 * from the compiled module rather than transcribed.
 *
 * An earlier release named the set by hand and asserted it in both directions, on
 * the argument that a count would stay true if one gate silently regressed while
 * another gained a producer. That argument was right and the mechanism was not
 * sufficient: a hand-written array is edited by whoever closes a gate, and it
 * stays green if the gate they closed quietly falls back to the `default:` arm on
 * the very next change. Deriving it from `deriveShipGates` over an R3 task with
 * **no change facts at all** closes that, because the only rows this can select
 * are rows that genuinely came from that arm.
 *
 * It is asserted against the expected value below rather than only used, so this
 * is still a claim a later author has to edit rather than a tautology.
 */
function producerlessR3Gates() {
  const report = deriveShipGates({
    tasks: [{ id: "ctr_derivation", risk: { tier: "R3", reasons: ["derivation"] } }],
    taskIdFor: () => "tsk_derivation",
    entries: [],
    reviews: [],
    change: undefined
  });
  return [
    ...new Set(report.gates.filter((gate) => gate.reason === NO_PRODUCER_REASON).map((gate) => gate.gate))
  ].sort();
}

/**
 * **Empty, as of this release, and that is the milestone this file now records.**
 *
 * `release_observation_plan` was the last entry and gains a producer here, so
 * every one of R3's ten gates can be answered. The constant and the assertion
 * stay rather than being deleted, and they change job: they are no longer "what
 * a later release still owes" but "no gate regressed to `evaluateGate`'s
 * `default:` arm". `evaluateGate` keeps that arm for exactly this reason — delete
 * it and the derivation returns `[]` by construction, which is the tautology this
 * file's own comment warns against.
 */
const PRODUCERLESS_R3_GATES = [];

test("no R3 gate answers from evaluateGate's producerless arm", () => {
  // Both directions, and derived on one side. Let any of the ten fall back to the
  // `default:` arm and this reddens without anybody having touched it, which the
  // hand-written array this replaced could not do.
  assert.deepEqual(producerlessR3Gates(), PRODUCERLESS_R3_GATES);
});

/**
 * R3 with one executable criterion declaring a real-interface surface.
 *
 * One executable criterion and no manual ones, which `legion plan` materialises
 * as exactly one oracle and exactly one task — the smallest shape that still
 * exercises every quantifier the gate has, since the union of `task.oracleRefs`
 * is then non-empty and resolvable and the delta set is non-empty too.
 */
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
  "risk-tier": "R3",
  "risk-reason": "A new surface other services depend on.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * An R3 change planned and committed, one command short of any approval.
 *
 * `acceptancePaths` is opt-in rather than always on, and the split is the claim
 * every test above depends on: without a declared acceptance path,
 * `protected_acceptance_tests` answers its nothing-was-declared arm and stays in
 * the unmet set, which is what those tests assert. The R3 milestone is the one
 * fixture that declares one, because it is the one that has to satisfy all ten.
 */
async function plannedR3(t, { acceptancePaths = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-r3-ordering-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");

  if (acceptancePaths) {
    // A real file, because a declared path that is not there when a run starts is
    // reported as unknown rather than as unchanged.
    await writeFile(
      path.join(root, ACCEPTANCE_PATH),
      "// the check that decides this criterion\nexport const ok = true;\n",
      "utf8"
    );
  }

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  const answers = acceptancePaths ? { ...ANSWERS, "req-1-ac-1-acceptance-paths": ACCEPTANCE_PATH } : ANSWERS;
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  const finalized = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalized.exitCode, 0, finalized.stdout + finalized.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const changeDir = path.join(root, ".legion/project/changes", changeId);
  return { root, run, changeId, changeDir, planned: parseJsonOutput(planned) };
}

/** Every decision instant the ordering gate reads, off disk. */
async function decisionInstants(changeDir) {
  const dir = path.join(changeDir, "approvals");
  const instants = [];
  for (const name of await readdir(dir)) {
    const document = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    if (document.scope.action !== "spec.delta.approve" && document.scope.action !== "oracle.approve") continue;
    instants.push(document.decidedAt);
  }
  return instants;
}

/** Every run start, off disk. */
async function runStarts(changeDir) {
  const dir = path.join(changeDir, "runs");
  const starts = [];
  for (const name of await readdir(dir)) {
    const document = JSON.parse(await readFile(path.join(dir, name, "task-run.json"), "utf8"));
    if (document.startedAt !== undefined) starts.push(document.startedAt);
  }
  return starts;
}

test("an R3 change approved before it is built satisfies the ordering gate, and is blocked on exactly six gates", async (t) => {
  // The milestone this release can honestly claim. Before it, `legion ship` on
  // this exact fixture reported seven unmet gates, of which
  // `approved_spec_and_oracle` was one and had no route out at all: nothing
  // approved an oracle, so nothing could ever answer it.
  const { root, run, changeDir } = await plannedR3(t);

  // The order is the substance. Both approvals go in between `legion plan` and
  // `legion build`, which is what the gate exists to require — and the commit
  // between them is load-bearing twice over: `legion build` refuses a dirty
  // worktree, and the two git calls put real time between the decisions and the
  // run.
  const approvedSpec = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approvedSpec.exitCode, 0, approvedSpec.stdout + approvedSpec.stderr);

  const approvedOracle = await run("approve", "oracle", "--approver", "dasbl", "--json");
  assert.equal(approvedOracle.exitCode, 0, approvedOracle.stdout + approvedOracle.stderr);
  const oraclePayload = parseJsonOutput(approvedOracle);
  assert.equal(oraclePayload.status, "approved");
  assert.deepEqual(oraclePayload.unapproved, []);
  // Nothing has run, so no ordering warning is due — and the routing is forward,
  // to the build these decisions have to precede.
  assert.equal(oraclePayload.warnings, undefined);
  assert.equal(oraclePayload.nextAction.command, "legion build");
  // The pin is the oracle document's own reference, which is the only pin
  // `shipGatePinnedReferences` resolves for an oracle. Anything else answers
  // `unverified` at ship time forever.
  const [approval] = oraclePayload.approvals;
  assert.match(approval.pinned.path, /\/oracle\/orc_[^/]+\.yaml$/);
  assert.equal(approval.status, "granted");

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve spec and oracle"]);

  const built = await run("build", "--executor", "fake", "--json");
  assert.equal(built.exitCode, 0, built.stdout + built.stderr);
  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);
  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);

  // The premise, asserted rather than left to wall-clock luck. Both stamps have
  // millisecond resolution and the gate blocks at equality, so a fast machine
  // that collided would redden the gate assertion below with a message about
  // governance rather than about timing. This says which it was.
  //
  // Compared as strings, never through `Date`: `utcTimestampSchema` is a
  // fixed-width canonical instant, so byte order is chronological order, and
  // that is the comparison the gate itself makes.
  const decided = await decisionInstants(changeDir);
  const starts = await runStarts(changeDir);
  assert.equal(decided.length, 2, "one spec approval and one oracle approval");
  assert.ok(starts.length > 0);
  const latestDecision = decided.slice().sort().at(-1);
  const earliestStart = starts.slice().sort()[0];
  assert.ok(
    latestDecision < earliestStart,
    `every decision must be strictly earlier than the first run start: latest ${latestDecision}, earliest start ${earliestStart}`
  );

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "R3 is not shippable in this release and this test must not pretend it is");
  const payload = parseJsonOutput(shipped);

  // Nothing is *unsatisfied*: every gate R3 derives that has a producer is met.
  // What blocks is only the six with none.
  assert.equal(
    payload.diagnostics.filter((entry) => entry.code === "risk_gate_unsatisfied").length,
    0,
    `expected no failing gate: ${JSON.stringify(payload.diagnostics.map((entry) => entry.gate))}`
  );
  // Six gate ids are still unmet, and the set did not shrink in this release
  // either — which is the honest report and is worth stating plainly. This
  // fixture attests nothing, declares no protected acceptance path, records no
  // review domain and writes no release plan, so each of those gates answers its
  // own nothing-was-recorded arm. What a producer gives a gate is the ability to
  // be *satisfied*, and the change that does all six of those things is the R3
  // milestone at the bottom of this file. The difference here is in the reasons,
  // asserted immediately below: every one of these six rows now says what is
  // missing and names a command that produces it, and none of them says Legion
  // produces no evidence for it at all.
  const unmet = [...new Set(payload.diagnostics.map((entry) => entry.gate))].sort();
  assert.deepEqual(unmet, [
    "architecture_or_security_review",
    "independent_baseline",
    "protected_acceptance_tests",
    "release_observation_plan",
    "rollback_or_forward_fix_evidence",
    "security_or_e2e_evaluator"
  ]);

  const stillProducerless = payload.diagnostics
    .filter((entry) => entry.message.includes(NO_PRODUCER_REASON))
    .map((entry) => entry.gate)
    .sort();
  assert.deepEqual(
    stillProducerless,
    PRODUCERLESS_R3_GATES,
    "no gate may answer from evaluateGate's producerless arm, read off the real command"
  );

  // This release's gate is the sixth, and its sentence is about the *release
  // plane* rather than about any run or any attestation: nothing records how
  // this change's release would be observed, which is a different fact from
  // "Legion produces no evidence for this". Change-scoped, so one row for the
  // change rather than one per task.
  const releaseRow = payload.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.notEqual(releaseRow, undefined);
  assert.doesNotMatch(releaseRow.message, /does not yet produce/);
  assert.match(releaseRow.message, /No release plan is recorded for change chg_/);
  assert.match(releaseRow.message, /is not satisfied for chg_/);

  // An earlier release's gate is the fifth, and its sentence is about the *plan*
  // rather than about any run: nothing in this change names a test the work must
  // not weaken, which is a different fact from "the run weakened one" and from
  // "Legion produces no evidence for this". Task-scoped, so the row names the
  // task whose run would have answered.
  const acceptanceRow = payload.diagnostics.find((entry) => entry.gate === "protected_acceptance_tests");
  assert.notEqual(acceptanceRow, undefined);
  assert.doesNotMatch(acceptanceRow.message, /does not yet produce/);
  assert.match(acceptanceRow.message, /No oracle in this change declares a protected acceptance path/);
  assert.match(acceptanceRow.message, /is not satisfied for tsk_/);

  // And the ones earlier releases closed no longer answer from that arm: each
  // names the plane it looked at and what it did not find there.
  for (const gate of ["independent_baseline", "security_or_e2e_evaluator", "rollback_or_forward_fix_evidence"]) {
    const row = payload.diagnostics.find((entry) => entry.gate === gate);
    assert.notEqual(row, undefined, gate);
    assert.doesNotMatch(row.message, /does not yet produce/, gate);
    assert.match(row.message, /No attestation records anyone asserting/, gate);
    // Change-scoped, so one row for the change rather than one per task.
    assert.match(row.message, /is not satisfied for chg_/, gate);
  }

  // This release's gate is the fourth, and its sentence is about the reviews
  // plane rather than the attestation one: a review was accepted here, and it
  // records no domain, which is a different fact from "nobody reviewed this".
  const domainRow = payload.diagnostics.find((entry) => entry.gate === "architecture_or_security_review");
  assert.notEqual(domainRow, undefined);
  assert.doesNotMatch(domainRow.message, /does not yet produce/);
  assert.match(domainRow.message, /records the domain it was performed in/);
  assert.match(domainRow.message, /is not satisfied for chg_/);

  // The payload's aggregate advice moved as a side effect of those three gaining
  // recoveries, and it moved in the right direction. Before this release the
  // advice on this exact fixture was `legion build` — the fallback arm, because
  // none of the six unmet gates had a recovery — on a change that had already
  // been built, reviewed and accepted. That is the exits-0-and-still-blocked loop
  // this series exists to close, emitted by the aggregator rather than by a gate.
  assert.notEqual(
    payload.nextAction.command,
    "legion build",
    "a change that has been built, reviewed and accepted must not be advised to build"
  );
  // Which is the same as saying this release's gate is satisfied — stated
  // separately because the set above is what a later author will edit, and the
  // claim this release makes must not vanish with it.
  assert.equal(
    payload.diagnostics.some((entry) => entry.gate === "approved_spec_and_oracle"),
    false
  );
});

test("an oracle approved after the build blocks the gate, naming both instants and a recovery that is not an approval", async (t) => {
  // The inversion, and this release's proof of the series' first lesson. The
  // only difference from the test above is where `legion approve oracle` sits
  // relative to `legion build`.
  //
  // It is also the one verdict in this series that no command repairs. Verified
  // against the tree: nothing rewinds, deletes or supersedes a task run,
  // `legion plan` is create-only, and re-approving writes a *later* decision
  // instant. So the recovery must name neither an approve verb nor a build, and
  // the assertion below is in both directions for that reason.
  const { root, run, changeDir } = await plannedR3(t);

  const approvedSpec = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approvedSpec.exitCode, 0, approvedSpec.stdout + approvedSpec.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve spec"]);

  const built = await run("build", "--executor", "fake", "--json");
  assert.equal(built.exitCode, 0, built.stdout + built.stderr);

  // The command still writes: the decision is a real governance fact and
  // refusing would leave no way to record one at all. What it must not do is be
  // silent about what it has just made impossible.
  const approvedOracle = await run("approve", "oracle", "--approver", "dasbl", "--json");
  assert.equal(approvedOracle.exitCode, 0, approvedOracle.stdout + approvedOracle.stderr);
  const oraclePayload = parseJsonOutput(approvedOracle);
  assert.equal(oraclePayload.status, "approved");
  const warning = oraclePayload.warnings.find((entry) => entry.code === "approval_after_execution");
  assert.notEqual(warning, undefined, "the operator has to learn this at the one moment they could still act on it");
  assert.match(warning.message, /no command re-orders a decision that has already been taken/);
  // And it does not route them to a build they have already run.
  assert.equal(oraclePayload.nextAction.command, "legion ship");

  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);
  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1);
  const payload = parseJsonOutput(shipped);

  const blocked = payload.diagnostics.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.notEqual(blocked, undefined);
  assert.equal(blocked.code, "risk_gate_unsatisfied");

  // Both instants, read off disk and found in the sentence. A verdict that said
  // only "the ordering is wrong" would be unactionable and unauditable.
  const decided = await decisionInstants(changeDir);
  const starts = await runStarts(changeDir);
  const latest = decided.slice().sort().at(-1);
  const earliest = starts.slice().sort()[0];
  assert.ok(latest > earliest, "the fixture must actually produce the ordering it is asserting about");
  assert.ok(blocked.message.includes(latest), `expected the decision instant ${latest} in: ${blocked.message}`);
  assert.ok(blocked.message.includes(earliest), `expected the run start ${earliest} in: ${blocked.message}`);

  // The change-scoped subject: one answer for the change, named as the change.
  assert.match(blocked.message, /is not satisfied for chg_/);

  // The recovery, asserted on `command` and not only on `reason`.
  //
  // The first draft of this test asserted `payload.nextAction.reason` alone, and
  // adversarial review found what that hid: `shipGateRecovery`'s mixed arm kept
  // ship's fallback command whenever any unmet gate had no recovery, which at R3
  // is unconditional — so this payload read `{command: "legion build", reason: "…
  // legion start --intake."}`. The two fields contradicted each other inside one
  // object, and `command` is the field hosts dispatch: following it exits 0,
  // writes another attempt, moves `min(startedAt)` not at all, and reports this
  // identical verdict forever.
  //
  // Neither an approve verb — which would write a later decision and make this
  // worse — nor a build, which has already happened.
  assert.equal(payload.nextAction.command, "legion start --intake");
  assert.doesNotMatch(payload.nextAction.command, /approve/);

  // **The reason moved in this release, and the command deliberately did not.**
  //
  // Three of R3's producerless gates gained recoveries here, so `shipGateRecovery`
  // now sees three distinct repair commands among the unmet set instead of one and
  // takes its mixed arm: the reason is built from ship's fallback rather than from
  // the ordering gate's own sentence. That is the aggregator working as specified
  // — it says plainly that no single command unblocks the ship and names them all.
  //
  // What had to be checked rather than assumed is `command`, because
  // `independent_baseline` is **first** in R3's gate order
  // (packages/core/src/risk/index.ts) and is therefore `recoveries[0]` on every
  // blocked R3 ship from now on. It stays `legion start --intake` because that
  // gate's own post-execution recovery is the same command as the ordering gate's,
  // for the same reason: nothing re-dates an attestation any more than it re-orders
  // an approval, so attesting a baseline now would write a later instant and make
  // the state strictly worse. Two gates, one honest repair, and the field hosts
  // dispatch is unchanged.
  assert.match(payload.nextAction.reason, /No single command unblocks this ship/);
  assert.match(payload.nextAction.reason, /legion start --intake is the first of them in gate order/);
  // And the ordering gate's own sentence still carries the fact the aggregate no
  // longer does, which is the point of putting it in the verdict as well as in the
  // recovery: a blocked ship's gate rows are `{code, gate, message, path}` and the
  // recovery reaches the operator only through the single aggregate `nextAction`.
  assert.match(blocked.message, /not earlier than/);
});

test("every advisory before the build routes an R3 operator to approve first", async (t) => {
  // The routing defect adversarial review found, and it is the one that made this
  // release's gate producer unreachable in practice.
  //
  // `legion build` is a one-way door at R3 — after it, `approved_spec_and_oracle`
  // can never be satisfied and the verdict says so — and no command's `nextAction`
  // pointed anywhere else. A fresh R3 intake driven through the real CLI following
  // only the tool's own `Next:` lines went `legion plan 1` → `legion build` →
  // `legion review` → `legion review --accept` → blocked forever, and none of the
  // three pre-build payloads contained the string "approve". `commands/approve.md`
  // documented "Runs between legion plan and legion build"; nothing in the CLI
  // pointed at it. A gate with a producer the workflow never reaches in time has
  // no producer.
  //
  // All three advisories are asserted here, because fixing one and leaving two is
  // indistinguishable from fixing none: an operator follows whichever command they
  // happened to run.
  const { run, planned } = await plannedR3(t);

  assert.equal(planned.nextAction.command, "legion approve spec --approver <id>");
  assert.match(planned.nextAction.reason, /one-way door/);

  const status = parseJsonOutput(await run("status", "--json"));
  assert.equal(status.nextAction.command, "legion approve spec --approver <id>");

  // Ship's two pre-build refusals return before a gate is ever evaluated, so this
  // command cannot report the ordering gate until after the point of no return.
  // It can still say which command comes first.
  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1);
  const shipPayload = parseJsonOutput(shipped);
  assert.equal(shipPayload.nextAction.command, "legion approve spec --approver <id>");

  // And the chain continues rather than skipping the other half: at R3 the gate
  // reads the oracles too, so an operator who approves only the specs must not be
  // sent straight to a build.
  const approvedSpec = parseJsonOutput(await run("approve", "spec", "--approver", "dasbl", "--json"));
  assert.equal(approvedSpec.status, "approved");
  assert.equal(approvedSpec.nextAction.command, "legion approve oracle --approver <id>");

  const approvedOracle = parseJsonOutput(await run("approve", "oracle", "--approver", "dasbl", "--json"));
  assert.equal(approvedOracle.nextAction.command, "legion build");
});

test("legion approve spec warns when the work it claims to gate has already run", async (t) => {
  // The blocking defect from this release's first draft, at the writer end.
  //
  // `legion approve oracle` carried an `approval_after_execution` warning and
  // `legion approve spec` — which feeds the identical gate — carried nothing. So
  // the operator following ship's own advice on an already-built R3 change got
  // `status: "approved"`, `warnings: undefined`, and `nextAction: legion build` on
  // a change already built, while the gate moved silently from `unevaluable` to
  // permanently `unsatisfied`. Exiting 0 while making the change strictly worse is
  // the sharpest case of this series' first lesson.
  // `plannedR3` already commits, so the worktree is clean for the build.
  const { run } = await plannedR3(t);

  const built = await run("build", "--executor", "fake", "--json");
  assert.equal(built.exitCode, 0, built.stdout + built.stderr);

  const approved = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approved.exitCode, 0, approved.stdout + approved.stderr);
  const payload = parseJsonOutput(approved);
  assert.equal(payload.status, "approved", "the decision is a real governance fact and is still recorded");

  const warning = payload.warnings.find((entry) => entry.code === "approval_after_execution");
  assert.notEqual(warning, undefined, "the operator has to learn this at the one moment they could still act on it");
  assert.match(warning.message, /no command re-orders a decision that has already been taken/);
  // And it does not route them to a build they have already run.
  assert.equal(payload.nextAction.command, "legion ship");

  // The reader agrees with the writer about what just happened: the gate names
  // the ordering rather than asking for another approval.
  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  const shipPayload = parseJsonOutput(await run("ship", "--json"));
  assert.equal(shipPayload.nextAction.command, "legion start --intake");
  assert.doesNotMatch(shipPayload.nextAction.command, /approve/);
});

test("an unapproved R3 change that has already run is not advised to approve it", async (t) => {
  // The reader half of the same defect, in the state ship actually reports first.
  // Before the fix, `legion ship` on this change advised `legion approve spec
  // --approver <id>` — the gate's own recovery — and following it converted a
  // repairable-looking `unevaluable` into a permanent `unsatisfied`. The gate now
  // reads where execution is before it chooses its advice.
  const { run } = await plannedR3(t);

  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const payload = parseJsonOutput(await run("ship", "--json"));
  const gate = payload.diagnostics.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.notEqual(gate, undefined);
  assert.equal(gate.code, "risk_gate_unevaluable");
  // The verdict's own sentence carries it, because a blocked ship's gate rows are
  // `{code, gate, message, path}` and the recovery reaches the operator only
  // through the payload's single aggregate `nextAction`.
  assert.match(gate.message, /approving cannot satisfy this gate/);
  assert.doesNotMatch(payload.nextAction.command, /approve/);
});

test("deleting a run directory does not turn a late approval into an early one", async (t) => {
  // The blocking defect adversarial review found in the first draft, reproduced
  // as the regression test it needs.
  //
  // `listTaskRunsForChange` records `skipped` only for directories it saw and
  // could not read: it filters `entries.filter((c) => c.isDirectory())` before the
  // skip loop, so a run directory replaced by a plain file leaves no trace, and a
  // deleted one leaves no entry to skip at all. `completeTaskRuns` therefore
  // returned a short list as if it were whole, `min(startedAt)` moved later, and
  // this gate flipped from `unsatisfied` to `satisfied` — a governance verdict
  // reversed by an `rm -rf`, with no diagnostic anywhere and `legion validate`
  // still exiting 0.
  //
  // The run plane is the only plane a gate verdict rests on that nothing
  // content-pins: `validateChangeTraceability` blocks ship on an edited oracle,
  // delta spec or taskgraph before a gate is derived, and says nothing about
  // `runs/`. So completeness is corroborated from the outside — the evidence index
  // still names the deleted run.
  const { root, run, changeDir } = await plannedR3(t);

  const approvedSpec = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approvedSpec.exitCode, 0, approvedSpec.stdout + approvedSpec.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve spec"]);

  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  // Approved after the first run: the ordering is genuinely wrong.
  assert.equal((await run("approve", "oracle", "--approver", "dasbl", "--json")).exitCode, 0);
  // A second attempt, so that deleting the first leaves a set that still looks
  // whole. `legion review --auto` produces exactly this shape in the ordinary fix
  // cycle, which is why `min` rather than `max` is the gate's reading.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve oracle"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const before = parseJsonOutput(await run("ship", "--json"));
  const blockedBefore = before.diagnostics.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.notEqual(blockedBefore, undefined, "the fixture must start from a genuinely late approval");
  assert.equal(blockedBefore.code, "risk_gate_unsatisfied");

  // One directory, nothing else touched: the earliest run.
  const runs = path.join(changeDir, "runs");
  const starts = [];
  for (const name of await readdir(runs)) {
    const document = JSON.parse(await readFile(path.join(runs, name, "task-run.json"), "utf8"));
    starts.push({ name, startedAt: document.startedAt });
  }
  starts.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  assert.ok(starts.length >= 2, "the fixture needs two attempts for the deletion to leave a plausible set");
  await rm(path.join(runs, starts[0].name), { recursive: true, force: true });

  const after = parseJsonOutput(await run("ship", "--json"));
  const gate = after.diagnostics.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.notEqual(gate, undefined, "a deleted run must never make this gate satisfied");
  // `unevaluable`, not `unsatisfied`: the honest answer is that the ordering can
  // no longer be established, which is a different sentence from "the ordering is
  // wrong" and has a different repair.
  assert.equal(gate.code, "risk_gate_unevaluable");

  // And the payload names what is missing, rather than reporting a clean plane.
  const plane = after.diagnostics.find((entry) => entry.code === "task_run_plane_contradicted");
  assert.notEqual(plane, undefined, "the operator has no other way to learn a run record is gone");
  assert.match(plane.message, new RegExp(starts[0].name));
});

/** The same R3 fixture, approved and built, one command short of any review. */
async function builtR3(t) {
  const fixture = await plannedR3(t);
  const { root, run } = fixture;

  const approvedSpec = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approvedSpec.exitCode, 0, approvedSpec.stdout + approvedSpec.stderr);
  const approvedOracle = await run("approve", "oracle", "--approver", "dasbl", "--json");
  assert.equal(approvedOracle.exitCode, 0, approvedOracle.stdout + approvedOracle.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve spec and oracle"]);
  const built = await run("build", "--executor", "fake", "--json");
  assert.equal(built.exitCode, 0, built.stdout + built.stderr);
  return fixture;
}

test("a review that declares its domain satisfies the architecture gate, end to end through the real CLI", async (t) => {
  // **The only thing that proves the writer and the reader agree.** Every unit
  // assertion in tests/domain-review-gate hands the gate a fact set built by hand;
  // this drives `legion review --domain architecture` through the real command,
  // lets it write a real review artifact, and asks `legion ship` — which re-reads
  // that artifact off disk through `listReviewDecisionsForChange` — whether the
  // gate moved. A writer that recorded something the reader will not accept passes
  // every unit test in the tree and fails here.
  const { run, changeDir } = await builtR3(t);

  const reviewed = await run(
    "review",
    "--executor",
    "fake",
    "--domain",
    "architecture",
    "--domain",
    "security",
    "--json"
  );
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);
  const reviewPayload = parseJsonOutput(reviewed);
  // Repeated flags, not a comma list: `parseCliArgs` already records every
  // occurrence, so both reached the document rather than the last one winning.
  assert.deepEqual(reviewPayload.review.domains, ["architecture", "security"]);
  // The change derives the gate and this review answers it, so no warning is due.
  assert.equal(reviewPayload.warnings, undefined);

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  const acceptPayload = parseJsonOutput(accepted);
  assert.equal(acceptPayload.warnings, undefined);
  // The accept spreads `...review.document`, so the domains stamped at submit
  // survive the transition. Asserted against the artifact on disk rather than
  // against the payload, because the gate reads the file.
  const reviewFiles = (await readdir(path.join(changeDir, "reviews"))).filter((name) => name.endsWith(".json"));
  const accepted0 = JSON.parse(await readFile(path.join(changeDir, "reviews", reviewFiles[0]), "utf8"));
  assert.equal(accepted0.status, "accepted");
  assert.deepEqual(accepted0.domains, ["architecture", "security"]);

  const shipped = await run("ship", "--json");
  assert.equal(
    shipped.exitCode,
    1,
    "this fixture attests nothing and plans no release, so R3 is still blocked — on records, not on missing producers"
  );
  const payload = parseJsonOutput(shipped);
  assert.equal(
    payload.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    false,
    `the gate this release closed must be satisfied: ${JSON.stringify(payload.diagnostics.map((e) => e.gate))}`
  );
  // And exactly one remains producerless, which is the honest remaining set read
  // off the real command.
  const stillProducerless = payload.diagnostics
    .filter((entry) => entry.message.includes(NO_PRODUCER_REASON))
    .map((entry) => entry.gate)
    .sort();
  assert.deepEqual(stillProducerless, PRODUCERLESS_R3_GATES);
});

test("legion review refuses --domain on a run that accepts, and warns when an R3 review records none", async (t) => {
  // Two halves of one rule, and neither is cosmetic.
  //
  // The refusal: the accept path spreads `...review.document`, so it *could* stamp
  // a domain onto a review performed with no domain knowledge at all — a label
  // applied after the looking, which is what "a domain competence looked at this
  // change" is not. Accepted-and-ignored is the silent class `declared-options.ts`
  // exists to close, so it is refused by name.
  //
  // The warning: without it `legion review --accept` exits 0 on an R3 change and
  // `legion ship` blocks forever with nothing anywhere naming the flag that would
  // have fixed it. It calls the gate's own exported predicate rather than
  // paraphrasing it, which is this series' third lesson.
  const { run } = await builtR3(t);

  const refused = await run("review", "--accept", "--approver", "dasbl", "--domain", "architecture", "--json");
  assert.equal(refused.exitCode, 1);
  const refusedPayload = parseJsonOutput(refused);
  assert.equal(refusedPayload.status, "usage_error");
  assert.match(refusedPayload.diagnostics[0].message, /reads --domain only on a run that performs a review/);

  // A bare `--domain` at the end of argv is not recorded as a repeated value at
  // all — it binds `true` — so without its own guard the operator's flag would
  // read as absent and the command would record nothing while exiting 0.
  const bare = await run("review", "--executor", "fake", "--json", "--domain");
  assert.equal(bare.exitCode, 1);
  assert.match(parseJsonOutput(bare).diagnostics[0].message, /Missing required value for --domain/);

  const unknown = await run("review", "--executor", "fake", "--domain", "architecure", "--json");
  assert.equal(unknown.exitCode, 1);
  assert.match(parseJsonOutput(unknown).diagnostics[0].message, /Unknown review domain: --domain architecure/);

  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);
  const submitWarning = parseJsonOutput(reviewed).warnings.find(
    (entry) => entry.code === "review_domain_not_recorded"
  );
  assert.notEqual(submitWarning, undefined, "the flag is cheap here and expensive after the accept");
  assert.match(submitWarning.message, /legion review --accept does not take --domain/);

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  // Warned, never refused: the approval, the evidence acceptance and the
  // whole-change sign-off are real governance acts, and a gate ADR-006 permits
  // waiving must not make them unrecordable.
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  const acceptWarning = parseJsonOutput(accepted).warnings.find(
    (entry) => entry.code === "review_domain_not_recorded"
  );
  assert.notEqual(acceptWarning, undefined);
  assert.match(acceptWarning.message, /nothing was rolled back/);
});

test("the accept-time domain warning names a repair that actually repairs the state", async (t) => {
  // **This series' first lesson, run rather than reasoned about.** The warning
  // this release adds says "run legion review --domain architecture and accept
  // again", and the accept path has a documented trap around exactly that
  // sentence: `cleanSubmittedReviewCoverage` selects only reviews still in
  // `submitted`, which is why `RE_ACCEPT_RECOVERY` exists one gate over and why a
  // second `legion review --accept` on some states exits 1 with
  // `review_not_clean`. So the sequence is driven verbatim, from the state the
  // warning is emitted in, and the gate is asked afterwards whether it moved.
  const { run } = await builtR3(t);

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0);
  const warning = parseJsonOutput(accepted).warnings.find((entry) => entry.code === "review_domain_not_recorded");
  assert.notEqual(warning, undefined, "the fixture must start from the state the warning is about");
  assert.match(warning.message, /Run legion review --domain architecture/);

  const before = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    before.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    true
  );

  // The advice, verbatim and in order.
  const reReviewed = await run("review", "--domain", "architecture", "--executor", "fake", "--json");
  assert.equal(reReviewed.exitCode, 0, reReviewed.stdout + reReviewed.stderr);
  const reAccepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(reAccepted.exitCode, 0, reAccepted.stdout + reAccepted.stderr);
  // And the warning clears, which is the writer agreeing with the reader: the
  // predicate that emitted it is the gate's own.
  assert.equal(parseJsonOutput(reAccepted).warnings, undefined);

  const after = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    after.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    false,
    "advice that exits 0 and leaves the gate blocked is the loop this series exists to close"
  );

  // The supersession the gate reads is the one the real flow writes: the second
  // review supersedes the first, and it is the *later* record that carries the
  // domain, so the arm that drops a superseded domain review does not fire here.
  const domainRow = after.diagnostics.find((entry) => entry.gate === "architecture_or_security_review");
  assert.equal(domainRow, undefined);
});

test("a review file that will not parse blocks the gate rather than being answered around", async (t) => {
  // The fail-open this release closed one layer down, driven end to end.
  //
  // `listReviewDecisionsForChange` used to drop what it could not read and report
  // nothing, and `legion ship` applied no completeness wrapper — so on a change
  // whose architecture review said *no*, corrupting that one file made the
  // rejection vanish and left the gate answering from whatever survived. Measured
  // here in the direction that matters: the plane comes back short, ship names the
  // file, and the gate declines to answer.
  const { run, changeDir } = await builtR3(t);

  assert.equal((await run("review", "--executor", "fake", "--domain", "architecture", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const before = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    before.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    false,
    "the fixture must start from a satisfied gate"
  );

  // A schema-valid review id whose contents are not a review. Platform-neutral:
  // no permission bits, no symlinks — just bytes nothing can parse as a review.
  //
  // **The id is short on purpose, and the length is the whole of what this test
  // measures.** `reviewIdSchema` is `^rev_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`, so
  // 68 characters at most; the name this test used first was 71, failed the id
  // parse, and was skipped by the branch above the one the release depends on.
  // Deleting `skipped.push(entry.name)` from the `!read.ok` arm of
  // `listReviewDecisionsForChange` — the arm that catches a file whose *contents*
  // will not load — left the whole suite green, because nothing anywhere reached
  // it. Measured again with this name: the mutant reddens here.
  const corrupt = "rev_domain-review-corrupt-1.json";
  assert.equal(corrupt.length - ".json".length <= 68, true, "the id must parse, or a different branch is measured");
  await writeFile(path.join(changeDir, "reviews", corrupt), "{\n", "utf8");

  const after = parseJsonOutput(await run("ship", "--json"));
  const gate = after.diagnostics.find((entry) => entry.gate === "architecture_or_security_review");
  assert.notEqual(gate, undefined, "a dropped review file must never leave this gate satisfied");
  assert.equal(gate.code, "risk_gate_unevaluable");
  assert.match(gate.message, /could not be read as a complete set/);

  // And the payload names the file, because "the reviews could not be read" with
  // no filename is the unactionable diagnostic `ShipGatePlaneSkip` exists to stop
  // being.
  const plane = after.diagnostics.find((entry) => entry.code === "artifact_plane_incomplete");
  assert.notEqual(plane, undefined);
  assert.match(plane.message, new RegExp(corrupt));
  assert.match(plane.message, /could not be read as review/);
});

test("a junk file under attestations blocks the gate a clean domain review would satisfy", async (t) => {
  // **The same fail-open through the other plane, and the one an operator reaches
  // without touching a review at all.** This gate has two producers, and reducing
  // them by verdict made one producer's `satisfied` answer for the other's
  // silence — so a `.DS_Store` under `attestations/`, the exact junk-file class
  // `planeSkipDiagnostics` was written to name, collapsed that plane and the
  // clean architecture review beside it turned the gate green. The dropped
  // listing may have held an `architecture-review` attestation whose verdict is
  // `fail`, which the neighbouring unit test proves would otherwise block the
  // ship: a junk file must not discard a named human's recorded refusal.
  //
  // Driven end to end because the contradiction is between two halves of one
  // payload: `legion ship` printed "Every gate that reads the attestation plane
  // reports unevaluable while this is true" and then reported this gate
  // satisfied.
  const { run, changeDir } = await builtR3(t);

  assert.equal((await run("review", "--executor", "fake", "--domain", "architecture", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const before = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    before.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    false,
    "the fixture must start from a satisfied gate, or this measures nothing"
  );

  // Platform-neutral: an ordinary file with an ordinary name, in a directory the
  // change owns. No permission bits and no symlinks.
  await mkdir(path.join(changeDir, "attestations"), { recursive: true });
  await writeFile(path.join(changeDir, "attestations", ".DS_Store"), "junk\n", "utf8");

  const after = parseJsonOutput(await run("ship", "--json"));
  const gate = after.diagnostics.find((entry) => entry.gate === "architecture_or_security_review");
  assert.notEqual(gate, undefined, "a collapsed attestation plane must not be answered around");
  assert.equal(gate.code, "risk_gate_unevaluable");
  assert.match(gate.message, /attestations recorded for this change could not be read as a complete set/);

  const plane = after.diagnostics.find((entry) => entry.code === "artifact_plane_incomplete");
  assert.notEqual(plane, undefined);
  assert.match(plane.message, /\.DS_Store/);
  // And the payload no longer contradicts itself: the sentence that says every
  // gate reading this plane reports unevaluable is now true of this gate too.
  assert.match(plane.message, /Every gate that reads the attestation plane reports unevaluable/);
});

// --- the R3 milestone -------------------------------------------------------

/**
 * The three evidence fixtures the out-of-band attestation kinds cite.
 *
 * Written into the temp workspace rather than pinned from `docs/next/evidence/`,
 * on `tests/cli-attest`'s recorded rule: those files are stored LF and check out
 * CRLF on Windows, `hashContent` hashes raw bytes, and a pin minted on one
 * platform reads `drift` on the other — which is the gates' strongest negative
 * arm. Bytes this test wrote are immune either way and need no chmod or attrib.
 */
function threatModel() {
  return {
    schema_version: 1,
    generated_at: "2026-08-05T10:00:00.000Z",
    run_dir: "evidence/runs/security-sensitive.v1-r1",
    output_root: "evidence/runs",
    ok: true,
    checks: { sandbox: { ok: true, exit_code: 0 }, retention: { ok: true, exit_code: 0 }, redaction: { ok: true } },
    findings: []
  };
}

/**
 * `repository_root` and `manifest.repositoryRoot` both fold to the temp root,
 * because `rollbackPolicyVerdict` refuses a verdict taken in another checkout —
 * which is why the repository's own committed `rollback-policy.json` cannot
 * satisfy this gate here.
 */
function rollbackPolicy(root) {
  return {
    ok: true,
    status: "restorable",
    backup_manifest_path: path.join(root, "backup-manifest.json"),
    repository_root: root,
    source: "codex-legion",
    kind: "codex-legion-migration-backup",
    manifest: {
      schemaVersion: "0.1.0",
      kind: "codex-legion-migration-backup",
      createdAt: "2026-08-04T12:00:00.000Z",
      repositoryRoot: root,
      backupPath: path.join(root, "backup"),
      preMigrationHash: `sha256:${"b".repeat(64)}`,
      sourceHash: `sha256:${"1".repeat(64)}`,
      existingLegionRoot: true
    },
    findings: [],
    checks: {
      manifest: { name: "manifest", ok: true, findings: [] },
      restore_target: { name: "restore_target", ok: true, findings: [] }
    }
  };
}

/**
 * An A/B comparison with a **populated baseline side**, which no file in this
 * repository has.
 *
 * `abComparisonVerdict` refuses the committed `ab-comparison.json` by name: its
 * `v8_summary.run_count` is 0 and every scenario row reads `v8_present: false`,
 * so it is a v9-only aggregate wearing an A/B filename and an
 * `independent-baseline` attestation citing it would pin a document positively
 * stating that the baseline is absent. This fixture is what a real one looks
 * like, and writing it here is the only way the evidence arm of
 * `independent_baseline` is reachable at all.
 */
function abComparison() {
  return {
    schema_version: 1,
    generated_at: "2026-08-05T09:00:00.000Z",
    inputs: { v8_dir: "evidence/runs/v8", v9_dir: "evidence/runs/v9" },
    v8_summary: { run_count: 2, deterministic_mean: 0.71 },
    v9_summary: { run_count: 2, deterministic_mean: 0.88 },
    scenarios: [
      {
        scenario_id: "pricing-quote.v1",
        v8_present: true,
        v9_present: true,
        v8_score_missing: false,
        v9_score_missing: false,
        v8_deterministic_total: 0.7,
        v9_deterministic_total: 0.9
      },
      {
        scenario_id: "pricing-reject.v1",
        v8_present: true,
        v9_present: true,
        v8_score_missing: false,
        v9_score_missing: false,
        v8_deterministic_total: 0.72,
        v9_deterministic_total: 0.86
      }
    ]
  };
}

test("an R3 change carrying all ten gates ships ready, end to end through the real CLI", async (t) => {
  // **The milestone this whole series was for.** Before this release no R3 change
  // could report `ready`, whatever it carried: `release_observation_plan` had no
  // producer and fell through `evaluateGate`'s `default:` arm, so the honest
  // answer was always "unprovable". Measured immediately before this release on
  // this exact sequence, `legion ship` reported 0 unsatisfied and 1 unevaluable,
  // and advised `legion build` on a change that had already been built.
  //
  // The order below is load-bearing in two places and only two:
  //
  //  - `attest independent-baseline` must precede the build, because that gate
  //    compares `attestedAt` against `min(startedAt)` over the run set and blocks
  //    at equality.
  //  - `approve spec` and `approve oracle` must precede the build, because
  //    `approved_spec_and_oracle` compares the last decision against the same
  //    instant and no command re-orders a decision already taken.
  //
  // `release plan` deliberately sits after the review and before the accept, to
  // demonstrate the claim its own docblock makes: it carries no ordering rule, and
  // a plan authored after the build is still a plan. It would satisfy the gate
  // from anywhere after `legion plan`.
  //
  // **If this ever stops coming out ready, the repair is not to weaken a gate.**
  // The assertions below name which gate blocked and why, so a failure says what
  // it is rather than "R3 does not ship".
  const { root, run, changeDir } = await plannedR3(t, { acceptancePaths: true });

  await mkdir(path.join(root, "evidence"), { recursive: true });
  await writeFile(path.join(root, "evidence/threat-model.json"), `${JSON.stringify(threatModel(), null, 2)}\n`, "utf8");
  await writeFile(
    path.join(root, "evidence/rollback-policy.json"),
    `${JSON.stringify(rollbackPolicy(root), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "evidence/ab-comparison.json"),
    `${JSON.stringify(abComparison(), null, 2)}\n`,
    "utf8"
  );

  const ok = async (...args) => {
    const result = await run(...args);
    assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return parseJsonOutput(result);
  };

  await ok("approve", "spec", "--approver", "dasbl", "--json");
  await ok("approve", "oracle", "--approver", "dasbl", "--json");
  // Before the build. The pass arm of `independent_baseline` needs an A/B
  // comparison with a populated baseline side *and* an instant strictly earlier
  // than the first run start.
  const baseline = await ok(
    "attest", "independent-baseline", "--attested-by", "dasbl", "--verdict", "pass",
    "--source", "evidence/ab-comparison.json", "--json"
  );
  assert.equal(baseline.attestation.verdict, "pass");
  assert.deepEqual(baseline.attestation.sourceShapes, ["ab-comparison (clean)"]);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve and attest a baseline"]);

  await ok("build", "--executor", "fake", "--json");
  await ok(
    "attest", "security-evaluation", "--attested-by", "dasbl", "--verdict", "pass",
    "--source", "evidence/threat-model.json", "--json"
  );
  await ok(
    "attest", "rollback-evidence", "--attested-by", "dasbl", "--verdict", "pass",
    "--source", "evidence/rollback-policy.json", "--json"
  );
  await ok("review", "--executor", "fake", "--domain", "architecture", "--domain", "security", "--json");
  const planned = await ok(
    "release", "plan", "--environment", "staging", "--rollback-strategy", "revert",
    "--health-criterion", "p99 quote latency stays under 400ms for 30 minutes after the cutover",
    "--rollback-criterion", "quote error rate exceeds 1% over any 5 minute window",
    "--json"
  );
  assert.equal(planned.status, "planned");
  assert.equal(planned.warnings, undefined, "an R3 change that derives the gate and is fully covered warns about nothing");
  await ok("review", "--accept", "--approver", "dasbl", "--json");

  // The premises, read off disk rather than left to wall-clock luck. Both
  // ordering gates block at millisecond equality, so a fast machine that collided
  // would redden the readiness assertion below with a message about governance
  // rather than about timing. This says which it was.
  const decided = await decisionInstants(changeDir);
  const starts = await runStarts(changeDir);
  const attestationNames = await readdir(path.join(changeDir, "attestations"));
  const baselineFile = attestationNames.find((name) => name.includes("independent-baseline"));
  const attestedAt = JSON.parse(
    await readFile(path.join(changeDir, "attestations", baselineFile), "utf8")
  ).attestedAt;
  const earliestStart = starts.slice().sort()[0];
  assert.ok(
    decided.slice().sort().at(-1) < earliestStart,
    `every approval must precede the first run start: ${decided.join(", ")} vs ${earliestStart}`
  );
  assert.ok(
    attestedAt < earliestStart,
    `the baseline must precede the first run start: ${attestedAt} vs ${earliestStart}`
  );

  const shipped = await run("ship", "--json");
  const payload = parseJsonOutput(shipped);
  assert.equal(
    shipped.exitCode,
    0,
    `R3 must ship ready. Unmet: ${JSON.stringify(payload.diagnostics?.map((entry) => ({ gate: entry.gate, message: entry.message })))}`
  );
  assert.equal(payload.status, "ready");
  assert.equal(payload.riskGates.unsatisfied, 0);
  assert.equal(payload.riskGates.unevaluable, 0);
  assert.deepEqual(payload.riskGates.unevaluableGates, []);
  // **On evidence, not on sentences.** An R3 milestone satisfied by three waivers
  // and a human judgement is not the claim this test makes, and the payload
  // reports both separately for exactly that reason.
  assert.deepEqual(payload.riskGates.waivedGates, []);
  assert.deepEqual(payload.riskGates.humanJudgementGates, []);
  assert.equal(payload.riskGates.satisfied, 10, "R3 derives ten gates and every one of them is met");
  assert.deepEqual(payload.diagnostics, []);
  assert.equal(payload.warnings, undefined, "nothing was skipped, waived or judged");

  // **The laundering route, measured on the only fixture where it can be: a change
  // where `release_observation_plan` is the single unmet gate, so
  // `shipGateRecovery` reports that gate's own recovery as `nextAction` rather
  // than its mixed arm.**
  //
  // A review of this release drove exactly this: set `release.json` to
  // `rolled_back` with the `rollbackEvidenceRefs` the schema requires for that
  // status, and `legion ship` blocked with
  // `nextAction.command = "legion release plan --environment <env>
  // --health-criterion <text>"`. Running that command exited 0, wrote a fresh
  // `status: "requested"` document, dropped the rollback evidence, and returned
  // this payload to `ready` with ten satisfied gates and `waivedGates: []`. The
  // cure the gate printed erased the fact it was printed about, and nothing in the
  // ship payload recorded that a taken-back release had been replaced.
  const releasePath = path.join(changeDir, "release.json");
  const green = await readFile(releasePath, "utf8");
  const takenBack = `${JSON.stringify(
    { ...JSON.parse(green), status: "rolled_back", rollbackEvidenceRefs: ["evd_rollback-of-the-failed-cutover"] },
    null,
    2
  )}\n`;
  await writeFile(releasePath, takenBack, "utf8");

  const blockedShip = await run("ship", "--json");
  const blockedPayload = parseJsonOutput(blockedShip);
  assert.equal(blockedShip.exitCode, 1);
  assert.deepEqual(
    blockedPayload.diagnostics.map((entry) => entry.gate),
    ["release_observation_plan"],
    "one edit, one unmet gate — which is what makes the nextAction below this gate's own"
  );
  assert.equal(blockedPayload.nextAction.command, "legion ship");
  assert.doesNotMatch(
    blockedPayload.nextAction.command,
    /release plan/,
    "the field hosts dispatch on must not name the command that overwrites this record"
  );
  assert.match(blockedPayload.nextAction.reason, /belongs in a new change/);

  // And the command that used to be advertised refuses, so an operator who types
  // it from memory is told the same thing rather than quietly succeeding.
  const refused = await run(
    "release", "plan", "--environment", "staging", "--rollback-strategy", "revert",
    "--health-criterion", "p99 quote latency stays under 400ms for 30 minutes after the cutover",
    "--rollback-criterion", "quote error rate exceeds 1% over any 5 minute window",
    "--json"
  );
  assert.equal(refused.exitCode, 1);
  assert.equal(parseJsonOutput(refused).diagnostics[0].code, "release_records_negative");
  assert.equal(await readFile(releasePath, "utf8"), takenBack, "the refusal writes nothing");

  // Restored, and ready again: proof that the one edit above is what blocked the
  // ship, rather than anything the extra commands did to the change.
  await writeFile(releasePath, green, "utf8");
  const again = parseJsonOutput(await run("ship", "--json"));
  assert.equal(again.status, "ready");
  assert.equal(again.riskGates.satisfied, 10);
});
