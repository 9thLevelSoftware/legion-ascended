import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveShipGates,
  isLiveDeltaSpecGrant,
  shipGateDiagnostics
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `approved_delta_spec`, the first of the ten producerless gates to gain one.
 *
 * The defect this file exists for: the gate fell through `evaluateGate`'s
 * `default:` arm and reported "Legion does not yet produce evidence for this
 * gate" for every R2 change — which is honest, and is also why every R2 change
 * was structurally unshippable. Nothing approved a delta spec, so nothing could
 * ever answer it. It now reads the approval plane, and every test below exists
 * because some way of reading that plane would answer `satisfied` about work
 * nobody approved.
 *
 * Two conventions carried over from tests/ship-human-approval-gate:
 *
 *  - **Every approval and every delta entry is parsed through its real schema
 *    before it is used.** A fixture the schema would reject tests less than it
 *    appears to, and both documents here have several ways to be quietly wrong:
 *    a `decidedAt` before `requestedAt`, a requirement id that is not a slug, an
 *    idempotency key in neither admitted form, an `artifacts` array that is
 *    present and empty.
 *  - **The gate is derived at R2 and only at R2.** `DEFAULT_RISK_POLICY` lists
 *    `approved_delta_spec` at R2 and not at R3, so an R3 fixture makes
 *    `report.gates.find(...)` return `undefined` and every assertion below pass
 *    vacuously.
 */

const CHANGE_ID = "chg_delta-spec-change";
const OTHER_CHANGE_ID = "chg_some-other-change";
const PROJECT_ID = "prj_delta-spec";
const TASK_ID = "tsk_delta-spec-task";
const REQ_ONE = "req_editor-saves-metadata";
const REQ_TWO = "req_editor-loads-metadata";
const DECIDED_AT = "2026-08-01T12:00:00.000Z";
const LATER = "2026-08-02T12:00:00.000Z";
const EVALUATED_AT = "2026-08-10T00:00:00.000Z";

const { approvalSchema, LEGION_PROTOCOL_VERSION, buildChangeIdempotencyKey, buildIdempotencyKey } = await import(
  "../packages/protocol/dist/index.js"
);
const { changeBundleDeltaEntrySchema, hashContent } = await import("../packages/artifacts/dist/index.js");

const SPEC_BYTES = {
  [REQ_ONE]: "# modify: req_editor-saves-metadata\n",
  [REQ_TWO]: "# modify: req_editor-loads-metadata\n"
};

function deltaSpecPath(requirementId) {
  return `.legion/project/changes/${CHANGE_ID}/delta-specs/${requirementId}.md`;
}

