/**
 * P09-T02 — Whole-change acceptance fixture helpers.
 *
 * Minimal, deterministic builders for orchestrator results and
 * board events used by the whole-change acceptance tests.
 * Mirrors the P09-T01 merge fixture style.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash("whole-change-fixture-merge-queue");
const FIXTURE_DECISION_SHA256 = sha256ContentHash("whole-change-fixture-decision");
const FIXTURE_WORKER_CONTEXT_HASH = sha256ContentHash("whole-change-fixture-worker-context");
const FIXTURE_CHANGE_ID = "chg-whole-change-fixture-001";

export const WHOLE_CHANGE_FIXTURE_CONSTANTS = {
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  workerContextHash: FIXTURE_WORKER_CONTEXT_HASH
};

/**
 * Build a `MergeQueueOrchestratorSuccess` shape (matching the
 * core merge contract). Only the fields the aggregator inspects
 * are populated.
 */
export function makeOrchestratorSuccess({
  outcome = "integrated",
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  finalHeadRef = "refs/heads/whole-change-fixture",
  acceptedEntries = [0, 1],
  rejectedEntries = [],
  escalatedEntries = [],
  conflictEntries = []
} = {}) {
  const allEntries = [
    ...acceptedEntries,
    ...rejectedEntries,
    ...escalatedEntries,
    ...conflictEntries
  ].sort((a, b) => a - b);

  const steps = allEntries.map((seq) => ({
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
    outcome: outcome,
    headRefBefore: "refs/heads/whole-change-fixture-prev",
    headRefAfter: finalHeadRef,
    conflicts: [],
    rebase: null,
    verification: null,
    review: null,
    issues: [],
    stepSha256: sha256ContentHash(`step-${seq}-${outcome}`),
    createdAt: "2026-06-22T04:00:00.000Z"
  }));

  const snapshot = {
    schemaVersion: "1.0.0",
    kind: "merge-queue",
    sequenceLength: steps.length,
    steps,
    orderedSequenceIndices: allEntries,
    mergeQueueHash,
    createdAt: "2026-06-22T04:00:00.000Z"
  };

  const decision = {
    schemaVersion: "1.0.0",
    kind: "merge-integration-decision",
    mergeQueueHash,
    finalHeadRef,
    outcome,
    acceptedEntries,
    rejectedEntries,
    escalatedEntries,
    conflictEntries,
    decisionSha256,
    createdAt: "2026-06-22T04:00:00.000Z",
    rationale: `whole-change fixture ${outcome}`
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
    createdAt: "2026-06-22T04:00:00.000Z"
  };
}

/**
 * Build a `BoardEvent` for the whole-change aggregate. The
 * caller supplies the payload so tests can pin exact bytes.
 */
export function makeBoardEvent({
  payload,
  globalSequence = 1,
  aggregateSequence = 1,
  eventType = "change.accepted",
  occurredAt = "2026-06-22T04:00:00.000Z",
  aggregateId = `${FIXTURE_CHANGE_ID}:${FIXTURE_MERGE_QUEUE_HASH}`
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-fixture-${globalSequence}`,
    aggregateKind: "whole_change",
    aggregateId,
    aggregateSequence,
    globalSequence,
    eventType,
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: "fixture-correlation",
    occurredAt,
    idempotencyKey: `${FIXTURE_CHANGE_ID}:${FIXTURE_MERGE_QUEUE_HASH}:${eventType}`,
    payloadJson: JSON.stringify(payload)
  };
}

/**
 * Build a non-whole-change `BoardEvent`. Used to verify the
 * reducer silently ignores foreign events.
 */
export function makeForeignBoardEvent({
  globalSequence = 1,
  aggregateSequence = 1,
  aggregateKind = "task",
  eventType = "task.created"
} = {}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-foreign-${globalSequence}`,
    aggregateKind,
    aggregateId: "ctr-foreign",
    aggregateSequence,
    globalSequence,
    eventType,
    eventVersion: "0.1.0",
    payload: { schemaVersion: "0.1.0", foreign: true },
    payloadHash: sha256ContentHash(`foreign-${globalSequence}`),
    causationId: null,
    correlationId: null,
    occurredAt: "2026-06-22T04:00:00.000Z",
    idempotencyKey: null,
    payloadJson: '{"schemaVersion":"0.1.0","foreign":true}'
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