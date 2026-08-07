import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveShipGates,
  isSatisfyingAttestation,
  shipGatePinnedReferences,
  shipGateWaivers
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * The three attestation gates, arm by arm.
 *
 * `tests/ship-risk-gates` records the transcript — one cell per (scenario, tier,
 * gate) — which is what catches a verdict moving by accident. This file is the
 * other half: the arms a transcript cell cannot express, because each of them is
 * about *which sentence* and *which recovery* an unmet gate produces, and the
 * transcript records only statuses.
 *
 * Every gate here has at least five distinct unmet states, and this series' first
 * lesson is that each of them must name a repair that actually repairs that
 * state. A single table entry cannot serve five, so the verdicts carry their own
 * and these tests are what hold them to it — including the two states no command
 * repairs, where naming one would be worse than naming none.
 */

const CHANGE_ID = "chg_attested";
const TASK_ID = "tsk_attested-c1";
const OTHER_CHANGE_ID = "chg_something-else";

const THREAT_MODEL = {
  path: "docs/next/evidence/attested/threat-model.json",
  sha256: `sha256:${"a".repeat(64)}`
};
const AB_COMPARISON = {
  path: "docs/next/evidence/attested/ab-comparison.json",
  sha256: `sha256:${"b".repeat(64)}`
};
const ROLLBACK_POLICY = {
  path: "docs/next/evidence/attested/rollback-policy.json",
  sha256: `sha256:${"d".repeat(64)}`
};
const ADR = { path: "docs/adr/ADR-006-risk-gates.md", sha256: `sha256:${"c".repeat(64)}` };

const EXECUTION_STARTED_AT = "2026-08-02T09:00:00.000Z";
const BEFORE_EXECUTION_AT = "2026-08-01T09:00:00.000Z";

