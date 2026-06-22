/**
 * P11-T01 — Dashboard projection hash helpers.
 *
 * The dashboard projection state hash is a content-addressed
 * SHA-256 digest over the canonical JSON projection of
 * `DashboardProjectionState`. It mirrors the
 * `deriveWholeChangeProjectionStateHash` (P09-T02) and
 * `deriveReleaseObservationProjectionStateHash` (P10-T01)
 * shape so the SQLite projector can detect drift without
 * re-running the reducer.
 *
 * Hash inputs:
 *   - schemaVersion
 *   - kind
 *   - projectId
 *   - eventCount
 *   - taskStatusCounts (sorted by status)
 *   - aggregateKindCounts (sorted by aggregate kind)
 *   - releaseObservationPointers (sorted by mergeQueueHash)
 *   - approvalPointers (sorted by changeId, then globalSequence)
 *   - eventTimeline (sorted by globalSequence)
 *
 * The hash is returned with the canonical `sha256:<64-hex>`
 * prefix used throughout the Phase 9/10 ledger. The SQLite
 * projector strips the prefix before persisting.
 */

import { createHash } from "node:crypto";

import type {
  DashboardProjectionState,
  DashboardEventTailEntry,
  DashboardReleaseObservationPointer,
  DashboardApprovalPointer
} from "./contract.js";

/**
 * Canonical JSON serializer. Object keys are sorted
 * recursively so equal content produces equal bytes.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => canonicalize(entry)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          canonicalize((value as Record<string, unknown>)[key])
      )
      .join(",") +
    "}"
  );
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256ContentHash(payload: string): string {
  return `sha256:${sha256Hex(payload)}`;
}

function sortedTaskStatusCounts(
  state: DashboardProjectionState
): Readonly<Record<string, number>> {
  const entries = Object.entries(state.taskStatusCounts).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  return Object.fromEntries(entries);
}

function sortedAggregateKindCounts(
  state: DashboardProjectionState
): Readonly<Record<string, number>> {
  const entries = Object.entries(state.aggregateKindCounts).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  return Object.fromEntries(entries);
}

function sortedReleasePointers(
  pointers: readonly DashboardReleaseObservationPointer[]
): readonly DashboardReleaseObservationPointer[] {
  return [...pointers].sort((a, b) => {
    if (a.changeId !== b.changeId) return a.changeId < b.changeId ? -1 : 1;
    if (a.mergeQueueHash !== b.mergeQueueHash)
      return a.mergeQueueHash < b.mergeQueueHash ? -1 : 1;
    return a.globalSequence - b.globalSequence;
  });
}

function sortedApprovalPointers(
  pointers: readonly DashboardApprovalPointer[]
): readonly DashboardApprovalPointer[] {
  return [...pointers].sort((a, b) => {
    if (a.changeId !== b.changeId) return a.changeId < b.changeId ? -1 : 1;
    return a.lastGlobalSequence - b.lastGlobalSequence;
  });
}

function sortedTimeline(
  timeline: readonly DashboardEventTailEntry[]
): readonly DashboardEventTailEntry[] {
  return [...timeline].sort((a, b) => a.globalSequence - b.globalSequence);
}

/**
 * Compute the canonical hash of a `DashboardProjectionState`.
 *
 * Returns `sha256:<64-hex>`.
 *
 * Special cases:
 *   - `state === null` returns the canonical "empty hash"
 *     (`sha256:` + 64 zeros) so projectors can compare a
 *     not-yet-built projection against a fresh replay that
 *     yields an empty state (e.g. when the projection key has
 *     no events and the dashboard reducer returns the
 *     initial-state shell).
 */
export function deriveDashboardProjectionStateHash(
  state: DashboardProjectionState | null
): `sha256:${string}` {
  if (state === null) {
    return `sha256:${"0".repeat(64)}` as `sha256:${string}`;
  }

  const canonical = canonicalize({
    schemaVersion: state.schemaVersion,
    kind: state.kind,
    projectId: state.projectId,
    rebuiltThroughGlobalSequence: state.rebuiltThroughGlobalSequence,
    eventCount: state.eventCount,
    taskStatusCounts: sortedTaskStatusCounts(state),
    aggregateKindCounts: sortedAggregateKindCounts(state),
    releaseObservationPointers: sortedReleasePointers(
      state.releaseObservationPointers
    ),
    approvalPointers: sortedApprovalPointers(state.approvalPointers),
    eventTimeline: sortedTimeline(state.eventTimeline)
  });

  return sha256ContentHash(canonical) as `sha256:${string}`;
}

/**
 * Generic helper exposed for tests so they can compute the
 * canonical hash of arbitrary dashboard-shaped input without
 * needing the `DashboardProjectionState` runtime type.
 */
export function sha256OfCanonicalDashboardInput(
  value: unknown
): `sha256:${string}` {
  return sha256ContentHash(canonicalize(value)) as `sha256:${string}`;
}