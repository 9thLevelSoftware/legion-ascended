import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { deriveShipGates } from "../packages/cli/dist/workflow/ship-gates.js";
import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * An R3 change, driven as far as R3 goes, with `approved_spec_and_oracle`
 * satisfied and the true remaining set named.
 *
 * `approved_spec_and_oracle` is ADR-006's ordering gate: the spec and the oracle
 * are both approved **before** gated execution proceeds. Until this release
 * nothing anywhere recorded a decision about an oracle, so the gate fell through
 * `evaluateGate`'s `default:` arm and every R3 change was structurally
 * unshippable for a reason no command could move.
 *
 * **This file does not claim R3 ships, and asserting that it does not is half its
 * point.** Seven of R3's ten gates now have producers — `protected_oracle` and
 * `deterministic_verification` from the evidence items, `explicit_human_approval`
 * from the approval plane, `approved_spec_and_oracle` from its ordering, and
 * `independent_baseline`, `security_or_e2e_evaluator` and
 * `rollback_or_forward_fix_evidence` from the attestation plane — and three do
 * not. That set is **derived from the compiled gate module** rather than typed
 * out here, for a reason the previous release's hand-written array could not
 * serve: a list edited by hand stays true when a gate silently regresses to
 * `evaluateGate`'s `default:` arm, and the derivation reddens when it does.
 *
 * The two things this file can prove that no unit test can: that the real
 * command sequence produces the ordering the gate needs, and that the verdict
 * for an ordering that went the other way names a recovery which does not make it
 * worse.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";

/** The sentence `evaluateGate`'s `default:` arm answers with, matched exactly. */
const NO_PRODUCER_REASON = "Legion does not yet produce evidence for this gate.";

/**
 * The R3 gates that still answer from `evaluateGate`'s `default:` arm, derived
 * from the compiled module rather than transcribed.
 *
 * The previous release named the six by hand and asserted the set in both
 * directions, on the argument that a count would stay true if one gate silently
 * regressed while another gained a producer. That argument was right and the
 * mechanism was not sufficient: a hand-written array is edited by whoever closes
 * a gate, and it stays green if the gate they closed quietly falls back to the
 * `default:` arm on the very next change. Deriving it from `deriveShipGates` over
 * an R3 task with **no change facts at all** closes that, because the only rows
 * this can select are rows that genuinely came from that arm.
 *
 * It is asserted against the expected three below rather than only used, so this
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
 * The three expected to survive this release, each carrying the release that is
 * expected to close it, so the failure message a later author sees points at
 * their own work rather than at this file.
 */
const PRODUCERLESS_R3_GATES = [
  // PR 7.
  "architecture_or_security_review",
  // PR 8.
  "protected_acceptance_tests",
  // PR 9.
  "release_observation_plan"
];

test("the R3 gates with no producer are exactly the three later releases still owe", () => {
  // Both directions, and derived on one side. Give one of these a producer and
  // this assertion is the thing to edit; let one of the seven that *has* a
  // producer fall back to the `default:` arm and this reddens without anybody
  // having touched it, which the array it replaces could not do.
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

/** An R3 change planned and committed, one command short of any approval. */
async function plannedR3(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-r3-ordering-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
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
  // Six gate ids are still unmet, and the set did not shrink in this release —
  // which is the honest report and is worth stating plainly. Three of the six
  // gained a producer here; what a producer gives them is the ability to be
  // *satisfied*, and this change attests nothing, so all three answer the absence
  // arm. The difference is in the reason, asserted immediately below: three of
  // these rows now say what is missing and name a command that produces it, and
  // three still say Legion produces no evidence for them at all.
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
    "the true remaining set, read off the real command. Give one of these a producer and this is the thing to edit"
  );
  // And the three this release closed no longer answer from that arm: each names
  // the attestation plane it looked at and what it did not find there.
  for (const gate of ["independent_baseline", "security_or_e2e_evaluator", "rollback_or_forward_fix_evidence"]) {
    const row = payload.diagnostics.find((entry) => entry.gate === gate);
    assert.notEqual(row, undefined, gate);
    assert.doesNotMatch(row.message, /does not yet produce/, gate);
    assert.match(row.message, /No attestation records anyone asserting/, gate);
    // Change-scoped, so one row for the change rather than one per task.
    assert.match(row.message, /is not satisfied for chg_/, gate);
  }

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
