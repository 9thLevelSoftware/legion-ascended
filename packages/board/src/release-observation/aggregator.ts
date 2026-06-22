/**
 * P10-T01 — Release observation board aggregator.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - `packages/core/src/release-observation/contract.ts`
 *    describes the provider-neutral release observation
 *    orchestrator. It stays out of board persistence.
 *  - This module is the *adapter* layer that turns a frozen
 *    `ReleaseObservationReport` into a board event stream +
 *    a frozen `ReleaseObservationProjectionState`. The
 *    aggregator lives in the board adapter layer because it
 *    is the canonical producer of board events for the
 *    release-observation aggregate.
 *
 * Release-observation board invariants:
 *  1. A release-observation event is keyed by
 *     `<changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`
 *     so an orchestrator re-run on the same merge queue +
 *     same report emits idempotent events.
 *  2. The aggregator translates `ReleaseObservationStatus`
 *     into a `ReleaseObservationEventType` via a canonical
 *     non-invertible map. Terminal statuses stay terminal;
 *     a promotion requires a fresh `reportSha256`.
 *  3. Every emitted event carries the content-addressed
 *     audit trail: `changeId`, `mergeQueueHash`,
 *     `decisionSha256`, `reportSha256`, and `observedBy`.
 *  4. The aggregator is pure with respect to its inputs.
 *     The only side-effect is the array of `BoardEvent`
 *     values it returns. It never imports a runtime
 *     driver, git, or `node:sqlite`. Clock is injected
 *     via `now`.
 *  5. Every output shape is deeply frozen and
 *     content-addressed so audit consumers can prove
 *     "same orchestrator result ⇒ same events ⇒ same
 *     projection".
 *  6. Validation is fail-closed: a missing report, a
 *     `reportSha256` mismatch, a `changeId` mismatch, or
 *     an invalid event type yields a typed
 *     `ReleaseObservationBoardIssue` failure shape.
 */

import type {
  ChangeId,
  ContentHash,
  EventId,
  UtcTimestamp
} from "@legion/protocol";

import {
  RELEASE_OBSERVATION_KIND,
  type ReleaseObservationEventPayload,
  type ReleaseObservationReport
} from "@legion/core";

import type {
  BoardEvent,
  BoardEventAggregateKind,
  BoardEventType
} from "@legion/board-store";

import { BOARD_EVENT_SCHEMA_VERSION } from "@legion/board-store";

import {
  RELEASE_OBSERVATION_ADAPTER_KIND,
  RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
  type ReleaseObservationBoardAggregatorFailure,
  type ReleaseObservationBoardAggregatorInput,
  type ReleaseObservationBoardAggregatorResult,
  type ReleaseObservationBoardAggregatorSuccess,
  type ReleaseObservationBoardIssue,
  type ReleaseObservationEventType,
  type ReleaseObservationProjectionState,
  eventTypeForReleaseObservationStatus,
  releaseObservationIdempotencyKey
} from "./contract.js";

// Re-export so the module barrel can surface the
// contract-level helpers without forcing adapter
// consumers to import `contract.js` directly.
export {
  eventTypeForReleaseObservationStatus,
  releaseObservationIdempotencyKey
};

import { deriveReleaseObservationEventPayloadHash } from "./hash.js";

// ---------------------------------------------------------------------------
// Default reporter / clock
// ---------------------------------------------------------------------------

const DEFAULT_REPORTER = "release-observation-aggregator" as const;

const fixedClock = (): UtcTimestamp =>
  "2026-06-22T05:30:00.000Z" as UtcTimestamp;

// ---------------------------------------------------------------------------
// Aggregate ID helper
// ---------------------------------------------------------------------------

