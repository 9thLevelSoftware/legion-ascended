/**
 * P10-T01 — Release observation board adapter fixture.
 *
 * Mirrors the P09-T02 whole-change fixture style: minimal,
 * deterministic builders for orchestrator results, board
 * events, and the new release-observation report shape.
 */

import { createHash } from "node:crypto";

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload) {
  return `sha256:${sha256Hex(payload)}`;
}

const FIXTURE_MERGE_QUEUE_HASH = sha256ContentHash(
  "release-observation-board-fixture-merge-queue"
);
const FIXTURE_DECISION_SHA256 = sha256ContentHash(
  "release-observation-board-fixture-decision"
);
const FIXTURE_REPORT_SHA256 = sha256ContentHash(
  "release-observation-board-fixture-report"
);
const FIXTURE_CHANGE_ID = "chg-release-observation-board-001";

export const RELEASE_OBSERVATION_BOARD_FIXTURE_CONSTANTS = {
  changeId: FIXTURE_CHANGE_ID,
  mergeQueueHash: FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256: FIXTURE_DECISION_SHA256,
  reportSha256: FIXTURE_REPORT_SHA256
};

/**
 * Build a minimal `ReleaseObservationReport` shape suitable
 * for the board aggregator tests. The fixture is the
 * *frozen* report the orchestrator would emit.
 */
export function makeReleaseObservationReport({
  status = "promoted",
  changeId = FIXTURE_CHANGE_ID,
  mergeQueueHash = FIXTURE_MERGE_QUEUE_HASH,
  decisionSha256 = FIXTURE_DECISION_SHA256,
  reportSha256 = FIXTURE_REPORT_SHA256,
  releaseability = "releaseable",
  tier = "R0"
} = {}) {
  const report = {
    schemaVersion: "1.0.0",
    kind: "release-observation",
    changeId,
    mergeQueueHash,
    decisionSha256,
    tier,
    releaseability,
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
  return report;
}

export function makeBoardEventForReport(report, { eventType = null } = {}) {
  // The aggregator's payload shape is the *observed* payload
  // surface — the report rides as a nested object so the
  // board adapter's reducer can rebuild the full report
  // from the event log.
  const resolvedEventType =
    eventType ??
    (() => {
      switch (report.status) {
        case "observing":
          return "release.observing";
        case "promoted":
          return "release.promoted";
        case "regressed":
          return "release.regressed";
        case "rolled_back":
          return "release.rolled_back";
      }
    })();
  const payload = {
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
    report: report,
    reportSha256: report.reportSha256,
    failureReason: report.failureReason
  };
  return {
    schemaVersion: "0.1.0",
    eventId: `evt-ro-${report.reportSha256.slice(7, 19)}`,
    aggregateKind: "release_observation",
    aggregateId: `${report.changeId}:${report.mergeQueueHash}:${report.reportSha256}`,
    aggregateSequence: 1,
    globalSequence: 1,
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

export function sha256OfCanonicalFixture(value) {
  function canonical(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return sha256ContentHash(canonical(value));
}