function task(tier = "R3") {
  return { id: "ctr_attested-c1", risk: { tier, reasons: ["test"] } };
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

const CLEAN = {
  [THREAT_MODEL.path]: { kind: "clean", shape: "threat-model", enveloped: false },
  [AB_COMPARISON.path]: { kind: "clean", shape: "ab-comparison", enveloped: false },
  [ROLLBACK_POLICY.path]: { kind: "clean", shape: "rollback-policy", enveloped: false },
  [ADR.path]: { kind: "unrecognised" }
};

function classifier(table = CLEAN) {
  return (reference) => table[reference.path] ?? { kind: "unrecognised" };
}

function attestation(overrides = {}) {
  return {
    id: "att_attested-attestation-security-evaluation",
    changeId: CHANGE_ID,
    attests: "security-evaluation",
    verdict: "pass",
    attestedBy: { kind: "human", id: "dasbl" },
    attestedAt: BEFORE_EXECUTION_AT,
    sources: [THREAT_MODEL],
    covers: [{ kind: "task", id: TASK_ID }],
    statement: "dasbl attests security-evaluation as pass.",
    ...overrides
  };
}

function gateOf(report, gate) {
  const row = report.gates.find((entry) => entry.gate === gate);
  assert.notEqual(row, undefined, `${gate} was not derived`);
  return row;
}

function derive({ attestations, taskRuns, verifyPin = () => "match", classifySource = classifier() } = {}) {
  return deriveShipGates({
    tasks: [task()],
    taskIdFor: () => TASK_ID,
    entries: entries(),
    reviews: [{ document: { id: "rev_1", status: "accepted", taskId: TASK_ID } }],
    change: {
      changeId: CHANGE_ID,
      acceptance: undefined,
      approvals: undefined,
      attestations,
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

test("an attestation belonging to another change answers for nothing", () => {
  // The scoping predicate matches on strict change-id equality, and it is
  // load-bearing rather than belt-and-braces here in a way it is not on the
  // approvals plane. An attestation cites *ordinary repository files* —
  // `docs/next/evidence/...` — which several changes can legitimately name, so a
  // record that matched loosely would let one change's security evaluation
  // satisfy another change's gate off the same threat model. That is precisely
  // the phase-keyed-artifact confusion this entity exists to make explicit.
  const report = derive({
    attestations: [attestation({ changeId: OTHER_CHANGE_ID, id: "att_elsewhere-attestation-security-evaluation" })]
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /No attestation records anyone asserting/);
  assert.match(gate.reason, new RegExp(CHANGE_ID));
});

test("a source whose bytes have drifted is unsatisfied, and the cure is the bytes rather than another attestation", () => {
  // The tampering arm, and it is the reason an attestation pins a digest at all.
  // Without the re-hash, the record would certify whatever the file said on the
  // day it was written and would keep certifying it after somebody edited the
  // file — which is the failure the pin exists to catch, inverted.
  //
  // The recovery deliberately does **not** name `legion attest`. Re-attesting
  // would re-pin whatever is on disk now and launder an out-of-band edit into the
  // very record that was supposed to catch it, which is `ORACLE_BYTES_RECOVERY`'s
  // argument one plane over.
  const report = derive({ attestations: [attestation()], verifyPin: () => "drift" });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /whose bytes have changed since the attestation was recorded/);
  assert.match(gate.reason, new RegExp(THREAT_MODEL.path));
  assert.doesNotMatch(gate.recovery.command, /legion attest/);
  assert.match(gate.recovery.reason, /Restore the file to the bytes the attestation pins/);
});

test("a source that is gone is unsatisfied; one nobody re-hashed is unevaluable", () => {
  // Three verdicts from one verifier, and the two negatives must not be spelled
  // the same way as the unknown. `missing` is evidence that exists and is
  // negative — the pin asserts the file was there. `unverified` means nobody
  // hashed it, which is the reader's problem rather than the artifact's, and
  // reporting it as `missing` would blame a file sitting right there.
  const gone = gateOf(
    derive({ attestations: [attestation()], verifyPin: () => "missing" }),
    "security_or_e2e_evaluator"
  );
  assert.equal(gone.status, "unsatisfied");
  assert.match(gone.reason, /no longer present/);

  const unchecked = gateOf(
    derive({ attestations: [attestation()], verifyPin: () => "unverified" }),
    "security_or_e2e_evaluator"
  );
  assert.equal(unchecked.status, "unevaluable");
  assert.match(unchecked.reason, /did not re-hash/);
});

test("a pass over a report that is red by its own rule is unsatisfied, whatever the record says", () => {
  // The reader half of the refusal `legion attest` applies at write time, and the
  // half that actually enforces it. `legion attest` is not the only way a JSON
  // file reaches `.legion/project/changes/<id>/attestations/`, so a gate that
  // trusted the record's own `verdict` field would certify a pass over evidence
  // saying the opposite — PR 2's writer/reader divergence in mirror image, with
  // the reader as the one that gives up.
  const report = derive({
    attestations: [attestation()],
    classifySource: classifier({
      [THREAT_MODEL.path]: {
        kind: "blocking",
        shape: "threat-model",
        enveloped: false,
        reason: "its own ok is false and it records 2 findings"
      }
    })
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /negative by its own rule/);
  assert.match(gate.reason, /ok is false/);
  // And the advice is to produce a green report, not to attest again over a red
  // one — the writer would refuse the same pass for the same reason.
  assert.match(gate.recovery.reason, /Attesting again cannot move this/);
});

test("a pass citing only a shape nothing can read a verdict from is unsatisfied, not satisfied", () => {
  // Positive checks, never negative. An unrecognised shape is not a shape that
  // passed: the record claims a machine-checkable verdict and points at a
  // sentence. Reaching `satisfied` here would make the whole plane a rubber stamp
  // with extra steps.
  const report = derive({
    attestations: [attestation({ sources: [ADR] })],
    classifySource: classifier()
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /is a sentence/);
});

test("a pass for a kind no report shape can evidence is unsatisfied and says so", () => {
  // `e2e-evaluation` has an empty admissible list, and that is the honest state
  // of this repository rather than an omission: no end-to-end report shape exists
  // here. The empty list refuses; it does not fall through.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-e2e-evaluation",
        attests: "e2e-evaluation",
        sources: [THREAT_MODEL]
      })
    ]
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /no report shape in this repository can evidence a e2e-evaluation pass/);
});

test("a covers list that leaves a deriving task out is unsatisfied", () => {
  // `covers` gets a reader in the same release that adds it. A `.min(1)` array no
  // gate reads looks like a coverage guarantee and is not — `oracle.protectedPaths`
  // is the in-tree example — so the gate requires the attestation to claim to
  // speak for every task of the change that derived it.
  const report = derive({
    attestations: [attestation({ covers: [{ kind: "task", id: "tsk_some-other-task" }] })]
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, new RegExp(`leaving ${TASK_ID} uncovered`));
});

test("verdict fail blocks and verdict unknown is unevaluable", () => {
  // Two different facts. `fail` is evidence that exists and is negative;
  // `unknown` is a record that exists and asserts nothing, which is what
  // `legion attest` writes when it refuses a pass it cannot check. Collapsing
  // `unknown` into `fail` would punish the honest answer and teach operators to
  // give the other one.
  const failed = gateOf(derive({ attestations: [attestation({ verdict: "fail" })] }), "security_or_e2e_evaluator");
  assert.equal(failed.status, "unsatisfied");

  const unknown = gateOf(
    derive({ attestations: [attestation({ verdict: "unknown" })] }),
    "security_or_e2e_evaluator"
  );
  assert.equal(unknown.status, "unevaluable");
  assert.match(unknown.reason, /asserts nothing about it/);
});

test("an audited waiver satisfies, carries a machine-readable record of itself, and says so in its own sentence", () => {
  // The one arm in these three gates that satisfies with no falsifiable evidence
  // behind it, so it is the arm that must be impossible to miss. A satisfied gate
  // emits no diagnostic at all, so without `waived` and without the sentence the
  // quietest thing in a ship payload would be the gate that was not checked.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-rollback-evidence",
        attests: "rollback-evidence",
        verdict: "not_applicable",
        sources: [ADR],
        waiverReason: "This change ships no migration and touches no persisted state."
      })
    ]
  });

  const gate = gateOf(report, "rollback_or_forward_fix_evidence");
  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /is waived for change/);
  assert.match(gate.reason, /No evidence was checked for this gate/);
  assert.match(gate.reason, /ships no migration/);

  const waivers = shipGateWaivers(report.gates);
  assert.equal(waivers.length, 1);
  assert.equal(waivers[0].gate, "rollback_or_forward_fix_evidence");
  assert.equal(waivers[0].attestedBy, "dasbl");
  assert.match(waivers[0].reason, /ships no migration/);
});

