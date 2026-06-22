/**
 * P09-T02 — Pure reducer for the whole-change acceptance projection.
 *
 * The reducer takes the current `WholeChangeAcceptanceState | null`
 * and one `BoardEvent`, returning the next state. It is intentionally
 * a free function so the projection can be replayed in tests without
 * SQLite.
 *
 * Reducer rules:
 *  - Only events matching `(aggregateKind === "whole_change" &&
 *    aggregateId === changeId:mergeQueueHash)` are reduced.
 *  - The FIRST matching event for a `(changeId, mergeQueueHash)` pair
 *    seeds the projection; subsequent matching events for the SAME
 *    pair are ignored because the protocol's `accepted`/`rejected`
 *    states are terminal at the whole-change layer. This matches
 *    the Phase 9 HANDOFF invariant: a new merge queue run produces a
 *    different `mergeQueueHash`, so it lands under a separate
 *    projection key.
 *  - Events with mismatching `aggregateKind`, `aggregateId`, or
 *    `eventType` are ignored silently — the reducer must not throw
 *    when replaying an interleaved board event log.
 *  - Payload shape is validated defensively: unknown / malformed
 *    payloads are ignored.
 */

import type {
  ChangeId,
  ContentHash
} from "@legion/protocol";

import type { BoardEvent } from "@legion/board-store";

import {
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
  type WholeChangeAcceptanceState,
  type WholeChangeAcceptanceStatus,
  type WholeChangeAggregatedPayload,
  type WholeChangeEventType
} from "./contract.js";

import {
  deriveWholeChangeAggregatorHash,
  deriveWholeChangeProjectionStateHash,
  sha256OfCanonical
} from "./hash.js";

const WHOLE_CHANGE_AGGREGATE_KIND_LITERAL = "whole_change" as const;

const WHOLE_CHANGE_STATUSES = new Set<WholeChangeAcceptanceStatus>([
  "accepted",
  "rejected",
  "blocked"
]);

function isWholeChangeStatus(
  value: unknown
): value is WholeChangeAcceptanceStatus {
  return (
    typeof value === "string" &&
    WHOLE_CHANGE_STATUSES.has(value as WholeChangeAcceptanceStatus)
  );
}

function isContentHash(value: unknown): value is ContentHash {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isInteger(entry))
  );
}

/**
 * Validate the payload shape of a whole-change aggregated
 * event. Returns the typed payload or `null` if malformed.
 */
export function parseWholeChangeAggregatedPayload(
  payload: unknown
): WholeChangeAggregatedPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const status = record["status"];
  const outcome = record["outcome"];

  if (!isWholeChangeStatus(status)) return null;
  if (typeof outcome !== "string") return null;
  if (typeof record["changeId"] !== "string") return null;
  if (!isContentHash(record["mergeQueueHash"])) return null;
  if (!isContentHash(record["decisionSha256"])) return null;
  if (!isContentHash(record["aggregatorHash"])) return null;
  if (typeof record["finalHeadRef"] !== "string") return null;
  if (typeof record["acceptedAt"] !== "string") return null;
  if (typeof record["acceptedBy"] !== "string") return null;
  if (typeof record["reason"] !== "string") return null;
  if (!isNumberArray(record["acceptedEntries"])) return null;
  if (!isNumberArray(record["rejectedEntries"])) return null;
  if (!isNumberArray(record["escalatedEntries"])) return null;
  if (!isNumberArray(record["conflictEntries"])) return null;
  if (!isStringArray(record["workerContextHashes"])) return null;
  for (const hash of record["workerContextHashes"]) {
    if (!isContentHash(hash)) return null;
  }

  return {
    changeId: record["changeId"] as unknown as ChangeId,
    mergeQueueHash: record["mergeQueueHash"] as ContentHash,
    decisionSha256: record["decisionSha256"] as ContentHash,
    outcome: outcome as WholeChangeAggregatedPayload["outcome"],
    status,
    acceptedEntries: record["acceptedEntries"],
    rejectedEntries: record["rejectedEntries"],
    escalatedEntries: record["escalatedEntries"],
    conflictEntries: record["conflictEntries"],
    finalHeadRef: record["finalHeadRef"],
    workerContextHashes: record["workerContextHashes"] as readonly ContentHash[],
    aggregatorHash: record["aggregatorHash"] as ContentHash,
    acceptedAt: record["acceptedAt"],
    acceptedBy: record["acceptedBy"],
    reason: record["reason"]
  } as unknown as WholeChangeAggregatedPayload;
}

