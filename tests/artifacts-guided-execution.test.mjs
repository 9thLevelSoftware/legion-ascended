import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-artifacts-guided-"));
}

test("task-run and review artifacts round trip with revision conflicts", async () => {
  const {
    artifactPathForRole,
    hashContent,
    listReviewDecisionsForChange,
    listTaskRunsForChange,
    readReviewDecision,
    readTaskRun,
    stableProtocolJson,
    writeReviewDecision,
    writeTaskRun
  } = await import("../packages/artifacts/dist/index.js");
  const {
    LEGION_PROTOCOL_VERSION,
    buildIdempotencyKey,
    formatEntityId
  } = await import("../packages/protocol/dist/index.js");
  const root = await tempRepo();
  try {
    const projectId = formatEntityId("project", "guided-test");
    const changeId = formatEntityId("change", "guided-test-change");
    const contractId = formatEntityId("contract", "guided-test-task");
    const taskId = formatEntityId("task", "guided-test-task");
    const runId = formatEntityId("run", "guided-test-task-attempt-1");
    const evidenceId = formatEntityId("evidence", "guided-test-task-attempt-1");
    const reviewId = formatEntityId("review", "guided-test-change-review-1");
    const createdAt = "2026-06-23T12:00:00.000Z";
    const baseCommit = "0000000000000000000000000000000000000000";

    assert.equal(
      artifactPathForRole({ role: "task-run", changeId, runId }),
      ".legion/project/changes/chg_guided-test-change/runs/run_guided-test-task-attempt-1/task-run.json"
    );
    assert.equal(
      artifactPathForRole({ role: "review", changeId, reviewId }),
      ".legion/project/changes/chg_guided-test-change/reviews/rev_guided-test-change-review-1.json"
    );

    const targetHash = hashContent("guided target");
    const manifest = {
      runtime: { driver: "legion.executor", version: LEGION_PROTOCOL_VERSION },
      workerBundle: {
        id: "workflow-executor",
        version: LEGION_PROTOCOL_VERSION,
        role: "implementer",
        domain: "codebase",
        capabilities: ["build"],
        promptContentContract: {
          instructionsHash: hashContent("instructions"),
          requiredSections: ["objective"],
          forbiddenSections: ["biography"]
        }
      },
      model: { provider: "legion", id: "fake", policyVersion: LEGION_PROTOCOL_VERSION },
      inputs: {
        contractHash: hashContent("contract"),
        currentSpecsHash: hashContent("current"),
        deltaSpecsHash: hashContent("delta"),
        oracleHash: hashContent("oracle")
      },
      repository: { baseCommit },
      workspace: { sandboxDriver: "fake", worktreePath: ".legion/project" },
      policy: { version: LEGION_PROTOCOL_VERSION, riskTier: "R1" },
      idempotencyKey: buildIdempotencyKey({
        projectId,
        changeId,
        taskId,
        runId,
        effectKind: "workflow-execute",
        targetHash
      }),
      frozenAt: createdAt
    };
    const startedRun = {
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "task-run",
      id: runId,
      projectId,
      changeId,
      taskId,
      contractId,
      contractRevision: 1,
      attempt: 1,
      status: "started",
      startedAt: createdAt,
      manifest
    };

    const createdRun = await writeTaskRun({ repositoryRoot: root, document: startedRun });
    assert.equal(createdRun.ok, true, stableProtocolJson(createdRun));
    assert.equal(createdRun.revision.revision, 1);

    const staleRun = await writeTaskRun({ repositoryRoot: root, document: startedRun });
    assert.equal(staleRun.ok, false);
    assert.equal(staleRun.status, "conflict");

    const succeededRun = await writeTaskRun({
      repositoryRoot: root,
      expectedRevision: 1,
      document: {
        ...createdRun.document,
        status: "succeeded",
        finishedAt: "2026-06-23T12:01:00.000Z",
        evidenceRefs: [evidenceId]
      }
    });
    assert.equal(succeededRun.ok, true, stableProtocolJson(succeededRun));
    assert.equal(succeededRun.revision.revision, 2);

    const loadedRun = await readTaskRun({ repositoryRoot: root, changeId, runId });
    assert.equal(loadedRun.ok, true, stableProtocolJson(loadedRun));
    assert.equal(loadedRun.document.status, "succeeded");
    assert.equal(loadedRun.revision.revision, 2);

    const submittedReview = {
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "review",
      id: reviewId,
      projectId,
      changeId,
      taskId,
      runId,
      reviewer: { kind: "tool", id: "legion-fake-reviewer" },
      verdicts: { specification: "pass", integration: "pass", evidence: "pass" },
      confidence: "high",
      findings: [],
      supersedes: [],
      evidenceRefs: [evidenceId],
      status: "submitted",
      submittedAt: createdAt
    };
    const createdReview = await writeReviewDecision({ repositoryRoot: root, document: submittedReview });
    assert.equal(createdReview.ok, true, stableProtocolJson(createdReview));
    assert.equal(createdReview.revision.revision, 1);

    const acceptedReview = await writeReviewDecision({
      repositoryRoot: root,
      expectedRevision: 1,
      document: {
        ...createdReview.document,
        status: "accepted",
        updatedAt: "2026-06-23T12:02:00.000Z",
        submittedAt: createdReview.document.submittedAt
      }
    });
    assert.equal(acceptedReview.ok, true, stableProtocolJson(acceptedReview));
    assert.equal(acceptedReview.revision.revision, 2);

    const loadedReview = await readReviewDecision({ repositoryRoot: root, changeId, reviewId });
    assert.equal(loadedReview.ok, true, stableProtocolJson(loadedReview));
    assert.equal(loadedReview.document.status, "accepted");
    assert.equal(loadedReview.revision.revision, 2);

    const malformedRunId = formatEntityId("run", "guided-test-task-attempt-bad");
    const malformedRunRoot = path.join(root, ".legion", "project", "changes", changeId, "runs", malformedRunId);
    await mkdir(malformedRunRoot, { recursive: true });
    await writeFile(path.join(malformedRunRoot, "task-run.json"), "{ invalid json", "utf8");
    const listedRuns = await listTaskRunsForChange({ repositoryRoot: root, changeId });
    assert.equal(listedRuns.ok, true, stableProtocolJson(listedRuns));
    assert.equal(listedRuns.taskRuns.length, 1);
    assert.equal(listedRuns.taskRuns[0].document.id, runId);

    const malformedReviewId = formatEntityId("review", "guided-test-change-review-bad");
    const malformedReviewPath = path.join(root, ".legion", "project", "changes", changeId, "reviews", `${malformedReviewId}.json`);
    await writeFile(malformedReviewPath, "{ invalid json", "utf8");
    const listedReviews = await listReviewDecisionsForChange({ repositoryRoot: root, changeId });
    assert.equal(listedReviews.ok, true, stableProtocolJson(listedReviews));
    assert.equal(listedReviews.reviews.length, 1);
    assert.equal(listedReviews.reviews[0].document.id, reviewId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
