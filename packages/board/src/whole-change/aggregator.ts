/**
 * P09-T02 — Whole-change acceptance aggregator.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - `packages/core/src/merge/contract.ts` describes the merge
 *    queue itself. It stays provider-neutral (no board persistence,
 *    no Eve, no git).
 *  - This module is the *adapter* layer that turns a frozen
 *    `MergeQueueOrchestratorResult` into a board event stream +
 *    a frozen `WholeChangeAcceptanceState`. The aggregator lives
 *    in the board adapter layer because it is the canonical
 *    producer of board events for the whole-change aggregate.
 *
 * Whole-change acceptance invariants:
 *  1. A whole-change acceptance is keyed by `(changeId,
 *     mergeQueueHash)` so an orchestrator re-run on the same queue
 *     emits idempotent events. The `idempotencyKey` on every
 *     emitted `BoardEvent` is `<changeId>:<mergeQueueHash>:<eventType>`.
 *  2. The aggregator translates `MergeIntegrationOutcome` into
 *     `WholeChangeAcceptanceStatus` with the canonical map:
 *        integrated → accepted
 *        rejected   → rejected
 *        escalated  → blocked
 *        blocked    → blocked
 *     The map is non-invertible on purpose: a `blocked`
 *     whole-change may later resolve to `accepted` (runner becomes
 *     available) but the protocol's `accepted` is terminal at the
 *     state layer — we surface that transition through a follow-up
 *     event rather than mutating a frozen state.
 *  3. Every emitted event carries the content-addressed audit
 *     trail: `mergeQueueHash`, `decisionSha256`, originating
 *     `workerContextHash` (per task), and the originating
 *     `ChangeId`.
 *  4. The aggregator is pure with respect to its inputs: the only
 *     side-effect is the array of `BoardEvent` values it returns.
 *     It never imports a runtime driver, git, or `node:sqlite`.
 *     Clock is injected via `now`.
 *  5. Every output shape is deeply frozen and content-addressed
 *     so audit consumers can prove "same orchestrator result ⇒
 *     same events ⇒ same projection".
 *  6. Validation is fail-closed: an empty queue, a missing
 *     decision, a missing snapshot, a hash mismatch, or an
 *     invalid `acceptedBy` yields a typed `WholeChangeAggregatorIssue`
 *     failure shape — never a silently partial event stream.
 */