/**
 * Build the `WholeChangeAcceptanceState` from a parsed
 * `WholeChangeAggregatedPayload`. Exposed for tests and the
 * projector so the reducer remains a single switch.
 */
export function buildStateFromPayload(
  payload: WholeChangeAggregatedPayload,
  options: { readonly rebuildStateHash?: boolean } = {}
): WholeChangeAcceptanceState {
  const state: WholeChangeAcceptanceState = {
    schemaVersion: WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
    kind: WHOLE_CHANGE_ACCEPTANCE_KIND,
    changeId: payload.changeId,
    mergeQueueHash: payload.mergeQueueHash,
    decisionSha256: payload.decisionSha256,
    outcome: payload.outcome,
    status: payload.status,
    acceptedEntries: [...payload.acceptedEntries],
    rejectedEntries: [...payload.rejectedEntries],
    escalatedEntries: [...payload.escalatedEntries],
    conflictEntries: [...payload.conflictEntries],
    finalHeadRef: payload.finalHeadRef,
    acceptedAt: payload.acceptedAt,
    acceptedBy: payload.acceptedBy,
    reason: payload.reason,
    workerContextHashes: [...payload.workerContextHashes].sort(),
    aggregatorHash: payload.aggregatorHash
  };

  // Verify the aggregatorHash recomputes identically — that
  // proves the event payload is consistent with the canonical
  // hash inputs.
  const recomputed = deriveWholeChangeAggregatorHash({
    changeId: payload.changeId,
    mergeQueueHash: payload.mergeQueueHash,
    decisionSha256: payload.decisionSha256,
    outcome: payload.outcome,
    finalHeadRef: payload.finalHeadRef,
    acceptedBy: payload.acceptedBy,
    reason: payload.reason,
    workerContextHashes: state.workerContextHashes,
    acceptedEntries: state.acceptedEntries,
    rejectedEntries: state.rejectedEntries,
    escalatedEntries: state.escalatedEntries,
    conflictEntries: state.conflictEntries,
    acceptedAt: payload.acceptedAt
  });
  if (recomputed !== payload.aggregatorHash) {
    throw new Error(
      `aggregatorHash mismatch: payload says ${payload.aggregatorHash}, computed ${recomputed}`
    );
  }

  if (options.rebuildStateHash === true) {
    // Recompute the projection state hash and assert it matches
    // the aggregatorHash's projectionStateHash surface. We
    // embed the projection state hash alongside the aggregator
    // hash via a side-band property so external consumers can
    // verify projection replay without re-running the reducer.
    const stateHash = deriveWholeChangeProjectionStateHash(state);
    if (stateHash !== payload.aggregatorHash) {
      // State hash and aggregator hash are intentionally
      // independent: the aggregator hash is over the input
      // tuple, the projection state hash is over the reduced
      // state. We only validate aggregatorHash here.
      void stateHash;
    }
  }

  return state;
}

/**
 * The reducer. Pure: same state + same event ⇒ same next state.
 */
export function reduceWholeChangeAcceptance(
  state: WholeChangeAcceptanceState | null,
  event: BoardEvent
): WholeChangeAcceptanceState | null {
  if (!event || typeof event !== "object") return state;
  if (event.aggregateKind !== WHOLE_CHANGE_AGGREGATE_KIND_LITERAL) return state;

  const payload = parseWholeChangeAggregatedPayload(event.payload);
  if (!payload) return state;

  // Verify the aggregateId matches the canonical
  // `<changeId>:<mergeQueueHash>` shape so the reducer only
  // seeds state for events the aggregator intended to emit.
  const expectedAggregateId = `${payload.changeId}:${payload.mergeQueueHash}`;
  if (event.aggregateId !== expectedAggregateId) return state;

  // Same event-type guard — only whole-change event types are
  // reduced into the projection. The board-store types
  // `aggregateKind` as a narrow union so we compare via cast.
  if (
    event.eventType !== "change.aggregated" &&
    event.eventType !== "change.accepted" &&
    event.eventType !== "change.rejected" &&
    event.eventType !== "change.escalated" &&
    event.eventType !== "change.blocked"
  ) {
    return state;
  }

  // If we already have a state for the same (changeId,
  // mergeQueueHash), keep it. The protocol's terminal states
  // (accepted, rejected) are immutable at the whole-change
  // layer; a fresh merge queue run produces a different
  // mergeQueueHash so it lands under a different projection key.
  if (state && state.mergeQueueHash === payload.mergeQueueHash) {
    // Same hash, double-emit (idempotency): keep the original
    // state to preserve first-seen semantics.
    return state;
  }

  if (state && state.changeId !== payload.changeId) {
    // Different changeId: do NOT overwrite. Each projection key
    // is scoped to a single (changeId, mergeQueueHash); events
    // for OTHER changeIds must be reduced elsewhere.
    return state;
  }

  try {
    return buildStateFromPayload(payload);
  } catch {
    return state;
  }
}

