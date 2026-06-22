/**
 * P10-T01 — Release observation orchestrator.
 *
 * The orchestrator is the entry point for the four sequential
 * release-observation phases. It validates the input, runs the
 * canary / health-check / regression-detection / alert phases
 * in order, derives the final status with the canonical
 * non-invertible map, and produces the frozen
 * `ReleaseObservationReport` + `ReleaseObservationEventPayload`
 * pair that the board adapter can serialize into `BoardEvent`s.
 *
 * Provider-neutrality (mirroring P09-T01 `MergeQueueOrchestrator`):
 *  - `CanaryProbeRunner`, `HealthCheckRunner`,
 *    `RegressionDetectorRunner`, and `AlertSink` are injected.
 *    The orchestrator never spawns CLI processes, reads
 *    `process.env`, or imports a runtime driver.
 *  - The orchestrator is pure with respect to its inputs.
 *    Side-effects happen only inside the injected runners.
 *  - Outputs are deeply frozen and content-addressed.
 */

import type {
  Actor,
  ContentHash,
  UtcTimestamp
} from "@legion/protocol";

import type {
  MergeIntegrationDecision,
  MergeQueueOrchestratorResult
} from "../merge/contract.js";

import { deepFreeze } from "../merge/orchestrator.js";

import type {
  AlertPhaseInput,
  AlertPhaseResult,
  AlertRecord,
  AlertSink,
  CanaryPhaseInput,
  CanaryPhaseResult,
  HealthCheckPhaseInput,
  HealthCheckPhaseResult,
  HealthCheckRunner,
  HealthCheckStatus,
  ProbeOutcome,
  ReleaseObservationEventPayload,
  ReleaseObservationFailure,
  ReleaseObservationInput,
  ReleaseObservationIssue,
  ReleaseObservationObservedPayload,
  ReleaseObservationReport,
  ReleaseObservationResult,
  ReleaseObservationStatus,
  ReleaseabilityState,
  RegressionPhaseInput,
  RegressionPhaseResult,
  RegressionSignal
} from "./contract.js";

import {
  mapIntegrationOutcomeToReleaseability,
  RELEASE_OBSERVATION_KIND,
  RELEASE_OBSERVATION_SCHEMA_VERSION
} from "./contract.js";

import {
  deriveAlertPhaseSha256,
  deriveCanaryPhaseSha256,
  deriveHealthCheckPhaseSha256,
  deriveRegressionPhaseSha256,
  deriveReleaseObservationReportSha256
} from "./hash.js";

// ---------------------------------------------------------------------------
// Default clock
// ---------------------------------------------------------------------------

const defaultClock = (): UtcTimestamp =>
  "2026-06-22T05:00:00.000Z" as UtcTimestamp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyProbeOutcome(
  invocations: readonly import("./contract.js").CanaryProbeInvocation[]
): ProbeOutcome {
  if (invocations.length === 0) return "skipped";
  if (invocations.some((i) => i.outcome === "failed")) return "failed";
  if (invocations.some((i) => i.outcome === "timed_out")) return "timed_out";
  if (invocations.every((i) => i.outcome === "skipped")) return "skipped";
  return "passed";
}

function classifyHealthOutcome(
  invocations: readonly import("./contract.js").HealthCheckInvocation[]
): HealthCheckStatus {
  if (invocations.length === 0) return "skipped";
  if (invocations.some((i) => i.observedStatus === "unhealthy"))
    return "unhealthy";
  if (invocations.some((i) => i.observedStatus === "degraded"))
    return "degraded";
  if (invocations.every((i) => i.observedStatus === "skipped")) return "skipped";
  return "healthy";
}

function classifyRegressionOutcome(
  signals: readonly RegressionSignal[]
): import("./contract.js").RegressionOutcome {
  if (signals.length === 0) return "skipped";
  if (signals.some((s) => s.severity === "critical"))
    return "regression_detected";
  return "no_regression";
}

// ---------------------------------------------------------------------------
// Phase runners
// ---------------------------------------------------------------------------

