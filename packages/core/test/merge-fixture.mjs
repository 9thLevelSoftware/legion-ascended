/**
 * P09-T01 merge queue fixture helpers.
 *
 * Minimal, fully-typed builders for ordered merge queue entries
 * backed by accepted `PerTaskReviewPipelineResult` outputs. Mirrors
 * the P08-T01 dispatch fixture style.
 */

import {
  sha256ContentHash
} from "../dist/index.js";

import { makeFixtureContract } from "./dispatch-fixture.mjs";

function ref(path, payload) {
  return {
    path,
    sha256: sha256ContentHash(payload),
    mediaType: "text/markdown"
  };
}

/**
 * Build a successful review pipeline result for an entry. Mirrors
 * the deterministic stub used by the dispatch fixture: every command
 * exits 0, the reviewer passes every verdict, and the decision is
 * `accepted`.
 */
export function makeAcceptedReviewResult({
  contract,
  workerContext,
  implementer,
  reviewer
}) {
  const decision = {
    kind: "acceptance-decision",
    schemaVersion: "1.0.0",
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContextHash: workerContext.workerContextHash,
    tier: contract.risk.tier,
    outcome: "accepted",
    gates: [],
    failingGates: [],
    decisionSha256: sha256ContentHash(`accept:${contract.id}:${contract.revision}`),
    createdAt: "2026-06-22T02:30:00.000Z",
    rationale: "accepted for fixture"
  };

  const verification = {
    kind: "verification-report",
    schemaVersion: "1.0.0",
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContextHash: workerContext.workerContextHash,
    commands: [
      {
        index: 0,
        command: "pnpm",
        args: ["--filter", "@legion/core", "test"],
        exitCode: 0,
        expectedExitCode: 0,
        stdoutSha256: sha256ContentHash("merge-fixture-stdout"),
        stderrSha256: sha256ContentHash(""),
        combinedSha256: sha256ContentHash("merge-fixture-combined"),
        durationMs: 10,
        timedOut: false,
        startedAt: "2026-06-22T02:00:00.000Z",
        finishedAt: "2026-06-22T02:00:01.000Z"
      }
    ],
    passed: true,
    failingIndices: [],
    reportSha256: sha256ContentHash(`verify:${contract.id}:${contract.revision}`),
    createdAt: "2026-06-22T02:30:00.000Z"
  };

  const reviewRecord = {
    kind: "review-record",
    schemaVersion: "1.0.0",
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContextHash: workerContext.workerContextHash,
    reviewer,
    implementer,
    verdicts: { specification: "pass", integration: "pass", evidence: "pass" },
    findings: [],
    confidence: "high",
    summary: "merge fixture reviewer pass",
    independent: true,
    reviewHash: sha256ContentHash(`review:${contract.id}:${contract.revision}`),
    createdAt: "2026-06-22T02:00:00.000Z",
    submittedAt: "2026-06-22T02:30:00.000Z"
  };

  return {
    ok: true,
    schemaVersion: "1.0.0",
    kind: "task-review-pipeline",
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContextHash: workerContext.workerContextHash,
    isolationTag: workerContext.isolationTag,
    verification,
    review: reviewRecord,
    decision,
    reviewPipelineHash: sha256ContentHash(`pipeline:${contract.id}:${contract.revision}`),
    createdAt: "2026-06-22T02:30:00.000Z"
  };
}

/**
 * Build an accepted/rejected/escalated decision override. Used to
 * drive the integration gate's fail-closed paths.
 */
export function makeDecisionWithOutcome({ outcome, contract, workerContext, rationale }) {
  return {
    kind: "acceptance-decision",
    schemaVersion: "1.0.0",
    taskContractId: contract.id,
    contractRevision: contract.revision,
    workerContextHash: workerContext.workerContextHash,
    tier: contract.risk.tier,
    outcome,
    gates: [],
    failingGates: [],
    decisionSha256: sha256ContentHash(`decision:${outcome}:${contract.id}:${contract.revision}`),
    createdAt: "2026-06-22T02:30:00.000Z",
    rationale: rationale ?? `merge-fixture ${outcome}`
  };
}

/**
 * Build a `WorkerContext` for a merge queue entry. Mirrors the
 * `FreshContextDispatcher` output shape but uses deterministic
 * timestamps and hashes so tests can pin exact byte-for-byte
 * behavior.
 */
