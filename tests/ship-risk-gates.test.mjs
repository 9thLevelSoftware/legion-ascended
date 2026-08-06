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
// `derive()` passes no `change` facts unless a caller supplies them, even though
// `deriveShipGates` requires them in TypeScript. That is deliberate too. These
// tests import compiled JavaScript, where required-ness is not enforced, and
// they stand in for the runtime cases the type cannot cover: a caller that
// degraded to absent facts because a change artifact would not read.
//
// What that does *not* do is protect the guard. `normalizeChangeFacts` only
// repairs an absent or non-callable `verifyPin`, and the one gate that calls a
// verifier returns before reaching it whenever the facts are that degraded — so
// deleting the guard and reading `input.change` directly still leaves every
// assertion below passing. An earlier draft of this comment claimed the
// opposite, which is the more dangerous kind of wrong: a note telling the next
// reader that an edit is covered when it is not. The guard is held by the tests
// at the end of this file, which call it directly.

// `contract` carries the parts of a task contract a gate reads beyond its risk
// tier. It exists because `integration_or_real_interface_checks` is the first
// gate to read the task at all: its question is about the verification surfaces
// the contract and the contract's oracles declare, so a scenario that cannot
// change the contract cannot move its cell.
//
// The default is still `{id, risk}` and deliberately stays that way. That is the
// shape every other fixture here and in tests/ship-delta-spec-approval and
// tests/ship-human-approval-gate builds, and the gate has to tolerate it —
// `task.verification.some(...)` on it throws a TypeError out of
// `deriveShipGates`, from the one command whose job is reporting what is broken.
function task(tier, contract = {}) {
  return { id: "ctr_phase-1", risk: { tier, reasons: ["test"] }, ...contract };
}

// `acceptedAt` is carried because `evidenceAcceptanceSchema`'s `accepted` member
// *requires* it and `writeEvidenceIndex` raises `Accepted evidence bundle …
// requires acceptedAt.` on the shape this used to build. Every fixture in this
// file, in tests/ship-delta-spec-approval and in tests/ship-human-approval-gate
// was in a shape the schema would reject, on the one field
// `whole_change_acceptance_evidence` reads — and a fixture in a shape that could
// never exist on disk tests less than it appears to.
const EVIDENCE_ACCEPTED_AT = "2026-08-05T09:00:00.000Z";

function entry(items, acceptance = { status: "accepted", reviewId: "rev_1", acceptedAt: EVIDENCE_ACCEPTED_AT }) {
  return { evidence: { id: "evd_1", taskId: TASK_ID, items }, acceptance };
}

function item(id, verdict) {
  return { id, verdict };
}

function acceptedReview() {
  return { document: { id: "rev_1", status: "accepted", taskId: TASK_ID } };
}

// The approval `legion review --accept --approver` writes beside a whole-change
// acceptance, one per accepted review. `whole_change_acceptance_evidence`
// corroborates `acceptance.acceptedBy` against it, because that field is a bare
// id string with no `kind` and the accepted-versus-ready distinction the gate
// reports would otherwise rest on a name nothing could check.
function reviewAcceptApproval({ id = "dasbl", kind = "human" } = {}) {
  return {
    id: "apv_transcript-review-accept",
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    status: "granted",
    scope: { action: "workflow.review.accept", targets: [{ kind: "task", id: TASK_ID }] },
    decidedBy: { kind, id },
    decidedAt: EVIDENCE_ACCEPTED_AT
  };
}

