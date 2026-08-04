import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveShipGates } from "../packages/cli/dist/workflow/ship-gates.js";

const TASK_ID = "tsk_phase-1";

function task(tier) {
  return { id: "ctr_phase-1", risk: { tier, reasons: ["test"] } };
}

function entry(items) {
  return { evidence: { id: "evd_1", taskId: TASK_ID, items }, acceptance: { status: "accepted" } };
}

function item(id, verdict) {
  return { id, verdict };
}

function acceptedReview() {
  return { document: { id: "rev_1", status: "accepted", taskId: TASK_ID } };
}

function derive({ tier = "R2", items = [], reviews = [] } = {}) {
  return deriveShipGates({
    tasks: [task(tier)],
    taskIdFor: () => TASK_ID,
    entries: [entry(items)],
    reviews
  });
}

const PASSING_R2 = {
  items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
  reviews: [acceptedReview()]
};

test("a failed declared-verification leaves the deterministic_verification gate unsatisfied", () => {
  const report = derive({
    items: [item("declared-verification", "fail"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()]
  });

  const gate = report.gates.find((entry) => entry.gate === "deterministic_verification");
  assert.equal(gate.status, "unsatisfied");
  assert.equal(report.ready, false);
});

test("a failed diff-reconciliation leaves the scoped_implementer_run gate unsatisfied", () => {
  // scoped_implementer_run is an R1 gate. DEFAULT_RISK_POLICY does not include
  // it at R2 or R3, so this asserts at the tier where the policy actually
  // demands it.
  const report = derive({
    tier: "R1",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "fail")],
    reviews: [acceptedReview()]
  });

  const gate = report.gates.find((entry) => entry.gate === "scoped_implementer_run");
  assert.equal(gate.status, "unsatisfied");
  assert.equal(report.ready, false);
});

test("R2 and R3 do not derive a scope-containment gate", () => {
  // Recording current policy behaviour rather than asserting it is correct:
  // DEFAULT_RISK_POLICY drops scoped_implementer_run above R1. Containment is
  // still enforced — build blocks on a failed reconciliation and review
  // --accept refuses one — but it is not re-checked as a ship gate. Changing
  // the shipped policy is an ADR decision, not a test fixup.
  for (const tier of ["R2", "R3"]) {
    const report = derive({ tier, ...PASSING_R2 });
    assert.equal(
      report.gates.some((entry) => entry.gate === "scoped_implementer_run"),
      false,
      `${tier} unexpectedly derived scoped_implementer_run`
    );
  }
});

test("a missing accepted review leaves the independent review gate unsatisfied", () => {
  const report = derive({ items: PASSING_R2.items, reviews: [] });

  const gate = report.gates.find((entry) => entry.gate === "task_level_independent_review");
  assert.equal(gate.status, "unsatisfied");
  assert.equal(report.ready, false);
});

test("gates with no producer are unevaluable, not silently satisfied", () => {
  const report = derive(PASSING_R2);

  // `whole_change_acceptance_evidence` still has no producer. `protected_oracle`
  // did until oracle results became their own evidence item, so this asserts
  // against a gate that is genuinely unproduced rather than one that merely was.
  const unproduced = report.gates.find((entry) => entry.gate === "whole_change_acceptance_evidence");
  assert.equal(unproduced.status, "unevaluable");
  assert.match(unproduced.reason, /does not yet produce/);

  // They are counted so the gap is visible on every ship, never absorbed
  // into the satisfied total.
  assert.ok(report.unevaluable > 0);
  assert.equal(report.satisfied + report.unsatisfied + report.unevaluable, report.gates.length);
});

