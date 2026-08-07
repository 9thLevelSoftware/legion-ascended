import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewDecisionSchema } from "../packages/protocol/dist/index.js";
import {
  deriveShipGates,
  isDomainReviewSatisfying
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `architecture_or_security_review`, arm by arm.
 *
 * `tests/ship-risk-gates` records the transcript — one cell per (scenario, tier,
 * gate) — which is what catches a verdict moving by accident, and its four new
 * rows are this gate's status movement. This file is the other half, on
 * `tests/attestation-gates`' stated division of labour: the arms a transcript
 * cell cannot express, because each of them is about *which sentence* and *which
 * recovery* an unmet gate produces, and the transcript records only statuses.
 *
 * The distinction matters more here than it has for any earlier gate, and one
 * test below says why in as many words: before this release the gate answered
 * `unevaluable` from `evaluateGate`'s `default:` arm, so a test asserting only
 * that a plain accepted review leaves it `unevaluable` **passes against the
 * pre-change build**. Every absence arm here therefore asserts the reason.
 */

const CHANGE_ID = "chg_domain-reviewed";
const TASK_ID = "tsk_domain-reviewed-c1";
const OTHER_TASK_ID = "tsk_domain-reviewed-c2";
const OTHER_CHANGE_ID = "chg_something-else";

const ALL_AXES_PASS = { specification: "pass", integration: "pass", evidence: "pass" };
const EXECUTION_STARTED_AT = "2026-08-02T09:00:00.000Z";

const ADR = { path: "docs/adr/ADR-006-risk-gates.md", sha256: `sha256:${"c".repeat(64)}` };
const THREAT_MODEL = {
  path: "docs/next/evidence/domain-reviewed/threat-model.json",
  sha256: `sha256:${"a".repeat(64)}`
};

function task(id = "ctr_domain-reviewed-c1", tier = "R3") {
  return { id, risk: { tier, reasons: ["test"] } };
}

function entries() {
  return [
    {
      evidence: {
        id: "evd_1",
        taskId: TASK_ID,
        items: [
          { id: "declared-verification", verdict: "pass" },
          { id: "diff-reconciliation", verdict: "pass" }
        ]
      },
      acceptance: { status: "accepted", reviewId: "rev_1", acceptedAt: "2026-08-05T09:00:00.000Z" }
    }
  ];
}

function review(overrides = {}) {
  return {
    document: {
      id: "rev_domain-1",
      changeId: CHANGE_ID,
      taskId: TASK_ID,
      status: "accepted",
      domains: ["architecture"],
      verdicts: ALL_AXES_PASS,
      findings: [],
      supersedes: [],
      ...overrides
    }
  };
}

/** A review carrying no `domains` field at all — every review written before this release. */
function legacyReview(overrides = {}) {
  const built = review(overrides);
  const { domains: _dropped, ...document } = built.document;
  return { document };
}

const CLEAN = {
  [ADR.path]: { kind: "unrecognised" },
  [THREAT_MODEL.path]: { kind: "clean", shape: "threat-model", enveloped: false }
};

function classifier(table = CLEAN) {
  return (reference) => table[reference.path] ?? { kind: "unrecognised" };
}

function attestation(overrides = {}) {
  return {
    id: "att_domain-reviewed-attestation-architecture-review",
    changeId: CHANGE_ID,
    attests: "architecture-review",
    verdict: "pass",
    attestedBy: { kind: "human", id: "dasbl" },
    attestedAt: "2026-08-01T09:00:00.000Z",
    sources: [ADR],
    covers: [{ kind: "task", id: TASK_ID }],
    statement: "The pricing boundary was reviewed against ADR-006 and no new coupling was introduced.",
    ...overrides
  };
}

function gateOf(report) {
  const row = report.gates.find((entry) => entry.gate === "architecture_or_security_review");
  assert.notEqual(row, undefined, "architecture_or_security_review was not derived");
  return row;
}

function derive(options = {}) {
  const {
    reviews,
    taskRuns,
    tasks = [task()],
    taskIds = [TASK_ID],
    verifyPin = () => "match",
    classifySource = classifier()
  } = options;
  // Read with `in` rather than through a default, because `undefined` is a *fact*
  // on this plane — "the attestations could not be read as a complete set" — and
  // a default of `[]` makes it unreachable from here. Every crossing test below
  // needs to say it, and the version of this file that defaulted it is the reason
  // the gate shipped answering a satisfied verdict out of a plane it could not
  // read.
  const attestations = "attestations" in options ? options.attestations : [];
  return deriveShipGates({
    tasks,
    taskIdFor: (candidate) => taskIds[tasks.indexOf(candidate)] ?? TASK_ID,
    entries: entries(),
    // The *raw* top-level reviews list, which the two independent-review gates
    // read. Deliberately left holding the plain accepted review every fixture in
    // this tree carries, so that nothing below can satisfy this gate through it.
    reviews: [{ document: { id: "rev_1", status: "accepted", taskId: TASK_ID } }],
    change: {
      changeId: CHANGE_ID,
      acceptance: undefined,
      approvals: undefined,
      attestations,
      reviews,
      deltas: undefined,
      oracles: undefined,
      taskRuns,
      release: undefined,
      evaluatedAt: "2026-08-10T00:00:00.000Z",
      verifyPin,
      classifySource
    }
  });
}

test("a plain accepted review with no domains leaves the gate unevaluable, and says so about the domain", () => {
  // **The specification's hard requirement, and the one test in this file that
  // has to assert on the reason rather than the status.** Before this release the
  // gate fell through `evaluateGate`'s `default:` arm and answered `unevaluable`
  // for every input whatsoever, so "a plain accepted review does not satisfy this
  // gate" was already true — of a build that checked nothing. Deleting the `case`
  // arm today restores exactly that, and the status assertion alone would stay
  // green through it. The sentence is what distinguishes a gate that looked from
  // a gate that has no producer.
  const gate = gateOf(derive({ reviews: [legacyReview()] }));

  assert.equal(gate.status, "unevaluable");
  assert.doesNotMatch(gate.reason, /does not yet produce/);
  assert.match(gate.reason, /records the domain it was performed in/);
  assert.match(gate.reason, new RegExp(CHANGE_ID));
  // And the route out is the review, not an attestation: this gate is the one
  // attestation-reading gate whose evidence a command in the workflow produces.
  assert.equal(gate.recovery.command, "legion review --domain architecture");
});

test("a review recording only implementation is not an architecture or security review", () => {
  // Recording *a* domain is not recording *this* one. Without the filter the
  // gate would be satisfied by the domain `legion review` would most naturally
  // default to, which is the fail-open in its most reachable form.
  const gate = gateOf(derive({ reviews: [review({ domains: ["implementation"] })] }));

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /record the domain they were performed in \(implementation\)/);
  assert.match(gate.reason, /none of them is architecture or security/);
});

