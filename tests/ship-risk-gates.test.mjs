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

test("no gate answers from evaluateGate's producerless arm, and the counts still add up", () => {
  // **The retirement its predecessor's comment asked for.** That test named one
  // gate that fell through `evaluateGate`'s `default:` arm and asserted it said
  // so rather than passing, and it had been re-pointed five times as each gate
  // gained a producer: `protected_oracle`, then
  // `whole_change_acceptance_evidence`, then `independent_baseline`, then
  // `architecture_or_security_review`, then `protected_acceptance_tests`.
  // `release_observation_plan` was the last one left and gains a producer in this
  // release, so there is no sixth gate to re-point at — and re-pointing at a gate
  // that *has* a producer would make the assertion vacuous.
  //
  // What replaces it is the claim in the other direction, which is the one that
  // can still fail: **no** gate at any tier answers from that arm. The reason
  // string is matched exactly, as `tests/change-r3-ordering` matches it, so a
  // gate that silently regresses to the arm reddens here without anybody having
  // touched this file.
  const producerless = [];
  for (const tier of ["R0", "R1", "R2", "R3"]) {
    const report = derive({ tier, ...PASSING_R2 });
    for (const gate of report.gates) {
      if (gate.reason === "Legion does not yet produce evidence for this gate.") producerless.push(gate.gate);
    }
    // The counting arithmetic, preserved from the retired test: every gate lands
    // in exactly one bucket, so a gap is visible on every ship rather than
    // absorbed into the satisfied total.
    assert.equal(report.satisfied + report.unsatisfied + report.unevaluable, report.gates.length, tier);
  }
  assert.deepEqual([...new Set(producerless)], []);

  // And an R3 change with no facts is still blocked — by gates that name what is
  // missing, rather than by an arm that says Legion cannot answer at all.
  const r3 = derive({ tier: "R3", ...PASSING_R2 });
  assert.ok(r3.unevaluable > 0);
  assert.equal(r3.ready, false);
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
  // execution. A post-execution test verdict cannot answer it: an oracle that
  // held is not an oracle anybody agreed to, and it says nothing at all about
  // when the agreeing happened. Satisfying it from the oracle result would claim
  // a governance gate was met when no such approval exists.
  //
  // The claim is unchanged from the release before this one; what changed is why
  // it holds. It used to hold because the gate fell through `evaluateGate`'s
  // `default:` arm and answered "Legion does not yet produce evidence for this
  // gate" about everything. It now holds because the gate looked and found no
  // approval plane — so the assertion on that literal reason string is gone, and
  // the `if (gate !== undefined)` guard with it: at R3 the gate is always
  // derived, and a guard that skipped the body would have made this test pass by
  // asserting nothing.
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
  assert.notEqual(gate, undefined, "R3 derives this gate, so a missing row is the test failing silently");
  assert.equal(gate.status, "unevaluable");
  assert.doesNotMatch(gate.reason, /does not yet produce/);
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

// The oracle `approved_spec_and_oracle` quantifies over, and the reference an
// oracle approval pins. `legion approve oracle` copies `readOracleArtifact`'s own
// reference rather than minting a digest, so the fixture's `reference` and the
// approval's `artifacts[0]` are the same object shape and the same bytes.
const ORACLE_ID = "orc_transcript-c1";
const ORACLE_PIN = {
  path: `.legion/project/changes/${CHANGE_ID}/oracle/${ORACLE_ID}.yaml`,
  sha256: `sha256:${"d".repeat(64)}`
};

// The instant every ordering fixture below is measured against: one run, one
// start. The two new scenarios differ from each other in exactly one field —
// when the oracle was approved relative to this — and in nothing else.
const EXECUTION_STARTED_AT = "2026-08-02T09:00:00.000Z";
const APPROVED_BEFORE_AT = "2026-08-01T12:00:00.000Z";

function deltaSpecApproval(decidedAt = APPROVED_BEFORE_AT) {
  return {
    id: "apv_transcript-approval",
    changeId: CHANGE_ID,
    status: "granted",
    scope: { action: "spec.delta.approve", targets: [{ kind: "requirement", id: REQUIREMENT_ID }] },
    artifacts: [DELTA_SPEC_PIN],
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt
  };
}

function oracleApproval(decidedAt = APPROVED_BEFORE_AT) {
  return {
    id: "apv_transcript-oracle",
    changeId: CHANGE_ID,
    status: "granted",
    scope: { action: "oracle.approve", targets: [{ kind: "oracle", id: ORACLE_ID }] },
    artifacts: [ORACLE_PIN],
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt
  };
}

function orderedChange(oracleDecidedAt) {
  return {
    changeId: CHANGE_ID,
    deltas: [{ requirementId: REQUIREMENT_ID, path: DELTA_SPEC_PATH, delta: DELTA_SPEC_PIN }],
    approvals: [deltaSpecApproval(), oracleApproval(oracleDecidedAt)],
    oracles: [{ document: { id: ORACLE_ID }, reference: ORACLE_PIN }],
    taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }],
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "match"
  };
}

// --- the attestation plane --------------------------------------------------
//
// An attestation cites ordinary repository files rather than project artifacts,
// which is why `pinned-references.ts` resolves paths itself and why these pins
// live outside `.legion/project`. They are also deliberately distinct from every
// other family's paths in this file: `shipGatePinnedReferences` records that a
// dropped collector was once unfalsifiable precisely because two families shared
// a path, so nothing here may share one.
const THREAT_MODEL_PATH = "docs/next/evidence/transcript/threat-model.json";
const THREAT_MODEL_PIN = { path: THREAT_MODEL_PATH, sha256: `sha256:${"e".repeat(64)}` };
const AB_COMPARISON_PATH = "docs/next/evidence/transcript/ab-comparison.json";
const AB_COMPARISON_PIN = { path: AB_COMPARISON_PATH, sha256: `sha256:${"f".repeat(64)}` };
const WAIVER_BASIS_PATH = "docs/adr/ADR-006-risk-gates.md";
const WAIVER_BASIS_PIN = { path: WAIVER_BASIS_PATH, sha256: `sha256:${"1".repeat(64)}` };

// The classifier `legion ship` injects, stood in for. The real one parses bytes;
// what the gate needs from it is a verdict per path, and asserting the gate
// against a fixture classifier is what keeps this suite filesystem-free.
// tests/evidence-sources asserts the parser itself against the committed
// artefacts, which is where the shape recognition is actually pinned.
function classifier(overrides = {}) {
  const table = {
    [THREAT_MODEL_PATH]: { kind: "clean", shape: "threat-model", enveloped: false },
    [AB_COMPARISON_PATH]: { kind: "clean", shape: "ab-comparison", enveloped: false },
    [WAIVER_BASIS_PATH]: { kind: "unrecognised" },
    ...overrides
  };
  return (reference) => table[reference.path] ?? { kind: "unrecognised" };
}

const ATTESTED_BEFORE_AT = "2026-08-01T18:00:00.000Z";

function attestationRecord({
  attests,
  verdict = "pass",
  sources,
  attestedAt = ATTESTED_BEFORE_AT,
  attestedBy = { kind: "human", id: "dasbl" },
  waiverReason,
  covers = [{ kind: "task", id: TASK_ID }]
}) {
  return {
    id: `att_transcript-attestation-${attests}`,
    changeId: CHANGE_ID,
    attests,
    verdict,
    attestedBy,
    attestedAt,
    sources,
    covers,
    statement: `${attestedBy.id} attests ${attests} as ${verdict}.`,
    ...(waiverReason === undefined ? {} : { waiverReason })
  };
}

