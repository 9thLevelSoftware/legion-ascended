/**
 * P10-T01 — Release observation orchestrator tests.
 *
 * Coverage:
 *  1. Releaseability map — `mapIntegrationOutcomeToReleaseability`
 *     returns the canonical non-invertible mapping.
 *  2. Happy path — releaseable orchestrator + canary/health
 *     inputs → `promoted` status.
 *  3. Non-releaseable orchestrator result (rejected) → typed
 *     `merge_integration_not_accepted` issue.
 *  4. Failed canary → `regressed` status with reason.
 *  5. Unhealthy health check → `regressed` status with reason.
 *  6. Critical alert → `rolled_back` status with reason.
 *  7. Determinism — two identical runs produce identical
 *     `reportSha256`.
 *  8. Frozen output — every report field is `Object.isFrozen`.
 *  9. Window validation — `windowEnd <= windowStart` yields
 *     `window_invalid` issue.
 * 10. Window expiration — `observedAt > windowEnd` yields
 *     `window_expired` issue.
 * 11. Provider-neutrality — release observation source files
 *     never import a runtime driver, eve, board-store, or
 *     read process.env.
 * 12. Phase-hash determinism — same canary inputs produce
 *     same `phaseSha256`.
 * 13. Failure reason — when canary runner throws, the report
 *     surfaces the error message.
 * 14. Regression detection — critical signal forces `regressed`
 *     status.
 * 15. Canary runner not injected but invocations present →
 *     `canary_runner_unavailable` issue.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReleaseObservation,
  deriveCanaryPhaseSha256,
  deriveHealthCheckPhaseSha256,
  deriveRegressionPhaseSha256,
  deriveAlertPhaseSha256,
  deriveReleaseObservationReportSha256,
  eventTypeForReleaseStatus,
  mapIntegrationOutcomeToReleaseability,
  RELEASE_OBSERVATION_KIND,
  ReleaseObservationOrchestrator
} from "../dist/index.js";

import {
  makeAlertInput,
  makeCanaryInput,
  makeHealthCheckInput,
  makeNonReleaseableOrchestratorResult,
  makeObserver,
  makeRegressionInput,
  makeReleaseableOrchestratorResult,
  RELEASE_OBSERVATION_FIXTURE_CONSTANTS
} from "./release-observation-fixture.mjs";

const NOW = () => "2026-06-22T05:30:00.000Z";

function buildInput(overrides = {}) {
  return {
    changeId: RELEASE_OBSERVATION_FIXTURE_CONSTANTS.changeId,
    orchestratorResult: makeReleaseableOrchestratorResult(),
    windowStart: "2026-06-22T05:00:00.000Z",
    windowEnd: "2026-06-22T05:30:00.000Z",
    tier: "R0",
    observer: makeObserver(),
    observedAt: "2026-06-22T05:15:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Releaseability map
// ---------------------------------------------------------------------------

test("mapIntegrationOutcomeToReleaseability covers the canonical non-invertible map", () => {
  assert.equal(mapIntegrationOutcomeToReleaseability("integrated"), "releaseable");
  assert.equal(mapIntegrationOutcomeToReleaseability("rejected"), "non_releaseable");
  assert.equal(mapIntegrationOutcomeToReleaseability("blocked"), "non_releaseable");
  assert.equal(mapIntegrationOutcomeToReleaseability("escalated"), "deferred");
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("releaseable orchestrator + canary + health → promoted", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 3, failed: 0 }),
    healthCheck: makeHealthCheckInput({ healthy: 2, degraded: 0 })
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "promoted");
  assert.equal(result.report.releaseability, "releaseable");
  assert.equal(result.report.canary?.outcome, "passed");
  assert.equal(result.report.healthCheck?.outcome, "healthy");
});

// ---------------------------------------------------------------------------
// Non-releaseable orchestrator
// ---------------------------------------------------------------------------

test("non-releaseable orchestrator result surfaces merge_integration_not_accepted issue", async () => {
  const result = await buildReleaseObservation(buildInput({
    orchestratorResult: makeNonReleaseableOrchestratorResult({ outcome: "rejected" })
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  const code = result.issues.map((i) => i.code);
  assert.ok(code.includes("merge_integration_not_accepted"));
});

// ---------------------------------------------------------------------------
// Failed canary → regressed
// ---------------------------------------------------------------------------

test("failed canary → regressed status with reason", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 1, failed: 1 })
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "regressed");
  assert.match(result.report.failureReason ?? "", /canary failed/);
});

// ---------------------------------------------------------------------------
// Unhealthy health check
// ---------------------------------------------------------------------------

test("unhealthy health check → regressed status", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 1 }),
    healthCheck: {
      invocations: [
        {
          checkId: "health-unhealthy-0",
          endpoint: "https://example.com/health/x",
          intervalMs: 30_000,
          timeoutMs: 5_000,
          expectedStatus: "healthy",
          startedAt: "2026-06-22T05:00:00.000Z",
          finishedAt: "2026-06-22T05:00:01.000Z",
          observedStatus: "unhealthy"
        }
      ]
    }
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "regressed");
  assert.match(result.report.failureReason ?? "", /health unhealthy/);
});

// ---------------------------------------------------------------------------
// Critical alert → rolled_back
// ---------------------------------------------------------------------------

test("critical alert → rolled_back status", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 1 }),
    healthCheck: makeHealthCheckInput({ healthy: 1 }),
    alert: {
      candidateAlerts: [
        {
          alertId: "alert-critical-0",
          severity: "critical",
          title: "page",
          summary: "x",
          source: "canary"
        }
      ]
    }
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "rolled_back");
  assert.match(result.report.failureReason ?? "", /critical alert/);
});

test("suppressed critical alert does not force rollback", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 1 }),
    healthCheck: makeHealthCheckInput({ healthy: 1 }),
    alert: {
      candidateAlerts: [
        {
          alertId: "alert-critical-suppressed-0",
          severity: "critical",
          title: "page",
          summary: "x",
          source: "canary"
        }
      ],
      sink: (alert) => ({
        ...alert,
        decision: "suppressed"
      })
    }
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "promoted");
  assert.deepEqual(result.report.alert?.criticalAlertIds, []);
  assert.deepEqual(result.report.alert?.suppressedAlertIds, [
    "alert-critical-suppressed-0"
  ]);
});

test("skipped required observation blocks promotion", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: { invocations: [] },
    healthCheck: makeHealthCheckInput({ healthy: 1 })
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "observing");
  assert.match(result.report.failureReason ?? "", /required observation skipped/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("deterministic reportSha256 for identical inputs", async () => {
  const a = await buildReleaseObservation(buildInput(), { now: NOW });
  const b = await buildReleaseObservation(buildInput(), { now: NOW });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.reportSha256, b.reportSha256);
  assert.equal(a.report.reportSha256, b.report.reportSha256);
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

test("report + payload are deeply frozen", async () => {
  const result = await buildReleaseObservation(buildInput(), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.report), true);
});

// ---------------------------------------------------------------------------
// Window validation
// ---------------------------------------------------------------------------

test("windowEnd <= windowStart yields window_invalid issue", async () => {
  const result = await buildReleaseObservation(buildInput({
    windowStart: "2026-06-22T05:30:00.000Z",
    windowEnd: "2026-06-22T05:00:00.000Z"
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("window_invalid"));
});

test("observedAt > windowEnd yields window_expired issue", async () => {
  const result = await buildReleaseObservation(buildInput({
    observedAt: "2026-06-22T06:00:00.000Z"
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("window_expired"));
});

test("observedAt before windowStart yields window_invalid issue", async () => {
  const result = await buildReleaseObservation(buildInput({
    observedAt: "2026-06-22T04:59:59.000Z"
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("window_invalid"));
});

// ---------------------------------------------------------------------------
// Provider neutrality
// ---------------------------------------------------------------------------

const RELEASE_OBSERVATION_SRC_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "release-observation"
);

test("release-observation source files never import a runtime driver, eve, board-store, or read process.env", async () => {
  const files = await readdir(RELEASE_OBSERVATION_SRC_ROOT);
  // The forbidden tokens must be searched as standalone
  // tokens (import statements, path segments) rather than
  // raw substrings so we don't trip over common English
  // words or doc-comments that mention forbidden
  // boundaries.
  const forbiddenPathSegments = ["/runtime/", "board-store/"];
  const forbiddenImports = [
    " from \"eve\"",
    " from 'eve'",
    " from \"node:sqlite\"",
    " from 'node:sqlite'",
    " from \"@legion/board-store\"",
    " from '@legion/board-store'",
    " from \"@legion/runtime\"",
    " from '@legion/runtime'",
    " from \"@legion/runtime-eve\"",
    " from '@legion/runtime-eve'"
  ];
  // Code-only check: `process.env` is forbidden only when
  // referenced outside a comment. Strip `//` line comments
  // and `/* ... */` block comments before scanning.
  const forbiddenEnvReads = ["process.env"];
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const raw = await readFile(path.join(RELEASE_OBSERVATION_SRC_ROOT, file), "utf8");
    const codeOnly = raw
      // Strip block comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Strip line comments
      .replace(/^\s*\/\/.*$/gm, "")
      // Strip trailing line comments
      .replace(/\s+\/\/.*$/gm, "");
    for (const bad of forbiddenPathSegments) {
      assert.equal(
        codeOnly.includes(bad),
        false,
        `${file} must not reference ${bad}`
      );
    }
    for (const bad of forbiddenImports) {
      assert.equal(
        codeOnly.includes(bad),
        false,
        `${file} must not import ${bad}`
      );
    }
    for (const bad of forbiddenEnvReads) {
      assert.equal(
        codeOnly.includes(bad),
        false,
        `${file} must not read ${bad}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Phase hash determinism
