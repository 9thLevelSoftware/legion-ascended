import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveShipGates,
  earliestExecutionStart,
  normalizeChangeFacts
} from "../packages/cli/dist/workflow/ship-gates.js";

const TASK_ID = "tsk_phase-1";

// The fixtures below are deliberately structurally minimal: the smallest shapes
// `deriveShipGates` actually reads, not schema-valid protocol documents. That is
// the point of this suite — it exercises gate logic with no filesystem and no
// artifact service, and end-to-end shape is covered by tests/ship-traceability.
// Do not "fix" them into real documents; the cost would be a slow suite that
// asserts the same things.
//
// `derive()` also passes no `change` facts at all, even though `deriveShipGates`
// now requires them in TypeScript. That is deliberate too. These tests import
// compiled JavaScript, where required-ness is not enforced, and they stand in
// for the runtime cases the type cannot cover: a caller that degraded to absent
// facts because a change artifact would not read.
//
// What that does *not* do is protect the guard. No gate reads a change fact in
// this release, so deleting `normalizeChangeFacts` and reading `input.change`
// directly leaves every assertion below passing — an earlier draft of this
// comment claimed the opposite, which is the more dangerous kind of wrong: a
// note telling the next reader that an edit is covered when it is not. The guard
// is held by the tests at the end of this file, which call it directly.

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

// --- the seam that carries change-scoped facts ------------------------------

const SCENARIOS = [
  {
    name: "passing verification and an accepted review",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()]
  },
  { name: "no evidence and no review", items: [], reviews: [] },
  {
    name: "failed declared-verification",
    items: [item("declared-verification", "fail"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()]
  },
  {
    name: "passing oracle verification",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      item("oracle-verification", "pass")
    ],
    reviews: [acceptedReview()]
  },
  {
    name: "failed oracle verification",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      item("oracle-verification", "fail")
    ],
    reviews: [acceptedReview()]
  }
];

/**
 * Every gate's verdict, at every tier, in five input scenarios — transcribed
 * from a build made before the change-facts seam was added.
 *
 * Nothing in this file could previously falsify "no gate verdict moved". Each
 * existing test reads one gate, so a change that flipped a gate nobody asserts
 * on would ship green — and the seam being added here threads a new argument
 * through the one function every gate flows through, which is precisely the
 * shape of change that moves a verdict by accident.
 *
 * Later work that gives one of the unevaluable gates a real producer is
 * expected to edit exactly the cells for its own gate. That edit is the
 * behaviour change, stated in one place, and reviewing it is reviewing the
 * central claim of the change that makes it.
 *
 * **One gate id has moved since that transcript was taken, and exactly one:
 * `explicit_human_approval`.** It appears once per scenario, all five times at
 * R3, and all five cells are now `unevaluable`. No other gate id moved in any
 * scenario at any tier, and the arithmetic guard below still holds because the
 * gate stayed task-scoped.
 *
 * Four of the five moved from `satisfied`, which is the point of the change:
 * the gate shared an arm with the two independent-review gates and answered
 * from any accepted review, so it reported a human approval on a change whose
 * every review records `reviewer: {kind: "tool"}` and where no human identity
 * existed anywhere. `derive()` passes no `change` facts, so the approvals plane
 * is absent, and absent is `unevaluable`.
 *
 * The fifth — "no evidence and no review" at R3 — moved from `unsatisfied` to
 * `unevaluable`, which is a loosening and is deliberate. That scenario has no
 * review at all, so the old arm reported a negative human-approval verdict it
 * had no basis for: nobody had been asked. It now reports that the plane was
 * never consulted. `ready` is false either way, in all five, so no readiness
 * assertion moved with them.
 */
