// P11-T02 — Portfolio snapshot generator.
//
// Builds a frozen snapshot of the portfolio projection
// state for the canonical P11-T02 evidence bundle. Reads
// the project-level fixture from the board package's test
// directory and replays it through the public replay
// helper, then writes the resulting state plus its
// content-addressed hash to
// docs/next/evidence/P11-T02/portfolio-snapshot.json.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const board = require("../packages/board/dist/index.js");
const {
  replayPortfolio,
  derivePortfolioProjectionStateHash,
  asTenantId
} = board;

const FIXTURE_PROJECT_A = "prj_portfolio_a";
const FIXTURE_PROJECT_B = "prj_portfolio_b";
const FIXTURE_PROJECT_C = "prj_portfolio_c";
const FIXTURE_CHANGE_A1 = "chg_portfolio_a1";
const FIXTURE_CHANGE_B1 = "chg_portfolio_b1";
const FIXTURE_TENANT_ID = "tnt-portfolio-snapshot-001";
const FIXTURE_MERGE_QUEUE_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const FIXTURE_DECISION_SHA256 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const FIXTURE_AGGREGATOR_HASH = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const FIXTURE_REPORT_SHA256 = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

function taskCreated({
  taskId,
  projectId,
  changeId,
  priority,
  fromStatus = "queued",
  globalSequence,
  occurredAt
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-snap-${globalSequence}-task.created`,
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    aggregateSequence: 1,
    globalSequence,
    eventType: "task.created",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "0.1.0",
      projectId,
      changeId,
      taskId,
      contractId: `ctr-${taskId}`,
      contractRevision: 1,
      contractHash: "sha256:" + Buffer.from(`contract-${taskId}`).toString("hex").padEnd(64, "0").slice(0, 64),
      fromStatus,
      priority
    },
    payloadHash: "sha256:" + "a".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `snap:${taskId}:${globalSequence}:task.created`
  };
}

function taskTransitioned({
  taskId,
  projectId,
  changeId,
  toStatus,
  fromStatus,
  globalSequence,
  occurredAt
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-snap-${globalSequence}-task.transitioned`,
    aggregateKind: "task",
    aggregateId: `${projectId}:${changeId}:${taskId}`,
    aggregateSequence: 2,
    globalSequence,
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
    payloadHash: "sha256:" + "b".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `snap:${taskId}:${globalSequence}:task.transitioned`
  };
}

function taskLinked({
  taskId,
  projectId,
  changeId,
  dependsOnTaskId,
  toProjectId,
  relation,
  globalSequence,
  occurredAt
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-snap-${globalSequence}-task.linked`,
    aggregateKind: "task_link",
    aggregateId: `${projectId}:${changeId}:${taskId}:${dependsOnTaskId}`,
    aggregateSequence: 1,
    globalSequence,
    eventType: "task.linked",
    eventVersion: "0.1.0",
    payload: {
      schemaVersion: "0.1.0",
      projectId,
      changeId,
      taskId,
      contractId: `ctr-${taskId}`,
      contractRevision: 1,
      contractHash: "sha256:" + "c".repeat(64),
      dependsOnTaskId,
      toProjectId,
      relation
    },
    payloadHash: "sha256:" + "d".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `snap:${taskId}:${globalSequence}:task.linked`
  };
}

function changeAggregated({
  changeId,
  projectId,
  mergeQueueHash,
  decisionSha256,
  aggregatorHash,
  status,
  globalSequence,
  occurredAt
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-snap-${globalSequence}-change.aggregated`,
    aggregateKind: "whole_change",
    aggregateId: `${changeId}:${mergeQueueHash}`,
    aggregateSequence: 1,
    globalSequence,
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
      outcome: "integrated",
      reason: "snapshot accepted",
      acceptedEntries: [1, 2, 3],
      rejectedEntries: [],
      escalatedEntries: [],
      conflictEntries: [],
      finalHeadRef: "abc123",
      acceptedAt: occurredAt,
      acceptedBy: "ci-bot",
      workerContextHashes: []
    },
    payloadHash: "sha256:" + "e".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `snap:${changeId}:${mergeQueueHash}:change.aggregated:${globalSequence}`
  };
}

