/**
 * P09-T02 — Sqlite-backed whole-change acceptance projector.
 *
 * This module is the SQLite adapter for the whole-change
 * acceptance projection. The board layer exposes the *logical*
 * projection descriptor and pure reducer; this adapter wires
 * that reducer into `SqliteBoardProjectionRebuilder` so the
 * whole-change acceptance projection can be persisted, replayed,
 * and verified using the standard board-store flow.
 *
 * The projector lives in `@legion/store-sqlite` (not
 * `@legion/board`) to honor the package-boundary invariant:
 * `@legion/board` does NOT import `@legion/store-sqlite`. This
 * mirrors the relationship between `SqliteBoardProjectionRebuilder`
 * (in this package) and `BoardProjectionRebuilder` (in
 * `@legion/board-store`).
 *
 * Storage shape:
 *  - The projector stores `{ state: WholeChangeAcceptanceState |
 *    null }` under each projection key so the
 *    `BoardProjectionState` envelope constraint
 *    (`{ [key: string]: unknown }`) is satisfied.
 *  - The `state` slot is `null` when no whole-change acceptance
 *    has been observed yet; this is the canonical "no event
 *    yet" sentinel.
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
  deriveWholeChangeProjectionStateHash,
  reduceWholeChangeAcceptance,
  wholeChangeAcceptanceProjectionKey,
  WHOLE_CHANGE_PROJECTION_VERSION,
  type ChangeId,
  type ContentHash,
  type WholeChangeAcceptanceState
} from "@legion/board";

/**
 * Result type for the SQLite projector methods. Mirrors
 * `BoardProjectionRebuildReport` but exposes the nullable
 * `WholeChangeAcceptanceState` and a content-addressed
 * projection-state hash.
 */
export interface SqliteWholeChangeAcceptanceProjectorReplayResult {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: WholeChangeAcceptanceState | null;
  readonly stateHash: ReturnType<typeof deriveWholeChangeProjectionStateHash>;
  readonly rebuiltAt: string;
}

/**
 * Bridge from the board's pure `WholeChangeAcceptanceState | null`
 * reducer to the SQLite rebuilder's `BoardProjectionState`
 * envelope.
 */
function envelopeFor(
  state: WholeChangeAcceptanceState | null
): BoardProjectionState {
  return { state } as unknown as BoardProjectionState;
}

function stateFromEnvelope(
  envelope: BoardProjectionState
): WholeChangeAcceptanceState | null {
  const record = envelope as { state?: WholeChangeAcceptanceState | null };
  return record.state ?? null;
}

