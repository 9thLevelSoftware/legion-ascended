import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeOracleDemand,
  deriveShipGates,
  earliestExecutionRun,
  isLiveOracleGrant,
  shipGateRecovery
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `approved_spec_and_oracle` — the ordering gate, and the arms `legion ship`
 * cannot reach.
 *
 * The defect this file exists for: the gate fell through `evaluateGate`'s
 * `default:` arm and reported "Legion does not yet produce evidence for this
 * gate" for every R3 change, which is honest and is why no R3 change could ever
 * ship. ADR-006 asks whether the spec and the oracle were both approved *before*
 * gated execution proceeded — not whether they were approved, which
 * `approved_delta_spec` asks and which R3 does not even derive — and nothing
 * anywhere recorded a decision about an oracle at all.
 *
 * Three conventions, two carried from tests/ship-delta-spec-approval and one
 * specific to this gate:
 *
 *  - **Every approval is parsed through `approvalSchema` before it is used.** A
 *    fixture the schema would reject tests less than it appears to, and an
 *    approval has several ways to be quietly wrong that matter here: a
 *    `decidedAt` before `requestedAt` (which the ordering fixtures below dance
 *    around deliberately), an `artifacts` array that is present and empty, an
 *    idempotency key in neither admitted form, and an oracle target id that is
 *    not a valid oracle id.
 *  - **The gate is derived at R3 and only at R3.** `DEFAULT_RISK_POLICY` lists it
 *    at R3 and nowhere else, so an R2 fixture makes `report.gates.find(...)`
 *    return `undefined` and every assertion pass vacuously.
 *  - **The oracle fact and the task run are structurally minimal.** The gate
 *    reads `document.id` and `reference`, and `id`/`taskId`/`startedAt`. Building
 *    a schema-valid `Oracle` — owner, projectId, requirementCoverage, expected
 *    pre/postconditions, execution — or a schema-valid `TaskRun` with its frozen
 *    runtime manifest would shape forty lines of fixture around plumbing no gate
 *    reads. The end-to-end proof that real documents drive this gate is
 *    tests/change-r3-ordering, which runs the whole CLI.
 *
 * **Why so much is driven here rather than end to end.** Two of this gate's arms
 * are unreachable through `legion ship` today, and neither is dead:
 *
 *  - The tampering arm — an oracle whose bytes no longer hash to what its
 *    approval pinned — is caught *first* by `validateChangeTraceability`, because
 *    `taskgraph.json` independently pins every oracle's sha256 in
 *    `artifactInputs` and ship flattens a stale pin to `change_traceability_broken`
 *    before evaluating a gate. Measured, not assumed: editing an oracle in a real
 *    repository produces two `change_traceability_broken` diagnostics and no gate
 *    verdict at all. The gate keeps its own check because a gate must not inherit
 *    its central truth claim from another module's invariant — the argument
 *    `approvedDeltaSpecPin` already makes for the same shape.
 *  - The equal-instant boundary needs two events in the same millisecond. Two CLI
 *    processes will not collide, so it has to be constructed.
 *
 * Nothing here uses `chmod` or `attrib` to make a file unreadable. That pattern
 * does not fail the same way on Linux CI, and every state below is reachable by
 * constructing the fact object.
 */

const CHANGE_ID = "chg_ordering-change";
const OTHER_CHANGE_ID = "chg_some-other-change";
const PROJECT_ID = "prj_ordering";
const TASK_ID = "tsk_ordering-task";
const CONTRACT_ID = "ctr_ordering-task";
const REQUIREMENT_ID = "req_editor-saves-metadata";
const ORACLE_ID = "orc_ordering-task-c1";
const SECOND_ORACLE_ID = "orc_ordering-task-c2";

const APPROVED_AT = "2026-08-01T12:00:00.000Z";
const STARTED_AT = "2026-08-02T09:00:00.000Z";
const ONE_MS_BEFORE_START = "2026-08-02T08:59:59.999Z";
const AFTER_START = "2026-08-02T09:00:00.001Z";
const EVALUATED_AT = "2026-08-10T00:00:00.000Z";

const { approvalSchema, LEGION_PROTOCOL_VERSION, buildChangeIdempotencyKey } = await import(
  "../packages/protocol/dist/index.js"
);
const { hashContent } = await import("../packages/artifacts/dist/index.js");

const SPEC_BYTES = "# modify: req_editor-saves-metadata\n";
const ORACLE_BYTES = { [ORACLE_ID]: '{"kind":"oracle-artifact","oracle":{"id":"c1"}}', [SECOND_ORACLE_ID]: '{"kind":"oracle-artifact","oracle":{"id":"c2"}}' };

const DELTA_SPEC_PATH = `.legion/project/changes/${CHANGE_ID}/delta-specs/${REQUIREMENT_ID}.md`;
const DELTA_PIN = { path: DELTA_SPEC_PATH, sha256: hashContent(SPEC_BYTES), mediaType: "text/markdown" };
const DELTA = { operation: "modify", requirementId: REQUIREMENT_ID, path: DELTA_SPEC_PATH, delta: DELTA_PIN };

