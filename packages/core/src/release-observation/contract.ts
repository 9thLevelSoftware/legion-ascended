/**
 * P10-T01 — Release observation contract.
 *
 * Why this lives in its own module under `@legion/core`:
 *  - `packages/core/src/merge/contract.ts` describes the merge
 *    queue + whole-change integration decision. Release observation
 *    is downstream of that surface: it consumes the frozen
 *    `MergeQueueOrchestratorResult` and adds monitoring/health/
 *    regression/alert evidence on top.
 *  - The release-observation module is provider-neutral: it never
 *    imports board persistence, runtime drivers, host CLIs, or
 *    `node:sqlite`. Probe execution is injected via a
 *    `CanaryProbeRunner`; alerting is injected via an
 *    `AlertSink`. CLI / runtime / DB adapters wrap concrete
 *    monitoring/alerting backends in `@legion/cli` and
 *    `@legion/store-sqlite` (mirroring the P09-T01 rebase
 *    sequencer layering).
 *
 * Release-observation invariants:
 *  1. Release observation is keyed by `(changeId, mergeQueueHash)`
 *     and only consumes `accepted` whole-change state. A
 *     `blocked`/`rejected`/`escalated` merge queue result MUST
 *     surface a typed `ReleaseObservationIssue` rather than emit
 *     a `ReleaseObservationReport`.
 *  2. A release-observation cycle has four sequential phases:
 *        canary → health-check → regression-detection → alert
 *     Each phase is independently auditable and produces a
 *     content-addressed `*PhaseResult` record. Phases that are
 *     skipped (e.g. regression-detection before any baseline)
 *     surface as `skipped` outcomes with a structured reason.
 *  3. A release-observation report is `observing` until either
 *     every required phase emits a `passed`/`healthy` outcome
 *     (→ `promoted`) or any phase emits a `failed`/`regressed`
 *     outcome (→ `regressed`) or a critical alert fires
 *     (→ `rolled_back`). Phase 10 collapses these to the
 *     non-invertible terminal status set the board adapter
 *     projects: `promoted | regressed | rolled_back`.
 *  4. The observation window is bounded by `windowStart`,
 *     `windowEnd`, and `tier` (a Phase 8 risk tier). A canary
 *     observation cycle MUST terminate inside the window or it
 *     becomes a `timed_out` outcome — never a silent success.
 *  5. Every output shape is deeply frozen, content-addressed, and
 *     keyed back to the originating merge queue so audit consumers
 *     can prove "same orchestrator result ⇒ same observation
 *     cycle ⇒ same report".
 *  6. `CanaryProbeRunner`, `HealthCheckRunner`, and
 *     `RegressionDetectorRunner` are async-or-sync function
 *     callbacks. They are the ONLY way to perform side-effecting
 *     monitoring work. Core never spawns child processes, reads
 *     `process.env`, or imports a runtime driver.
 *  7. The release-observation orchestrator is pure with respect
 *     to its inputs. The only side-effects are the array of
 *     `BoardEvent`-shaped payloads it returns and any records
 *     that the injected runners choose to write to their
 *     own sinks. The orchestrator is therefore safe to replay
 *     in tests and to re-run idempotently in production when
 *     the same `mergeQueueHash` is observed again.
 */

