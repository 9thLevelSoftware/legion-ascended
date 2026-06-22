/**
 * P10-T01 — Pure release-observation reducer + projection helpers.
 *
 * Mirrors the P09-T02 whole-change reducer: a pure function
 * that takes the current `ReleaseObservationProjectionState |
 * null` and one `BoardEvent`, returns the next state. No IO,
 * no clock reads. The reducer ignores foreign events (events
 * whose `aggregateKind !== "release_observation"` or whose
 * `eventType` is not in the release-observation board event
 * allowlist) so the projection can be replayed alongside
 * other aggregates without interference.
 *
 * The reducer is also a "replay" helper that walks an array
 * of `BoardEvent` values and returns the final state. The
 * projector in `@legion/store-sqlite` wires the reducer into
 * `SqliteBoardProjectionRebuilder` so the projection can be
 * persisted, replayed, and verified.
 */

import type { BoardEvent } from "@legion/board-store";

import { RELEASE_OBSERVATION_KIND } from "@legion/core";

import {
  RELEASE_OBSERVATION_ADAPTER_KIND,
  type ReleaseObservationProjectionDescriptor,
  type ReleaseObservationProjectionState,
  type ReleaseObservationReducer
} from "./contract.js";

import {
  deriveReleaseObservationProjectionStateHash,
  RELEASE_OBSERVATION_ADAPTER_HASH_VERSION
} from "./hash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RELEASE_OBSERVATION_BOARD_EVENT_TYPES: ReadonlySet<string> = new Set([
  "release.observing",
  "release.observed",
  "release.promoted",
  "release.regressed",
  "release.rolled_back"
]);

const REDUCER_KIND_LITERAL = "release-observation-reducer" as const;

export const RELEASE_OBSERVATION_REDUCER_KIND_LITERAL = REDUCER_KIND_LITERAL;

export const RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX =
  "release-observation:" as const;

export const RELEASE_OBSERVATION_PROJECTION_VERSION = 1;

function isContentHash(value: unknown): value is import("@legion/protocol").ContentHash {
  return (
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function isReleaseObservationBoardEvent(event: BoardEvent): boolean {
  if (event.aggregateKind !== "release_observation") return false;
  return RELEASE_OBSERVATION_BOARD_EVENT_TYPES.has(event.eventType);
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

function parseObservedAt(occurredAt: string): import("@legion/protocol").UtcTimestamp {
  return occurredAt as unknown as import("@legion/protocol").UtcTimestamp;
}

function buildStateFromPayload(
  event: BoardEvent
): ReleaseObservationProjectionState | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const mergeQueueHash = payload["mergeQueueHash"];
  const reportSha256 = payload["reportSha256"];
  const decisionSha256 = payload["decisionSha256"];
  const changeId = payload["changeId"];
  if (
    !isContentHash(mergeQueueHash) ||
    !isContentHash(reportSha256) ||
    !isContentHash(decisionSha256) ||
    typeof changeId !== "string"
  ) {
    return null;
  }
  const report = payload["report"];
  if (!report || typeof report !== "object") {
    return null;
  }
  return deepFreeze({
    schemaVersion: RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION_FROZEN,
    kind: RELEASE_OBSERVATION_ADAPTER_KIND,
    changeId: changeId as import("@legion/protocol").ChangeId,
    mergeQueueHash,
    reportSha256,
    decisionSha256,
    report: report as unknown as import("@legion/core").ReleaseObservationReport,
    lastEventType: event.eventType as unknown as import("@legion/core").ReleaseObservationEventType,
    lastObservedAt: parseObservedAt(event.occurredAt),
    observedBy:
      typeof payload["observedBy"] === "object" &&
      payload["observedBy"] !== null &&
      "id" in (payload["observedBy"] as Record<string, unknown>) &&
      typeof (payload["observedBy"] as { id?: unknown }).id === "string"
        ? ((payload["observedBy"] as { id: string }).id)
        : "unknown",
    reportCount: 1
  });
}

// We re-export the schema version constant locally to avoid a
// second import line in the frozen-typed state builder.
import { RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION as RELEASE_OBSERVATION_ADAPTER_SCHEMA_VERSION_FROZEN } from "./contract.js";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function isReleaseObservationEventType(
  eventType: string
): boolean {
  return RELEASE_OBSERVATION_BOARD_EVENT_TYPES.has(eventType);
}

export const reduceReleaseObservation: ReleaseObservationReducer = (
  state,
  event
) => {
  if (!isReleaseObservationBoardEvent(event)) {
    return state;
  }
  const next = buildStateFromPayload(event);
  if (next === null) return state;
  return next;
};

export function makeReleaseObservationReducer(): ReleaseObservationReducer {
  return reduceReleaseObservation;
}

/**
 * Replay a list of `BoardEvent` values into a single
 * `ReleaseObservationProjectionState | null`. Foreign events
 * are silently skipped; release-observation events are
 * applied in `globalSequence` order.
 */
export function replayReleaseObservation(
  events: readonly BoardEvent[]
): ReleaseObservationProjectionState | null {
  let state: ReleaseObservationProjectionState | null = null;
  for (const event of events) {
    state = reduceReleaseObservation(state, event);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Projection key helpers
// ---------------------------------------------------------------------------

export function releaseObservationProjectionKey(
  changeId: import("@legion/protocol").ChangeId,
  mergeQueueHash: import("@legion/protocol").ContentHash
): string {
  return `${RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX}${changeId}:${mergeQueueHash}`;
}

export function isReleaseObservationProjectionKey(
  projectionKey: string
): boolean {
  return projectionKey.startsWith(RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX);
}

export function parseReleaseObservationProjectionKey(
  projectionKey: string
): {
  readonly changeId: import("@legion/protocol").ChangeId;
  readonly mergeQueueHash: import("@legion/protocol").ContentHash;
} | null {
  if (!isReleaseObservationProjectionKey(projectionKey)) return null;
  const rest = projectionKey.slice(RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return null;
  const changeId = rest.slice(0, firstColon);
  const mergeQueueHash = rest.slice(firstColon + 1);
  if (
    !isContentHash(mergeQueueHash) ||
    changeId.length === 0
  ) {
    return null;
  }
  return {
    changeId: changeId as import("@legion/protocol").ChangeId,
    mergeQueueHash
  };
}

// ---------------------------------------------------------------------------
// Projection descriptor
// ---------------------------------------------------------------------------

export const releaseObservationProjectionDescriptor: ReleaseObservationProjectionDescriptor = {
  projectionKey: RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX,
  projectionVersion: RELEASE_OBSERVATION_PROJECTION_VERSION,
  initialState: null,
  reduce: reduceReleaseObservation
};

// ---------------------------------------------------------------------------
// State hash helper — content-addressed hash of the projection state
// ---------------------------------------------------------------------------

export {
  deriveReleaseObservationProjectionStateHash,
  RELEASE_OBSERVATION_ADAPTER_HASH_VERSION
};

// Make sure the schema-version constant and the hash version are
// in sync; we surface the version via the descriptor so consumers
// can pin a single audit value.
export const RELEASE_OBSERVATION_REDUCER_KIND = REDUCER_KIND_LITERAL;

// Suppress unused warning — RELEASE_OBSERVATION_KIND from core is
// kept here so future refactors can pin the core vs adapter
// discriminator without re-importing.
export const _RELEASE_OBSERVATION_CORE_KIND_PIN = RELEASE_OBSERVATION_KIND;
