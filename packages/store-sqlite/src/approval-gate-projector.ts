/**
 * P11-T01 — Sqlite-backed approval-gate projector.
 *
 * This module is the SQLite adapter for the approval-gate
 * projection. The board layer exposes the *logical*
 * projection descriptor and pure reducer; this adapter
 * wires that reducer into `SqliteBoardProjectionRebuilder`
 * so the approval-gate projection can be persisted,
 * replayed, and verified using the standard board-store
 * flow.
 *
 * The projector lives in `@legion/store-sqlite` (not
 * `@legion/board`) to honor the package-boundary invariant:
 * `@legion/board` does NOT import `@legion/store-sqlite`.
 * This mirrors the relationship between
 * `SqliteBoardProjectionRebuilder` (in this package) and
 * `BoardProjectionRebuilder` (in `@legion/board-store`).
 *
 * Storage shape:
 *  - The projector stores `{ state: ApprovalGateProjectionState |
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
  approvalGateProjectionKey,
  APPROVAL_GATE_PROJECTION_VERSION,
  makeInitialApprovalGateState,
  reduceApprovalGate,
  type ApprovalGateProjectionState,
  type ChangeId,
  type ProjectId
} from "@legion/board";

import { createHash } from "node:crypto";

/**
 * Result type for the SQLite projector methods. Mirrors
 * `BoardProjectionRebuildReport` but exposes the nullable
 * `ApprovalGateProjectionState`.
 */
export interface SqliteApprovalGateProjectorReplayResult {
  readonly projectionKey: string;
  readonly projectionVersion: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly eventCount: number;
  readonly state: ApprovalGateProjectionState | null;
  readonly stateHash: string;
  readonly rebuiltAt: string;
}

function envelopeFor(
  state: ApprovalGateProjectionState | null
): BoardProjectionState {
  return { state } as unknown as BoardProjectionState;
}

function stateFromEnvelope(
  envelope: BoardProjectionState
): ApprovalGateProjectionState | null {
  const record = envelope as { state?: ApprovalGateProjectionState | null };
  return record.state ?? null;
}

function stripSha256Prefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * Deterministic hash for the approval-gate projection state.
 * Mirrors the P09-T02 / P10-T01 projector pattern: the
 * board-side hash helpers are content-addressed by the
 * state itself, and the SQLite projector strips the
 * `sha256:` prefix before persisting.
 */
function deriveApprovalGateStateHash(
  state: ApprovalGateProjectionState | null
): string {
  if (state === null) {
    return "0".repeat(64);
  }
  // We use a simple JSON canonicalization here because the
  // approval-gate state surface is small and stable. The
  // board-side approval-gate reducer doesn't ship a
  // hash.ts module yet, so we hash the canonical projection
  // state directly.
  const keys = Object.keys(state).sort();
  const canonical = JSON.stringify(
    keys.reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = state[key as keyof ApprovalGateProjectionState];
      return acc;
    }, {})
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
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

function isBoundApprovalGateEvent(
  event: BoardEvent,
  projectId: ProjectId,
  changeId: ChangeId
): boolean {
  if (
    !(
      (event.aggregateKind === "whole_change" &&
        (event.eventType === "change.aggregated" ||
          event.eventType === "change.accepted" ||
          event.eventType === "change.rejected" ||
          event.eventType === "change.blocked" ||
          event.eventType === "change.escalated")) ||
      (event.aggregateKind === "release_observation" &&
        (event.eventType === "release.observing" ||
          event.eventType === "release.observed" ||
          event.eventType === "release.promoted" ||
          event.eventType === "release.regressed" ||
          event.eventType === "release.rolled_back"))
    )
  ) {
    return false;
  }
  if (!event.payload || typeof event.payload !== "object") return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload["changeId"] !== changeId) return false;
  const eventProjectId = payload["projectId"];
  return eventProjectId === undefined || eventProjectId === projectId;
}

