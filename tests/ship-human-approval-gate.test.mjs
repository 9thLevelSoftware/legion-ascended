import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveShipGates } from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `explicit_human_approval`, after it stopped answering from an accepted review.
 *
 * The defect this whole file exists for: the gate shared a `case` arm with
 * `lightweight_independent_review` and `task_level_independent_review`, all
 * three returning `hasAcceptedReview(reviews, taskId)`. Every review Legion
 * writes records `reviewer: {kind: "tool", id: "legion-<executor>-reviewer"}`,
 * and nothing anywhere recorded who *accepted* one — so the gate reported that a
 * human had approved a change on which no human identity existed in any
 * artifact. It could not fail: the row that satisfied "an independent review
 * exists" satisfied "a human approved", and R3's strictest gate was the
 * cheapest one to pass.
 *
 * Every approval below is parsed through the real `approvalSchema` before it is
 * used. A fixture the schema would reject tests less than it appears to, and
 * this document has at least three ways to be quietly wrong — a missing
 * `decisionReason`, a `decidedAt` before `requestedAt`, an idempotency key that
 * is not in the required project:change:task:run:effect:hash form — each of
 * which would leave a green test asserting over a shape that can never exist on
 * disk.
 */

const TASK_ID = "tsk_human-approval-task";
const OTHER_TASK_ID = "tsk_some-other-task";
const CHANGE_ID = "chg_human-approval-change";
const OTHER_CHANGE_ID = "chg_some-other-change";
const DECIDED_AT = "2026-08-01T12:00:00.000Z";
const LATER = "2026-08-02T12:00:00.000Z";
/**
 * Review ids are `rev_` plus at least four characters — `reviewIdSchema`
 * refuses `rev_1`, and the approval fixtures below are parsed, so a short id
 * would fail the fixture assertion rather than the gate.
 */
const REVIEW_ID = "rev_human-approval-1";
const SECOND_REVIEW_ID = "rev_human-approval-2";
/** The bytes the approvals below were granted against. */
const REVIEW_BYTES = "accepted review bytes";

const { approvalSchema, reviewDecisionSchema, LEGION_PROTOCOL_VERSION, buildIdempotencyKey } = await import(
  "../packages/protocol/dist/index.js"
);
const { hashContent } = await import("../packages/artifacts/dist/index.js");

const IDEMPOTENCY_KEY = buildIdempotencyKey({
  projectId: "prj_human-approval",
  changeId: CHANGE_ID,
  taskId: TASK_ID,
  runId: "run_human-approval-task-attempt-1",
  effectKind: "workflow.review.accept",
  targetHash: hashContent(REVIEW_BYTES)
});