function oraclePath(oracleId) {
  return `.legion/project/changes/${CHANGE_ID}/oracle/${oracleId}.yaml`;
}

/**
 * One `ShipGateOracleFact`, as `loadOracleFacts` produces it.
 *
 * `reference` is the artifact service's own hash of the bytes on disk, which is
 * what makes the byte comparison in `approvedOraclePin` the live check: the
 * manifest re-hashes the file on every read, so this digest *is* what is there.
 */
function oracleFact(oracleId = ORACLE_ID, bytes = ORACLE_BYTES[oracleId]) {
  return {
    document: { id: oracleId },
    reference: { path: oraclePath(oracleId), sha256: hashContent(bytes), mediaType: "application/json" }
  };
}

/** A schema-valid approval, defaulting to the shape `legion approve oracle` writes. */
function oracleApproval(overrides = {}) {
  const { oracleId = ORACLE_ID, pinnedBytes = ORACLE_BYTES[oracleId], decidedAt = APPROVED_AT, ...rest } = overrides;
  const document = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: APPROVED_AT,
    updatedAt: decidedAt,
    kind: "approval",
    id: `apv_ordering-change-approval-${oracleId === ORACLE_ID ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb"}`,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    requestedBy: { kind: "human", id: "dasbl" },
    requestedAt: APPROVED_AT,
    scope: {
      effectClass: "S1",
      action: "oracle.approve",
      targets: [
        { kind: "oracle", id: oracleId },
        { kind: "change", id: CHANGE_ID }
      ]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      effectKind: "oracle.approve",
      targetHash: hashContent(ORACLE_BYTES[oracleId])
    }),
    artifacts: [{ path: oraclePath(oracleId), sha256: hashContent(pinnedBytes), mediaType: "application/json" }],
    status: "granted",
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt,
    decisionReason: `dasbl approved oracle ${oracleId}.`,
    ...rest
  };
  const parsed = approvalSchema.safeParse(document);
  assert.equal(parsed.success, true, `fixture rejected by approvalSchema: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

/** A schema-valid delta-spec approval, the requirement half of the same gate. */
function specApproval(overrides = {}) {
  const { decidedAt = APPROVED_AT, ...rest } = overrides;
  const document = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: APPROVED_AT,
    updatedAt: decidedAt,
    kind: "approval",
    id: "apv_ordering-change-approval-cccccccccccc",
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    requestedBy: { kind: "human", id: "dasbl" },
    requestedAt: APPROVED_AT,
    scope: {
      effectClass: "S1",
      action: "spec.delta.approve",
      targets: [
        { kind: "requirement", id: REQUIREMENT_ID },
        { kind: "change", id: CHANGE_ID }
      ]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      effectKind: "spec.delta.approve",
      targetHash: hashContent(SPEC_BYTES)
    }),
    artifacts: [DELTA_PIN],
    status: "granted",
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt,
    decisionReason: `dasbl approved the delta spec for ${REQUIREMENT_ID}.`,
    ...rest
  };
  const parsed = approvalSchema.safeParse(document);
  assert.equal(parsed.success, true, `fixture rejected by approvalSchema: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

function run(overrides = {}) {
  return { id: "run_ordering-task-attempt-1", taskId: TASK_ID, startedAt: STARTED_AT, ...overrides };
}

function task(overrides = {}) {
  return {
    id: CONTRACT_ID,
    risk: { tier: "R3", reasons: ["test"] },
    oracleRefs: [ORACLE_ID],
    requirementIds: [REQUIREMENT_ID],
    ...overrides
  };
}

/**
 * A pin verifier driven per path, so `match`, `drift`, `missing` and
 * `unverified` can each be produced deliberately. The default is `match`,
 * because the everyday case is a working tree still holding what was approved.
 */
function pins(overrides = {}) {
  return (reference) => overrides[reference.path] ?? "match";
}

function facts(overrides = {}) {
  return {
    changeId: CHANGE_ID,
    acceptance: undefined,
    approvals: [specApproval(), oracleApproval()],
    deltas: [DELTA],
    oracles: [oracleFact()],
    taskRuns: [run()],
    release: undefined,
    evaluatedAt: EVALUATED_AT,
    verifyPin: pins(),
    ...overrides
  };
}

/** The one gate row this file is about. */
function gate(overrides = {}, tasks = [task()]) {
  const report = deriveShipGates({
    tasks,
    taskIdFor: () => TASK_ID,
    entries: [],
    reviews: [],
    change: facts(overrides)
  });
  const found = report.gates.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.notEqual(found, undefined, "R3 derives this gate; a missing row is the test asserting nothing");
  return found;
}

test("an approved spec and oracle decided before the first run satisfies the gate", () => {
  // The claim the whole gate exists to make, and the shape `legion plan`,
  // `legion approve spec`, `legion approve oracle` and `legion build` produce in
  // that order. Both instants are in the sentence, because a satisfied verdict
  // that hides its margin cannot be audited: a reader has no way to tell a
  // decision taken a week early from one taken a millisecond early.
  const result = gate();

  assert.equal(result.status, "satisfied");
  assert.match(result.reason, new RegExp(APPROVED_AT));
  assert.match(result.reason, new RegExp(STARTED_AT));
  assert.equal(result.scope, "change");
  assert.equal(result.subjectId, CHANGE_ID);
});

test("a decision taken in the same millisecond as the run start does not satisfy the gate", () => {
  // The boundary, and it belongs to the side that blocks. Both stamps come from
  // `currentUtcTimestamp()`, which has millisecond resolution, so an exact
  // collision is reachable — and an unorderable pair is not evidence that the
  // decision came first. Three existing rules in ship-gates.ts already draw the
  // line here: `grantExpiry` spends a grant expiring exactly now, and both
  // supersession filters leave a negative standing at an equal instant.
  //
  // The pair below is one millisecond wide and is the whole test: at the run's
  // own instant the gate blocks, and one millisecond earlier it passes. Write
  // `>` instead of `>=` and the first assertion fails.
  const collided = gate({ approvals: [specApproval(), oracleApproval({ decidedAt: STARTED_AT })] });
  assert.equal(collided.status, "unsatisfied");
  assert.match(collided.reason, /same instant/);

  const justBefore = gate({
    approvals: [specApproval(), oracleApproval({ decidedAt: ONE_MS_BEFORE_START })]
  });
  assert.equal(justBefore.status, "satisfied");
});

test("a decision taken after execution began names both instants and the run", () => {
  // The reason is the only thing an operator sees, and "the ordering is wrong"
  // is unactionable. It has to say which decision, when it was taken, when
  // execution began, and which run holds that start — the run id is the only
  // handle they have on the attempt that beat the approval.
  const result = gate({ approvals: [specApproval(), oracleApproval({ decidedAt: AFTER_START })] });

  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, new RegExp(AFTER_START));
  assert.match(result.reason, new RegExp(STARTED_AT));
  assert.match(result.reason, /run_ordering-task-attempt-1/);
  assert.match(result.reason, new RegExp(TASK_ID));
});