/**
 * SQLite-backed projector for the approval-gate projection.
 * One projector instance owns one projection key
 * (`approval-gate:<projectId>:<changeId>`).
 *
 * The projector replays the *global* board event log and
 * relies on the approval-gate reducer's foreign-event
 * safety: events whose payload does not carry the matching
 * `(projectId, changeId)` pair are silently dropped by the
 * reducer, so a single global replay correctly produces the
 * per-(projectId, changeId) verdict.
 */
export class SqliteApprovalGateProjector {
  readonly #eventRepository: BoardEventRepository;
  readonly #projectionRepository: BoardProjectionRepository;
  readonly #projectionKey: string;
  readonly #projectionVersion: number;
  readonly #projectId: ProjectId;
  readonly #changeId: ChangeId;
  readonly #now: () => string;

  constructor(options: {
    readonly projectId: ProjectId;
    readonly changeId: ChangeId;
    readonly eventRepository: BoardEventRepository;
    readonly projectionRepository: BoardProjectionRepository;
    readonly now?: () => string;
    readonly projectionVersion?: number;
  }) {
    if (!options.projectId || typeof options.projectId !== "string") {
      throw new Error("projectId must be a non-empty branded string");
    }
    if (!options.changeId || typeof options.changeId !== "string") {
      throw new Error("changeId must be a non-empty branded string");
    }
    if (!options.eventRepository) {
      throw new Error("eventRepository is required");
    }
    if (!options.projectionRepository) {
      throw new Error("projectionRepository is required");
    }
    this.#projectId = options.projectId;
    this.#changeId = options.changeId;
    this.#projectionKey = approvalGateProjectionKey(
      options.projectId,
      options.changeId
    );
    this.#projectionVersion =
      options.projectionVersion ?? APPROVAL_GATE_PROJECTION_VERSION;
    this.#eventRepository = options.eventRepository;
    this.#projectionRepository = options.projectionRepository;
    this.#now = options.now ?? defaultNow;
  }

  /**
   * Replay the event log through the projection without
   * persisting. Useful for tests and dry-run CLI commands.
   */
  replay(
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqliteApprovalGateProjectorReplayResult {
    const query: Omit<
      BoardEventQuery,
      "fromGlobalSequence" | "limit" | "order"
    > = {
      ...(typeof input.throughGlobalSequence === "number"
        ? { untilGlobalSequence: input.throughGlobalSequence }
        : {})
    };
    const events = listReplayEvents(this.#eventRepository, query);
    let envelope: BoardProjectionState = envelopeFor(null);
    let lastSequence = -1;
    for (const event of events) {
      let current = stateFromEnvelope(envelope);
      if (
        current === null &&
        isBoundApprovalGateEvent(event, this.#projectId, this.#changeId)
      ) {
        current = makeInitialApprovalGateState(this.#projectId, this.#changeId);
      }
      const next = reduceApprovalGate(current, event as BoardEvent);
      envelope = envelopeFor(next);
      if (next !== null) {
        lastSequence = event.globalSequence;
      }
    }
    const state = stateFromEnvelope(envelope);
    return {
      projectionKey: this.#projectionKey,
      projectionVersion: this.#projectionVersion,
      rebuiltThroughGlobalSequence: lastSequence,
      eventCount: events.length,
      state,
      stateHash: deriveApprovalGateStateHash(state),
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
  ): SqliteApprovalGateProjectorReplayResult {
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
    input: { readonly throughGlobalSequence?: number } = {}
  ): SqliteApprovalGateProjectorReplayResult {
    const saved = this.#projectionRepository.loadProjection(this.#projectionKey);
    if (!saved) {
      throw new Error(
        "Approval-gate projection " +
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
        "Approval-gate projection drift detected: saved=" +
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
   * Return the changeId the projector is bound to.
   */
  get changeId(): ChangeId {
    return this.#changeId;
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
  approvalGateProjectionKey,
  APPROVAL_GATE_PROJECTION_VERSION,
  reduceApprovalGate,
  type ApprovalGateProjectionState
};
export type { BoardProjectionRebuildReport };
