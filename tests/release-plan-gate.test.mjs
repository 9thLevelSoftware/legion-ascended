import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseEnvironmentSchema, releaseStatusSchema } from "../packages/protocol/dist/index.js";

import {
  deriveShipGates,
  isSatisfyingReleasePlan,
  releasePlanShortfall,
  releaseRecordsNegative,
  shipGateWaivers
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `release_observation_plan`, arm by arm.
 *
 * **Named for the plan rather than for the observation, deliberately**, because
 * three things in this repository carry the words "release observation" and one
 * of them already has a test file: `tests/review-observation-gate` is about
 * `legion review`, `legion dev board release-observation` is a post-deployment
 * report on the board plane, and this is the pre-release plan on the control
 * plane. A file named for the words rather than the mechanism would be the fourth
 * thing to confuse.
 *
 * **Every assertion here reads the sentence and not only the status.** Before this
 * release the gate answered `unevaluable` for every input whatsoever, so a
 * status-only assertion on any `unevaluable` arm passes against a build that
 * checks nothing — which is the lesson the domain-review gate's first draft paid
 * for. Each test names the defect it exists for, and each one is a state some
 * document a hand or a host can write would produce.
 */

const CHANGE_ID = "chg_release-gate";
const TASK_ID = "tsk_release-gate-c1";
const OTHER_TASK_ID = "tsk_release-gate-c2";
const TASKGRAPH_PATH = `.legion/project/changes/${CHANGE_ID}/taskgraph.json`;
const WAIVER_BASIS = { path: "docs/adr/ADR-006-risk-gates.md", sha256: `sha256:${"1".repeat(64)}` };

function plan(overrides = {}) {
  return {
    id: "rel_release-gate-release",
    changeId: CHANGE_ID,
    status: "requested",
    environment: "staging",
    releaseIntent: { path: TASKGRAPH_PATH, sha256: `sha256:${"e".repeat(64)}` },
    taskRefs: [TASK_ID],
    approvalRefs: [],
    evidenceRefs: [],
    healthCriteria: ["p99 quote latency stays under 400ms for 30 minutes"],
    rollbackPlan: {
      strategy: "revert",
      criteria: ["quote error rate exceeds 1% over any 5 minute window"],
      evidenceRefs: []
    },
    ...overrides
  };
}

function waiver(overrides = {}) {
  return {
    id: "att_release-gate-attestation-release-observation",
    changeId: CHANGE_ID,
    attests: "release-observation",
    verdict: "not_applicable",
    attestedBy: { kind: "human", id: "dasbl" },
    attestedAt: "2026-08-01T18:00:00.000Z",
    sources: [WAIVER_BASIS],
    covers: [{ kind: "task", id: TASK_ID }],
    statement: "dasbl attests release-observation as not applicable.",
    waiverReason: "This change ships documentation only and deploys nothing.",
    ...overrides
  };
}

/**
 * The gate's verdict for one release fact and one attestation plane.
 *
 * Driven through `deriveShipGates` rather than through an internal helper, so
 * that everything asserted here is what `legion ship` would print — including the
 * scope collapse and the subject id, which are applied outside the gate.
 */
function gate(options = {}) {
  const release = options.release;
  // `"attestations" in options` rather than a destructuring default, because an
  // explicit `undefined` is the fact `legion ship` passes when
  // `completeAttestations` refuses a partial listing — and a default would turn
  // that into an empty plane, which is the opposite claim.
  const attestations = "attestations" in options ? options.attestations : [];
  const tasks = options.tasks ?? [{ id: "ctr_c1" }];
  const taskIdFor = (task) => (task.id === "ctr_c1" ? TASK_ID : OTHER_TASK_ID);
  const report = deriveShipGates({
    tasks: tasks.map((task) => ({ ...task, risk: { tier: "R3", reasons: ["fixture"] } })),
    taskIdFor,
    entries: [],
    reviews: [],
    change: {
      changeId: CHANGE_ID,
      release,
      attestations,
      verifyPin: () => "match",
      classifySource: () => ({ kind: "unrecognised" })
    }
  });
  return report.gates.find((entry) => entry.gate === "release_observation_plan");
}

test("a plan covering every deriving task satisfies the gate, and says what it checked", () => {
  // The defect: a gate that reported `satisfied` without reading the document
  // would be indistinguishable, at the status, from the producerless arm this
  // release retires. The sentence is what makes the difference falsifiable — it
  // names the environment, both criterion counts, the strategy and the coverage
  // denominator, so a gate that stopped reading any of them reddens here.
  const verdict = gate({ release: { kind: "document", document: plan() } });
  assert.equal(verdict.status, "satisfied");
  assert.match(verdict.reason, /observes it in staging/);
  assert.match(verdict.reason, /1 health criterion/);
  assert.match(verdict.reason, /a revert rollback plan with 1 criterion/);
  assert.match(verdict.reason, /coverage of all 1 task that derive release_observation_plan/);
  // And it says what it is not, because "release observation" names three things
  // in this repository and only one of them is checkable before the release.
  assert.match(verdict.reason, /This is a plan and not an observation/);
  // Change-scoped: one answer for the change, named as the change.
  assert.equal(verdict.scope, "change");
  assert.equal(verdict.subjectId, CHANGE_ID);
});

test("a plan that observes only part of the change is unsatisfied, naming what it left out", () => {
  // **Lesson 5, in the direction the specification names.** The coverage
  // quantifier is `every deriving task is in taskRefs`, and a plan covering one of
  // two tasks passes any check written as "taskRefs is non-empty". `unsatisfied`
  // rather than `unevaluable`: somebody wrote a plan and it does not cover the
  // change, which is a recorded failure to answer rather than the absence of a
  // record.
  const verdict = gate({
    release: { kind: "document", document: plan() },
    tasks: [{ id: "ctr_c1" }, { id: "ctr_c2" }]
  });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, new RegExp(`leaving ${OTHER_TASK_ID} uncovered`));
  assert.match(verdict.reason, /derived by 2 tasks of this change/);
});