import type {
  ChangeId,
  ContentHash,
  EventId,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type {
  MergeIntegrationOutcome,
  MergeQueueOrchestratorResult
} from "@legion/core";

import type {
  BoardEvent,
  BoardEventAggregateKind,
  BoardEventType
} from "@legion/board-store";

import { BOARD_EVENT_SCHEMA_VERSION } from "@legion/board-store";

import {
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
  type WholeChangeAcceptanceAggregatorFailure,
  type WholeChangeAcceptanceAggregatorInput,
  type WholeChangeAcceptanceAggregatorResult,
  type WholeChangeAcceptanceState,
  type WholeChangeAcceptanceStatus,
  type WholeChangeAggregatedPayload,
  type WholeChangeAggregatorIssue,
  type WholeChangeEventType
} from "./contract.js";

import {
  deriveWholeChangeAggregatorHash,
  deriveWholeChangeEventPayloadHash,
  sha256OfCanonical
} from "./hash.js";

// ---------------------------------------------------------------------------
// Default reporter / clock
// ---------------------------------------------------------------------------

const DEFAULT_REPORTER = "whole-change-aggregator" as const;

const fixedClock = (): UtcTimestamp =>
  "2026-06-22T04:00:00.000Z" as UtcTimestamp;

// ---------------------------------------------------------------------------
// Outcome → status map (canonical, non-invertible)
// ---------------------------------------------------------------------------

/**
 * Translate `MergeIntegrationOutcome` into the board-level
 * `WholeChangeAcceptanceStatus` discriminator.
 *
 *   integrated → accepted
 *   rejected   → rejected
 *   escalated  → blocked
 *   blocked    → blocked
 *
 * Exposed as a free function so tests, the reducer, and the
 * projector can reuse the exact same mapping without spinning
 * up an aggregator instance.
 */
export function mapOutcomeToStatus(
  outcome: MergeIntegrationOutcome
): WholeChangeAcceptanceStatus {
  switch (outcome) {
    case "integrated":
      return "accepted";
    case "rejected":
      return "rejected";
    case "escalated":
    case "blocked":
      return "blocked";
  }
}

/**
 * Resolve the right `WholeChangeEventType` for the resolved
 * status. Mirrors `eventTypeForStatus` in contract.ts but is
 * re-declared here so the aggregator owns the emit logic without
 * importing the contract helper (avoids circular imports in
 * future refactors).
 */
function eventTypeForWholeChangeStatus(
  status: WholeChangeAcceptanceStatus
): WholeChangeEventType {
  switch (status) {
    case "accepted":
      return "change.accepted";
    case "rejected":
      return "change.rejected";
    case "blocked":
      return "change.blocked";
  }
}

// ---------------------------------------------------------------------------
// Aggregate ID helpers
// ---------------------------------------------------------------------------

/**
 * Stable, content-addressed `aggregateId` for the whole-change
 * event stream. The board column is a free-form TEXT, but
 * pinning the shape `<changeId>:<mergeQueueHash>` lets replay
 * tooling filter without parsing the JSON payload.
 */
export function deriveWholeChangeAggregateId(
  changeId: ChangeId,
  mergeQueueHash: ContentHash
): string {
  return `${changeId}:${mergeQueueHash}` as unknown as string;
}

// ---------------------------------------------------------------------------
// Input validation (fail-closed)
// ---------------------------------------------------------------------------

interface ValidationOk {
  readonly ok: true;
  readonly outcome: MergeIntegrationOutcome;
  readonly decision: NonNullable<
    MergeQueueOrchestratorResult["decision"]
  >;
  readonly mergeQueueHash: ContentHash;
  readonly workerContextHashes: readonly ContentHash[];
  readonly reason: string;
}

interface ValidationErr {
  readonly ok: false;
  readonly issues: readonly WholeChangeAggregatorIssue[];
}

type ValidationResult = ValidationOk | ValidationErr;

function isContentHash(value: unknown): value is ContentHash {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function validateInput(
  input: WholeChangeAcceptanceAggregatorInput
): ValidationResult {
  const issues: WholeChangeAggregatorIssue[] = [];

  if (!input || typeof input !== "object") {
    return {
      ok: false,
      issues: [
        {
          code: "orchestrator_result_invalid",
          message: "aggregator input must be an object",
          path: ["input"]
        }
      ]
    };
  }

  if (
    typeof input.acceptedBy !== "string" ||
    input.acceptedBy.trim().length === 0
  ) {
    issues.push({
      code: "accepted_by_invalid",
      message:
        "acceptedBy must be a non-empty string identifying the integrator actor",
      path: ["acceptedBy"]
    });
  }

  const result = input.orchestratorResult;
  if (!result || typeof result !== "object") {
    issues.push({
      code: "orchestrator_result_invalid",
      message: "orchestratorResult must be a MergeQueueOrchestratorResult",
      path: ["orchestratorResult"]
    });
    return { ok: false, issues };
  }

  const decision = result.decision;
  if (!decision) {
    issues.push({
      code: "decision_missing",
      message:
        "orchestratorResult.decision is required (merge queue did not produce an integration decision)",
      path: ["orchestratorResult", "decision"]
    });
  }

  const snapshot = result.snapshot;
  if (!snapshot) {
    issues.push({
      code: "snapshot_missing",
      message:
        "orchestratorResult.snapshot is required (merge queue did not produce a snapshot)",
      path: ["orchestratorResult", "snapshot"]
    });
  }

  if (!result.mergeQueueHash || !isContentHash(result.mergeQueueHash)) {
    issues.push({
      code: "merge_queue_hash_mismatch",
      message:
        "orchestratorResult.mergeQueueHash must be a sha256: prefixed content hash",
      path: ["orchestratorResult", "mergeQueueHash"]
    });
  }

  if (
    decision &&
    snapshot &&
    result.mergeQueueHash &&
    decision.mergeQueueHash !== result.mergeQueueHash
  ) {
    issues.push({
      code: "merge_queue_hash_mismatch",
      message:
        "decision.mergeQueueHash must equal orchestratorResult.mergeQueueHash",
      path: ["decision", "mergeQueueHash"]
    });
  }

  if (
    decision &&
    snapshot &&
    result.mergeQueueHash &&
    snapshot.mergeQueueHash !== result.mergeQueueHash
  ) {
    issues.push({
      code: "merge_queue_hash_mismatch",
      message:
        "snapshot.mergeQueueHash must equal orchestratorResult.mergeQueueHash",
      path: ["snapshot", "mergeQueueHash"]
    });
  }

  // Empty queue check: snapshot.sequenceLength === 0 means the
  // merge queue had no entries to integrate. The orchestrator
  // surface would normally refuse this, but we double-check.
  if (snapshot && snapshot.sequenceLength === 0) {
    issues.push({
      code: "empty_queue",
      message:
        "merge queue snapshot reports sequenceLength === 0; cannot aggregate an empty queue",
      path: ["snapshot", "sequenceLength"]
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Safe to narrow — every issue above is a typed issue, and the
  // checks above guarantee every field exists.
  const safeResult = result as MergeQueueOrchestratorResult & {
    decision: NonNullable<MergeQueueOrchestratorResult["decision"]>;
    snapshot: NonNullable<MergeQueueOrchestratorResult["snapshot"]>;
    mergeQueueHash: ContentHash;
  };

  // Worker-context hashes: prefer the caller-supplied list (which
  // may have come from a fresh replay), otherwise harvest from
  // each entry's refs. Since the merge queue's snapshot does NOT
  // carry per-entry refs directly, we only use the explicit
  // override and fail-closed if it is missing — the orchestrator
  // result keeps worker-context hashes inside each step's
  // entryRef (which the merge queue contract documents). We also
  // accept a side-band via input.workerContextHashes.
  let workerContextHashes: readonly ContentHash[] =
    input.workerContextHashes ?? [];
  if (workerContextHashes.length === 0) {
    workerContextHashes = safeResult.snapshot.steps
      .map((step) => step.entryRef.workerContextHash)
      .filter((hash): hash is ContentHash => isContentHash(hash));
  }

  if (workerContextHashes.length === 0) {
    issues.push({
      code: "orchestrator_result_invalid",
      message:
        "workerContextHashes could not be derived from orchestrator result; pass them via input.workerContextHashes",
      path: ["workerContextHashes"]
    });
    return { ok: false, issues };
  }

  const reason =
    typeof input.reason === "string" && input.reason.length > 0
      ? input.reason
      : buildDefaultReason(safeResult.decision.outcome, safeResult.snapshot);

  return {
    ok: true,
    outcome: safeResult.decision.outcome,
    decision: safeResult.decision,
    mergeQueueHash: safeResult.mergeQueueHash,
    workerContextHashes,
    reason
  };
}

function buildDefaultReason(
  outcome: MergeIntegrationOutcome,
  snapshot: NonNullable<MergeQueueOrchestratorResult["snapshot"]>
): string {
  const len = snapshot.sequenceLength;
  return `whole-change ${outcome} for ${len} entr${len === 1 ? "y" : "ies"}`;
}

// ---------------------------------------------------------------------------
// Frozen output helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Build the `BoardEvent` envelope for one whole-change
 * transition. The aggregator emits exactly one event per run;
 * the projection reducer can replay that single event into a
 * terminal `WholeChangeAcceptanceState`.
 */
function buildEvent(
  payload: WholeChangeAggregatedPayload,
  options: {
    readonly changeId: ChangeId;
    readonly aggregateId: string;
    readonly eventType: WholeChangeEventType;
    readonly occurredAt: UtcTimestamp;
    readonly reporter: string;
    readonly correlationId: string | null;
  }
): BoardEvent {
  const payloadHash = deriveWholeChangeEventPayloadHash(payload);
  const eventVersion = BOARD_EVENT_SCHEMA_VERSION;
  const occurredAt = options.occurredAt as unknown as string;
  const idempotencyKey =
    `${options.changeId}:${payload.mergeQueueHash}:${options.eventType}` as string;

  // The board event envelope uses `BOARD_EVENT_SCHEMA_VERSION`
  // for `schemaVersion` (the board event log schema) and
  // `eventVersion` (the payload schema). Both are required to
  // be `BOARD_EVENT_SCHEMA_VERSION` so downstream replay can
  // distinguish schema generations without parsing the payload.
  const aggregateKind: BoardEventAggregateKind = "whole_change";
  const eventType = options.eventType as unknown as BoardEventType;

  // BoardEvent.payload is typed as `Readonly<Record<string,
  // unknown>>` so any structured payload must be assigned
  // through an explicit cast. The payload shape is preserved
  // verbatim into `payloadJson` for replay.
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
    idempotencyKey
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

export interface WholeChangeAcceptanceAggregatorOptions {
  readonly now?: () => UtcTimestamp;
  readonly reporter?: string;
}

/**
 * The whole-change acceptance aggregator.
 *
 * Usage:
 *   const aggregator = new WholeChangeAcceptanceAggregator();
 *   const result = await aggregator.aggregate({
 *     changeId,
 *     orchestratorResult: mergeQueue.run(input),
 *     acceptedBy: "ci-bot",
 *     reason: "merge queue completed cleanly"
 *   });
 *   if (result.ok) {
 *     boardEventRepository.appendEvents({ events: result.events });
 *   }
 */
export class WholeChangeAcceptanceAggregator {
  readonly #now: () => UtcTimestamp;
  readonly #reporter: string;

  constructor(
    options: WholeChangeAcceptanceAggregatorOptions = {}
  ) {
    this.#now = options.now ?? fixedClock;
    this.#reporter = options.reporter ?? DEFAULT_REPORTER;
  }

  /**
   * Run the aggregator. Returns a frozen success or a typed
   * failure; never throws on validation problems.
   */
  aggregate(
    input: WholeChangeAcceptanceAggregatorInput
  ): WholeChangeAcceptanceAggregatorResult {
    const validated = validateInput(input);
    if (!validated.ok) {
      const failure: WholeChangeAcceptanceAggregatorFailure = deepFreeze({
        ok: false,
        schemaVersion: WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
        kind: WHOLE_CHANGE_ACCEPTANCE_KIND,
        changeId: input.changeId,
        issues: validated.issues,
        attemptedOutcome: input.orchestratorResult?.decision?.outcome ?? null,
        attemptedMergeQueueHash:
          input.orchestratorResult?.mergeQueueHash ?? null
      });
      return failure;
    }

    const status = mapOutcomeToStatus(validated.outcome);
    const eventType = eventTypeForWholeChangeStatus(status);
    const aggregateId = deriveWholeChangeAggregateId(
      input.changeId,
      validated.mergeQueueHash
    );
    const acceptedAt = this.#now();
    const acceptedBy = input.acceptedBy.trim();

    // Build the payload once so the same bytes feed the event
    // and the frozen state.
    const payload: WholeChangeAggregatedPayload = {
      changeId: input.changeId,
      mergeQueueHash: validated.mergeQueueHash,
      decisionSha256: validated.decision.decisionSha256,
      outcome: validated.outcome,
      status,
      acceptedEntries: [...validated.decision.acceptedEntries],
      rejectedEntries: [...validated.decision.rejectedEntries],
      escalatedEntries: [...validated.decision.escalatedEntries],
      conflictEntries: [...validated.decision.conflictEntries],
      finalHeadRef: validated.decision.finalHeadRef,
      workerContextHashes: [...validated.workerContextHashes].sort(),
      aggregatorHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000" as ContentHash,
      acceptedAt,
      acceptedBy,
      reason: validated.reason
    };

    const aggregatorHash = deriveWholeChangeAggregatorHash({
      changeId: input.changeId,
      mergeQueueHash: validated.mergeQueueHash,
      decisionSha256: validated.decision.decisionSha256,
      outcome: validated.outcome,
      finalHeadRef: validated.decision.finalHeadRef,
      acceptedBy,
      reason: validated.reason,
      workerContextHashes: payload.workerContextHashes,
      acceptedEntries: payload.acceptedEntries,
      rejectedEntries: payload.rejectedEntries,
      escalatedEntries: payload.escalatedEntries,
      conflictEntries: payload.conflictEntries,
      acceptedAt
    });

    // Patch the aggregatorHash back into the payload. The
    // payload's aggregatorHash field is part of the audit trail
    // so the state hash and the event payload hash both include
    // the final aggregatorHash.
    const finalPayload: WholeChangeAggregatedPayload = {
      ...payload,
      aggregatorHash
    };

    const event = buildEvent(finalPayload, {
      changeId: input.changeId,
      aggregateId,
      eventType,
      occurredAt: acceptedAt,
      reporter: this.#reporter,
      correlationId: input.correlationId ?? null
    });

    const state: WholeChangeAcceptanceState = deepFreeze({
      schemaVersion: WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
      kind: WHOLE_CHANGE_ACCEPTANCE_KIND,
      changeId: input.changeId,
      mergeQueueHash: validated.mergeQueueHash,
      decisionSha256: validated.decision.decisionSha256,
      outcome: validated.outcome,
      status,
      acceptedEntries: [...validated.decision.acceptedEntries],
      rejectedEntries: [...validated.decision.rejectedEntries],
      escalatedEntries: [...validated.decision.escalatedEntries],
      conflictEntries: [...validated.decision.conflictEntries],
      finalHeadRef: validated.decision.finalHeadRef,
      acceptedAt,
      acceptedBy,
      reason: validated.reason,
      workerContextHashes: [...validated.workerContextHashes].sort(),
      aggregatorHash
    });

    return deepFreeze({
      ok: true,
      schemaVersion: WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
      kind: WHOLE_CHANGE_ACCEPTANCE_KIND,
      changeId: input.changeId,
      mergeQueueHash: validated.mergeQueueHash,
      decisionSha256: validated.decision.decisionSha256,
      outcome: validated.outcome,
      status,
      state,
      events: [event],
      aggregatorHash,
      acceptedAt
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience: project an orchestrator result to events without
// instantiating the class (mirrors the free-function convention
// from P08-T02). Used by the projector + reducer tests.
// ---------------------------------------------------------------------------

export function buildWholeChangeAcceptance(
  input: WholeChangeAcceptanceAggregatorInput,
  options: WholeChangeAcceptanceAggregatorOptions = {}
): WholeChangeAcceptanceAggregatorResult {
  const aggregator = new WholeChangeAcceptanceAggregator(options);
  return aggregator.aggregate(input);
}

// ---------------------------------------------------------------------------
// Allowlist guard — used by `WholeChangeAcceptanceKey` consumers
// to verify a payload hash is for a whole-change event.
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_AGGREGATE_KIND_LITERAL =
  "whole_change" as unknown as BoardEventAggregateKind;

export type { BoardEventType };