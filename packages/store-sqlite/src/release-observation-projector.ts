/**
 * P10-T01 — Sqlite-backed release-observation projector.
 *
 * This module is the SQLite adapter for the release-observation
 * projection. The board layer exposes the *logical* projection
 * descriptor and pure reducer; this adapter wires that reducer
 * into the standard SQLite projection-store flow so the
 * release-observation projection can be persisted, replayed,
 * and verified.
 *
 * The projector lives in `@legion/store-sqlite` (not
 * `@legion/board`) to honor the package-boundary invariant:
 * `@legion/board` does NOT import `@legion/store-sqlite`. This
 * mirrors the relationship between `SqliteBoardProjectionRebuilder`
 * (in this package) and `BoardProjectionRebuilder` (in
 * `@legion/board-store`).
 *
 * Storage shape:
 *  - The projector stores
 *    `{ state: ReleaseObservationProjectionState | null }`
 *    under each projection key so the
 *    `BoardProjectionState` envelope constraint
 *    (`{ [key: string]: unknown }`) is satisfied.
 *  - The `state` slot is `null` when no release-observation
 *    has been observed yet; this is the canonical "no event
 *    yet" sentinel.
 *  - The `stateHash` is the 64-char hex digest (no `sha256:`
 *    prefix) because the SQLite projection store enforces
 *    `length(state_hash) = 64` in its CHECK constraint.
 */

import type {
  BoardEvent,
  BoardEventRepository,
  BoardProjectionRebuildReport,
  BoardProjectionRepository,
  BoardProjectionState
} from "@legion/board-store";

import {
  deriveReleaseObservationProjectionStateHash,
  reduceReleaseObservation,
  releaseObservationProjectionKey,
  RELEASE_OBSERVATION_PROJECTION_VERSION,
  type ChangeId,
  type ReleaseObservationProjectionState
} from "@legion/board";

type BrandedContentHash = string & { readonly __contentHashBrand?: never };

/**
 * Result type for the SQLite projector methods. Mirrors
 * `BoardProjectionRebuildReport` but exposes the nullable
 * `ReleaseObservationProjectionState` and a content-addressed
 * projection-state hash.
 */
export interface SqliteReleaseObservationProjectorReplayResult {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: ReleaseObservationProjectionState | null;
  readonly stateHash: ReturnType<typeof deriveReleaseObservationProjectionStateHash>;
  readonly rebuiltAt: string;
}

/**
 * Bridge from the board's pure
 * `ReleaseObservationProjectionState | null` reducer to the
 * SQLite rebuilder's `BoardProjectionState` envelope.
 */
function envelopeFor(
  state: ReleaseObservationProjectionState | null
): BoardProjectionState {
  return { state } as unknown as BoardProjectionState;
}

function stateFromEnvelope(
  envelope: BoardProjectionState
): ReleaseObservationProjectionState | null {
  const record = envelope as { state?: ReleaseObservationProjectionState | null };
  return record.state ?? null;
}

function defaultNow(): string {
  return "2026-06-22T05:45:00.000Z";
}

function stripSha256Prefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

/**
 * SQLite-backed projector for the release-observation
 * projection. One projector instance owns one projection
 * key per `(changeId, mergeQueueHash)` pair, mirroring the
 * per-(change, merge-queue) wiring from P09-T02.
 */
export class SqliteReleaseObservationProjector {
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #projectionKey: string;
  readonly #projectionVersion: number;
  readonly #changeId: ChangeId;
  readonly #mergeQueueHash: string;
  readonly #now: () => string;

