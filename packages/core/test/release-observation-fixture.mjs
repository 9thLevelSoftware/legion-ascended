/**
 * P10-T01 — Release observation fixture helpers.
 *
 * Minimal, deterministic builders for merge queue
 * orchestrator results + canary/health/regression/alert
 * inputs used by the release observation tests. Mirrors
 * the P09-T01 / P09-T02 fixture style.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "release-observation-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "release-observation-fixture-decision"
);
const FIXTURE_WORKER_CONTEXT_HASH = sha256ContentHash(
  "release-observation-fixture-worker-context"
);
const FIXTURE_CHANGE_ID = "chg-release-observation-fixture-001";

export const RELEASE_OBSERVATION_FIXTURE_CONSTANTS = {
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  workerContextHash: FIXTURE_WORKER_CONTEXT_HASH
};

/**
 * Build a `MergeQueueOrchestratorSuccess` shape (matching the
 * core merge contract) configured to be `releaseable`.
 */
export function makeReleaseableOrchestratorResult({
  outcome = "integrated",
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  finalHeadRef = "refs/heads/release-observation-fixture",
  acceptedEntries = [0, 1]
} = {}) {
  const steps = acceptedEntries.map((seq) => ({
    schemaVersion: "1.0.0",
    kind: "merge-queue-step",
    sequenceIndex: seq,
    entryRef: {
      workerContextHash: sha256ContentHash(`worker-context-${seq}`),
      isolationTag: `merge-queue:v1:step-${seq}`,
      reviewPipelineHash: sha256ContentHash(`review-pipeline-${seq}`),
      verificationReportSha256: sha256ContentHash(`verification-${seq}`),
      reviewHash: sha256ContentHash(`review-${seq}`),
      decisionSha256: sha256ContentHash(`decision-${seq}`),
      taskContractId: `ctr_step-${seq}`,
      contractRevision: 1
    },
    outcome,
    headRefBefore: "refs/heads/release-observation-fixture-prev",
    headRefAfter: finalHeadRef,
    conflicts: [],
    rebase: null,
    verification: null,
    review: null,
    issues: [],
    stepSha256: sha256ContentHash(`step-${seq}-${outcome}`),
    createdAt: "2026-06-22T05:00:00.000Z"
  }));

  const snapshot = {
    schemaVersion: "1.0.0",
    kind: "merge-queue",
    sequenceLength: steps.length,
    steps,
    orderedSequenceIndices: acceptedEntries,
    mergeQueueHash,
    createdAt: "2026-06-22T05:00:00.000Z"
  };

  const decision = {
    schemaVersion: "1.0.0",
    kind: "merge-integration-decision",
    mergeQueueHash,
    finalHeadRef,
    outcome,
    acceptedEntries,
    rejectedEntries: [],
    escalatedEntries: [],
    conflictEntries: [],
    decisionSha256,
    createdAt: "2026-06-22T05:00:00.000Z",
    rationale: `release-observation fixture ${outcome}`
  };

  return {
    ok: true,
    schemaVersion: "1.0.0",
    kind: "merge-queue",
    snapshot,
    decision,
    blockers: [],
    issues: [],
    mergeQueueHash,
    createdAt: "2026-06-22T05:00:00.000Z"
  };
}

export function makeNonReleaseableOrchestratorResult({
  outcome = "rejected",
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256
} = {}) {
  return makeReleaseableOrchestratorResult({
    outcome,
    mergeQueueHash,
    decisionSha256,
    acceptedEntries: []
  });
}

/**
 * Build a canary input that already has outcomes assigned
 * (i.e. the runner is not invoked). Used for tests that
 * don't need the runner to mutate probe invocations.
 */
export function makeCanaryInput({
  passed = 2,
  failed = 0,
  tier = "R0"
} = {}) {
  const invocations = [];
  for (let i = 0; i < passed; i += 1) {
    invocations.push({
      probeId: `canary-pass-${i}`,
      tier,
      weight: 1,
      expectedOutcome: "passed",
      startedAt: "2026-06-22T05:00:00.000Z",
      finishedAt: "2026-06-22T05:00:01.000Z",
      outcome: "passed"
    });
  }
  for (let i = 0; i < failed; i += 1) {
    invocations.push({
      probeId: `canary-fail-${i}`,
      tier,
      weight: 1,
      expectedOutcome: "passed",
      startedAt: "2026-06-22T05:00:00.000Z",
      finishedAt: "2026-06-22T05:00:01.000Z",
      outcome: "failed"
    });
  }
  return { invocations };
}

/**
 * Build a health check input. Mark `degraded` to produce
 * the degraded health outcome.
 */
export function makeHealthCheckInput({
  healthy = 2,
  degraded = 0
} = {}) {
  const invocations = [];
  for (let i = 0; i < healthy; i += 1) {
    invocations.push({
      checkId: `health-pass-${i}`,
      endpoint: `https://example.com/health/${i}`,
      intervalMs: 30_000,
      timeoutMs: 5_000,
      expectedStatus: "healthy",
      startedAt: "2026-06-22T05:00:00.000Z",
      finishedAt: "2026-06-22T05:00:01.000Z",
      observedStatus: "healthy",
      latencyMs: 12
    });
  }
  for (let i = 0; i < degraded; i += 1) {
    invocations.push({
      checkId: `health-degraded-${i}`,
      endpoint: `https://example.com/health/degraded/${i}`,
      intervalMs: 30_000,
      timeoutMs: 5_000,
      expectedStatus: "healthy",
      startedAt: "2026-06-22T05:00:00.000Z",
      finishedAt: "2026-06-22T05:00:01.000Z",
      observedStatus: "degraded",
      latencyMs: 4_500
    });
  }
  return { invocations };
}

export function makeRegressionInput({
  baseline = null,
  signals = []
} = {}) {
  return { baseline, signals };
}

export function makeAlertInput({
  critical = 0,
  warn = 0
} = {}) {
  const candidateAlerts = [];
  for (let i = 0; i < critical; i += 1) {
    candidateAlerts.push({
      alertId: `alert-critical-${i}`,
      severity: "critical",
      title: `critical alert ${i}`,
      summary: "fire",
      source: "canary"
    });
  }
  for (let i = 0; i < warn; i += 1) {
    candidateAlerts.push({
      alertId: `alert-warn-${i}`,
      severity: "warn",
      title: `warn alert ${i}`,
      summary: "warn",
      source: "canary"
    });
  }
  return { candidateAlerts };
}

export function makeObserver() {
  return {
    id: "chg-release-observation-fixture-001",
    type: "ci-bot",
    displayName: "ci-bot"
  };
}

export function sha256OfCanonicalFixture(value) {
  function canonical(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return sha256ContentHash(canonical(value));
}