function stripSha256Prefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function isContentHash(value: unknown): value is ContentHash {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

const REPLAY_PAGE_LIMIT = 1_000;

function listReplayEvents(
  eventRepository: BoardEventRepository,
  query: Omit<BoardEventQuery, "fromGlobalSequence" | "limit" | "order">
): readonly BoardEvent[] {
  const events: BoardEvent[] = [];
  let fromGlobalSequence = 0;
  for (;;) {
    const page = eventRepository.listEvents({
      ...query,
      fromGlobalSequence,
      limit: REPLAY_PAGE_LIMIT,
      order: "asc"
    });
    if (page.length === 0) break;
    events.push(...page);
    const last = page[page.length - 1]!;
    fromGlobalSequence = last.globalSequence + 1;
    if (
      page.length < REPLAY_PAGE_LIMIT ||
      (typeof query.untilGlobalSequence === "number" &&
        fromGlobalSequence > query.untilGlobalSequence)
    ) {
      break;
    }
  }
  return events;
}

function isBoundWholeChangeEvent(
  event: BoardEvent,
  changeId: ChangeId,
  mergeQueueHash: string
): boolean {
  if (event.aggregateKind !== "whole_change") return false;
  if (event.aggregateId !== `${changeId}:${mergeQueueHash}`) return false;
  if (!event.payload || typeof event.payload !== "object") return false;
  const payload = event.payload as Record<string, unknown>;
  return (
    payload["changeId"] === changeId &&
    payload["mergeQueueHash"] === mergeQueueHash
  );
}

/**
 * SQLite-backed projector for the whole-change acceptance
 * projection. One projector instance owns one projection key
 * (`whole_change.acceptance:<changeId>:<mergeQueueHash>`).
 */
export class SqliteWholeChangeAcceptanceProjector {
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #projectionKey: string;
  readonly #projectionVersion: number;
  readonly #changeId: ChangeId;
  readonly #mergeQueueHash: ContentHash;

  constructor(options: {
    readonly changeId: ChangeId;
    readonly mergeQueueHash: string;
    readonly eventRepository: BoardEventRepository;
    readonly projectionRepository: BoardProjectionRepository;
    readonly now?: () => string;
    readonly projectionVersion?: number;
  }) {
    if (!options.changeId || typeof options.changeId !== "string") {
      throw new Error("changeId must be a non-empty branded string");
    }
    if (!isContentHash(options.mergeQueueHash)) {
      throw new Error("mergeQueueHash must be a sha256: prefixed content hash");
    }
    if (!options.eventRepository) {
      throw new Error("eventRepository is required");
    }
    if (!options.projectionRepository) {
      throw new Error("projectionRepository is required");
    }
    this.#changeId = options.changeId;
    this.#mergeQueueHash = options.mergeQueueHash;
    this.#projectionKey = wholeChangeAcceptanceProjectionKey(
      options.changeId,
      options.mergeQueueHash
    );
    this.#projectionVersion =
      options.projectionVersion ?? WHOLE_CHANGE_PROJECTION_VERSION;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#now = options.now ?? defaultNow;
  }

  readonly #now: () => string;

  /**
   * Replay the event log through the projection without
   * persisting. Useful for tests and dry-run CLI commands.
   */
  replay(input: { readonly throughGlobalSequence?: number } = {}): SqliteWholeChangeAcceptanceProjectorReplayResult {
    const events = listReplayEvents(this.#eventRepository, {
      ...(typeof input.throughGlobalSequence === "number"
        ? { untilGlobalSequence: input.throughGlobalSequence }
        : {})
    });
    let envelope: BoardProjectionState = envelopeFor(null);
    let lastSequence = -1;
    let eventCount = 0;
    for (const event of events) {
      if (!isBoundWholeChangeEvent(event, this.#changeId, this.#mergeQueueHash)) {
        continue;
      }
      const current = stateFromEnvelope(envelope);
      const next = reduceWholeChangeAcceptance(current, event);
      envelope = envelopeFor(next);
      lastSequence = event.globalSequence;
      eventCount += 1;
    }
    const state = stateFromEnvelope(envelope);
    return {
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: Math.max(0, lastSequence),
      eventCount,
      state,
      stateHash: deriveWholeChangeProjectionStateHash(state),
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
  ): SqliteWholeChangeAcceptanceProjectorReplayResult {
    const report = this.replay(input);
    // The board's `stateHash` carries the canonical `sha256:` prefix.
    // The SQLite projection repository requires the raw 64-char hex
    // digest, so we strip the prefix before persisting.
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
      ...report,
      state: stateFromEnvelope(record.state)
    };
  }

  /**
   * Verify the persisted projection matches a fresh replay.
   */
  verify(
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqliteWholeChangeAcceptanceProjectorReplayResult {
    const saved = this.#projectionRepository.loadProjection(this.#projectionKey);
    if (!saved) {
      throw new Error(
        "Whole-change projection " +
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
        "Whole-change projection drift detected: saved=" +
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
  get mergeQueueHash(): ContentHash {
    return this.#mergeQueueHash;
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

// Re-export the board-side helpers so consumers can build the
// projector without importing the board module separately.
export {
  deriveWholeChangeProjectionStateHash,
  reduceWholeChangeAcceptance,
  wholeChangeAcceptanceProjectionKey,
  WHOLE_CHANGE_PROJECTION_VERSION,
  type WholeChangeAcceptanceState
};
