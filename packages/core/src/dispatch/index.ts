/**
 * Public surface of the fresh-context task dispatcher (P08-T01).
 *
 * Re-exports the typed contract, the dispatcher, the selector, the
 * blocker mapper, the hash helpers, and the isolation invariant
 * check. Keeping them behind a single barrel lets the CLI and tests
 * import everything they need with one line.
 */

export * from "./contract.js";
export * from "./blocker.js";
export * from "./hash.js";
export * from "./selector.js";
export {
  FreshContextDispatcher,
  FreshContextIsolationError,
  assertIsolatedWorkerContext,
  collectBlockers,
  renderDispatchResult
} from "./dispatcher.js";
