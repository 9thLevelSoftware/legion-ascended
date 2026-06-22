/**
 * Public surface of the per-task review pipeline (P08-T02).
 *
 * Re-exports the typed contract, the deterministic verification
 * runner, the independent reviewer surface, the acceptance gate
 * evaluator, and the pipeline orchestrator. Keeping them behind a
 * single barrel lets the CLI and tests import everything they need
 * with one line, mirroring the P08-T01 dispatch surface.
 */

export * from "./contract.js";
export * from "./hash.js";
export * from "./verification.js";
export * from "./reviewer.js";
export * from "./gate.js";
export {
  PerTaskReviewPipeline,
  renderReviewPipelineResult,
  summarizeReviewPipelineResults
} from "./pipeline.js";