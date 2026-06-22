# Phase 9 Handoff — Merge Queue and Whole Change Acceptance

## Status

IN PROGRESS — P09-T01 (merge queue orchestrator) and P09-T02 (whole-change acceptance aggregator) DONE; P09-T03 (independent review) TODO.

Implementation batch: Phase 9 P09-T01 + P09-T02 changes on `codex/p03-t02-board-task-repository` after base `657f14ef52974efb0b72f009f536f7105884ad9c`, with task evidence under `docs/next/evidence/P09-T01/` and `docs/next/evidence/P09-T02/`.

Phase 9 establishes the whole-change acceptance lifecycle on top of Phase 8's fresh-context dispatch and per-task review. The branch now carries an ordered, deterministic merge queue: each task run is staged as an accepted queue entry, the sequencer walks one entry at a time, the path-level conflict detector blocks overlapping writes before rebase, the injected rebase runner advances the head ref, the whole-change integration gate produces a fail-closed `MergeIntegrationDecision`, and the board adapter layer emits a content-addressed `BoardEvent` for the resolved whole-change acceptance with a SQLite-backed projection.

## Delivered Surface — P09-T01

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

## Delivered Surface — P09-T02

- `packages/board/src/whole-change/contract.ts`: typed whole-change acceptance contract — `WholeChangeAcceptanceAggregatorInput`, `WholeChangeAcceptanceState`, `WholeChangeAcceptanceStatus`, `WholeChangeAggregatedPayload`, `WholeChangeEventType`, `WholeChangeAggregatorIssue`, `WholeChangeAcceptanceProjectionDescriptor`, `WHOLE_CHANGE_ACCEPTANCE_KIND`, `WHOLE_CHANGE_ACCEPTANCE_SCHEMA_VERSION`, `WHOLE_CHANGE_EVENT_TYPES`, `WHOLE_CHANGE_AGGREGATE_KINDS`.
- `packages/board/src/whole-change/hash.ts`: deterministic SHA-256 helpers — `deriveWholeChangeAggregatorHash`, `deriveWholeChangeEventPayloadHash`, `deriveWholeChangeProjectionStateHash`, `sha256OfCanonical`.
- `packages/board/src/whole-change/aggregator.ts`: `WholeChangeAcceptanceAggregator` class + `buildWholeChangeAcceptance` free function. Fail-closed validation (empty queue, missing decision/snapshot, hash mismatch, invalid acceptedBy). Emits exactly one `BoardEvent` per run, with `aggregateKind="whole_change"`, content-addressed `payloadHash`, and `idempotencyKey="<changeId>:<mergeQueueHash>:<eventType>"`. `mapOutcomeToStatus` enforces the canonical non-invertible map: `integrated → accepted`, `rejected → rejected`, `escalated → blocked`, `blocked → blocked`.
- `packages/board/src/whole-change/reducer.ts`: pure `reduceWholeChangeAcceptance` reducer + `parseWholeChangeAggregatedPayload` payload validator + `replayWholeChangeAcceptance` + `wholeChangeAcceptanceProjectionKey` + `verifyWholeChangeAcceptanceState`. Idempotent under duplicate emission; ignores foreign events (different `aggregateKind` or mismatched `aggregateId`).
- `packages/board/src/whole-change/projector.ts`: logical projection descriptor (`wholeChangeAcceptanceProjectionDescriptor`, `WHOLE_CHANGE_PROJECTION_VERSION`) and helper exports for the SQLite adapter layer.
- `packages/board/src/whole-change/index.ts`: public barrel.
- `packages/board/src/index.ts`: re-exports the whole-change barrel alongside the existing board event/projection/task/approval/link surfaces.
- `packages/board/test/whole-change-aggregator.test.mjs`: 32 tests covering outcome→status mapping, frozen output, audit hashes, payload parser, projection keys, reducer roundtrip, foreign-event ignore, idempotency under duplicate emission, schema constants, and `WholeChangeAcceptanceAggregator` class equivalence.
- `packages/board/test/whole-change-fixture.mjs`: deterministic fixture helpers — `makeOrchestratorSuccess`, `makeBoardEvent`, `makeForeignBoardEvent`.
- `packages/store-sqlite/src/whole-change-projector.ts`: `SqliteWholeChangeAcceptanceProjector` SQLite adapter that wires the board's pure `reduceWholeChangeAcceptance` into the standard projection-store flow (`replay`, `rebuildAndSave`, `verify`). The board's `sha256:`-prefixed `stateHash` is stripped before persisting to the SQLite projection column.
- `packages/store-sqlite/test/whole-change-projector.test.mjs`: 5 tests covering SQLite-backed replay, persistence, and drift verification against a real SQLite database.
- `packages/store-sqlite/test/whole-change-fixture.mjs`: shared fixture helpers (mirrored from board).
- `packages/board-store/src/index.ts`: extended `BOARD_EVENT_TYPES` with `change.aggregated`, `change.accepted`, `change.rejected`, `change.escalated`, `change.blocked`; extended `BOARD_EVENT_AGGREGATE_KINDS` with `whole_change`. These are board-layer extensions of the existing allowlists; the SQLite repository persists them unchanged.
- `scripts/check-package-boundaries.mjs`: extended `store-sqlite`'s allowed workspace imports to include `@legion/board` so the projector adapter can resolve the reducer + descriptor.
- `docs/next/evidence/P09-T02/whole-change-snapshot.json`: canonical serialized aggregator output for evidence dumps.