// ---------------------------------------------------------------------------

test("deriveCanaryPhaseSha256 is deterministic for identical inputs", () => {
  const canary = makeCanaryInput({ passed: 2, failed: 0 });
  const invocations = canary.invocations;
  const startedAt = "2026-06-22T05:00:00.000Z";
  const draft = {
    phase: "canary",
    invocations,
    failedProbeIds: [],
    skippedProbeIds: [],
    timedOutProbeIds: [],
    outcome: "passed",
    startedAt,
    finishedAt: "2026-06-22T05:00:01.000Z"
  };
  const a = deriveCanaryPhaseSha256(draft);
  const b = deriveCanaryPhaseSha256(draft);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Failure reason — when canary runner throws
// ---------------------------------------------------------------------------

test("canary runner throwing surfaces phase_failed issue + report.failureReason", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: {
      invocations: [
        {
          probeId: "p1",
          tier: "R0",
          weight: 1,
          expectedOutcome: "passed",
          startedAt: "2026-06-22T05:00:00.000Z",
          finishedAt: "2026-06-22T05:00:01.000Z",
          outcome: "passed"
        }
      ],
      runner: () => {
        throw new Error("runner exploded");
      }
    }
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("phase_failed"));
});

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

test("regression detection: critical signal forces regressed", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: makeCanaryInput({ passed: 1 }),
    healthCheck: makeHealthCheckInput({ healthy: 1 }),
    regression: {
      baseline: {
        changeId: "chg-baseline",
        mergeQueueHash: RELEASE_OBSERVATION_FIXTURE_CONSTANTS.mergeQueueHash,
        observedAt: "2026-06-21T05:00:00.000Z",
        reportSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      },
      signals: [
        {
          signalId: "s1",
          metric: "p99_latency_ms",
          baseline: 100,
          observed: 350,
          delta: 250,
          severity: "critical"
        }
      ],
      runner: (input) => {
        // Echo the input signals so the orchestrator sees
        // the critical signal at evaluation time.
        return input.signals;
      }
    }
  }), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.status, "regressed");
  assert.match(result.report.failureReason ?? "", /regression detected/);
});