test("a plan naming no task at all is unsatisfied, not vacuously satisfying", () => {
  // **Lesson 5, in the direction the schema leaves open.** `taskRefs` is a plain
  // `z.array(taskIdSchema)` with no `.min(1)`, so `taskRefs: []` parses — and the
  // uncovered computation over an empty `covered` set would still find the
  // deriving task, which is why this arm exists as its own positive check with its
  // own sentence rather than as a special case of partial coverage.
  const verdict = gate({ release: { kind: "document", document: plan({ taskRefs: [] }) } });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /names no task at all/);
  assert.match(verdict.reason, /observes none of this change/);
});

test("a plan with no health criterion is unsatisfied, because it observes nothing", () => {
  // **Lesson 5, in the direction the approved plan for this release got wrong.**
  // That plan asserted `releaseSchema` already required `healthCriteria`; it does
  // not — only `rollbackPlan.criteria` is `.min(1)`. A gate written trusting the
  // schema would be satisfied by a plan that watches nothing, and nothing anywhere
  // would fail.
  const verdict = gate({ release: { kind: "document", document: plan({ healthCriteria: [] }) } });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /names no health criterion/);
  assert.match(verdict.reason, /plans a release nothing would be observed against/);
});

test("a plan whose rollback has no criterion is unsatisfied even though the schema forbids it", () => {
  // The defect: a gate that inherited this from `releaseRollbackPlanSchema`'s
  // `.min(1)` would be one schema edit away from a vacuous quantifier, and this
  // function's parameter type admits the empty array whatever the schema says.
  // `attestationGateStatus` keeps its `sources.length === 0` guard for the same
  // reason: a gate must not inherit its central truth claim from another module's
  // invariant.
  const verdict = gate({
    release: {
      kind: "document",
      document: plan({ rollbackPlan: { strategy: "disable", criteria: [], evidenceRefs: [] } })
    }
  });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /declares a disable rollback strategy and no criterion that would trigger it/);
});