test("nothing this verdict advises is a command that would make the ordering worse", () => {
  // This series' first lesson, in the one place it has no comfortable answer.
  // Verified against the tree rather than assumed: `writeTaskRun`'s only callers
  // are the two in `legion build`, nothing rewinds, deletes or supersedes a run,
  // `legion plan` is create-only, `legion dev change repoint` leaves
  // `taskGraph.document.tasks` untouched — and re-approving writes a *later*
  // `decidedAt`, which makes the ordering strictly worse. So a recovery naming
  // any `legion approve` verb here would be PR 4's defect wearing a new coat:
  // a command that exits 0 and leaves the ship blocked forever.
  const result = gate({ approvals: [specApproval(), oracleApproval({ decidedAt: AFTER_START })] });

  assert.notEqual(result.recovery, undefined);
  assert.doesNotMatch(result.recovery.command, /approve/);
  assert.doesNotMatch(result.recovery.command, /^legion build$/);
  assert.match(result.recovery.command, /legion start --intake/);
  // And it says so, rather than leaving the operator to discover it.
  assert.match(result.recovery.reason, /no command re-orders a decision/);
  assert.match(result.recovery.reason, /risk\.override/);

  // The blocked ship's advice carries it too, which is the path an operator
  // actually reaches it by.
  const advised = shipGateRecovery({
    gates: [result],
    fallback: { command: "legion build", reason: "Required risk gates are not satisfied." }
  });
  assert.match(advised.command, /legion start --intake/);
});

test("an unapproved oracle is reported before the ordering, and advises approving rather than building", () => {
  // Arm order is the point. A gate that asked about ordering first would answer
  // an operator who has approved nothing with "no task has run, run legion
  // build" — which is not merely unhelpful: building is the one act that makes
  // this gate's ordering unrepairable. So the ordering arm runs last, after every
  // subject is satisfied, and the advice on the way there is to approve.
  const result = gate({ approvals: [specApproval()], taskRuns: [] });

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, new RegExp(`No approval records anyone approving oracle ${ORACLE_ID}`));
  assert.match(result.recovery.command, /legion approve oracle/);
});

test("an unapproved delta spec advises approving the spec, not the oracle", () => {
  // At R3 `approved_delta_spec` is not derived at all, so this gate is the only
  // reader of a `spec.delta.approve` grant there — and the two halves have two
  // different commands. A single table entry for this gate would name one of them
  // and misroute the other.
  //
  // `taskRuns: []` is load-bearing rather than tidy: approving is the repair only
  // while nothing has run, and the test below is the other half of that pair.
  const result = gate({ approvals: [oracleApproval()], taskRuns: [] });

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, new RegExp(REQUIREMENT_ID));
  assert.match(result.recovery.command, /legion approve spec/);
});