test("a waiver over a failing report of the very check being waived is refused", () => {
  // Converting a negative result into a satisfied gate with no evidence in
  // between is the one thing an audited waiver must not be able to do, and it is
  // refused at both ends: `legion attest` will not write it, and the gate will not
  // read it. Only the second of those is a defence, because the first is not the
  // only way a file reaches the plane.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-rollback-evidence",
        attests: "rollback-evidence",
        verdict: "not_applicable",
        sources: [THREAT_MODEL],
        waiverReason: "We decided this does not apply to us."
      })
    ],
    classifySource: classifier({
      [THREAT_MODEL.path]: {
        kind: "blocking",
        shape: "threat-model",
        enveloped: false,
        reason: "its own ok is false"
      }
    })
  });

  const gate = gateOf(report, "rollback_or_forward_fix_evidence");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /negative by its own rule/);
});

test("a baseline attested after execution began is unsatisfied, and no attest verb is advised", () => {
  // PR 5's unrepairable-ordering trap, reproduced for a new verb and answered the
  // same way. Nothing re-dates an attestation, so attesting again writes a *later*
  // `attestedAt` and makes this strictly worse — naming `legion attest` here would
  // be advice that exits 0 and deepens the state, which is the sharpest form of
  // this series' first lesson.
  //
  // The recovery names re-planning in the field hosts dispatch and the audited
  // waiver in the sentence, because both are real routes out and only one leaves
  // the change honest.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-independent-baseline",
        attests: "independent-baseline",
        sources: [AB_COMPARISON],
        attestedAt: EXECUTION_STARTED_AT
      })
    ],
    taskRuns: [{ id: "run_attested-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
  });

  const gate = gateOf(report, "independent_baseline");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /the same instant as/);
  assert.match(gate.reason, /A baseline captured after the run it is supposed to be independent of is not one/);
  assert.doesNotMatch(gate.recovery.command, /legion attest/);
  assert.equal(gate.recovery.command, "legion start --intake");
  assert.match(gate.recovery.reason, /--verdict not_applicable/);
});