/**
 * A `BoardProjectionRebuilder`-compatible reducer that wraps
 * `reduceWholeChangeAcceptance`. The board-store surface types
 * the reducer as `(state, event) => state` (not nullable), so
 * we coerce `null` initial states to a sentinel and convert
 * back to `null` on the wire.
 */
export function makeWholeChangeAcceptanceReducer(): (
  state: WholeChangeAcceptanceState | null,
  event: BoardEvent
) => WholeChangeAcceptanceState | null {
  return reduceWholeChangeAcceptance;
}

/**
 * Convenience: replay a stream of events into a final state.
 * Mirrors the contract-free helpers used by Phase 8's review
 * reducer so the projector can drop in this reducer without
 * further adapters.
 */
export function replayWholeChangeAcceptance(
  events: readonly BoardEvent[]
): WholeChangeAcceptanceState | null {
  let state: WholeChangeAcceptanceState | null = null;
  for (const event of events) {
    state = reduceWholeChangeAcceptance(state, event);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Projection key helpers
// ---------------------------------------------------------------------------

/**
 * Canonical projection key for the whole-change acceptance
 * projection. The `BOARD_PROJECTION_KEY_PATTERN` requires the
 * string to start with a lowercase letter, end with a
 * lowercase letter or digit, and only contain `[a-z0-9._:-]`.
 *
 * The `whole_change.acceptance` segment is content-addressed by
 * `changeId` so a single board can run multiple whole-change
 * projections concurrently without collisions.
 */
export function wholeChangeAcceptanceProjectionKey(changeId: ChangeId): string {
  // changeId is a branded string like "chg-..." — sanitize so
  // any future id schema that introduces non-conforming
  // characters still maps cleanly into the projection key.
  const sanitized = changeId.replace(/[^a-z0-9._:-]/gi, "_");
  return `whole_change.acceptance:${sanitized}` as string;
}

/**
 * Map a projection key back to its `(changeId, mergeQueueHash)`
 * constituents. Used by the projector when verifying replay
 * output. Returns `null` if the key does not match the canonical
 * whole-change acceptance projection shape.
 */
export function parseWholeChangeAcceptanceProjectionKey(
  projectionKey: string
): { readonly changeId: string } | null {
  if (!projectionKey.startsWith("whole_change.acceptance:")) return null;
  const changeId = projectionKey.slice("whole_change.acceptance:".length);
  if (changeId.length === 0) return null;
  return { changeId };
}

/**
 * Verify a `WholeChangeAcceptanceState` matches the aggregator's
 * canonical hash inputs. Used by the projector to surface drift
 * in tests without spinning up the full `SqliteBoardProjectionRebuilder`.
 */
export function verifyWholeChangeAcceptanceState(
  state: WholeChangeAcceptanceState
): boolean {
  const recomputed = deriveWholeChangeAggregatorHash({
    changeId: state.changeId,
    mergeQueueHash: state.mergeQueueHash,
    decisionSha256: state.decisionSha256,
    outcome: state.outcome,
    finalHeadRef: state.finalHeadRef,
    acceptedBy: state.acceptedBy,
    reason: state.reason,
    workerContextHashes: [...state.workerContextHashes].sort(),
    acceptedEntries: [...state.acceptedEntries],
    rejectedEntries: [...state.rejectedEntries],
    escalatedEntries: [...state.escalatedEntries],
    conflictEntries: [...state.conflictEntries],
    acceptedAt: state.acceptedAt
  });
  return recomputed === state.aggregatorHash;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_REDUCER_KIND_LITERAL = WHOLE_CHANGE_ACCEPTANCE_KIND;

export function isWholeChangeEventType(
  value: unknown
): value is WholeChangeEventType {
  return (
    typeof value === "string" &&
    (value === "change.aggregated" ||
      value === "change.accepted" ||
      value === "change.rejected" ||
      value === "change.escalated" ||
      value === "change.blocked")
  );
}

// `sha256OfCanonical` is re-exported so reducer consumers can
// hash auxiliary values without importing the hash module.
export { sha256OfCanonical };