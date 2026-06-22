/**
 * P11-T01 — SqliteApprovalGateProjector fixture.
 *
 * Mirrors the P09-T02 / P10-T01 fixture style: minimal
 * builders for board events that drive the approval-gate
 * projector tests against a real SQLite database.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_PROJECT_ID = "proj-approval-gate-proj-fixture-001";
const FIXTURE_CHANGE_ID = "chg-approval-gate-proj-fixture-001";
const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "approval-gate-proj-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "approval-gate-proj-fixture-decision"
);
const FIXTURE_AGGREGATOR_HASH = sha256ContentHash(
  "approval-gate-proj-fixture-aggregator"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "approval-gate-proj-fixture-report"
);

export const APPROVAL_GATE_PROJECTOR_FIXTURE_CONSTANTS = {
  projectId: FIXTURE_PROJECT_ID,
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

export function buildAggregatedAcceptedAppendInput({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
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
      status: "accepted",
      outcome: "integrated",
      reason: "all entries integrated",
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

export function buildAggregatedRejectedAppendInput({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
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
      status: "rejected",
      outcome: "rejected",
      reason: "conflict detected",
      acceptedEntries: [],
      rejectedEntries: [1, 2],
      escalatedEntries: [],
      conflictEntries: [1, 2],
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

export function buildReleaseRegressedAppendInput({
  projectId = FIXTURE_PROJECT_ID,
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  occurredAt = "2026-06-22T05:45:00.000Z",
  failureReason = "error rate spike",
  idempotencyKey
}) {
  return {
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    eventType: "release.regressed",
    eventVersion: "0.1.0",
    payload: {
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
      observedAt: occurredAt,
      observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
      canary: null,
      healthCheck: null,
      regression: null,
      alert: null,
      reason: "canary regression detected",
      failureReason,
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
        observedAt: occurredAt,
        observedBy: { id: "ci-bot", type: "ci-bot", displayName: "ci-bot" },
        canary: null,
        healthCheck: null,
        regression: null,
        alert: null,
        reportSha256,
        failureReason
      }
    },
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: idempotencyKey ?? `${changeId}:${mergeQueueHash}:${reportSha256}:release.regressed`
  };
}