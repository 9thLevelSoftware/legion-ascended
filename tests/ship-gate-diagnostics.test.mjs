import assert from "node:assert/strict";
import { test } from "node:test";

import { completeApprovals, completeTaskRuns } from "../packages/cli/dist/commands/workflow/ship.js";
import { shipGateDiagnostics, shipGateRecovery } from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * The blocked-ship diagnostics, and the collapse rule for change-scoped gates.
 *
 * `deriveShipGates` emits one row per (task, gate) — the report's counts and its
 * `ready` flag depend on that — so a gate whose verdict is about the whole
 * change would repeat the same sentence once per task in the operator's output.
 * The ship command collapses those to one, and that collapse is what this file
 * exists for.
 *
 * The defect it guards against is a collapse applied before the scope filter:
 * deduplicating the whole list by gate id drops one diagnostic per task on any
 * multi-task change, while every other assertion in the tree stays green —
 * cli-workflow-ux checks only that a particular code is present, and both
 * dogfood checks only that the count is above zero. That is a real behaviour
 * change hiding inside a rendering change, invisible to CI.
 *
 * `approved_delta_spec` is the first change-scoped gate, so the collapse branch
 * now has a production user — but not a production *witness*: every change
 * `legion plan` can build has exactly one task, so an end-to-end assertion that
 * a blocked ship names it once passes with or without the collapse. The hand-
 * built lists below stay the thing that can falsify it.
 *
 * `release_observation_plan` is still used as the stand-in change-scoped gate
 * here, deliberately: these tests are about the rendering rule rather than about
 * any gate's verdict, and using the one gate that really is change-scoped would
 * couple them to a scope decision they do not assert.
 *
 * These fixtures are hand-built results rather than reports from
 * `deriveShipGates`. That is not a fixture in a shape that could never exist: a
 * gate result is an in-memory value with no schema and no on-disk form, and
 * `scope: "change"` is a shape the type permits and the first change-scoped gate
 * will produce.
 */
function gateResult(overrides = {}) {
  return {
    gate: "deterministic_verification",
    label: "Deterministic Verification",
    status: "unevaluable",
    reason: "no reason",
    taskId: "tsk_a",
    scope: "task",
    subjectId: "tsk_a",
    ...overrides
  };
}

test("a change-scoped gate is reported once; a task-scoped gate once per task", () => {
  const diagnostics = shipGateDiagnostics({
    gates: [
      gateResult({ taskId: "tsk_a", subjectId: "tsk_a" }),
      gateResult({ taskId: "tsk_b", subjectId: "tsk_b" }),
      gateResult({
        gate: "release_observation_plan",
        label: "Release Observation Plan",
        taskId: "tsk_a",
        scope: "change",
        subjectId: "chg_x"
      }),
      gateResult({
        gate: "release_observation_plan",
        label: "Release Observation Plan",
        taskId: "tsk_b",
        scope: "change",
        subjectId: "chg_x"
      })
    ],
    path: "p"
  });

  // Four means the collapse never ran; two means it ran over the whole list and
  // took the per-task diagnostics with it.
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics.filter((entry) => entry.message.includes("tsk_a")).length, 1);
  assert.equal(diagnostics.filter((entry) => entry.message.includes("tsk_b")).length, 1);
  assert.equal(diagnostics.filter((entry) => entry.message.includes("chg_x")).length, 1);
});

test("a satisfied gate produces no diagnostic, and the code names the status", () => {
  // Reporting only `unsatisfied` would make a change blocked purely by
  // unevaluable gates fail with no explanation of what is missing, and every
  // R2 change today is blocked exactly that way.
  const diagnostics = shipGateDiagnostics({
    gates: [
      gateResult({ status: "satisfied" }),
      gateResult({ status: "unsatisfied" }),
      gateResult({ status: "unevaluable" })
    ],
    path: "p"
  });

  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ["risk_gate_unsatisfied", "risk_gate_unevaluable"]
  );
});