export function deriveReleaseObservationAggregateId(input: {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly reportSha256: ContentHash;
}): string {
  return `${input.changeId}:${input.mergeQueueHash}:${input.reportSha256}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isContentHash(value: unknown): value is ContentHash {
  return (
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Input validation (fail-closed)
// ---------------------------------------------------------------------------

interface ValidationOk {
  readonly ok: true;
  readonly eventType: ReleaseObservationEventType;
}

interface ValidationErr {
  readonly ok: false;
  readonly issues: readonly ReleaseObservationBoardIssue[];
}

type ValidationResult = ValidationOk | ValidationErr;

const RELEASE_OBSERVATION_BOARD_EVENT_TYPE_SET = new Set<string>([
  "release.observing",
  "release.observed",
  "release.promoted",
  "release.regressed",
  "release.rolled_back"
]);

function validateInput(
  input: ReleaseObservationBoardAggregatorInput
): ValidationResult {
  const issues: ReleaseObservationBoardIssue[] = [];

  if (!input || typeof input !== "object") {
    return {
      ok: false,
      issues: [
        {
          code: "report_missing",
          message: "aggregator input must be an object",
          path: ["input"]
        }
      ]
    };
  }

  const report = input.report;
  if (!report || typeof report !== "object") {
    issues.push({
      code: "report_missing",
      message: "input.report is required for the release-observation aggregator",
      path: ["report"]
    });
    return { ok: false, issues };
  }

  if (!isContentHash(report.reportSha256)) {
    issues.push({
      code: "report_sha_mismatch",
      message:
        "report.reportSha256 must be a sha256: prefixed content hash",
      path: ["report", "reportSha256"]
    });
  }

  if (report.changeId !== input.changeId) {
    issues.push({
      code: "change_id_mismatch",
      message:
        "report.changeId must equal input.changeId for a release-observation aggregator run",
      path: ["report", "changeId"]
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const eventType = eventTypeForReleaseObservationStatus(report.status);
  if (!RELEASE_OBSERVATION_BOARD_EVENT_TYPE_SET.has(eventType)) {
    issues.push({
      code: "event_type_invalid",
      message: `derived event type "${eventType}" is not in the release-observation board event allowlist`,
      path: ["report", "status"]
    });
    return { ok: false, issues };
  }

  return { ok: true, eventType };
}

// ---------------------------------------------------------------------------
// Board event builder
// ---------------------------------------------------------------------------

function buildBoardEvent(
  payload: import("@legion/core").ReleaseObservationEventPayload,
  options: {
    readonly changeId: ChangeId;
    readonly aggregateId: string;
    readonly eventType: ReleaseObservationEventType;
    readonly occurredAt: UtcTimestamp;
    readonly reporter: string;
    readonly correlationId: string | null;
    readonly idempotencyKey: string;
  }
): BoardEvent {
  const payloadHash = deriveReleaseObservationEventPayloadHash(payload);
  const eventVersion = BOARD_EVENT_SCHEMA_VERSION;
  const occurredAt = options.occurredAt as unknown as string;
  const aggregateKind: BoardEventAggregateKind = "release_observation";
  const eventType = options.eventType as unknown as BoardEventType;
  const payloadRecord = payload as unknown as Readonly<Record<string, unknown>>;

  const envelope = {
    schemaVersion: BOARD_EVENT_SCHEMA_VERSION,
    eventId: "" as unknown as EventId,
    aggregateKind,
    aggregateId: options.aggregateId,
    aggregateSequence: 1,
    globalSequence: 0,
    eventType,
    eventVersion,
    payload: payloadRecord,
    payloadHash,
    causationId: null,
    correlationId: options.correlationId,
    occurredAt,
    idempotencyKey: options.idempotencyKey
  };

  const boardEvent: BoardEvent = {
    ...envelope,
    payloadJson: JSON.stringify(payload)
  };

  return deepFreeze(boardEvent);
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

export interface ReleaseObservationBoardAggregatorOptions {
  readonly now?: () => UtcTimestamp;
  readonly reporter?: string;
}

/**
 * The release-observation board aggregator.
 *
 * Usage:
 *   const aggregator = new ReleaseObservationBoardAggregator();
 *   const result = aggregator.aggregate({
 *     changeId,
 *     report: releaseObservationOrchestrator.run(...)
 *   });
 *   if (result.ok) {
 *     boardEventRepository.appendEvents({ events: result.events });
 *   }
 */
export class ReleaseObservationBoardAggregator {
  readonly #now: () => UtcTimestamp;
  readonly #reporter: string;

  constructor(
    options: ReleaseObservationBoardAggregatorOptions = {}
  ) {
    this.#now = options.now ?? fixedClock;
    this.#reporter = options.reporter ?? DEFAULT_REPORTER;
  }

  /**
   * Run the aggregator. Returns a frozen success or a typed
   * failure; never throws on validation problems.
   */
  aggregate(
    input: ReleaseObservationBoardAggregatorInput
  ): ReleaseObservationBoardAggregatorResult {
    const validated = validateInput(input);
    if (!validated.ok) {
      const failure: ReleaseObservationBoardAggregatorFailure = deepFreeze({
        ok: false,
        schemaVersion: RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
        kind: RELEASE_OBSERVATION_ADAPTER_KIND,
        changeId: input.changeId,
        issues: validated.issues
      });
      return failure;
    }

    const report: ReleaseObservationReport = input.report;
    const eventType = validated.eventType;
    const observedAt = this.#now();
    const aggregateId = deriveReleaseObservationAggregateId({
      changeId: report.changeId,
      mergeQueueHash: report.mergeQueueHash,
      reportSha256: report.reportSha256
    });
    const idempotencyKey = releaseObservationIdempotencyKey(
      report.changeId,
      report.mergeQueueHash,
      report.reportSha256,
      eventType
    );
    const reporter =
      typeof input.reporter === "string" && input.reporter.length > 0
        ? input.reporter
        : this.#reporter;

    // Build the event payload. The payload is a verbatim copy
    // of the report's relevant fields, content-addressed via
    // the deriveReleaseObservationEventPayloadHash helper.
    // The full report rides as a nested `report` field so
    // the board adapter's reducer can rebuild the projection
    // state from the event log without re-running the
    // orchestrator.
    const payload: ReleaseObservationEventPayload = {
      schemaVersion: RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
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

    const event = buildBoardEvent(payload, {
      changeId: report.changeId,
      aggregateId,
      eventType,
      occurredAt: observedAt,
      reporter,
      correlationId: input.correlationId ?? null,
      idempotencyKey
    });

    const state: ReleaseObservationProjectionState = deepFreeze({
      schemaVersion: RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
      kind: RELEASE_OBSERVATION_ADAPTER_KIND,
      changeId: report.changeId,
      mergeQueueHash: report.mergeQueueHash,
      reportSha256: report.reportSha256,
      decisionSha256: report.decisionSha256,
      report,
      lastEventType: eventType,
      lastObservedAt: observedAt,
      observedBy: report.observedBy.id,
      reportCount: 1
    });

    const success: ReleaseObservationBoardAggregatorSuccess = deepFreeze({
      ok: true,
      schemaVersion: RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION,
      kind: RELEASE_OBSERVATION_ADAPTER_KIND,
      changeId: report.changeId,
      mergeQueueHash: report.mergeQueueHash,
      reportSha256: report.reportSha256,
      lastEventType: eventType,
      state,
      events: [event],
      idempotencyKey,
      observedAt
    });
    return success;
  }
}

// ---------------------------------------------------------------------------
// Convenience: project a release-observation report to events without
// instantiating the class
// ---------------------------------------------------------------------------

export function buildReleaseObservationBoardEvent(
  input: ReleaseObservationBoardAggregatorInput,
  options: ReleaseObservationBoardAggregatorOptions = {}
): ReleaseObservationBoardAggregatorResult {
  const aggregator = new ReleaseObservationBoardAggregator(options);
  return aggregator.aggregate(input);
}

// ---------------------------------------------------------------------------
// Aggregate kind literal — exported for adapter consumers that
// pattern-match on the typed literal
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_AGGREGATE_KIND_LITERAL =
  "release_observation" as unknown as BoardEventAggregateKind;
