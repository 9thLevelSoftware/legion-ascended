/**
 * P11-T01 — Approval-gate projection contract.
 *
 * The approval-gate is the per-`(projectId, changeId)` read
 * surface that ties together the Phase 9 whole-change
 * acceptance verdict and the Phase 10 release-observation
 * verdict into a single operator-facing
 * `ApprovalGateVerdict`. It is the canonical "can this
 * change ship?" projection promised by the Phase 11
 * Kanban manifest.
 *
 * Verdict rules (fail-closed):
 *
 *  - `approved`  → the change has a `change.aggregated`
 *                  payload with `status=accepted` AND a
 *                  `release.promoted` event for the same
 *                  `(changeId, mergeQueueHash)` AND no
 *                  regressed/rolled-back event with the
 *                  same `(changeId, mergeQueueHash)`.
 *  - `rejected`  → the change has a `change.rejected` /
 *                  `change.aggregated(status=rejected)` or
 *                  a `release.regressed` / `release.rolled_back`
 *                  event after the change.aggregated event.
 *  - `blocked`   → the change has a `change.blocked` /
 *                  `change.escalated` event OR an
 *                  aggregated status of `blocked` (no
 *                  rejection, but the merge gate failed).
 *  - `pending`   → otherwise (no terminal verdict yet).
 *
 * The approval-gate is *project-scoped* and *change-scoped*,
 * so the projection key is `approval-gate:<projectId>:<changeId>`.
 * Each changeId gets exactly one projection; the operator can
 * inspect the gate via `legion next board approval-gate status`.
 *
 * Why this lives in `@legion/board` (not `@legion/core`):
 *  - The approval-gate is a *projection* over board events.
 *    It does not orchestrate anything; it derives read-only
 *    state from the same audit trail that the P09-T02
 *    whole-change and P10-T01 release-observation adapters
 *    already consume.
 *  - Mirrors the P09-T02 / P10-T01 layering: core stays
 *    provider-neutral (no event log reads); board owns the
 *    logical aggregation/reduction over board events.
 */