test("a diagnostic names the gate, its subject, its reason and the artifact path", () => {
  // The message text is not asserted anywhere else in the tree, so the move
  // from `taskId` to `subjectId` in the template could otherwise change the
  // operator's output with every suite still green.
  const [diagnostic] = shipGateDiagnostics({
    gates: [
      gateResult({
        label: "Deterministic Verification",
        status: "unsatisfied",
        reason: "Evidence records a failed declared-verification.",
        taskId: "tsk_a",
        subjectId: "tsk_a"
      })
    ],
    path: ".legion/project/changes/chg_x/evidence/index.json"
  });

  assert.equal(
    diagnostic.message,
    "Deterministic Verification is not satisfied for tsk_a: Evidence records a failed declared-verification."
  );
  assert.equal(diagnostic.path, ".legion/project/changes/chg_x/evidence/index.json");
  // Machine-readable, beside the prose. Until this release a blocked ship
  // carried no gate id at all — while the *ready* payload has listed
  // `riskGates.unevaluableGates` all along — so the only way to name a gate in
  // the payload an operator on a failing change actually sees was to match the
  // human label inside `message`. That couples a CI-blocking assertion to a
  // string in `@legion/core` that no reader would recognise as a contract.
  assert.equal(diagnostic.gate, "deterministic_verification");
});

// --- the route out of a block -----------------------------------------------

// `legion ship` blocked on ten producerless gates and always advised `legion
// build`. That was true enough while nothing could satisfy any of them.
// `approved_delta_spec` is the first gate whose evidence a build can never
// produce — it reads the approval plane — so the old advice became a loop with
// no end: run build, get the same block, run build again.

test("a block whose only unmet gate has a recovery advises that command", () => {
  const recovery = shipGateRecovery({
    gates: [
      gateResult({ gate: "approved_delta_spec", scope: "change", subjectId: "chg_x", status: "unevaluable" }),
      gateResult({ gate: "deterministic_verification", status: "satisfied" })
    ],
    fallback: { command: "legion build", reason: "Required risk gates are not satisfied." }
  });

  assert.equal(recovery.command, "legion approve spec --approver <id>");
  assert.match(recovery.reason, /no build produces that/);
});

test("a block with several unmet gates keeps the fallback and names the ones with a route", () => {
  // Advising `legion approve spec` here would claim one command unblocks a ship
  // that two gates are holding — the failure `recoveryFor` in the ship command
  // already guards against with its own `.every()`. Saying nothing would leave
  // the operator with `legion build` and no thread at all.
  //
  // Re-pointed at `independent_baseline`. This fixture's whole shape is "one gate
  // with a route, one without", and it used `whole_change_acceptance_evidence`
  // for the second slot precisely *because* that gate had no `GATE_RECOVERY`
  // entry. This release gives it one, so leaving it here would have kept the
  // assertions green while the fixture no longer built the case they describe —
  // the "two have a command" arm rather than the "one has" one. Green for the
  // wrong reason is the failure this file exists to catch elsewhere.
  const recovery = shipGateRecovery({
    gates: [
      gateResult({ gate: "approved_delta_spec", scope: "change", subjectId: "chg_x" }),
      gateResult({ gate: "independent_baseline" })
    ],
    fallback: { command: "legion build", reason: "Required risk gates are not satisfied." }
  });

  assert.equal(recovery.command, "legion build");
  assert.match(recovery.reason, /^Required risk gates are not satisfied\./);
  assert.match(recovery.reason, /legion approve spec --approver <id>/);
  // "one has", not "2 have" — which is what pins that the second gate really is
  // one without a route, rather than a second route being summarised away.
  assert.match(recovery.reason, /one has a command/);
});

test("a block whose unmet gates have no recovery keeps the fallback unchanged", () => {
  // Byte-identical to what shipped before this release, which is most of what
  // this function does today: nine of the ten gates still have no producer and
  // therefore no command to name.
  const fallback = { command: "legion build", reason: "Required risk gates are not satisfied." };
  assert.deepEqual(
    shipGateRecovery({ gates: [gateResult({ gate: "protected_oracle" })], fallback }),
    fallback
  );
  assert.deepEqual(shipGateRecovery({ gates: [], fallback }), fallback);
  assert.deepEqual(
    shipGateRecovery({ gates: [gateResult({ status: "satisfied" })], fallback }),
    fallback
  );
});

// --- the run listing is carried whole or not at all -------------------------

// `listTaskRunsForChange` reports `ok: true` while silently dropping any run
// directory whose `task-run.json` will not read (tests/artifacts-guided-execution
// pins that behaviour against a real corrupt run on disk). The ordering gates
// take `min(startedAt)` over what they are given, and a dropped run can only push
// that minimum later — the direction that makes an approval recorded after
// execution began look as though it came first. So ship must not pass a subset,
// and since nothing reads `taskRuns` in this release, this is the only thing that
// can falsify the claim that it does not.

