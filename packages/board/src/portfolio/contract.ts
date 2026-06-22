/**
 * P11-T02 — Portfolio projection contract.
 *
 * The portfolio projection is the *cross-project* read
 * surface for the Phase 11 multi-project operator work
 * promised by the kanban manifest. P11-T01 shipped a
 * project-scoped dashboard; P11-T02 layers a tenant-scoped
 * portfolio view on top of the same board event log so a
 * multi-project board operator can answer:
 *
 *   - Which projects are running, blocked, queued, or
 *     completed? (portfolio status counts)
 *   - What is the latest release-observation verdict for
 *     every change in scope? (portfolio release pointers)
 *   - What is the latest approval-gate verdict for every
 *     change in scope? (portfolio approval pointers)
 *   - Which tasks in project A depend on tasks in project
 *     B, and vice versa? (cross-project dependency edges)
 *   - Where is the operator's capacity being spent?
 *     (resource allocation ledger: priority sums, claimed
 *     counts, blocked counts)
 *
 * Why this lives in `@legion/board` (not `@legion/core`):
 *  - Mirrors the P11-T01 dashboard layering. The portfolio
 *    is a *projection* over board events. It does not
 *    orchestrate anything; it derives read-only state from
 *    the same audit trail that the P09-T02 whole-change,
 *    P10-T01 release-observation, and P11-T01 dashboard
 *    adapters already consume.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - The portfolio is the first *tenant-scoped* projection:
 *    it consumes `task.*`, `change.*`, `release.*`,
 *    `task_link.*`, and `claim.*` events across every
 *    `projectId` in scope. That is materially different
 *    from the P11-T01 dashboard (per-projectId), the
 *    P09-T02 whole-change (per changeId), and the P10-T01
 *    release-observation (per changeId+mergeQueueHash)
 *    projections, so the portfolio gets its own key
 *    namespace `portfolio:<tenantId>`.
 *
 * Portfolio invariants:
 *  1. The portfolio projection is *tenant-scoped*: one
 *     projection key per `tenantId`. A multi-tenant board
 *     operator can host multiple portfolio projections in
 *     parallel without collisions.
 *  2. Reducer is pure: same event log ⇒ same portfolio
 *     state. Foreign events (wrong aggregateKind /
 *     aggregateId / eventType / unknown projectId) are
 *     ignored silently so an interleaved board event log
 *     never throws.
 *  3. The portfolio never mutates frozen dashboard,
 *     whole-change, or release-observation state. It
 *     derives cross-project counts, dependency edges, and
 *     resource ledgers from the append-only log.
 *  4. The reducer exposes a content-addressed
 *     `PortfolioProjectionStateHash` so the SQLite
 *     projector can detect drift without re-running the
 *     reducer.
 *  5. The portfolio module never imports a runtime driver,
 *     git, eve, board-store (only types), or `node:sqlite`.
 *     Those belong to `@legion/store-sqlite` and the CLI
 *     adapter layer.
 *  6. The portfolio key includes the optional
 *     `projectIds` scope filter in its hash inputs (not
 *     in its key shape) so the same tenant can host
 *     sub-portfolios without leaking state across scope
 *     boundaries.
 */

import type {
  ContentHash,
  ProjectId,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type { BoardEvent, BoardEventType } from "@legion/board-store";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const PORTFOLIO_ADAPTER_SCHEMA_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

export const PORTFOLIO_ADAPTER_KIND = "portfolio-adapter" as const;

// ---------------------------------------------------------------------------
// Tenant scoping + projection key
// ---------------------------------------------------------------------------

/**
 * Tenant identity. The portfolio is keyed by tenant — a
 * multi-tenant board host can run multiple portfolios in
 * parallel by isolating the `tenantId` slot. `TenantId` is
 * a structural brand over `string` (no schema); the
 * portfolio reducer treats it as an opaque identifier and
 * never reaches into process state to interpret it.
 */
export interface PortfolioAggregateId {
  readonly tenantId: TenantId;
}

export type TenantId = string & { readonly __brand: "TenantId" };

/**
 * Helper to coerce a raw string into a branded `TenantId`.
 * The brand is purely structural; the reducer + projector
 * never reach into process state.
 */
export function asTenantId(value: string): TenantId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tenantId must be a non-empty string");
  }
  return value as TenantId;
}

export const PORTFOLIO_PROJECTION_KEY_PREFIX = "portfolio" as const;

