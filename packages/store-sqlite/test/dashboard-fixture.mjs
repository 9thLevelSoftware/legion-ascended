/**
 * P11-T01 — SqliteDashboardProjector fixture.
 *
 * Mirrors the P09-T02 / P10-T01 whole-change +
 * release-observation fixture style: minimal builders for
 * board events that drive the dashboard projector tests
 * against a real SQLite database.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_PROJECT_ID = "proj-dashboard-proj-fixture-001";
const FIXTURE_CHANGE_ID = "chg-dashboard-proj-fixture-001";
const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "dashboard-proj-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "dashboard-proj-fixture-decision"
);
const FIXTURE_AGGREGATOR_HASH = sha256ContentHash(
  "dashboard-proj-fixture-aggregator"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "dashboard-proj-fixture-report"
);

export const DASHBOARD_PROJECTOR_FIXTURE_CONSTANTS = {
  projectId: FIXTURE_PROJECT_ID,
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

export function buildTaskCreatedAppendInput({
  taskId,
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  fromStatus = "queued",
  priority = 10,
  contractId = "ct-1",
  contractRevision = 1,
  contractHash = sha256ContentHash(`dashboard-proj-contract-${taskId}`),
  occurredAt = "2026-06-22T05:00:00.000Z",
  idempotencyKey = `task:${taskId}:created:${occurredAt}`,
  causationId = null,
  correlationId = null
}) {
  return {
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    eventType: "task.created",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "0.1.0",
      projectId,
      changeId,
      taskId,
      contractId,
      contractRevision,
      contractHash,
      fromStatus,
      priority
    },
    occurredAt,
    correlationId,
    causationId,
    idempotencyKey
  };
}

export function buildTaskTransitionedAppendInput({
  taskId,
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  fromStatus = "queued",
  toStatus = "ready",
  occurredAt = "2026-06-22T05:01:00.000Z",
  idempotencyKey = `task:${taskId}:transition:${occurredAt}`,
  causationId = null,
  correlationId = null
}) {
  return {
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    eventType: "task.transitioned",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "0.1.0",
      projectId,
      changeId,
      taskId,
      fromStatus,
      toStatus
    },
    occurredAt,
    correlationId,
    causationId,
    idempotencyKey
  };
}

export function buildChangeAggregatedAppendInput({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  status = "accepted",
  outcome = "integrated",
  reason = "all entries integrated",
  occurredAt = "2026-06-22T05:10:00.000Z",
  idempotencyKey
}) {
  return {
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    eventType: "change.aggregated",
    eventVersion: "0.1.0",
    payload: {
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
      acceptedAt: occurredAt,
      acceptedBy: "ci-bot",
      workerContextHashes: []
    },
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: idempotencyKey ?? `${changeId}:${mergeQueueHash}:change.aggregated:${occurredAt}`
  };
}

export function buildReleasePromotedAppendInput({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  occurredAt = "2026-06-22T05:30:00.000Z",
  idempotencyKey
}) {
  return {
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    eventType: "release.promoted",
    eventVersion: "0.1.0",
    payload: {
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
      observedAt: occurredAt,
      observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
      canary: null,
      healthCheck: null,
      regression: null,
      alert: null,
      reason: "canary + health green",
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
        observedAt: occurredAt,
        observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
        canary: null,
        healthCheck: null,
        regression: null,
        alert: null,
        reportSha256,
        failureReason: null
      },
      failureReason: null
    },
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: idempotencyKey ?? `${changeId}:${mergeQueueHash}:${reportSha256}:release.promoted`
  };
}