/**
 * P10-T01 — Release observation store-sqlite fixture.
 *
 * Mirrors the P09-T02 whole-change-projector fixture: minimal
 * helpers for opening a fresh SQLite database, appending
 * release-observation events, and rebuilding the projection.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openSqliteBoardEventRepository,
  openSqliteBoardProjectionRepository,
  openSqliteBoardStore
} from "../dist/index.js";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "release-observation-store-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "release-observation-store-fixture-decision"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "release-observation-store-fixture-report"
);
const FIXTURE_CHANGE_ID = "chg-release-observation-store-001";

export const RELEASE_OBSERVATION_STORE_FIXTURE_CONSTANTS = {
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  reportSha256: FIXTURE_REPORT_SHA256
};

export function makeFixtureReport({
  status = "promoted",
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  reportSha256 = FIXTURE_REPORT_SHA256
} = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    changeId,
    mergeQueueHash,
    decisionSha256,
    tier: "R0",
    releaseability: "releaseable",
    status,
    windowStart: "2026-06-22T05:00:00.000Z",
    windowEnd: "2026-06-22T05:30:00.000Z",
    observedAt: "2026-06-22T05:15:00.000Z",
    observedBy: {
      id: "ci-bot",
      type: "ci-bot",
      displayName: "ci-bot"
    },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    reportSha256,
    failureReason: null
  };
}

export function buildFixturePayload(report) {
  return {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    changeId: report.changeId,
    mergeQueueHash: report.mergeQueueHash,
    decisionSha256: report.decisionSha256,
    tier: report.tier,
    releaseability: report.releaseability,
    status: report.status,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    observedAt: report.observedAt,
    observedBy: report.observedBy,
    canary: report.canary,
    healthCheck: report.healthCheck,
    regression: report.regression,
    alert: report.alert,
    report,
    reportSha256: report.reportSha256,
    failureReason: report.failureReason
  };
}

export function makeFixtureBoardEvent(report, { eventType, globalSequence = 1 }) {
  const payload = buildFixturePayload(report);
  const resolvedEventType = eventType ?? statusToEventType(report.status);
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-store-${globalSequence}`,
    aggregateKind: "release_observation",
    aggregateId: `${report.changeId}:${report.mergeQueueHash}:${report.reportSha256}`,
    aggregateSequence: 1,
    globalSequence,
    eventType: resolvedEventType,
    eventVersion: "0.1.0",
    payload,
    payloadHash: sha256ContentHash(JSON.stringify(payload)),
    causationId: null,
    correlationId: "fixture-correlation",
    occurredAt: "2026-06-22T05:30:00.000Z",
    idempotencyKey: `${report.changeId}:${report.mergeQueueHash}:${report.reportSha256}:${resolvedEventType}`,
    payloadJson: JSON.stringify(payload)
  };
}

function statusToEventType(status) {
  switch (status) {
    case "observing":
      return "release.observing";
    case "promoted":
      return "release.promoted";
    case "regressed":
      return "release.regressed";
    case "rolled_back":
      return "release.rolled_back";
  }
}

export async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p10-t01-proj-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export function buildRepositories(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const database = new DatabaseSync(databasePath);
  const eventRepository = openSqliteBoardEventRepository({ database });
  const projectionRepository = openSqliteBoardProjectionRepository({ database });
  return { store, database, eventRepository, projectionRepository };
}