/**
 * Canonical projection key for the portfolio projection.
 * Mirrors the P11-T01 dashboard shape
 * (`<prefix>:<projectId>` → `<prefix>:<tenantId>`) and
 * conforms to `BOARD_PROJECTION_KEY_PATTERN` (lowercase
 * start/end, `[a-z0-9._:-]` only).
 */
export function portfolioProjectionKey(tenantId: TenantId): string {
  const sanitized = String(tenantId).replace(/[^a-z0-9._:-]/gi, "_");
  return `portfolio:${sanitized}` as string;
}

/**
 * Inverse of `portfolioProjectionKey`. Returns `null` if
 * the key does not match the canonical portfolio projection
 * shape.
 */
export function parsePortfolioProjectionKey(
  projectionKey: string
): { readonly tenantId: string } | null {
  if (!projectionKey.startsWith("portfolio:")) return null;
  const tenantId = projectionKey.slice("portfolio:".length);
  if (tenantId.length === 0) return null;
  return { tenantId };
}

// ---------------------------------------------------------------------------
// Project scope filter (optional sub-portfolio)
// ---------------------------------------------------------------------------

/**
 * Optional scope filter for the portfolio projection. When
 * the operator passes a `projectIds` list, the reducer
 * drops events for projects not in the list and exposes the
 * scope in the public state so callers can verify what was
 * actually reduced. When `scope` is null, the portfolio
 * spans every project the tenant has events for.
 *
 * `PortfolioScope` is provided to the reducer as a
 * `ReadonlySet` for cheap membership checks; the public
 * projection state exposes the same scope as a frozen
 * array under the `scope` key so the JSON output stays
 * stable and serialized scopes round-trip identically.
 */
export type PortfolioScope = ReadonlySet<ProjectId> | null;

export function portfolioScopeFromList(
  projectIds: readonly ProjectId[]
): PortfolioScope {
  if (!projectIds || projectIds.length === 0) return null;
  return new Set<ProjectId>(projectIds);
}

// ---------------------------------------------------------------------------
// Per-project rollup
// ---------------------------------------------------------------------------

/**
 * The set of board event aggregate kinds the portfolio
 * reducer counts. Other kinds (e.g. `outbox`,
 * `task_run`) are not part of the rollup because they do
 * not change operator-facing state.
 */
export const PORTFOLIO_ROLLUP_AGGREGATE_KINDS = [
  "task",
  "task_link",
  "claim",
  "approval",
  "whole_change",
  "release_observation"
] as const;

export type PortfolioRollupAggregateKind =
  (typeof PORTFOLIO_ROLLUP_AGGREGATE_KINDS)[number];

/**
 * Per-project portfolio summary. Mirrors the P11-T01
 * dashboard task-status surface but bounded to one project.
 */
export interface PortfolioProjectRollup {
  readonly projectId: ProjectId;
  readonly taskStatusCounts: Readonly<Record<string, number>>;
  readonly aggregateKindCounts: Readonly<Record<string, number>>;
  readonly taskCount: number;
  readonly terminalTaskCount: number;
  readonly activeTaskCount: number;
  readonly blockedTaskCount: number;
  readonly totalPriority: number;
  readonly maxPriority: number;
  readonly priorityBands: Readonly<Record<PortfolioPriorityBand, number>>;
  readonly claimedTaskCount: number;
  readonly lastEventType: BoardEventType | null;
  readonly lastGlobalSequence: number;
  readonly lastOccurredAt: UtcTimestamp | null;
  readonly lastReleaseObservationStatus: BoardEventType | null;
  readonly lastApprovalVerdict: string | null;
}

// ---------------------------------------------------------------------------
// Cross-project dependency edge
// ---------------------------------------------------------------------------

export const PORTFOLIO_DEPENDENCY_RELATIONS = [
  "depends_on",
  "blocks"
] as const;

export type PortfolioDependencyRelation =
  (typeof PORTFOLIO_DEPENDENCY_RELATIONS)[number];

/**
 * A directed cross-project dependency edge. The portfolio
 * only surfaces edges that touch *two different projects*
 * because within-project edges are already covered by the
 * P11-T01 dashboard.
 */
export interface PortfolioDependencyEdge {
  readonly relation: PortfolioDependencyRelation;
  readonly fromProjectId: ProjectId;
  readonly fromTaskId: string;
  readonly toProjectId: ProjectId;
  readonly toTaskId: string;
  readonly firstObservedAt: UtcTimestamp;
  readonly lastObservedAt: UtcTimestamp;
  readonly lastGlobalSequence: number;
  readonly eventCount: number;
}

