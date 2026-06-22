/**
 * P11-T01 — Dashboard projection barrel.
 *
 * Re-exports the dashboard contract, reducer, hash helpers,
 * and descriptor so consumers (SQLite projector, CLI) can
 * import the full dashboard surface from
 * `@legion/board/dashboard`.
 */

export {
  DASHBOARD_ADAPTER_KEYS,
  DASHBOARD_ADAPTER_KIND,
  DASHBOARD_ADAPTER_SCHEMA_VERSION,
  DASHBOARD_APPROVAL_VERDICTS,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  DASHBOARD_MAX_TAIL_LIMIT,
  DASHBOARD_PROJECTION_KEY_PREFIX,
  DASHBOARD_PROJECTION_VERSION,
  DASHBOARD_RELEASE_STATUSES,
  dashboardProjectionKey,
  isDashboardProjectionState,
  makeInitialDashboardState,
  parseDashboardProjectionKey
} from "./contract.js";

export {
  DASHBOARD_REDUCER_KIND,
  DASHBOARD_REDUCER_KIND_LITERAL,
  DASHBOARD_KNOWN_RELEASE_STATUSES,
  DASHBOARD_TIMELINE_KEY,
  deriveDashboardProjectionStateHash,
  makeDashboardReducer,
  reduceDashboard,
  replayDashboard,
  sha256OfCanonicalDashboardInput
} from "./reducer.js";

export type {
  DashboardAdapterKey,
  DashboardAggregateKindCounts,
  DashboardApprovalPointer,
  DashboardApprovalVerdict,
  DashboardEventTailEntry,
  DashboardProjectionDescriptor,
  DashboardProjectionState,
  DashboardReducer,
  DashboardReleaseObservationPointer,
  DashboardReleaseStatus,
  DashboardTaskStatusCounts
} from "./contract.js";

export type { ReduceDashboardOptions } from "./reducer.js";

export type { ProjectId } from "@legion/protocol";