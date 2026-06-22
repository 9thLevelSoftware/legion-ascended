/**
 * P11-T01 — Sqlite-backed dashboard projector.
 *
 * This module is the SQLite adapter for the dashboard
 * projection. The board layer exposes the *logical*
 * projection descriptor and pure reducer; this adapter
 * wires that reducer into `SqliteBoardProjectionRebuilder`
 * so the dashboard projection can be persisted, replayed,
 * and verified using the standard board-store flow.
 *
 * The projector lives in `@legion/store-sqlite` (not
 * `@legion/board`) to honor the package-boundary invariant:
 * `@legion/board` does NOT import `@legion/store-sqlite`.
 * This mirrors the relationship between
 * `SqliteBoardProjectionRebuilder` (in this package) and
 * `BoardProjectionRebuilder` (in `@legion/board-store`).
 *
 * Storage shape:
 *  - The projector stores `{ state: DashboardProjectionState |
 *    null }` under each projection key so the
 *    `BoardProjectionState` envelope constraint
 *    (`{ [key: string]: unknown }`) is satisfied.
 *  - The `state` slot is `null` when no events have been
 *    observed yet; this is the canonical "no event yet"
 *    sentinel.
 */

import type {
  BoardEvent,
  BoardEventRepository,
  BoardEventQuery,
  BoardProjectionRebuildReport,
  BoardProjectionRepository,
  BoardProjectionState
} from "@legion/board-store";

import {
  dashboardProjectionKey,
  deriveDashboardProjectionStateHash,
  DASHBOARD_DEFAULT_TAIL_LIMIT,
  reduceDashboard,
  DASHBOARD_PROJECTION_VERSION,
  type DashboardProjectionState,
  type ProjectId
} from "@legion/board";

/**
 * Result type for the SQLite projector methods. Mirrors
 * `BoardProjectionRebuildReport` but exposes the nullable
 * `DashboardProjectionState` and a content-addressed
 * projection-state hash.
 */
export interface SqliteDashboardProjectorReplayResult {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: DashboardProjectionState | null;
  /**
   * The persisted state hash. The SQLite projector strips
   * the canonical `sha256:` prefix before persisting, so
   * this value is the raw 64-char hex digest.
   */
  readonly stateHash: string;
  readonly rebuiltAt: string;
}

function envelopeFor(
  state: DashboardProjectionState | null
): BoardProjectionState {
  return { state } as unknown as BoardProjectionState;
}

function stateFromEnvelope(
  envelope: BoardProjectionState
): DashboardProjectionState | null {
  const record = envelope as { state?: DashboardProjectionState | null };
  return record.state ?? null;
}

function stripSha256Prefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * SQLite-backed projector for the dashboard projection.
 * One projector instance owns one projection key
 * (`dashboard:<projectId>`).
 *
 * The projector replays the *global* board event log (not
 * a per-aggregate slice) and filters events by their
 * payload.projectId so foreign projects do not contaminate
 * this dashboard's counters. The board event repository's
 * `listEvents` returns the global log in `asc` order; the
 * reducer is foreign-event-safe so unfiltered events for
 * OTHER projects are silently dropped by the reducer.
 */
export class SqliteDashboardProjector {
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #projectionKey: string;
  readonly #projectionVersion: number;
  readonly #projectId: ProjectId;
  readonly #tailLimit: number;
  readonly #now: () => string;