// ---------------------------------------------------------------------------
// Resource allocation ledger
// ---------------------------------------------------------------------------

/**
 * Resource allocation surface. The portfolio reducer
 * exposes three slices so the operator can decide where
 * capacity is being spent:
 *
 *  - `priorityBands`: how many tasks in each
 *    `(projectId, band)` bucket. Bands are coarse
 *    (high ≥ 750, mid 250..749, low 0..249) so the output
 *    stays compact for a portfolio view.
 *  - `claimUtilization`: per-project claim saturation
 *    (claimed / active tasks).
 *  - `blockedPressure`: per-project blocked task counts
 *    and the most-recent blocker reason surfaced in the
 *    event log.
 */
export const PORTFOLIO_PRIORITY_BANDS = ["high", "mid", "low"] as const;
export type PortfolioPriorityBand = (typeof PORTFOLIO_PRIORITY_BANDS)[number];

export interface PortfolioResourceLedger {
  readonly priorityBands: Readonly<Record<PortfolioPriorityBand, number>>;
  readonly priorityBandsByProject: Readonly<
    Record<ProjectId, Readonly<Record<PortfolioPriorityBand, number>>>
  >;
  readonly claimUtilizationByProject: Readonly<Record<ProjectId, number>>;
  readonly blockedPressureByProject: Readonly<Record<ProjectId, number>>;
}

// ---------------------------------------------------------------------------
// Portfolio projection state
// ---------------------------------------------------------------------------

/**
 * The frozen portfolio projection state for a single
 * `(tenantId)` slice. Operators consume this through
 * `legion next board portfolio status` and the JSON output
 * surfaces the rollups, dependency edges, and resource
 * ledger so any external UI can render a multi-project
 * board view.
 */
export interface PortfolioProjectionState {
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof PORTFOLIO_ADAPTER_KIND;
  readonly tenantId: TenantId;
  readonly scope: readonly ProjectId[];
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly projectRollups: Readonly<Record<ProjectId, PortfolioProjectRollup>>;
  readonly dependencyEdges: readonly PortfolioDependencyEdge[];
  readonly resourceLedger: PortfolioResourceLedger;
  readonly crossProjectDependencyCount: number;
  readonly terminalProjectCount: number;
}

// ---------------------------------------------------------------------------
// Reducer surface
// ---------------------------------------------------------------------------

/**
 * Reducer signature for the portfolio projection. Mirrors
 * the P11-T01 dashboard reducer shape so the descriptor
 * can drop into `SqliteBoardProjectionRebuilder` unchanged.
 */
export type PortfolioReducer = (
  state: PortfolioProjectionState | null,
  event: BoardEvent,
  options?: ReducePortfolioOptions
) => PortfolioProjectionState | null;

/**
 * Options accepted by `reducePortfolio` (mirrors
 * `ReduceDashboardOptions` from the P11-T01 dashboard
 * reducer). Defined here in the contract so the reducer's
 * type signature can reference it without a circular
 * dependency on the reducer module.
 */
export interface ReducePortfolioOptions {
  readonly tenantId?: TenantId;
  readonly scope?: PortfolioScope;
  readonly priorEvents?: readonly import("@legion/board-store").BoardEvent[];
}

export interface PortfolioProjectionDescriptor {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly initialState: PortfolioProjectionState | null;
  readonly reduce: PortfolioReducer;
}

export const PORTFOLIO_PROJECTION_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Allowlist for fresh-context isolation
// ---------------------------------------------------------------------------

export const PORTFOLIO_ADAPTER_KEYS = [
  "schemaVersion",
  "kind",
  "tenantId",
  "scope",
  "rebuiltThroughGlobalSequence",
  "eventCount",
  "projectRollups",
  "dependencyEdges",
  "resourceLedger",
  "crossProjectDependencyCount",
  "terminalProjectCount",
  "stateHash"
] as const;