  constructor(options: {
    readonly changeId: ChangeId;
    readonly mergeQueueHash: string;
    readonly eventRepository: BoardEventRepository;
    readonly projectionRepository: BoardProjectionRepository;
    readonly now?: () => string;
    readonly projectionVersion?: number;
  }) {
    if (!options || typeof options !== "object") {
      throw new Error(
        "SqliteReleaseObservationProjector requires an options object."
      );
    }
    if (!options.changeId || typeof options.changeId !== "string") {
      throw new Error(
        "SqliteReleaseObservationProjector requires a non-empty changeId."
      );
    }
    if (
      !options.mergeQueueHash ||
      typeof options.mergeQueueHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(options.mergeQueueHash)
    ) {
      throw new Error(
        "SqliteReleaseObservationProjector requires a sha256: prefixed mergeQueueHash."
      );
    }
    if (!options.eventRepository) {
      throw new Error(
        "SqliteReleaseObservationProjector requires an eventRepository."
      );
    }
    if (!options.projectionRepository) {
      throw new Error(
        "SqliteReleaseObservationProjector requires a projectionRepository."
      );
    }
    this.#changeId = options.changeId;
    this.#mergeQueueHash = options.mergeQueueHash;
    this.#projectionKey = releaseObservationProjectionKey(
      options.changeId as unknown as never,
      options.mergeQueueHash as unknown as never
    );
    this.#projectionVersion =
      options.projectionVersion ?? RELEASE_OBSERVATION_PROJECTION_VERSION;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#now = options.now ?? defaultNow;
  }

  /**
   * Replay the event log through the projection without
   * persisting. Useful for tests and dry-run CLI commands.
   */
  replay(input: { readonly throughGlobalSequence?: number } = {}): SqliteReleaseObservationProjectorReplayResult {
    const events = this.#eventRepository.listEvents({
      ...(typeof input.throughGlobalSequence === "number"
        ? { untilGlobalSequence: input.throughGlobalSequence }
        : {}),
      order: "asc"
    });
    let envelope: BoardProjectionState = envelopeFor(null);
    let lastSequence = -1;
    for (const event of events) {
      if (event.aggregateKind !== "release_observation") continue;
      const current = stateFromEnvelope(envelope);
      const next = reduceReleaseObservation(current, event);
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
      stateHash: deriveReleaseObservationProjectionStateHash(state),
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
  ): SqliteReleaseObservationProjectorReplayResult {
    const report = this.replay(input);
    // The board's `stateHash` carries the canonical `sha256:` prefix.
    // The SQLite projection repository requires the raw 64-char hex
    // digest, so we strip the prefix before persisting.
    const stateHashHex = stripSha256Prefix(report.stateHash);
    // The `rebuiltThroughGlobalSequence` must be a non-negative
    // integer for the SQLite CHECK constraint; an empty event
    // log returns -1, so we clamp it to 0.
    const rebuiltThrough = Math.max(0, report.rebuiltThroughGlobalSequence);
    const record = this.#projectionRepository.saveProjection({
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: rebuiltThrough,
      state: envelopeFor(report.state),
      stateHash: stateHashHex,
      ...(typeof input.expectedProjectionVersion === "number"
        ? { expectedProjectionVersion: input.expectedProjectionVersion }
        : {}),
      updatedAt: report.rebuiltAt
    });
    return {
      ...report,
      state: stateFromEnvelope(record.state)
    };
  }

  /**
   * Verify the persisted projection matches a fresh replay.
   */
  verify(
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqliteReleaseObservationProjectorReplayResult {
    const saved = this.#projectionRepository.loadProjection(this.#projectionKey);
    if (!saved) {
      throw new Error(
        "Release-observation projection " +
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
        "Release-observation projection drift detected: saved=" +
          saved.stateHash +
          "/" +
          saved.rebuiltThroughGlobalSequence +
          " actual=" +
          stateHashHex +
          "/" +
          report.rebuiltThroughGlobalSequence
      );
    }
    return report;
  }

  /**
   * The projection key the projector is bound to.
   */
  get projectionKeyPublic(): string {
    return this.#projectionKey;
  }

  /**
   * Return the changeId the projector is bound to.
   */
  get changeId(): ChangeId {
    return this.#changeId;
  }

  /**
   * Return the mergeQueueHash the projector is bound to.
   */
  get mergeQueueHash(): BrandedContentHash {
    return this.#mergeQueueHash as BrandedContentHash;
  }

  /**
   * The projection version.
   */
  get projectionVersionPublic(): number {
    return this.#projectionVersion;
  }
}

// ---------------------------------------------------------------------------
// Public utility — wrap a list of release-observation BoardEvent
// values into the standard envelope so the projector can replay
// them. Mirrors the P09-T02 `envelopeFor` helper.
// ---------------------------------------------------------------------------

export function envelopeReleaseObservationState(
  state: ReleaseObservationProjectionState | null
): BoardProjectionState {
  return envelopeFor(state);
}

export function stateFromReleaseObservationEnvelope(
  envelope: BoardProjectionState
): ReleaseObservationProjectionState | null {
  return stateFromEnvelope(envelope);
}

export function releaseObservationProjectionKeyFor(
  changeId: ChangeId,
  mergeQueueHash: BrandedContentHash
): string {
  return releaseObservationProjectionKey(
    changeId as unknown as never,
    mergeQueueHash as unknown as never
  );
}

// Suppress unused warning — BoardEvent and BoardProjectionRebuildReport
// are re-exported above via the type imports and are public surface
// for adapter consumers.
export type { BoardEvent, BoardProjectionRebuildReport };