// --- the review domain plane ------------------------------------------------
//
// `acceptedReview()` above is deliberately left alone: it carries no `changeId`
// and no `domains`, which is precisely what every review on disk today looks
// like, and every existing scenario's `architecture_or_security_review` cell
// staying `unevaluable` is the proof that a plain accepted review does not
// satisfy this gate.
//
// These fixtures go on `change.reviews`, never on `scenario.reviews`. The
// top-level parameter feeds the two independent-review gates at R1 and R2, so a
// domain review placed there would move cells this release must not touch.
const ALL_AXES_PASS = { specification: "pass", integration: "pass", evidence: "pass" };

function domainReview({
  id = "rev_transcript-domain",
  status = "accepted",
  domains = ["architecture"],
  verdicts = ALL_AXES_PASS,
  findings = []
} = {}) {
  return {
    document: {
      id,
      changeId: CHANGE_ID,
      taskId: TASK_ID,
      status,
      domains,
      verdicts,
      findings,
      supersedes: []
    }
  };
}

// --- the release plane ------------------------------------------------------

/**
 * A release plan the gate would accept, with the knobs each arm turns.
 *
 * `releaseIntent.path` is derived from the change id rather than written out,
 * because the gate compares it against `artifactPathForRole({role: "taskgraph"})`
 * — a fixture with a hard-coded path would silently start failing the
 * release-intent arm if that layout ever moved, which is a different defect from
 * the one any of these tests is about.
 */
function releasePlan({
  changeId = CHANGE_ID,
  status = "requested",
  environment = "staging",
  healthCriteria = ["p99 quote latency stays under 400ms for 30 minutes"],
  rollbackStrategy = "revert",
  rollbackCriteria = ["quote error rate exceeds 1% over any 5 minute window"],
  taskRefs = [TASK_ID],
  releaseIntentPath
} = {}) {
  return {
    id: `rel_${changeId.slice("chg_".length)}-release`,
    changeId,
    status,
    environment,
    releaseIntent: {
      path: releaseIntentPath ?? `.legion/project/changes/${changeId}/taskgraph.json`,
      sha256: `sha256:${"e".repeat(64)}`
    },
    taskRefs,
    approvalRefs: [],
    evidenceRefs: [],
    healthCriteria,
    rollbackPlan: { strategy: rollbackStrategy, criteria: rollbackCriteria, evidenceRefs: [] }
  };
}

/**
 * A change whose only planes are the two `release_observation_plan` reads.
 *
 * `attestations` is present and empty rather than absent for the same reason
 * `reviewedChange` does it: this gate refuses to answer from a release plane it
 * can read while an attestation plane it *cannot* read might hold a record, so a
 * fixture reaching the satisfied arm has to load both.
 */
function plannedRelease({ release, attestations = [] } = {}) {
  return {
    changeId: CHANGE_ID,
    release,
    attestations,
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "match",
    classifySource: classifier()
  };
}

/** A change whose only planes are the two `architecture_or_security_review` reads. */
function reviewedChange(reviews) {
  return {
    changeId: CHANGE_ID,
    reviews,
    // Present and empty rather than absent, and that is a requirement rather than
    // tidiness: the gate refuses to answer from a reviews plane it can read while
    // an attestation plane it *cannot* read might hold a `fail`, so a fixture
    // reaching the satisfied arm has to load both planes. The crossing itself —
    // one producer satisfied, the other's plane in doubt — is held in
    // tests/domain-review-gate, which is where a transcript of statuses cannot
    // go: what distinguishes the two `unevaluable`s is the sentence.
    attestations: [],
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "match",
    classifySource: classifier()
  };
}

// --- the protected acceptance path plane ------------------------------------
//
// The declaration lives on the oracle, and the observation lives on the run's
// evidence item. Both halves are needed for a cell to move: an oracle declaring
// a path with no item is the "nothing was observed" arm, and an item with no
// declaration is the "nobody said" arm — which is where every scenario above
// sits and is why none of their cells move.
const ACCEPTANCE_TEST_PATH = "tests/pricing.test.mjs";

function protectedOracle(acceptancePaths = [ACCEPTANCE_TEST_PATH]) {
  return { document: { id: ORACLE_ID, acceptancePaths }, reference: ORACLE_PIN };
}

/**
 * The item `legion build` writes, with the trace references that say which
 * declarations the run actually snapshotted.
 *
 * The references are not decoration: without them the gate cannot tell a
 * declaration the run covered from one a replan added afterwards, and a `pass`
 * written before the replan would answer for a path nothing ever hashed.
 */
function acceptancePathItem(verdict, paths = [ACCEPTANCE_TEST_PATH]) {
  return {
    id: "protected-acceptance-paths",
    verdict,
    traceRefs: paths.map((entry) => ({ path: entry, entity: { kind: "oracle", id: ORACLE_ID } }))
  };
}

/** The decision `legion approve protected-paths` writes, pinning the oracle. */
function protectedPathsApproval(decidedAt = APPROVED_BEFORE_AT) {
  return {
    id: "apv_transcript-protected-paths",
    changeId: CHANGE_ID,
    status: "granted",
    scope: { action: "oracle.protected-paths.modify", targets: [{ kind: "oracle", id: ORACLE_ID }] },
    artifacts: [ORACLE_PIN],
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt
  };
}

/** A change whose oracles protect an acceptance test, and what was decided about it. */
function protectedPathsChange({ approvals, taskRuns } = {}) {
  return {
    changeId: CHANGE_ID,
    oracles: [protectedOracle()],
    ...(approvals === undefined ? {} : { approvals }),
    ...(taskRuns === undefined ? {} : { taskRuns }),
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "match",
    classifySource: classifier()
  };
}