const listing = (overrides = {}) => ({
  ok: true,
  status: "read",
  taskRuns: [],
  skipped: [],
  diagnostics: [],
  ...overrides
});

const runResult = (startedAt) => ({ document: { id: "run_a", startedAt } });

test("a complete run listing is carried through as documents", () => {
  const runs = completeTaskRuns(
    listing({ taskRuns: [runResult("2026-01-01T12:00:00.000Z"), runResult("2026-01-01T10:00:00.000Z")] })
  );

  assert.deepEqual(runs.map((run) => run.startedAt), [
    "2026-01-01T12:00:00.000Z",
    "2026-01-01T10:00:00.000Z"
  ]);
});

test("a listing that skipped a run is carried as absence, not as the runs it kept", () => {
  // The concrete failure: run_a started at 10:00 and is corrupt, run_b started at
  // 12:00 and reads fine. Passing the subset makes the change's earliest start
  // 12:00, so an approval decided at 11:00 — an hour after gated execution
  // actually began — satisfies the gate that exists to prove approval came first.
  // Absence makes that gate unevaluable, which blocks. Both block today; only one
  // still blocks once the gate has a producer.
  assert.equal(
    completeTaskRuns(listing({ taskRuns: [runResult("2026-01-01T12:00:00.000Z")], skipped: ["run_a"] })),
    undefined
  );
});

test("a failed or absent listing is absence too", () => {
  assert.equal(completeTaskRuns(undefined), undefined);
  assert.equal(completeTaskRuns({ ok: false, status: "invalid", diagnostics: [] }), undefined);
  // An empty change genuinely has no runs, and that is not the same as a listing
  // that lost some: it stays an empty list so a gate can say "no run exists"
  // rather than "the runs could not be established".
  assert.deepEqual(completeTaskRuns(listing()), []);
});

const approvalListing = (overrides = {}) => ({
  ok: true,
  status: "read",
  approvals: [],
  skipped: [],
  diagnostics: [],
  ...overrides
});

const approvalResult = (id, status) => ({ document: { id, status } });

test("a complete approvals listing is carried through as documents", () => {
  assert.deepEqual(
    completeApprovals(approvalListing({ approvals: [approvalResult("apv_a", "granted")] })).map((approval) => approval.id),
    ["apv_a"]
  );
});

test("an approvals listing that skipped an entry is absence, because the entry may be the revocation", () => {
  // Sharper than the run listing's version of the same rule. An approval file
  // carries the current state of one decision, so once a grant has been revoked
  // the revocation *is* that file. Dropping it does not shorten a list of
  // positives — it deletes a negative, and `explicit_human_approval` would read
  // what remained and report satisfied on a decision that had been withdrawn.
  assert.equal(
    completeApprovals(
      approvalListing({ approvals: [approvalResult("apv_a", "granted")], skipped: ["apv_b.json"] })
    ),
    undefined
  );
});

test("a failed approvals listing is absence, but an empty one is an empty list", () => {
  // The distinction the gate depends on. `undefined` means the plane could not
  // be established; `[]` means it was read and this change has no approvals,
  // which is what every change accepted by an earlier Legion looks like. Both
  // report unevaluable today, for different stated reasons — and the first must
  // never be spelled as the second, because the day a gate treats an empty list
  // as "nothing to check" it would treat an unreadable directory the same way.
  assert.equal(completeApprovals(undefined), undefined);
  assert.equal(completeApprovals({ ok: false, status: "invalid", diagnostics: [] }), undefined);
  assert.deepEqual(completeApprovals(approvalListing()), []);
});

test("a repeated change-scoped gate id collapses even across different subjects", () => {
  // The collapse keys on the gate id, not on the subject. A report only ever
  // covers one change, so two subjects for one change-scoped gate would mean the
  // facts disagreed with themselves; reporting both would present that
  // contradiction as two independent findings.
  const diagnostics = shipGateDiagnostics({
    gates: [
      gateResult({ gate: "release_observation_plan", scope: "change", subjectId: "chg_x" }),
      gateResult({ gate: "release_observation_plan", scope: "change", subjectId: "chg_y" })
    ],
    path: "p"
  });

  assert.equal(diagnostics.length, 1);
});
