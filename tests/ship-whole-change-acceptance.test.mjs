import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveShipGates, shipGateRecovery } from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `whole_change_acceptance_evidence`, gate side.
 *
 * ADR-006 asks whether acceptance evidence covers the **complete change** rather
 * than only an isolated task, and until this release nothing in Legion could
 * answer: `createChangeBundle` wrote `acceptance: {status: "not_ready"}` and no
 * code path ever moved it, so every R2 change fell through `evaluateGate`'s
 * `default:` arm and was structurally unshippable.
 *
 * The transcript in tests/ship-risk-gates records the two cells this gate moved.
 * What this file holds is every *other* way the gate can be wrong, and most of
 * them are ways to be wrong in the direction of `satisfied` — which is the
 * failure family the whole ten-gate series exists to close. In particular:
 *
 *  - `[].every()` is `true` and `Math.max` of nothing is nothing, so a gate that
 *    answered from timestamps alone reports `satisfied` on a change with no
 *    evidence at all.
 *  - a task rebuilt after sign-off whose new evidence is still `pending` carries
 *    **no `acceptedAt`**, so no comparison of instants can reach it.
 *  - `legion review --reject-reason` rewrites every evidence entry to `rejected`
 *    and leaves nothing accepted, so a sign-off would stand over rejected work.
 *  - five arms return for the five non-`accepted` members of
 *    `acceptanceStateSchema` and the code below them assumed `accepted`, so the
 *    gate's *default* answer for an unrecognized status was `satisfied`.
 *  - `acceptedBy` is a bare string, so the `accepted`-versus-`ready` distinction
 *    rested on a name nothing in the facts could check.
 *
 * The other family is a verdict with no route out, which PR 3 paid for once
 * already: five of this gate's unmet states are reachable only *after* an accept
 * has run, and the accept they all named exits 1 in every one of them.
 *
 * These fixtures are structurally minimal, matching tests/ship-risk-gates'
 * convention: the smallest shapes the gate reads. The one exception is
 * `acceptance`, which carries the fields `evidenceAcceptanceSchema` and
 * `acceptanceStateSchema` actually require — this gate reads exactly those
 * fields, and a fixture in a shape the schema would reject would test less than
 * it appears to.
 */

const TASK_ID = "tsk_phase-1";
const OTHER_TASK_ID = "tsk_phase-2";
const CHANGE_ID = "chg_acceptance";
const EVIDENCE_AT = "2026-08-05T09:00:00.000Z";
const GATE = "whole_change_acceptance_evidence";

function task(id) {
  return { id: `ctr_${id}`, risk: { tier: "R2", reasons: ["test"] } };
}

function entry(taskId, acceptance) {
  return {
    evidence: {
      id: `evd_${taskId}-attempt-1`,
      taskId,
      items: [{ id: "declared-verification", verdict: "pass" }]
    },
    acceptance
  };
}

function accepted(acceptedAt = EVIDENCE_AT) {
  return { status: "accepted", reviewId: "rev_1", acceptedAt };
}

/**
 * The record `legion review --accept --approver` writes beside the acceptance.
 *
 * The default for every fixture below, because it is what the only writer of an
 * `accepted` acceptance produces: one granted `workflow.review.accept` approval
 * per task, carrying a typed `Actor`. The gate corroborates `acceptedBy` against
 * it, so a fixture that omitted it would be a fixture no command can produce and
 * would test the absent-record arm by accident in every other test.
 */
function acceptApproval({ id = "dasbl", kind = "human", status = "granted" } = {}) {
  return {
    id: `apr_${id}`,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    scope: { action: "workflow.review.accept", targets: [{ kind: "task", id: TASK_ID }] },
    status,
    decidedBy: { id, kind },
    decidedAt: EVIDENCE_AT
  };
}

function verdict(options) {
  const { acceptance, entries, tasks = [TASK_ID], evaluatedAt = "2026-08-10T00:00:00.000Z" } = options;
  // Read through `in` rather than a default parameter: `undefined` is a distinct,
  // load-bearing value for this field — "the plane could not be read" — and a
  // default would silently replace it with the corroborating record, so the test
  // that exists for that arm would assert nothing.
  const approvals = "approvals" in options ? options.approvals : [acceptApproval()];
  const report = deriveShipGates({
    tasks: tasks.map(task),
    taskIdFor: (contract) => contract.id.replace(/^ctr_/, ""),
    entries,
    reviews: [{ document: { id: "rev_1", status: "accepted", taskId: TASK_ID } }],
    change: {
      changeId: CHANGE_ID,
      acceptance,
      approvals,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt,
      verifyPin: () => "match"
    }
  });
  return report.gates.find((gate) => gate.gate === GATE);
}

