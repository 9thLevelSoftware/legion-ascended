/**
 * P11-T01 — Dashboard projection fixture.
 *
 * Mirrors the P09-T02 / P10-T01 whole-change + release-
 * observation fixture style: minimal, deterministic
 * builders for board events that drive the dashboard
 * projection reducer and projector tests.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_PROJECT_ID = "proj-dashboard-fixture-001";
const FIXTURE_CHANGE_ID = "chg-dashboard-fixture-001";
const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "dashboard-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "dashboard-fixture-decision"
);
const FIXTURE_AGGREGATOR_HASH = sha256ContentHash(
  "dashboard-fixture-aggregator"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "dashboard-fixture-report"
);

export const DASHBOARD_FIXTURE_CONSTANTS = {
  projectId: FIXTURE_PROJECT_ID,
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

/**
 * Build a minimal `task.created`-shaped board event.
 */
export function makeTaskCreatedEvent({
  taskId = "task-fixture-1",
  projectId = FIXTURE_PROJECT_ID,
  fromStatus = "queued",
  changeId = FIXTURE_CHANGE_ID,
  priority = 10,
  contractId = "ct-1",
  contractRevision = 1,
  contractHash = sha256ContentHash(`task-contract-${taskId}`),
  aggregateSequence = 1,
  globalSequence = 1,
  occurredAt = "2026-06-22T05:00:00.000Z",
  eventId
} = {}) {
  const payload = {
    schemaVersion: "0.1.0",
    projectId,
    changeId,
    taskId,
    contractId,
    contractRevision,
    contractHash,
    fromStatus,
    priority
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-task-${taskId}-${globalSequence}`,
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    aggregateSequence,
    globalSequence,
    eventType: "task.created",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `task:${taskId}:created:${globalSequence}`,
    payloadJson: JSON.stringify(payload)
  };
}

/**
 * Build a minimal `task.transitioned` event.
 */
export function makeTaskTransitionedEvent({
  taskId = "task-fixture-1",
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  toStatus = "ready",
  fromStatus = "queued",
  aggregateSequence = 2,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  const payload = {
    schemaVersion: "0.1.0",
    projectId,
    changeId,
    taskId,
    fromStatus,
    toStatus
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-task-${taskId}-trans-${globalSequence}`,
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    aggregateSequence,
    globalSequence,
    eventType: "task.transitioned",
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:01:00.000Z",
    idempotencyKey: `task:${taskId}:transition:${globalSequence}`,
    payloadJson: JSON.stringify(payload)
  };
}

/**
 * Build a `change.aggregated` event with a typed status.
 */
export function makeChangeAggregatedEvent({
  changeId = FIXTURE_CHANGE_ID,
  projectId = FIXTURE_PROJECT_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  status = "accepted",
  outcome = "integrated",
  reason = "all entries integrated",
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  const payload = {
    schemaVersion: "1.0.0",
    kind: "whole_change",
    projectId,
    changeId,
    mergeQueueHash,
    decisionSha256,
    aggregatorHash,
    status,
    outcome,
    reason,
    acceptedEntries: [1, 2, 3],
    rejectedEntries: [],
    escalatedEntries: [],
    conflictEntries: [],
    finalHeadRef: "abc123",
    acceptedAt: "2026-06-22T05:10:00.000Z",
    acceptedBy: "ci-bot",
    workerContextHashes: []
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-change-${changeId}-${globalSequence}`,
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
 * Build a `release.promoted` event.
 */
export function makeReleasePromotedEvent({
  changeId = FIXTURE_CHANGE_ID,
  projectId = FIXTURE_PROJECT_ID,
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
      projectId,
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
    eventId: eventId ?? `evt-release-${changeId}-${globalSequence}`,
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

/**
 * Build a `release.regressed` event.
 */
export function makeReleaseRegressedEvent({
  changeId = FIXTURE_CHANGE_ID,
  projectId = FIXTURE_PROJECT_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId,
  reason = "canary regression detected",
  failureReason
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
    failureReason: failureReason ?? "error rate spike",
    report: {
      schemaVersion: "1.0.0",
      kind: "release-observation",
      projectId,
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
      failureReason: failureReason ?? "error rate spike"
    }
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-release-${changeId}-reg-${globalSequence}`,
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

/**
 * Build a foreign event for a different projectId. Used to
 * verify the dashboard reducer's foreign-event safety.
 */
export function makeForeignProjectTaskEvent({
  projectId = "proj-foreign-002",
  changeId = "chg-foreign-002",
  taskId = "task-foreign-2",
  globalSequence = 99,
  occurredAt = "2026-06-22T05:50:00.000Z",
  eventId
} = {}) {
  return makeTaskCreatedEvent({
    projectId,
    changeId,
    taskId,
    aggregateSequence: 1,
    globalSequence,
    occurredAt,
    eventId
  });
}