export function makeFixtureWorkerContext(contract, overrides = {}) {
  const workerContextHash = sha256ContentHash(
    `ctx:${contract.id}:${contract.revision}:${overrides.workerContextHash ?? "default"}`
  );
  const isolationTag = `merge-queue:v1:${workerContextHash.replace(/^sha256:/, "").slice(0, 12)}`;

  return {
    schemaVersion: "1.0.0",
    kind: "worker-context",
    taskContract: contract,
    contextRefs: {
      specRefs: contract.context.specRefs,
      designRefs: contract.context.designRefs,
      predecessorArtifacts: contract.context.predecessorArtifacts,
      all: [
        ...contract.context.specRefs,
        ...contract.context.designRefs,
        ...contract.context.predecessorArtifacts
      ]
    },
    scope: {
      read: [...contract.scope.read],
      write: [...contract.scope.write],
      forbidden: [...contract.scope.forbidden],
      sequentialFiles: [...contract.scope.sequentialFiles]
    },
    workerBundle: {
      id: "legion.merge-worker",
      version: "1.0.0",
      role: "implementer",
      domain: "merge",
      capabilities: ["merge-queue-integration"],
      promptContentContract: {
        instructionsHash: sha256ContentHash("merge-worker"),
        requiredSections: ["ordered-merge-queue"],
        forbiddenSections: []
      }
    },
    model: {
      provider: "minimax",
      id: "MiniMax-M3",
      policyVersion: "1.0.0"
    },
    workerContextHash,
    isolationTag,
    createdAt: "2026-06-22T03:00:00.000Z",
    protocolVersion: "0.1.0",
    ...overrides
  };
}

/**
 * Build a single merge queue entry. Pass `outcomeOverrides` to
 * override the per-task acceptance decision outcome.
 */
export function makeFixtureEntry({
  sequenceIndex,
  contract,
  workerContext,
  baseRef,
  headRef,
  targetRef,
  outcome = "accepted",
  reviewer,
  implementer
}) {
  const reviewResult = makeAcceptedReviewResult({
    contract,
    workerContext,
    implementer: implementer ?? { kind: "worker", id: "legion-worker" },
    reviewer: reviewer ?? { kind: "human", id: "reviewer.merge", displayName: "Merge Reviewer" }
  });

  const decision = makeDecisionWithOutcome({
    outcome,
    contract,
    workerContext,
    rationale: `merge fixture entry ${sequenceIndex} ${outcome}`
  });

  const verification = reviewResult.verification;
  const review = reviewResult.review;

  return {
    schemaVersion: "1.0.0",
    kind: "merge-queue",
    sequenceIndex,
    taskContract: contract,
    workerContext,
    reviewResult: {
      ...reviewResult,
      decision
    },
    refs: {
      workerContextHash: workerContext.workerContextHash,
      isolationTag: workerContext.isolationTag,
      reviewPipelineHash: reviewResult.reviewPipelineHash,
      verificationReportSha256: verification.reportSha256,
      reviewHash: review?.reviewHash ?? null,
      decisionSha256: decision.decisionSha256,
      taskContractId: contract.id,
      contractRevision: contract.revision
    },
    baseRef,
    headRef,
    targetRef,
    tier: contract.risk.tier,
    decision,
    submittedBy: implementer ?? { kind: "worker", id: "legion-worker" },
    submittedAt: "2026-06-22T03:00:00.000Z"
  };
}

/**
 * Build a sequence of merged-queue entries that do NOT conflict
 * (disjoint write paths) and progress head refs from a common base.
 */
export function makeSequencedEntries({ baseRef, startIndex = 0, count = 2 } = {}) {
  const entries = [];
  let headRef = baseRef;
  for (let i = 0; i < count; i += 1) {
    const sequenceIndex = startIndex + i;
    const targetRef = `merge-head-${sequenceIndex}-${Math.random().toString(36).slice(2, 10)}`;
    const contractOverrides = {
      id: `ctr_merge-${sequenceIndex}`,
      revision: 1,
      changeId: "chg_merge-queue",
      title: `Merge entry ${sequenceIndex}`,
      scope: {
        read: [".legion/project/specs/merge-queue.md"],
        write: [`packages/core/src/merge/entry-${sequenceIndex}.ts`],
        forbidden: ["packages/core/src/runtime/local-driver.ts"],
        sequentialFiles: []
      },
      completion: {
        expectedArtifacts: [
          ref(`packages/core/src/merge/entry-${sequenceIndex}.ts`, `entry-${sequenceIndex}-source`)
        ],
        requiredEvidence: [`entry-${sequenceIndex}-evidence`],
        blockedConditions: ["Merge queue cannot advance", "Path conflicts detected"]
      }
    };
    const contract = makeFixtureContract(contractOverrides);
    const workerContext = makeFixtureWorkerContext(contract, {
      workerContextHash: `merge-${sequenceIndex}`
    });
    entries.push(
      makeFixtureEntry({
        sequenceIndex,
        contract,
        workerContext,
        baseRef: i === 0 ? baseRef : headRef,
        headRef,
        targetRef
      })
    );
    headRef = targetRef;
  }
  return { entries, finalHeadRef: headRef };
}