test("an accepted, clean architecture review satisfies the gate and names what was not established", () => {
  const gate = gateOf(derive({ reviews: [review()] }));

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /carries an accepted review performed in architecture/);
  // A satisfied verdict that overclaims is worse than one that blocks. Nothing in
  // this repository records an implementer identity that varies, so the gate says
  // in its own sentence that independence is not what it established.
  assert.match(gate.reason, /not the reviewer's independence of the implementer/);
  // Change-scoped: one answer, about the change.
  assert.equal(gate.scope, "change");
  assert.equal(gate.subjectId, CHANGE_ID);
});

test("security alone satisfies it too, because ADR-006 asks for either competence", () => {
  const gate = gateOf(derive({ reviews: [review({ domains: ["security"] })] }));

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /performed in security/);
});

test("a rejected architecture review is unsatisfied, and the cure is not another review", () => {
  // **Lesson 1.** `legion review --domain architecture` on this state writes a
  // fresh review over the same evidence, exits 0, and records the same verdict —
  // the exits-0-and-still-blocked loop this series exists to close. The recovery
  // is asserted in both directions for that reason.
  const gate = gateOf(derive({ reviews: [review({ status: "rejected" })] }));

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /was rejected/);
  assert.equal(gate.recovery.command, "legion build");
  assert.doesNotMatch(gate.recovery.command, /legion review/);
  assert.match(gate.recovery.reason, /re-running the review is deliberately not offered/);
});