const SIGNED_OFF = { status: "accepted", acceptedAt: EVIDENCE_AT, acceptedBy: "dasbl" };

test("a sign-off at the same instant as the evidence it covers is satisfied", () => {
  // `legion review --accept` computes ONE `acceptedAt` and stamps it on the
  // reviews, on every promoted evidence entry, on the approvals and on the
  // change acceptance, so byte equality is what the happy path produces. With a
  // strict `>` no honest change would ever ship, and the equal case is not a
  // tolerance being granted — it is the intended encoding of "one accept, one
  // instant, one transaction".
  const gate = verdict({ acceptance: SIGNED_OFF, entries: [entry(TASK_ID, accepted())] });

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /dasbl accepted this change at 2026-08-05T09:00:00\.000Z/);
  assert.equal(gate.scope, "change");
  assert.equal(gate.subjectId, CHANGE_ID);
});

test("a sign-off older than the evidence it claims to cover is unsatisfied", () => {
  // The branch this gate exists for, and the one `approvedReviewLink` names as
  // this gate's to own: a change accepted, rebuilt, and re-accepted *per task*
  // while the whole-change sign-off kept its older instant. Every per-task fact
  // here is clean — the evidence is accepted, the review is accepted — so
  // nothing else in the gate set reports it.
  const gate = verdict({
    acceptance: { status: "accepted", acceptedAt: "2026-08-05T08:00:00.000Z", acceptedBy: "dasbl" },
    entries: [entry(TASK_ID, accepted())]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /older than the 2026-08-05T09:00:00\.000Z/);
  assert.match(gate.reason, /has since been replaced/);
  // `legion review`, not the accept. This state is reachable only *after* an
  // accept has run, and an accept flips every covering review from `submitted` to
  // `accepted` — which `cleanSubmittedReviewCoverage` then refuses, so a second
  // accept exits 1 with `review_not_clean` before it reaches any promotion.
  assert.equal(gate.recovery.command, "legion review");
  assert.match(gate.recovery.reason, /clean \*submitted\* review/);
});

test("a sign-off over no evidence at all is unsatisfied, not vacuously satisfied", () => {
  // `[].every()` is `true` and the newest accepted instant over an empty index
  // is `undefined`; `acceptedAt >= (newest ?? "")` is a fail-open exactly one
  // `??` wide, and it is the shape a reading of this gate as "compare two
  // timestamps" produces. The coverage quantifier runs over `tasks` — what is
  // being shipped — so a task with no entry is named rather than skipped.
  const gate = verdict({ acceptance: SIGNED_OFF, entries: [] });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /tsk_phase-1 has no evidence in this change's index/);
  assert.equal(gate.recovery.command, "legion build");
});

test("a task added to the graph after the sign-off is not covered by it", () => {
  // Quantifying over the *entries* rather than over the tasks would make this
  // invisible: the new task contributes no entry, so no instant moves and every
  // recorded acceptance still lines up. The denominator has to be what is being
  // shipped.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, accepted())],
    tasks: [TASK_ID, OTHER_TASK_ID]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /tsk_phase-2 has no evidence/);
});

test("a rebuild whose new evidence was never accepted is unsatisfied", () => {
  // No timestamp comparison can reach this: a `pending` acceptance carries no
  // `acceptedAt` at all, so a gate answering from instants alone reports
  // `satisfied` over a task whose latest run was never signed off. `legion ship`
  // refuses a mixed index before the gates run, which is why this needs a
  // fixture — a gate that is correct only because an earlier check ran is not
  // correct, and that check does not run here.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, accepted()), { ...entry(TASK_ID, { status: "pending" }), evidence: { id: "evd_tsk_phase-1-attempt-2", taskId: TASK_ID, items: [] } }]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /is not accepted, so this change was re-run after the sign-off/);
  // `legion review --accept` refuses when no clean *submitted* review covers the
  // new entries, so naming it here would send the operator to a command that
  // exits non-zero. A review has to be submitted first.
  assert.equal(gate.recovery.command, "legion review");
});