test("every release status is classified positively, and only four of the nine satisfy", () => {
  // **Lesson 4, and the reason the classification is a total record rather than a
  // filter.** The specification named `failed` and `rollback_required` as
  // blocking. Written as `status !== "failed" && status !== "rollback_required"`,
  // the other three non-current statuses — `rolled_back`, `forward_fix_required`
  // and `superseded` — fall into the satisfied arm, and a change whose release has
  // already been rolled back would ship green. Every status is asserted here, so
  // that a tenth added upstream cannot be absorbed silently by a default.
  const expected = {
    requested: "satisfied",
    staging: "satisfied",
    deployed: "satisfied",
    healthy: "satisfied",
    failed: "unsatisfied",
    rollback_required: "unsatisfied",
    rolled_back: "unsatisfied",
    forward_fix_required: "unsatisfied",
    superseded: "unevaluable"
  };
  const extra = {
    rolled_back: { rollbackEvidenceRefs: ["evd_release-gate-rollback"] },
    forward_fix_required: {
      forwardFixPlan: {
        owner: { kind: "human", id: "dasbl" },
        criteria: ["the pricing contract test passes against the live service"],
        taskRefs: [TASK_ID]
      }
    }
  };
  // **Derived from the protocol enum rather than transcribed beside it.** The
  // paragraph above claims a tenth status cannot be absorbed silently; iterating a
  // hand-written map cannot hold that claim, because the compile-time
  // `Record<ReleaseStatus, ReleaseStanding>` forces an entry to *exist* and cannot
  // check that it is the right one. This is the same idiom PR 5 used for the
  // producerless gate set and PR 6 for the unread attestation kinds.
  assert.deepEqual(
    releaseStatusSchema.options.slice().sort(),
    Object.keys(expected).sort(),
    "a status added upstream must be classified here rather than absorbed by this loop"
  );
  for (const [status, want] of Object.entries(expected)) {
    const verdict = gate({
      release: { kind: "document", document: plan({ status, ...(extra[status] ?? {}) }) }
    });
    assert.equal(verdict.status, want, `${status} -> ${verdict.status}: ${verdict.reason}`);
  }

  // And the three non-`current` families say three different things, because they
  // are three different facts with three different repairs.
  assert.match(gate({ release: { kind: "document", document: plan({ status: "failed" }) } }).reason, /recorded negative/);
  assert.match(
    gate({ release: { kind: "document", document: plan({ status: "rolled_back", ...extra.rolled_back }) } }).reason,
    /already been taken back or needs a forward fix/
  );
  assert.match(
    gate({ release: { kind: "document", document: plan({ status: "superseded" }) } }).reason,
    /it is not the current plan, and there is no current plan to read/
  );
});

test("the cure for a failed or taken-back release is not the command that would erase it", () => {
  // **The defect, measured on the real CLI before this test existed.** These four
  // statuses printed `RELEASE_REPLAN_RECOVERY`, which `shipGateRecovery` promotes
  // to `nextAction.command` — and running exactly `legion release plan
  // --environment <env> --health-criterion <text>` over a `rolled_back` release
  // wrote a fresh `status: "requested"` document, dropped the
  // `rollbackEvidenceRefs` the schema had required for that status, and returned
  // `legion ship` to `status: "ready"` with ten satisfied gates, `waivedGates: []`
  // and no warning. The cure the gate printed laundered the negative it was
  // printed about, which is lesson 1 inverted: advice that changes the state by
  // erasing the fact.
  //
  // Both halves are held: the recovery here, and `legion release plan`'s refusal
  // in tests/cli-release-plan. Either alone leaves the route open — a recovery
  // nobody follows still names a command that works, and a refusal is no use if
  // ship keeps advertising the command that hits it.
  const extra = {
    rolled_back: { rollbackEvidenceRefs: ["evd_release-gate-rollback"] },
    forward_fix_required: {
      forwardFixPlan: {
        owner: { kind: "human", id: "dasbl" },
        criteria: ["the pricing contract test passes against the live service"],
        taskRefs: [TASK_ID]
      }
    }
  };
  for (const status of ["failed", "rollback_required", "rolled_back", "forward_fix_required"]) {
    const verdict = gate({
      release: { kind: "document", document: plan({ status, ...(extra[status] ?? {}) }) }
    });
    assert.equal(verdict.status, "unsatisfied", status);
    assert.doesNotMatch(
      verdict.recovery.command,
      /release plan/,
      `${status}: the advertised cure must not be the command that overwrites this record`
    );
    assert.equal(verdict.recovery.command, "legion ship", status);
    assert.match(verdict.recovery.reason, /refuses to overwrite a release at one of those statuses/);
    assert.match(verdict.recovery.reason, /belongs in a new change/);
    // And the sentence names the by-hand route too, because a record that is
    // itself wrong is repaired by an edit no verb performs.
    assert.match(verdict.recovery.reason, /correct or remove the release\.json/);
  }

  // The classification the writer refuses on is the gate's own, exported rather
  // than restated: a status list beside `legion release plan` is one enum member
  // away from a verb that quietly replaces a rolled-back release.
  assert.equal(releaseRecordsNegative(plan({ status: "failed" })), true);
  assert.equal(releaseRecordsNegative(plan({ status: "rollback_required" })), true);
  assert.equal(releaseRecordsNegative(plan({ status: "rolled_back", ...extra.rolled_back })), true);
  assert.equal(releaseRecordsNegative(plan({ status: "forward_fix_required", ...extra.forward_fix_required })), true);
  // `superseded` is deliberately not one: the gate calls it an absence, and
  // writing the current plan over it is the repair rather than a laundering.
  assert.equal(releaseRecordsNegative(plan({ status: "superseded" })), false);
  assert.equal(releaseRecordsNegative(plan()), false);
});

