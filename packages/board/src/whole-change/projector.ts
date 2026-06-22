/**
 * P09-T02 — Whole-change acceptance projection descriptor.
 *
 * Why this lives in its own module under `@legion/board`:
 *  - The board layer owns the *logical* projection descriptor:
 *    the projection key, version, and the pure reducer that
 *    turns a stream of `whole_change` events into a frozen
 *    `WholeChangeAcceptanceState`.
 *  - The actual SQLite-backed projector is a `@legion/store-sqlite`
 *    adapter (mirroring how `SqliteBoardProjectionRebuilder`
 *    wraps the board-store's `BoardProjectionRebuilder`).
 *  - Keeping the SQLite projector out of `@legion/board` honors
 *    the package-boundary invariant: `@legion/board` does NOT
 *    import `@legion/store-sqlite`.
 *
 * The descriptor is intentionally expressed over the *logical*
 * `WholeChangeAcceptanceState | null` shape (not the
 * `BoardProjectionState` envelope) so the board layer does not
 * have to know about the SQLite envelope's `[key: string]:
 * unknown` constraint.
 */

import type {
  BoardEvent
} from "@legion/board-store";

import {
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION,
  type WholeChangeAcceptanceProjectionDescriptor
} from "./contract.js";

import {
  parseWholeChangeAcceptanceProjectionKey,
  reduceWholeChangeAcceptance,
  wholeChangeAcceptanceProjectionKey
} from "./reducer.js";

import {
  deriveWholeChangeProjectionStateHash
} from "./hash.js";

/**
 * The projection version. Bump when the reducer semantics
 * change in a way that requires a rebuild.
 */
export const WHOLE_CHANGE_PROJECTION_VERSION = 1 as const;

/**
 * The full projection descriptor for the whole-change
 * acceptance projection. This descriptor is what the
 * `@legion/store-sqlite` adapter wraps into a
 * `SqliteWholeChangeAcceptanceProjector`.
 *
 * The `initialState` is `null` because no whole-change
 * acceptance has been observed yet for the bound `changeId`.
 * The `reduce` field takes/returns `WholeChangeAcceptanceState |
 * null` rather than the `BoardProjectionState` envelope so the
 * descriptor stays decoupled from the SQLite storage shape.
 */
export const wholeChangeAcceptanceProjectionDescriptor: WholeChangeAcceptanceProjectionDescriptor = {
  projectionKey: "whole_change.acceptance",
  projectionVersion: WHOLE_CHANGE_PROJECTION_VERSION,
  initialState: null,
  reduce: (state, event) => reduceWholeChangeAcceptance(state, event)
};

/**
 * Convenience: derive a stable fingerprint for the projection
 * state so audit consumers can prove "same event stream ⇒
 * same projection" without parsing the JSON state.
 */
export function deriveWholeChangeProjectionState(
  events: readonly BoardEvent[]
): import("./contract.js").WholeChangeAcceptanceState | null {
  let state: import("./contract.js").WholeChangeAcceptanceState | null = null;
  for (const event of events) {
    state = reduceWholeChangeAcceptance(state, event);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Allowlist helpers
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_PROJECTION_KEY_PREFIX =
  "whole_change.acceptance:" as const;

export function isWholeChangeAcceptanceProjectionKey(
  projectionKey: string
): boolean {
  return parseWholeChangeAcceptanceProjectionKey(projectionKey) !== null;
}

// Re-export the projection-state hash from hash.ts so callers
// don't need to import the hash module separately.
export { deriveWholeChangeProjectionStateHash };

// Re-export constants for symmetry with other board adapter
// modules (e.g. `WHOLE_CHANGE_ACCEPTANCE_KIND`).
export {
  WHOLE_CHANGE_ACCEPTANCE_KIND,
  WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION
};

// Re-export the projection-key helper so SQLite adapters can
// pin the projection-key shape without importing the reducer
// module directly.
export { wholeChangeAcceptanceProjectionKey };