test("a baseline attested before execution began is satisfied and states the bound on what independence means", () => {
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-independent-baseline",
        attests: "independent-baseline",
        sources: [AB_COMPARISON],
        attestedAt: BEFORE_EXECUTION_AT
      })
    ],
    taskRuns: [{ id: "run_attested-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
  });

  const gate = gateOf(report, "independent_baseline");
  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, new RegExp(BEFORE_EXECUTION_AT));
  assert.match(gate.reason, new RegExp(EXECUTION_STARTED_AT));
  // Stated rather than implied. The specification asked for an attester distinct
  // from the executor recorded in the task runs; `legion build` writes the
  // hard-coded literal `{kind: "tool", id: "legion-cli"}` on every run of every
  // change, so that check could never fail and would have shipped looking like an
  // independence guarantee. Ordering carries the claim, and the verdict says so.
  assert.match(gate.reason, /Independence here is\s+temporal/);
});

test("an unestablished or empty run plane makes the baseline unevaluable, never satisfied", () => {
  // "Attested before nothing" is the vacuous truth this series has paid for four
  // times. A change with no runs has not yet had the execution a baseline is
  // supposed to precede, and a run plane that would not read establishes nothing
  // at all — neither is a baseline that came first.
  const baseline = attestation({
    id: "att_attested-attestation-independent-baseline",
    attests: "independent-baseline",
    sources: [AB_COMPARISON]
  });

  const unreadable = gateOf(derive({ attestations: [baseline] }), "independent_baseline");
  assert.equal(unreadable.status, "unevaluable");
  assert.match(unreadable.reason, /could not be read as a complete set/);

  const noRuns = gateOf(derive({ attestations: [baseline], taskRuns: [] }), "independent_baseline");
  assert.equal(noRuns.status, "unevaluable");
  assert.match(noRuns.reason, /no task of this change has run/);
});

test("a human executor equal to the attester refuses the baseline, and can only ever refuse", () => {
  // The surviving half of the distinctness rule, kept with its bound stated. It
  // is unreachable through the CLI — every run Legion writes records
  // `{kind: "tool", id: "legion-cli"}` — and reachable through a hand-written or
  // host-written run, which is the threat model `humanApprovalStatus` already
  // states for the approvals plane.
  //
  // Its vacuity is harmless precisely because it can only refuse: an absent or
  // non-human `claimedBy` leaves the ordering clause to carry the verdict, and the
  // ordering clause is never vacuous. That asymmetry is why it survived the half
  // that was dropped.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-independent-baseline",
        attests: "independent-baseline",
        sources: [AB_COMPARISON],
        attestedAt: BEFORE_EXECUTION_AT
      })
    ],
    taskRuns: [
      {
        id: "run_attested-attempt-1",
        taskId: TASK_ID,
        startedAt: EXECUTION_STARTED_AT,
        claimedBy: { kind: "human", id: "dasbl" }
      }
    ]
  });

  const gate = gateOf(report, "independent_baseline");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /records dasbl as the executor who claimed it/);
});