test("an accepted review carrying a blocking finding is unsatisfied", () => {
  // The one shape nothing else in this tree checks. `legion review --accept`
  // refuses a review that is not clean, so this is unreachable through the happy
  // path — and a gate that is correct only because an earlier command ran is not
  // correct, because that command does not run in this file and does not run over
  // a review a host or a hand wrote.
  const gate = gateOf(
    derive({
      reviews: [
        review({
          findings: [
            {
              id: "unbounded-fanout",
              title: "The router calls the pricing service per line item",
              body: "A 200-line order issues 200 requests.",
              severity: "blocking",
              evidenceRefs: ["evd_1"]
            }
          ]
        })
      ]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /records a blocking finding: unbounded-fanout/);
  assert.equal(gate.recovery.command, "legion build");
});

test("a fail on any verdict axis is unsatisfied, and the axis is named", () => {
  for (const axis of ["specification", "integration", "evidence"]) {
    const gate = gateOf(
      derive({ reviews: [review({ verdicts: { ...ALL_AXES_PASS, [axis]: "fail" } })] })
    );
    assert.equal(gate.status, "unsatisfied", axis);
    assert.match(gate.reason, new RegExp(`records its ${axis} verdict as fail`), axis);
  }
});

test("an axis that reached no verdict does not satisfy the gate, and is not a failure either", () => {
  // **Lesson 4, in the place it would have been easiest to get wrong.**
  // `reviewVerdictSchema` admits `unknown`, `not_verified` and `not_applicable`
  // besides `pass` and `fail`, so a satisfied arm written as "no axis is fail" is
  // satisfied by a review that verified nothing at all. Each of the three is
  // checked, because a positive check written for one of them and a negative one
  // for the others would pass a test that only tried `unknown`.
  for (const verdict of ["unknown", "not_verified", "not_applicable"]) {
    const gate = gateOf(
      derive({ reviews: [review({ verdicts: { ...ALL_AXES_PASS, integration: verdict } })] })
    );
    assert.equal(gate.status, "unevaluable", verdict);
    assert.match(gate.reason, new RegExp(`integration is "${verdict}"`), verdict);
    assert.match(gate.reason, /is satisfied by a review that says every axis passed/, verdict);
  }
});

test("a submitted architecture review nobody accepted is unevaluable, and the cure is the accept", () => {
  // An unaccepted review is a verdict nobody has stood behind, and the repair is
  // one command rather than another review — which is a different cure from the
  // absence arm's, so the arms must not share one.
  const gate = gateOf(derive({ reviews: [review({ status: "submitted" })] }));

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /is still submitted: nobody has accepted it/);
  assert.equal(gate.recovery.command, "legion review --accept --approver <id>");
});

test("a domain review superseded by a domainless one stops answering for the change", () => {
  // The staleness arm. `supersedes` is a recorded link the review gate writes,
  // not a timestamp comparison, and without reading it an architecture review
  // accepted at attempt 1 keeps satisfying this gate after the work was
  // re-reviewed by a review that examined no domain — a governance verdict
  // surviving the thing it was a verdict about.
  const gate = gateOf(
    derive({
      reviews: [
        review(),
        legacyReview({ id: "rev_domain-2", supersedes: ["rev_domain-1"] })
      ]
    })
  );

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /review rev_domain-2 has since superseded it without recording a domain/);
});

test("a review of another change answers for nothing", () => {
  // Strict change-id equality, on the approvals plane's rule: a record too
  // degraded to name its own change matches nothing rather than everything.
  const gate = gateOf(derive({ reviews: [review({ changeId: OTHER_CHANGE_ID })] }));

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /No review of change chg_domain-reviewed records the domain/);
});