/** One `bundle.deltas[]` entry, in the shape `createChangeBundle` writes. */
function delta(requirementId, overrides = {}) {
  const parsed = changeBundleDeltaEntrySchema.safeParse({
    operation: "modify",
    requirementId,
    path: deltaSpecPath(requirementId),
    delta: {
      path: deltaSpecPath(requirementId),
      sha256: hashContent(SPEC_BYTES[requirementId]),
      mediaType: "text/markdown"
    },
    ...overrides
  });
  assert.equal(parsed.success, true, `delta fixture rejected: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

/** A schema-valid approval, defaulting to the shape `legion approve spec` writes. */
function approval(requirementId, overrides = {}) {
  const { pinnedBytes = SPEC_BYTES[requirementId], ...rest } = overrides;
  const document = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: DECIDED_AT,
    updatedAt: DECIDED_AT,
    kind: "approval",
    id: `apv_delta-spec-change-approval-${requirementId === REQ_ONE ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb"}`,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    requestedBy: { kind: "human", id: "dasbl" },
    requestedAt: DECIDED_AT,
    scope: {
      effectClass: "S1",
      action: "spec.delta.approve",
      targets: [
        { kind: "requirement", id: requirementId },
        { kind: "change", id: CHANGE_ID }
      ]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      effectKind: "spec.delta.approve",
      targetHash: hashContent(SPEC_BYTES[requirementId])
    }),
    artifacts: [
      {
        path: deltaSpecPath(requirementId),
        sha256: hashContent(pinnedBytes),
        mediaType: "text/markdown"
      }
    ],
    status: "granted",
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt: DECIDED_AT,
    decisionReason: `dasbl approved the delta spec for ${requirementId}.`,
    ...rest
  };
  const parsed = approvalSchema.safeParse(document);
  assert.equal(parsed.success, true, `fixture rejected by approvalSchema: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

function task(tier = "R2") {
  return { id: "ctr_delta-spec-task", risk: { tier, reasons: ["test"] } };
}

/**
 * A pin verifier driven per path, so `match`, `drift`, `missing` and
 * `unverified` can each be produced deliberately.
 *
 * The default is `match` for every path the change carries, because the
 * everyday case is a working tree that still holds what was approved, and a
 * default of `unverified` would send every unrelated test down the "not checked"
 * branch and hide whatever it was actually asserting.
 */
function pins(overrides = {}) {
  return (reference) => overrides[reference.path] ?? "match";
}

function facts(approvals, deltas, overrides = {}) {
  return {
    changeId: CHANGE_ID,
    approvals,
    deltas,
    // Later than every fixture instant above, so an approval with no expiry is
    // unaffected and one with an expiry is decided by its own timestamp rather
    // than by whichever clock the suite happened to run under.
    evaluatedAt: EVALUATED_AT,
    verifyPin: pins(),
    ...overrides
  };
}

function gate(change, tier = "R2") {
  const report = deriveShipGates({
    tasks: [task(tier)],
    taskIdFor: () => TASK_ID,
    entries: [{ evidence: { id: "evd_1", taskId: TASK_ID, items: [] }, acceptance: { status: "accepted" } }],
    reviews: [{ document: { id: "rev_delta-spec-1", status: "accepted", taskId: TASK_ID, supersedes: [] } }],
    ...(change === undefined ? {} : { change })
  });
  return report.gates.find((entry) => entry.gate === "approved_delta_spec");
}

// --- absence, in all the shapes it arrives in --------------------------------

test("a change with no facts at all is unevaluable, not satisfied", () => {
  // The degraded path: `legion ship` could not load the change, so it derived
  // gates with no facts. This is also the shape every compiled unit suite in the
  // tree calls `deriveShipGates` with, and the invariant the whole seam rests on
  // — an absent fact yields unevaluable, never satisfied — has to hold through
  // the runtime guard, not only through a well-formed facts object.
  const result = gate(undefined);
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /delta specs recorded for this change could not be read/);
});

test("a change whose bundle would not load is unevaluable, in the same words", () => {
  // `ship.ts` passes `deltas: bundle?.deltas`, so a bundle that failed to read
  // arrives as `undefined` rather than as an empty list. It must produce the
  // same sentence as no facts at all: tests/ship-risk-gates asserts that an
  // absent plane is worth no more than no facts, and a second wording here would
  // make that claim depend on which of two identical situations occurred.
  const withoutFacts = gate(undefined);
  const withEmptyPlane = gate(facts([], undefined));
  assert.equal(withEmptyPlane.status, "unevaluable");
  assert.equal(withEmptyPlane.reason, withoutFacts.reason);
});

test("a change recording no delta specs is unevaluable, not vacuously satisfied", () => {
  // `changeBundleSchema` marks `deltas` `.min(1)`, so an empty list cannot come
  // from a bundle that loaded — but that is another module's invariant, this
  // gate's parameter type admits `[]`, and `[].every(...)` is `true`. The
  // fail-open here would be produced by a shape rather than by a mistake, which
  // is exactly the kind that survives review.
  const result = gate(facts([], []));
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /records no delta specs/);
});

test("an unreadable approvals plane is unevaluable, never satisfied", () => {
  // `undefined` is what `legion ship` passes when the approvals directory would
  // not read or the listing dropped an entry. A dropped file is as likely to be
  // a revocation as a grant, so nothing may be concluded from what was kept.
  const result = gate(facts(undefined, [delta(REQ_ONE)]));
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /approvals recorded for this change could not be read/);
});

test("a change with no approvals directory reports unevaluable, not satisfied", () => {
  // The back-compat case, and the one that decides whether this release breaks
  // every change already on disk. `listApprovalsForChange` returns `[]` — not a
  // failure — when `approvals/` does not exist, which is what every change
  // planned before this release looks like. Reading that as "nothing objected,
  // so it is approved" would satisfy the gate on every historical change at
  // once; reading it as a negative would report that somebody refused. It is
  // absence, and absence blocks while naming what is missing.
  const result = gate(facts([], [delta(REQ_ONE)]));
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, new RegExp(`No approval records anyone approving the delta spec for ${REQ_ONE}`));
});

// --- the positive case, and what makes it positive ---------------------------

test("a granted, pin-clean approval satisfies the gate and names who decided", () => {
  const result = gate(facts([approval(REQ_ONE)], [delta(REQ_ONE)]));
  assert.equal(result.status, "satisfied");
  assert.match(result.reason, /dasbl/);
  assert.match(result.reason, new RegExp(REQ_ONE));
});

test("the satisfied path requires the pin to verify as match, not merely to exist", () => {
  // `resolvePinnedReferences` answers `unverified` for any path nobody
  // pre-resolved, and `legion ship` pre-resolves only `bundle.deltas[].delta`
  // and the oracle references. A wiring regression there — a collector dropped,
  // a path spelled differently — turns every pin `unverified` and this gate
  // permanently `unevaluable`, which looks identical to "nobody approved
  // anything". Asserting `match` rather than "not unsatisfied" is what tells
  // those two apart.
  const verified = [];
  const result = gate(
    facts([approval(REQ_ONE)], [delta(REQ_ONE)], {
      verifyPin: (reference) => {
        verified.push(reference.path);
        return "match";
      }
    })
  );
  assert.equal(result.status, "satisfied");
  assert.deepEqual(verified, [deltaSpecPath(REQ_ONE)]);
});

// --- coverage is over the deltas, not over the approvals ---------------------

test("approving one of two requirements does not satisfy the gate", () => {
  // The defect this closes is a loop written the other way round. "Every
  // approval is clean" is trivially true when zero of five requirements are
  // approved, and it reads identically to "every requirement is approved" at a
  // glance — both spell out as "check the approvals". The loop runs over
  // `deltas`, so a requirement with no approval is a hole rather than a silence.
  const result = gate(facts([approval(REQ_ONE)], [delta(REQ_ONE), delta(REQ_TWO)]));
  assert.notEqual(result.status, "satisfied");
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, new RegExp(`No approval records anyone approving the delta spec for ${REQ_TWO}`));
});

test("a requirement added after the others were approved is a hole, not an exemption", () => {
  // The same rule from the direction it actually arrives from: the approvals are
  // all valid and all clean, and the change has grown a delta nobody has looked
  // at. Iterating approvals would report satisfied here, and the operator would
  // ship a specification nobody read.
  const result = gate(
    facts([approval(REQ_ONE), approval(REQ_TWO)], [delta(REQ_ONE), delta(REQ_TWO)])
  );
  assert.equal(result.status, "satisfied");

  const grown = gate(facts([approval(REQ_ONE), approval(REQ_TWO)], [delta(REQ_ONE), delta(REQ_TWO), delta(REQ_ONE, {
    requirementId: "req_editor-deletes-metadata",
    path: `.legion/project/changes/${CHANGE_ID}/delta-specs/req_editor-deletes-metadata.md`,
    delta: {
      path: `.legion/project/changes/${CHANGE_ID}/delta-specs/req_editor-deletes-metadata.md`,
      sha256: hashContent("# modify: req_editor-deletes-metadata\n"),
      mediaType: "text/markdown"
    }
  })]));
  assert.equal(grown.status, "unevaluable");
  assert.match(grown.reason, /req_editor-deletes-metadata/);
});

test("a negative on one requirement beats an absence on another", () => {
  // Aggregation order. A revoked approval is the more actionable fact and the
  // one the operator has to answer; reporting the absence instead would send
  // them to approve a requirement while the withdrawal stayed invisible. The
  // count is appended so fixing the named one does not come as a surprise when
  // the gate still blocks.
  const result = gate(
    facts(
      [approval(REQ_TWO, { status: "revoked", decidedAt: LATER, decisionReason: "Withdrawn after review." })],
      [delta(REQ_ONE), delta(REQ_TWO)]
    )
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /is revoked/);
  assert.match(result.reason, /2 of 2 delta specs in this change are unmet/);
});

// --- the pin: what "approved" is a statement about --------------------------

test("an approval pinning bytes the change does not ship is unsatisfied", () => {
  // The only form of this staleness that is reachable through the CLI. A delta
  // spec cannot be rewritten — `legion plan` refuses to re-plan an existing
  // change and nothing else writes one — and `loadChangeBundle` refuses a bundle
  // whose delta bytes have moved, so a drifted *file* never reaches this gate.
  // A drifted *approval* does: it is schema-valid, it is what a hand edit or a
  // stale copy produces, and it says the approver was looking at text this
  // change is not shipping.
  const result = gate(
    facts([approval(REQ_ONE, { pinnedBytes: "# modify: something else entirely\n" })], [delta(REQ_ONE)])
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /granted against different bytes/);
});

test("a delta spec edited after approval is unsatisfied", () => {
  // The drift arm, driven at the seam where it is reachable. End to end this
  // state cannot be produced: editing the delta spec makes `loadChangeBundle`
  // fail with `delta_artifact_mismatch`, so `legion ship` dies at change
  // discovery before any gate is derived — tests/cli-approve-spec asserts that
  // and says so. The arm stays because a gate must not inherit its central truth
  // claim from another module's invariant: `verifyPin` answering `drift` means
  // the bytes on disk are not the bytes approved, and the only correct verdict
  // for that is a negative one.
  const result = gate(
    facts([approval(REQ_ONE)], [delta(REQ_ONE)], {
      verifyPin: pins({ [deltaSpecPath(REQ_ONE)]: "drift" })
    })
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /bytes have changed since it was granted/);
});

test("an approved delta spec that is no longer on disk is unsatisfied", () => {
  // A pin asserts the file existed at that digest. Its absence is a negative
  // answer, not an unchecked one — folding `missing` into `unverified` would
  // report a deleted specification as "not checked" and block for the wrong
  // reason, which is the reason the operator would then chase.
  const result = gate(
    facts([approval(REQ_ONE)], [delta(REQ_ONE)], {
      verifyPin: pins({ [deltaSpecPath(REQ_ONE)]: "missing" })
    })
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /no longer present/);
});

test("a pin nobody hashed is unevaluable, never satisfied", () => {
  // `unverified` is what `resolvePinnedReferences` answers for a path no
  // collector gathered. Reading it as clean is the fail-open; reading it as
  // `missing` blames the artifact for the reader's problem. It means the
  // comparison was not made.
  const result = gate(
    facts([approval(REQ_ONE)], [delta(REQ_ONE)], {
      verifyPin: pins({ [deltaSpecPath(REQ_ONE)]: "unverified" })
    })
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /did not hash/);
});

test("an approval that pins nothing is unevaluable, not satisfied", () => {
  // `artifacts` is optional, so this is the shape of every approval written
  // before this release and of anything a host writes. Nothing says which bytes
  // were approved, and a requirement id survives every possible edit of the
  // document that specifies it — so the id link alone certifies the approval
  // rather than the artifact.
  const result = gate(facts([approval(REQ_ONE, { artifacts: undefined })], [delta(REQ_ONE)]));
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /pins no artifact/);
});

test("an approval pinning some other file does not answer for this delta spec", () => {
  // Checked here rather than left to `verifyPin` answering `unverified`. Ship
  // pre-resolves only the change's own delta specs and oracles, so a mis-pinned
  // approval would answer `unverified` today — but that makes this gate's
  // correctness depend on which paths another module happened to collect.
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          artifacts: [
            {
              path: `.legion/project/changes/${CHANGE_ID}/design.md`,
              sha256: hashContent("design"),
              mediaType: "text/markdown"
            }
          ]
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /pins no reference to/);
});

test("an approval pinning one path twice is unevaluable, not resolved by first match", () => {
  // `artifacts` carries no uniqueness constraint, so a document pinning both the
  // right hash and a wrong one is persistable. `find` would take whichever came
  // first and the verdict would depend on array order — the same class of defect
  // as reading the first granted approval in a list that also holds a
  // revocation.
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          artifacts: [
            { path: deltaSpecPath(REQ_ONE), sha256: hashContent(SPEC_BYTES[REQ_ONE]), mediaType: "text/markdown" },
            { path: deltaSpecPath(REQ_ONE), sha256: hashContent("something else"), mediaType: "text/markdown" }
          ]
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /pins 2 references/);
});

// --- the gate scopes its own reads ------------------------------------------

test("an approval filed under another change does not answer this change's gate", () => {
  // A requirement id is not change-scoped: the same `req_` id can appear in two
  // changes, and the approval target would be byte-identical in both. Change
  // scoping cannot rest on the loader having listed one directory, because a
  // bundle reader or a release-scoped gate would assemble the plane from more
  // than one.
  const result = gate(facts([approval(REQ_ONE, { changeId: OTHER_CHANGE_ID })], [delta(REQ_ONE)]));
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /No approval records anyone approving/);
});

test("a review-acceptance approval does not approve a delta spec", () => {
  // `legion review --accept` writes an approval into the same directory,
  // carrying a `{kind: "change"}` target for this change. A loose action match —
  // a prefix, a substring, a missing check — would let "somebody accepted a
  // review" answer "somebody approved this requirement's specification".
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          scope: {
            effectClass: "S1",
            action: "workflow.review.accept",
            targets: [
              { kind: "requirement", id: REQ_ONE },
              { kind: "change", id: CHANGE_ID }
            ]
          }
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /No approval records anyone approving/);
});

test("an approval naming no requirement does not approve one", () => {
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          scope: {
            effectClass: "S1",
            action: "spec.delta.approve",
            targets: [{ kind: "change", id: CHANGE_ID }]
          }
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
});

test("an approval that also claims a task or a run is reported, not silently dropped", () => {
  // `legion approve spec` writes neither field, deliberately: a delta spec
  // belongs to the change, and no run exists at all between plan and build. A
  // document carrying one was written by something else with something else in
  // mind. Filtering it away would report "nobody approved this" and send the
  // operator to create a second record beside one that already exists.
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          taskId: TASK_ID,
          runId: "run_delta-spec-task-attempt-1",
          idempotencyKey: buildIdempotencyKey({
            projectId: PROJECT_ID,
            changeId: CHANGE_ID,
            taskId: TASK_ID,
            runId: "run_delta-spec-task-attempt-1",
            effectKind: "spec.delta.approve",
            targetHash: hashContent(SPEC_BYTES[REQ_ONE])
          })
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /belongs to the change rather than to one task or run/);
});

// --- standing, supersession and expiry --------------------------------------

test("a revoked approval is unsatisfied, so withdrawing one blocks the ship", () => {
  const result = gate(
    facts(
      [approval(REQ_ONE, { status: "revoked", decidedAt: LATER, decisionReason: "Withdrawn after review." })],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /is revoked/);
});

test("a denied approval is unsatisfied", () => {
  const result = gate(
    facts([approval(REQ_ONE, { status: "denied", decisionReason: "The specification is wrong." })], [delta(REQ_ONE)])
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /is denied/);
});

test("a revocation later than the grant blocks, in either listing order", () => {
  // Legion stores one approval per (change, action, requirement) and re-decides
  // it in place, so its own writer cannot produce a grant and a revocation as
  // separate files. This gate's threat model is wider than its writer:
  // `writeApproval` persists any document whose id matches its filename, so two
  // files reach the plane, and taking the first granted record seen would let a
  // revocation dated a day later be outranked by list order.
  const granted = approval(REQ_ONE, { decidedAt: DECIDED_AT });
  const revoked = approval(REQ_ONE, {
    id: "apv_delta-spec-change-approval-cccccccccccc",
    status: "revoked",
    decidedAt: LATER,
    decisionReason: "Withdrawn after review."
  });

  for (const plane of [[granted, revoked], [revoked, granted]]) {
    const result = gate(facts(plane, [delta(REQ_ONE)]));
    assert.equal(result.status, "unsatisfied", JSON.stringify(plane.map((entry) => entry.status)));
    assert.match(result.reason, /is revoked, and no later grant supersedes it/);
  }
});

test("a grant strictly later than a revocation supersedes it", () => {
  // The other direction, and the reason this is an ordering rather than "any
  // negative anywhere blocks". Re-approving after a revocation is what `legion
  // approve spec` does on a rerun, and a gate that could never recover from a
  // withdrawn approval would push operators to delete artifacts to unblock a
  // ship.
  const result = gate(
    facts(
      [
        approval(REQ_ONE, {
          id: "apv_delta-spec-change-approval-cccccccccccc",
          status: "revoked",
          decidedAt: DECIDED_AT,
          decisionReason: "Withdrawn after review."
        }),
        approval(REQ_ONE, { decidedAt: LATER })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "satisfied");
});

test("a revocation decided at the same instant as the grant leaves the grant blocked", () => {
  // Equal timestamps cannot be ordered, and an unorderable pair is not evidence
  // the grant came second. The boundary belongs to the blocking side.
  const result = gate(
    facts(
      [
        approval(REQ_ONE, { decidedAt: DECIDED_AT }),
        approval(REQ_ONE, {
          id: "apv_delta-spec-change-approval-cccccccccccc",
          status: "revoked",
          decidedAt: DECIDED_AT,
          decisionReason: "Withdrawn."
        })
      ],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unsatisfied");
});

test("a granted approval whose expiry has passed is unsatisfied, not satisfied forever", () => {
  const result = gate(facts([approval(REQ_ONE, { expiresAt: LATER })], [delta(REQ_ONE)]));
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /expired at 2026-08-02/);
});

test("an expiry with no clock to check it against is unevaluable, never satisfied", () => {
  const result = gate(
    facts([approval(REQ_ONE, { expiresAt: LATER })], [delta(REQ_ONE)], { evaluatedAt: undefined })
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /no clock/);
});

test("a grant by a tool is unsatisfied, not satisfied", () => {
  // Membership in the project's decision owners is not proof of humanity, and
  // `legion approve spec` refuses a non-human approver before writing anything —
  // so this defends against a document a host, a hand edit or a later verb
  // produced.
  const result = gate(
    facts([approval(REQ_ONE, { decidedBy: { kind: "tool", id: "release-bot" } })], [delta(REQ_ONE)])
  );
  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /granted by tool release-bot/);
});

test("an approval requested and not yet decided is unevaluable, not unsatisfied", () => {
  // A pending decision is the absence of a decision. Reporting it as a negative
  // would say somebody refused, when nobody has answered.
  const result = gate(
    facts(
      [approval(REQ_ONE, { status: "requested", decidedBy: undefined, decidedAt: undefined, decisionReason: undefined })],
      [delta(REQ_ONE)]
    )
  );
  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /recorded as requested/);
});

// --- change scope, and the diagnostic collapse it turns on -------------------

test("the gate is change-scoped and names the change as its subject", () => {
  // `GATE_SCOPE` maps this id to "change", which is what makes `subjectId` the
  // change rather than one arbitrary task and what turns on the collapse below.
  // Asserted rather than assumed: the scope is a one-word literal in a total
  // record, and flipping it back leaves every verdict assertion in this file
  // green.
  const result = gate(facts([approval(REQ_ONE)], [delta(REQ_ONE)]));
  assert.equal(result.scope, "change");
  assert.equal(result.subjectId, CHANGE_ID);
  assert.equal(result.taskId, TASK_ID);
});

test("a change-scoped verdict falls back to the task id when there are no facts", () => {
  // Naming a task that exists beats naming a change that does not. The gate is
  // unevaluable in that case anyway.
  const result = gate(undefined);
  assert.equal(result.scope, "change");
  assert.equal(result.subjectId, TASK_ID);
});

test("a multi-task change reports one delta-spec diagnostic, not one per task", () => {
  // The collapse in `shipGateDiagnostics` gains its first production user here.
  // It cannot be witnessed end to end — every change `legion plan` can build has
  // exactly one task, so a blocked ship names the gate once with or without the
  // collapse — so the witness is this: two tasks, one change, one sentence.
  const report = deriveShipGates({
    tasks: [
      { id: "ctr_delta-spec-task", risk: { tier: "R2", reasons: ["test"] } },
      { id: "ctr_delta-spec-other", risk: { tier: "R2", reasons: ["test"] } }
    ],
    taskIdFor: (contract) => `tsk_${contract.id.slice("ctr_".length)}`,
    entries: [],
    reviews: [],
    change: facts([], [delta(REQ_ONE)])
  });

  const rows = report.gates.filter((entry) => entry.gate === "approved_delta_spec");
  // One row per (task, gate) still, because the report's counts and its `ready`
  // flag rest on that arithmetic.
  assert.equal(rows.length, 2);

  const diagnostics = shipGateDiagnostics({ gates: report.gates, path: "p" });
  const named = diagnostics.filter((entry) => entry.gate === "approved_delta_spec");
  assert.equal(named.length, 1);
  assert.match(named[0].message, new RegExp(`is not satisfied for ${CHANGE_ID}`));
});

test("R3 does not derive this gate, so an R3 fixture asserts nothing about it", () => {
  // Recorded so the next reader does not write an R3 fixture and watch every
  // assertion pass vacuously: `report.gates.find(...)` returns `undefined` and
  // `undefined?.status` is not `"satisfied"`, so a careless negative assertion
  // succeeds against a gate that was never emitted.
  assert.equal(gate(facts([], [delta(REQ_ONE)]), "R3"), undefined);
});

// --- the writer's idea of "done" against the reader's idea of "satisfied" ----

test("the predicate legion approve spec calls agrees with the gate on every shape", () => {
  // The defect: `legion approve spec` decided "already approved, nothing to
  // write" from its own rule — granted, human, no expiry, *some* pin at the
  // delta's path — which is strictly weaker than the gate's. Four document
  // shapes satisfied the writer and failed the reader, and in each of them
  // `legion ship` blocked on `approved_delta_spec` while `legion approve spec`
  // exited 0 reporting the change fully approved and writing nothing. With no
  // `--force` anywhere, no command could repair them: a no-route-out loop
  // created by the verb whose recovery entry exists to prevent one.
  //
  // The fix is that `isLiveDeltaSpecGrant` runs the gate rather than
  // paraphrasing it, so the two cannot disagree by construction. This test is
  // what holds that: it drives both over the same documents and fails if any
  // shape is accepted by one and rejected by the other. Reverting the predicate
  // to the old inline rule fails on the first four rows.
  const target = delta(REQ_ONE);
  const shapes = [
    ["the shape legion approve spec writes", approval(REQ_ONE)],
    [
      "one path pinned twice",
      approval(REQ_ONE, {
        artifacts: [
          { path: deltaSpecPath(REQ_ONE), sha256: hashContent(SPEC_BYTES[REQ_ONE]), mediaType: "text/markdown" },
          { path: deltaSpecPath(REQ_ONE), sha256: hashContent("something else entirely\n"), mediaType: "text/markdown" }
        ]
      })
    ],
    ["a stray taskId", approval(REQ_ONE, { taskId: TASK_ID })],
    ["a foreign scope.action", approval(REQ_ONE, { scope: { ...approval(REQ_ONE).scope, action: "workflow.review.accept" } })],
    [
      "a requirement target naming something else",
      approval(REQ_ONE, {
        scope: {
          ...approval(REQ_ONE).scope,
          targets: [{ kind: "requirement", id: REQ_TWO }, { kind: "change", id: CHANGE_ID }]
        }
      })
    ],
    ["a revoked decision", approval(REQ_ONE, { status: "revoked", decisionReason: "Withdrawn by hand." })],
    ["a denied decision", approval(REQ_ONE, { status: "denied", decisionReason: "Not this text." })],
    ["a grant by a tool", approval(REQ_ONE, { decidedBy: { kind: "tool", id: "legion-reviewer" } })],
    ["a lapsed grant", approval(REQ_ONE, { expiresAt: "2026-08-05T00:00:00.000Z" })],
    ["a grant pinning bytes the change does not ship", approval(REQ_ONE, { pinnedBytes: "# modify: something else\n" })],
    ["a grant filed under another change", approval(REQ_ONE, { changeId: OTHER_CHANGE_ID })]
  ];

  for (const [name, document] of shapes) {
    const viaGate = gate(facts([document], [target]));
    const viaPredicate = isLiveDeltaSpecGrant({
      approval: document,
      changeId: CHANGE_ID,
      delta: target,
      evaluatedAt: EVALUATED_AT
    });
    assert.equal(viaPredicate, viaGate.status === "satisfied", name);
  }

  // And the first row is the one that must be `true`, so the loop above is not
  // passing by agreeing on "no" everywhere.
  assert.equal(
    isLiveDeltaSpecGrant({ approval: approval(REQ_ONE), changeId: CHANGE_ID, delta: target, evaluatedAt: EVALUATED_AT }),
    true
  );
});

test("the predicate does not answer the working-tree question its caller has already answered", () => {
  // `isLiveDeltaSpecGrant` substitutes a verifier that answers `match`, which
  // would be a fail-open in any caller that had not already hashed the file. Its
  // one caller has: `loadChangeBundle` refuses the bundle unless every delta
  // spec on disk hashes to `delta.delta.sha256`, and the predicate requires the
  // approval's pin to equal that same hash — so a pin that gets through matches
  // disk. Recorded as a test because the substitution is invisible at the call
  // site and the next caller has to know the precondition it inherits.
  const target = delta(REQ_ONE);
  const document = approval(REQ_ONE);

  // Drift is what the gate reports when the file has moved under the approval…
  const drifted = gate(facts([document], [target], { verifyPin: pins({ [deltaSpecPath(REQ_ONE)]: "drift" }) }));
  assert.equal(drifted.status, "unsatisfied");

  // …and the predicate cannot see it, by design. The claim is not "these always
  // agree"; it is "they agree given the bundle load the caller has performed".
  assert.equal(
    isLiveDeltaSpecGrant({ approval: document, changeId: CHANGE_ID, delta: target, evaluatedAt: EVALUATED_AT }),
    true
  );
});
