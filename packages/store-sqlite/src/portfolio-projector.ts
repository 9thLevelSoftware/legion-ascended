/**
 * P11-T02 — Sqlite-backed portfolio projector.
 *
 * This module is the SQLite adapter for the portfolio
 * projection. The board layer exposes the *logical*
 * projection descriptor and pure reducer; this adapter
 * wires that reducer into `SqliteBoardProjectionRebuilder`
 * so the portfolio projection can be persisted, replayed,
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
 *  - The projector stores `{ state: PortfolioProjectionState
 *    | null, scope: ProjectId[] }` under each projection key
 *    so the `BoardProjectionState` envelope constraint
 *    (`{ [key: string]: unknown }`) is satisfied.
 *  - The `state` slot is `null` when no events have been
 *    observed yet; this is the canonical "no event yet"
 *    sentinel.
 *  - The `scope` slot is the frozen sorted scope array the
 *    reducer used; persisting it lets a follow-up rebuild
 *    reproduce the exact scope filter without re-reading
 *    the caller.
 */

import type {
  BoardEvent,
  BoardEventQuery,
  BoardEventRepository,
  BoardProjectionRebuildReport,
  BoardProjectionRepository,
  BoardProjectionState,
  ProjectId
} from "@legion/board-store";

import {
  PORTFOLIO_PROJECTION_VERSION,
  portfolioProjectionKey,
  portfolioScopeFromList,
  reducePortfolio,
  replayPortfolio,
  derivePortfolioProjectionStateHash,
  type PortfolioProjectionState,
  type PortfolioScope,
  type TenantId
} from "@legion/board";

/**
 * Result type for the SQLite projector methods. Mirrors
 * `BoardProjectionRebuildReport` but exposes the nullable
 * `PortfolioProjectionState` and a content-addressed
 * projection-state hash.
 */
export interface SqlitePortfolioProjectorReplayResult {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: PortfolioProjectionState | null;
  readonly tenantId: TenantId;
  readonly scope: PortfolioScope;
  /**
   * The persisted state hash. The SQLite projector strips
   * the canonical `sha256:` prefix before persisting, so
   * this value is the raw 64-char hex digest.
   */
  readonly stateHash: string;
  readonly rebuiltAt: string;
}

interface PortfolioEnvelope {
  state: PortfolioProjectionState | null;
  scope: readonly ProjectId[];
}

function envelopeFor(
  state: PortfolioProjectionState | null,
  scope: readonly ProjectId[]
): BoardProjectionState {
  const payload: PortfolioEnvelope = {
    state,
    scope: scope as readonly ProjectId[]
  };
  return payload as unknown as BoardProjectionState;
}

function stateFromEnvelope(
  envelope: BoardProjectionState
): PortfolioProjectionState | null {
  const record = envelope as Partial<PortfolioEnvelope>;
  return record.state ?? null;
}

function scopeFromEnvelope(envelope: BoardProjectionState): readonly ProjectId[] {
  const record = envelope as Partial<PortfolioEnvelope>;
  if (!record.scope || !Array.isArray(record.scope)) {
    return Object.freeze([] as ProjectId[]);
  }
  return Object.freeze([...record.scope] as ProjectId[]);
}

function stripSha256Prefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

export interface SqlitePortfolioProjectorOptions {
  readonly tenantId: TenantId;
  readonly eventRepository: BoardEventRepository;
  readonly projectionRepository: BoardProjectionRepository;
  readonly now?: () => string;
  readonly projectionVersion?: number;
  readonly scope?: readonly ProjectId[];
}

/**
 * SQLite-backed projector for the portfolio projection.
 * One projector instance owns one projection key
 * (`portfolio:<tenantId>`).
 *
 * The projector replays the *global* board event log (not
 * a per-aggregate slice) and uses the portfolio reducer's
 * scope filter to drop foreign projects. The board event
 * repository's `listEvents` returns the global log in
 * `asc` order; the reducer is foreign-event-safe so
 * unfiltered events for OTHER tenants are silently
 * ignored.
 */
