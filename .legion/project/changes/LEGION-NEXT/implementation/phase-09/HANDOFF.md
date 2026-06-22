# Phase 9 Handoff — Merge Queue and Whole Change Acceptance

## Status

IN PROGRESS — P09-T01 (merge queue orchestrator) DONE; P09-T02 (whole-change acceptance aggregator) and P09-T03 (independent review) TODO.

Implementation batch: Phase 9 P09-T01 changes on `codex/p03-t02-board-task-repository` after base `657f14ef52974efb0b72f009f536f7105884ad9c`, with task evidence under `docs/next/evidence/P09-T01/`.

Phase 9 establishes the whole-change acceptance lifecycle on top of Phase 8's fresh-context dispatch and per-task review. The branch now carries an ordered, deterministic merge queue: each task run is staged as an accepted queue entry, the sequencer walks one entry at a time, the path-level conflict detector blocks overlapping writes before rebase, the injected rebase runner advances the head ref, and the whole-change integration gate produces a fail-closed `MergeIntegrationDecision` for the next phase's aggregator.

## Delivered Surface

- `packages/core/src/merge/contract.ts`: typed merge queue contract — `MergeQueueEntry`, `MergeQueueStep`, `MergeQueueSnapshot`, `MergeIntegrationDecision`, `RebaseRunner`, `PathOwnershipMap`, `MergeQueueIssueCode` allowlist, `MERGE_QUEUE_KEYS` / `MERGE_QUEUE_ENTRY_KEYS` allowlists.
- `packages/core/src/merge/conflict.ts`: deterministic path-level conflict detector — `detectPathConflicts`, `createStaticPathOwnershipMap`, `pathsOverlap`, `normalizePath`, `claimsForEntry`. Reports `overlapping_write` and `sequential_violation` with stable, sorted, deduped indices.
- `packages/core/src/merge/hash.ts`: deterministic hashing for `stepSha256`, `mergeQueueHash`, and `decisionSha256`; `buildHashReceipt` helper for evidence dumps.
- `packages/core/src/merge/rebase.ts`: rebase sequencer — `runSequencer`, `runSequencerStep`, `buildIdentityRebaseResult`. Walks the ordered entries, propagates `previousOutcome` so queued/conflict steps do not falsely flag `entry_base_ref_mismatch`, and freezes the resulting `MergeQueueStep`.
- `packages/core/src/merge/gate.ts`: whole-change integration gate — `evaluateMergeIntegration`, `classifyStepOutcome`. Fail-closed aggregation: rejected → rejected, escalated → escalated, queued → blocked, otherwise integrated.
- `packages/core/src/merge/orchestrator.ts`: `MergeQueueOrchestrator` plus renderer + blocker mapper. Produces the frozen `MergeQueueOrchestratorResult` with `snapshot`, `decision`, `blockers`, `issues`, and `mergeQueueHash`.
- `packages/core/src/merge/index.ts`: public barrel.
- `packages/core/src/index.ts`: re-exports the merge barrel alongside dispatch, review, runtime, gates, risk, state-machines, and transition.
- `packages/core/test/merge.test.mjs`: 41 tests covering ordered queue, conflict detection, rebase sequencing, integration gate outcomes, provider-neutrality source scan, deterministic hashing, blocker projection, frozen output, dedup, and external ownership.
- `packages/core/test/merge-fixture.mjs`: deterministic fixture helpers — `makeFixtureEntry`, `makeSequencedEntries`, `makeOverlappingEntries`, `makeIdentityRebaseRunner`, `makeFailingRebaseRunner`.
- `packages/core/test/merge-evidence-snapshot.mjs`: produces the canonical serialized `MergeQueueOrchestratorResult` JSON for evidence dumps.
- `docs/next/evidence/P09-T01/merge-queue-snapshot.json`: canonical serialized snapshot output.

## Verification Evidence

