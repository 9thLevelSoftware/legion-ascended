/**
 * P10-T01 — Public surface of the release observation module.
 *
 * Re-exports the typed contract, the deterministic hashing
 * helpers, and the orchestrator. Keeping them behind a single
 * barrel lets the CLI and tests import everything they need
 * with one line, mirroring the P08-T01 dispatch, P08-T02
 * review, and P09-T01 merge barrels.
 */

export * from "./contract.js";
export {
  buildReleaseObservation,
  ReleaseObservationOrchestrator,
  ReleaseObservationOrchestratorError
} from "./orchestrator.js";
export type {
  ReleaseObservationOrchestratorOptions
} from "./orchestrator.js";
export {
  deriveAlertPhaseSha256,
  deriveCanaryPhaseSha256,
  deriveHealthCheckPhaseSha256,
  deriveRegressionPhaseSha256,
  deriveReleaseObservationReportSha256,
  RELEASE_OBSERVATION_HASH_VERSION
} from "./hash.js";
// Re-export the canonical SHA-256 helper via the merge hash module
// to avoid clashing with the merge barrel's own `sha256OfCanonical`
// re-export when both modules are surfaced through `@legion/core`.
export { sha256OfCanonical } from "../merge/hash.js";