test("evidence rejected after the change was accepted leaves the gate unsatisfied", () => {
  // `legion review --reject-reason` rewrites every entry to `rejected` and, until
  // this release, touched nothing else — so accept-then-reject would leave
  // `accepted` standing with *no accepted evidence remaining*, which the
  // staleness branch cannot catch because that branch compares against the newest
  // accepted instant and a reject leaves none.
  //
  // Closed twice on purpose: here, and by the demotion `rejectLatestReview` now
  // writes. A gate that is right about a document that lies is one refactor away
  // from being wrong, and an artifact that lies is wrong whatever reads it.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, { status: "rejected", reviewId: "rev_1", reason: "not good enough" })]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /has since been rejected/);
});

test("a sign-off dated after the report was derived is unsatisfied", () => {
  // A hand-written `acceptedAt` of 3000-01-01 is `>=` everything, forever. The
  // comparison is against the injected `evaluatedAt` — one instant per report,
  // read once by `legion ship` — and it is strict, so an acceptance stamped in
  // the same millisecond the report was derived still passes.
  const gate = verdict({
    acceptance: { status: "accepted", acceptedAt: "3000-01-01T00:00:00.000Z", acceptedBy: "dasbl" },
    entries: [entry(TASK_ID, accepted())]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /cannot be dated after the moment it is read/);
});

test("a report with no clock does not block a sign-off it cannot place", () => {
  // The mirror of the test above. `evaluatedAt` is `undefined` for a caller with
  // no clock, and refusing every acceptance in that case would make the absence
  // of a clock a negative verdict about a decision. The gate skips the ordering
  // check and answers from coverage, which needs no clock.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, accepted())],
    evaluatedAt: undefined
  });

  assert.equal(gate.status, "satisfied");
});

test("not_ready and ready are unevaluable, and name different routes out", () => {
  // `{status: "not_ready"}` is what every change bundle written before this
  // release carries, and `ready` is what an accept with no `--approver` writes:
  // every task's evidence accepted, nobody named signing off on the change. Both
  // block, and the **repairs are different commands**, which is the correction of
  // a defect this gate shipped with. Under `not_ready` a clean submitted review
  // is sitting there and the accept works. Under `ready` an accept has already
  // run and flipped that review to `accepted`, so the same command exits 1 with
  // `review_not_clean` — measured against the real CLI, on the single most likely
  // operator mistake this release introduces: running `legion review --accept`
  // and forgetting `--approver`.
  const notReady = verdict({ acceptance: { status: "not_ready" }, entries: [entry(TASK_ID, accepted())] });
  assert.equal(notReady.status, "unevaluable");
  assert.match(notReady.reason, /no accept decision has been made/);
  assert.equal(notReady.recovery.command, "legion review --accept --approver <id>");
  assert.match(notReady.recovery.reason, /a clean submitted review already covers its evidence/);

  const ready = verdict({ acceptance: { status: "ready" }, entries: [entry(TASK_ID, accepted())] });
  assert.equal(ready.status, "unevaluable");
  assert.match(ready.reason, /no named approver signed off on the change as a whole/);
  assert.equal(ready.recovery.command, "legion review");
  assert.match(ready.recovery.reason, /then rerun `legion review --accept --approver <id>`/);
});

test("an unreadable bundle says nothing is known, not that nobody decided", () => {
  // `changeSchema.acceptance` is required, so a bundle that parses always
  // carries one — `undefined` reaches this gate only when `loadChangeBundle`
  // failed. Reporting that as "nobody decided" would send the operator to run an
  // accept that will fail on the same unreadable bundle. The command named here
  // reports rather than repairs, and says so.
  const gate = verdict({ acceptance: undefined, entries: [entry(TASK_ID, accepted())] });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /could not be read/);
  assert.equal(gate.recovery.command, "legion dev change validate <changeId>");
  assert.match(gate.recovery.reason, /it does not repair it/);
});