test("an unapproved subject on a change that has already run is not told to approve it", () => {
  // The blocking defect adversarial review found in the first draft of this
  // release, and this series' first lesson in the place it costs the most.
  //
  // The draft answered every unmet subject with the approve verb for that
  // subject, whatever the run plane said. Driven end to end on a real R3 change
  // that had already been built: ship reported this gate `unevaluable` and advised
  // `legion approve spec --approver <id>`; the command exited 0 with
  // `status: "approved"` and no warning; and the next ship reported the same gate
  // `unsatisfied` — permanently, because nothing re-orders a decision already
  // taken. The advertised repair converted a blocked change into an unrepairable
  // one and reported success doing it.
  //
  // Both directions are asserted. The recovery must not be an approve verb, and
  // the verdict's own sentence must carry the reason — a blocked ship's gate rows
  // are `{code, gate, message, path}` and nothing else, so an operator on a
  // multi-gate block never sees the recovery at all.
  const spec = gate({ approvals: [oracleApproval()], taskRuns: [run()] });
  assert.equal(spec.status, "unevaluable");
  assert.doesNotMatch(spec.recovery.command, /approve/);
  assert.match(spec.recovery.command, /legion start --intake/);
  assert.match(spec.reason, /approving cannot satisfy this gate/);
  assert.match(spec.reason, new RegExp(STARTED_AT));

  const oracle = gate({ approvals: [specApproval()], taskRuns: [run()] });
  assert.equal(oracle.status, "unevaluable");
  assert.doesNotMatch(oracle.recovery.command, /approve/);

  // And the restore-the-bytes repair is *not* collapsed into it, because
  // restoring an oracle re-dates nothing: a grant taken before the build stays
  // before the build. Collapsing every post-execution verdict to "re-plan" would
  // throw away the one tampering case that is genuinely still repairable.
  const tampered = gate({
    oracles: [oracleFact(ORACLE_ID, '{"kind":"oracle-artifact","oracle":{"id":"c1"},"edited":true}')],
    taskRuns: [run()]
  });
  assert.equal(tampered.status, "unsatisfied");
  assert.match(tampered.recovery.reason, /Restore it/);
});

test("an unmet subject on a change whose run plane will not read is not told to approve either", () => {
  // A change that has never run has no `runs/` directory at all, so
  // `listTaskRunsForChange` answers `{ok: true, taskRuns: [], skipped: []}` and
  // ship hands this gate `[]`. An *absent* run plane therefore means the directory
  // exists and something in it would not read — which is a change that has almost
  // certainly been built, and telling its operator to approve is the same trap one
  // step further from proof.
  const result = gate({ approvals: [oracleApproval()], taskRuns: undefined });

  assert.equal(result.status, "unevaluable");
  assert.doesNotMatch(result.recovery.command, /approve/);
  assert.match(result.reason, /could not be established from its run plane/);
});

test("an oracle edited after it was approved is unsatisfied, and is not cured by re-approving", () => {
  // The tampering this gate exists to catch. Nothing in Legion rewrites an
  // oracle — `createOracleArtifact` has two callers and both create,
  // `updateOracleArtifact` has no CLI caller at all — so bytes that no longer
  // match the approval were changed out of band.
  //
  // The cure is restoring the file, and re-approving is deliberately not offered:
  // it would launder the edit into a governance record, which `legion approve
  // spec` already refuses to do for a delta spec, *and* it would stamp a fresh
  // `decidedAt` after execution had started, breaking the ordering the same
  // command would have been invoked to establish.
  //
  // Driven here rather than end to end because `legion ship` cannot reach it:
  // `taskgraph.json` pins every oracle's sha256 in `artifactInputs`, so an edited
  // oracle is reported as `change_traceability_broken` before any gate runs.
  // Measured in a real repository, not assumed. The check stays because a gate
  // must not inherit its central truth claim from another module's invariant.
  const result = gate({ oracles: [oracleFact(ORACLE_ID, '{"kind":"oracle-artifact","oracle":{"id":"c1"},"edited":true}')] });

  assert.equal(result.status, "unsatisfied");
  assert.match(result.reason, /edited after it was approved/);
  assert.doesNotMatch(result.recovery.command, /approve/);
  assert.match(result.recovery.reason, /Restore it/);
});

test("a drifted or missing oracle pin is unsatisfied; an unhashed one is the byte comparison's answer", () => {
  // The working-tree half of the same check. `verifyPin` here is a *second
  // opinion*: it cannot be reached with a digest that disagrees with the oracle's,
  // because `approvedOraclePin` compares the pin against `oracle.reference.sha256`
  // and returns `stale` before calling it. So its only reachable contributions are
  // `drift` and `missing`, which say the file moved between `loadOracleFacts`
  // hashing it and `resolvePinnedReferences` hashing it, inside one ship run.
  const drifted = gate({ verifyPin: pins({ [oraclePath(ORACLE_ID)]: "drift" }) });
  assert.equal(drifted.status, "unsatisfied");
  assert.match(drifted.reason, /bytes have changed/);

  const missing = gate({ verifyPin: pins({ [oraclePath(ORACLE_ID)]: "missing" }) });
  assert.equal(missing.status, "unsatisfied");
  assert.match(missing.reason, /no longer present/);

  // `unverified` was `unevaluable` in the first draft, and that was a writer/reader
  // divergence loop rather than caution. `resolvePinnedReferences` answers it for a
  // path it refuses — an NTFS alternate-data-stream path, a case-folded alias, a
  // symlink out of the repository — and the gate then reported "this report did not
  // hash it" *about a digest it had already compared against bytes hashed off disk
  // in the same read*. `legion approve oracle` answered "already approved" over the
  // same document, wrote nothing, exited 0, and ship repeated the identical
  // `unevaluable` forever. A missing second opinion is an absent corroboration, not
  // a failed check.
  const unhashed = gate({ verifyPin: pins({ [oraclePath(ORACLE_ID)]: "unverified" }) });
  assert.equal(unhashed.status, "satisfied");

  // And the byte comparison still decides, under exactly that verifier: the loop
  // is closed by trusting the check that ran, not by trusting nothing.
  const unhashedAndEdited = gate({
    verifyPin: pins({ [oraclePath(ORACLE_ID)]: "unverified" }),
    oracles: [oracleFact(ORACLE_ID, '{"kind":"oracle-artifact","oracle":{"id":"c1"},"edited":true}')]
  });
  assert.equal(unhashedAndEdited.status, "unsatisfied");
  assert.match(unhashedAndEdited.reason, /edited after it was approved/);
});