function releasePromoted({
  changeId,
  projectId,
  mergeQueueHash,
  reportSha256,
  globalSequence,
  occurredAt
}) {
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-snap-${globalSequence}-release.promoted`,
    aggregateKind: "release_observation",
    aggregateId: `${changeId}:${mergeQueueHash}:${reportSha256}`,
    aggregateSequence: 1,
    globalSequence,
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
      reason: "snapshot promoted",
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
    payloadHash: "sha256:" + "f".repeat(64),
    causationId: null,
    correlationId: null,
    occurredAt,
    idempotencyKey: `snap:${changeId}:${mergeQueueHash}:${reportSha256}:release.promoted:${globalSequence}`
  };
}

const events = [
  // Project A: 2 tasks, 1 transition, 1 cross-project link, change accepted, release promoted
  taskCreated({ taskId: "task-snap-a-1", projectId: FIXTURE_PROJECT_A, changeId: FIXTURE_CHANGE_A1, priority: 800, globalSequence: 1, occurredAt: "2026-06-22T05:00:00.000Z" }),
  taskCreated({ taskId: "task-snap-a-2", projectId: FIXTURE_PROJECT_A, changeId: FIXTURE_CHANGE_A1, priority: 300, globalSequence: 2, occurredAt: "2026-06-22T05:00:01.000Z" }),
  taskTransitioned({ taskId: "task-snap-a-1", projectId: FIXTURE_PROJECT_A, changeId: FIXTURE_CHANGE_A1, toStatus: "running", fromStatus: "queued", globalSequence: 3, occurredAt: "2026-06-22T05:01:00.000Z" }),
  taskLinked({ taskId: "task-snap-a-1", projectId: FIXTURE_PROJECT_A, changeId: FIXTURE_CHANGE_A1, dependsOnTaskId: "task-snap-b-1", toProjectId: FIXTURE_PROJECT_B, relation: "depends_on", globalSequence: 4, occurredAt: "2026-06-22T05:02:00.000Z" }),
  changeAggregated({ changeId: FIXTURE_CHANGE_A1, projectId: FIXTURE_PROJECT_A, mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH, decisionSha256: FIXTURE_DECISION_SHA256, aggregatorHash: FIXTURE_AGGREGATOR_HASH, status: "accepted", globalSequence: 5, occurredAt: "2026-06-22T05:10:00.000Z" }),
  releasePromoted({ changeId: FIXTURE_CHANGE_A1, projectId: FIXTURE_PROJECT_A, mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH, reportSha256: FIXTURE_REPORT_SHA256, globalSequence: 6, occurredAt: "2026-06-22T05:30:00.000Z" }),
  // Project B: 1 task + back-link
  taskCreated({ taskId: "task-snap-b-1", projectId: FIXTURE_PROJECT_B, changeId: FIXTURE_CHANGE_B1, priority: 100, globalSequence: 7, occurredAt: "2026-06-22T05:00:02.000Z" }),
  taskLinked({ taskId: "task-snap-b-1", projectId: FIXTURE_PROJECT_B, changeId: FIXTURE_CHANGE_B1, dependsOnTaskId: "task-snap-a-2", toProjectId: FIXTURE_PROJECT_A, relation: "blocks", globalSequence: 8, occurredAt: "2026-06-22T05:03:00.000Z" })
];

const state = replayPortfolio(events, {
  tenantId: asTenantId(FIXTURE_TENANT_ID)
});
const snapshot = {
  schemaVersion: state.schemaVersion,
  kind: state.kind,
  tenantId: state.tenantId,
  scope: state.scope,
  rebuiltThroughGlobalSequence: state.rebuiltThroughGlobalSequence,
  eventCount: state.eventCount,
  projectRollups: state.projectRollups,
  dependencyEdges: state.dependencyEdges,
  resourceLedger: state.resourceLedger,
  crossProjectDependencyCount: state.crossProjectDependencyCount,
  terminalProjectCount: state.terminalProjectCount,
  stateHash: derivePortfolioProjectionStateHash(state)
};

writeFileSync(
  "docs/next/evidence/P11-T02/portfolio-snapshot.json",
  JSON.stringify(snapshot, null, 2) + "\n"
);
console.log("snapshot written; stateHash=" + snapshot.stateHash);