test("rejected, blocked and superseded are recorded negatives and carry their reason", () => {
  // Three recorded human-or-machine verdicts, none of them absence. `blocked` is
  // what `legion review --accept` writes when traceability reports a defect, and
  // echoing its reason is the only way an operator learns *which* defect without
  // running a second command.
  const rejected = verdict({
    acceptance: { status: "rejected", reason: "the pricing contract changed under us" },
    entries: [entry(TASK_ID, accepted())]
  });
  assert.equal(rejected.status, "unsatisfied");
  assert.match(rejected.reason, /the pricing contract changed under us/);

  const blocked = verdict({
    acceptance: { status: "blocked", reason: "missing_requirement_oracle (req_x): no oracle covers it" },
    entries: [entry(TASK_ID, accepted())]
  });
  assert.equal(blocked.status, "unsatisfied");
  assert.match(blocked.reason, /missing_requirement_oracle/);
  // The route out has to be *real*, which is why it names two commands and the
  // first one is `legion review`. `blocked` is only ever written by an accept, so
  // by the time an operator reads it the covering review is already `accepted`
  // and the accept alone exits 1. Reproduced with the real CLI: inject a dangling
  // traceRef, accept (records `blocked`), repair the traceRef, and the accept the
  // gate used to name returns `review_not_clean`.
  assert.equal(blocked.recovery.command, "legion review");
  assert.match(blocked.recovery.reason, /Submit a fresh review first/);
  assert.match(blocked.recovery.reason, /re-derives the verdict from scratch/);

  const superseded = verdict({ acceptance: { status: "superseded" }, entries: [entry(TASK_ID, accepted())] });
  assert.equal(superseded.status, "unsatisfied");
  assert.match(superseded.reason, /no longer the current decision/);
});

test("an accepted entry with no instant leaves the bar unestablished", () => {
  // The parameter type admits it and a hand-edited index produces it, even
  // though `evidenceAcceptanceSchema` requires `acceptedAt` on the `accepted`
  // member and `writeEvidenceIndex` refuses the shape. If the bar cannot be
  // established, neither can "the sign-off covers it" — and defaulting the
  // missing instant either way is a verdict about a fact nobody recorded.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, { status: "accepted", reviewId: "rev_1" })]
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /accepted with no acceptedAt/);
});

test("an acceptance with no instant is unevaluable rather than trusted", () => {
  // `acceptanceStateSchema` requires `acceptedAt` on `accepted`, so this is
  // unreachable from a bundle that parsed — but this suite calls the compiled
  // module with literals, `legion ship` degrades rather than throwing, and a
  // gate reading a hand-written artifact must not compare `undefined` against a
  // timestamp and take the answer.
  const gate = verdict({
    acceptance: { status: "accepted", acceptedBy: "dasbl" },
    entries: [entry(TASK_ID, accepted())]
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /with no instant/);
});

test("an acceptor no record on disk calls a human is unevaluable", () => {
  // `acceptanceActorSchema` is a bare `z.string().min(1).max(128)` with no
  // `kind`, unlike `reviewDecision.acceptedBy` and `approval.decidedBy`, which
  // are `Actor` objects. So the `accepted`-versus-`ready` distinction this gate
  // reports — the only thing separating "a named human signed off" from "every
  // task's evidence was accepted" — used to rest on a string nothing in the facts
  // could check, and this exact fixture reported `satisfied`. `legion ship`'s
  // contract is that it re-reads every plane rather than trusting a recorded
  // conclusion, and this was the one conclusion it took on trust.
  const gate = verdict({
    acceptance: { status: "accepted", acceptedAt: EVIDENCE_AT, acceptedBy: "legion-fake-reviewer" },
    entries: [entry(TASK_ID, accepted())]
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /no granted workflow\.review\.accept approval for this change names that actor/);
  assert.equal(gate.recovery.command, "legion review");
});

test("an acceptor every approval records as a tool is a negative, not an absence", () => {
  // A positive statement about the sign-off: the plane was read, it names this
  // actor, and it says the actor is not a person. That is `unsatisfied` rather
  // than `unevaluable`, on the same rule `humanApprovalStatus` follows — absence
  // is what nobody wrote, and this is what somebody wrote.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, accepted())],
    approvals: [acceptApproval({ kind: "tool" })]
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /records it as tool, not as a human/);
});

test("an unreadable approvals plane is unevaluable, not a satisfied sign-off", () => {
  // `undefined` means the directory would not read or the listing dropped an
  // entry, which is the one value from which nothing may be concluded. Reading it
  // as "no contradicting record, therefore fine" is the absent-fact fail-open the
  // whole series exists to close.
  const gate = verdict({ acceptance: SIGNED_OFF, entries: [entry(TASK_ID, accepted())], approvals: undefined });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /the approvals recorded for it could not be read/);
});