- `pnpm --filter @legion/core test` — PASS, 226/226 package tests (185 prior + 41 P09-T01).
- `pnpm --filter @legion/protocol test` — PASS.
- `pnpm --filter @legion/artifacts test` — PASS.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 10/10.
- `pnpm run validate:next` — PASS; all gates pass including `runtime-import-boundaries` (the merge module does NOT depend on `../runtime/*`; it inlines a `sha256ContentHash` helper).
- `git diff --binary HEAD -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-09' ':!docs/next/evidence/P09-T01' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in 130.21 KB P09-T01 diff scan.

Full transcripts are under `docs/next/evidence/P09-T01/`. The structured closeout report is `docs/next/evidence/P09-T01/integration-report.yaml`; the SHA-256 evidence index is `.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml`.

## Acceptance Cut Line

Phase 9 P09-T01 establishes these stable assumptions for downstream phases:

1. A whole-change integration is the deterministic aggregation of `MergeQueueEntry` records, each anchored to a frozen `WorkerContext` and a `PerTaskReviewPipelineResult` from Phase 8.
2. Merge queue entries are ordered by `sequenceIndex`; duplicates surface `entry_duplicate_sequence`; out-of-order indices surface `entry_out_of_order` and the sequencer sorts internally before walking.
3. Path conflicts are detected before the rebase step advances. `overlapping_write` is reported when two entries' `scope.write` paths overlap (equal or parent/child). `sequential_violation` is reported when a `sequentialFiles` path collides with any other entry's write or sequential scope.
4. The rebase sequencer is provider-neutral. `RebaseRunner` is injected; the CLI adapter wraps the actual git/Eve call. The sequencer never reads `process.env`, never imports a runtime driver, and never imports board persistence.
5. `previousOutcome` is propagated so the sequencer does NOT spuriously flag `entry_base_ref_mismatch` when the previous step did not advance.
6. The whole-change integration gate fails closed: any rejected/conflict → rejected; any escalated → escalated; any queued → blocked; otherwise integrated.
7. The snapshot carries `mergeQueueHash`; each step carries `stepSha256`; the decision carries `decisionSha256` plus a human-readable `rationale` so audit consumers can grep for the failing entry set.
8. Phase 8 freshness boundary is preserved: the merge queue consumes frozen `WorkerContext` and `PerTaskReviewPipelineResult` shapes but never reads worker scratch state or board persistence.
9. Phase 5 RuntimeDriver neutrality is preserved by construction: no merge module imports from `../runtime/*`, `../board-store/*`, or `node:sqlite`.
10. Provider-neutrality source scan: the merge source tree contains no forbidden imports (`runtime-local-driver`, `runtime-eve`, `runtime-legacy-cli`, `board-store`, `node:sqlite`, `process.env`).

## Phase 9 Continuing Point

Proceed to P09-T02 (`t_13698b40`): whole-change acceptance aggregator — board-driven event sourcing over `MergeQueueOrchestratorResult` snapshots and decisions.

P09-T02 should consume these inputs:

- Phase 9 `MergeQueueOrchestratorResult.mergeQueueHash` as the immutable whole-change identity handle.
- Phase 9 `MergeQueueOrchestratorResult.decision.outcome` (`integrated | rejected | escalated | blocked`) as the whole-change gate.
- Phase 9 `MergeQueueOrchestratorResult.decision.{acceptedEntries, rejectedEntries, escalatedEntries, conflictEntries}` as the per-entry breakdown for event sourcing.
- Phase 9 `MergeQueueOrchestratorResult.blockers` as the typed board blockers (with `code`, `path`, `entrySequenceIndex`, `reportedBy`, `reportedAt`) for board persistence.
- Phase 9 `MergeQueueOrchestratorResult.issues` as the typed `MergeQueueIssue[]` with codes from the `MergeQueueIssueCode` allowlist.
- Phase 8 `WorkerContext` + `PerTaskReviewPipelineResult` audit hashes as the upstream identity handles (still required for traceability from task acceptance → whole-change integration).

Recommended first checks for P09-T02:

1. Read this handoff, `docs/next/evidence/P09-T01/integration-report.yaml`, `packages/core/src/merge/contract.ts`, and `packages/core/src/merge/orchestrator.ts` before editing.
2. Treat the merge queue as a pure function: do not introduce side-effects beyond emitting board events; do not re-implement conflict detection or rebase.
3. Translate `MergeIntegrationDecision.outcome` into the board's `AcceptanceState` (`integrated → accepted`, `rejected → rejected`, `escalated → blocked`, `blocked → blocked`) without inventing a fourth state.
4. Preserve the content-addressed audit trail: every board event MUST carry `mergeQueueHash`, `decisionSha256`, and the originating `WorkerContext.workerContextHash`.
5. Keep board persistence out of core: the aggregator lives in the board adapter layer; core does not import from `@legion/board-store` or `@legion/store-sqlite`.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 9 source blocker because the local core/protocol/artifacts/typecheck/workspace/validate/gitleaks gates passed; CI/release runners should continue to use the declared Node range.
