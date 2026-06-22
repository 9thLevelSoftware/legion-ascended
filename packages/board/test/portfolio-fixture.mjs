/**
 * P11-T02 — Portfolio projection fixture.
 *
 * Mirrors the P11-T01 dashboard fixture style: minimal,
 * deterministic builders for board events that drive the
 * portfolio projection reducer and projector tests across
 * multiple projects in a single tenant.
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
const FIXTURE_PROJECT_C = "prj_portfolio_c";
const FIXTURE_PROJECT_FOREIGN = "prj_portfolio_foreign";
const FIXTURE_CHANGE_A1 = "chg_portfolio_a1";
const FIXTURE_CHANGE_B1 = "chg_portfolio_b1";
const FIXTURE_CHANGE_C1 = "chg_portfolio_c1";
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

export const PORTFOLIO_FIXTURE_CONSTANTS = {
  tenantId: FIXTURE_TENANT_ID,
  projectA: FIXTURE_PROJECT_A,
  projectB: FIXTURE_PROJECT_B,
  projectC: FIXTURE_PROJECT_C,
  foreignProject: FIXTURE_PROJECT_FOREIGN,
  changeA1: FIXTURE_CHANGE_A1,
  changeB1: FIXTURE_CHANGE_B1,
  changeC1: FIXTURE_CHANGE_C1,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  aggregatorHash: FIXTURE_AGGREGATOR_HASH,
  reportSha256: FIXTURE_REPORT_SHA256
};

function buildBaseEvent({
  taskId,
  projectId,
  changeId,
  priority,
  fromStatus,
  toStatus,
  relation,
  dependsOnTaskId,
  toProjectId,
  payloadExtras,
  aggregateKind,
  eventType,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId
}) {
  const payload = {
    schemaVersion: "0.1.0",
    projectId,
    changeId,
    taskId,
    contractId: `ctr-${taskId ?? "na"}`,
    contractRevision: 1,
    contractHash: sha256ContentHash(`task-contract-${taskId ?? "na"}`),
    fromStatus,
    toStatus,
    priority,
    relation,
    dependsOnTaskId,
    toProjectId,
    ...(payloadExtras ?? {})
  };
  return {
    schemaVersion: "0.1.0",
    eventId: eventId ?? `evt-portfolio-${globalSequence}-${eventType}`,
    aggregateKind,
    aggregateId: `${projectId}:${changeId}:${taskId ?? "na"}`,
    aggregateSequence,
    globalSequence,
    eventType,
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: null,
    occurredAt: occurredAt ?? "2026-06-22T05:00:00.000Z",
    idempotencyKey: `portfolio:${globalSequence}:${eventType}`,
    payloadJson: JSON.stringify(payload)
  };
}

/**
 * Build a `task.created` event for the portfolio fixture.
 */