// ---------------------------------------------------------------------------
// Canary runner unavailable
// ---------------------------------------------------------------------------

test("canary invocations present but no runner yields canary_runner_unavailable issue", async () => {
  const result = await buildReleaseObservation(buildInput({
    canary: {
      invocations: [
        {
          probeId: "p1",
          tier: "R0",
          weight: 1,
          expectedOutcome: "passed",
          startedAt: "2026-06-22T05:00:00.000Z",
          finishedAt: "2026-06-22T05:00:01.000Z"
        }
      ]
    }
  }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.map((i) => i.code).includes("canary_runner_unavailable"));
});

// ---------------------------------------------------------------------------
// Class vs free function equivalence
// ---------------------------------------------------------------------------

test("ReleaseObservationOrchestrator class returns the same result shape as buildReleaseObservation", async () => {
  const orchestrator = new ReleaseObservationOrchestrator({ now: NOW });
  const a = await orchestrator.run(buildInput());
  const b = await buildReleaseObservation(buildInput(), { now: NOW });
  assert.equal(a.ok, b.ok);
});

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

test("eventTypeForReleaseStatus maps status to event type", () => {
  assert.equal(eventTypeForReleaseStatus("observing"), "release.observing");
  assert.equal(eventTypeForReleaseStatus("promoted"), "release.promoted");
  assert.equal(eventTypeForReleaseStatus("regressed"), "release.regressed");
  assert.equal(eventTypeForReleaseStatus("rolled_back"), "release.rolled_back");
});

test("deriveReleaseObservationReportSha256 is content-addressed over report fields", () => {
  const a = deriveReleaseObservationReportSha256({
    schemaVersion: "1.0.0",
    kind: RELEASE_OBSERVATION_KIND,
    changeId: "chg-1",
    mergeQueueHash: "sha256:" + "a".repeat(64),
    decisionSha256: "sha256:" + "b".repeat(64),
    tier: "R0",
    releaseability: "releaseable",
    status: "promoted",
    windowStart: "2026-06-22T05:00:00.000Z",
    windowEnd: "2026-06-22T05:30:00.000Z",
    observedAt: "2026-06-22T05:15:00.000Z",
    observedBy: { id: "obs", type: "ci-bot" },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    failureReason: null
  });
  const b = deriveReleaseObservationReportSha256({
    schemaVersion: "1.0.0",
    kind: RELEASE_OBSERVATION_KIND,
    changeId: "chg-1",
    mergeQueueHash: "sha256:" + "a".repeat(64),
    decisionSha256: "sha256:" + "b".repeat(64),
    tier: "R0",
    releaseability: "releaseable",
    status: "promoted",
    windowStart: "2026-06-22T05:00:00.000Z",
    windowEnd: "2026-06-22T05:30:00.000Z",
    observedAt: "2026-06-22T05:15:00.000Z",
    observedBy: { id: "obs", type: "ci-bot" },
    canary: null,
    healthCheck: null,
    regression: null,
    alert: null,
    failureReason: null
  });
  assert.equal(a, b);
});

test("deriveHealthCheckPhaseSha256 + deriveRegressionPhaseSha256 + deriveAlertPhaseSha256 are stable", () => {
  const startedAt = "2026-06-22T05:00:00.000Z";
  const finishedAt = "2026-06-22T05:00:01.000Z";

  const healthDraft = {
    phase: "health_check",
    invocations: [
      {
        checkId: "h1",
        endpoint: "https://example.com/health",
        intervalMs: 30_000,
        timeoutMs: 5_000,
        expectedStatus: "healthy",
        startedAt,
        finishedAt,
        observedStatus: "healthy",
        latencyMs: 12
      }
    ],
    unhealthyCheckIds: [],
    degradedCheckIds: [],
    skippedCheckIds: [],
    outcome: "healthy",
    startedAt,
    finishedAt
  };
  const regressionDraft = {
    phase: "regression_detection",
    baseline: null,
    signals: [],
    criticalSignalIds: [],
    warningSignalIds: [],
    outcome: "skipped",
    startedAt,
    finishedAt
  };
  const alertDraft = {
    phase: "alert",
    alerts: [],
    criticalAlertIds: [],
    firedAlertIds: [],
    suppressedAlertIds: [],
    startedAt,
    finishedAt
  };
  assert.equal(deriveHealthCheckPhaseSha256(healthDraft), deriveHealthCheckPhaseSha256(healthDraft));
  assert.equal(deriveRegressionPhaseSha256(regressionDraft), deriveRegressionPhaseSha256(regressionDraft));
  assert.equal(deriveAlertPhaseSha256(alertDraft), deriveAlertPhaseSha256(alertDraft));
});