test("oracle gates read the oracle evidence item, not declared-verification", () => {
  // Folded together, one verdict answered two different questions: "did the
  // contract's own commands pass" and "did the criteria the phase was specified
  // against hold". A task whose declared commands pass and whose oracle fails
  // must not satisfy the oracle gate.
  const passing = derive({
    items: [item("declared-verification", "pass"), item("oracle-verification", "pass")],
    reviews: [acceptedReview()]
  });
  assert.equal(passing.gates.find((entry) => entry.gate === "protected_oracle").status, "satisfied");

  const failing = derive({
    items: [item("declared-verification", "pass"), item("oracle-verification", "fail")],
    reviews: [acceptedReview()]
  });
  assert.equal(failing.gates.find((entry) => entry.gate === "protected_oracle").status, "unsatisfied");
  assert.equal(failing.ready, false);
});

test("a task naming no oracle is unevaluable, not satisfied", () => {
  // No oracle evidence means the criteria were never expressed, which is not
  // the same as their having held. Defaulting to satisfied would let a task
  // clear an oracle gate by declaring nothing.
  const report = derive(PASSING_R2);
  const gate = report.gates.find((entry) => entry.gate === "protected_oracle");
  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /No oracle-verification evidence/);
});

test("unevaluable gates block, because a gate with no producer is unmet", () => {
  // Otherwise an R2 change reports ready while the same payload lists its
  // security, acceptance and rollback gates as unproven.
  const clean = derive(PASSING_R2);
  assert.equal(clean.unsatisfied, 0);
  assert.ok(clean.unevaluable > 0);
  assert.equal(clean.ready, false);

  const broken = derive({ ...PASSING_R2, reviews: [] });
  assert.ok(broken.unsatisfied > 0);
  assert.equal(broken.ready, false);
});

test("a tier whose gates are all evaluable can be ready", () => {
  // R0 needs only a contract, deterministic verification and an evidence note —
  // all of which Legion produces — so readiness remains reachable.
  const r0 = derive({ tier: "R0", ...PASSING_R2 });
  assert.equal(r0.unevaluable, 0);
  assert.equal(r0.unsatisfied, 0);
  assert.equal(r0.ready, true);
});

test("a lower risk tier requires fewer gates", () => {
  const r0 = derive({ tier: "R0", ...PASSING_R2 });
  const r3 = derive({ tier: "R3", ...PASSING_R2 });

  assert.ok(r0.gates.length < r3.gates.length);
  // R0 needs no independent review; R3 demands explicit human approval.
  assert.equal(r0.gates.some((entry) => entry.gate === "explicit_human_approval"), false);
  assert.equal(r3.gates.some((entry) => entry.gate === "explicit_human_approval"), true);
});

test("every derived gate names the task it belongs to", () => {
  const report = derive(PASSING_R2);
  assert.ok(report.gates.length > 0);
  assert.ok(report.gates.every((entry) => entry.taskId === TASK_ID));
});

test("approved_spec_and_oracle is not satisfied by a passing oracle run", () => {
  // That gate asks whether the spec and oracle were approved *before* gated
  // execution. A post-execution test verdict cannot answer it: there is no
  // approval record, approver, or ordering timestamp anywhere to check.
  // Satisfying it from the oracle result would claim a governance gate was met
  // when no such approval exists.
  const report = derive({
    tier: "R3",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      item("oracle-verification", "pass")
    ],
    reviews: [acceptedReview()]
  });

  const gate = report.gates.find((entry) => entry.gate === "approved_spec_and_oracle");
  if (gate !== undefined) {
    assert.equal(gate.status, "unevaluable");
    assert.match(gate.reason, /does not yet produce/);
  }
});

test("an oracle verdict of unknown does not satisfy the gate", () => {
  // `unknown` is what build records when a task references oracles that were
  // not all evaluated — a requirement mixing executable and manual criteria
  // emits both command and inspection oracles, and only the commands run.
  // Passing commands must not stand in for criteria nobody inspected.
  const report = derive({
    items: [item("declared-verification", "pass"), item("oracle-verification", "unknown")],
    reviews: [acceptedReview()]
  });

  const gate = report.gates.find((entry) => entry.gate === "protected_oracle");
  assert.notEqual(gate.status, "satisfied");
  assert.equal(report.ready, false);
});