test("two hand-filed attestations of one kind are unevaluable rather than answered from either", () => {
  // Legion derives an attestation's id from `(changeId, attests)` and so can never
  // write a second *of one kind*. A same-kind sibling is therefore something
  // somebody filed by hand, and answering from either would let a favourable
  // record hide an unfavourable one — which is the fail-open one-per-kind exists
  // to remove.
  const report = derive({
    attestations: [
      attestation(),
      attestation({ id: "att_attested-attestation-security-evaluation-copy", verdict: "fail" })
    ]
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /Legion writes exactly one per change per kind/);
  assert.match(gate.reason, /of kind security-evaluation/);
});

test("the two kinds one gate accepts are two records, not a duplicate", () => {
  // **The defect this test exists for, and it was reachable with two ordinary
  // commands.** `security_or_e2e_evaluator` reads `security-evaluation` OR
  // `e2e-evaluation`, and `attestationIdForKind` keys on `(changeId, attests)` —
  // so `legion attest` itself writes two distinct files that both belong to this
  // gate. The duplication guard counted them together and called them hand-filed
  // siblings, so recording the second legitimate kind collapsed a satisfied gate
  // to `unevaluable` and advised deleting a real governance record.
  //
  // Worst direction first: a recorded `fail` plus a later `not_applicable` waiver
  // of the other kind turned "1 failed" into "0 failed, 1 unprovable" — a stated
  // failure downgraded to unestablished, which is the exact inversion the
  // one-per-kind rule was written to prevent, performed by the rule itself.
  const failed = attestation({ verdict: "fail" });
  const waived = attestation({
    id: "att_attested-attestation-e2e-evaluation",
    attests: "e2e-evaluation",
    verdict: "not_applicable",
    sources: [ADR],
    waiverReason: "End-to-end coverage for this surface lives in the harness, not in this change."
  });

  for (const order of [[failed, waived], [waived, failed]]) {
    const gate = gateOf(derive({ attestations: order }), "security_or_e2e_evaluator");
    assert.equal(gate.status, "unsatisfied", "a recorded fail is not unmade by a favourable record of another kind");
    assert.match(gate.reason, /as failed/);
    assert.match(gate.reason, /do not override the one above|does not override the one above/);
  }

  // And the ordinary direction: a green security evaluation is not discarded
  // because somebody also recorded an honest `unknown` for the e2e question.
  const green = gateOf(
    derive({
      attestations: [
        attestation(),
        attestation({
          id: "att_attested-attestation-e2e-evaluation",
          attests: "e2e-evaluation",
          verdict: "unknown",
          sources: [ADR]
        })
      ]
    }),
    "security_or_e2e_evaluator"
  );
  assert.equal(green.status, "satisfied");
  assert.match(green.reason, /hash-clean/);

  // A waiver on one kind still reaches `shipGateWaivers` when the other kind is
  // merely unevaluable — the warning ship echoes must not vanish because a second
  // record exists.
  const rollbackWaiver = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-rollback-evidence",
        attests: "rollback-evidence",
        verdict: "not_applicable",
        sources: [ADR],
        waiverReason: "This change ships no migration and touches no persisted state."
      }),
      attestation({
        id: "att_attested-attestation-forward-fix-evidence",
        attests: "forward-fix-evidence",
        verdict: "unknown",
        sources: [ADR]
      })
    ]
  });
  assert.equal(gateOf(rollbackWaiver, "rollback_or_forward_fix_evidence").status, "satisfied");
  assert.equal(shipGateWaivers(rollbackWaiver.gates).length, 1);
});

test("a clean report of the wrong shape for the kind cannot pass, however green it is", () => {
  // **The per-kind admissibility matrix, which is the load-bearing half of what
  // makes these gates more than a hash check — and which survived deletion at
  // both the reader and the writer with the whole suite green.**
  //
  // `ADMISSIBLE_SOURCE_SHAPES` exists so that `legion attest rollback-evidence
  // --source threat-model.json --verdict pass` cannot satisfy the rollback gate
  // off a security report: a hash pin proves which bytes were meant, never what
  // they say, and "some recognised report is green" is not "the question this
  // gate asks was answered". Drop the `admitted.has(...)` conjunct and every
  // gate test still passed, because every other scenario cites a shape that
  // happens to be the right one.
  const report = derive({
    attestations: [
      attestation({
        id: "att_attested-attestation-rollback-evidence",
        attests: "rollback-evidence",
        sources: [THREAT_MODEL]
      })
    ]
  });

  const gate = gateOf(report, "rollback_or_forward_fix_evidence");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /none of the 1 file it cites is a rollback-policy report/);

  // The control, so this is a statement about the matrix rather than about the
  // rollback gate refusing everything: the same record citing the shape its own
  // kind admits is satisfied.
  const admitted = gateOf(
    derive({
      attestations: [
        attestation({
          id: "att_attested-attestation-rollback-evidence",
          attests: "rollback-evidence",
          sources: [ROLLBACK_POLICY]
        })
      ]
    }),
    "rollback_or_forward_fix_evidence"
  );
  assert.equal(admitted.status, "satisfied");

  // And the same asymmetry in the other direction: a clean rollback verdict is
  // not a security evaluation.
  const crossed = gateOf(
    derive({ attestations: [attestation({ sources: [ROLLBACK_POLICY] })] }),
    "security_or_e2e_evaluator"
  );
  assert.equal(crossed.status, "unsatisfied");
  assert.match(crossed.reason, /none of the 1 file it cites is a threat-model report/);
});

