import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attemptFromEvidence,
  latestEvidenceEntries,
  latestEvidencePerTask
} from "../packages/cli/dist/workflow/evidence-selection.js";
import { deriveShipGates } from "../packages/cli/dist/workflow/ship-gates.js";

const TASK_ID = "tsk_phase-1";

function entry(attempt, items, taskId = TASK_ID) {
  return {
    evidence: {
      id: `evd_phase-1-attempt-${attempt}`,
      runId: `run_phase-1-attempt-${attempt}`,
      taskId,
      items
    },
    acceptance: { status: "pending" }
  };
}

const PASS = [{ id: "declared-verification", verdict: "pass" }, { id: "diff-reconciliation", verdict: "pass" }];
const FAIL = [{ id: "declared-verification", verdict: "fail" }, { id: "diff-reconciliation", verdict: "pass" }];

test("attempt numbers are parsed as integers, not compared as strings", () => {
  assert.equal(attemptFromEvidence(entry(2, PASS)), 2);
  assert.equal(attemptFromEvidence(entry(10, PASS)), 10);
  // Lexicographic ordering would put attempt-10 before attempt-2, making
  // "latest" wrong exactly when a task has been retried enough to matter.
  assert.ok(attemptFromEvidence(entry(10, PASS)) > attemptFromEvidence(entry(2, PASS)));
});

test("the latest attempt wins regardless of stored order", () => {
  const outOfOrder = [entry(10, PASS), entry(2, FAIL)];
  assert.equal(latestEvidencePerTask(outOfOrder).get(TASK_ID).evidence.id, "evd_phase-1-attempt-10");

  const inOrder = [entry(2, FAIL), entry(10, PASS)];
  assert.equal(latestEvidencePerTask(inOrder).get(TASK_ID).evidence.id, "evd_phase-1-attempt-10");
});

test("entries without a task id are skipped", () => {
  const untagged = { evidence: { id: "evd_x", items: PASS }, acceptance: { status: "pending" } };
  assert.equal(latestEvidencePerTask([untagged]).size, 0);
});

test("one entry per task is returned", () => {
  const entries = [entry(1, FAIL), entry(2, PASS), entry(1, PASS, "tsk_other")];
  const latest = latestEvidenceEntries(entries);
  assert.equal(latest.length, 2);
});

// --- the behaviour that was permanently broken -----------------------------

// No `change` facts are passed, though `deriveShipGates` now requires them in
// TypeScript. This file imports compiled JavaScript, where that requirement is
// unenforced, and the omission is the point: it is a second caller standing in
// for the runtime case where `legion ship` degraded to absent facts because a
// change artifact would not read. These three tests do not, however, hold the
// guard that makes that safe — no gate reads a change fact yet, so they pass
// with the guard removed. `normalizeChangeFacts` is tested directly in
// tests/ship-risk-gates.test.mjs; do not read this omission as coverage of it.
function gatesFor(entries) {
  return deriveShipGates({
    tasks: [{ id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] } }],
    taskIdFor: () => TASK_ID,
    entries,
    reviews: [{ document: { id: "rev_1", status: "accepted", taskId: TASK_ID } }]
  });
}

test("a passing rerun clears an earlier failure", () => {
  // Previously the failed attempt persisted in the index forever, so the
  // operator was told to rerun and reruns could never unblock anything.
  const report = gatesFor([entry(1, FAIL), entry(2, PASS)]);

  const gate = report.gates.find((item) => item.gate === "deterministic_verification");
  assert.equal(gate.status, "satisfied");
  assert.equal(report.unsatisfied, 0);
});

test("a failing rerun is not masked by an earlier pass", () => {
  // The inverse: reading the first stored match answered with the oldest
  // attempt, so an early pass certified a task that most recently failed.
  const report = gatesFor([entry(1, PASS), entry(2, FAIL)]);

  const gate = report.gates.find((item) => item.gate === "deterministic_verification");
  assert.equal(gate.status, "unsatisfied");
  assert.equal(report.ready, false);
});

test("attempt 10 beats attempt 2 in the gate decision", () => {
  const report = gatesFor([entry(10, FAIL), entry(2, PASS)]);
  assert.equal(report.ready, false);
});