export class SqlitePortfolioProjector {
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #projectionKey: string;
  readonly #projectionVersion: number;
  readonly #tenantId: TenantId;
  readonly #scope: PortfolioScope;
  readonly #now: () => string;

  constructor(options: SqlitePortfolioProjectorOptions) {
    if (!options.tenantId || typeof options.tenantId !== "string") {
      throw new Error("tenantId must be a non-empty branded string");
    }
    if (!options.eventRepository) {
      throw new Error("eventRepository is required");
    }
    if (!options.projectionRepository) {
      throw new Error("projectionRepository is required");
    }
    this.#tenantId = options.tenantId;
    this.#projectionKey = portfolioProjectionKey(options.tenantId);
    this.#projectionVersion =
      options.projectionVersion ?? PORTFOLIO_PROJECTION_VERSION;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#scope = options.scope ? portfolioScopeFromList(options.scope) : null;
    this.#now = options.now ?? defaultNow;
  }

  /**
   * Replay the event log through the projection without
   * persisting. Useful for tests and dry-run CLI commands.
   */
  replay(
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqlitePortfolioProjectorReplayResult {
    const query: BoardEventQuery = {
      ...(typeof input.throughGlobalSequence === "number"
        ? { untilGlobalSequence: input.throughGlobalSequence }
        : {}),
      order: "asc"
    };
    const events = this.#eventRepository.listEvents(query);
    const state = replayPortfolio(events, {
      tenantId: this.#tenantId,
      scope: this.#scope
    });
    const lastSequence = events.length
      ? events[events.length - 1]!.globalSequence
      : -1;
    return {
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: lastSequence,
      eventCount: events.length,
      state,
      tenantId: this.#tenantId,
      scope: this.#scope,
      stateHash: derivePortfolioProjectionStateHash(state),
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
    } = {}
  ): SqlitePortfolioProjectorReplayResult {
    const report = this.replay(input);
    const stateHashHex = stripSha256Prefix(report.stateHash);
    const record = this.#projectionRepository.saveProjection({
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: envelopeFor(report.state, report.state?.scope ?? []),
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
      tenantId: this.#tenantId,
      scope: this.#scope,
      stateHash: stateHashHex,
      rebuiltAt: report.rebuiltAt
    };
  }

  /**
   * Verify the persisted projection matches a fresh replay.
   * Fails closed on drift (throws Error).
   */
  verify(
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqlitePortfolioProjectorReplayResult {
    const saved = this.#projectionRepository.loadProjection(this.#projectionKey);
    if (!saved) {
      throw new Error(
        "Portfolio projection " +
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
        "Portfolio projection drift detected: saved=" +
          saved.stateHash +
          "/" +
          saved.rebuiltThroughGlobalSequence +
          " actual=" +
          stateHashHex +
          "/" +
          report.rebuiltThroughGlobalSequence
      );
    }
    // Restore the persisted scope if the projector was
    // configured without one — the saved scope is the
    // source of truth for verify.
    const persistedScope = scopeFromEnvelope(saved.state);
    const verifyScope =
      this.#scope ??
      (persistedScope.length > 0
        ? portfolioScopeFromList(persistedScope)
        : null);
    return {
      projectionKey: report.projectionKey,
      projectionVersion: report.projectionVersion,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      eventCount: report.eventCount,
      state: report.state,
      tenantId: this.#tenantId,
      scope: verifyScope,
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
   * Return the tenantId the projector is bound to.
   */
  get tenantIdPublic(): TenantId {
    return this.#tenantId;
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
  portfolioProjectionKey,
  portfolioScopeFromList,
  reducePortfolio,
  replayPortfolio,
  derivePortfolioProjectionStateHash,
  PORTFOLIO_PROJECTION_VERSION,
  type PortfolioProjectionState,
  type PortfolioScope,
  type TenantId
};
export type { BoardProjectionRebuildReport, BoardEvent as SqlitePortfolioProjectorBoardEvent };