test("the gate and the writer agree about an oracle nobody could re-hash", () => {
  // The loop itself, asserted as a pair rather than as two independent facts.
  // `oracleApprovalStatus` under `unverified` and `isLiveOracleGrant` — which
  // passes `() => "unverified"` because it hashed nothing and has no second
  // opinion to offer — must reach the same verdict about the same document, or
  // ship blocks on a state the writer reports as already done.
  const approval = oracleApproval();
  const reader = gate({ approvals: [specApproval(), approval], verifyPin: pins({ [oraclePath(ORACLE_ID)]: "unverified" }) });
  const writer = isLiveOracleGrant({
    approval,
    changeId: CHANGE_ID,
    oracle: oracleFact(),
    evaluatedAt: EVALUATED_AT
  });

  assert.equal(reader.status === "satisfied", writer);
  assert.equal(writer, true);
});

test("an approval that pins the oracle twice, or not at all, says so rather than passing", () => {
  // `artifacts` carries no uniqueness constraint, so a `find` would take
  // whichever duplicate came first and a document pinning both the right digest
  // and a wrong one would sail through. And an approval with no pin at this path
  // does not say what was approved — the honest answer is that nothing says.
  const twice = gate({
    approvals: [
      specApproval(),
      oracleApproval({
        artifacts: [
          { path: oraclePath(ORACLE_ID), sha256: hashContent(ORACLE_BYTES[ORACLE_ID]), mediaType: "application/json" },
          { path: oraclePath(ORACLE_ID), sha256: hashContent("something else"), mediaType: "application/json" }
        ]
      })
    ]
  });
  assert.equal(twice.status, "unevaluable");
  assert.match(twice.reason, /pins 2 references/);

  const elsewhere = gate({
    approvals: [
      specApproval(),
      oracleApproval({ artifacts: [{ path: "ops/compose.yml", sha256: hashContent("x"), mediaType: "text/plain" }] })
    ]
  });
  assert.equal(elsewhere.status, "unevaluable");
  assert.match(elsewhere.reason, /pins no reference/);
});

test("an oracle approval that also claims a task is named, not silently ignored", () => {
  // An oracle is a property of the change, and `legion approve oracle` writes
  // neither `taskId` nor `runId` — so a document carrying one was written by
  // something else with something else in mind. A silent filter would report
  // that as "nobody approved this oracle", which sends the operator to approve
  // something that already has a record.
  const result = gate({ approvals: [specApproval(), oracleApproval({ taskId: TASK_ID })] });

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, new RegExp(TASK_ID));
  assert.match(result.reason, /belongs to the change rather than to one task/);
});

test("an approval for another change, another oracle or another action answers for nothing", () => {
  // Three scoping predicates, each closing a different way for one decision to
  // answer for another. The change id is strict equality against a possibly
  // absent value, so facts too degraded to name their own change match nothing
  // rather than everything; an oracle id is derived from a phase slug and is not
  // change-scoped, so the same id can appear in two changes.
  for (const wrong of [
    oracleApproval({ changeId: OTHER_CHANGE_ID }),
    oracleApproval({
      oracleId: SECOND_ORACLE_ID,
      scope: {
        effectClass: "S1",
        action: "oracle.approve",
        targets: [{ kind: "oracle", id: SECOND_ORACLE_ID }]
      }
    }),
    oracleApproval({
      scope: {
        effectClass: "S1",
        action: "workflow.review.accept",
        targets: [{ kind: "oracle", id: ORACLE_ID }]
      }
    })
  ]) {
    const result = gate({ approvals: [specApproval(), wrong] });
    assert.equal(result.status, "unevaluable", JSON.stringify(wrong.scope));
    assert.match(result.reason, new RegExp(`No approval records anyone approving oracle ${ORACLE_ID}`));
  }
});