async function runCanaryPhase(
  input: CanaryPhaseInput,
  startedAt: UtcTimestamp
): Promise<CanaryPhaseResult> {
  const invocations = input.invocations;
  if (invocations.length === 0) {
    const result: Omit<CanaryPhaseResult, "phaseSha256"> = {
      phase: "canary",
      invocations: [],
      failedProbeIds: [],
      skippedProbeIds: [],
      timedOutProbeIds: [],
      outcome: "skipped",
      startedAt,
      finishedAt: startedAt
    };
    return { ...result, phaseSha256: deriveCanaryPhaseSha256(result) };
  }
  // If every invocation is already resolved (the caller
  // supplied finished outcomes), accept them as-is. The
  // runner is still wired so the orchestrator can override
  // the outcomes when present.
  const allResolved = invocations.every(
    (i) => typeof i.outcome === "string" && i.outcome.length > 0
  );
  let results: import("./contract.js").CanaryProbeInvocation[];
  if (input.runner) {
    results = [];
    for (const invocation of invocations) {
      const ran = await input.runner(invocation);
      results.push(deepFreeze(ran));
    }
  } else if (allResolved) {
    results = invocations.map((i) => deepFreeze(i));
  } else {
    throw new ReleaseObservationOrchestratorError(
      "canary_runner_unavailable",
      "Canary phase requires an injected runner when invocations are present.",
      ["canary"]
    );
  }
  const failed = results.filter((i) => i.outcome === "failed").map((i) => i.probeId);
  const skipped = results
    .filter((i) => i.outcome === "skipped")
    .map((i) => i.probeId);
  const timedOut = results
    .filter((i) => i.outcome === "timed_out")
    .map((i) => i.probeId);
  const finishedAt = results.reduce<UtcTimestamp>(
    (acc, cur) => (String(cur.finishedAt) > String(acc) ? cur.finishedAt : acc),
    startedAt
  );
  const result: Omit<CanaryPhaseResult, "phaseSha256"> = {
    phase: "canary",
    invocations: results,
    failedProbeIds: failed,
    skippedProbeIds: skipped,
    timedOutProbeIds: timedOut,
    outcome: classifyProbeOutcome(results),
    startedAt,
    finishedAt
  };
  return { ...result, phaseSha256: deriveCanaryPhaseSha256(result) };
}

async function runHealthCheckPhase(
  input: HealthCheckPhaseInput,
  startedAt: UtcTimestamp
): Promise<HealthCheckPhaseResult> {
  const invocations = input.invocations;
  if (invocations.length === 0) {
    const result: Omit<HealthCheckPhaseResult, "phaseSha256"> = {
      phase: "health_check",
      invocations: [],
      unhealthyCheckIds: [],
      degradedCheckIds: [],
      skippedCheckIds: [],
      outcome: "skipped",
      startedAt,
      finishedAt: startedAt
    };
    return { ...result, phaseSha256: deriveHealthCheckPhaseSha256(result) };
  }
  const allResolved = invocations.every(
    (i) => typeof i.observedStatus === "string" && i.observedStatus.length > 0
  );
  let results: import("./contract.js").HealthCheckInvocation[];
  if (input.runner) {
    results = [];
    for (const invocation of invocations) {
      const ran = await input.runner(invocation);
      results.push(deepFreeze(ran));
    }
  } else if (allResolved) {
    results = invocations.map((i) => deepFreeze(i));
  } else {
    throw new ReleaseObservationOrchestratorError(
      "health_check_runner_unavailable",
      "Health check phase requires an injected runner when invocations are present.",
      ["health_check"]
    );
  }
  const unhealthy = results
    .filter((i) => i.observedStatus === "unhealthy")
    .map((i) => i.checkId);
  const degraded = results
    .filter((i) => i.observedStatus === "degraded")
    .map((i) => i.checkId);
  const skipped = results
    .filter((i) => i.observedStatus === "skipped")
    .map((i) => i.checkId);
  const finishedAt = results.reduce<UtcTimestamp>(
    (acc, cur) => (String(cur.finishedAt) > String(acc) ? cur.finishedAt : acc),
    startedAt
  );
  const result: Omit<HealthCheckPhaseResult, "phaseSha256"> = {
    phase: "health_check",
    invocations: results,
    unhealthyCheckIds: unhealthy,
    degradedCheckIds: degraded,
    skippedCheckIds: skipped,
    outcome: classifyHealthOutcome(results),
    startedAt,
    finishedAt
  };
  return { ...result, phaseSha256: deriveHealthCheckPhaseSha256(result) };
}

