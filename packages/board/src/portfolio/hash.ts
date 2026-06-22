/**
 * P11-T02 — Portfolio projection hash helpers.
 *
 * The portfolio projection state hash is a content-addressed
 * SHA-256 digest over the canonical JSON projection of
 * `PortfolioProjectionState`. It mirrors the
 * `deriveDashboardProjectionStateHash` (P11-T01) and
 * `deriveWholeChangeProjectionStateHash` (P09-T02) shape so
 * the SQLite projector can detect drift without re-running
 * the reducer.
 *
 * Hash inputs:
 *   - schemaVersion
 *   - kind
 *   - tenantId
 *   - scope (sorted list)
 *   - eventCount
 *   - rebuiltThroughGlobalSequence
 *   - projectRollups (sorted by projectId)
 *   - dependencyEdges (sorted by edge-key)
 *   - resourceLedger (priorityBands sorted, then by-project sorted)
 *   - crossProjectDependencyCount
 *   - terminalProjectCount
 *
 * The hash is returned with the canonical `sha256:<64-hex>`
 * prefix used throughout the Phase 9/10/11 ledger. The
 * SQLite projector strips the prefix before persisting.
 */

import { createHash } from "node:crypto";

import type {
  PortfolioDependencyEdge,
  PortfolioPriorityBand,
  PortfolioProjectionState,
  PortfolioProjectRollup
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

function sortedProjectRollups(state: PortfolioProjectionState): Readonly<
  Record<string, PortfolioProjectRollup>
> {
  const entries = Object.entries(state.projectRollups).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  const result: Record<string, PortfolioProjectRollup> = {};
  for (const [key, value] of entries) result[key] = value;
  return Object.freeze(result);
}

function sortedDependencyEdges(
  state: PortfolioProjectionState
): readonly PortfolioDependencyEdge[] {
  return Object.freeze(
    [...state.dependencyEdges].sort((a, b) => {
      const aKey =
        a.relation +
        "|" +
        a.fromProjectId +
        "|" +
        a.fromTaskId +
        "->" +
        a.toProjectId +
        "|" +
        a.toTaskId;
      const bKey =
        b.relation +
        "|" +
        b.fromProjectId +
        "|" +
        b.fromTaskId +
        "->" +
        b.toProjectId +
        "|" +
        b.toTaskId;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
  );
}

function sortedResourceLedger(
  state: PortfolioProjectionState
): PortfolioProjectionState["resourceLedger"] {
  const ledger = state.resourceLedger;
  const sortedBands = Object.freeze(
    (["high", "mid", "low"] as PortfolioPriorityBand[]).reduce<
      Record<PortfolioPriorityBand, number>
    >(
      (acc, band) => {
        acc[band] = ledger.priorityBands[band] ?? 0;
        return acc;
      },
      { high: 0, mid: 0, low: 0 }
    )
  );

  const sortProjectMap = (
    input: Readonly<Record<string, Readonly<Record<string, number>>>>
  ): Readonly<Record<string, Readonly<Record<string, number>>>> => {
    const sortedEntries = Object.entries(input).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
    );
    const result: Record<
      string,
      Record<PortfolioPriorityBand, number>
    > = {};
    for (const [projectId, bands] of sortedEntries) {
      const sortedBandEntries = (
        ["high", "mid", "low"] as PortfolioPriorityBand[]
      ).map((band) => [band, bands[band] ?? 0]);
      result[projectId] = Object.freeze(
        Object.fromEntries(sortedBandEntries) as Record<
          PortfolioPriorityBand,
          number
        >
      );
    }
    return Object.freeze(result);
  };

  const sortNumeric = (
    input: Readonly<Record<string, number>>
  ): Readonly<Record<string, number>> => {
    const sortedEntries = Object.entries(input).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
    );
    return Object.freeze(Object.fromEntries(sortedEntries));
  };

  return Object.freeze({
    priorityBands: sortedBands,
    priorityBandsByProject: sortProjectMap(ledger.priorityBandsByProject),
    claimUtilizationByProject: sortNumeric(ledger.claimUtilizationByProject),
    blockedPressureByProject: sortNumeric(ledger.blockedPressureByProject)
  });
}

/**
 * Sort the scope list for the canonical hash input. The
 * portfolio state stores the scope as a frozen array; the
 * canonical projection always re-sorts so two equal scopes
 * produce identical hashes regardless of declaration order.
 */
function sortedScope(state: PortfolioProjectionState): readonly string[] {
  return Object.freeze([...state.scope].sort());
}

/**
 * Compute the canonical SHA-256 content hash for the
 * portfolio projection state. The hash inputs cover every
 * public field of `PortfolioProjectionState` plus the
 * `rebuiltThroughGlobalSequence` and `scope` so a
 * portfolio with a different tenant scope is
 * content-addressed distinctly.
 */
export function derivePortfolioProjectionStateHash(
  state: PortfolioProjectionState | null
): string {
  if (state === null) {
    return sha256ContentHash(
      JSON.stringify({ kind: "portfolio-adapter-empty", schemaVersion: "1.0.0" })
    );
  }
  const canonical = canonicalize({
    schemaVersion: state.schemaVersion,
    kind: state.kind,
    tenantId: state.tenantId,
    scope: sortedScope(state),
    rebuiltThroughGlobalSequence: state.rebuiltThroughGlobalSequence,
    eventCount: state.eventCount,
    projectRollups: sortedProjectRollups(state),
    dependencyEdges: sortedDependencyEdges(state),
    resourceLedger: sortedResourceLedger(state),
    crossProjectDependencyCount: state.crossProjectDependencyCount,
    terminalProjectCount: state.terminalProjectCount
  });
  return sha256ContentHash(canonical);
}

/**
 * Helper for tests + consumers that want to compute the
 * canonical JSON shape directly (for property tests,
 * diff-against-fixture assertions, etc.).
 */
export function sha256OfCanonicalPortfolioInput(payload: unknown): string {
  return sha256ContentHash(canonicalize(payload));
}