test("every release environment is classified, and only the two a release happens in satisfy", () => {
  // **The defect, measured end to end on the R3 milestone fixture.** `environment`
  // was read only to be quoted in the satisfied sentence. `legion release plan
  // --environment local --rollback-strategy manual --health-criterion "someone
  // will probably notice" --rollback-criterion "we change our minds"` exited 0
  // with no warning, and `legion ship` then reported `status: "ready"` with ten
  // satisfied gates, `waivedGates: []` and `humanJudgementGates: []` — a route
  // into an R3 gate that needs no named human, no waiver reason and no waiver
  // entry, which is strictly weaker than the audited `not_applicable` attestation
  // the design made the only other way in. Nothing reddened, because every fixture
  // in this file pinned `environment: "staging"`.
  //
  // `status` on the same document is a total record for exactly this reason. This
  // asserts the same totality for the other classified field, and derives the set
  // from the protocol so a fifth environment cannot be absorbed by this loop.
  const expected = { local: "unsatisfied", test: "unsatisfied", staging: "satisfied", production: "satisfied" };
  assert.deepEqual(
    releaseEnvironmentSchema.options.slice().sort(),
    Object.keys(expected).sort(),
    "an environment added upstream must be classified here rather than absorbed by this loop"
  );
  for (const [environment, want] of Object.entries(expected)) {
    const verdict = gate({ release: { kind: "document", document: plan({ environment }) } });
    assert.equal(verdict.status, want, `${environment} -> ${verdict.status}: ${verdict.reason}`);
  }

  const local = gate({ release: { kind: "document", document: plan({ environment: "local" }) } });
  assert.match(local.reason, /names local as the environment it observes/);
  assert.match(local.reason, /it is where the work runs rather than where this change reaches anything/);
  // The waiver is named, because an operator whose change reaches no released
  // environment has an audited route out and re-planning is not it.
  assert.match(local.reason, /legion attest release-observation --verdict not_applicable/);
  // And the cure names the two environments that satisfy rather than repeating
  // `--environment <env>`, which the operator would fill in the same way twice.
  assert.equal(local.recovery.command, "legion release plan --environment <staging|production>");
  assert.match(local.recovery.reason, /plans the work rather than the release of it/);

  // The writer's predicate moves with it, so the verb cannot report "already
  // planned" over a plan the gate refuses for this reason either.
  const tasks = [{ id: "ctr_c1", risk: { tier: "R3", reasons: ["fixture"] } }];
  assert.equal(
    isSatisfyingReleasePlan({ release: plan({ environment: "test" }), changeId: CHANGE_ID, tasks, taskIdFor: () => TASK_ID }),
    false
  );
});

test("the shortfall the writer warns with is the gate's own sentence, not a paraphrase", () => {
  // The defect this closes is a warning that mispredicts the gate. `legion release
  // plan` used to tell the operator "ship will report it unsatisfied" from a
  // coverage computation of its own, over every task of the change rather than
  // over the tasks that derive the gate — so on a mixed-tier task graph the
  // command promised a verdict the gate would not give. The sentence now comes
  // from the reader, and this asserts the identity rather than the shape.
  const tasks = [
    { id: "ctr_c1", risk: { tier: "R3", reasons: ["fixture"] } },
    { id: "ctr_c2", risk: { tier: "R3", reasons: ["fixture"] } }
  ];
  const taskIdFor = (task) => (task.id === "ctr_c1" ? TASK_ID : OTHER_TASK_ID);
  const partial = plan();
  const shortfall = releasePlanShortfall({ release: partial, changeId: CHANGE_ID, tasks, taskIdFor });
  const verdict = gate({ release: { kind: "document", document: partial }, tasks: [{ id: "ctr_c1" }, { id: "ctr_c2" }] });
  assert.equal(shortfall, verdict.reason, "the writer's sentence and the reader's verdict are one string");
  assert.equal(
    releasePlanShortfall({ release: plan(), changeId: CHANGE_ID, tasks: [tasks[0]], taskIdFor }),
    undefined,
    "a plan the gate accepts has no shortfall to warn about"
  );
});

