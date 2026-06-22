/**
 * P10-T01 — Deterministic hashing for release-observation outputs.
 *
 * Mirrors the P08 / P09 hash contract: SHA-256 over a
 * canonicalized string built from sorted keys, so two
 * release-observation cycles against the same merge queue
 * output, the same probe set, the same regression baseline,
 * and the same alert set produce identical hashes regardless
 * of object key order.
 *
 * Used for:
 *  - `phaseSha256` per observation phase (audit-by-grep)
 *  - `reportSha256` (top-level audit tag, ties report + payload)
 *  - `regressionBaselineReportSha256` for content-addressed
 *    baseline references.
 */

import { createHash } from "node:crypto";

import type { ContentHash, SchemaVersion } from "@legion/protocol";

import type {
  AlertPhaseResult,
  AlertRecord,
  CanaryPhaseResult,
  CanaryProbeInvocation,
  HealthCheckPhaseResult,
  HealthCheckInvocation,
  ReleaseObservationReport,
  RegressionBaselineRef,
  RegressionPhaseResult,
  RegressionSignal
} from "./contract.js";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
      )
      .join(",") +
    "}"
  );
}

function hexSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function contentHash(input: string): ContentHash {
  return `sha256:${hexSha256(input)}` as unknown as ContentHash;
}

// ---------------------------------------------------------------------------
// Public utility — content hash from any frozen value
// ---------------------------------------------------------------------------

export function sha256OfCanonical(value: unknown): ContentHash {
  return contentHash(canonical(value));
}

// ---------------------------------------------------------------------------
// Phase hashing
// ---------------------------------------------------------------------------

function serializeCanaryInvocation(
  invocation: CanaryProbeInvocation
): unknown {
  return {
    probeId: invocation.probeId,
    tier: invocation.tier,
    weight: invocation.weight,
    expectedOutcome: invocation.expectedOutcome,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    outcome: invocation.outcome,
    ...(invocation.observedValue === undefined
      ? {}
      : { observedValue: invocation.observedValue }),
    ...(invocation.threshold === undefined
      ? {}
      : { threshold: invocation.threshold }),
    ...(invocation.notes === undefined ? {} : { notes: invocation.notes })
  };
}

export function deriveCanaryPhaseSha256(
  result: Omit<CanaryPhaseResult, "phaseSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation:canary",
      schemaVersion: RELEASE_OBSERVATION_HASH_VERSION,
      invocations: result.invocations.map(serializeCanaryInvocation),
      failedProbeIds: [...result.failedProbeIds].sort(),
      skippedProbeIds: [...result.skippedProbeIds].sort(),
      timedOutProbeIds: [...result.timedOutProbeIds].sort(),
      outcome: result.outcome,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    })
  );
}

function serializeHealthCheckInvocation(
  invocation: HealthCheckInvocation
): unknown {
  return {
    checkId: invocation.checkId,
    endpoint: invocation.endpoint,
    intervalMs: invocation.intervalMs,
    timeoutMs: invocation.timeoutMs,
    expectedStatus: invocation.expectedStatus,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    observedStatus: invocation.observedStatus,
    ...(invocation.latencyMs === undefined
      ? {}
      : { latencyMs: invocation.latencyMs }),
    ...(invocation.notes === undefined ? {} : { notes: invocation.notes })
  };
}

export function deriveHealthCheckPhaseSha256(
  result: Omit<HealthCheckPhaseResult, "phaseSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation:health-check",
      schemaVersion: RELEASE_OBSERVATION_HASH_VERSION,
      invocations: result.invocations.map(serializeHealthCheckInvocation),
      unhealthyCheckIds: [...result.unhealthyCheckIds].sort(),
      degradedCheckIds: [...result.degradedCheckIds].sort(),
      skippedCheckIds: [...result.skippedCheckIds].sort(),
      outcome: result.outcome,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    })
  );
}

function serializeRegressionSignal(signal: RegressionSignal): unknown {
  return {
    signalId: signal.signalId,
    metric: signal.metric,
    baseline: signal.baseline,
    observed: signal.observed,
    delta: signal.delta,
    severity: signal.severity,
    ...(signal.notes === undefined ? {} : { notes: signal.notes })
  };
}

function serializeBaseline(
  baseline: RegressionBaselineRef | null
): unknown {
  if (baseline === null) return null;
  return {
    changeId: baseline.changeId,
    mergeQueueHash: baseline.mergeQueueHash,
    observedAt: baseline.observedAt,
    reportSha256: baseline.reportSha256
  };
}

export function deriveRegressionPhaseSha256(
  result: Omit<RegressionPhaseResult, "phaseSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation:regression-detection",
      schemaVersion: RELEASE_OBSERVATION_HASH_VERSION,
      baseline: serializeBaseline(result.baseline),
      signals: result.signals.map(serializeRegressionSignal),
      criticalSignalIds: [...result.criticalSignalIds].sort(),
      warningSignalIds: [...result.warningSignalIds].sort(),
      outcome: result.outcome,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    })
  );
}

function serializeAlertRecord(alert: AlertRecord): unknown {
  return {
    alertId: alert.alertId,
    severity: alert.severity,
    title: alert.title,
    summary: alert.summary,
    source: alert.source,
    firedAt: alert.firedAt,
    decision: alert.decision,
    ...(alert.correlationId === undefined
      ? {}
      : { correlationId: alert.correlationId }),
    ...(alert.notes === undefined ? {} : { notes: alert.notes })
  };
}

export function deriveAlertPhaseSha256(
  result: Omit<AlertPhaseResult, "phaseSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation:alert",
      schemaVersion: RELEASE_OBSERVATION_HASH_VERSION,
      alerts: result.alerts.map(serializeAlertRecord),
      criticalAlertIds: [...result.criticalAlertIds].sort(),
      firedAlertIds: [...result.firedAlertIds].sort(),
      suppressedAlertIds: [...result.suppressedAlertIds].sort(),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    })
  );
}

// ---------------------------------------------------------------------------
// Top-level report hash
// ---------------------------------------------------------------------------

export function deriveReleaseObservationReportSha256(
  report: Omit<ReleaseObservationReport, "reportSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation:report",
      schemaVersion: RELEASE_OBSERVATION_HASH_VERSION,
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
      failureReason: report.failureReason
    })
  );
}

// ---------------------------------------------------------------------------
// Versioning — explicitly exported so consumers can audit the
// canonical-string contract without scraping the file
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_HASH_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;