export function makePortfolioTaskCreatedEvent({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  fromStatus = "queued",
  priority = 500,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  return buildBaseEvent({
    taskId,
    projectId,
    changeId,
    priority,
    fromStatus,
    aggregateKind: "task",
    eventType: "task.created",
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a `task.transitioned` event.
 */
export function makePortfolioTaskTransitionedEvent({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  toStatus = "ready",
  fromStatus = "queued",
  aggregateSequence = 2,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  return buildBaseEvent({
    taskId,
    projectId,
    changeId,
    priority: 500,
    fromStatus,
    toStatus,
    aggregateKind: "task",
    eventType: "task.transitioned",
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a `task.priority_changed` event.
 */
export function makePortfolioTaskPriorityChangedEvent({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  priority = 800,
  aggregateSequence = 3,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  return buildBaseEvent({
    taskId,
    projectId,
    changeId,
    priority,
    aggregateKind: "task",
    eventType: "task.priority_changed",
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a `task.linked` event for a cross-project edge.
 *
 * The fixture emits the destination project under
 * `toProjectId` so the reducer can detect a cross-project
 * edge; same-project edges (no `toProjectId`) are dropped
 * from the public edges array.
 */
export function makePortfolioTaskLinkedEvent({
  taskId = "task-portfolio-1",
  projectId = FIXTURE_PROJECT_A,
  changeId = FIXTURE_CHANGE_A1,
  dependsOnTaskId = "task-portfolio-dep-1",
  toProjectId = FIXTURE_PROJECT_B,
  relation = "depends_on",
  aggregateSequence = 4,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  return buildBaseEvent({
    taskId,
    projectId,
    changeId,
    relation,
    dependsOnTaskId,
    toProjectId,
    aggregateKind: "task_link",
    eventType: "task.linked",
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a `change.aggregated` event carrying a status.
 */
export function makePortfolioChangeAggregatedEvent({
  changeId = FIXTURE_CHANGE_A1,
  projectId = FIXTURE_PROJECT_A,
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
  return buildBaseEvent({
    taskId: "na",
    projectId,
    changeId,
    aggregateKind: "whole_change",
    eventType: "change.aggregated",
    payloadExtras: {
      schemaVersion: "1.0.0",
      kind: "whole_change",
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
      acceptedAt: occurredAt ?? "2026-06-22T05:10:00.000Z",
      acceptedBy: "ci-bot",
      workerContextHashes: []
    },
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a `release.promoted` event.
 */
export function makePortfolioReleasePromotedEvent({
  changeId = FIXTURE_CHANGE_A1,
  projectId = FIXTURE_PROJECT_A,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  reportSha256 = FIXTURE_REPORT_SHA256,
  aggregateSequence = 1,
  globalSequence,
  occurredAt,
  eventId
} = {}) {
  return buildBaseEvent({
    taskId: "na",
    projectId,
    changeId,
    aggregateKind: "release_observation",
    eventType: "release.promoted",
    payloadExtras: {
      schemaVersion: "1.0.0",
      kind: "release-observation",
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
    },
    aggregateSequence,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Build a foreign-tenant task event for reducer foreign-
 * event safety tests. Foreign-tenant events are dropped
 * silently by the reducer (tenant scope is implicitly
 * defined by the projector instance).
 */
export function makeForeignTenantTaskEvent({
  projectId = FIXTURE_PROJECT_FOREIGN,
  changeId = "chg_foreign",
  taskId = "task-foreign",
  globalSequence = 99,
  occurredAt = "2026-06-22T05:50:00.000Z",
  eventId
} = {}) {
  return makePortfolioTaskCreatedEvent({
    projectId,
    changeId,
    taskId,
    fromStatus: "queued",
    priority: 100,
    globalSequence,
    occurredAt,
    eventId
  });
}

/**
 * Helper: produce a coherent multi-project event stream for
 * the portfolio reducer tests. Two projects in the same
 * tenant carry task.* + task.linked + change.* events; a
 * third project is dropped by the scope filter.
 */
export function buildMultiProjectEventStream() {
  return [
    // Project A: two tasks, one cross-project link, one
    // accepted change, one promoted release.
    makePortfolioTaskCreatedEvent({
      taskId: "task-a-1",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      priority: 800,
      globalSequence: 1,
      occurredAt: "2026-06-22T05:00:00.000Z"
    }),
    makePortfolioTaskCreatedEvent({
      taskId: "task-a-2",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      priority: 300,
      globalSequence: 2,
      occurredAt: "2026-06-22T05:00:01.000Z"
    }),
    makePortfolioTaskTransitionedEvent({
      taskId: "task-a-1",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      toStatus: "running",
      fromStatus: "queued",
      globalSequence: 3,
      occurredAt: "2026-06-22T05:01:00.000Z"
    }),
    makePortfolioTaskLinkedEvent({
      taskId: "task-a-1",
      projectId: FIXTURE_PROJECT_A,
      changeId: FIXTURE_CHANGE_A1,
      dependsOnTaskId: "task-b-1",
      toProjectId: FIXTURE_PROJECT_B,
      relation: "depends_on",
      globalSequence: 4,
      occurredAt: "2026-06-22T05:02:00.000Z"
    }),
    makePortfolioChangeAggregatedEvent({
      changeId: FIXTURE_CHANGE_A1,
      projectId: FIXTURE_PROJECT_A,
      status: "accepted",
      globalSequence: 5,
      occurredAt: "2026-06-22T05:10:00.000Z"
    }),
    makePortfolioReleasePromotedEvent({
      changeId: FIXTURE_CHANGE_A1,
      projectId: FIXTURE_PROJECT_A,
      globalSequence: 6,
      occurredAt: "2026-06-22T05:30:00.000Z"
    }),

    // Project B: one task (the dependency target) + a
    // back-link to project A.
    makePortfolioTaskCreatedEvent({
      taskId: "task-b-1",
      projectId: FIXTURE_PROJECT_B,
      changeId: FIXTURE_CHANGE_B1,
      priority: 100,
      globalSequence: 7,
      occurredAt: "2026-06-22T05:00:02.000Z"
    }),
    makePortfolioTaskLinkedEvent({
      taskId: "task-b-1",
      projectId: FIXTURE_PROJECT_B,
      changeId: FIXTURE_CHANGE_B1,
      dependsOnTaskId: "task-a-2",
      toProjectId: FIXTURE_PROJECT_A,
      relation: "blocks",
      globalSequence: 8,
      occurredAt: "2026-06-22T05:03:00.000Z"
    })
  ];
}
