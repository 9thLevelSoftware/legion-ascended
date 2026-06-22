/**
 * P10-T01 — Public surface of the release-observation board
 * adapter module.
 *
 * Re-exports the contract, hashing helpers, the pure
 * reducer, the aggregator, and the projection descriptor.
 * Mirrors the P09-T02 whole-change barrel so the CLI and
 * tests can import everything they need with one line.
 */

export type { ChangeId, ContentHash } from "@legion/protocol";

export * from "./contract.js";
export {
  buildReleaseObservationBoardEvent,
  deriveReleaseObservationAggregateId,
  eventTypeForReleaseObservationStatus,
  ReleaseObservationBoardAggregator,
  releaseObservationIdempotencyKey,
  RELEASE_OBSERVATION_AGGREGATE_KIND_LITERAL
} from "./aggregator.js";
export type {
  ReleaseObservationBoardAggregatorOptions
} from "./aggregator.js";
export {
  deriveReleaseObservationProjectionStateHash,
  deriveReleaseObservationEventPayloadHash,
  sha256OfCanonical,
  RELEASE_OBSERVATION_ADAPTER_HASH_VERSION
} from "./hash.js";
export {
  isReleaseObservationEventType,
  makeReleaseObservationReducer,
  parseReleaseObservationProjectionKey,
  reduceReleaseObservation,
  releaseObservationProjectionDescriptor,
  releaseObservationProjectionKey,
  replayReleaseObservation,
  RELEASE_OBSERVATION_PROJECTION_KEY_PREFIX,
  RELEASE_OBSERVATION_PROJECTION_VERSION,
  RELEASE_OBSERVATION_REDUCER_KIND,
  RELEASE_OBSERVATION_REDUCER_KIND_LITERAL
} from "./reducer.js";
