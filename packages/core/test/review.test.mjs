/**
 * P08-T02 Per-task review pipeline tests.
 *
 * These tests pin the Phase 8 acceptance cut line: a fresh worker
 * context produced by P08-T01 must be paired with deterministic
 * verification, an independent reviewer record (when the tier
 * requires it), and an ADR-006 acceptance gate decision before the
 * task can be marked DONE.
 *
 * Coverage (30 tests):
 *  1. Happy path — R1 task with passing verification + independent
 *     reviewer produces `accepted` outcome.
 *  2. Verification failure — a command that exits non-zero forces
 *     `rejected` outcome via the `deterministic_verification` gate.
 *  3. Verification runner throws — pipeline surfaces
 *     `verification_command_failed` issue.
 *  4. Verification runner missing — pipeline surfaces
 *     `verification_runner_unavailable`.
 *  5. Same-actor review — pipeline rejects with
 *     `reviewer_is_implementer` issue; gate fails.
 *  6. Tier R2 with no reviewer input — gate records missing
 *     `task_level_independent_review`; outcome `rejected`.
 *  7. Tier R3 escalates — outcome `escalated` because the per-task
 *     loop cannot evaluate `explicit_human_approval`.
 *  8. Tier R0 — no required gates, passing verification accepts.
 *  9. Reviewer verdict fail — gate fails on
 *     `task_level_independent_review`.
 * 10. Blocking finding with passing verdicts — surfaces
 *     `review_verdict_inconsistent`.
 * 11. Blocking finding missing evidence refs — surfaces
 *     `review_evidence_missing`.
 * 12. Determinism — two pipeline runs with identical inputs
 *     produce identical `reviewPipelineHash`.
 * 13. Provider neutrality — review source never imports a runtime
 *     driver, eve, board-store, or reads process.env.
 * 14. Output shape — pipeline result only exposes keys in
 *     `REVIEW_PIPELINE_KEYS` allowlist.
 * 15. Renderer — `renderReviewPipelineResult` and `renderAcceptanceDecision`
 *     produce stable strings.
 * 16. Summary helper — `summarizeReviewPipelineResults` aggregates
 *     outcomes correctly.
 * 17. Hash determinism — `deriveReviewPipelineHash` is stable
 *     across runs (sanity check on the top-level hash).
 * 18. Review record shape — `ReviewRecord` carries reviewer,
 *     implementer, verdicts, and is deeply frozen.
 * 19. Review hash stability — same inputs → same `reviewHash`.
 * 20. Verification report shape — passed/failingIndices/reportSha256
 *     carry the expected values.
 * 21. Per-command runner override — runner perCommand overrides
 *     surface through the verification report.
 * 22. Command runner returns wrong index — pipeline surfaces
 *     `verification_command_failed` issue.
 * 23. Timeout in runner — verification report records `timedOut:
 *     true` and gate fails.
 * 24. Gate evaluator policy override — custom policy produces
 *     different gate set than default.
 * 25. Empty verification list — contract with no verification
 *     commands still runs (passes trivially when not required).
 * 26. Pipeline never throws — bad inputs (no runner, no review,
 *     wrong tier) always return a `PerTaskReviewPipelineResult`.
 * 27. Frozen output — every output field is `Object.isFrozen` on
 *     the root and on nested objects.
 * 28. Review summary derived from findings — when the reviewer
 *     omits a summary, the record derives one from the findings.
 * 29. Acceptance rationale — `AcceptanceDecision.rationale` is
 *     stable and encodes the failing gate set.
 * 30. `deriveAcceptanceDecisionSha256` — same inputs → same hash
 *     (proves determinism of the decision record).
 * 31. `evaluateAcceptanceGate` R2 with passing verification + passing
 *     review but a blocking finding — gate records
 *     `task_level_independent_review` as failed.
 * 32. `PerTaskReviewPipeline.render` — produces a one-line summary
 *     carrying the contract id, isolation tag, and pipeline hash.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_REVIEW_GATE_POLICY,
  PerTaskReviewPipeline,
  REVIEW_PIPELINE_KEYS,
  buildReviewRecord,
  deriveAcceptanceDecisionSha256,
  deriveReviewPipelineHash,
  evaluateAcceptanceGate,
  previewReviewHash,
  renderAcceptanceDecision,
  renderReviewPipelineResult,
  renderReviewRecord,
  runDeterministicVerification,
  summarizeReviewPipelineResults
} from "../dist/index.js";

import { makeFixtureContract } from "./dispatch-fixture.mjs";
import {
  makeFailingRunner,
  makeFixtureWorkerContext,
  makeImplementer,
  makePassingRunner,
  makeReviewer,
  makeReviewerInput,
  makeThrowingRunner
} from "./review-fixture.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = join(SCRIPT_PATH, "..", "..", "src");

function readSource(relativePath) {
  return readFileSync(join(SOURCE_ROOT, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test("P08-T02 R1 pipeline accepts when verification passes and reviewer is independent", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module", "internal-api"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline({
    now: () => "2026-06-22T02:00:00.000Z"
  });
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable: success path");

  assert.equal(result.decision.outcome, "accepted");
  assert.equal(result.decision.tier, "R1");
  assert.equal(result.decision.failingGates.length, 0);
  assert.equal(result.verification.passed, true);
  assert.ok(result.review !== null);
  assert.equal(result.review.independent, true);
  assert.match(result.reviewPipelineHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.isolationTag, /^fresh-context:v1:[0-9a-f]{12}$/);
});

test("P08-T02 pipeline passes its injected clock into review records", async () => {
  const createdAt = "2026-06-22T09:45:00.000Z";
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module", "internal-api"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline({
    now: () => createdAt
  });
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  assert.equal(result.createdAt, createdAt);
  assert.equal(result.verification.createdAt, createdAt);
  assert.equal(result.decision.createdAt, createdAt);
  assert.equal(result.review.createdAt, createdAt);
});

// ---------------------------------------------------------------------------
// 2. Verification failure
// ---------------------------------------------------------------------------

test("P08-T02 R1 pipeline rejects when a verification command fails", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module", "internal-api"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline({
    now: () => "2026-06-22T02:00:00.000Z"
  });
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makeFailingRunner(),
    review: makeReviewerInput()
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable: blocked path");

  assert.equal(result.decision.outcome, "rejected");
  assert.ok(
    result.decision.failingGates.includes("deterministic_verification"),
    `expected deterministic_verification in failing gates, got: ${result.decision.failingGates.join(", ")}`
  );
  assert.equal(result.verification.passed, false);
  assert.ok(result.issues.some((issue) => issue.code === "verification_command_failed"));
});

// ---------------------------------------------------------------------------
// 3. Runner throws
// ---------------------------------------------------------------------------

test("P08-T02 pipeline surfaces 'verification_command_failed' when the runner throws", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline({
    now: () => "2026-06-22T02:00:00.000Z"
  });
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makeThrowingRunner()
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "verification_command_failed"));
});

// ---------------------------------------------------------------------------
// 4. Runner missing
// ---------------------------------------------------------------------------

test("P08-T02 pipeline surfaces 'verification_runner_unavailable' when no runner is supplied", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    review: makeReviewerInput()
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "verification_runner_unavailable"));
  assert.equal(result.decision.outcome, "rejected");
});

// ---------------------------------------------------------------------------
// 5. Same-actor review
// ---------------------------------------------------------------------------

test("P08-T02 pipeline rejects reviews where the reviewer is the implementer", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput({ reviewer: makeImplementer() })
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "reviewer_is_implementer"));
  assert.ok(
    result.decision.failingGates.includes("lightweight_independent_review"),
    `expected lightweight_independent_review in failing gates, got: ${result.decision.failingGates.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 6. R2 with no reviewer
// ---------------------------------------------------------------------------

test("P08-T02 R2 pipeline rejects when no reviewer input is supplied", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R2", reasons: ["multi-module", "user-facing-path"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner()
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "review_required_for_tier"));
  assert.ok(
    result.decision.failingGates.includes("task_level_independent_review"),
    `expected task_level_independent_review in failing gates, got: ${result.decision.failingGates.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 7. R3 escalation
// ---------------------------------------------------------------------------

test("P08-T02 R3 pipeline escalates because human approval is out of scope for the per-task loop", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R3", reasons: ["auth-boundary", "production-deployment"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  assert.equal(result.decision.outcome, "escalated");
  assert.ok(result.decision.gates.some((gate) => gate.state === "not_evaluable"));
});

// ---------------------------------------------------------------------------
// 8. R0 trivial accept
// ---------------------------------------------------------------------------

test("P08-T02 R0 pipeline accepts with no required gates", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R0", reasons: ["docs-only"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner()
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.outcome, "accepted");
  // R0 has no required gates.
  assert.equal(result.decision.gates.length, 0);
});

// ---------------------------------------------------------------------------
// 9. Failing verdict
// ---------------------------------------------------------------------------

test("P08-T02 pipeline rejects when reviewer returns a failing verdict", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput({
      verdicts: { specification: "fail", integration: "pass", evidence: "pass" }
    })
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.decision.failingGates.includes("lightweight_independent_review"),
    `expected lightweight_independent_review in failing gates, got: ${result.decision.failingGates.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 10. Blocking finding + passing verdicts
// ---------------------------------------------------------------------------

test("P08-T02 review record surfaces 'review_verdict_inconsistent' when verdicts pass but findings are blocking", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput({
      findings: [
        {
          id: "fnd_blocking_1",
          title: "blocking finding",
          body: "blocking finding body",
          severity: "blocking",
          evidenceRefs: ["ev_blocking_1"]
        }
      ]
    })
  });

  assert.ok(result.issues.some((issue) => issue.code === "review_verdict_inconsistent"));
  assert.equal(result.decision.outcome, "rejected");
});

// ---------------------------------------------------------------------------
// 11. Blocking finding missing evidence
// ---------------------------------------------------------------------------

test("P08-T02 review record rejects blocking findings without evidence refs", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput({
      verdicts: { specification: "fail", integration: "pass", evidence: "pass" },
      findings: [
        {
          id: "fnd_blocking_no_evidence",
          title: "blocking without evidence",
          body: "this finding lacks evidence refs",
          severity: "blocking"
        }
      ]
    })
  });

  assert.ok(result.issues.some((issue) => issue.code === "review_evidence_missing"));
});

// ---------------------------------------------------------------------------
// 12. Determinism
// ---------------------------------------------------------------------------

test("P08-T02 pipeline hash is deterministic for identical inputs", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline({
    now: () => "2026-06-22T02:00:00.000Z"
  });
  const inputA = {
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  };
  const inputB = {
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  };
  const resultA = await pipeline.run(inputA);
  const resultB = await pipeline.run(inputB);
  assert.equal(resultA.reviewPipelineHash, resultB.reviewPipelineHash);
});

// ---------------------------------------------------------------------------
// 13. Provider neutrality (static scan)
// ---------------------------------------------------------------------------

test("P08-T02 review source files never import a runtime driver, eve, board-store, or process.env", () => {
  const reviewFiles = [
    "review/index.ts",
    "review/contract.ts",
    "review/hash.ts",
    "review/verification.ts",
    "review/reviewer.ts",
    "review/gate.ts",
    "review/pipeline.ts"
  ];
  const forbiddenPatterns = [
    /from\s+["']@legion\/runtime-eve["']/,
    /from\s+["']@legion\/board-store["']/,
    /from\s+["']@legion\/board["']/,
    /from\s+["'].*runtime\//,
    /process\.env/
  ];

  for (const relativePath of reviewFiles) {
    const source = readSource(relativePath);
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${relativePath} matches forbidden pattern ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 14. Output shape allowlist
// ---------------------------------------------------------------------------

test("P08-T02 pipeline result exposes only keys in REVIEW_PIPELINE_KEYS", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  const allowed = new Set(REVIEW_PIPELINE_KEYS);
  for (const key of Object.keys(result)) {
    assert.ok(allowed.has(key), `unexpected key "${key}" on pipeline result`);
  }
});

// ---------------------------------------------------------------------------
// 15. Renderer
// ---------------------------------------------------------------------------

test("P08-T02 renderReviewPipelineResult and renderAcceptanceDecision produce stable strings", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  const line = renderReviewPipelineResult(result);
  assert.match(line, /pipeline ok: contract=/);
  const decisionLine = renderAcceptanceDecision(result.decision);
  assert.match(decisionLine, /acceptance decision: contract=.* outcome=accepted/);
});

// ---------------------------------------------------------------------------
// 16. Summary helper
// ---------------------------------------------------------------------------

test("P08-T02 summarizeReviewPipelineResults aggregates outcomes", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const passingResult = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });
  const failingResult = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makeFailingRunner(),
    review: makeReviewerInput()
  });
  const summary = summarizeReviewPipelineResults([passingResult, failingResult]);
  assert.equal(summary.total, 2);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.failed, 1);
});

// ---------------------------------------------------------------------------
// 17. Hash determinism — deriveReviewPipelineHash
// ---------------------------------------------------------------------------

test("P08-T02 deriveReviewPipelineHash is deterministic", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const verificationOutcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner: makePassingRunner() }
  });
  const verificationSha = verificationOutcome.report.reportSha256;

  const hashA = deriveReviewPipelineHash({
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContext,
    verificationSha256: verificationSha,
    reviewSha256: null,
    decisionSha256: verificationSha,
    schemaVersion: "1.0.0"
  });
  const hashB = deriveReviewPipelineHash({
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContext,
    verificationSha256: verificationSha,
    reviewSha256: null,
    decisionSha256: verificationSha,
    schemaVersion: "1.0.0"
  });
  assert.equal(hashA, hashB);
});

// ---------------------------------------------------------------------------
// 18. Review record shape
// ---------------------------------------------------------------------------

test("P08-T02 review record carries reviewer, implementer, verdicts, and is deeply frozen", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const built = buildReviewRecord({
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContext,
    implementer: makeImplementer(),
    reviewerInput: makeReviewerInput()
  });

  assert.equal(Object.isFrozen(built.record), true);
  assert.equal(Object.isFrozen(built.record.verdicts), true);
  assert.equal(Object.isFrozen(built.record.reviewer), true);
  assert.equal(built.record.implementer.id, "legion-worker");
  assert.equal(built.record.reviewer.id, "reviewer.dasbl");
  assert.equal(built.record.independent, true);
});

// ---------------------------------------------------------------------------
// 19. Review hash stability
// ---------------------------------------------------------------------------

test("P08-T02 previewReviewHash is stable for identical inputs", () => {
  const workerContext = null;
  // The function only needs workerContextHash, so we can pass a
  // placeholder; previewReviewHash doesn't read it.
  const inputA = {
    taskContractId: "ctr_p08-t02",
    contractRevision: 1,
    workerContextHash: "sha256:abc",
    reviewer: makeReviewer(),
    implementer: makeImplementer(),
    review: makeReviewerInput()
  };
  const inputB = {
    taskContractId: "ctr_p08-t02",
    contractRevision: 1,
    workerContextHash: "sha256:abc",
    reviewer: makeReviewer(),
    implementer: makeImplementer(),
    review: makeReviewerInput()
  };
  assert.equal(previewReviewHash(inputA), previewReviewHash(inputB));
  void workerContext;
});

// ---------------------------------------------------------------------------
// 20. Verification report shape
// ---------------------------------------------------------------------------

test("P08-T02 verification report exposes passed/failingIndices/reportSha256", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner: makePassingRunner() }
  });
  assert.equal(outcome.report.kind, "verification-report");
  assert.equal(outcome.report.passed, true);
  assert.equal(outcome.report.failingIndices.length, 0);
  assert.match(outcome.report.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(outcome.report.commands.length, contract.verification.length);
});

// ---------------------------------------------------------------------------
// 21. Per-command runner override
// ---------------------------------------------------------------------------

test("P08-T02 per-command runner override surfaces through the verification report", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const runner = makePassingRunner({
    perCommand: {
      0: { exitCode: 1, timedOut: false }
    }
  });
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner }
  });
  assert.equal(outcome.report.passed, false);
  assert.ok(outcome.report.failingIndices.includes(0));
  assert.equal(outcome.report.commands[0].exitCode, 1);
});

// ---------------------------------------------------------------------------
// 22. Runner returns wrong index
// ---------------------------------------------------------------------------

test("P08-T02 pipeline surfaces 'verification_command_failed' when the runner returns the wrong index", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const runner = async (request) => ({
    index: request.index + 1, // deliberately wrong
    command: request.command,
    args: [...request.args],
    exitCode: 0,
    expectedExitCode: request.expectedExitCode,
    stdoutSha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    stderrSha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    combinedSha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    durationMs: 1,
    timedOut: false,
    startedAt: "2026-06-22T02:00:00.000Z",
    finishedAt: "2026-06-22T02:00:01.000Z"
  });
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner }
  });
  assert.ok(outcome.issues.some((issue) => issue.code === "verification_command_failed"));
});

// ---------------------------------------------------------------------------
// 23. Timeout in runner
// ---------------------------------------------------------------------------

test("P08-T02 verification report records 'timedOut: true' when the runner reports a timeout", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const runner = makePassingRunner({ perCommand: { 0: { timedOut: true } } });
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner }
  });
  assert.equal(outcome.report.passed, false);
  assert.equal(outcome.report.commands[0].timedOut, true);
});

test("P08-T02 verification enforces configured timeouts when the runner hangs", async () => {
  const contract = makeFixtureContract();
  const workerContext = await makeFixtureWorkerContext({ contract });
  const runner = () => new Promise(() => {});
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: {
      runner,
      defaultTimeoutMs: 25,
      timeout: async () => {
        throw new Error("timer fired");
      }
    }
  });

  assert.equal(outcome.report.passed, false);
  assert.deepEqual(outcome.report.failingIndices, [0]);
  assert.equal(outcome.report.commands[0].timedOut, true);
  assert.ok(outcome.issues.some((issue) => issue.code === "verification_command_failed" && /timed out/.test(issue.message)));
});

// ---------------------------------------------------------------------------
// 24. Gate evaluator policy override
// ---------------------------------------------------------------------------

test("P08-T02 evaluateAcceptanceGate honors a custom gate policy", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const verificationOutcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner: makePassingRunner() }
  });
  const strictPolicy = {
    gatesByTier: {
      ...DEFAULT_REVIEW_GATE_POLICY.gatesByTier,
      R1: ["deterministic_verification", "evidence_bundle_or_log"]
    },
    requireIndependentReview: { R0: false, R1: false, R2: true, R3: true }
  };
  const result = evaluateAcceptanceGate({
    taskContract: contract,
    workerContext,
    verification: verificationOutcome.report,
    review: null,
    policy: strictPolicy
  });
  assert.equal(result.decision.outcome, "accepted");
  // Custom policy drops review; default policy would have required it.
});

test("P08-T02 evaluateAcceptanceGate returns structured issues when a custom policy omits the current tier", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const verificationOutcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner: makePassingRunner() }
  });
  const incompletePolicy = {
    gatesByTier: {
      R0: [],
      R2: ["deterministic_verification"],
      R3: ["deterministic_verification"]
    },
    requireIndependentReview: { R0: false, R1: false, R2: true, R3: true }
  };

  const result = evaluateAcceptanceGate({
    taskContract: contract,
    workerContext,
    verification: verificationOutcome.report,
    review: null,
    policy: incompletePolicy
  });

  assert.ok(result.issues.some((issue) => issue.code === "gate_evaluator_failure"));
  assert.deepEqual(result.decision.gates, []);
});

// ---------------------------------------------------------------------------
// 25. Empty verification list
// ---------------------------------------------------------------------------

test("P08-T02 R0 task with no verification commands passes trivially", async () => {
  // The protocol-level task-contract schema requires
  // `verification` to have at least one entry, so we cannot
  // dispatch this fixture through FreshContextDispatcher. Call
  // runDeterministicVerification directly with a minimal mock
  // WorkerContext to prove the runner tolerates empty verification
  // lists.
  const contract = makeFixtureContract({
    risk: { tier: "R0", reasons: ["docs-only"] },
    verification: []
  });
  const stubWorkerContext = {
    workerContextHash: "sha256:abc",
    isolationTag: "fresh-context:v1:abc",
    schemaVersion: "1.0.0",
    kind: "worker-context",
    taskContract: contract,
    contextRefs: { specRefs: [], designRefs: [], predecessorArtifacts: [], all: [] },
    scope: { read: [], write: [], forbidden: [], sequentialFiles: [] },
    workerBundle: { id: "legion.local-worker", version: "0.1.0", role: "implementer", domain: "core", capabilities: [], promptContentContract: { instructionsHash: "sha256:abc", requiredSections: [], forbiddenSections: [] } },
    model: { provider: "minimax", id: "MiniMax-M3", policyVersion: "1.0.0" },
    createdAt: "2026-06-22T02:00:00.000Z",
    protocolVersion: "0.1.0"
  };
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext: stubWorkerContext,
    options: { runner: makePassingRunner() }
  });
  assert.equal(outcome.report.passed, true);
  assert.equal(outcome.report.commands.length, 0);
});

// ---------------------------------------------------------------------------
// 26. Pipeline never throws on bad inputs
// ---------------------------------------------------------------------------

test("P08-T02 pipeline always returns a structured result for any combination of inputs", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R3", reasons: ["auth-boundary", "production-deployment"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();

  const noInputs = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer()
  });
  assert.ok(typeof noInputs.ok === "boolean");
  assert.ok(Array.isArray(noInputs.decision.gates));

  const onlyRunner = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner()
  });
  assert.ok(typeof onlyRunner.ok === "boolean");

  const onlyReview = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    review: makeReviewerInput()
  });
  assert.ok(typeof onlyReview.ok === "boolean");
});

// ---------------------------------------------------------------------------
// 27. Frozen output
// ---------------------------------------------------------------------------

test("P08-T02 pipeline output is deeply frozen on root and nested objects", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.verification), true);
  assert.equal(Object.isFrozen(result.verification.commands), true);
  assert.equal(Object.isFrozen(result.decision), true);
  assert.equal(Object.isFrozen(result.decision.gates), true);
});

// ---------------------------------------------------------------------------
// 28. Review summary derived from findings
// ---------------------------------------------------------------------------

test("P08-T02 review record derives a summary from findings when none is supplied", () => {
  const contract = makeFixtureContract();
  const reviewerInput = makeReviewerInput({
    findings: [
      { id: "f1", title: "minor", body: "minor finding", severity: "minor" },
      { id: "f2", title: "blocking", body: "blocking finding", severity: "blocking", evidenceRefs: ["ev1"] }
    ],
    // Deliberately omit `summary`.
  });
  const built = buildReviewRecord({
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContext: { workerContextHash: "sha256:abc" },
    implementer: makeImplementer(),
    reviewerInput
  });
  assert.match(built.record.summary, /1 blocking, 0 major, 1 minor/);
});

// ---------------------------------------------------------------------------
// 29. Acceptance rationale
// ---------------------------------------------------------------------------

test("P08-T02 acceptance rationale encodes the failing gate set on rejection", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makeFailingRunner(),
    review: makeReviewerInput()
  });

  assert.match(result.decision.rationale, /deterministic_verification/);
});

// ---------------------------------------------------------------------------
// 30. Decision hash determinism
// ---------------------------------------------------------------------------

test("P08-T02 deriveAcceptanceDecisionSha256 is deterministic for identical inputs", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const verificationOutcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext,
    options: { runner: makePassingRunner() }
  });
  const result = evaluateAcceptanceGate({
    taskContract: contract,
    workerContext,
    verification: verificationOutcome.report,
    review: null
  });

  const hashA = deriveAcceptanceDecisionSha256({
    taskContractId: result.decision.taskContractId,
    contractRevision: result.decision.contractRevision,
    workerContextHash: result.decision.workerContextHash,
    tier: result.decision.tier,
    outcome: result.decision.outcome,
    rationale: result.decision.rationale,
    gates: result.decision.gates
  });
  const hashB = deriveAcceptanceDecisionSha256({
    taskContractId: result.decision.taskContractId,
    contractRevision: result.decision.contractRevision,
    workerContextHash: result.decision.workerContextHash,
    tier: result.decision.tier,
    outcome: result.decision.outcome,
    rationale: result.decision.rationale,
    gates: result.decision.gates
  });
  assert.equal(hashA, hashB);
});

// ---------------------------------------------------------------------------
// 31. R2 + blocking finding fails the review gate
// ---------------------------------------------------------------------------

test("P08-T02 R2 pipeline records task_level_independent_review as failed when the reviewer attaches a blocking finding", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R2", reasons: ["multi-module", "user-facing-path"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput({
      findings: [
        {
          id: "fnd_blocking_r2",
          title: "blocking",
          body: "blocking finding on R2 task",
          severity: "blocking",
          evidenceRefs: ["ev_r2_1"]
        }
      ]
    })
  });

  assert.equal(result.decision.outcome, "rejected");
  assert.ok(
    result.decision.failingGates.includes("task_level_independent_review"),
    `expected task_level_independent_review in failing gates, got: ${result.decision.failingGates.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 32. Pipeline.render
// ---------------------------------------------------------------------------

test("P08-T02 PerTaskReviewPipeline.render produces a one-line summary carrying the contract id and pipeline hash", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const pipeline = new PerTaskReviewPipeline();
  const result = await pipeline.run({
    taskContract: contract,
    workerContext,
    implementer: makeImplementer(),
    runner: makePassingRunner(),
    review: makeReviewerInput()
  });

  const line = pipeline.render(result);
  assert.match(line, /per-task review pipeline: contract=ctr_p08-t01-fresh-context@1/);
  assert.match(line, /outcome=accepted/);
  assert.match(line, /tier=R1/);
  assert.match(line, /pipelineHash=sha256:/);
});

// ---------------------------------------------------------------------------
// 33. Render review record helper
// ---------------------------------------------------------------------------

test("P08-T02 renderReviewRecord produces a one-line summary with reviewer, verdicts, and hash", async () => {
  const contract = makeFixtureContract({
    risk: { tier: "R1", reasons: ["isolated-module"] }
  });
  const workerContext = await makeFixtureWorkerContext({ contract });
  const built = buildReviewRecord({
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContext,
    implementer: makeImplementer(),
    reviewerInput: makeReviewerInput()
  });
  const line = renderReviewRecord(built.record);
  assert.match(line, /review record: contract=ctr_p08-t01-fresh-context@1/);
  assert.match(line, /reviewer=reviewer.dasbl/);
  assert.match(line, /verdicts=pass\/pass\/pass/);
  assert.match(line, /independent=true/);
});