  constructor(options: {
    readonly projectId: ProjectId;
    readonly eventRepository: BoardEventRepository;
    readonly projectionRepository: BoardProjectionRepository;
    readonly now?: () => string;
    readonly tailLimit?: number;
    readonly projectionVersion?: number;
  }) {
    if (!options.projectId || typeof options.projectId !== "string") {
      throw new Error("projectId must be a non-empty branded string");
    }
    if (!options.eventRepository) {
      throw new Error("eventRepository is required");
    }
    if (!options.projectionRepository) {
      throw new Error("projectionRepository is required");
    }
    this.#projectId = options.projectId;
    this.#projectionKey = dashboardProjectionKey(options.projectId);
    this.#projectionVersion =
      options.projectionVersion ?? DASHBOARD_PROJECTION_VERSION;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#tailLimit = Math.max(
      options.tailLimit ?? DASHBOARD_DEFAULT_TAIL_LIMIT,
      1
    );
    this.#now = options.now ?? defaultNow;
  }

  /**
   * Replay the event log through the projection without
   * persisting. Useful for tests and dry-run CLI commands.
   */
  replay(
    input: { readonly throughGlobalSequence?: number; readonly tailLimit?: number } = {}
  ): SqliteDashboardProjectorReplayResult {
    const query: BoardEventQuery = {
      ...(typeof input.throughGlobalSequence === "number"
        ? { untilGlobalSequence: input.throughGlobalSequence }
        : {}),
      order: "asc"
    };
    const events = this.#eventRepository.listEvents(query);
    let envelope: BoardProjectionState = envelopeFor(null);
    let lastSequence = -1;
    const tailLimit = Math.max(input.tailLimit ?? this.#tailLimit, 1);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;
      const current = stateFromEnvelope(envelope);
      const next = reduceDashboard(current, event as BoardEvent, {
        tailLimit,
        priorEvents: events.slice(0, i) as readonly BoardEvent[]
      });
      envelope = envelopeFor(next);
      lastSequence = event.globalSequence;
    }
    const state = stateFromEnvelope(envelope);
    return {
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: lastSequence,
      eventCount: events.length,
      state,
      stateHash: deriveDashboardProjectionStateHash(state),
      rebuiltAt: this.#now()
    };
  }

  /**
   * Replay and persist.
   */
  rebuildAndSave(
    input: {
      readonly throughGlobalSequence?: number;
      readonly expectedProjectionVersion?: number;
      readonly tailLimit?: number;
    } = {}
  ): SqliteDashboardProjectorReplayResult {
    const report = this.replay(input);
    const stateHashHex = stripSha256Prefix(report.stateHash);
    const record = this.#projectionRepository.saveProjection({
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: envelopeFor(report.state),
      stateHash: stateHashHex,
      ...(typeof input.expectedProjectionVersion === "number"
        ? { expectedProjectionVersion: input.expectedProjectionVersion }
        : {}),
      updatedAt: report.rebuiltAt
    });
    return {
      projectionKey: report.projectionKey,
      projectionVersion: report.projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      eventCount: report.eventCount,
      state: stateFromEnvelope(record.state),
      stateHash: stateHashHex,
      rebuiltAt: report.rebuiltAt
    };
  }

  /**
   * Verify the persisted projection matches a fresh replay.
   * Fails closed on drift (throws Error).
   */
  verify(
    input: { readonly throughGlobalSequence?: number; readonly tailLimit?: number } = {}
  ): SqliteDashboardProjectorReplayResult {
    const saved = this.#projectionRepository.loadProjection(this.#projectionKey);
    if (!saved) {
      throw new Error(
        "Dashboard projection " +
          this.#projectionKey +
          " has no saved state to verify against."
      );
    }
    const report = this.replay(input);
    const stateHashHex = stripSha256Prefix(report.stateHash);
    if (
      saved.stateHash !== stateHashHex ||
      saved.rebuiltThroughGlobalSequence !== report.rebuiltThroughGlobalSequence
    ) {
      throw new Error(
        "Dashboard projection drift detected: saved=" +
          saved.stateHash +
          "/" +
          saved.rebuiltThroughGlobalSequence +
          " actual=" +
          stateHashHex +
          "/" +
          report.rebuiltThroughGlobalSequence
      );
    }
    return {
      projectionKey: report.projectionKey,
      projectionVersion: report.projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      eventCount: report.eventCount,
      state: report.state,
      stateHash: stateHashHex,
      rebuiltAt: report.rebuiltAt
    };
  }

  /**
   * The projection key the projector is bound to.
   */
  get projectionKeyPublic(): string {
    return this.#projectionKey;
  }

  /**
   * Return the projectId the projector is bound to.
   */
  get projectId(): ProjectId {
    return this.#projectId;
  }

  /**
   * The projection version.
   */
  get projectionVersionPublic(): number {
    return this.#projectionVersion;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

// Re-export the board-side helpers so consumers can build
// the projector without importing the board module
// separately.
export {
  dashboardProjectionKey,
  deriveDashboardProjectionStateHash,
  reduceDashboard,
  DASHBOARD_PROJECTION_VERSION,
  type DashboardProjectionState
};
export type { BoardProjectionRebuildReport };