test("an archived withdrawal does not outrank the grant that superseded it", () => {
  // The correction of a specification defect rather than of code. "Unsatisfied
  // when any approval is denied, revoked or expired" would make this gate
  // permanently unsatisfied on every change that ever recovered from a
  // withdrawal, because `archiveWithdrawnDecision` deliberately leaves a *second*
  // denied document — same targets, same action, same `decidedAt` — in the same
  // directory. That copy is the record the whole recovery depends on.
  //
  // PR 1's rule instead: a negative stands unless a live grant is strictly later
  // than it.
  //
  // `createdAt` and `requestedAt` move with `decidedAt` here, and that is not
  // fixture noise: `approvalSchema`'s superRefine refuses a `decidedAt` earlier
  // than its `requestedAt`, so any ordering fixture dating a decision backwards
  // has to date the request backwards too or `writeApproval` would never have
  // produced it.
  const withdrawnAt = "2026-07-30T12:00:00.000Z";
  const archived = oracleApproval({
    id: "apv_ordering-change-approval-dddddddddddd",
    createdAt: withdrawnAt,
    requestedAt: withdrawnAt,
    status: "revoked",
    decidedAt: withdrawnAt,
    decisionReason: "dasbl withdrew this approval."
  });

  const superseded = gate({ approvals: [specApproval(), archived, oracleApproval()] });
  assert.equal(superseded.status, "satisfied");

  // And the negative still stands when nothing later supersedes it.
  const standing = gate({ approvals: [specApproval(), oracleApproval({ status: "revoked", decisionReason: "no" })] });
  assert.equal(standing.status, "unsatisfied");
  assert.match(standing.reason, /is revoked/);
});

test("a lapsed grant and a machine grant are recorded negatives, not absence", () => {
  const lapsed = gate({
    approvals: [specApproval(), oracleApproval({ expiresAt: "2026-08-03T00:00:00.000Z" })]
  });
  assert.equal(lapsed.status, "unsatisfied");
  assert.match(lapsed.reason, /expired at/);

  const byMachine = gate({
    approvals: [specApproval(), oracleApproval({ decidedBy: { kind: "tool", id: "legion-approver" } })]
  });
  assert.equal(byMachine.status, "unsatisfied");
  assert.match(byMachine.reason, /not by a human/);
});

test("a grant carrying an expiry, read by a report with no clock, is unevaluable", () => {
  // A decision that says it expires, evaluated by a caller that cannot tell
  // whether it has, is a decision whose current validity is unestablished. The
  // only two alternatives are "always live", which is a fail-open, and "never
  // checkable", which permanently disables a field the schema offers.
  const result = gate({
    approvals: [specApproval(), oracleApproval({ expiresAt: "2026-09-01T00:00:00.000Z" })],
    evaluatedAt: undefined
  });

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /no clock/);
});

// --- PR 0's deferred question: the empty and the short oracle set ------------

test("an oracle a task names but the change cannot show is unevaluable, not vacuously approved", () => {
  // **This is PR 0's deferred question, and the reason neither route it offered
  // closes it.** `deriveOracleManifest` maps ENOENT on the oracle directory to
  // `{ok: true}` with an empty manifest, and `loadOracleFacts` turns that into
  // `[]` rather than `undefined` — so "every oracle is approved" is vacuously
  // true over a deleted directory. Distinguishing that ENOENT in the service
  // would not have been enough: the manifest also reports `{ok: true}` with a
  // *short* list when one oracle file of several is deleted, and it carries no
  // `skipped` field of any kind. A bare non-emptiness rule passes over the
  // survivors.
  //
  // So the quantifier runs over the oracles the change's *tasks name*, which
  // lives in `taskgraph.json` and which deleting an oracle file cannot shrink.
  // Both halves are asserted here, because they are the two shapes the two
  // rejected routes each leave open.
  const emptyDirectory = gate({ oracles: [] });
  assert.equal(emptyDirectory.status, "unevaluable");
  assert.match(emptyDirectory.reason, new RegExp(`judged against oracle ${ORACLE_ID}`));
  assert.match(emptyDirectory.reason, /0 oracle documents/);

  const shortList = gate({ oracles: [oracleFact(SECOND_ORACLE_ID)] }, [
    task({ oracleRefs: [ORACLE_ID, SECOND_ORACLE_ID] })
  ]);
  assert.equal(shortList.status, "unevaluable");
  assert.match(shortList.reason, new RegExp(`judged against oracle ${ORACLE_ID}`));

  // And neither is answered with an approval. `GATE_RECOVERY` for this gate is
  // `legion approve oracle` — the state every R3 change written before this
  // release is in — so a verdict about a *missing* oracle that carried no
  // recovery of its own would fall through to advice that cannot help, and the
  // writer would refuse for exactly the reason the gate did.
  for (const result of [emptyDirectory, shortList]) {
    assert.doesNotMatch(result.recovery.command, /approve/);
  }
});

test("a plane that would not load is not answered by writing another approval into it", () => {
  // `GATE_RECOVERY[approved_spec_and_oracle]` is `legion approve oracle`, which
  // is right for the state every R3 change written before this release is in and
  // wrong for every degraded plane below: `legion approve oracle` reads the same
  // change bundle, the same task graph and the same oracle manifest, so it
  // refuses for the reason the gate did. A verdict that fell through to the table
  // here would be PR 4's defect — a recovery that exits 1 in every state it is
  // offered for — arriving through the table instead of through a constant.
  for (const [why, overrides] of Object.entries({
    "the bundle would not load": { deltas: undefined },
    "the bundle records no delta spec": { deltas: [] },
    "the approvals listing dropped a file": { approvals: undefined },
    "the oracle manifest would not derive": { oracles: undefined }
  })) {
    const result = gate(overrides);
    assert.equal(result.status, "unevaluable", why);
    assert.doesNotMatch(result.recovery.command, /approve/, why);
    assert.match(result.recovery.reason, /the writer reads the same planes/, why);
  }
});