/**
 * Build two entries whose `write` paths overlap — used to drive
 * the path conflict detector's `overlapping_write` path.
 */
export function makeOverlappingEntries({ baseRef, startIndex = 0 } = {}) {
  const sharedPath = "packages/core/src/merge/shared.ts";
  const buildEntry = (sequenceIndex, writePaths) => {
    const contract = makeFixtureContract({
      id: `ctr_merge-conflict-${sequenceIndex}`,
      revision: 1,
      changeId: "chg_merge-queue-conflict",
      title: `Conflicting merge entry ${sequenceIndex}`,
      scope: {
        read: [".legion/project/specs/merge-queue.md"],
        write: writePaths,
        forbidden: ["packages/core/src/runtime/local-driver.ts"],
        sequentialFiles: []
      },
      completion: {
        expectedArtifacts: [
          ref(`packages/core/src/merge/entry-${sequenceIndex}.ts`, `entry-${sequenceIndex}-source`)
        ],
        requiredEvidence: [`entry-${sequenceIndex}-evidence`],
        blockedConditions: ["Merge queue cannot advance"]
      }
    });
    const workerContext = makeFixtureWorkerContext(contract, {
      workerContextHash: `merge-conflict-${sequenceIndex}`
    });
    return makeFixtureEntry({
      sequenceIndex,
      contract,
      workerContext,
      baseRef: sequenceIndex === startIndex ? baseRef : `merge-head-${sequenceIndex - 1}`,
      headRef: `merge-head-${sequenceIndex - 1}`,
      targetRef: `merge-head-${sequenceIndex}`
    });
  };
  return [
    buildEntry(startIndex, [sharedPath, `packages/core/src/merge/entry-${startIndex}.ts`]),
    buildEntry(startIndex + 1, [sharedPath, `packages/core/src/merge/entry-${startIndex + 1}.ts`])
  ];
}

/**
 * Build a rebase runner that returns a deterministic successful
 * `RebaseCommandResult` advancing the head ref to the entry's
 * `targetRef`.
 */
export function makeIdentityRebaseRunner() {
  return (request) => ({
    entrySequenceIndex: request.entrySequenceIndex,
    command: "merge-queue.identity",
    args: ["--sequence", String(request.entrySequenceIndex)],
    exitCode: 0,
    expectedExitCode: 0,
    stdoutSha256: sha256ContentHash(`runner-stdout:${request.entrySequenceIndex}`),
    stderrSha256: sha256ContentHash(""),
    combinedSha256: sha256ContentHash(`runner-combined:${request.entrySequenceIndex}`),
    durationMs: 5,
    timedOut: false,
    startedAt: "2026-06-22T03:00:00.000Z",
    finishedAt: "2026-06-22T03:00:01.000Z",
    newHeadRef: request.targetRef
  });
}

/**
 * Build a runner that intentionally fails. Used to exercise the
 * `rebase_command_failed` issue code.
 */
export function makeFailingRebaseRunner() {
  return (request) => ({
    entrySequenceIndex: request.entrySequenceIndex,
    command: "merge-queue.identity",
    args: ["--sequence", String(request.entrySequenceIndex)],
    exitCode: 1,
    expectedExitCode: 0,
    stdoutSha256: sha256ContentHash(""),
    stderrSha256: sha256ContentHash("merge conflict"),
    combinedSha256: sha256ContentHash("merge conflict"),
    durationMs: 5,
    timedOut: false,
    startedAt: "2026-06-22T03:00:00.000Z",
    finishedAt: "2026-06-22T03:00:01.000Z",
    newHeadRef: request.headRef
  });
}
