import assert from "node:assert/strict";
import { test } from "node:test";

import { completeTaskRuns } from "../packages/cli/dist/commands/workflow/ship.js";
import { shipGateDiagnostics } from "../packages/cli/dist/workflow/ship-gates.js";

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
 * No gate is change-scoped yet, so nothing else in the tree reaches the collapse
 * branch. It is asserted here against a hand-built gate list instead, because
 * unreachable-in-production is only acceptable when it is reachable by test.
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