async function runRegressionPhase(
  input: RegressionPhaseInput,
  startedAt: UtcTimestamp
): Promise<RegressionPhaseResult> {
  let signals = input.signals;
  if (input.runner) {
    const ran = await input.runner(input);
    signals = ran;
  }
  if (!input.baseline && signals.length === 0) {
    const result: Omit<RegressionPhaseResult, "phaseSha256"> = {
      phase: "regression_detection",
      baseline: null,
      signals: [],
      criticalSignalIds: [],
      warningSignalIds: [],
      outcome: "skipped",
      startedAt,
      finishedAt: startedAt
    };
    return { ...result, phaseSha256: deriveRegressionPhaseSha256(result) };
  }
  if (!input.baseline && signals.length > 0) {
    throw new ReleaseObservationOrchestratorError(
      "baseline_observation_missing",
      "Regression signals cannot be evaluated without a baseline observation reference.",
      ["regression_detection"]
    );
  }
  const frozen = deepFreeze(signals);
  const critical = frozen
    .filter((s) => s.severity === "critical")
    .map((s) => s.signalId);
  const warning = frozen
    .filter((s) => s.severity === "warn")
    .map((s) => s.signalId);
  const finishedAt = startedAt;
  const result: Omit<RegressionPhaseResult, "phaseSha256"> = {
    phase: "regression_detection",
    baseline: input.baseline,
    signals: frozen,
    criticalSignalIds: critical,
    warningSignalIds: warning,
    outcome: classifyRegressionOutcome(frozen),
    startedAt,
    finishedAt
  };
  return { ...result, phaseSha256: deriveRegressionPhaseSha256(result) };
}