test("one reviewed task of two leaves the gate unevaluable, naming the task with no review", () => {
  // The coverage quantifier, and its empty case is the reason it exists: `every`
  // over an empty denominator is vacuously true, so a change whose second task
  // nobody looked at must not inherit the first task's review.
  //
  // `unevaluable` rather than `unsatisfied`, deliberately, and the divergence from
  // `attestationRecordStatus`' `covers` arm is stated in the gate: there an
  // attester made a positive claim that provably fails to reach every deriving
  // task, and here nobody claimed anything about the uncovered one.
  const gate = gateOf(
    derive({
      tasks: [task("ctr_domain-reviewed-c1"), task("ctr_domain-reviewed-c2")],
      taskIds: [TASK_ID, OTHER_TASK_ID],
      reviews: [review()]
    })
  );

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, new RegExp(`leaving ${OTHER_TASK_ID} with none`));
});

test("no task deriving the gate is unevaluable, never vacuously satisfied", () => {
  // Unreachable from `deriveShipGates`, which only evaluates a gate a task
  // derived, and reachable from every other caller — including
  // `isDomainReviewSatisfying`, which `legion review` calls. A gate must not
  // inherit its central truth claim from another module's invariant.
  //
  // **Measured, and worth recording because a single-mutant reading of it is
  // misleading.** The same vacuity is closed three independent ways: the
  // `deriving.length === 0` early return, the `relevant` filter dropping a review
  // of a task that derives nothing, and the `satisfying` filter requiring
  // `taskId ∈ derivingIds`. Deleting any one of the three alone leaves this
  // assertion green — the mutant survives, and it survives because the answer is
  // still correct rather than because nothing checks it. Deleting all three
  // reddens this test. What the early return buys on its own is the *sentence*,
  // which no caller can currently observe; it is kept because the other two
  // closures are one refactor from disappearing.
  const gate = gateOf(
    deriveShipGates({
      tasks: [task("ctr_domain-reviewed-c1", "R3")],
      taskIdFor: () => TASK_ID,
      entries: entries(),
      reviews: [],
      change: {
        changeId: CHANGE_ID,
        acceptance: undefined,
        approvals: undefined,
        attestations: [],
        reviews: [review()],
        deltas: undefined,
        oracles: undefined,
        taskRuns: undefined,
        release: undefined,
        evaluatedAt: "2026-08-10T00:00:00.000Z",
        verifyPin: () => "match",
        classifySource: classifier()
      }
    })
  );
  assert.equal(gate.status, "satisfied");

  // And the same predicate over a task list that derives nothing answers no.
  assert.equal(
    isDomainReviewSatisfying({
      reviews: [review()],
      changeId: CHANGE_ID,
      tasks: [task("ctr_domain-reviewed-c1", "R0")],
      taskIdFor: () => TASK_ID
    }),
    false
  );
});

test("an unreadable reviews plane is unevaluable, and is not the same sentence as an empty one", () => {
  // The fail-open this release closed one layer down. `listReviewDecisionsForChange`
  // dropped what it could not parse and reported nothing, and this is the first
  // gate with an `unsatisfied` arm that reads a review — so a rejected domain
  // review made unparseable would vanish and the gate would answer from the
  // accepted one beside it. Absence of the *set* must therefore be its own
  // sentence, distinct from a set that is genuinely empty.
  const unreadable = gateOf(derive({ reviews: undefined }));
  assert.equal(unreadable.status, "unevaluable");
  assert.match(unreadable.reason, /could not be read as a complete set/);
  assert.equal(unreadable.recovery.command, "legion ship");

  const empty = gateOf(derive({ reviews: [] }));
  assert.equal(empty.status, "unevaluable");
  assert.match(empty.reason, /No review of change chg_domain-reviewed records the domain/);
});