import type {
  ChangeId,
  ContentHash,
  ProjectId,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type { BoardEvent, BoardEventType } from "@legion/board-store";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const APPROVAL_GATE_ADAPTER_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const APPROVAL_GATE_ADAPTER_KIND = "approval-gate-adapter" as const;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export const APPROVAL_GATE_VERDICTS = [
  "approved",
  "rejected",
  "blocked",
  "pending"
] as const;

export type ApprovalGateVerdict = (typeof APPROVAL_GATE_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Identity + projection key
// ---------------------------------------------------------------------------

export interface ApprovalGateAggregateId {
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
}

export const APPROVAL_GATE_PROJECTION_KEY_PREFIX = "approval-gate" as const;

/**
 * Canonical projection key for the approval-gate projection.
 * Sanitizes the projectId/changeId segments so any future id
 * schema that introduces non-conforming characters still
 * maps cleanly into the projection key.
 */
export function approvalGateProjectionKey(
  projectId: ProjectId,
  changeId: ChangeId
): string {
  const projectSegment = projectId.replace(/[^a-z0-9._:-]/gi, "_");
  const changeSegment = changeId.replace(/[^a-z0-9._:-]/gi, "_");
  return `approval-gate:${projectSegment}:${changeSegment}` as string;
}

/**
 * Inverse of `approvalGateProjectionKey`. Returns `null` if
 * the key does not match the canonical approval-gate shape.
 */
export function parseApprovalGateProjectionKey(
  projectionKey: string
): { readonly projectId: string; readonly changeId: string } | null {
  if (!projectionKey.startsWith("approval-gate:")) return null;
  const rest = projectionKey.slice("approval-gate:".length);
  const colonAt = rest.indexOf(":");
  if (colonAt <= 0 || colonAt === rest.length - 1) return null;
  const projectId = rest.slice(0, colonAt);
  const changeId = rest.slice(colonAt + 1);
  return { projectId, changeId };
}

// ---------------------------------------------------------------------------
// Approval-gate projection state
// ---------------------------------------------------------------------------

/**
 * The frozen approval-gate projection state for a single
 * `(projectId, changeId)` pair. Operators consume this
 * through `legion next board approval-gate status` and the
 * JSON output surfaces the verdict, the trace-back hashes,
 * and the underlying whole-change + release-observation
 * pointers.
 */
export interface ApprovalGateProjectionState {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof APPROVAL_GATE_ADAPTER_KIND;
  readonly projectId: ProjectId;
  readonly changeId: ChangeId;
  readonly verdict: ApprovalGateVerdict;
  readonly mergeQueueHash: ContentHash | null;
  readonly decisionSha256: ContentHash | null;
  readonly aggregatorHash: ContentHash | null;
  readonly releaseObservationReportSha256: ContentHash | null;
  readonly releaseObservationStatus:
    | "observing"
    | "promoted"
    | "regressed"
    | "rolled_back"
    | "absent";
  readonly lastEventType: BoardEventType | null;
  readonly lastGlobalSequence: number;
  readonly lastOccurredAt: UtcTimestamp | null;
  readonly reason: string;
  readonly eventCount: number;
  readonly wholeChangeStatus: "accepted" | "rejected" | "blocked" | "absent";
  readonly wholeChangeOutcome: "integrated" | "rejected" | "escalated" | "blocked" | "absent";
}

// ---------------------------------------------------------------------------
// Reducer surface
// ---------------------------------------------------------------------------

/**
 * Reducer signature for the approval-gate projection. Mirrors
 * the P09-T02 / P10-T01 reducer shape so the descriptor can
 * drop into `SqliteBoardProjectionRebuilder` unchanged.
 */
export type ApprovalGateReducer = (
  state: ApprovalGateProjectionState | null,
  event: BoardEvent
) => ApprovalGateProjectionState | null;

export interface ApprovalGateProjectionDescriptor {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: ApprovalGateProjectionState | null;
  readonly reduce: ApprovalGateReducer;
}

export const APPROVAL_GATE_PROJECTION_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation
// ---------------------------------------------------------------------------

export const APPROVAL_GATE_ADAPTER_KEYS = [
  "schemaVersion",
  "kind",
  "projectId",
  "changeId",
  "verdict",
  "mergeQueueHash",
  "decisionSha256",
  "aggregatorHash",
  "releaseObservationReportSha256",
  "releaseObservationStatus",
  "lastEventType",
  "lastGlobalSequence",
  "lastOccurredAt",
  "reason",
  "eventCount",
  "wholeChangeStatus",
  "wholeChangeOutcome",
  "stateHash"
] as const;

export type ApprovalGateAdapterKey =
  (typeof APPROVAL_GATE_ADAPTER_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Allocate a fresh approval-gate projection state for the
 * given `(projectId, changeId)` pair. Mirrors the dashboard
 * initializer.
 */
export function makeInitialApprovalGateState(
  projectId: ProjectId,
  changeId: ChangeId
): ApprovalGateProjectionState {
  return {
    schemaVersion: APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
    kind: APPROVAL_GATE_ADAPTER_KIND,
    projectId,
    changeId,
    verdict: "pending",
    mergeQueueHash: null,
    decisionSha256: null,
    aggregatorHash: null,
    releaseObservationReportSha256: null,
    releaseObservationStatus: "absent",
    lastEventType: null,
    lastGlobalSequence: -1,
    lastOccurredAt: null,
    reason: "",
    eventCount: 0,
    wholeChangeStatus: "absent",
    wholeChangeOutcome: "absent"
  };
}

/**
 * Validate that an incoming state has the canonical
 * approval-gate shape. Exposed so the projector can detect
 * drift and so callers (CLI, tests) can validate third-party
 * projections.
 */
export function isApprovalGateProjectionState(
  value: unknown
): value is ApprovalGateProjectionState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== APPROVAL_GATE_ADAPTER_KIND) return false;
  if (typeof record["projectId"] !== "string") return false;
  if (typeof record["changeId"] !== "string") return false;
  if (typeof record["verdict"] !== "string") return false;
  if (
    record["verdict"] !== "approved" &&
    record["verdict"] !== "rejected" &&
    record["verdict"] !== "blocked" &&
    record["verdict"] !== "pending"
  ) {
    return false;
  }
  if (typeof record["eventCount"] !== "number") return false;
  if (typeof record["lastGlobalSequence"] !== "number") return false;
  return true;
}

// Re-export BoardEventType so reducer consumers don't need to
// import the board-store module separately when shaping input.
export type { BoardEvent, BoardEventType };
export type { ChangeId, ContentHash, ProjectId, SchemaVersion, UtcTimestamp };