test("a plan planned against something other than the change's task graph is unsatisfied", () => {
  // The defect: `releaseIntent` is a required field that nothing read, and a
  // required field nothing reads is a field a hand-written document can point
  // anywhere. The plan's `taskRefs` are only meaningful relative to the document
  // that says which tasks exist, so this is the gate's self-consistency check —
  // and it is a *path* comparison rather than a byte pin, because
  // `legion review --accept` re-points `taskgraph.json` and a digest would drift
  // during an accept that changed no task.
  const verdict = gate({
    release: {
      kind: "document",
      document: plan({
        releaseIntent: { path: `.legion/project/changes/${CHANGE_ID}/change.yaml`, sha256: `sha256:${"c".repeat(64)}` }
      })
    }
  });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /as the release intent it was planned against/);
  assert.match(verdict.reason, new RegExp(TASKGRAPH_PATH.replace(/\./g, "\\.")));
});

test("a plan about another change does not answer for this one", () => {
  // The defect: a `release.json` copied between change directories. The service
  // refuses it too, and both checks are positive because either alone is one
  // deletion away from a gate satisfied by a document nobody wrote for the change
  // being shipped.
  const verdict = gate({
    release: { kind: "document", document: plan({ changeId: "chg_release-gate-elsewhere" }) }
  });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /names change chg_release-gate-elsewhere rather than/);
});

test("no plan at all is unevaluable and names the verb that writes one", () => {
  // The defect: an absent plan reported as anything but `unevaluable` would be
  // PR 0's invariant broken — an absent fact must never read as a positive — and
  // an absent plan with no recovery is what made a blocked R3 ship advise
  // `legion build` on a change already built.
  const verdict = gate({ release: { kind: "absent" } });
  assert.equal(verdict.status, "unevaluable");
  assert.match(verdict.reason, /No release plan is recorded for change chg_release-gate/);
  assert.equal(verdict.recovery.command, "legion release plan --environment <env>");
  assert.match(verdict.recovery.reason, /no build produces that/);
  // The waiver is named in the sentence rather than in the command: both are real
  // routes out and only one leaves the change carrying a checkable document.
  assert.match(verdict.recovery.reason, /legion attest release-observation --verdict not_applicable/);
});

test("a release.json that will not read is unevaluable, and its recovery is not the writer", () => {
  // The defect: collapsing "no plan" and "a plan that will not parse" into one
  // fact. Both are `unevaluable`, so no verdict moves — but the second may be the
  // document recording a `failed` release, and its repair is correcting a file
  // rather than writing a new plan over the top of it.
  const verdict = gate({
    release: { kind: "unreadable", path: `.legion/project/changes/${CHANGE_ID}/release.json` }
  });
  assert.equal(verdict.status, "unevaluable");
  assert.match(verdict.reason, /could not be read as a release plan/);
  assert.match(verdict.reason, /whether the one it carries records a failed release — is unestablished/);
  assert.equal(verdict.recovery.command, "legion ship");
  assert.match(verdict.recovery.reason, /refuses to overwrite an unread record/);
});

test("an audited waiver satisfies the gate and is carried out as a waiver, not as evidence", () => {
  // The defect: the second producer. A gate that satisfied on the waiver without
  // setting `waived` would emit no diagnostic at all — a satisfied gate is silent
  // — so the one arm with nothing falsifiable behind it would be the quietest
  // thing in a ready payload. `shipGateWaivers` is how `legion ship` echoes it on
  // all five of its surfaces.
  const verdict = gate({ release: { kind: "absent" }, attestations: [waiver()] });
  assert.equal(verdict.status, "satisfied");
  assert.match(verdict.reason, /is waived for change chg_release-gate by dasbl \(human\)/);
  assert.match(verdict.reason, /No evidence was checked for this gate/);

  const report = deriveShipGates({
    tasks: [{ id: "ctr_c1", risk: { tier: "R3", reasons: ["fixture"] } }],
    taskIdFor: () => TASK_ID,
    entries: [],
    reviews: [],
    change: {
      changeId: CHANGE_ID,
      release: { kind: "absent" },
      attestations: [waiver()],
      verifyPin: () => "match",
      classifySource: () => ({ kind: "unrecognised" })
    }
  });
  const waivers = shipGateWaivers(report.gates);
  assert.equal(waivers.length, 1);
  assert.equal(waivers[0].gate, "release_observation_plan");
  assert.equal(waivers[0].attests, "release-observation");
  assert.equal(waivers[0].attestedBy, "dasbl");
});

