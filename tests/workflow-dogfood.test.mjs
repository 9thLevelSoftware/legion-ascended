import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("workflow dogfood script completes the synthetic workflow loop", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/dogfood-workflow.mjs",
    "--json"
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });

  const payload = JSON.parse(stdout);
  // `ok: true` is a literal in the summary object, so it proves only that the
  // script reached its end. Every claim worth making is below it.
  assert.equal(payload.ok, true);
  assert.equal(payload.executor, "fake");
  assert.equal(payload.source, "synthetic");
  assert.equal(payload.finalStage, "ship_ready");

  // The defect: for the whole of the ship-gate series this harness asserted
  // `shipStatus === "blocked"` and `shipBlockedGates > 0` as its success
  // condition. Those two assertions could not tell a loop that refused because
  // gates were unproven from one that refused because the change had rotted,
  // they could not fail if a gate stopped being derived at all, and the field
  // they read went to zero in exactly the run they were meant to certify.
  //
  // The tier, the task count and the three counts are asserted together because
  // none of them alone says "every R2 gate": seven satisfied is seven gates only
  // if there is one task and its tier is R2, and `satisfied: 0, unsatisfied: 0,
  // unevaluable: 0` is also what a report derives when it derives nothing.
  assert.equal(payload.shipStatus, "ready");
  assert.equal(payload.riskTier, "R2");
  assert.equal(payload.tasks, 1);
  assert.deepEqual(payload.shipRiskGates, { satisfied: 7, unsatisfied: 0, unevaluable: 0 });
  assert.equal(payload.taskRuns > 0, true);

  // Both verdicts, in one run. Now that the loop certifies `ready`, the only
  // thing left proving the gates still refuse anything is one fixture in
  // tests/cli-workflow-ux.test.mjs — so the dogfood also edits the file its
  // declared surface pins, confirms the ship blocks naming that gate, runs the
  // recovery the blocked payload printed, and confirms the ship comes back.
  assert.equal(payload.gateBlockedOnPinDrift, "integration_or_real_interface_checks");
  assert.equal(payload.shipStatusAfterReaffirm, "ready");

  // A second defect, found by review of the first fix: the recovered `ready`
  // was byte-identical to the earned one. `legion approve surface` satisfies
  // `integration_or_real_interface_checks` by a named human re-affirming that
  // drifted bytes still describe what they meant — no verification re-runs —
  // and the ready payload reported `humanJudgementGates: []` over it. Measured
  // on a copy of this very workspace: overwrite the pinned compose file with
  // prose stating the integration environment no longer exists, re-affirm, ship
  // reports seven satisfied, nothing waived, nothing human-judged, no
  // diagnostics. This field is the difference between the two `ready`s, and
  // asserting it here is also what makes the harness's *empty* assertion on the
  // first ship falsifiable — before this, no R2 fixture could move either list.
  assert.deepEqual(payload.humanJudgementGatesAfterReaffirm, ["integration_or_real_interface_checks"]);
});