test("corroboration reads identity only, never whether the grant is still live", () => {
  // The line between this gate and `explicit_human_approval`, which is an R3 gate
  // and asks whether a live, unexpired, unrevoked grant covers the review being
  // shipped. An approval that has since expired is still a record that a person
  // took the decision, and re-deriving the R3 verdict inside an R2 gate is how
  // two gates quietly become one. `expiresAt` is in the past here and the gate
  // does not care.
  const gate = verdict({
    acceptance: SIGNED_OFF,
    entries: [entry(TASK_ID, accepted())],
    approvals: [{ ...acceptApproval(), expiresAt: "2026-08-06T00:00:00.000Z" }]
  });

  assert.equal(gate.status, "satisfied");
});

test("an acceptance status this Legion does not recognize is unevaluable", () => {
  // **The gate's default answer used to be `satisfied`.** Five arms returned for
  // the five non-`accepted` members of `acceptanceStateSchema` and the code below
  // them simply assumed `accepted`, so any status not in the union fell through
  // to a satisfied verdict — the inverse of the invariant the series is built on,
  // and the inverse of what `humanApprovalStatus` forty lines up does. It is not
  // reachable from a schema-valid bundle today, and `acceptanceStateSchema` is a
  // lifecycle union this plan versions to protocol 0.3.0 in a later PR; every one
  // of its five non-accepted members already permits `acceptedAt`/`acceptedBy`,
  // so a `withdrawn` or `revoked` added later would compile cleanly and ship.
  const gate = verdict({
    acceptance: { status: "totally-made-up", acceptedAt: EVIDENCE_AT, acceptedBy: "dasbl" },
    entries: [entry(TASK_ID, accepted())]
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /does not recognize as a whole-change verdict/);
});

test("an acceptance naming nobody is unevaluable, not an unnamed sign-off", () => {
  // `acceptedBy` was read through a `?? "an unnamed actor"` display fallback with
  // no guard behind it, so this reported `satisfied` with a reason that said the
  // acceptor was unnamed out loud — while the sibling case of an absent
  // `acceptedAt` two lines below reported `unevaluable`. Same defensive intent,
  // opposite direction. A gate whose entire verdict is "who signed this off" must
  // not report satisfied when the answer is nobody.
  const missing = verdict({
    acceptance: { status: "accepted", acceptedAt: EVIDENCE_AT },
    entries: [entry(TASK_ID, accepted())]
  });
  assert.equal(missing.status, "unevaluable");
  assert.match(missing.reason, /an acceptance with no acceptor/);

  const empty = verdict({
    acceptance: { status: "accepted", acceptedAt: EVIDENCE_AT, acceptedBy: "" },
    entries: [entry(TASK_ID, accepted())]
  });
  assert.equal(empty.status, "unevaluable");
});

test("a null acceptance degrades to a gate verdict rather than taking the report down", () => {
  // `acceptance: null` used to throw `TypeError: Cannot read properties of null`
  // out of `deriveShipGates`, taking every gate in the report with it. Unreachable
  // from `ship.ts` — `changeSchema.acceptance` is required and non-nullable — but
  // the neighbouring defensive arms are all justified on the grounds that this
  // module is called with hand-built literals, and `null` was the one literal
  // shape that died instead of degrading. `legion ship` is the command that must
  // not throw at an artifact that is already broken.
  const gate = verdict({ acceptance: null, entries: [entry(TASK_ID, accepted())] });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /could not be read/);
});

test("the verdict's own recovery beats the table entry", () => {
  // `GATE_RECOVERY` is keyed by gate id and therefore cannot distinguish two
  // unmet states of the same gate. This gate has five with five repairs, so it
  // answers on the verdict — and `shipGateRecovery` has to prefer that, or the
  // four states the table cannot name would all be told to run an accept.
  const gate = verdict({ acceptance: SIGNED_OFF, entries: [] });
  const recovery = shipGateRecovery({
    gates: [gate],
    fallback: { command: "legion build", reason: "Required risk gates are not satisfied." }
  });

  assert.equal(recovery.command, "legion build");
  assert.match(recovery.reason, /Build it, review it, then accept/);
});

test("a caller holding only a gate id still gets a route out", () => {
  // The table's entry, reached when a verdict carries none. It names the state
  // every change bundle written before this release is in, which is the state a
  // table *can* answer for.
  const recovery = shipGateRecovery({
    gates: [{ gate: GATE, status: "unevaluable", scope: "change", subjectId: CHANGE_ID, taskId: TASK_ID, label: "x", reason: "y" }],
    fallback: { command: "legion build", reason: "Required risk gates are not satisfied." }
  });

  assert.equal(recovery.command, "legion review --accept --approver <id>");
});