export type PortfolioAdapterKey = (typeof PORTFOLIO_ADAPTER_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Allocate a fresh portfolio projection state for the given
 * tenant + scope. Mirrors `makeInitialDashboardState`
 * (P11-T01) and `makeInitialApprovalGateState` (P11-T01).
 */
export function makeInitialPortfolioState(
  tenantId: TenantId,
  scope: PortfolioScope = null
): PortfolioProjectionState {
  const projectRollups: Record<ProjectId, PortfolioProjectRollup> = {};
  const priorityBandsByProject: Record<
    ProjectId,
    Record<PortfolioPriorityBand, number>
  > = {};
  const claimUtilizationByProject: Record<ProjectId, number> = {};
  const blockedPressureByProject: Record<ProjectId, number> = {};
  if (scope) {
    for (const projectId of scope) {
      projectRollups[projectId] = emptyProjectRollup(projectId);
      priorityBandsByProject[projectId] = emptyPriorityBands();
      claimUtilizationByProject[projectId] = 0;
      blockedPressureByProject[projectId] = 0;
    }
  }
  const scopeSnapshot = scope ? Object.freeze(Array.from(scope)) : null;
  return Object.freeze({
    schemaVersion: PORTFOLIO_ADAPTER_SCHEMA_VERSION,
    kind: PORTFOLIO_ADAPTER_KIND,
    tenantId,
    scope: (scopeSnapshot ?? Object.freeze([])) as readonly ProjectId[],
    rebuiltThroughGlobalSequence: -1,
    eventCount: 0,
    projectRollups: Object.freeze(projectRollups),
    dependencyEdges: Object.freeze([]),
    resourceLedger: Object.freeze({
      priorityBands: Object.freeze(emptyPriorityBands()),
      priorityBandsByProject: Object.freeze(priorityBandsByProject),
      claimUtilizationByProject: Object.freeze(claimUtilizationByProject),
      blockedPressureByProject: Object.freeze(blockedPressureByProject)
    }),
    crossProjectDependencyCount: 0,
    terminalProjectCount: 0
  }) as PortfolioProjectionState;
}

function emptyProjectRollup(projectId: ProjectId): PortfolioProjectRollup {
  return Object.freeze({
    projectId,
    taskStatusCounts: Object.freeze({}),
    aggregateKindCounts: Object.freeze({}),
    taskCount: 0,
    terminalTaskCount: 0,
    activeTaskCount: 0,
    blockedTaskCount: 0,
    totalPriority: 0,
    maxPriority: 0,
    claimedTaskCount: 0,
    lastEventType: null,
    lastGlobalSequence: -1,
    lastOccurredAt: null,
    lastReleaseObservationStatus: null,
    lastApprovalVerdict: null
  }) as PortfolioProjectRollup;
}

function emptyPriorityBands(): Record<PortfolioPriorityBand, number> {
  return { high: 0, mid: 0, low: 0 };
}

/**
 * Validate that an incoming state has the canonical portfolio
 * shape. Exposed so the projector can detect drift and so
 * callers (CLI, tests) can validate third-party projections.
 */
export function isPortfolioProjectionState(
  value: unknown
): value is PortfolioProjectionState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== PORTFOLIO_ADAPTER_KIND) return false;
  if (typeof record["tenantId"] !== "string") return false;
  if (typeof record["eventCount"] !== "number") return false;
  if (!Array.isArray(record["scope"])) return false;
  if (!record["projectRollups"] || typeof record["projectRollups"] !== "object") {
    return false;
  }
  if (!Array.isArray(record["dependencyEdges"])) return false;
  if (!record["resourceLedger"] || typeof record["resourceLedger"] !== "object") {
    return false;
  }
  if (typeof record["crossProjectDependencyCount"] !== "number") return false;
  if (typeof record["terminalProjectCount"] !== "number") return false;
  return true;
}

/**
 * Idempotency key for a dependency edge. The reducer emits
 * at most one entry per `(relation, fromProjectId, fromTaskId,
 * toProjectId, toTaskId)` tuple so a duplicate replay does
 * not double-count.
 */
export function portfolioEdgeKey(edge: {
  readonly relation: PortfolioDependencyRelation;
  readonly fromProjectId: ProjectId;
  readonly fromTaskId: string;
  readonly toProjectId: ProjectId;
  readonly toTaskId: string;
}): string {
  return `${edge.relation}|${edge.fromProjectId}|${edge.fromTaskId}->${edge.toProjectId}|${edge.toTaskId}`;
}

/**
 * Map a numeric priority into one of the three portfolio
 * priority bands. Mirrors the documented `high ≥ 750`,
 * `mid 250..749`, `low 0..249` rule.
 */
export function portfolioPriorityBand(priority: number): PortfolioPriorityBand {
  if (priority >= 750) return "high";
  if (priority >= 250) return "mid";
  return "low";
}

// Re-export BoardEventType so reducer consumers don't need to
// import the board-store module separately when shaping input.
export type { BoardEventType };

// Re-export the ContentHash so reducer consumers can keep
// the import surface tight.
export type { ContentHash };
