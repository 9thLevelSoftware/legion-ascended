/**
 * P09-T02 — Public surface of the whole-change acceptance module.
 *
 * Re-exports the contract, deterministic hashing helpers, the
 * pure reducer, the aggregator, and the projector. Keeping
 * everything behind a single barrel lets the CLI and tests
 * import everything they need with one line, mirroring the
 * P08-T01 dispatch, P08-T02 review, and P09-T01 merge barrels.
 */

export type { ChangeId } from "@legion/protocol";

export * from "./contract.js";
export {
  buildWholeChangeAcceptance,
  mapOutcomeToStatus,
  deriveWholeChangeAggregateId,
  WHOLE_CHANGE_AGGREGATE_KIND_LITERAL,
  WholeChangeAcceptanceAggregator
} from "./aggregator.js";
export type {
  WholeChangeAcceptanceAggregatorOptions
} from "./aggregator.js";
export {
  buildStateFromPayload,
  isWholeChangeEventType,
  makeWholeChangeAcceptanceReducer,
  parseWholeChangeAcceptanceProjectionKey,
  parseWholeChangeAggregatedPayload,
  replayWholeChangeAcceptance,
  reduceWholeChangeAcceptance,
  verifyWholeChangeAcceptanceState,
  wholeChangeAcceptanceProjectionKey,
  WHOLE_CHANGE_REDUCER_KIND_LITERAL
} from "./reducer.js";
export {
  deriveWholeChangeProjectionState,
  deriveWholeChangeProjectionStateHash,
  isWholeChangeAcceptanceProjectionKey,
  wholeChangeAcceptanceProjectionDescriptor,
  WHOLE_CHANGE_PROJECTION_KEY_PREFIX,
  WHOLE_CHANGE_PROJECTION_VERSION
} from "./projector.js";
export {
  deriveWholeChangeAggregatorHash,
  deriveWholeChangeEventPayloadHash,
  sha256OfCanonical,
  WHOLE_CHANGE_HASH_VERSION
} from "./hash.js";