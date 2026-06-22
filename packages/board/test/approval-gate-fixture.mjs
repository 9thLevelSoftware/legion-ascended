/**
 * P11-T01 — Approval-gate projection fixture.
 *
 * Mirrors the P09-T02 / P10-T01 whole-change + release-
 * observation fixture style: minimal, deterministic
 * builders for board events that drive the approval-gate
 * projection reducer and projector tests.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_PROJECT_ID = "proj-approval-gate-fixture-001";
const FIXTURE_CHANGE_ID = "chg-approval-gate-fixture-001";
const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "approval-gate-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "approval-gate-fixture-decision"
);
const FIXTURE_AGGREGATOR_HASH = sha256ContentHash(
  "approval-gate-fixture-aggregator"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "approval-gate-fixture-report"
);

export const APPROVAL_GATE_FIXTURE_CONSTANTS = {
  projectId: FIXTURE_PROJECT_ID,
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

export function makeAggregatedAcceptedEvent({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "all entries integrated"
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "whole_change",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256,
    aggregatorHash,
    status: "accepted",
    outcome: "integrated",
    reason,
    acceptedEntries: [1, 2, 3],
    rejectedEntries: [],
    escalatedEntries: [],
    conflictEntries: [],
    finalHeadRef: "abc123",
    acceptedAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    acceptedBy: "ci-bot",
    workerContextHashes: []
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-chg-acc-${changeId}-${globalSequence}`,
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    aggregateSequence,
    globalSequence,
    eventType: "change.aggregated",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    idempotencyKey: `${changeId}:${mergeQueueHash}:change.aggregated:${globalSequence}`,
    payloadJson: JSON.stringify(payload)
  };
}

export function makeAggregatedRejectedEvent({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "conflict detected"
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "whole_change",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256,
    aggregatorHash,
    status: "rejected",
    outcome: "rejected",
    reason,
    acceptedEntries: [],
    rejectedEntries: [1, 2],
    escalatedEntries: [],
    conflictEntries: [1, 2],
    finalHeadRef: "abc123",
    acceptedAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    acceptedBy: "ci-bot",
    workerContextHashes: []
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-chg-rej-${changeId}-${globalSequence}`,
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    aggregateSequence,
    globalSequence,
    eventType: "change.aggregated",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    idempotencyKey: `${changeId}:${mergeQueueHash}:change.aggregated:${globalSequence}`,
    payloadJson: JSON.stringify(payload)
  };
}

export function makeReleasePromotedEvent({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "canary + health green"
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256: FIXTURE_DECISION_SHA256,
    reportSha256,
    status: "promoted",
    tier: "R0",
    releaseability: "releaseable",
    observedAt: occurredAt ?? "2026-06-22T05:30:00.000Z",
    observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    reason,
    report: {
      schemaVersion: "1.0.0",
      kind: "release-observation",
      changeId,
      mergeQueueHash,
      decisionSha256: FIXTURE_DECISION_SHA256,
      tier: "R0",
      releaseability: "releaseable",
      status: "promoted",
      windowStart: "2026-06-22T05:00:00.000Z",
      windowEnd: "2026-06-22T05:30:00.000Z",
      observedAt: occurredAt ?? "2026-06-22T05:30:00.000Z",
      observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
      canary: null,
      healthCheck: null,
      regression: null,
      alert: null,
      reportSha256,
      failureReason: null
    },
    failureReason: null
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-rel-pro-${changeId}-${globalSequence}`,
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    aggregateSequence,
    globalSequence,
    eventType: "release.promoted",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:30:00.000Z",
    idempotencyKey: `${changeId}:${mergeQueueHash}:${reportSha256}:release.promoted`,
    payloadJson: JSON.stringify(payload)
  };
}

export function makeReleaseRegressedEvent({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "canary regression detected",
  failureReason = "error rate spike"
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256: FIXTURE_DECISION_SHA256,
    reportSha256,
    status: "regressed",
    tier: "R0",
    releaseability: "not_releaseable",
    observedAt: occurredAt ?? "2026-06-22T05:45:00.000Z",
    observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    reason,
    failureReason,
    report: {
      schemaVersion: "1.0.0",
      kind: "release-observation",
      changeId,
      mergeQueueHash,
      decisionSha256: FIXTURE_DECISION_SHA256,
      tier: "R0",
      releaseability: "not_releaseable",
      status: "regressed",
      windowStart: "2026-06-22T05:30:00.000Z",
      windowEnd: "2026-06-22T05:45:00.000Z",
      observedAt: occurredAt ?? "2026-06-22T05:45:00.000Z",
      observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
      canary: null,
      healthCheck: null,
      regression: null,
      alert: null,
      reportSha256,
      failureReason
    }
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-rel-reg-${changeId}-${globalSequence}`,
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    aggregateSequence,
    globalSequence,
    eventType: "release.regressed",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:45:00.000Z",
    idempotencyKey: `${changeId}:${mergeQueueHash}:${reportSha256}:release.regressed`,
    payloadJson: JSON.stringify(payload)
  };
}

export function makeChangeBlockedEvent({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "merge queue conflict"
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "whole_change",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256,
    aggregatorHash,
    status: "blocked",
    outcome: "blocked",
    reason,
    acceptedEntries: [],
    rejectedEntries: [],
    escalatedEntries: [],
    conflictEntries: [1],
    finalHeadRef: "abc123",
    acceptedAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    acceptedBy: "ci-bot",
    workerContextHashes: []
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-chg-blk-${changeId}-${globalSequence}`,
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    aggregateSequence,
    globalSequence,
    eventType: "change.aggregated",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
    idempotencyKey: `${changeId}:${mergeQueueHash}:change.aggregated:${globalSequence}`,
    payloadJson: JSON.stringify(payload)
  };
}

/**
 * Build a foreign event for a different (projectId, changeId)
 * pair. Used to verify the approval-gate reducer's foreign-
 * event safety.
 */
export function makeForeignChangeEvent({
  projectId = "proj-foreign-002",
  changeId = "chg-foreign-002",
  globalSequence = 99,
  occurredAt = "2026-06-22T05:50:00.000Z",
  eventId
} = {}) {
  return makeAggregatedAcceptedEvent({
    projectId,
    changeId,
    mergeQueueHash: sha256ContentHash(`foreign-merge-${changeId}`),
    decisionSha256: sha256ContentHash(`foreign-decision-${changeId}`),
    aggregatorHash: sha256ContentHash(`foreign-aggregator-${changeId}`),
    aggregateSequence: 1,
    globalSequence,
    occurredAt,
    eventId,
    reason: "foreign change"
  });
}