test("a waiver that is not audited does not satisfy the gate", () => {
  // The defect: `not_applicable` is the one route into this gate with no
  // machine-checkable evidence behind it, so the two things that make it an
  // *audited* waiver — a human attester and a recorded reason — are checked
  // positively rather than inherited from the schema. A tool-written waiver
  // satisfying this gate would let a program waive a gate about a release.
  const noHuman = gate({
    release: { kind: "absent" },
    attestations: [waiver({ attestedBy: { kind: "tool", id: "legion-cli" } })]
  });
  assert.equal(noHuman.status, "unsatisfied");
  assert.match(noHuman.reason, /a waiver requires a human attester and a recorded reason/);

  const noReason = gate({
    release: { kind: "absent" },
    attestations: [waiver({ waiverReason: undefined })]
  });
  assert.equal(noReason.status, "unsatisfied");
});

test("a recorded fail blocks the gate even beside a plan that would satisfy it", () => {
  // **The two-producer ordering, in the direction that matters most.** An OR over
  // two producers must not become an OR over verdicts: somebody recorded a `fail`
  // about this change's release observation, and a plan written afterwards does
  // not unmake it. Reachable through the CLI — `legion attest release-observation
  // --verdict fail` is accepted, because recording a negative is never refused.
  const verdict = gate({
    release: { kind: "document", document: plan() },
    attestations: [waiver({ verdict: "fail", waiverReason: undefined, statement: "the canary plan was never run" })]
  });
  assert.equal(verdict.status, "unsatisfied");
  assert.match(verdict.reason, /as failed/);
  assert.match(verdict.reason, /This change also carries a favourable release observation plan/);
  assert.match(verdict.reason, /does not override the verdict above/);
});

test("an attestation plane that came back short is not answered around by a satisfying plan", () => {
  // **The fail-open PR 7 closed for the other two-producer gate, reproduced here
  // before it could be reintroduced.** Reducing two producers by verdict lets one
  // producer's `satisfied` answer for the other producer's *silence* — and the
  // silence of a plane that came back short is not the absence of a claim. A
  // single `.DS_Store` under `attestations/` collapses that plane, and the dropped
  // listing may have held the `fail` the test above shows would block.
  //
  // `attestations: undefined` is exactly what `legion ship` passes when
  // `completeAttestations` refuses a partial listing.
  const verdict = gate({ release: { kind: "document", document: plan() }, attestations: undefined });
  assert.equal(verdict.status, "unevaluable");
  assert.match(verdict.reason, /could not be read as a complete set/);
  assert.match(verdict.reason, /This change also carries a favourable release observation plan/);
  assert.match(verdict.reason, /does not settle the question above/);
  // And the recovery names the plane, not the writer: `legion release plan` would
  // exit 0, report the plan already recorded, and leave the gate blocked by a
  // plane nobody was told to repair.
  assert.equal(verdict.recovery.command, "legion ship");
});

test("an unreadable release.json is not answered around by an audited waiver", () => {
  // **The other half of the two-producer ordering, and the one that only this
  // gate has.** The attestation plane can be in doubt, and so can the release
  // plane: a `release.json` that will not parse may be the one recording a
  // `failed` release. Without `concealsNegative` on that arm, a waiver sitting
  // beside it answers `satisfied` and the gate certifies that the change deploys
  // nothing while a document saying its release failed sits unread in the same
  // directory.
  const verdict = gate({
    release: { kind: "unreadable", path: `.legion/project/changes/${CHANGE_ID}/release.json` },
    attestations: [waiver()]
  });
  assert.equal(verdict.status, "unevaluable");
  assert.match(verdict.reason, /could not be read as a release plan/);
  assert.match(verdict.reason, /This change also carries a favourable release-observation attestation/);
  assert.match(verdict.reason, /does not settle the question above/);
  // And the advice names the file rather than the waiver, because the waiver is
  // already there and repeating it would leave the gate blocked by a document
  // nobody was told to correct.
  assert.equal(verdict.recovery.command, "legion ship");
});