/** A change carrying exactly one attestation and the run it is ordered against. */
function attestedChange({ attestation, taskRuns, classifySource = classifier() }) {
  return {
    changeId: CHANGE_ID,
    attestations: [attestation],
    ...(taskRuns === undefined ? {} : { taskRuns }),
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "match",
    classifySource
  };
}

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
  },
  {
    // The eleventh, added with `approved_spec_and_oracle`'s producer, and the
    // first row this transcript has ever produced from `change.taskRuns`. It is
    // also the first row that needs *four* planes at once — deltas, approvals,
    // oracles and runs — because the gate's question spans all of them: every
    // delta spec and every oracle a task names carries a granted, pin-clean
    // approval, and the last of those decisions is strictly earlier than the
    // earliest run's start.
    //
    // The task contract carries `oracleRefs`, and that is load-bearing rather
    // than decorative: the gate quantifies over the oracles the change's *tasks
    // name*, not over the files its oracle directory holds. Strip the ref and
    // this cell becomes `unevaluable` — "no task of this change references an
    // oracle" — rather than vacuously satisfied, which is the whole of PR 0's
    // deferred question answered in one fixture.
    name: "a spec and oracle approved before execution",
    contract: { oracleRefs: [ORACLE_ID] },
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: orderedChange(APPROVED_BEFORE_AT)
  },
  {
    // The twelfth, and the pair's other half. Identical to the row above in
    // every field but one: the oracle's `decidedAt` is the run's `startedAt`, to
    // the millisecond.
    //
    // That is the boundary, and it is deliberately the equal case rather than a
    // comfortably later one. Millisecond wall-clock stamps make an exact
    // collision reachable, and an unorderable pair is not evidence that the
    // decision came first — so `>=` blocks, matching `grantExpiry`, both
    // supersession filters and `archiveWithdrawnDecision`. This cell is what
    // fails if anyone ever writes `>` here, and it is worth noting that the one
    // gate in this file that satisfies at `>=` —
    // `whole_change_acceptance_evidence` — does so because one command stamps one
    // instant on both sides of *its* comparison. No writer stamps both sides of
    // this one.
    name: "an oracle approved in the instant execution began",
    contract: { oracleRefs: [ORACLE_ID] },
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: orderedChange(EXECUTION_STARTED_AT)
  },
  {
    // The thirteenth, added with the attestation plane, and the first row this
    // transcript has ever produced from `change.attestations`. A security
    // evaluation attested as passed, citing a threat-model report that reads
    // clean and whose pin still matches.
    //
    // `security_or_e2e_evaluator` has no ordering rule and this scenario carries
    // no run plane, which is the claim: evaluating the implemented change
    // necessarily comes after implementing it, so an ordering rule here would
    // make an honest attestation permanently unsatisfiable.
    name: "a security evaluation attested against a clean threat model",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: attestedChange({
      attestation: attestationRecord({ attests: "security-evaluation", sources: [THREAT_MODEL_PIN] })
    })
  },
  {
    // The fourteenth, and the pair's other half. Identical to the row above in
    // every field but one: the cited report's own verdict.
    //
    // This is the arm that makes `legion attest` more than a rubber stamp
    // enforceable at *read* time. The writer refuses a pass over a red report,
    // and the gate re-derives the same answer rather than trusting the record —
    // because `legion attest` is not the only way a JSON file reaches the
    // attestations directory, and a gate that trusted the record's own verdict
    // would certify a pass over evidence saying the opposite.
    name: "a security evaluation attested over a failing threat model",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: attestedChange({
      attestation: attestationRecord({ attests: "security-evaluation", sources: [THREAT_MODEL_PIN] }),
      classifySource: classifier({
        [THREAT_MODEL_PATH]: {
          kind: "blocking",
          shape: "threat-model",
          enveloped: false,
          reason: "its own ok is false and it records 2 findings"
        }
      })
    })
  },
  {
    // The fifteenth. A baseline attested before the change's first run started,
    // which is the only shape that satisfies `independent_baseline` on evidence.
    name: "a baseline attested before execution began",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: attestedChange({
      attestation: attestationRecord({
        attests: "independent-baseline",
        sources: [AB_COMPARISON_PIN],
        attestedAt: ATTESTED_BEFORE_AT
      }),
      taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  },
  {
    // The sixteenth, and the pair's other half. Identical but for `attestedAt`,
    // which is the run's own `startedAt` to the millisecond.
    //
    // The boundary is deliberately the equal case rather than a comfortably
    // later one, on `approved_spec_and_oracle`'s recorded rule: millisecond
    // wall-clock stamps make an exact collision reachable, and an unorderable
    // pair is not evidence that the baseline came first. `>=` blocks. This cell
    // is what fails if anyone ever writes `>` here.
    //
    // It is `unsatisfied` rather than `unevaluable`, and that distinction is the
    // whole point of the arm: a baseline captured after the run it is supposed
    // to be independent of is not an absence of evidence, it is evidence that
    // there was no independence.
    name: "a baseline attested in the instant execution began",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: attestedChange({
      attestation: attestationRecord({
        attests: "independent-baseline",
        sources: [AB_COMPARISON_PIN],
        attestedAt: EXECUTION_STARTED_AT
      }),
      taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  },
  {
    // The seventeenth, and the one arm in these three gates with no falsifiable
    // evidence behind it: an audited waiver. ADR-006 permits a waived gate, and
    // this is what it looks like — a named human, a recorded instant, a reason a
    // reviewer can disagree with, and a pinned document supporting the claim.
    //
    // The cited document is deliberately `unrecognised` by the classifier. A
    // waiver cites the decision record that supports "this does not apply", not
    // a report of the check being waived — and a waiver over a *failing* report
    // of that check is refused at both ends, which is asserted in
    // tests/attestation-gates rather than as a transcript cell.
    name: "a rollback gate waived by a named human",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: attestedChange({
      attestation: attestationRecord({
        attests: "rollback-evidence",
        verdict: "not_applicable",
        sources: [WAIVER_BASIS_PIN],
        waiverReason: "This change ships no migration and touches no persisted state, so there is nothing to roll back."
      })
    })
  },
  {
    // The eighteenth, added with `architecture_or_security_review`'s producer,
    // and the first row this transcript has ever produced from `change.reviews`.
    // An accepted review that says which competence performed it, with all three
    // verdict axes pass and no blocking finding.
    name: "an accepted architecture review",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: reviewedChange([domainReview()])
  },
  {
    // The nineteenth, and the pair's other half. Identical to the row above in
    // every field but one: `status`.
    //
    // `unsatisfied` rather than `unevaluable`, and that distinction is the arm's
    // whole point: a rejected architecture review is not an absence of evidence,
    // it is evidence that the architecture review said no.
    name: "a rejected architecture review",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: reviewedChange([domainReview({ status: "rejected" })])
  },
  {
    // The twentieth. Accepted, clean, and performed in a domain this gate does
    // not read — which is the hard requirement of the specification stated as a
    // transcript cell: recording *a* domain is not recording *this* one, and the
    // difference from the eighteenth row is one string.
    name: "an accepted implementation-only review",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: reviewedChange([domainReview({ domains: ["implementation"] })])
  },
  {
    // The twenty-first. Accepted, performed in the architecture domain, no
    // finding of any severity — and one verdict axis that reached no verdict.
    //
    // This is the cell that fails if the satisfied arm is ever written as "no
    // axis is fail". `reviewVerdictSchema` admits `unknown`, `not_verified` and
    // `not_applicable`, so the negative phrasing satisfies this gate off a review
    // that verified nothing, and the positive phrasing — all three axes literally
    // `"pass"` — is what puts this row at `unevaluable`. It is neither a pass nor
    // a failure, so it is neither `satisfied` nor `unsatisfied`.
    name: "an architecture review that reached no verdict on one axis",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: reviewedChange([
      domainReview({ verdicts: { specification: "pass", integration: "unknown", evidence: "pass" } })
    ])
  },
  {
    // The twenty-second, added with `protected_acceptance_tests`' producer, and
    // the first row this transcript has ever produced from an oracle's declared
    // acceptance paths. An oracle naming a test the work must not weaken, and a
    // run whose observation says it was byte-identical on both sides.
    name: "a run that left its protected acceptance test alone",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      acceptancePathItem("pass")
    ],
    reviews: [acceptedReview()],
    change: protectedPathsChange()
  },
  {
    // The twenty-third, and the pair's other half. Identical to the row above in
    // every field but one: the item's verdict.
    //
    // `unsatisfied` rather than `unevaluable`, and that is the arm's whole point:
    // a run that edited the test it is judged by is not an absence of evidence,
    // it is evidence that the implementer moved their own bar. No approval plane
    // is loaded here at all, which is the honest shape of the common case —
    // nobody decided anything, so there is nothing to have decided it.
    name: "a run that changed a protected acceptance test",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      acceptancePathItem("fail")
    ],
    reviews: [acceptedReview()],
    change: protectedPathsChange({
      approvals: [],
      taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  },
  {
    // The twenty-fourth. The same `fail` observation, with a named human's
    // decision recorded *before* the run started. This is the only route to
    // `satisfied` over a changed acceptance test, and it is what "cannot be
    // weakened by the implementer" means: the approval plane blesses it, and only
    // in advance.
    name: "a protected acceptance test changed under a decision taken first",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      acceptancePathItem("fail")
    ],
    reviews: [acceptedReview()],
    change: protectedPathsChange({
      approvals: [protectedPathsApproval(APPROVED_BEFORE_AT)],
      taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  },
  {
    // The twenty-fifth, and the pair's other half. Identical to the row above in
    // every field but one: the decision instant, moved to the run's own
    // millisecond.
    //
    // This is the cell that fails if the comparison is ever written `<=` instead
    // of `<`. Both stamps are millisecond wall-clock and no honest writer produces
    // the equal pair — `legion approve protected-paths` writes no runs and
    // `legion build` writes no approvals — so strictness costs nothing honest and
    // an unorderable pair is not evidence that the decision came first.
    name: "a protected acceptance test changed under a decision taken too late",
    items: [
      item("declared-verification", "pass"),
      item("diff-reconciliation", "pass"),
      acceptancePathItem("fail")
    ],
    reviews: [acceptedReview()],
    change: protectedPathsChange({
      approvals: [protectedPathsApproval(EXECUTION_STARTED_AT)],
      taskRuns: [{ id: "run_transcript-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  },
  {
    // The twenty-sixth, and the first of this release's four. A release plan
    // that observes the whole change: one health criterion, a revert strategy
    // with one trigger, and coverage of the only task that derives the gate. The
    // one R3 cell in this file that reaches `satisfied` on the artifact route.
    name: "a release plan that observes the whole change",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: plannedRelease({ release: { kind: "document", document: releasePlan() } })
  },
  {
    // The twenty-seventh, and the pair's other half. Identical in every field but
    // one: `taskRefs` names a task this change does not have, so the plan
    // observes none of what it claims to. `unsatisfied` rather than
    // `unevaluable`, because somebody wrote a plan and it does not cover the
    // change — which is a recorded failure to answer rather than the absence of a
    // record.
    name: "a release plan that observes a task this change does not have",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: plannedRelease({
      release: { kind: "document", document: releasePlan({ taskRefs: ["tsk_phase-1-elsewhere"] }) }
    })
  },
  {
    // The twenty-eighth. Identical to the twenty-sixth in every field but
    // `environment`, which is the field this gate was found reading only to quote
    // back: a `local` plan satisfied it exactly as a `production` plan did, so
    // `--environment local` was a route to a green R3 gate that needed no named
    // human, no waiver reason and no `waivedGates` entry. `unsatisfied` — the
    // document exists and plans the work rather than the release of it.
    name: "a release plan for an environment nothing is released into",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: plannedRelease({
      release: { kind: "document", document: releasePlan({ environment: "local" }) }
    })
  },
  {
    // The twenty-ninth. The other producer: no plan at all, and an audited
    // `release-observation` waiver for a change that deploys nothing. It is the
    // one arm of this gate that satisfies with nothing falsifiable behind it, and
    // the transcript records that it satisfies — `shipGateWaivers` echoing it is
    // asserted in tests/release-plan-gate, where the sentence can be read.
    name: "a release waived as not applicable",
    items: [item("declared-verification", "pass"), item("diff-reconciliation", "pass")],
    reviews: [acceptedReview()],
    change: plannedRelease({
      release: { kind: "absent" },
      attestations: [
        attestationRecord({
          attests: "release-observation",
          verdict: "not_applicable",
          sources: [WAIVER_BASIS_PIN],
          waiverReason: "This change ships documentation only and deploys nothing."
        })
      ]
    })
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
 * **One gate id changed behaviour in this release, and exactly one:
 * `protected_acceptance_tests`.** ADR-006 asks whether the acceptance tests can
 * be weakened by the implementer, and until now nothing anywhere recorded which
 * tests those were: `oracle.protectedPaths` named the change artifact and was
 * read by nobody. An oracle now carries `acceptancePaths`, the guarded harness
 * hashes them on both sides of every dispatch, and the run's evidence records
 * what moved.
 *
 * **Twenty-one existing R3 rows kept `protected_acceptance_tests` at
 * `unevaluable`, and that is the load-bearing half.** They now flow through a
 * real gate rather than through `evaluateGate`'s `default:` arm. Which arm they
 * land on is *not* uniform, and an earlier version of this paragraph said it was:
 * only the two scenarios built by `orderedChange` — the one pre-existing fixture
 * that sets `oracles` — reach the branch that says nothing in the change declares
 * a protected acceptance path. The other nineteen pass no oracle plane at all and
 * land on the `unestablished` branch beside it. Both are `unevaluable`, so no cell
 * moves either way; but the transcript is therefore not a witness for the
 * nothing-was-declared arm — that arm is witnessed by the unit suite and by
 * change-r3-ordering, and a reader who trusts this file to redden when it is
 * refactored will be disappointed. The reason string moved and the status did
 * not; a cell that moves here is a defect rather than an edit.
 *
 * The movement is in four new scenarios, and it takes four because the pairs are
 * the claim. Both pairs differ in exactly one field: an observation that says
 * `pass` against one that says `fail`, and a decision instant before the run
 * against one in the run's own millisecond.
 *
 * The gate id that moved in the release before this one was
 * `architecture_or_security_review`. ADR-006 asks whether a domain competence
 * looked at this change, and `reviewDecisionBaseSchema` carried three fixed
 * verdict axes and no notion of domain at all — so the only available reading was
 * "an accepted review exists", which every change has and which is the exact
 * fail-open `explicit_human_approval` closed one gate over. `domains` is the
 * field that makes the question answerable.
 *
 *  - `satisfied` — every deriving task carries an *accepted* review whose
 *    `domains` name architecture or security, with all three verdict axes
 *    literally `"pass"` and no blocking finding; **or** a pin-clean `pass`
 *    `architecture-review` attestation by a named human, which ship echoes as a
 *    `risk_gate_human_judgement` warning because nothing machine-checkable was
 *    read; **or** an audited waiver.
 *  - `unsatisfied` — such a review is rejected, carries a blocking finding, or
 *    records a `fail` on any axis; or the attestation says `fail`.
 *  - `unevaluable` — no review records a domain at all (every review written
 *    before this release), a domain that is not architecture or security, a
 *    domain review nobody accepted, one whose axes reached no verdict, one a
 *    later domainless review superseded, or a deriving task no domain review
 *    covers.
 *
 * It is **change-scoped**, the eighth entry in `GATE_SCOPE` that is not
 * `"task"`, and that flip is part of this release's behaviour change: the entry
 * was already there reading `"task"`, so nothing failed to compile. Both
 * producers answer for the change — an attestation is keyed by `(changeId,
 * kind)`, and the review half quantifies over every deriving task.
 *
 * **No cell in the seventeen earlier scenarios moved**, which is what a transcript
 * is for: a gate that gained a producer must not move a verdict it was not asked
 * about.
 *
 * **What those seventeen frozen cells are not is the proof that a plain accepted
 * review fails to satisfy this gate**, and an earlier version of this paragraph
 * said they were. Measured: they leave `change.reviews` unset — most pass no
 * `change` at all — so `domainReviewOutcome` returns from its first guard, "the
 * reviews recorded for this change could not be read as a complete set", and
 * never reaches the `domains` filter, the status check or the verdict check. Those
 * cells would read `unevaluable` with the entire domain logic deleted. The
 * specification's hard requirement is held by the first test in
 * tests/domain-review-gate, which asserts the *sentence*, and by the new
 * `an accepted implementation-only review` row below — a mutant widening
 * `DOMAIN_REVIEW_GATE_DOMAINS` to include `implementation` reddens exactly those
 * two and none of the seventeen.
 *
 * The movement is in four new scenarios, and it takes four because three of them
 * are the near misses. They differ from each other in one field: `status`,
 * `domains`, one verdict axis. An accepted architecture review with three passing
 * axes is `satisfied`; the same review rejected is `unsatisfied`; the same review
 * performed in `implementation` is `unevaluable`; and the same review with
 * `integration: "unknown"` is `unevaluable`, which is the cell that fails if the
 * satisfied arm is ever written as "no axis is fail".
 *
 * **The three gate ids that changed behaviour in the release before this one were
 * `independent_baseline`, `security_or_e2e_evaluator` and
 * `rollback_or_forward_fix_evidence`.** All three gained a producer at once
 * because all three had the same problem — the verdict they want already exists
 * in this repository as JSON keyed by phase or by release, with no concept of a
 * change anywhere in it — and the same answer: an `Attestation`, in which a named
 * human asserts at a recorded instant that specific hash-pinned files are this
 * change's evidence, and which `legion ship` re-hashes and re-reads.
 *
 * Their shared shape:
 *
 *  - `satisfied` — a `pass` attestation of an accepted kind whose sources all
 *    hash clean and at least one of which is a report shape this tree can read a
 *    green verdict out of; **or** an audited waiver (`not_applicable`, a human
 *    attester, a recorded reason), which ship echoes as a `risk_gate_waived`
 *    warning on every payload that carries one.
 *  - `unsatisfied` — verdict `fail`; a source that drifted or is gone; a cited
 *    report that is negative by its own producer's rule; a `covers` list leaving
 *    a deriving task out; a `pass` over a shape nothing can read a verdict from.
 *  - `unevaluable` — no attestation of an accepted kind, a plane that would not
 *    read as a complete set, verdict `unknown`, or a source nobody re-hashed.
 *
 * `independent_baseline` alone carries an ordering rule: `attestedAt <
 * executionStartedAt`, reusing `approved_spec_and_oracle`'s `executionOrdering`
 * rather than a second minimum, and blocking at `>=` for the same reason. The
 * specification also asked for an attester distinct from the executor recorded in
 * the task runs; that half was measured and dropped, because `legion build`
 * writes the hard-coded literal `{kind: "tool", id: "legion-cli"}` as `claimedBy`
 * on every run of every change, so the check could never fail. What survives is
 * the falsifier alone — a *human* executor whose id equals the attester's — which
 * can only refuse and never satisfy, so its vacuity is harmless.
 *
 * All three are **change-scoped**, the fifth, sixth and seventh entries in
 * `GATE_SCOPE` that are not `"task"`. An attestation is keyed by `changeId` and
 * there is at most one per kind per change, so all three answer once for the
 * change; `CHANGE_SCOPED_GATES` below is the hand-written duplicate that records
 * the flip.
 *
 * **No cell in the twelve earlier scenarios moved.** None of them carries an
 * attestation plane at all, so all three gates answer `unevaluable` there —
 * exactly what the `default:` arm answered before they had producers. The
 * movement is in five new scenarios, and it takes five because the pairs are the
 * claim: a clean threat model against a red one, a baseline before the run
 * against one in the run's own millisecond, and the audited waiver on its own,
 * which has no pair because it is the arm with no evidence behind it.
 *
 * **The gate id that moved in the release before this one was
 * `approved_spec_and_oracle`.** It gained a producer, and it is the ordering
 * gate the whole approval artifact was built for: not "was this approved" —
 * `approved_delta_spec` asks that, and R3 does not even derive it — but "was it
 * approved *first*". `satisfied` requires every delta spec the change ships and
 * every oracle any task *names* to carry a granted, pin-clean approval, and the
 * last of those decisions to be strictly earlier than `min(startedAt)` over the
 * change's complete run set. `unsatisfied` for a standing negative, for an
 * oracle whose bytes no longer match what was approved, and for a decision taken
 * at or after the start. `unevaluable` for anything unestablished — including a
 * task naming an oracle the change cannot show, which is what makes an empty or
 * short oracle directory non-vacuous.
 *
 * It is **change-scoped**, the fourth entry in `GATE_SCOPE` that is not
 * `"task"`, and that flip is part of this release's behaviour change rather than
 * a tidy-up: the entry was already there, reading `"task"`, so nothing failed to
 * compile. `legion plan` materialises one task per executable criterion, and a
 * task-scoped version would have re-answered one change-level ordering question
 * once per criterion under a `subjectId` naming a task the sentence is not about.
 *
 * **No cell in the ten earlier scenarios moved.** Eight of them load no oracle
 * plane and no run plane at all, and the two that load a plane load it for
 * another gate — so this gate's absent-fact answer is `unevaluable`, which is
 * exactly what the `default:` arm answered before it had a producer. What those
 * unchanged cells assert is worth keeping: they are PR 0's invariant — an absent
 * fact yields `unevaluable`, never `satisfied` — checked from outside the gate
 * that has to hold it.
 *
 * The movement is in two new scenarios, and it takes two because the pair is the
 * claim. They differ in one field: the oracle's `decidedAt`. Approved the day
 * before the run, the gate is `satisfied`; approved in the run's own
 * millisecond, it is `unsatisfied`, because an unorderable pair is not evidence
 * that the decision came first.
 *
 * **The gate id that moved in the release before this one was
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
  },
  "a spec and oracle approved before execution": {
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
      // R2 does not derive this release's gate at all, so its whole row is
      // recorded here to show what a change carrying four loaded planes looks
      // like at the tier that asks none of this release's questions. The one
      // cell that is not "passing verification and an accepted review"'s is
      // `approved_delta_spec`, which the spec approval satisfies — the same fact
      // this release's gate reads for its requirement half, seen through the
      // gate that has read it since PR 2.
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
      // The cell this release adds, and the first `satisfied` this gate has ever
      // produced.
      approved_spec_and_oracle: "satisfied",
      protected_oracle: "unevaluable",
      deterministic_verification: "satisfied",
      architecture_or_security_review: "unevaluable",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      // The approvals plane holds records, and neither is a review acceptance.
      // This gate matches `scope.action` exactly, so it reads them as naming
      // nothing about a review — which is absence, not a negative.
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "an oracle approved in the instant execution began": {
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
      // The other cell, and the first `unsatisfied` this gate has ever produced.
      // One millisecond apart from the row above — literally zero, since the two
      // instants are equal — and nothing else differs.
      approved_spec_and_oracle: "unsatisfied",
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
  "a security evaluation attested against a clean threat model": {
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
      security_or_e2e_evaluator: "satisfied",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a security evaluation attested over a failing threat model": {
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
      security_or_e2e_evaluator: "unsatisfied",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a baseline attested before execution began": {
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
      independent_baseline: "satisfied",
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
  "a baseline attested in the instant execution began": {
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
      independent_baseline: "unsatisfied",
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
  "a rollback gate waived by a named human": {
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
      rollback_or_forward_fix_evidence: "satisfied"
    }
  },
  "an accepted architecture review": {
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
      architecture_or_security_review: "satisfied",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a rejected architecture review": {
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
      architecture_or_security_review: "unsatisfied",
      protected_acceptance_tests: "unevaluable",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "an accepted implementation-only review": {
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
  "an architecture review that reached no verdict on one axis": {
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
  "a run that left its protected acceptance test alone": {
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
      protected_acceptance_tests: "satisfied",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a run that changed a protected acceptance test": {
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
      protected_acceptance_tests: "unsatisfied",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a protected acceptance test changed under a decision taken first": {
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
      protected_acceptance_tests: "satisfied",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  "a protected acceptance test changed under a decision taken too late": {
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
      protected_acceptance_tests: "unsatisfied",
      security_or_e2e_evaluator: "unevaluable",
      explicit_human_approval: "unevaluable",
      release_observation_plan: "unevaluable",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  // This release's four, and each moves exactly one cell: the R3
  // `release_observation_plan` entry. Every other cell in all sixteen blocks is
  // identical to the rows above, which is the claim — a gate gaining a producer
  // must not move a verdict belonging to another gate.
  "a release plan that observes the whole change": {
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
      release_observation_plan: "satisfied",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  // The pair's other half. The only field that differs from the row above is
  // `taskRefs`, and the cell goes from `satisfied` to `unsatisfied` rather than
  // to `unevaluable`: a plan that names the wrong task is a record that fails to
  // answer, not the absence of one.
  "a release plan that observes a task this change does not have": {
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
      release_observation_plan: "unsatisfied",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  // The same plan at `environment: "local"`. The one cell that differs from the
  // scenario two above is `release_observation_plan` at R3, which is the whole
  // claim: the environment is classified rather than rendered, so a plan for a
  // place nothing is released into is a recorded failure to answer this gate
  // rather than an answer to it.
  "a release plan for an environment nothing is released into": {
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
      release_observation_plan: "unsatisfied",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  },
  // The other producer, on the same gate. A plan that does not exist and an
  // audited waiver that does — the one arm of this gate that satisfies with
  // nothing falsifiable behind it, recorded here as satisfying so that a later
  // change removing the waiver route reddens the transcript rather than only a
  // unit test.
  "a release waived as not applicable": {
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
      release_observation_plan: "satisfied",
      rollback_or_forward_fix_evidence: "unevaluable"
    }
  }
};

/**
 * `report.ready` for the same twenty-nine scenarios at the same four tiers.
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
  "a change rebuilt after its sign-off": { R0: true, R1: true, R2: false, R3: false },
  // R3 stays blocked in every one of these, and that is the honest report rather
  // than a weaker one: every fixture in this file moves at most one R3 gate,
  // leaving the other nine unmet, so no row here could make R3 ready and one that
  // appeared to would be lying about the release. As of this release every R3
  // gate *does* have a producer, and the change that carries all ten really does
  // report `ready` — that claim needs the whole CLI to make and is made end to
  // end by the R3 milestone test in tests/change-r3-ordering, which also derives
  // the producerless set from `evaluateGate`'s own `default:` reason string and
  // asserts it is now empty.
  "a spec and oracle approved before execution": { R0: true, R1: true, R2: false, R3: false },
  "an oracle approved in the instant execution began": { R0: true, R1: true, R2: false, R3: false },
  "a security evaluation attested against a clean threat model": { R0: true, R1: true, R2: false, R3: false },
  "a security evaluation attested over a failing threat model": { R0: true, R1: true, R2: false, R3: false },
  "a baseline attested before execution began": { R0: true, R1: true, R2: false, R3: false },
  "a baseline attested in the instant execution began": { R0: true, R1: true, R2: false, R3: false },
  "a rollback gate waived by a named human": { R0: true, R1: true, R2: false, R3: false },
  // R3 stays blocked in the four review-domain rows too, and for the same reason:
  // two of R3's ten gates still have no producer, and these fixtures move exactly
  // one gate each.
  "an accepted architecture review": { R0: true, R1: true, R2: false, R3: false },
  "a rejected architecture review": { R0: true, R1: true, R2: false, R3: false },
  "an accepted implementation-only review": { R0: true, R1: true, R2: false, R3: false },
  "an architecture review that reached no verdict on one axis": { R0: true, R1: true, R2: false, R3: false },
  // The four `protected_acceptance_tests` rows. Every R3 cell stays `false` —
  // satisfying one gate does not make a tier ready while nine others are unmet —
  // and every R0 and R1 cell stays `true`, which is the second half of the pair's
  // claim: the new plane moved exactly one gate at exactly one tier.
  "a run that left its protected acceptance test alone": { R0: true, R1: true, R2: false, R3: false },
  "a run that changed a protected acceptance test": { R0: true, R1: true, R2: false, R3: false },
  "a protected acceptance test changed under a decision taken first": { R0: true, R1: true, R2: false, R3: false },
  "a protected acceptance test changed under a decision taken too late": { R0: true, R1: true, R2: false, R3: false },
  // This release's four. R3 stays `false` in all of them for the reason above:
  // each moves exactly one of R3's ten gates, and nine are unmet for want of a
  // fixture rather than for want of a producer.
  "a release plan that observes the whole change": { R0: true, R1: true, R2: false, R3: false },
  "a release plan that observes a task this change does not have": { R0: true, R1: true, R2: false, R3: false },
  "a release plan for an environment nothing is released into": { R0: true, R1: true, R2: false, R3: false },
  "a release waived as not applicable": { R0: true, R1: true, R2: false, R3: false }
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

test("the only change facts any gate reads are acceptance, deltas, approvals, attestations, reviews, oracles, taskRuns, release, changeId and the clock", () => {
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
  // `taskRuns` joins the allow-list with `approved_spec_and_oracle`'s producer,
  // and it is the last of the four fail-opens this trap was holding open to gain
  // a reader. It is admitted with a stated reason: that gate's question *is*
  // "were these decisions taken before gated execution began", the only record
  // of when execution began is `min(startedAt)` over the run plane, and there is
  // nowhere else it could be read from.
  //
  // Like `oracles`, the read is guarded — it happens only once every delta spec
  // and every referenced oracle is already approved, because a gate that
  // complained about ordering before it complained about an unapproved oracle
  // would tell an operator with nothing approved to run a build, which is the one
  // act that makes the ordering unrepairable. So `ABSENT_PLANE_READS` does not
  // move for it at all, and the populated ordering pass at the bottom is what
  // witnesses the read. An admission with no populated witness is an admission
  // nothing witnesses.
  //
  // `reviews` joins the allow-list with `architecture_or_security_review`'s
  // producer, and it is admitted with a stated reason rather than by widening the
  // trap. It is a *second* reviews channel beside `deriveShipGates`' top-level
  // `reviews` parameter, deliberately: that parameter is the raw listing, which
  // drops what it cannot parse and says nothing, and this is the first gate with
  // an `unsatisfied` arm that reads a review — so a rejected domain review made
  // unparseable would vanish and the gate would answer from the accepted one
  // beside it. The three gates on the raw parameter ask a question a dropped file
  // can only make more conservative, so they stay there.
  //
  // Unlike `oracles` and `taskRuns`, this read happens on the absent-plane path
  // too — an unreadable reviews plane is one of the gate's distinct sentences —
  // so it moves `ABSENT_PLANE_READS.R3` rather than needing a populated pass to
  // witness it. A populated pass is added below anyway, because the absent path
  // returns before the domain filter and the coverage quantifier run.
  //
  // `release` joins the allow-list with `release_observation_plan`'s producer,
  // and it is the last of the planes this trap was holding open. It is admitted
  // with a stated reason: that gate's question *is* whether this change records
  // a plan for how its release is observed and taken back, there is exactly one
  // release.json per change, and there is nowhere else it could be read from.
  //
  // Unlike `oracles` and `taskRuns`, the read happens on the degraded path too —
  // the gate asks the plane before anything else, and "nobody looked" is one of
  // its distinct sentences — so it moves `ABSENT_PLANE_READS.R3` rather than
  // needing a populated pass to witness it. A populated pass is added below
  // anyway, driving the gate all the way to `satisfied`, because the absent arm
  // returns before the status classification and the coverage quantifier ever
  // run. An admission with no populated witness is an admission nothing
  // witnesses.
  function tripwire(
    reads,
    { acceptance, approvals, attestations, reviews, deltas, oracles, taskRuns, release, classifySource } = {}
  ) {
    return new Proxy(
      // `verifyPin` and `classifySource` are the two true exemptions: the guard
      // inside `deriveShipGates` inspects both on every call, to substitute one
      // when a caller supplied something that is not a function, so recording
      // them would say nothing about which gate read what.
      {
        verifyPin: () => "match",
        classifySource: classifySource ?? (() => ({ kind: "unrecognised" })),
        changeId: "chg_tripwire",
        acceptance,
        approvals,
        attestations,
        reviews,
        deltas,
        oracles,
        taskRuns,
        release,
        evaluatedAt: undefined
      },
      {
        get(target, property) {
          if (property === "verifyPin") return target.verifyPin;
          if (property === "classifySource") return target.classifySource;
          if (
            property === "changeId" ||
            property === "acceptance" ||
            property === "approvals" ||
            property === "attestations" ||
            property === "reviews" ||
            property === "deltas" ||
            property === "oracles" ||
            property === "taskRuns" ||
            property === "release" ||
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
    // R3 reads `attestations` first of all, because `independent_baseline` is
    // the first gate in R3's order and the attestation plane is the first thing
    // it asks about; `changeId` follows immediately, because that gate is now
    // change-scoped and `deriveShipGates` reads the id to name its subject.
    // `deltas` is `approved_spec_and_oracle`'s first read, `reviews` is
    // `architecture_or_security_review`'s — fifth in R3's order, which is where
    // it lands in this list — and `approvals` is `explicit_human_approval`'s.
    // `oracles` joins this list in the release that gave
    // `protected_acceptance_tests` a producer, and it is admitted with a stated
    // reason rather than by widening the trap. That gate's subject set *is* the
    // acceptance paths the change's oracles declare — a change-wide set, because
    // `legion plan` makes one task per criterion and a per-task set would let one
    // task's run weaken a test another task's oracle protects — and there is
    // nowhere else it could be read from. Unlike
    // `integration_or_real_interface_checks`, which consults the plane only when a
    // task contract names an oracle, this gate has no contract-side half to guard
    // behind, so the read happens on the degraded path too and moves this list
    // rather than needing a populated pass to witness it. A populated pass is
    // added below anyway, because the absent path returns before the coverage
    // quantifier, the approval scoping and the ordering comparison.
    //
    // Its position — sixth in R3's order, between `reviews` and `approvals` — is
    // the gate order asserted rather than assumed. `taskRuns` is deliberately
    // still absent: this gate reaches it only once an item records a `fail`, so
    // no gate touches it on a degraded change.
    //
    // `release` is last, and the position is the gate order asserted rather than
    // assumed: `release_observation_plan` is ninth of R3's ten gates, after
    // `explicit_human_approval` which contributes `approvals`. It also depends on
    // `releaseObservationPlanStatus` asking the release plane before the
    // attestation one — reorder those two calls and this list moves without the
    // gate's behaviour changing at all.
    R3: ["attestations", "changeId", "deltas", "reviews", "oracles", "approvals", "release"]
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
  // `deltas` joins this R3 pass with `approved_spec_and_oracle`'s producer: the
  // gate reads the delta plane first of all and returns on finding it absent,
  // before it can reach an oracle or a run. That it stops there is the point —
  // a populated approvals plane must not be enough to make an ordering gate
  // start consulting planes nobody loaded.
  assert.deepEqual(
    [...new Set(populatedReviewReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "oracles", "release", "reviews"]
  );

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

  // And once more at R3, against every plane the ordering gate reads, with a
  // task that actually names an oracle. Both guarded reads — `oracles` and
  // `taskRuns` — are reachable only from here: the absent-plane loop returns at
  // the delta arm, and a gate with an unapproved subject returns before the
  // ordering arm. Without this pass, admitting `taskRuns` to the allow-list
  // above would be a widening nothing witnesses, which is the failure mode this
  // file's own comments warn about.
  const populatedOrderingReads = [];
  const orderingReport = deriveShipGates({
    tasks: [task("R3", { oracleRefs: [ORACLE_ID] })],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedOrderingReads, {
      deltas: [{ requirementId: REQUIREMENT_ID, path: DELTA_SPEC_PATH, delta: DELTA_SPEC_PIN }],
      // `chg_tripwire` on both, because every scoping predicate here matches on
      // strict change-id equality: facts too degraded to name their own change
      // must match nothing rather than everything.
      approvals: [
        { ...deltaSpecApproval(), changeId: "chg_tripwire" },
        { ...oracleApproval(), changeId: "chg_tripwire" }
      ],
      oracles: [{ document: { id: ORACLE_ID }, reference: ORACLE_PIN }],
      taskRuns: [{ id: "run_tripwire-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  });
  assert.deepEqual(
    [...new Set(populatedOrderingReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "evaluatedAt", "oracles", "release", "reviews", "taskRuns"]
  );
  // The planes are genuinely read to a decision, not merely touched: this is the
  // gate's `satisfied` arm, which no other assertion in this file reaches.
  const ordering = orderingReport.gates.find((gate) => gate.gate === "approved_spec_and_oracle");
  assert.equal(ordering.status, "satisfied");
  // A satisfied verdict that hides its margin is unauditable, so both instants
  // are in the sentence an operator reads.
  assert.match(ordering.reason, new RegExp(APPROVED_BEFORE_AT));
  assert.match(ordering.reason, new RegExp(EXECUTION_STARTED_AT));
  // Change-scoped, so the subject is the change the sentence is about — the
  // fixture's own change id rather than the transcript's, because the tripwire
  // names itself.
  assert.equal(ordering.subjectId, "chg_tripwire");

  // And once more against a populated attestation plane, because `attestations`
  // joins the allow-list in this release and this file's standard is that an
  // admission with no populated witness is an admission nothing witnesses. The
  // absent-plane loop above reaches `attestations` and returns immediately, so
  // without this pass nothing would show the plane being read to a decision —
  // and the two guarded reads past it, `taskRuns` for the ordering clause and
  // the injected classifier for the source verdict, would be invisible.
  const populatedAttestationReads = [];
  const attestationReport = deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedAttestationReads, {
      // `chg_tripwire`, because the scoping predicate matches on strict
      // change-id equality: an attestation cites ordinary repository files that
      // several changes could name, so a record too degraded to name its own
      // change must match nothing rather than everything.
      attestations: [
        {
          ...attestationRecord({ attests: "independent-baseline", sources: [AB_COMPARISON_PIN] }),
          changeId: "chg_tripwire"
        },
        {
          ...attestationRecord({ attests: "security-evaluation", sources: [THREAT_MODEL_PIN] }),
          changeId: "chg_tripwire"
        }
      ],
      taskRuns: [{ id: "run_tripwire-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }],
      classifySource: classifier()
    })
  });
  assert.deepEqual(
    [...new Set(populatedAttestationReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "oracles", "release", "reviews", "taskRuns"]
  );
  // Read to a decision rather than merely touched: the baseline gate reaches its
  // ordering clause, which no other assertion in this file does, and the
  // security gate reaches the source classifier.
  assert.equal(
    attestationReport.gates.find((gate) => gate.gate === "independent_baseline").status,
    "satisfied"
  );
  assert.equal(
    attestationReport.gates.find((gate) => gate.gate === "security_or_e2e_evaluator").status,
    "satisfied"
  );
  // And the third gate stays `unevaluable` on the same populated plane, because
  // nothing attests it: a plane that is readable and holds records is not the
  // same fact as a plane that answers this gate's question.
  assert.equal(
    attestationReport.gates.find((gate) => gate.gate === "rollback_or_forward_fix_evidence").status,
    "unevaluable"
  );

  // And once more against a populated *reviews* plane. The absent-plane loop
  // above reaches `reviews` and returns immediately, so without this pass nothing
  // would show the plane being read to a decision — and this file's standard is
  // that an admission with no populated witness is an admission nothing
  // witnesses. `taskRuns` is the guarded read past it: the executor falsifier
  // runs only once a satisfying review has been found, which is why it appears
  // here and not in the absent-plane list.
  const populatedDomainReviewReads = [];
  const domainReviewReport = deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedDomainReviewReads, {
      // `chg_tripwire`, because the scoping predicate matches on strict change-id
      // equality: a record too degraded to name its own change must match nothing
      // rather than everything.
      reviews: [{ document: { ...domainReview().document, changeId: "chg_tripwire" } }],
      attestations: [],
      taskRuns: [{ id: "run_tripwire-attempt-1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }]
    })
  });
  assert.deepEqual(
    [...new Set(populatedDomainReviewReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "oracles", "release", "reviews", "taskRuns"]
  );
  // Read to a decision rather than merely touched: this is the gate's `satisfied`
  // arm, which no absent-plane pass can reach.
  assert.equal(
    domainReviewReport.gates.find((gate) => gate.gate === "architecture_or_security_review").status,
    "satisfied"
  );

  // And once more against an oracle plane that actually declares a protected
  // acceptance path. `oracles` is admitted to the R3 absent-plane list above, and
  // that admission proves only that the plane is *touched*; this proves it is read
  // to a decision, past the coverage quantifier that compares the declaration set
  // against the trace references of the item the run wrote. Without it the
  // admission would be a widening nothing witnesses, which is the failure mode
  // this file's own comments warn about.
  const populatedAcceptancePathReads = [];
  const acceptancePathReport = deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [
      entry([
        ...PASSING_R2.items,
        {
          id: "protected-acceptance-paths",
          verdict: "pass",
          traceRefs: [{ path: "tests/pricing.test.mjs", entity: { kind: "oracle", id: ORACLE_ID } }]
        }
      ])
    ],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedAcceptancePathReads, {
      oracles: [
        {
          document: { id: ORACLE_ID, acceptancePaths: ["tests/pricing.test.mjs"] },
          reference: ORACLE_PIN
        }
      ]
    })
  });
  assert.deepEqual(
    [...new Set(populatedAcceptancePathReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "oracles", "release", "reviews"]
  );
  // `taskRuns` is absent from that list, and its absence is this gate's guard
  // ordering asserted rather than assumed: a `pass` needs no decision behind it,
  // so the gate never reaches the approval scoping or the ordering comparison.
  // (`approvals` is there because `explicit_human_approval` reads it at R3
  // whatever this gate does.)
  assert.equal(
    acceptancePathReport.gates.find((gate) => gate.gate === "protected_acceptance_tests").status,
    "satisfied"
  );

  // And once more against a populated *release* plane, which is the last plane
  // this trap was holding open. `release` is admitted to the R3 absent-plane list
  // above, and that admission proves only that the plane is touched; this drives
  // the gate all the way to `satisfied`, past the status classification, the two
  // criteria guards, the release-intent comparison and the coverage quantifier —
  // none of which any absent-plane pass can reach. An admission with no populated
  // witness is an admission nothing witnesses.
  const populatedReleaseReads = [];
  const releaseReport = deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [entry(PASSING_R2.items)],
    reviews: PASSING_R2.reviews,
    change: tripwire(populatedReleaseReads, {
      // `chg_tripwire`, because the gate compares the plan's own `changeId`
      // against the change being shipped: a plan too degraded to name its change
      // must answer for nothing rather than for everything.
      release: { kind: "document", document: releasePlan({ changeId: "chg_tripwire" }) },
      attestations: []
    })
  });
  // `taskRuns` is there for a reason that is not this gate: supplying
  // `attestations: []` lets `independent_baseline` past its unreadable-plane arm,
  // and that gate reads the run plane to decide whether attesting now could still
  // help. Recorded rather than filtered, because a read this test hid would be a
  // read nothing pins.
  assert.deepEqual(
    [...new Set(populatedReleaseReads)].sort(),
    ["approvals", "attestations", "changeId", "deltas", "oracles", "release", "reviews", "taskRuns"]
  );
  const releaseGate = releaseReport.gates.find((gate) => gate.gate === "release_observation_plan");
  assert.equal(releaseGate.status, "satisfied");
  // The sentence, not only the status. Before this release the gate answered
  // `unevaluable` for every input whatsoever, so a status-only assertion would
  // pass against a build that checks nothing.
  assert.match(releaseGate.reason, /observes it in staging/);
  assert.match(releaseGate.reason, /a revert rollback plan with 1 criterion/);
  // Change-scoped, so the subject is the change the sentence is about.
  assert.equal(releaseGate.subjectId, "chg_tripwire");
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
  "whole_change_acceptance_evidence",
  // The flip is the claim rather than the consequence: `GATE_SCOPE` already
  // carried an entry for each of these, so changing one from `"task"` to
  // `"change"` compiles either way and nothing but this line and the one beside
  // it in `ship-gates.ts` records the decision.
  "approved_spec_and_oracle",
  // Added with the attestation plane. An `Attestation` is keyed by `changeId`,
  // there is at most one per kind per change, and its `covers` array names which
  // of the change's tasks it speaks for — so all three answer once for the
  // change. Left `"task"` they would repeat one sentence per criterion-task
  // under a `subjectId` naming a task the sentence is not about.
  "independent_baseline",
  "security_or_e2e_evaluator",
  "rollback_or_forward_fix_evidence",
  // Added with the review-domain producer, and the flip is again the claim: both
  // of this gate's producers answer for the change — an attestation keyed by
  // `(changeId, kind)`, and a review verdict quantified over every deriving task
  // — so left `"task"` it would repeat one change-level sentence per
  // criterion-task under a `subjectId` naming a task the sentence is not about.
  "architecture_or_security_review",
  // Added with the release plane, and the flip is again the claim rather than the
  // consequence: there is exactly one release.json per change, its `taskRefs` are
  // quantified over every deriving task, and the alternative producer is an
  // attestation keyed by `(changeId, kind)`. Left `"task"` it would repeat one
  // change-level sentence per criterion-task under a `subjectId` naming a task the
  // sentence is not about.
  "release_observation_plan"
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