test("a change whose tasks name no oracle is unevaluable, never satisfied", () => {
  // The vacuity guard in its narrowest form. `taskContractSchema.oracleRefs` is
  // `.min(1)`, so this is unreachable from a parsed contract — and it is kept
  // because a gate must not inherit its central truth claim from another
  // module's invariant. At R3 a change whose work is judged against no criteria
  // has not answered ADR-006's question; it has skipped it.
  const result = gate({}, [task({ oracleRefs: [] })]);

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /No task of this change references an oracle/);
});

test("an oracle no task names is neither required nor able to block", () => {
  // The other direction, and it is deliberately not a blocking condition. An
  // oracle nothing is judged against proves nothing about the criteria the work
  // *was* judged against, and refusing it would refuse a shape `legion plan`
  // legitimately produces when a criterion set changes.
  const result = gate({ oracles: [oracleFact(), oracleFact(SECOND_ORACLE_ID)] });

  assert.equal(result.status, "satisfied");

  const demand = changeOracleDemand({
    tasks: [task()],
    taskIdFor: () => TASK_ID,
    change: facts({ oracles: [oracleFact(), oracleFact(SECOND_ORACLE_ID)] })
  });
  assert.deepEqual(demand.unreferenced, [SECOND_ORACLE_ID]);
  assert.deepEqual(demand.referenced.map((entry) => entry.oracleId), [ORACLE_ID]);
});

test("a task implementing a requirement the change ships no delta spec for is unevaluable", () => {
  // The delta loop quantifies over what the change ships, so it cannot see a
  // requirement the change ships nothing for — and a task implementing one is a
  // requirement whose specification nothing in this change ever approved.
  const result = gate({}, [task({ requirementIds: ["req_something-else-entirely"] })]);

  assert.equal(result.status, "unevaluable");
  assert.match(result.reason, /ships no delta spec for/);
});

// --- the three worlds one `undefined` collapses ------------------------------

test("an unreadable run plane, an empty one and one with no start each say a different thing", () => {
  // `earliestExecutionStart` returns `undefined` for all three, so a gate that
  // branched on its return value alone would print one sentence for three states
  // and offer one repair for two that need different ones. The plane is checked
  // on the field first.
  //
  // The empty case is the one that matters most for advice: it is where every
  // correctly-approved-but-unbuilt R3 change sits, and it is the *only* arm of
  // this gate a build repairs.
  const unreadable = gate({ taskRuns: undefined });
  assert.equal(unreadable.status, "unevaluable");
  assert.match(unreadable.reason, /could not be read as a complete set/);
  assert.match(unreadable.recovery.command, /legion ship/);

  const empty = gate({ taskRuns: [] });
  assert.equal(empty.status, "unevaluable");
  assert.match(empty.reason, /no task of it has run/);
  assert.equal(empty.recovery.command, "legion build");

  const unstarted = gate({ taskRuns: [{ id: "run_ordering-task-attempt-1", taskId: TASK_ID, status: "created" }] });
  assert.equal(unstarted.status, "unevaluable");
  assert.match(unstarted.reason, /records when it started/);
  assert.notEqual(unstarted.recovery.command, "legion build");
});

test("the earliest run is the minimum over the whole set, and names itself stably", () => {
  // `min`, not `max`, and the difference is the launder this gate exists to
  // catch: `legion review --auto` calls the build inside the ordinary fix cycle,
  // attempt 2 lands in a new directory, and under `max` the sequence
  // build → approve → rebuild would satisfy the gate. `min` is also monotone in
  // the safe direction — adding a run can only move the boundary earlier.
  //
  // Ties break on the run id rather than on list order, so the sentence an
  // operator reads names the same run on every derivation rather than whichever
  // one the directory happened to yield first.
  assert.equal(earliestExecutionRun(undefined), undefined);
  assert.equal(earliestExecutionRun([]), undefined);
  assert.equal(earliestExecutionRun([{ status: "created" }]), undefined);

  const rebuilt = earliestExecutionRun([
    { id: "run_b-attempt-2", taskId: TASK_ID, startedAt: AFTER_START },
    { id: "run_a-attempt-1", taskId: TASK_ID, startedAt: STARTED_AT }
  ]);
  assert.equal(rebuilt.startedAt, STARTED_AT);
  assert.equal(rebuilt.runId, "run_a-attempt-1");

  const tied = earliestExecutionRun([
    { id: "run_z", taskId: TASK_ID, startedAt: STARTED_AT },
    { id: "run_a", taskId: TASK_ID, startedAt: STARTED_AT }
  ]);
  assert.equal(tied.runId, "run_a");
});