test("every unmet arm of independent_baseline advises the ordering-aware cure once a run exists", () => {
  // **Lesson 1, reproduced with the correct helper already present in the same
  // file.** Only the absence arm routed its recovery through
  // `orderingAwareBaselineRecovery`; seven others returned the raw `legion attest
  // independent-baseline` advice. On a change whose runs have started that advice
  // exits 0, writes a *later* `attestedAt`, and the gate's own `>=` clause then
  // reports `unsatisfied` permanently — advice that converts an unevaluable gate
  // into a failed one. `shipGateRecovery` picks the first gate's recovery in R3's
  // order and `independent_baseline` is first, so it owned `nextAction.command`
  // on every blocked R3 ship.
  //
  // Measured through the CLI at the time: ship offered the attest verb, running
  // it verbatim exited 1 for want of `--verdict`, `--verdict pass` was refused,
  // and `--verdict unknown` exited 0 and moved nothing — the exits-0-and-still-
  // blocked loop `tests/change-r3-ordering` asserts is closed.
  const taskRuns = [{ id: "run_attested-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }];
  const baseline = (overrides) =>
    attestation({
      id: "att_attested-attestation-independent-baseline",
      attests: "independent-baseline",
      sources: [AB_COMPARISON],
      attestedAt: BEFORE_EXECUTION_AT,
      ...overrides
    });

  const arms = {
    absent: [],
    unknown: [baseline({ verdict: "unknown" })],
    sourceless: [baseline({ sources: [] })],
    uncovered: [baseline({ covers: [{ kind: "task", id: "tsk_some-other-task" }] })],
    "unreadable shape": [baseline({ sources: [ADR] })],
    "waiver without a reason": [baseline({ verdict: "not_applicable" })]
  };

  for (const [name, attestations] of Object.entries(arms)) {
    const gate = gateOf(derive({ attestations, taskRuns }), "independent_baseline");
    assert.notEqual(gate.status, "satisfied", name);
    assert.doesNotMatch(gate.recovery.command, /legion attest/, name);
    assert.equal(gate.recovery.command, "legion start --intake", name);
  }

  // And the wrapper is conditional on execution, not unconditional: before any
  // run exists, attesting really is the repair and the cure says so.
  const notYetRun = gateOf(derive({ attestations: [], taskRuns: [] }), "independent_baseline");
  assert.match(notYetRun.recovery.command, /legion attest independent-baseline/);

  // The two gates with no ordering rule keep their own advice, which is why
  // `orderingAwareRecovery` is not simply widened to match `legion attest`:
  // evaluating an implemented change necessarily comes after building it.
  const evaluator = gateOf(derive({ attestations: [], taskRuns }), "security_or_e2e_evaluator");
  assert.match(evaluator.recovery.command, /legion attest security-evaluation/);
});

test("the two empty-set guards no other assertion reaches", () => {
  // **Two of the five empty-set guards this gate carries had no test**, and both
  // survive removal with the rest of the suite green. Lesson 5 is that a
  // quantifier over a possibly-empty set is vacuously true, and this series has
  // now hit that fail-open six times — so a guard whose whole purpose is to
  // refuse an empty set is exactly the code that must not be held up only by
  // another module's invariant.
  //
  // `sources` empty: `[].every(clean)` is `true`, so a record with no sources
  // would sail through the pin loop and the classify loop and reach the pass arm.
  // `attestationSchema`'s `.min(1)` makes it unreachable from a parsed document,
  // and `tests/attestations-artifact` asserts that schema rule — which is the one
  // kind of test that cannot witness this guard, because the guard exists
  // precisely so the gate does not inherit its central truth claim from the
  // schema.
  const sourceless = gateOf(
    derive({ attestations: [attestation({ sources: [] })] }),
    "security_or_e2e_evaluator"
  );
  assert.equal(sourceless.status, "unevaluable");
  assert.match(sourceless.reason, /cites no source/);

  // `deriving` empty: "this attestation covers every task that derives the gate"
  // is vacuously true when no task derives it. Unreachable through
  // `deriveShipGates`, which only emits a row for a gate some task derived — and
  // reachable through `isSatisfyingAttestation`, which `legion attest` calls with
  // the change's own task list to decide whether it has anything to write.
  assert.equal(
    isSatisfyingAttestation({
      attestation: attestation(),
      gate: "security_or_e2e_evaluator",
      kinds: ["security-evaluation", "e2e-evaluation"],
      changeId: CHANGE_ID,
      tasks: [],
      taskIdFor: () => TASK_ID,
      verifyPin: () => "match",
      classifySource: classifier()
    }),
    false,
    "an attestation covering no deriving task must not report itself as satisfying"
  );

  // The control, so this is a statement about the empty denominator rather than
  // about `isSatisfyingAttestation` never saying yes.
  assert.equal(
    isSatisfyingAttestation({
      attestation: attestation(),
      gate: "security_or_e2e_evaluator",
      kinds: ["security-evaluation", "e2e-evaluation"],
      changeId: CHANGE_ID,
      tasks: [task()],
      taskIdFor: () => TASK_ID,
      verifyPin: () => "match",
      classifySource: classifier()
    }),
    true
  );
});

test("an unreadable attestation plane is unevaluable, never satisfied", () => {
  // The all-or-nothing rule at the gate end. A dropped attestation file is as
  // likely to hold a `fail` as a `pass`, so the plane collapses to absence rather
  // than being answered from what survived.
  for (const gate of [
    "independent_baseline",
    "security_or_e2e_evaluator",
    "rollback_or_forward_fix_evidence"
  ]) {
    const row = gateOf(derive({ attestations: undefined }), gate);
    assert.equal(row.status, "unevaluable", gate);
    assert.match(row.reason, /could not be read as a complete set/, gate);
  }
});

test("attestation sources are a pinned-reference family the collector actually gathers", () => {
  // Forgetting a family in `shipGatePinnedReferences` fails silently, permanently,
  // and in the direction of looking correct: every source answers `unverified`,
  // every gate reports `unevaluable`, and `unevaluable` is indistinguishable at
  // the readiness arithmetic from "nothing declared this".
  //
  // The file records that a claimed end-to-end tripwire for this could not trip,
  // because two families shared a path. So this asserts one family at a time
  // against a path no other family in the tree uses.
  const references = shipGatePinnedReferences({
    deltas: undefined,
    oracles: undefined,
    approvals: undefined,
    attestations: [attestation({ sources: [THREAT_MODEL, AB_COMPARISON] })],
    tasks: []
  });
  assert.deepEqual(
    references.map((reference) => reference.path).sort(),
    [AB_COMPARISON.path, THREAT_MODEL.path].sort()
  );

  // And an absent plane contributes nothing rather than throwing.
  assert.deepEqual(
    shipGatePinnedReferences({
      deltas: undefined,
      oracles: undefined,
      approvals: undefined,
      attestations: undefined,
      tasks: []
    }),
    []
  );
});

test("facts without a callable source classifier get one that answers unread", () => {
  // The runtime guard, on `verifyPin`'s rule and for its reason: a hand-written
  // fixture can supply facts without a classifier, and a gate would then throw
  // `TypeError: change.classifySource is not a function` out of the one command
  // whose entire job is honest reporting.
  //
  // `unread` and not `unrecognised`: "nobody collected these bytes" is a different
  // fact from "these bytes are in no shape I know". Both refuse a pass, so the
  // substitution cannot fail open either way.
  const report = deriveShipGates({
    tasks: [task()],
    taskIdFor: () => TASK_ID,
    entries: entries(),
    reviews: [{ document: { id: "rev_1", status: "accepted", taskId: TASK_ID } }],
    change: {
      changeId: CHANGE_ID,
      attestations: [attestation()],
      verifyPin: () => "match"
    }
  });

  const gate = gateOf(report, "security_or_e2e_evaluator");
  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /is a sentence/);
});