async function runAlertPhase(
  input: AlertPhaseInput,
  startedAt: UtcTimestamp
): Promise<AlertPhaseResult> {
  if (input.candidateAlerts.length === 0) {
    const result: Omit<AlertPhaseResult, "phaseSha256"> = {
      phase: "alert",
      alerts: [],
      criticalAlertIds: [],
      firedAlertIds: [],
      suppressedAlertIds: [],
      startedAt,
      finishedAt: startedAt
    };
    return { ...result, phaseSha256: deriveAlertPhaseSha256(result) };
  }
  const firedAt = startedAt;
  // If no sink is provided, default every candidate to a
  // "fired" decision with the phase start time. Production
  // paths should always supply a sink; this default keeps
  // the orchestrator usable for fixtures and tests.
  const sink = input.sink ?? ((alert: AlertRecord) => alert);
  const alerts: AlertRecord[] = [];
  for (const candidate of input.candidateAlerts) {
    const candidateRecord: AlertRecord = {
      ...candidate,
      firedAt,
      decision: "fired"
    };
    alerts.push(deepFreeze(await sink(candidateRecord)));
  }
  const critical = alerts
    .filter((a) => a.severity === "critical" && a.decision === "fired")
    .map((a) => a.alertId);
  const fired = alerts
    .filter((a) => a.decision === "fired")
    .map((a) => a.alertId);
  const suppressed = alerts
    .filter((a) => a.decision === "suppressed" || a.decision === "deduplicated")
    .map((a) => a.alertId);
  const result: Omit<AlertPhaseResult, "phaseSha256"> = {
    phase: "alert",
    alerts,
    criticalAlertIds: critical,
    firedAlertIds: fired,
    suppressedAlertIds: suppressed,
    startedAt,
    finishedAt: firedAt
  };
  return { ...result, phaseSha256: deriveAlertPhaseSha256(result) };
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

function resolveStatus(
  canary: CanaryPhaseResult | null,
  healthCheck: HealthCheckPhaseResult | null,
  regression: RegressionPhaseResult | null,
  alert: AlertPhaseResult | null
): { readonly status: ReleaseObservationStatus; readonly reason: string | null } {
  // A critical alert forces rolled_back.
  if (alert && alert.criticalAlertIds.length > 0) {
    return {
      status: "rolled_back",
      reason: `critical alert(s) fired: ${alert.criticalAlertIds.join(", ")}`
    };
  }
  // Regression detected (any critical signal) → regressed.
  if (regression && regression.outcome === "regression_detected") {
    return {
      status: "regressed",
      reason: `regression detected: ${regression.criticalSignalIds.join(", ")}`
    };
  }
  // Canary failed or timed out → regressed.
  if (canary && (canary.outcome === "failed" || canary.outcome === "timed_out")) {
    return {
      status: "regressed",
      reason: `canary ${canary.outcome}: ${[
        ...canary.failedProbeIds,
        ...canary.timedOutProbeIds
      ].join(", ")}`
    };
  }
  // Health unhealthy → regressed.
  if (healthCheck && healthCheck.outcome === "unhealthy") {
    return {
      status: "regressed",
      reason: `health unhealthy: ${healthCheck.unhealthyCheckIds.join(", ")}`
    };
  }
  const skippedRequiredPhases = [
    canary?.outcome === "skipped" ? "canary" : null,
    healthCheck?.outcome === "skipped" ? "health_check" : null,
    regression?.outcome === "skipped" ? "regression_detection" : null
  ].filter((phase): phase is string => phase !== null);
  if (skippedRequiredPhases.length > 0) {
    return {
      status: "observing",
      reason: `required observation skipped: ${skippedRequiredPhases.join(", ")}`
    };
  }
  // A regressing or unhealthy observation: any of the four
  // phases with a "bad" outcome forces the cycle to stay in
  // `observing` until the board adapter decides to surface a
  // `release.observed` event.
  if (
    canary?.outcome === "failed" ||
    canary?.outcome === "timed_out" ||
    healthCheck?.outcome === "unhealthy" ||
    healthCheck?.outcome === "degraded" ||
    regression?.outcome === "regression_detected"
  ) {
    return { status: "observing", reason: null };
  }
  // A cycle with no phases at all stays in `observing`.
  if (
    canary === null &&
    healthCheck === null &&
    regression === null &&
    alert === null
  ) {
    return { status: "observing", reason: null };
  }
  // All supplied phases are "good" (passed / healthy /
  // no_regression / empty alerts) — promote.
  return { status: "promoted", reason: null };
}

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class ReleaseObservationOrchestratorError extends Error {
  readonly code: import("./contract.js").ReleaseObservationIssueCode;
  readonly path: readonly (string | number)[];

  constructor(
    code: import("./contract.js").ReleaseObservationIssueCode,
    message: string,
    path: readonly (string | number)[]
  ) {
    super(message);
    this.name = "ReleaseObservationOrchestratorError";
    this.code = code;
    this.path = path;
  }
}

export interface ReleaseObservationOrchestratorOptions {
  readonly now?: () => UtcTimestamp;
}

export class ReleaseObservationOrchestrator {
  readonly #now: () => UtcTimestamp;

  constructor(options: ReleaseObservationOrchestratorOptions = {}) {
    this.#now = options.now ?? defaultClock;
  }

  async run(
    input: ReleaseObservationInput
  ): Promise<ReleaseObservationResult> {
    const issues: ReleaseObservationIssue[] = [];
    const now = input.now ?? this.#now;

    const orchestratorResult = input.orchestratorResult;
    if (!orchestratorResult.ok) {
      issues.push({
        code: "decision_missing",
        message: "Orchestrator result is a failure shape; cannot observe a non-releaseable merge queue run.",
        path: ["orchestratorResult"]
      });
      return failureResult(
        null,
        issues
      );
    }

    const snapshot = orchestratorResult.snapshot;
    const decision = orchestratorResult.decision;
    if (!decision) {
      issues.push({
        code: "decision_missing",
        message: "Merge integration decision missing from orchestrator result.",
        path: ["orchestratorResult", "decision"]
      });
    }
    if (!snapshot) {
      issues.push({
        code: "snapshot_missing",
        message: "Merge queue snapshot missing from orchestrator result.",
        path: ["orchestratorResult", "snapshot"]
      });
    }
    if (issues.length > 0) {
      return failureResult(
        decision?.mergeQueueHash ?? null,
        issues
      );
    }

    if (!input.changeId) {
      issues.push({
        code: "decision_missing",
        message: "Release observation requires a changeId; pass it via input.changeId.",
        path: ["changeId"]
      });
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }

    // Phase 1: validate window
    if (String(input.windowEnd) <= String(input.windowStart)) {
      issues.push({
        code: "window_invalid",
        message: "Release observation window is invalid: windowEnd must be after windowStart.",
        path: ["windowStart", "windowEnd"]
      });
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }
    if (String(input.observedAt) > String(input.windowEnd)) {
      issues.push({
        code: "window_expired",
        message: "Release observation window has already expired; observedAt must be inside [windowStart, windowEnd].",
        path: ["observedAt"]
      });
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }
    if (String(input.observedAt) < String(input.windowStart)) {
      issues.push({
        code: "window_invalid",
        message: "Release observation observedAt must be inside [windowStart, windowEnd].",
        path: ["observedAt"]
      });
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }

    const releaseability: ReleaseabilityState = mapIntegrationOutcomeToReleaseability(
      (decision as MergeIntegrationDecision).outcome
    );
    if (releaseability !== "releaseable") {
      issues.push({
        code: "merge_integration_not_accepted",
        message: `Merge integration outcome is "${(decision as MergeIntegrationDecision).outcome}" which is not releaseable.`,
        path: ["orchestratorResult", "decision", "outcome"]
      });
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }

    // Phase 2: run canary / health / regression / alert in order
    const phaseStartedAt = now();
    let canaryResult: CanaryPhaseResult | null = null;
    let healthResult: HealthCheckPhaseResult | null = null;
    let regressionResult: RegressionPhaseResult | null = null;
    let alertResult: AlertPhaseResult | null = null;
    let failureReason: string | null = null;
    try {
      if (input.canary) {
        canaryResult = await runCanaryPhase(input.canary, phaseStartedAt);
      }
      if (input.healthCheck) {
        healthResult = await runHealthCheckPhase(
          input.healthCheck,
          phaseStartedAt
        );
      }
      if (input.regression) {
        regressionResult = await runRegressionPhase(
          input.regression,
          phaseStartedAt
        );
      }
      if (input.alert) {
        alertResult = await runAlertPhase(input.alert, phaseStartedAt);
      }
    } catch (err) {
      const issue: ReleaseObservationIssue =
        err instanceof ReleaseObservationOrchestratorError
          ? {
              code: err.code,
              message: err.message,
              path: err.path
            }
          : {
              code: "phase_failed",
              message:
                err instanceof Error
                  ? `Phase failed: ${err.message}`
                  : "Phase failed: unknown error",
              path: ["phase"]
            };
      failureReason = issue.message;
      issues.push(issue);
    }

    if (issues.length > 0) {
      return failureResult(
        (decision as MergeIntegrationDecision).mergeQueueHash,
        issues
      );
    }

    // Phase 3: resolve status
    const { status, reason } = resolveStatus(
      canaryResult,
      healthResult,
      regressionResult,
      alertResult
    );
    if (reason !== null) {
      failureReason = reason;
    }

    // Phase 4: build report + payload
    const reportDraft: Omit<ReleaseObservationReport, "reportSha256"> = {
      schemaVersion: RELEASE_OBSERVATION_SCHEMA_VERSION,
      kind: RELEASE_OBSERVATION_KIND,
      changeId: input.changeId,
      mergeQueueHash: (decision as MergeIntegrationDecision).mergeQueueHash,
      decisionSha256: (decision as MergeIntegrationDecision).decisionSha256,
      tier: input.tier,
      releaseability,
      status,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      observedAt: input.observedAt,
      observedBy: input.observer,
      canary: canaryResult,
      healthCheck: healthResult,
      regression: regressionResult,
      alert: alertResult,
      failureReason
    };
    const reportSha256 = deriveReleaseObservationReportSha256(reportDraft);
    const report: ReleaseObservationReport = deepFreeze({
      ...reportDraft,
      reportSha256
    });

    const payload: ReleaseObservationObservedPayload = {
      schemaVersion: RELEASE_OBSERVATION_SCHEMA_VERSION,
      kind: RELEASE_OBSERVATION_KIND,
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
    const eventPayloads: readonly ReleaseObservationEventPayload[] =
      deepFreeze([payload]);

    return deepFreeze({
      ok: true,
      schemaVersion: RELEASE_OBSERVATION_SCHEMA_VERSION,
      kind: RELEASE_OBSERVATION_KIND,
      changeId: report.changeId,
      mergeQueueHash: report.mergeQueueHash,
      report,
      eventPayloads,
      reportSha256
    });
  }
}

function failureResult(
  mergeQueueHash: ContentHash | null,
  issues: readonly ReleaseObservationIssue[]
): ReleaseObservationFailure {
  return {
    ok: false,
    schemaVersion: RELEASE_OBSERVATION_SCHEMA_VERSION,
    kind: RELEASE_OBSERVATION_KIND,
    changeId: null,
    issues,
    attemptedMergeQueueHash: mergeQueueHash
  };
}

// ---------------------------------------------------------------------------
// ChangeId helpers
// ---------------------------------------------------------------------------

/**
 * In production the changeId is supplied via `input.changeId`
 * (which the board adapter pins from the originating
 * `WholeChangeAcceptanceState`). This module does not invent a
 * changeId from the merge queue hash; it surfaces an issue if
 * the call site did not pass one.
 */

// ---------------------------------------------------------------------------
// Public free function
// ---------------------------------------------------------------------------

export async function buildReleaseObservation(
  input: ReleaseObservationInput,
  options: ReleaseObservationOrchestratorOptions = {}
): Promise<ReleaseObservationResult> {
  const orchestrator = new ReleaseObservationOrchestrator(options);
  return orchestrator.run(input);
}
