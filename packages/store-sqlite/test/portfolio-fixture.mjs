/**
 * P11-T02 — Portfolio SQLite projector fixture.
 *
 * Mirrors the P11-T01 dashboard fixture style: minimal,
 * deterministic builders for board events that drive the
 * SQLite-backed portfolio projector tests.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_TENANT_ID = "tnt-portfolio-fixture-001";
const FIXTURE_PROJECT_A = "prj_portfolio_a";
const FIXTURE_PROJECT_B = "prj_portfolio_b";
const FIXTURE_CHANGE_A1 = "chg_portfolio_a1";
const FIXTURE_CHANGE_B1 = "chg_portfolio_b1";
const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "portfolio-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "portfolio-fixture-decision"
);
const FIXTURE_AGGREGATOR_HASH = sha256ContentHash(
  "portfolio-fixture-aggregator"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "portfolio-fixture-report"
);

export const PORTFOLIO_PROJECTOR_FIXTURE_CONSTANTS = {
  tenantId: FIXTURE_TENANT_ID,
  projectA: FIXTURE_PROJECT_A,
  projectB: FIXTURE_PROJECT_B,
  changeA1: FIXTURE_CHANGE_A1,
  changeB1: FIXTURE_CHANGE_B1,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

/**
 * Build an `AppendBoardEventInput` for a `task.created`
 * event so the SQLite projector tests can append the
 * fixture events through the standard event repository.
 */
export function buildTaskCreatedAppendInput({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  fromStatus = "queued",
  priority = 500,
  globalSequence = 1,
  occurredAt = "2026-06-22T05:00:00.000Z"
} = {}) {
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
      contractId: `ctr-${taskId}`,
      contractRevision: 1,
      contractHash: sha256ContentHash(`task-contract-${taskId}`),
      fromStatus,
      priority
    },
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: `portfolio:${taskId}:${globalSequence}:task.created`
  };
}

/**
 * Build an `AppendBoardEventInput` for a `task.transitioned`
 * event.
 */
export function buildTaskTransitionedAppendInput({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  fromStatus = "queued",
  toStatus = "ready",
  globalSequence = 2,
  occurredAt = "2026-06-22T05:01:00.000Z"
} = {}) {
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
    correlationId: null,
    causationId: null,
    idempotencyKey: `portfolio:${taskId}:${globalSequence}:task.transitioned`
  };
}

/**
 * Build an `AppendBoardEventInput` for a `task.linked`
 * cross-project event.
 */
export function buildTaskLinkedAppendInput({
  taskId = "task-portfolio-a-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  dependsOnTaskId = "task-portfolio-b-1",
  toProjectId = FIXTURE_PROJECT_B,
  relation = "depends_on",
  globalSequence = 3,
  occurredAt = "2026-06-22T05:02:00.000Z"
} = {}) {
  return {
    aggregateKind: "task_link",
    aggregateId: `${projectId}:${changeId}:${taskId}:${dependsOnTaskId}`,
    eventType: "task.linked",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "0.1.0",
      projectId,
      changeId,
      taskId,
      dependsOnTaskId,
      toProjectId,
      relation
    },
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: `portfolio:${taskId}:${globalSequence}:task.linked`
  };
}

/**
 * Build an `AppendBoardEventInput` for a `change.aggregated`
 * event.
 */
export function buildChangeAggregatedAppendInput({
  changeId = FIXTURE_CHANGE_A1,
  projectId = FIXTURE_PROJECT_A,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  aggregatorHash = FIXTURE_AGGREGATOR_HASH,
  status = "accepted",
  outcome = "integrated",
  globalSequence = 4,
  occurredAt = "2026-06-22T05:10:00.000Z"
} = {}) {
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
      reason: "portfolio fixture accepted",
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
    idempotencyKey: `portfolio:${changeId}:${mergeQueueHash}:change.aggregated:${globalSequence}`
  };
}

/**
 * Build an `AppendBoardEventInput` for a `release.promoted`
 * event.
 */
export function buildReleasePromotedAppendInput({
  changeId = FIXTURE_CHANGE_A1,
  projectId = FIXTURE_PROJECT_A,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  globalSequence = 5,
  occurredAt = "2026-06-22T05:30:00.000Z"
} = {}) {
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
      reason: "portfolio fixture promoted",
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
        windowEnd: occurredAt,
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
    idempotencyKey: `portfolio:${changeId}:${mergeQueueHash}:${reportSha256}:release.promoted:${globalSequence}`
  };
}

/**
 * Helper: produce a coherent multi-project event stream for
 * the SQLite projector tests.
 */
export function buildMultiProjectAppendStream() {
  return [
    buildTaskCreatedAppendInput({
      taskId: "task-a-1",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      priority: 800,
      globalSequence: 1
    }),
    buildTaskCreatedAppendInput({
      taskId: "task-a-2",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      priority: 200,
      globalSequence: 2
    }),
    buildTaskCreatedAppendInput({
      taskId: "task-b-1",
      projectId: FIXTURE_PROJECT_B,
      changeId: FIXTURE_CHANGE_B1,
      priority: 100,
      globalSequence: 3
    }),
    buildTaskLinkedAppendInput({
      taskId: "task-a-1",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      dependsOnTaskId: "task-b-1",
      toProjectId: FIXTURE_PROJECT_B,
      relation: "depends_on",
      globalSequence: 4
    }),
    buildChangeAggregatedAppendInput({
      changeId: FIXTURE_CHANGE_A1,
      projectId: FIXTURE_PROJECT_A,
      globalSequence: 5
    }),
    buildReleasePromotedAppendInput({
      changeId: FIXTURE_CHANGE_A1,
      projectId: FIXTURE_PROJECT_A,
      globalSequence: 6
    })
  ];
}