function derive({ tier = "R2", items = [], reviews = [], change, contract, acceptance } = {}) {
  return deriveShipGates({
    tasks: [task(tier, contract)],
    taskIdFor: () => TASK_ID,
    entries: [acceptance === undefined ? entry(items) : entry(items, acceptance)],
    reviews,
    // Spread conditionally rather than passed as `undefined`, so the default
    // stays "no `change` key at all" — the shape a caller that never loaded the
    // planes produces, which is not the same as one that loaded them and found
    // nothing.
    ...(change === undefined ? {} : { change })
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
  const report = derive({ tier: "R3", ...PASSING_R2 });

  // Re-pointed at `independent_baseline`, which is R3-only and genuinely has no
  // producer. It has now been re-pointed twice: `protected_oracle` lost the job
  // when oracle results became their own evidence item, and
  // `whole_change_acceptance_evidence` lost it in this release, which is why the
  // tier moved to R3 with it. The point of this test is the `default:` arm of
  // `evaluateGate` — a gate Legion cannot answer at all must say so rather than
  // pass — so it has to name a gate that still falls through that arm, not one
  // that merely used to.
  const unproduced = report.gates.find((entry) => entry.gate === "independent_baseline");
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

const CHANGE_ID = "chg_transcript";
const REQUIREMENT_ID = "req_transcript";
const DELTA_SPEC_PATH = `.legion/project/changes/${CHANGE_ID}/delta-specs/${REQUIREMENT_ID}.md`;
const DELTA_SPEC_PIN = { path: DELTA_SPEC_PATH, sha256: `sha256:${"a".repeat(64)}` };

// Verification surfaces pin ordinary repository files rather than project
// artifacts, which is why `pinned-references.ts` resolves paths itself.
const SURFACE_PIN = { path: "ops/compose.integration.yml", sha256: `sha256:${"b".repeat(64)}` };

const REAL_INTERFACE_SURFACE = {
  kind: "real-interface",
  interface: "POST /v1/orders",
  rationale: "The suite posts a real order through the running API rather than a mocked client.",
  pinned: [SURFACE_PIN]
};

const UNIT_SURFACE = {
  kind: "unit",
  interface: "PricingEngine.quote()",
  rationale: "Exercises the pricing module in process; nothing outside this repository is reached.",
  pinned: [{ path: "packages/pricing/src/engine.ts", sha256: `sha256:${"c".repeat(64)}` }]
};

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
  },
  {
    // The sixth scenario, added with `approved_delta_spec`'s producer. Every
    // scenario above derives with no change facts at all, so a gate reading the
    // approvals plane answers `unevaluable` there whether it has a producer or
    // not — which is why none of their cells move (see the transcript comment
    // below). This is the first row in this transcript any gate has ever
    // produced from a change fact, and the first `satisfied` cell for a gate
    // that had no producer.
    //
    // The facts are structurally minimal, matching this file's convention: the
    // smallest shapes the gate reads, not schema-valid protocol documents.
    // tests/ship-delta-spec-approval parses every fixture through
    // `approvalSchema` and `changeBundleDeltaEntrySchema`; what this scenario
    // exists to hold is the transcript, not the document shapes.
    name: "an approved delta spec",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: {
      changeId: CHANGE_ID,
      deltas: [{ requirementId: REQUIREMENT_ID, path: DELTA_SPEC_PATH, delta: DELTA_SPEC_PIN }],
      approvals: [
        {
          id: "apv_transcript-approval",
          changeId: CHANGE_ID,
          status: "granted",
          scope: {
            action: "spec.delta.approve",
            targets: [{ kind: "requirement", id: REQUIREMENT_ID }]
          },
          artifacts: [DELTA_SPEC_PIN],
          decidedBy: { kind: "human", id: "dasbl" },
          decidedAt: "2026-08-01T12:00:00.000Z"
        }
      ],
      evaluatedAt: "2026-08-10T00:00:00.000Z",
      verifyPin: () => "match"
    }
  },
  {
    // The seventh scenario, added with `integration_or_real_interface_checks`'s
    // producer, and the first row in this transcript produced from the *task
    // contract* rather than from evidence or from a change plane.
    //
    // Everything the gate needs is here: a declared non-unit surface on the
    // contract's verification entry, a pin that still matches, and the evidence
    // item `legion build` writes when a non-unit surface was exercised. Removing
    // any one of the three moves this cell, which is what makes it a transcript
    // row rather than a restatement.
    name: "a verified real-interface surface",
    contract: {
      verification: [
        {
          command: "pnpm",
          args: ["test", "--filter", "orders"],
          expectedExitCode: 0,
          surface: REAL_INTERFACE_SURFACE
        }
      ]
    },
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      item("integration-surface-check", "pass")
    ],
    reviews: [acceptedReview()],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  },
  {
    // The eighth, and the first `unsatisfied` this gate has ever produced. It
    // carries no change facts at all, deliberately: "every surface this change
    // declares is a unit surface" is decided from the declarations on the
    // contracts, so the negative must be reachable without any plane loading.
    name: "only unit surfaces declared",
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: UNIT_SURFACE }
      ]
    },
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()]
  },
  {
    // The ninth, added with `whole_change_acceptance_evidence`'s producer, and
    // the first row this transcript has ever produced from `change.acceptance`.
    //
    // The sign-off's instant is byte-equal to the evidence's, which is not a
    // convenience: `legion review --accept` computes one `acceptedAt` and stamps
    // it on the reviews, on every promoted evidence entry, on the approvals and
    // on the change acceptance, so equality is what the happy path actually
    // produces. This cell is therefore also the test that fails if anyone ever
    // writes `>` instead of `>=`.
    //
    // The approvals plane carries the record that *corroborates* the acceptor.
    // `acceptance.acceptedBy` is a bare id string with no `kind`, so without a
    // granted `workflow.review.accept` approval naming a human this cell is
    // `unevaluable` — the same accept writes both, and a fixture with one and not
    // the other is a state no command produces.
    name: "an accepted change covering its evidence",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: {
      changeId: CHANGE_ID,
      acceptance: { status: "accepted", acceptedAt: EVIDENCE_ACCEPTED_AT, acceptedBy: "dasbl" },
      approvals: [reviewAcceptApproval()],
      evaluatedAt: "2026-08-10T00:00:00.000Z",
      verifyPin: () => "match"
    }
  },
  {
    // The tenth, and the branch nobody writes unless it is specified up front:
    // a change signed off, then rebuilt, then re-accepted *per task* while the
    // whole-change sign-off kept its older instant. Everything else about this
    // scenario is identical to the one above — same items, same reviews, same
    // acceptor — and the only difference is one hour on one timestamp.
    //
    // It is unreachable through the happy CLI path, and deliberately so:
    // `ship.ts` refuses before any gate runs unless every evidence entry is
    // accepted, so "rebuilt but not re-accepted" never reaches the gate. That is
    // exactly why it needs a fixture. A gate that is correct only because an
    // earlier check ran is not correct, and the earlier check does not run in
    // this file.
    name: "a change rebuilt after its sign-off",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: {
      changeId: CHANGE_ID,
      acceptance: { status: "accepted", acceptedAt: "2026-08-05T08:00:00.000Z", acceptedBy: "dasbl" },
      approvals: [reviewAcceptApproval()],
      evaluatedAt: "2026-08-10T00:00:00.000Z",
      verifyPin: () => "match"
    }
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
 * **One gate id has changed behaviour since the last release, and exactly one:
 * `whole_change_acceptance_evidence`.** It gained a producer — it reads
 * `bundle.change.acceptance`, which `legion review --accept` now promotes from
 * the `{status: "not_ready"}` that `createChangeBundle` writes and nothing had
 * ever moved, and compares its instant against the newest instant at which any of
 * this change's evidence was accepted. It is **change-scoped**, the third entry
 * in `GATE_SCOPE` that is not `"task"`: `change.acceptance` is one field on one
 * bundle with exactly one answer, and the verdict quantifies over every task, so
 * a `subjectId` naming one task would be false about the sentence beside it.
 *
 * The three statuses, stated once here because the release's whole verdict move
 * is in them:
 *
 *  - `satisfied` — the change is `accepted`, its sign-off covers every task's
 *    latest evidence, and its instant is at or after the newest instant at which
 *    any of that evidence was accepted.
 *  - `unsatisfied` — `rejected`, `blocked` or `superseded`; a sign-off dated
 *    after the moment the report was derived; a task with no evidence, or whose
 *    latest evidence has been rejected or is not accepted; or an `accepted`
 *    sign-off **older** than the evidence it claims to cover.
 *  - `unevaluable` — `not_ready` or `ready` (nobody decided), or the bundle would
 *    not read at all (nothing is known, which is a different sentence).
 *
 * The last `unsatisfied` branch is the one this gate exists for and the one
 * nobody writes unless it is specified up front: a change signed off, rebuilt,
 * and re-accepted *per task* while the whole-change sign-off kept its older
 * instant. `approvedReviewLink` names this gate as the owner of that staleness
 * and deliberately declines to answer it, so if this gate does not, nothing does.
 *
 * **No cell in the eight earlier scenarios moved, and that is the honest report
 * rather than a weaker one.** None of those eight carries a `change.acceptance`
 * at all — six load no change facts, and the two that do load them for other
 * planes — so the gate's absent-bundle answer is `unevaluable`, which is exactly
 * what the `default:` arm answered before it had a producer. What the unchanged
 * cells assert is worth keeping: they are PR 0's invariant — an absent fact
 * yields `unevaluable`, never `satisfied` — checked from outside the gate that
 * has to hold it.
 *
 * The movement is in two new scenarios, and it takes two because the pair is the
 * claim. They differ in exactly one character position:
 *
 *  - "an accepted change covering its evidence" records
 *    `whole_change_acceptance_evidence: "satisfied"` at R2, with the sign-off's
 *    instant byte-equal to the evidence's — which is what one `legion review
 *    --accept` actually writes, since it computes that instant once and stamps it
 *    on the reviews, the evidence, the approvals and the acceptance. This cell is
 *    what fails if the comparison is ever written `>` instead of `>=`.
 *  - "a change rebuilt after its sign-off" records it `"unsatisfied"` at R2 with
 *    the same items, the same reviews and the same acceptor, one hour earlier.
 *
 * Both carry the granted `workflow.review.accept` approval that corroborates the
 * acceptor, because one `legion review --accept --approver` writes both and a
 * fixture with the acceptance alone is a state no command produces. Without it
 * the first cell is `unevaluable`: `acceptance.acceptedBy` is a bare id string
 * with no `kind`, so the accepted-versus-ready distinction this gate reports has
 * to be corroborated against a record rather than read off a name.
 *
 * Both scenarios' other three tier rows are cell-for-cell identical to "passing
 * verification and an accepted review", which is the second half of the claim:
 * recording an acceptance moved this gate at the one tier that derives it, and
 * nothing else.
 *
 * The gate id that moved in the release before this one was
 * `integration_or_real_interface_checks`, and the one before that
 * `approved_delta_spec`. Their cells are recorded below as they now stand,
 * including the scenarios that were added to move them.
 *
 * **Readiness is transcribed separately, in `BASELINE_READY`, and it is not
 * uniformly false.** A draft of this paragraph asserted that `ready` was false
 * in all six scenarios at every tier above R0 and that no readiness assertion
 * therefore moved. Both halves were wrong: `ready` is `true` at R0 *and* R1 in
 * four of the six, because those tiers derive only gates Legion produces; and
 * the test below compared gate statuses and row counts only, so it asserted
 * `ready` nowhere at all. That is precisely the defect this file's header names
 * — a note telling the next reader that an edit is covered when it is not —
 * written inside the comment that exists to be the review artifact for a
 * deliberate verdict move. The table is now recorded and asserted cell by cell,
 * so a future gate that flips one of those `true` rows to blocked fails here
 * with the scenario and tier named.
 *
 * The gate id that moved in the previous release was `explicit_human_approval`,
 * and its cells are recorded below as they now stand.
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
  },
  "an approved delta spec": {
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
      // The one cell this release adds, and the only one in this row that
      // differs from "passing verification and an accepted review".
      approved_delta_spec: "satisfied",
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
      // The approvals plane holds a record, and it is a delta-spec approval.
      // This gate matches `scope.action` exactly, so it reads it as naming
      // nothing about a review — which is absence, not a negative.
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a verified real-interface surface": {
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
      // One of the two cells this release adds. The only one in this row that
      // differs from "passing verification and an accepted review".
      integration_or_real_interface_checks: "satisfied",
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
  "only unit surfaces declared": {
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
      // The other. `unsatisfied` rather than `unevaluable`, and that distinction
      // is the whole point of this scenario: the operator answered, and the
      // answer was that nothing here crosses a boundary.
      integration_or_real_interface_checks: "unsatisfied",
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
  "an accepted change covering its evidence": {
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
      // One of the two cells this release adds, and the only one in this row
      // that differs from "passing verification and an accepted review".
      whole_change_acceptance_evidence: "satisfied"
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
  "a change rebuilt after its sign-off": {
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
      // The other. One hour older than the row above and nothing else changed:
      // the sign-off is about work that has since been replaced.
      whole_change_acceptance_evidence: "unsatisfied"
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
  }
};

/**
 * `report.ready` for the same ten scenarios at the same four tiers.
 *
 * Written out as literals rather than derived from the table above, which would
 * make the assertion a restatement of `ready = unsatisfied === 0 && unevaluable
 * === 0` and could not fail independently. What it pins is that R0 and R1 are
 * genuinely reachable — four scenarios ship-ready at both — so a later gate that
 * quietly blocked a tier Legion can already satisfy would fail here rather than
 * in whatever suite happened to notice months later.
 *
 * No readiness cell moves in this release, and that is a claim rather than a
 * shrug. `an accepted change covering its evidence` is still R2-blocked *with*
 * `whole_change_acceptance_evidence: satisfied`, because this file's fixtures
 * load no approvals plane, no oracle result and no surface declaration — so the
 * other three R2 gates are unevaluable here for want of a fixture, not for want
 * of a producer. Every R2 gate now has one, and a change carrying all four kinds
 * of evidence really does report `ready`; that claim needs the whole CLI to make
 * and is made end to end by "an R2 change ships ready, end to end, for the first
 * time" in tests/change-acceptance.test.mjs, not from literals here. That
 * cross-reference is the only route from this transcript to the evidence for the
 * one claim the transcript declines to make itself, so it names a file that
 * exists: it previously pointed at `tests/ship-r2-milestone`, which never did.
 */
const BASELINE_READY = {
  "passing verification and an accepted review": { R0: true, R1: true, R2: false, R3: false },
  "no evidence and no review": { R0: false, R1: false, R2: false, R3: false },
  "failed declared-verification": { R0: false, R1: false, R2: false, R3: false },
  "passing oracle verification": { R0: true, R1: true, R2: false, R3: false },
  "failed oracle verification": { R0: true, R1: true, R2: false, R3: false },
  "an approved delta spec": { R0: true, R1: true, R2: false, R3: false },
  "a verified real-interface surface": { R0: true, R1: true, R2: false, R3: false },
  "only unit surfaces declared": { R0: true, R1: true, R2: false, R3: false },
  "an accepted change covering its evidence": { R0: true, R1: true, R2: false, R3: false },
  "a change rebuilt after its sign-off": { R0: true, R1: true, R2: false, R3: false }
};

test("no gate verdict moved: every tier and gate, against a pre-change transcript", () => {
  for (const scenario of SCENARIOS) {
    for (const tier of ["R0", "R1", "R2", "R3"]) {
      const report = derive({
        tier,
        items: scenario.items,
        reviews: scenario.reviews,
        ...(scenario.contract === undefined ? {} : { contract: scenario.contract }),
        ...(scenario.change === undefined ? {} : { change: scenario.change })
      });
      const actual = Object.fromEntries(report.gates.map((gate) => [gate.gate, gate.status]));

      // One row per (task, gate) — the arithmetic the report's counts and its
      // `ready` flag rest on. Collapsing a gate to one row per change would
      // pass the status comparison below and still change every count.
      assert.equal(Object.keys(actual).length, report.gates.length);
      assert.deepEqual(actual, BASELINE_GATE_STATUSES[scenario.name][tier], `${scenario.name} @ ${tier}`);
      assert.equal(report.ready, BASELINE_READY[scenario.name][tier], `ready @ ${scenario.name} @ ${tier}`);
    }
  }
});

test("the only change facts any gate reads are acceptance, deltas, approvals, oracles, changeId and the clock", () => {
  // The predecessor of this test asserted that no gate read any change fact,
  // by throwing on every property access. Its comment named the honest edit for
  // the day a gate started reading one: replace it with an assertion naming the
  // fields that gate reads, rather than narrowing the proxy into a no-op or
  // deleting it. This is that edit.
  //
  // It is stronger than the version it replaces, in both directions. The trap
  // still throws on the other eight planes, so the boundary claim stays
  // falsifiable for `acceptance`, `oracles`, `taskRuns` and `release` — none of
  // which has a reader yet, and each of which is a fail-open waiting for one.
  // And it records what *was* read, so the test also fails if
  // `explicit_human_approval` stops consulting the approvals plane and quietly
  // goes back to answering from the accepted review.
  //
  // `deltas` joined the allow-list with `approved_delta_spec`'s producer, and it
  // is admitted with a stated reason rather than by widening the trap: that gate
  // quantifies over `bundle.deltas`, so the set of things needing an approval
  // *is* that plane. The per-tier expectation below is what keeps the admission
  // from becoming a blanket one — R2 may read `deltas` and R3 may not, because
  // only R2 derives the gate.
  // An earlier version of this test exempted `changeId` on the claim that
  // `deriveShipGates` reads it to name a change-scoped gate's subject. That was
  // false at the time, and an exemption granted for a reason that does not hold
  // only widens the boundary the test exists to pin. It is now true — this
  // release adds the first change-scoped gate — and `changeId` is still recorded
  // like any other read rather than exempted for it.
  //
  // `oracles` joins the allow-list with `integration_or_real_interface_checks`'s
  // producer, and it is admitted with a stated reason rather than by widening the
  // trap. `legion plan` copies one authored verification surface onto both the
  // task contract's verification entry and the oracle that criterion produces, so
  // the declaration set that gate quantifies over spans the contract and the
  // oracles the contract names. Reading only one half would make an oracle-side
  // declaration invisible, which is absence — the fail-open this gate closes.
  //
  // The per-tier expectation below is what keeps that from becoming a blanket
  // admission, and it is sharper than it looks: the gate reads `oracles` only
  // when the task contract actually names one, and the tripwire's task names
  // none. So `ABSENT_PLANE_READS` does not move at all, and the third populated
  // pass at the bottom is what witnesses the read. Ordering the gate's guard that
  // way is deliberate — `acceptance`, `taskRuns` and `release` still have no
  // reader, and each is a fail-open waiting for one.
  //
  // `acceptance` joins the allow-list with `whole_change_acceptance_evidence`'s
  // producer, and it is the plane this trap was most explicitly holding open —
  // the comment above named it first among the four fail-opens waiting for a
  // reader. It is admitted with a stated reason: the gate's question *is*
  // `bundle.change.acceptance`, one field with one answer for the whole change,
  // and there is nowhere else it could be read from. Unlike `oracles`, this read
  // happens on the absent-plane path too — an unreadable bundle is one of the
  // gate's three distinct sentences — so it moves `ABSENT_PLANE_READS.R2` rather
  // than needing a populated pass to witness it. A populated pass is added below
  // anyway, because the absent path returns before the coverage quantifier runs
  // and `evaluatedAt` is only reached past it.
  //
  // `taskRuns` and `release` still have no reader, and each is a fail-open
  // waiting for one.
  function tripwire(reads, { acceptance, approvals, deltas, oracles } = {}) {
    return new Proxy(
      // `verifyPin` is the one true exemption: the guard inside
      // `deriveShipGates` inspects it on every call, to substitute a verifier
      // when a caller supplied something that is not one, so recording it would
      // say nothing about which gate read what.
      {
        verifyPin: () => "match",
        changeId: "chg_tripwire",
        acceptance,
        approvals,
        deltas,
        oracles,
        evaluatedAt: undefined
      },
      {
        get(target, property) {
          if (property === "verifyPin") return target.verifyPin;
          if (
            property === "changeId" ||
            property === "acceptance" ||
            property === "approvals" ||
            property === "deltas" ||
            property === "oracles" ||
            property === "evaluatedAt"
          ) {
            reads.push(property);
            return target[property];
          }
          throw new Error(`a ship gate read the change fact "${String(property)}"`);
        }
      }
    );
  }

  // R2 reads `changeId` even against an absent plane, and not from a gate:
  // `deriveShipGates` reads it to name a change-scoped gate's subject, which it
  // does whatever that gate concluded. That read was hypothetical when this
  // exemption was last argued about and is now real, so it is recorded rather
  // than exempted.
  const ABSENT_PLANE_READS = {
    R0: [],
    R1: [],
    R2: ["deltas", "changeId", "acceptance"],
    R3: ["approvals"]
  };

  for (const tier of ["R0", "R1", "R2", "R3"]) {
    const reads = [];
    const withFacts = deriveShipGates({
      tasks: [task(tier)],
      taskIdFor: () => TASK_ID,
      entries: [entry(PASSING_R2.items)],
      reviews: PASSING_R2.reviews,
      change: tripwire(reads)
    });
    const withoutFacts = derive({ tier, ...PASSING_R2 });

    // Reading an absent plane produces the same *verdicts* as passing no facts
    // at all. An absent fact must never be worth more than no facts.
    //
    // Compared verdict by verdict rather than as whole reports, because one
    // field legitimately differs and it is not a verdict: a change-scoped gate
    // names the change as its subject when a change id is known and falls back
    // to the task id when it is not, so `subjectId` moves the moment any facts
    // are supplied. That difference is asserted immediately below rather than
    // waved through — a `deepEqual` on the whole report would have to be deleted
    // or narrowed, and narrowing it silently is how a boundary test becomes a
    // no-op.
    assert.deepEqual(
      withFacts.gates.map((gate) => ({ gate: gate.gate, status: gate.status, reason: gate.reason })),
      withoutFacts.gates.map((gate) => ({ gate: gate.gate, status: gate.status, reason: gate.reason })),
      `${tier} verdicts moved when an absent plane replaced no facts`
    );
    assert.equal(withFacts.ready, withoutFacts.ready);
    assert.equal(withFacts.unevaluable, withoutFacts.unevaluable);
    assert.equal(withFacts.unsatisfied, withoutFacts.unsatisfied);
    for (const [index, gate] of withFacts.gates.entries()) {
      const expectedSubject = gate.scope === "change" ? "chg_tripwire" : TASK_ID;
      assert.equal(gate.subjectId, expectedSubject, gate.gate);
      assert.equal(withoutFacts.gates[index].subjectId, TASK_ID, gate.gate);
    }

    // Only R2 derives approved_delta_spec and only R3 derives
    // explicit_human_approval, so only those tiers should have touched a plane.
    // A lower tier reading one would mean the gate set and the fact set had
    // drifted apart. An unreadable plane is answered without consulting anything
    // else, which is why `changeId` is not in these lists.
    assert.deepEqual(
      [...new Set(reads)],
      ABSENT_PLANE_READS[tier],
      `${tier} read ${JSON.stringify([...new Set(reads)])}`
    );
  }

  // The same wire against planes that hold records, because the loop above
  // answers an unreadable plane without consulting anything else and an empty
  // one without running the scoping predicate at all. Without these passes, a
  // gate could start reading `oracles` or `taskRuns` on the populated path and
  // no assertion anywhere would notice.
  //
  // The stand-in documents are structurally minimal, like every other fixture in
  // this file: enough fields for the scoping predicates to run to a decision, no
  // more. Real `approvalSchema` documents are what
  // tests/ship-human-approval-gate and tests/ship-delta-spec-approval assert the
  // verdicts against.
  const populatedReviewReads = [];
  deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedReviewReads, {
      approvals: [
        { changeId: "chg_tripwire", taskId: TASK_ID, scope: { action: "workflow.review.accept", targets: [] } }
      ]
    })
  });
  assert.deepEqual([...new Set(populatedReviewReads)].sort(), ["approvals", "changeId"]);

  const populatedDeltaReads = [];
  deriveShipGates({
    tasks: [task("R2")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedDeltaReads, {
      approvals: [
        {
          id: "apv_tripwire",
          changeId: "chg_tripwire",
          status: "granted",
          scope: { action: "spec.delta.approve", targets: [{ kind: "requirement", id: REQUIREMENT_ID }] },
          artifacts: [DELTA_SPEC_PIN],
          decidedBy: { kind: "human", id: "dasbl" },
          decidedAt: "2026-08-01T12:00:00.000Z"
        }
      ],
      deltas: [{ requirementId: REQUIREMENT_ID, path: DELTA_SPEC_PATH, delta: DELTA_SPEC_PIN }]
    })
  });
  assert.deepEqual(
    [...new Set(populatedDeltaReads)].sort(),
    ["acceptance", "approvals", "changeId", "deltas", "evaluatedAt"]
  );

  // And once more with a task that names an oracle, which is the only shape that
  // makes `integration_or_real_interface_checks` consult the oracle plane. Both
  // passes above leave `oracles` untouched — deliberately, so the gate's guard
  // ordering is asserted rather than assumed — which means without this pass the
  // admission above would be a widening nothing witnesses.
  const populatedOracleReads = [];
  const oracleReport = deriveShipGates({
    tasks: [task("R2", { oracleRefs: ["orc_transcript-c1"] })],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedOracleReads, {
      oracles: [
        {
          document: { id: "orc_transcript-c1", surface: UNIT_SURFACE },
          reference: SURFACE_PIN
        }
      ]
    })
  });
  assert.deepEqual(
    [...new Set(populatedOracleReads)].sort(),
    ["acceptance", "changeId", "deltas", "oracles"]
  );
  // The oracle's declaration is genuinely read, not merely touched: a unit-only
  // declaration set is the gate's recorded negative.
  assert.equal(
    oracleReport.gates.find((gate) => gate.gate === "integration_or_real_interface_checks").status,
    "unsatisfied"
  );

  // And once more against a plane holding a real acceptance. The absent-plane
  // loop above reaches `acceptance` and returns immediately, so without this the
  // clock read past the coverage quantifier would be invisible — and a gate that
  // silently stopped consulting `evaluatedAt` would be one that could no longer
  // tell a future-dated sign-off from a live one.
  const populatedAcceptanceReads = [];
  const acceptanceReport = deriveShipGates({
    tasks: [task("R2")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedAcceptanceReads, {
      acceptance: { status: "accepted", acceptedAt: EVIDENCE_ACCEPTED_AT, acceptedBy: "dasbl" },
      // `chg_tripwire`, because the corroboration matches on strict change-id
      // equality: facts too degraded to name their own change must match nothing
      // rather than everything.
      approvals: [{ ...reviewAcceptApproval(), changeId: "chg_tripwire" }]
    })
  });
  assert.deepEqual(
    [...new Set(populatedAcceptanceReads)].sort(),
    ["acceptance", "approvals", "changeId", "deltas", "evaluatedAt"]
  );
  assert.equal(
    acceptanceReport.gates.find((gate) => gate.gate === "whole_change_acceptance_evidence").status,
    "satisfied"
  );
});

/**
 * Which gate ids are about the change rather than about one task.
 *
 * Written out here, against the compiled module, rather than imported from it:
 * a test that read `GATE_SCOPE` would assert that the record equals itself. This
 * list is the claim, and changing a scope means changing this line beside the
 * one in `ship-gates.ts` — which is the point, because a scope flip is not a
 * refactor. It changes which subject the operator's diagnostic names and whether
 * that diagnostic is collapsed to one per change.
 */
const CHANGE_SCOPED_GATES = new Set([
  "approved_delta_spec",
  "integration_or_real_interface_checks",
  "whole_change_acceptance_evidence"
]);

test("every gate names its scope and the subject that scope refers to", () => {
  // The ship command's blocked diagnostic interpolates `subjectId`, and nothing
  // else in the tree checks its text — so without this, "a task-scoped gate
  // names its task and a change-scoped one names its change" would be an
  // assumption rather than a fact.
  //
  // Both halves are asserted, because they fail in opposite directions. A gate
  // wrongly marked task-scoped repeats one sentence once per task; a gate
  // wrongly marked change-scoped reports a verdict about one task under the
  // change's name and swallows the other tasks' diagnostics entirely.
  // Looked up by name, not by position. It used to read `SCENARIOS.at(-1)`, and
  // the day a scenario was appended for a different gate — this release —
  // `derive` would have spread facts with no `changeId` and `approved_delta_spec`
  // would have fallen back to naming the task, failing this test with a message
  // about the delta-spec gate and no visible connection to the scenario that
  // broke it.
  const approvedDeltaSpec = SCENARIOS.find((scenario) => scenario.name === "an approved delta spec");

  for (const tier of ["R0", "R1", "R2", "R3"]) {
    const report = derive({ tier, ...PASSING_R2, change: approvedDeltaSpec.change });
    assert.ok(report.gates.length > 0);
    for (const gate of report.gates) {
      const expected = CHANGE_SCOPED_GATES.has(gate.gate) ? "change" : "task";
      assert.equal(gate.scope, expected, gate.gate);
      assert.equal(gate.subjectId, expected === "change" ? CHANGE_ID : TASK_ID, gate.gate);
      assert.equal(gate.taskId, TASK_ID);
    }
  }

  // With no facts at all, a change-scoped gate still names the task: naming a
  // task that exists beats naming a change that does not, and the gate is
  // unevaluable in that case anyway.
  for (const gate of derive({ tier: "R2", ...PASSING_R2 }).gates) {
    assert.equal(gate.subjectId, TASK_ID, gate.gate);
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