## Verification Evidence — P09-T01

- `pnpm --filter @legion/core test` — PASS, 226/226 package tests (185 prior + 41 P09-T01).
- `pnpm --filter @legion/protocol test` — PASS.
- `pnpm --filter @legion/artifacts test` — PASS.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 10/10.
- `pnpm run validate:next` — PASS; all gates pass including `runtime-import-boundaries` (the merge module does NOT depend on `../runtime/*`; it inlines a `sha256ContentHash` helper).
- `git diff --binary HEAD -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-09' ':!docs/next/evidence/P09-T01' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in 130.21 KB P09-T01 diff scan.

## Verification Evidence — P09-T02

- `pnpm --filter @legion/core test` — PASS, 226/226 package tests (no regressions).
- `pnpm --filter @legion/protocol test` — PASS.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm --filter @legion/board test` — PASS, 32/32 P09-T02 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 135/135 tests (130 prior + 5 P09-T02 projector tests).
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 10/10.
- `pnpm run validate:next` — PASS; all gates pass including `runtime-import-boundaries` (the board module does NOT depend on `../runtime/*` or `../store-sqlite/*`).
- `git diff --cached -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-09' ':!docs/next/evidence/P09-T01' ':!docs/next/evidence/P09-T02' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in 119.94 KB P09-T02 diff scan.

Full transcripts are under `docs/next/evidence/P09-T01/` and `docs/next/evidence/P09-T02/`. The structured closeout reports are `docs/next/evidence/P09-T01/integration-report.yaml` and `docs/next/evidence/P09-T02/integration-report.yaml`; the SHA-256 evidence index is `.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml`.

## Acceptance Cut Line

Phase 9 P09-T01 + P09-T02 establish these stable assumptions for downstream phases (P09-T03, P10+):

1. A whole-change integration is the deterministic aggregation of `MergeQueueEntry` records, each anchored to a frozen `WorkerContext` and a `PerTaskReviewPipelineResult` from Phase 8.
2. Merge queue entries are ordered by `sequenceIndex`; duplicates surface `entry_duplicate_sequence`; out-of-order indices surface `entry_out_of_order` and the sequencer sorts internally before walking.
3. Path conflicts are detected before the rebase step advances. `overlapping_write` is reported when two entries' `scope.write` paths overlap (equal or parent/child). `sequential_violation` is reported when a `sequentialFiles` path collides with any other entry's write or sequential scope.
4. The rebase sequencer is provider-neutral. `RebaseRunner` is injected; the CLI adapter wraps the actual git/Eve call. The sequencer never reads `process.env`, never imports a runtime driver, and never imports board persistence.
5. `previousOutcome` is propagated so the sequencer does NOT spuriously flag `entry_base_ref_mismatch` when the previous step did not advance.
6. The whole-change integration gate fails closed: any rejected/conflict → rejected; any escalated → escalated; any queued → blocked; otherwise integrated.
7. The snapshot carries `mergeQueueHash`; each step carries `stepSha256`; the decision carries `decisionSha256` plus a human-readable `rationale` so audit consumers can grep for the failing entry set.
8. The whole-change acceptance aggregator lives in `@legion/board` (board adapter layer), NOT in `@legion/core`. Core stays provider-neutral; only the merge queue's frozen `MergeQueueOrchestratorResult` crosses the core → board boundary.
9. The SQLite-backed whole-change projector lives in `@legion/store-sqlite`, not `@legion/board`. The board exposes the logical projection descriptor and pure reducer; the SQLite adapter wraps it into the standard `SqliteBoardProjectionRebuilder` flow.
10. The outcome → status map is non-invertible: `integrated → accepted`, `rejected → rejected`, `escalated → blocked`, `blocked → blocked`. A `blocked` whole-change may later resolve to `accepted` through a follow-up event with a different `mergeQueueHash`, never by mutating a frozen state.
11. Every emitted `BoardEvent` carries the content-addressed audit trail: `mergeQueueHash`, `decisionSha256`, `workerContextHashes[]`, `aggregatorHash`, and `idempotencyKey="<changeId>:<mergeQueueHash>:<eventType>"`.
12. The aggregator is fail-closed: empty queue, missing decision, missing snapshot, hash mismatch, or invalid `acceptedBy` yields a typed `WholeChangeAggregatorIssue` failure shape — never a silently partial event stream.
13. Phase 8 freshness boundary is preserved: the aggregator consumes the frozen `MergeQueueOrchestratorResult` but never re-runs the merge queue or re-implements conflict detection or rebase.
14. Phase 5 RuntimeDriver neutrality is preserved by construction: the board module does not import any runtime driver, git, or `node:sqlite` directly. SQLite access is mediated through `BoardEventRepository` and `BoardProjectionRepository` injected into the projector.
15. Provider-neutrality source scan: the board whole-change source tree contains no forbidden imports (`runtime-local-driver`, `runtime-eve`, `runtime-legacy-cli`, `node:sqlite`, `process.env`).

## Phase 9 Continuing Point

Proceed to P09-T03 (`t_095363c6`): independent review — a reviewer (different actor from the implementer) audits the whole-change acceptance projection for the same actor rules as P08-T02's per-task review, but at the whole-change layer.

P09-T03 should consume these inputs:

- Phase 9 `WholeChangeAcceptanceState.aggregatorHash` as the immutable identity handle for the whole-change acceptance under review.
- Phase 9 `WholeChangeAcceptanceState.workerContextHashes[]` as the upstream per-task audit chain (preserved from P09-T02).
- Phase 9 `WholeChangeAcceptanceState.{acceptedEntries, rejectedEntries, escalatedEntries, conflictEntries}` for the per-task breakdown.
- Phase 8 `PerTaskReviewPipelineResult` audit hashes (still required for traceability from per-task acceptance to whole-change integration).

Recommended first checks for P09-T03:

1. Read this handoff, `docs/next/evidence/P09-T02/integration-report.yaml`, `packages/board/src/whole-change/contract.ts`, `packages/board/src/whole-change/reducer.ts`, and `packages/store-sqlite/src/whole-change-projector.ts` before editing.
2. Treat the whole-change acceptance state as immutable input. The reviewer's job is to render verdicts against the frozen state, not to mutate it.
3. Re-use the P08-T02 review pipeline shapes (`ReviewRecord`, `ReviewPipelineIssue`) for consistency.
4. Same-actor review rule: the reviewer actor MUST differ from the `acceptedBy` actor recorded on the whole-change state.
5. Surface blocking findings with `MergeQueueIssue`-style codes so the board can project them without inventing a fourth issue family.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 9 source blocker because the local core/protocol/artifacts/board/store-sqlite/typecheck/workspace/validate/gitleaks gates passed; CI/release runners should continue to use the declared Node range.