test("a release plane nobody read is unevaluable, and it conceals a negative too", () => {
  // The symmetric case: `change.release` is `undefined`, which in production can
  // only mean nobody called `loadReleaseFact`. It must never read as absence,
  // because absence is a claim about the plane and this is a claim about the
  // reader — and what is actually in the file may be a `failed` release.
  const verdict = gate({ release: undefined });
  assert.equal(verdict.status, "unevaluable");
  assert.match(verdict.reason, /was not read/);
  assert.equal(verdict.recovery.command, "legion ship");

  // **The half this test was named for and did not assert, measured as an escaping
  // mutant: deleting `concealsNegative: true` from this arm reddened nothing in
  // the tree.** The flag is observable only beside a *satisfying* second producer,
  // because that is the only input whose verdict it changes — without it, a host
  // or future caller that derives gates without `loadReleaseFact` gets
  // `release_observation_plan` answered `satisfied` from a `not_applicable` waiver
  // while the release plane, which may hold the `failed` release, was never
  // consulted. The sibling `unreadable` arm has this test; this one had its title.
  const beside = gate({ release: undefined, attestations: [waiver()] });
  assert.equal(beside.status, "unevaluable", "a waiver must not answer for a plane nobody read");
  assert.match(beside.reason, /was not read/);
  assert.match(beside.reason, /This change also carries a favourable release-observation attestation/);
  assert.match(beside.reason, /does not settle the question above/);
  assert.equal(
    shipGateWaivers([beside]).length,
    0,
    "and it is not carried out as a waiver either, because no gate was waived"
  );
});

test("a change with no deriving task is unevaluable rather than vacuously satisfied", () => {
  // **Lesson 5 in the third direction.** "The plan covers every deriving task"
  // over an empty denominator is vacuously true, so a plan on a change no task of
  // which derives the gate would otherwise report `satisfied`. Driven through the
  // gate's own helper rather than through `deriveShipGates`, because a tier that
  // does not derive the gate emits no row at all — the arm is reachable only from
  // a mixed report, and `isSatisfyingReleasePlan` is the caller that can reach it.
  assert.equal(
    isSatisfyingReleasePlan({
      release: plan(),
      changeId: CHANGE_ID,
      tasks: [{ id: "ctr_c1", risk: { tier: "R1", reasons: ["fixture"] } }],
      taskIdFor: () => TASK_ID
    }),
    false,
    "an empty denominator must not make the predicate say yes"
  );
});

test("the writer's predicate is the gate's own, and refuses everything the gate refuses", () => {
  // **Lesson 3, and the thing PR 8 measured going unprotected.** `legion release
  // plan` computes "nothing to record" from this predicate; replacing the call
  // with `existing.ok` would make the command report "already planned" over a plan
  // with no health criterion, over one covering half the change, and over one
  // whose status records a failed release — exiting 0, writing nothing, and
  // leaving ship blocked forever with no flag that would make it write.
  const tasks = [{ id: "ctr_c1", risk: { tier: "R3", reasons: ["fixture"] } }];
  const taskIdFor = () => TASK_ID;
  const ask = (release) => isSatisfyingReleasePlan({ release, changeId: CHANGE_ID, tasks, taskIdFor });

  assert.equal(ask(plan()), true);
  assert.equal(ask(plan({ healthCriteria: [] })), false);
  assert.equal(ask(plan({ taskRefs: [] })), false);
  assert.equal(ask(plan({ status: "failed" })), false);
  assert.equal(ask(plan({ status: "superseded" })), false);
  assert.equal(ask(plan({ rollbackPlan: { strategy: "revert", criteria: [], evidenceRefs: [] } })), false);
  assert.equal(ask(plan({ changeId: "chg_release-gate-elsewhere" })), false);

  // And the one deliberate narrowing: the attestation plane is not consulted, so
  // an existing waiver can never make the verb report "already planned" and refuse
  // to write the plan the operator asked for. Asserted by the shape of the input —
  // there is nowhere to pass an attestation — plus the fact that a change whose
  // waiver satisfies the gate still gets `false` for a plan the gate would refuse.
  assert.equal(ask(plan({ healthCriteria: [] })), false);
});