const BASELINE_GATE_STATUSES = {
  "passing verification and an accepted review": {
    R0: {
      current_task_contract_or_small_change_record: "satisfied",
      deterministic_verification: "satisfied",
      evidence_note: "satisfied"
    },
    R1: {
      task_contract: "satisfied",
      scoped_implementer_run: "satisfied",
      deterministic_verification: "satisfied",
      evidence_bundle_or_log: "satisfied",
      lightweight_independent_review: "satisfied"
    },
    R2: {
      approved_delta_spec: "unevaluable",
      protected_oracle: "unevaluable",
      task_contract: "satisfied",
      deterministic_verification: "satisfied",
      task_level_independent_review: "satisfied",
      integration_or_real_interface_checks: "unevaluable",
      whole_change_acceptance_evidence: "unevaluable"
    },
    R3: {
      independent_baseline: "unevaluable",
      approved_spec_and_oracle: "unevaluable",
      protected_oracle: "unevaluable",
      deterministic_verification: "satisfied",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "no evidence and no review": {
    R0: {
      current_task_contract_or_small_change_record: "satisfied",
      deterministic_verification: "unevaluable",
      evidence_note: "unsatisfied"
    },
    R1: {
      task_contract: "satisfied",
      scoped_implementer_run: "unevaluable",
      deterministic_verification: "unevaluable",
      evidence_bundle_or_log: "unsatisfied",
      lightweight_independent_review: "unsatisfied"
    },
    R2: {
      approved_delta_spec: "unevaluable",
      protected_oracle: "unevaluable",
      task_contract: "satisfied",
      deterministic_verification: "unevaluable",
      task_level_independent_review: "unsatisfied",
      integration_or_real_interface_checks: "unevaluable",
      whole_change_acceptance_evidence: "unevaluable"
    },
    R3: {
      independent_baseline: "unevaluable",
      approved_spec_and_oracle: "unevaluable",
      protected_oracle: "unevaluable",
      deterministic_verification: "unevaluable",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "failed declared-verification": {
    R0: {
      current_task_contract_or_small_change_record: "satisfied",
      deterministic_verification: "unsatisfied",
      evidence_note: "satisfied"
    },
    R1: {
      task_contract: "satisfied",
      scoped_implementer_run: "satisfied",
      deterministic_verification: "unsatisfied",
      evidence_bundle_or_log: "satisfied",
      lightweight_independent_review: "satisfied"
    },
    R2: {
      approved_delta_spec: "unevaluable",
      protected_oracle: "unevaluable",
      task_contract: "satisfied",
      deterministic_verification: "unsatisfied",
      task_level_independent_review: "satisfied",
      integration_or_real_interface_checks: "unevaluable",
      whole_change_acceptance_evidence: "unevaluable"
    },
    R3: {
      independent_baseline: "unevaluable",
      approved_spec_and_oracle: "unevaluable",
      protected_oracle: "unevaluable",
      deterministic_verification: "unsatisfied",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "passing oracle verification": {
    R0: {
      current_task_contract_or_small_change_record: "satisfied",
      deterministic_verification: "satisfied",
      evidence_note: "satisfied"
    },
    R1: {
      task_contract: "satisfied",
      scoped_implementer_run: "satisfied",
      deterministic_verification: "satisfied",
      evidence_bundle_or_log: "satisfied",
      lightweight_independent_review: "satisfied"
    },
    R2: {
      approved_delta_spec: "unevaluable",
      protected_oracle: "satisfied",
      task_contract: "satisfied",
      deterministic_verification: "satisfied",
      task_level_independent_review: "satisfied",
      integration_or_real_interface_checks: "unevaluable",
      whole_change_acceptance_evidence: "unevaluable"
    },
    R3: {
      independent_baseline: "unevaluable",
      approved_spec_and_oracle: "unevaluable",
      protected_oracle: "satisfied",
      deterministic_verification: "satisfied",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "failed oracle verification": {
    R0: {
      current_task_contract_or_small_change_record: "satisfied",
      deterministic_verification: "satisfied",
      evidence_note: "satisfied"
    },
    R1: {
      task_contract: "satisfied",
      scoped_implementer_run: "satisfied",
      deterministic_verification: "satisfied",
      evidence_bundle_or_log: "satisfied",
      lightweight_independent_review: "satisfied"
    },
    R2: {
      approved_delta_spec: "unevaluable",
      protected_oracle: "unsatisfied",
      task_contract: "satisfied",
      deterministic_verification: "satisfied",
      task_level_independent_review: "satisfied",
      integration_or_real_interface_checks: "unevaluable",
      whole_change_acceptance_evidence: "unevaluable"
    },
    R3: {
      independent_baseline: "unevaluable",
      approved_spec_and_oracle: "unevaluable",
      protected_oracle: "unsatisfied",
      deterministic_verification: "satisfied",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  }
};

test("no gate verdict moved: every tier and gate, against a pre-change transcript", () => {
  for (const scenario of SCENARIOS) {
    for (const tier of ["R0", "R1", "R2", "R3"]) {
      const report = derive({ tier, items: scenario.items, reviews: scenario.reviews });
      const actual = Object.fromEntries(report.gates.map((gate) => [gate.gate, gate.status]));

      // One row per (task, gate) — the arithmetic the report's counts and its
      // `ready` flag rest on. Collapsing a gate to one row per change would
      // pass the status comparison below and still change every count.
      assert.equal(Object.keys(actual).length, report.gates.length);
      assert.deepEqual(actual, BASELINE_GATE_STATUSES[scenario.name][tier], `${scenario.name} @ ${tier}`);
    }
  }
});

test("the only change facts any gate reads are approvals, changeId and the clock", () => {
  // The predecessor of this test asserted that no gate read any change fact,
  // by throwing on every property access. Its comment named the honest edit for
  // the day a gate started reading one: replace it with an assertion naming the
  // fields that gate reads, rather than narrowing the proxy into a no-op or
  // deleting it. This is that edit.
  //
  // It is stronger than the version it replaces, in both directions. The trap
  // still throws on the other nine planes, so the boundary claim stays
  // falsifiable for `acceptance`, `deltas`, `oracles`, `taskRuns` and `release`
  // — none of which has a reader yet, and each of which is a fail-open waiting
  // for one. And it now records what *was* read, so the test also fails if
  // `explicit_human_approval` stops consulting the approvals plane and quietly
  // goes back to answering from the accepted review.
  //
  // The equality below is the second half of the claim: reading an absent
  // `approvals` produces the same report as passing no facts at all. An absent
  // fact must never be worth more than no facts.
  // An earlier version of this test exempted `changeId` on the claim that
  // `deriveShipGates` reads it to name a change-scoped gate's subject. That was
  // false — `GATE_SCOPE` maps all twenty ids to "task", so the read
  // short-circuits — and an exemption granted for a reason that does not hold
  // only widens the boundary the test exists to pin. `changeId` is recorded like
  // any other read now, and it is genuinely read: the approval gate scopes the
  // plane to this change itself rather than trusting the loader to have listed
  // one directory.
  function tripwire(reads, approvals) {
    return new Proxy(
      // `verifyPin` is the one true exemption: the guard inside
      // `deriveShipGates` inspects it on every call, to substitute a verifier
      // when a caller supplied something that is not one, so recording it would
      // say nothing about which gate read what.
      { verifyPin: () => "unverified", changeId: "chg_tripwire", approvals, evaluatedAt: undefined },
      {
        get(target, property) {
          if (property === "verifyPin") return target.verifyPin;
          if (property === "changeId" || property === "approvals" || property === "evaluatedAt") {
            reads.push(property);
            return target[property];
          }
          throw new Error(`a ship gate read the change fact "${String(property)}"`);
        }
      }
    );
  }

  for (const tier of ["R0", "R1", "R2", "R3"]) {
    const reads = [];
    const withFacts = deriveShipGates({
      tasks: [task(tier)],
      taskIdFor: () => TASK_ID,
      entries: [entry(PASSING_R2.items)],
      reviews: PASSING_R2.reviews,
      change: tripwire(reads, undefined)
    });

    assert.deepEqual(withFacts, derive({ tier, ...PASSING_R2 }));
    // Only R3 derives explicit_human_approval, so only R3 should have touched
    // the plane. A lower tier reading it would mean the gate set and the fact
    // set had drifted apart. An unreadable plane is answered without consulting
    // anything else, which is why `changeId` is not in this list.
    assert.deepEqual(
      [...new Set(reads)],
      tier === "R3" ? ["approvals"] : [],
      `${tier} read ${JSON.stringify([...new Set(reads)])}`
    );
  }

  // The same wire against a plane that holds a record, because the loop above
  // answers an unreadable plane without consulting anything else and an empty
  // one without running the scoping predicate at all. Without this pass, a gate
  // could start reading `deltas` or `taskRuns` on the populated path and no
  // assertion anywhere would notice.
  //
  // The stand-in approval is structurally minimal, like every other fixture in
  // this file: enough fields for the scoping predicate to run to a decision, no
  // more. Real `approvalSchema` documents are what tests/ship-human-approval-gate
  // asserts the verdicts against.
  const populatedReads = [];
  deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedReads, [
      { changeId: "chg_tripwire", taskId: TASK_ID, scope: { action: "workflow.review.accept", targets: [] } }
    ])
  });
  assert.deepEqual([...new Set(populatedReads)].sort(), ["approvals", "changeId"]);
});

test("every gate names its scope and the subject that scope refers to", () => {
  // The ship command's blocked diagnostic interpolates `subjectId` where it
  // interpolated `taskId`. That text is byte-identical only because every gate
  // this release emits is task-scoped with `subjectId === taskId`; nothing else
  // in the tree checks the message text, so without this the equivalence would
  // be an assumption rather than a fact.
  for (const tier of ["R0", "R1", "R2", "R3"]) {
    const report = derive({ tier, ...PASSING_R2 });
    assert.ok(report.gates.length > 0);
    for (const gate of report.gates) {
      assert.equal(gate.scope, "task", gate.gate);
      assert.equal(gate.subjectId, gate.taskId, gate.gate);
      assert.equal(gate.taskId, TASK_ID);
    }
  }
});

test("the earliest execution start skips runs that never recorded one", () => {
  // `startedAt` is optional on a created-but-unstarted run, and the run listing
  // returns an empty list when a change has no runs directory at all. An
  // ordering check that coerced either into a timestamp would compare an
  // approval against a start that never happened and call it early — the
  // fail-open this whole seam exists to make impossible. Absence has to stay
  // absent so the gate reading it can say so.
  assert.equal(earliestExecutionStart(undefined), undefined);
  assert.equal(earliestExecutionStart([]), undefined);
  assert.equal(earliestExecutionStart([{ status: "created" }]), undefined);
  assert.equal(
    earliestExecutionStart([
      { startedAt: "2026-01-02T00:00:00.000Z" },
      { status: "created" },
      { startedAt: "2026-01-01T00:00:00.000Z" }
    ]),
    "2026-01-01T00:00:00.000Z"
  );
});

// --- the runtime guard, tested where it is actually observable --------------

// `normalizeChangeFacts` is the only thing between an absent or malformed
// `change` and a `TypeError` out of `legion ship`, and in this release it is
// structurally invisible: nothing reads a fact, so replacing the call with
// `input.change` keeps every gate assertion in the tree green. Tested through
// `deriveShipGates` it would therefore be tested by nothing at all, which is how
// a guard gets deleted as dead code and rediscovered by the first gate that
// needs it. These call it directly.

test("absent, null and non-object change facts normalize to absence, not to a crash", () => {
  // `legion ship` degrades to absent facts whenever the change artifact will not
  // read. Throwing there would kill the command whose entire job is reporting
  // what is broken, at exactly the moment something is.
  assert.equal(normalizeChangeFacts(undefined), undefined);
  assert.equal(normalizeChangeFacts(null), undefined);
  assert.equal(normalizeChangeFacts("chg_x"), undefined);
  assert.equal(normalizeChangeFacts(7), undefined);
});

test("facts without a callable verifier get one that answers unverified", () => {
  // A hand-written fixture — `{ changeId: "chg_x", acceptance: undefined, ... }`
  // with no verifier — is the shape a future gate would call `verifyPin` on. The
  // substitute must answer "not checked", because "match" would pass a pin
  // nobody hashed and "missing" would report a present file as gone. Absence of
  // a verifier is absence of an answer.
  const facts = normalizeChangeFacts({ changeId: "chg_x", acceptance: undefined });

  assert.equal(facts.changeId, "chg_x");
  assert.equal(typeof facts.verifyPin, "function");
  assert.equal(facts.verifyPin({ path: "docs/x.md", sha256: "sha256:0" }), "unverified");

  // A verifier that is present but not callable is the same defect wearing a
  // key, so it is repaired too rather than trusted for having the right name.
  assert.equal(normalizeChangeFacts({ verifyPin: "yes" }).verifyPin(), "unverified");
});

test("a real verifier is passed through untouched", () => {
  // The repair must not replace a working verifier: a guard that overwrote the
  // caller's pin check would turn every pin in production into "unverified" and
  // every gate built on one into unevaluable, with no test disagreeing because
  // unevaluable is also what an unproduced gate reports.
  const verifyPin = () => "match";
  const facts = normalizeChangeFacts({ changeId: "chg_x", verifyPin });

  assert.equal(facts.verifyPin, verifyPin);
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