import type {
  Actor,
  ChangeId,
  ContentHash,
  RiskTier,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type {
  MergeIntegrationDecision,
  MergeQueueOrchestratorResult
} from "../merge/contract.js";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const RELEASE_OBSERVATION_KIND = "release-observation" as const;

// ---------------------------------------------------------------------------
// Phase codes — surface structured non-releaseable diagnostics
// ---------------------------------------------------------------------------

export type ReleaseObservationIssueCode =
  | "merge_integration_not_accepted"
  | "merge_queue_hash_mismatch"
  | "decision_missing"
  | "snapshot_missing"
  | "canary_runner_unavailable"
  | "health_check_runner_unavailable"
  | "regression_detector_runner_unavailable"
  | "alert_sink_unavailable"
  | "window_invalid"
  | "window_expired"
  | "phase_timeout"
  | "phase_failed"
  | "phase_payload_invalid"
  | "probe_invocations_invalid"
  | "baseline_observation_missing";

export interface ReleaseObservationIssue {
  readonly code: ReleaseObservationIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly phase?: ReleaseObservationPhaseName;
}

// ---------------------------------------------------------------------------
// Releaseable gate — the canonical map from outcome to releaseability
// ---------------------------------------------------------------------------

/**
 * The canonical, non-invertible releaseability map. Mirrors the
 * P09-T02 outcome → status rule:
 *    integrated → "releaseable"
 *    rejected   → "non_releaseable"
 *    escalated  → "deferred"
 *    blocked    → "non_releaseable"
 *
 * Only `releaseable` is allowed to enter release observation.
 * `non_releaseable` and `deferred` states route to a typed
 * `ReleaseObservationIssue` ("merge_integration_not_accepted")
 * rather than running the canary cycle.
 */
export type ReleaseabilityState =
  | "releaseable"
  | "non_releaseable"
  | "deferred";

export function mapIntegrationOutcomeToReleaseability(
  outcome: MergeIntegrationDecision["outcome"]
): ReleaseabilityState {
  switch (outcome) {
    case "integrated":
      return "releaseable";
    case "rejected":
    case "blocked":
      return "non_releaseable";
    case "escalated":
      return "deferred";
  }
}

// ---------------------------------------------------------------------------
// Canary / health / regression / alert — the four observation phases
// ---------------------------------------------------------------------------

export type ReleaseObservationPhaseName =
  | "canary"
  | "health_check"
  | "regression_detection"
  | "alert";

export const RELEASE_OBSERVATION_PHASES: readonly ReleaseObservationPhaseName[] = [
  "canary",
  "health_check",
  "regression_detection",
  "alert"
] as const;

export type ProbeOutcome =
  | "passed"
  | "failed"
  | "skipped"
  | "timed_out";

/**
 * A single canary probe invocation. Canary probes are the
 * smallest, fastest, and most deterministic canary check. The
 * orchestrator runs them in the order given and produces an
 * ordered, content-addressed phase result.
 */
export interface CanaryProbeInvocation {
  readonly probeId: string;
  readonly tier: RiskTier;
  readonly weight: number;
  readonly expectedOutcome: ProbeOutcome;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly outcome: ProbeOutcome;
  readonly observedValue?: number;
  readonly threshold?: number;
  readonly notes?: string;
}

export type CanaryProbeRunner = (
  invocation: CanaryProbeInvocation
) => Promise<CanaryProbeInvocation> | CanaryProbeInvocation;

export interface CanaryPhaseInput {
  readonly invocations: readonly CanaryProbeInvocation[];
  readonly runner?: CanaryProbeRunner;
}

export interface CanaryPhaseResult {
  readonly phase: "canary";
  readonly invocations: readonly CanaryProbeInvocation[];
  readonly failedProbeIds: readonly string[];
  readonly skippedProbeIds: readonly string[];
  readonly timedOutProbeIds: readonly string[];
  readonly outcome: ProbeOutcome;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly phaseSha256: ContentHash;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export type HealthCheckStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "skipped";

export interface HealthCheckInvocation {
  readonly checkId: string;
  readonly endpoint: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly expectedStatus: HealthCheckStatus;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly observedStatus: HealthCheckStatus;
  readonly latencyMs?: number;
  readonly notes?: string;
}

export type HealthCheckRunner = (
  invocation: HealthCheckInvocation
) => Promise<HealthCheckInvocation> | HealthCheckInvocation;

export interface HealthCheckPhaseInput {
  readonly invocations: readonly HealthCheckInvocation[];
  readonly runner?: HealthCheckRunner;
}

export interface HealthCheckPhaseResult {
  readonly phase: "health_check";
  readonly invocations: readonly HealthCheckInvocation[];
  readonly unhealthyCheckIds: readonly string[];
  readonly degradedCheckIds: readonly string[];
  readonly skippedCheckIds: readonly string[];
  readonly outcome: HealthCheckStatus;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly phaseSha256: ContentHash;
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

export type RegressionOutcome =
  | "no_regression"
  | "regression_detected"
  | "skipped"
  | "timed_out";

/**
 * Reference to a previously observed whole-change release cycle.
 * The regression detector uses this as the baseline. The baseline
 * is content-addressed so consumers can audit which prior
 * observation the current cycle was compared against.
 */
export interface RegressionBaselineRef {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly observedAt: UtcTimestamp;
  readonly reportSha256: ContentHash;
}

export interface RegressionSignal {
  readonly signalId: string;
  readonly metric: string;
  readonly baseline: number;
  readonly observed: number;
  readonly delta: number;
  readonly severity: "info" | "warn" | "critical";
  readonly notes?: string;
}

export interface RegressionPhaseInput {
  readonly baseline: RegressionBaselineRef | null;
  readonly signals: readonly RegressionSignal[];
  readonly runner?: (
    input: RegressionPhaseInput
  ) => Promise<readonly RegressionSignal[]> | readonly RegressionSignal[];
}

export interface RegressionPhaseResult {
  readonly phase: "regression_detection";
  readonly baseline: RegressionBaselineRef | null;
  readonly signals: readonly RegressionSignal[];
  readonly criticalSignalIds: readonly string[];
  readonly warningSignalIds: readonly string[];
  readonly outcome: RegressionOutcome;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly phaseSha256: ContentHash;
}

// ---------------------------------------------------------------------------
// Alerts — the only phase that produces a non-rollback side effect
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warn" | "critical";
export type AlertDecision = "fired" | "suppressed" | "deduplicated";

export interface AlertRecord {
  readonly alertId: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly summary: string;
  readonly source: ReleaseObservationPhaseName;
  readonly firedAt: UtcTimestamp;
  readonly decision: AlertDecision;
  readonly correlationId?: string;
  readonly notes?: string;
}

export type AlertSink = (
  alert: AlertRecord
) => Promise<AlertRecord> | AlertRecord;

export interface AlertPhaseInput {
  readonly candidateAlerts: readonly Omit<
    AlertRecord,
    "firedAt" | "decision"
  >[];
  readonly sink?: AlertSink;
}

export interface AlertPhaseResult {
  readonly phase: "alert";
  readonly alerts: readonly AlertRecord[];
  readonly criticalAlertIds: readonly string[];
  readonly firedAlertIds: readonly string[];
  readonly suppressedAlertIds: readonly string[];
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly phaseSha256: ContentHash;
}

// ---------------------------------------------------------------------------
// Release-observation status — terminal at the state layer
// ---------------------------------------------------------------------------

/**
 * The terminal status of a release-observation cycle. Mirrors
 * the P09-T02 non-invertible status rule: once a cycle reaches
 * a terminal status it stays there; a follow-up cycle must
 * reference a different `mergeQueueHash` to surface a new
 * status.
 */
export type ReleaseObservationStatus =
  | "observing"
  | "promoted"
  | "regressed"
  | "rolled_back";

// ---------------------------------------------------------------------------
// Release observation report
// ---------------------------------------------------------------------------

/**
 * Immutable identity for a release-observation cycle. The
 * `(changeId, mergeQueueHash)` pair anchors every report to
 * the originating merge queue run.
 */
export interface ReleaseObservationAggregateId {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
}

export interface ReleaseObservationInput {
  readonly changeId: ChangeId;
  readonly orchestratorResult: MergeQueueOrchestratorResult;
  readonly windowStart: UtcTimestamp;
  readonly windowEnd: UtcTimestamp;
  readonly tier: RiskTier;
  readonly observer: Actor;
  readonly observedAt: UtcTimestamp;
  readonly canary?: CanaryPhaseInput;
  readonly healthCheck?: HealthCheckPhaseInput;
  readonly regression?: RegressionPhaseInput;
  readonly alert?: AlertPhaseInput;
  readonly now?: () => UtcTimestamp;
}

export interface ReleaseObservationReport {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly tier: RiskTier;
  readonly releaseability: ReleaseabilityState;
  readonly status: ReleaseObservationStatus;
  readonly windowStart: UtcTimestamp;
  readonly windowEnd: UtcTimestamp;
  readonly observedAt: UtcTimestamp;
  readonly observedBy: Actor;
  readonly canary: CanaryPhaseResult | null;
  readonly healthCheck: HealthCheckPhaseResult | null;
  readonly regression: RegressionPhaseResult | null;
  readonly alert: AlertPhaseResult | null;
  readonly reportSha256: ContentHash;
  readonly failureReason: string | null;
}

// ---------------------------------------------------------------------------
// Aggregator result
// ---------------------------------------------------------------------------

export interface ReleaseObservationSuccess {
  readonly ok: true;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly report: ReleaseObservationReport;
  readonly eventPayloads: readonly ReleaseObservationEventPayload[];
  readonly reportSha256: ContentHash;
}

export interface ReleaseObservationFailure {
  readonly ok: false;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_KIND;
  readonly changeId: ChangeId | null;
  readonly issues: readonly ReleaseObservationIssue[];
  readonly attemptedMergeQueueHash: ContentHash | null;
}

export type ReleaseObservationResult =
  | ReleaseObservationSuccess
  | ReleaseObservationFailure;

// ---------------------------------------------------------------------------
// Event payloads — what the board adapter emits
// ---------------------------------------------------------------------------

export type ReleaseObservationEventType =
  | "release.observing"
  | "release.observed"
  | "release.promoted"
  | "release.regressed"
  | "release.rolled_back";

export const RELEASE_OBSERVATION_EVENT_TYPES: readonly ReleaseObservationEventType[] =
  [
    "release.observing",
    "release.observed",
    "release.promoted",
    "release.regressed",
    "release.rolled_back"
  ] as const;

export const RELEASE_OBSERVATION_AGGREGATE_KINDS = [
  "release_observation"
] as const;

export type ReleaseObservationAggregateKind =
  (typeof RELEASE_OBSERVATION_AGGREGATE_KINDS)[number];

export interface ReleaseObservationObservedPayload {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof RELEASE_OBSERVATION_KIND;
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly tier: RiskTier;
  readonly releaseability: ReleaseabilityState;
  readonly status: ReleaseObservationStatus;
  readonly windowStart: UtcTimestamp;
  readonly windowEnd: UtcTimestamp;
  readonly observedAt: UtcTimestamp;
  readonly observedBy: Actor;
  readonly canary: CanaryPhaseResult | null;
  readonly healthCheck: HealthCheckPhaseResult | null;
  readonly regression: RegressionPhaseResult | null;
  readonly alert: AlertPhaseResult | null;
  /**
   * The full `ReleaseObservationReport` rides as a nested
   * object so the board adapter's reducer can rebuild the
   * projection state from the event log without re-running
   * the orchestrator. Consumers that only need the
   * flat-shaped surface can ignore this field.
   */
  readonly report: ReleaseObservationReport;
  readonly reportSha256: ContentHash;
  readonly failureReason: string | null;
}

export type ReleaseObservationEventPayload = ReleaseObservationObservedPayload;

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation (mirrors P08 / P09 contract)
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_KEYS = [
  "ok",
  "schemaVersion",
  "kind",
  "changeId",
  "mergeQueueHash",
  "report",
  "eventPayloads",
  "reportSha256",
  "issues",
  "attemptedMergeQueueHash"
] as const;

export type ReleaseObservationKey = (typeof RELEASE_OBSERVATION_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers — re-exported for adapter consumers
// ---------------------------------------------------------------------------

/**
 * Helper that picks the matching event type for the resolved
 * release-observation status. Used by the orchestrator and the
 * board adapter's reducer.
 */
export function eventTypeForReleaseStatus(
  status: ReleaseObservationStatus
): ReleaseObservationEventType {
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