test("a grant with no decision instant is unevaluable, not skipped", () => {
  // The mirror of the dropped-run fail-open. A dropped run pushes
  // `min(startedAt)` later; a grant whose instant is skipped pulls
  // `max(decidedAt)` earlier. Both make a late approval look early, so neither
  // may be a `continue`. Unreachable from a parsed approval — `decidedAt` is
  // required on the `granted` member — and reachable from a fixture, which is
  // the same ground every defensive arm in this module stands on.
  const report = deriveShipGates({
    tasks: [task()],
    taskIdFor: () => TASK_ID,
    entries: [],
    reviews: [],
    change: {
      ...facts(),
      // Bypasses `approvalSchema` on purpose: this is the shape the schema
      // forbids, which is exactly why the gate has to answer it rather than
      // trust that it cannot arrive.
      approvals: [specApproval(), { ...oracleApproval(), decidedAt: undefined }]
    }
  });

  const found = report.gates.find((entry) => entry.gate === "approved_spec_and_oracle");
  assert.equal(found.status, "unevaluable");
  assert.match(found.reason, /records no decision instant/);
});

// --- the writer's predicate --------------------------------------------------

test("the writer's idea of approved is the gate's own, not a paraphrase of it", () => {
  // PR 2's lesson, applied to a third subject. A writer whose idea of "done" is
  // weaker than the reader's idea of "satisfied" reports "already approved",
  // writes nothing, and leaves the change permanently blocked with no flag
  // anywhere that would make it write. So `isLiveOracleGrant` calls the gate's
  // own predicate against a one-document plane.
  //
  // Every shape below is one the gate rejects, and each would have been accepted
  // by the obvious weaker rule (granted, human, no expiry, some pin at the path).
  assert.equal(
    isLiveOracleGrant({
      approval: oracleApproval(),
      changeId: CHANGE_ID,
      oracle: oracleFact(),
      evaluatedAt: EVALUATED_AT
    }),
    true
  );

  const rejected = {
    "pins the oracle twice": oracleApproval({
      artifacts: [
        { path: oraclePath(ORACLE_ID), sha256: hashContent(ORACLE_BYTES[ORACLE_ID]), mediaType: "application/json" },
        { path: oraclePath(ORACLE_ID), sha256: hashContent("other"), mediaType: "application/json" }
      ]
    }),
    "carries a stray taskId": oracleApproval({ taskId: TASK_ID }),
    "names another change": oracleApproval({ changeId: OTHER_CHANGE_ID }),
    "carries an action the gate does not read": oracleApproval({
      scope: { effectClass: "S1", action: "workflow.review.accept", targets: [{ kind: "oracle", id: ORACLE_ID }] }
    }),
    "was granted by a tool": oracleApproval({ decidedBy: { kind: "tool", id: "legion-approver" } })
  };
  for (const [why, approval] of Object.entries(rejected)) {
    assert.equal(
      isLiveOracleGrant({ approval, changeId: CHANGE_ID, oracle: oracleFact(), evaluatedAt: EVALUATED_AT }),
      false,
      why
    );
  }
});

test("the writer's predicate deliberately says nothing about ordering", () => {
  // The one place the predicate is narrower than the gate, and the exclusion is
  // load-bearing. If it carried the comparison, a rerun after execution had
  // started would report `regrant`, `legion approve oracle` would write a fresh
  // `decidedAt`, and the ordering would be made strictly *worse* by the command
  // invoked to repair it. The verb closes the resulting silence by reading the
  // run plane itself and warning; it does not close it by refusing to write.
  const approval = oracleApproval({ decidedAt: AFTER_START });

  assert.equal(
    isLiveOracleGrant({ approval, changeId: CHANGE_ID, oracle: oracleFact(), evaluatedAt: EVALUATED_AT }),
    true,
    "the writer must see this as already decided, so a rerun writes nothing"
  );
  assert.equal(
    gate({ approvals: [specApproval(), approval] }).status,
    "unsatisfied",
    "and the gate must still refuse it, so the two differ by exactly the ordering clause"
  );
});

test("the writer's predicate refuses an approval pinning bytes the change no longer carries", () => {
  // What makes this predicate strict, named correctly on the second attempt.
  //
  // The first draft passed `(reference) => reference.sha256 === fact.reference
  // .sha256 ? "match" : "drift"` and this test's comment claimed that made it
  // stricter than `isLiveDeltaSpecGrant`'s `() => "match"`. Adversarial review
  // measured it: `approvedOraclePin` compares the pin against
  // `oracle.reference.sha256` *before* calling the verifier, so the substitute
  // could only ever be handed the matching digest and could only ever answer
  // `match`. Replacing the whole thing with `() => "match"` left every test in
  // this file green — the test passed under exactly the mutation it named.
  //
  // The mechanism that actually refuses is the byte comparison, so that is what
  // is asserted, and the predicate now passes `() => "unverified"` — the truthful
  // value for a caller that hashed nothing. Delete the comparison at
  // `approvedOraclePin`'s `pin.sha256 !== input.oracle.reference.sha256` and this
  // reddens; nothing else in the file substitutes for it.
  assert.equal(
    isLiveOracleGrant({
      approval: oracleApproval(),
      changeId: CHANGE_ID,
      oracle: oracleFact(ORACLE_ID, '{"kind":"oracle-artifact","oracle":{"id":"c1"},"edited":true}'),
      evaluatedAt: EVALUATED_AT
    }),
    false
  );
});
