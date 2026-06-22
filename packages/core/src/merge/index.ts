/**
 * Public surface of the merge queue module (P09-T01).
 *
 * Re-exports the typed contract, the conflict detector, the rebase
 * sequencer, the integration gate, the orchestrator, and the
 * deterministic hashing helpers. Keeping them behind a single
 * barrel lets the CLI and tests import everything they need with
 * one line, mirroring the P08-T01 dispatch and P08-T02 review
 * surfaces.
 */

export * from "./contract.js";
export {
  buildSnapshot,
  buildEntryRefs,
  mapMergeQueueIssueToBoardBlocker,
  mapMergeQueueIssuesToBoardBlockers,
  renderMergeQueueIssueReason,
  summarizeMergeQueueResult,
  MergeQueueOrchestrator,
  deepFreeze
} from "./orchestrator.js";
export {
  createStaticPathOwnershipMap,
  detectPathConflicts,
  normalizePath,
  pathsOverlap,
  claimsForEntry
} from "./conflict.js";
export { buildIdentityRebaseResult, runSequencer, runSequencerStep } from "./rebase.js";
export { classifyStepOutcome, evaluateMergeIntegration } from "./gate.js";
export {
  buildHashReceipt,
  deriveEntryOrderingHash,
  deriveMergeIntegrationDecisionSha256,
  deriveMergeQueueSnapshotHash,
  deriveStepSha256,
  sha256OfCanonical
} from "./hash.js";