/** A schema-valid approval, defaulting to the shape `review --accept` writes. */
function approval(overrides = {}) {
  const { targetTaskId = TASK_ID, targetReviewId = REVIEW_ID, ...rest } = overrides;
  const document = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: DECIDED_AT,
    kind: "approval",
    id: "apv_human-approval-change-approval-1",
    projectId: "prj_human-approval",
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    runId: "run_human-approval-task-attempt-1",
    requestedBy: { kind: "tool", id: "legion-review", displayName: "Legion Review Gate" },
    requestedAt: DECIDED_AT,
    scope: {
      effectClass: "S1",
      action: "workflow.review.accept",
      targets: [
        { kind: "task", id: targetTaskId },
        { kind: "review", id: targetReviewId },
        { kind: "change", id: CHANGE_ID }
      ]
    },
    idempotencyKey: IDEMPOTENCY_KEY,
    status: "granted",
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt: DECIDED_AT,
    decisionReason: "dasbl accepted this task's review.",
    ...rest
  };
  const parsed = approvalSchema.safeParse(document);
  assert.equal(parsed.success, true, `fixture rejected by approvalSchema: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

function task(tier) {
  return { id: "ctr_human-approval-task", risk: { tier, reasons: ["test"] } };
}

/**
 * The review and evidence fixtures stay structurally minimal — the smallest
 * shapes `deriveShipGates` reads — matching the convention in
 * tests/ship-risk-gates.test.mjs. The approvals do not, because the gate reads
 * nine different fields off them and their validity is the thing under test.
 *
 * `reference.sha256` is the one place the minimal review fixture is not a
 * simplification. The gate compares the hash the approval was granted against
 * with the hash of the review as it is now, so a fixture without one would take
 * every assertion below down the "cannot be compared" path and report
 * `unevaluable` for reasons unrelated to what each test is about.
 */
function acceptedReview(overrides = {}) {
  const { bytes = REVIEW_BYTES, ...rest } = overrides;
  return {
    document: { id: REVIEW_ID, status: "accepted", taskId: TASK_ID, supersedes: [], ...rest },
    reference: {
      path: `.legion/project/changes/${CHANGE_ID}/reviews/${REVIEW_ID}.json`,
      sha256: hashContent(bytes)
    }
  };
}

function gate(input) {
  const report = deriveShipGates({
    tasks: [task("R3")],
    taskIdFor: () => TASK_ID,
    entries: [{ evidence: { id: "evd_1", taskId: TASK_ID, items: [] }, acceptance: { status: "accepted" } }],
    reviews: input.reviews ?? [acceptedReview()],
    ...(input.change === undefined ? {} : { change: input.change })
  });
  return report.gates.find((entry) => entry.gate === "explicit_human_approval");
}

function facts(approvals, overrides = {}) {
  return {
    changeId: CHANGE_ID,
    approvals,
    // Later than every fixture instant above, so an approval with no expiry is
    // unaffected and one with an expiry is decided by its own timestamp rather
    // than by whichever clock the suite happened to run under.
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    verifyPin: () => "unverified",
    ...overrides
  };
}

test("an accepted review alone no longer satisfies the human-approval gate", () => {
  // The exact regression. Before the split this fixture — an accepted review and
  // nothing else — reported `satisfied`, which is the fail-open. It must now
  // report that the plane holds no approval for this task, and it must report it
  // as absence rather than as a negative: nobody was asked, which is not the
  // same as somebody saying no.
  const result = gate({ change: facts([]) });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /No approval records anyone accepting this task's review/);
});

test("an unreadable approvals plane is unevaluable, never satisfied", () => {
  // `undefined` is what `legion ship` passes when the approvals directory would
  // not read or the listing dropped an entry. A dropped file is as likely to be
  // a revocation as a grant, so the only safe reading of a broken plane is that
  // nothing about it is known.
  const result = gate({ change: facts(undefined) });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /could not be read/);
});

test("a change with no facts at all is unevaluable, not satisfied", () => {
  // The degraded path: `legion ship` could not load the change, so it derived
  // gates with no facts. The absent-fact invariant has to hold through the
  // runtime guard too, not just through a well-formed facts object.
  const result = gate({});
  assert.equal(result.status, "unevaluable");
});

test("a granted approval decided by a human satisfies the gate and names who decided", () => {
  const result = gate({ change: facts([approval()]) });
  assert.equal(result.status, "satisfied");
  assert.match(result.reason, /dasbl/);
});

test("an approval granted for a different task does not satisfy this one", () => {
  // Approvals are per task and the gate is derived per task. Matching only on
  // "an approval exists for this change" would let one approved task carry every
  // other task in a multi-task change.
  const result = gate({ change: facts([approval({ targetTaskId: OTHER_TASK_ID })]) });
  assert.equal(result.status, "unevaluable");
});

test("an approval for a different action does not satisfy the review-acceptance gate", () => {
  // `legion approve spec` and `legion approve oracle` will write approvals into
  // the same directory. An action match that was loose — a prefix, a substring,
  // a missing check — would let a delta-spec approval answer a question about
  // who accepted a review.
  const result = gate({
    change: facts([approval({ scope: { effectClass: "S1", action: "spec.delta.approve", targets: [{ kind: "task", id: TASK_ID }] } })])
  });
  assert.equal(result.status, "unevaluable");
});

test("a granted approval decided by a tool is unsatisfied, not satisfied", () => {
  // Membership in the project's decision owners is not proof of humanity:
  // `actorSchema.kind` admits tool, worker, system and runtime, and a project
  // may legitimately record an automation actor as an owner. A grant by one is a
  // recorded negative for a gate whose entire question is humanity.
  const result = gate({
    change: facts([approval({ decidedBy: { kind: "tool", id: "release-bot" } })])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /granted by tool release-bot/);
});

test("a revoked approval is unsatisfied, so withdrawing one blocks the ship", () => {
  // The revocation is a later revision of the same document, so the approval the
  // gate finds *is* the revocation. There is no second record to correlate and
  // therefore no second record to lose.
  const result = gate({
    change: facts([
      approval({
        status: "revoked",
        decidedAt: "2026-08-02T12:00:00.000Z",
        decisionReason: "Withdrawn after the change was rebuilt."
      })
    ])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /revoked/);
});

test("a denied approval is unsatisfied", () => {
  const result = gate({
    change: facts([approval({ status: "denied", decisionReason: "The change is not ready to ship." })])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /denied/);
});

test("an approval requested and not yet decided is unevaluable, not unsatisfied", () => {
  // A pending decision is the absence of a decision. Reporting it as a negative
  // would tell the operator that somebody refused, when the truth is that
  // nobody has answered yet — a different problem with a different fix.
  const result = gate({
    change: facts([approval({ status: "requested", decidedBy: undefined, decidedAt: undefined, decisionReason: undefined })])
  });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /requested/);
});

test("a review accepted by a non-human beats a live grant, and the order is deliberate", () => {
  // A recorded negative about this task's own accept transition is a stronger
  // statement than a grant recorded elsewhere on the change: it says the human
  // step was performed, by something that is not a human. Checked first for that
  // reason. Unreachable through `legion review`, which refuses a non-human
  // approver before writing anything — this defends against artifacts written by
  // a host, by hand, or by a verb that does not exist yet.
  const result = gate({
    reviews: [acceptedReview({ acceptedBy: { kind: "tool", id: "legion-auto-accepter" }, acceptedAt: DECIDED_AT })],
    change: facts([approval()])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /accepted by tool legion-auto-accepter/);
});

test("a review decision written before acceptedBy existed still parses, and leaves the gate unevaluable", async () => {
  // The back-compat claim, asserted against a real document rather than a
  // hand-shaped stand-in. Every review artifact committed before this release
  // lacks `acceptedBy` and `acceptedAt`; had either been made required,
  // `readReviewDecision` would fail to parse them and `legion ship` would report
  // a broken change instead of an older one — the worst failure available to a
  // command whose job is honest reporting.
  //
  // The second half matters as much as the first: an older accepted review must
  // leave the gate `unevaluable`, not `satisfied`. That is the fail-open closing
  // in the one direction it can actually bite — on changes that already exist.
  const legacyReview = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: DECIDED_AT,
    kind: "review",
    id: "rev_legacy-review-1",
    projectId: "prj_human-approval",
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    runId: "run_human-approval-task-attempt-1",
    reviewer: { kind: "tool", id: "legion-fake-reviewer", displayName: "Legion Review Gate" },
    verdicts: { specification: "pass", integration: "pass", evidence: "pass" },
    confidence: "high",
    findings: [],
    supersedes: [],
    status: "accepted",
    submittedAt: DECIDED_AT,
    updatedAt: DECIDED_AT
  };
  const parsed = reviewDecisionSchema.safeParse(legacyReview);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.acceptedBy, undefined);

  const result = gate({ reviews: [{ document: parsed.data }], change: facts([]) });
  assert.equal(result.status, "unevaluable");
});

// --- supersession: two documents, one decision -----------------------------

// Legion stores one approval per (change, action, task) and re-decides it in
// place, so its own writer cannot produce a grant and a revocation as separate
// files. The gate's threat model is wider than its writer — the doc comment says
// so — and `writeApproval` will persist any document whose id matches its own
// filename, so a second file is a shape that reaches the gate. The first draft
// of this gate returned `satisfied` from the first granted-by-human record it
// saw, so a revocation dated a day later was outranked by list order, and the
// verdict did not change when the two were listed the other way round: the
// revocation was never consulted at all.

const REVOKED = {
  id: "apv_human-approval-change-approval-2",
  status: "revoked",
  decisionReason: "Withdrawn after the change was rebuilt."
};

test("a revocation later than the grant blocks, in either listing order", () => {
  const granted = approval({ decidedAt: DECIDED_AT });
  const revoked = approval({ ...REVOKED, decidedAt: LATER });

  for (const plane of [[granted, revoked], [revoked, granted]]) {
    const result = gate({ change: facts(plane) });
    assert.equal(result.status, "unsatisfied", JSON.stringify(plane.map((entry) => entry.status)));
    assert.match(result.reason, /is revoked, and no later grant supersedes it/);
  }
});

test("a denial later than the grant blocks too", () => {
  // Same defect, different member. `denied` and `revoked` are separate statuses
  // and a check written against one of them by name leaves the other outranked.
  const result = gate({
    change: facts([
      approval({ decidedAt: DECIDED_AT }),
      approval({ ...REVOKED, status: "denied", decidedAt: LATER, decisionReason: "Not ready to ship." })
    ])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /is denied/);
});

test("a grant strictly later than a revocation supersedes it", () => {
  // The other direction, and the reason the check is an ordering rather than
  // "any negative anywhere blocks". Re-approving after a revocation is a real
  // sequence, and a gate that could never recover from a withdrawn approval
  // would push operators to delete artifacts to unblock a ship — which is the
  // one thing an audit trail must not reward.
  const result = gate({
    change: facts([
      approval({ ...REVOKED, decidedAt: DECIDED_AT }),
      approval({ decidedAt: LATER })
    ])
  });
  assert.equal(result.status, "satisfied");
  assert.match(result.reason, /dasbl/);
});

test("a revocation decided at the same instant as the grant leaves the grant blocked", () => {
  // Equal timestamps cannot be ordered, and an unorderable pair is not evidence
  // that the grant came second. The boundary belongs to the blocking side.
  const result = gate({
    change: facts([approval({ decidedAt: DECIDED_AT }), approval({ ...REVOKED, decidedAt: DECIDED_AT })])
  });
  assert.equal(result.status, "unsatisfied");
});

// --- expiry ----------------------------------------------------------------

test("a granted approval whose expiry has passed is unsatisfied, not satisfied forever", () => {
  // `expiresAt` was accepted by the schema, written by nothing, and read by
  // nobody, so a time-boxed grant would have satisfied this gate for the rest of
  // the change's life. `approvalStatusSchema` carries an `expired` member, but
  // nothing transitions a document into it, so the status field cannot stand in
  // for the comparison.
  const result = gate({
    change: facts([approval({ expiresAt: LATER })])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /expired at 2026-08-02/);
});

test("an expiry with no clock to check it against is unevaluable, never satisfied", () => {
  // The evaluator is synchronous and pure and takes its instant from the caller,
  // so a caller with no clock leaves the grant's current validity unestablished.
  // The invariant this whole seam is built on is that an unestablished fact is
  // never worth a `satisfied`.
  const result = gate({
    change: facts([approval({ expiresAt: LATER })], { evaluatedAt: undefined })
  });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /no clock/);
});

test("a granted approval whose expiry is still ahead satisfies the gate", () => {
  // The inverse of the two above. Without it, refusing every approval that
  // carries an expiry would pass both of them while making the field unusable.
  const result = gate({
    change: facts([approval({ expiresAt: "2026-09-01T00:00:00.000Z" })])
  });
  assert.equal(result.status, "satisfied");
});

// --- the grant has to still be about the review it approved -----------------

// Without these, `explicit_human_approval: satisfied` is unfalsifiable by any
// later state of the tree. `rejectLatestReview` does not revoke the approval,
// re-reviewing writes a superseding review the approval has never seen, and the
// approval's own `artifacts` pin array is deliberately left unwritten — so the
// only link between the decision and the bytes it was made about is the
// idempotency key's target hash and the review target in `scope.targets`.

test("an approval whose review is no longer accepted is unsatisfied", () => {
  // The sequence that motivated this: accept with an approver, find a defect,
  // reject. The review flips and the approval file is untouched, so the gate
  // used to keep reporting that dasbl accepted work dasbl had rejected — masked
  // only by the two independent-review gates going unsatisfied beside it.
  const result = gate({
    reviews: [acceptedReview({ status: "rejected" })],
    change: facts([approval()])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /which is now rejected/);
});

test("an approval whose review has since been superseded is unsatisfied", () => {
  // Rejecting after an accept is refused (`latestSubmittedReviews` finds nothing
  // in `submitted`), so the reachable form of the same staleness is: accept,
  // review again, reject the new one. The first review stays `accepted` on disk
  // and the grant stays granted. `supersedes` is written by the review gate and
  // is a recorded link, not a timestamp guess.
  const result = gate({
    reviews: [
      acceptedReview(),
      {
        document: { id: SECOND_REVIEW_ID, status: "rejected", taskId: TASK_ID, supersedes: [REVIEW_ID] },
        reference: { path: `.legion/project/changes/${CHANGE_ID}/reviews/${SECOND_REVIEW_ID}.json`, sha256: hashContent("second cycle") }
      }
    ],
    change: facts([approval()])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, new RegExp(`${SECOND_REVIEW_ID} has since superseded`));
});

test("an approval granted against different bytes of the same review is unsatisfied", () => {
  // The review keeps its id and its accepted status while its content changes —
  // a hand edit, a host, a verb that rewrites in place. The id link alone would
  // still report satisfied; the hash is what makes "approved" survive a mutable
  // working tree.
  const result = gate({
    reviews: [acceptedReview({ bytes: "rewritten review bytes" })],
    change: facts([approval()])
  });
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /rewritten since/);
});

test("an approval that names no review at all is unevaluable, not satisfied", () => {
  // `legion review --accept` always names the review, so this is the shape a
  // host or a hand-written file takes. Nothing says what it was about, and the
  // honest answer to "is it still about the current review" is that nothing
  // says — which is absence, not a negative and certainly not a pass.
  const result = gate({
    change: facts([
      approval({
        scope: {
          effectClass: "S1",
          action: "workflow.review.accept",
          targets: [{ kind: "task", id: TASK_ID }]
        }
      })
    ])
  });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /names no review/);
});

test("an approval naming a review that is not in the readable set is unevaluable", () => {
  // `listReviewDecisionsForChange` skips reviews it cannot read and still
  // reports success, so a named review can be missing because the file is
  // broken rather than because it never existed. Both are absence; neither is a
  // grant.
  const result = gate({ change: facts([approval({ targetReviewId: "rev_never-written" })]) });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /not among this task's readable reviews/);
});

// --- the gate scopes its own reads ------------------------------------------

test("an approval filed under another change does not answer this change's gate", () => {
  // Change scoping rested entirely on the loader listing one directory.
  // `readApproval` refuses a document whose `changeId` disagrees with its path,
  // which keeps the current loader honest — but a bundle reader or a
  // release-scoped gate assembling the plane from more than one change would
  // hand this function records it must not read, and it had no defence of its
  // own.
  const result = gate({ change: facts([approval({ changeId: OTHER_CHANGE_ID })]) });
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /No approval records anyone accepting this task's review/);
});

test("an approval whose two task claims disagree is read as naming neither", () => {
  // `writeApproval` cross-checks nothing between the top-level `taskId` and
  // `scope.targets`, so a document claiming one task in its header and another
  // in its scope is persistable. It says two things; the gate reads neither.
  const result = gate({ change: facts([approval({ taskId: OTHER_TASK_ID })]) });
  assert.equal(result.status, "unevaluable");
});

test("the split did not take the two independent-review gates with it", () => {
  // Those two ask whether something other than the implementer looked at the
  // work, which an accepted review does answer. If the split had moved them onto
  // the approval plane, every R1 and R2 change in the tree would have gone
  // unevaluable overnight — a far larger behaviour change than the one this work
  // intends, and one no other test in this file would have caught.
  for (const [tier, gateId] of [
    ["R1", "lightweight_independent_review"],
    ["R2", "task_level_independent_review"]
  ]) {
    const report = deriveShipGates({
      tasks: [task(tier)],
      taskIdFor: () => TASK_ID,
      entries: [{ evidence: { id: "evd_1", taskId: TASK_ID, items: [] }, acceptance: { status: "accepted" } }],
      reviews: [acceptedReview()],
      change: facts([])
    });
    const found = report.gates.find((entry) => entry.gate === gateId);
    assert.equal(found.status, "satisfied", gateId);
  }
});