test("a rejected domain review is not buried by a passing architecture-review attestation", () => {
  // `combineDomainReviewOutcomes`, and its whole content is this ordering. Two
  // producers reduced by "any satisfied satisfies" would let an attestation bury a
  // recorded rejection — an OR over *producers* silently becoming an OR over
  // verdicts, which is the favourable-hides-unfavourable fail-open
  // `combineAttestationOutcomes` refuses one gate over.
  const gate = gateOf(
    derive({
      reviews: [review({ status: "rejected" })],
      attestations: [attestation()]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /was rejected/);
  assert.match(gate.reason, /does not override the verdict above/);
});

test("a clean domain review does not answer for an attestation plane that came back short", () => {
  // **The fail-open the two-producer OR put back, one layer above the one this
  // release closed.** `combineDomainReviewOutcomes` used to reduce by verdict
  // alone — unsatisfied, then satisfied, then whatever was left — which reads one
  // producer's `unevaluable` as "no claim" when it actually means "this plane may
  // hold a claim I could not read". A single `.DS_Store` under `attestations/`
  // collapses that plane, and the gate then answered `satisfied` from the review
  // beside it while the same ship payload printed "a listing that dropped a file
  // may have dropped a withdrawal". The dropped file may be the `fail`
  // architecture-review attestation the test below proves would otherwise block.
  const gate = gateOf(derive({ reviews: [review()], attestations: undefined }));

  assert.equal(gate.status, "unevaluable", "a plane in doubt must outrank the other producer's yes");
  assert.match(gate.reason, /attestations recorded for this change could not be read as a complete set/);
  assert.match(gate.reason, /answered from the half it could read/);
  // And the cure is the one that repairs *this* state. The review producer's own
  // cure — run a domain review — exits 0 here and leaves the gate blocked by a
  // plane nobody was told to correct, which is lesson 1 in its purest form.
  assert.equal(gate.recovery.command, "legion ship");
  assert.match(gate.recovery.reason, /correct or remove the file the other/);
});

test("a passing attestation does not answer for a reviews plane that came back short", () => {
  // The same crossing in the other direction, and the one an operator can reach
  // through the CLI: `legion review --domain architecture` writes into a
  // directory whose listing a junk file collapses, and an
  // `architecture-review` attestation then satisfied the gate over the top of it.
  // Substituting a *rejected* domain review for the unreadable bytes is the
  // exploitable form — the rejection is a recorded negative and corrupting it
  // must not turn the gate green.
  const gate = gateOf(derive({ reviews: undefined, attestations: [attestation()] }));

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /reviews recorded for this change could not be read as a complete set/);
  assert.match(gate.reason, /does not settle the question above/);
  assert.equal(gate.recovery.command, "legion ship");
  // Nothing is carried as a judgement either: the attestation did not decide this
  // gate, so `legion ship` must not echo it as though it had.
  assert.equal(gate.judgement, undefined);
});

test("two hand-filed attestations of one kind are not resolved by a clean domain review", () => {
  // The duplication guard exists so that "a favourable record cannot hide an
  // unfavourable one". Reduced by verdict, the caller defeated it from outside:
  // the guard's `unevaluable` lost to a satisfying review and the gate answered
  // green with no mention of either attestation, which is the guard's own
  // fail-open reached one level up.
  const gate = gateOf(
    derive({
      reviews: [review()],
      attestations: [
        attestation(),
        attestation({ id: "att_domain-reviewed-hand-filed", verdict: "fail" })
      ]
    })
  );

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /carries 2 attestations of kind architecture-review/);
  assert.match(gate.reason, /answered from the half it could read/);
  assert.equal(gate.recovery.command, "legion ship");
  assert.match(gate.recovery.reason, /Delete the ones that are not the record/);
});

test("a plane in doubt still loses to a recorded negative, in both directions", () => {
  // The other half of the ordering, and the half a blanket "unevaluable wins"
  // would have broken. A recorded `fail` is a verdict somebody wrote down; an
  // unreadable plane only *may* hold one. Reporting "unestablished" over a
  // rejection an operator can read on disk would replace a verdict that names
  // what to fix with one that names a file to tidy.
  const rejectedUnderDoubt = gateOf(
    derive({ reviews: [review({ status: "rejected" })], attestations: undefined })
  );
  assert.equal(rejectedUnderDoubt.status, "unsatisfied");
  assert.match(rejectedUnderDoubt.reason, /was rejected/);

  const failedUnderDoubt = gateOf(derive({ reviews: undefined, attestations: [attestation({ verdict: "fail" })] }));
  assert.equal(failedUnderDoubt.status, "unsatisfied");
  assert.match(failedUnderDoubt.reason, /as failed/);
});

test("a failing architecture-review attestation is not buried by a clean domain review", () => {
  // The same ordering in the other direction, because the two producers are
  // symmetric: a recorded `fail` is a statement somebody made, and a clean review
  // of the same change does not unmake it.
  const gate = gateOf(
    derive({
      reviews: [review()],
      attestations: [attestation({ verdict: "fail" })]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /as failed/);
  assert.match(gate.reason, /does not override the verdict above/);
});

test("a pin-clean pass architecture-review attestation satisfies the gate and is carried as a judgement", () => {
  // **The third admissibility state, and the reason it had to be one.** Under the
  // previous encoding `architecture-review` shared the empty-shape list with
  // `e2e-evaluation`, and both ends read that as a positive refusal — so `legion
  // attest architecture-review --verdict pass` exited 1 while `--verdict
  // not_applicable --waiver-reason <text>` satisfied the same gate. An operator
  // who genuinely held an architecture review was told to record that no
  // architecture review applied.
  //
  // What the arm gives up is asserted rather than described: nothing
  // machine-checkable is read, so the result carries a `judgement` for ship to
  // echo. A satisfied gate emits no diagnostic, so without that field this would
  // be the quietest thing in the payload.
  const gate = gateOf(derive({ reviews: [legacyReview()], attestations: [attestation()] }));

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /No report shape in this repository states a architecture-review verdict/);
  assert.equal(gate.judgement.gate, "architecture_or_security_review");
  assert.equal(gate.judgement.attestedBy, "dasbl");
  assert.deepEqual(gate.judgement.sources, [ADR.path]);
});

test("a pass architecture-review attestation by a tool is unsatisfied, not silently accepted", () => {
  // The positive re-check on the one arm with nothing falsifiable behind it. A
  // human judgement recorded by something that is not a human is not one, and an
  // unrecognised shape has to fall *out* of this arm rather than into it — which
  // is the audited waiver's own rule, applied to the arm that sits beside it.
  const gate = gateOf(
    derive({
      reviews: [legacyReview()],
      attestations: [attestation({ attestedBy: { kind: "tool", id: "legion-cli" } })]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /is a human judgement no report in this repository states/);
});

test("a pass architecture-review attestation citing a red report is refused", () => {
  // The human-judgement arm does not skip the red-report loop, and that ordering
  // is load-bearing: a pass whose cited source is a report negative by its own
  // rule would otherwise put a governance record on top of evidence saying the
  // opposite, which is exactly what the waiver arm is forbidden from doing.
  const gate = gateOf(
    derive({
      reviews: [legacyReview()],
      attestations: [attestation({ sources: [THREAT_MODEL] })],
      classifySource: classifier({
        [THREAT_MODEL.path]: {
          kind: "blocking",
          shape: "threat-model",
          enveloped: false,
          reason: "its own ok is false and it records 2 findings"
        }
      })
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /negative by its own rule/);
});

test("a domain review accepted by the human who ran the work is refused", () => {
  // **Spec (D), and the only half of it this repository can answer.** Nothing here
  // records an implementer identity that varies — `legion build` writes the
  // hard-coded literal `{kind: "tool", id: "legion-cli"}` as `claimedBy` on every
  // run of every change, and `review.reviewer` is `legion-<executor>-reviewer`, a
  // function of a flag — so a reviewer-versus-implementer distinctness check would
  // be true on every honest change and vacuously true where nothing records an
  // executor. What survives is the falsifier: it can only ever refuse, never
  // satisfy, so its vacuity is harmless. It is unreachable through the CLI and
  // reachable through a hand-written or host-written run, which is the same threat
  // model `humanApprovalStatus` already states.
  const gate = gateOf(
    derive({
      reviews: [review({ acceptedBy: { kind: "human", id: "dasbl" }, acceptedAt: EXECUTION_STARTED_AT })],
      taskRuns: [
        {
          id: "run_domain-reviewed-attempt-1",
          taskId: TASK_ID,
          startedAt: EXECUTION_STARTED_AT,
          claimedBy: { kind: "human", id: "dasbl" }
        }
      ]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /records the same person as the executor who claimed it/);

  // And the tool executor every honest change actually records does not trip it,
  // which is the half that makes the check a falsifier rather than a blanket
  // refusal.
  const honest = gateOf(
    derive({
      reviews: [review({ acceptedBy: { kind: "human", id: "dasbl" }, acceptedAt: EXECUTION_STARTED_AT })],
      taskRuns: [
        {
          id: "run_domain-reviewed-attempt-1",
          taskId: TASK_ID,
          startedAt: EXECUTION_STARTED_AT,
          claimedBy: { kind: "tool", id: "legion-cli" }
        }
      ]
    })
  );
  assert.equal(honest.status, "satisfied");
});

test("the same refusal holds on the attestation route, which is the weaker of the two", () => {
  // The falsifier was enforced on the review route and skipped on the attestation
  // one: the collision check inside `attestationRecordStatus` sits behind
  // `requireBeforeExecution`, which only `independent_baseline` passes. So the
  // route with *nothing machine-checkable behind it* was the route that did not
  // check, and an operator refused above could satisfy the same gate by asserting
  // the same thing under their own name. A refusal one producer enforces and the
  // other does not is not a refusal.
  const gate = gateOf(
    derive({
      reviews: [legacyReview()],
      attestations: [attestation()],
      taskRuns: [
        {
          id: "run_domain-reviewed-attempt-1",
          taskId: TASK_ID,
          startedAt: EXECUTION_STARTED_AT,
          claimedBy: { kind: "human", id: "dasbl" }
        }
      ]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /records the same person as the executor who claimed it/);
  assert.match(gate.reason, /nothing machine-checkable behind it/);
  // Nothing is echoed as a judgement, because no judgement was accepted.
  assert.equal(gate.judgement, undefined);
  // And the cure repairs this state: a different signature, not a rebuild and not
  // a second record under the same name.
  assert.equal(gate.recovery.command, "legion review --domain architecture");
  assert.match(gate.recovery.reason, /Attesting instead cannot substitute/);
});

test("a supersession written across tasks does not erase a rejected review of another task", () => {
  // `supersedes` is honoured only between reviews of the same task, because that
  // is the only link `legion review` can write. Read loosely, one cross-task
  // entry in a hand-written or host-written review deletes a recorded rejection:
  // the gate answered `satisfied` naming the two accepted reviews and never
  // mentioned the refusal at all — a document unmaking a verdict somebody else
  // recorded, which is the threat model the blocking-finding arm refuses an
  // accepted review for.
  const gate = gateOf(
    derive({
      tasks: [task("ctr_domain-reviewed-c1"), task("ctr_domain-reviewed-c2")],
      taskIds: [TASK_ID, OTHER_TASK_ID],
      reviews: [
        review({ id: "rev_domain-1", status: "rejected" }),
        review({ id: "rev_domain-2", taskId: OTHER_TASK_ID, supersedes: ["rev_domain-1"] }),
        review({ id: "rev_domain-3" })
      ]
    })
  );

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /Review rev_domain-1 of change chg_domain-reviewed was performed in architecture/);
  assert.match(gate.reason, /was rejected/);

  // And the supersession the CLI actually writes — same task, later review —
  // still drops the earlier verdict, or this fix would have closed the arm above
  // it as well.
  const superseded = gateOf(
    derive({
      reviews: [
        review({ id: "rev_domain-1", status: "rejected" }),
        review({ id: "rev_domain-2", supersedes: ["rev_domain-1"] })
      ]
    })
  );
  assert.equal(superseded.status, "satisfied");
});

test("a domain review about a task the change no longer derives gets its own sentence", () => {
  // The absence sentence was computed after the task filter, so it stated as fact
  // that no review of the change records a domain while one of them did — and
  // sent the operator to record a domain they had already recorded. Reached after
  // a re-plan, where the accepted architecture review is about a task id the
  // change no longer carries.
  const gate = gateOf(derive({ reviews: [review({ taskId: OTHER_TASK_ID })] }));

  assert.equal(gate.status, "unevaluable");
  assert.doesNotMatch(gate.reason, /records no domain|records the domain it was performed in/);
  assert.match(gate.reason, /is not one of the 1 task deriving architecture_or_security_review for this change/);
  assert.match(gate.reason, new RegExp(OTHER_TASK_ID));
  assert.equal(gate.recovery.command, "legion review --domain architecture");

  // The same defect one arm along, and the reason the declared-domain count is
  // taken over the change's current reviews rather than over the post-task-filter
  // set: a review that records `implementation` about a task the change no longer
  // derives is still a review that records a domain, and "no review of this change
  // records the domain it was performed in" is a false sentence about it.
  const strandedImplementation = gateOf(
    derive({ reviews: [review({ taskId: OTHER_TASK_ID, domains: ["implementation"] })] })
  );
  assert.equal(strandedImplementation.status, "unevaluable");
  assert.match(strandedImplementation.reason, /record the domain they were performed in \(implementation\)/);
});

test("the writer's predicate is the reader's own, and answers no for every unmet arm", () => {
  // **Lesson 3.** `legion review --accept` warns off this predicate, so a
  // predicate weaker than the gate would let the accept exit 0 on an R3 change
  // and leave ship blocked forever with no flag anywhere that would fix it. It
  // calls `domainReviewOutcome` against a one-plane fact set rather than
  // paraphrasing it, which is what this test holds it to: every arm the gate
  // refuses, it refuses.
  const tasks = [task()];
  const taskIdFor = () => TASK_ID;
  const ask = (reviews) => isDomainReviewSatisfying({ reviews, changeId: CHANGE_ID, tasks, taskIdFor });

  assert.equal(ask([review()]), true);
  assert.equal(ask([]), false);
  assert.equal(ask([legacyReview()]), false);
  assert.equal(ask([review({ domains: ["implementation"] })]), false);
  assert.equal(ask([review({ status: "submitted" })]), false);
  assert.equal(ask([review({ status: "rejected" })]), false);
  assert.equal(ask([review({ verdicts: { ...ALL_AXES_PASS, evidence: "unknown" } })]), false);
  assert.equal(ask([review({ changeId: OTHER_CHANGE_ID })]), false);
});

test("the schema refuses an empty domains array and a duplicated domain", () => {
  // `domains: []` is a present field asserting nothing — a claim-shaped absence,
  // over which every `some` is false and every `every` is vacuously true. Held
  // here as well as at the gate, and neither stands in for the other: this asserts
  // the schema's `.min(1)`, and the gate's own empty-set guards are asserted above
  // against fact sets the schema never sees, which is the mistake PR 6 recorded
  // under (I).
  const document = {
    schemaVersion: "0.2.0",
    createdAt: "2026-08-01T09:00:00.000Z",
    kind: "review",
    id: "rev_domain-1",
    projectId: "prj_order-router",
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    reviewer: { kind: "tool", id: "legion-fake-reviewer" },
    verdicts: ALL_AXES_PASS,
    confidence: "high",
    findings: [],
    supersedes: [],
    status: "submitted",
    submittedAt: "2026-08-01T09:00:00.000Z"
  };

  assert.equal(reviewDecisionSchema.safeParse({ ...document, domains: [] }).success, false);
  assert.equal(
    reviewDecisionSchema.safeParse({ ...document, domains: ["architecture", "architecture"] }).success,
    false
  );
  assert.equal(
    reviewDecisionSchema.safeParse({ ...document, domains: ["architecture", "security"] }).success,
    true
  );
  // And absent still parses, which is the whole reason the field is optional:
  // required, `readReviewDecision` would fail on every review already on disk and
  // `legion ship` would report a broken change rather than an older one.
  assert.equal(reviewDecisionSchema.safeParse(document).success, true);
});
