# Phase 9 Handoff — Merge Queue and Whole Change Acceptance

## Status

DONE.

Implementation batch: Phase 9 P09-T01 + P09-T02 changes on `codex/p03-t02-board-task-repository` after base `657f14ef52974efb0b72f009f536f7105884ad9c`, with final closeout evidence under `docs/next/evidence/P09-CLOSEOUT/`.

Phase 9 closes the Accepted Change Lifecycle cut line for Legion Next. The branch now carries an ordered, deterministic merge queue and board-backed whole-change acceptance lifecycle: each accepted task run is staged as a `MergeQueueEntry`, the sequencer walks one entry at a time, the path-level conflict detector blocks overlapping writes before rebase, the injected `RebaseRunner` advances the head ref, the whole-change integration gate produces a fail-closed `MergeIntegrationDecision`, and the board adapter layer emits a content-addressed `BoardEvent` with a SQLite-backed projection for accepted/rejected/blocked whole-change state.

## Delivered Surface — P09-T01

- `packages/core/src/merge/contract.ts`: typed merge queue contract — `MergeQueueEntry`, `MergeQueueStep`, `MergeQueueSnapshot`, `MergeIntegrationDecision`, `RebaseRunner`, `PathOwnershipMap`, `MergeQueueIssueCode` allowlist, `MERGE_QUEUE_KEYS` / `MERGE_QUEUE_ENTRY_KEYS` allowlists.
- `packages/core/src/merge/conflict.ts`: deterministic path-level conflict detector — `detectPathConflicts`, `createStaticPathOwnershipMap`, `pathsOverlap`, `normalizePath`, `claimsForEntry`. Reports `overlapping_write` and `sequential_violation` with stable, sorted, deduped indices.
- `packages/core/src/merge/hash.ts`: deterministic hashing for `stepSha256`, `mergeQueueHash`, and `decisionSha256`; `buildHashReceipt` helper for evidence dumps.
- `packages/core/src/merge/rebase.ts`: rebase sequencer — `runSequencer`, `runSequencerStep`, `buildIdentityRebaseResult`. Walks the ordered entries, propagates `previousOutcome` so queued/conflict steps do not falsely flag `entry_base_ref_mismatch`, and freezes the resulting `MergeQueueStep`.
- `packages/core/src/merge/gate.ts`: whole-change integration gate — `evaluateMergeIntegration`, `classifyStepOutcome`. Fail-closed aggregation: rejected/conflict -> rejected, escalated -> escalated, queued -> blocked, otherwise integrated.
- `packages/core/src/merge/orchestrator.ts`: `MergeQueueOrchestrator` plus renderer + blocker mapper. Produces the frozen `MergeQueueOrchestratorResult` with `snapshot`, `decision`, `blockers`, `issues`, and `mergeQueueHash`.
- `packages/core/src/merge/index.ts` and `packages/core/src/index.ts`: public barrel exports.
- `packages/core/test/merge.test.mjs`: 41 P09-T01 tests covering ordered queue, conflict detection, rebase sequencing, integration gate outcomes, provider-neutrality source scan, deterministic hashing, blocker projection, frozen output, dedup, and external ownership.
- `docs/next/evidence/P09-T01/merge-queue-snapshot.json`: canonical serialized merge queue output.

## Delivered Surface — P09-T02

- `packages/board/src/whole-change/contract.ts`: typed whole-change acceptance contract — `WholeChangeAcceptanceAggregatorInput`, `WholeChangeAcceptanceState`, `WholeChangeAcceptanceStatus`, `WholeChangeAggregatedPayload`, `WholeChangeEventType`, `WholeChangeAggregatorIssue`, projection descriptor and schema/event constants.
- `packages/board/src/whole-change/hash.ts`: deterministic SHA-256 helpers — `deriveWholeChangeAggregatorHash`, `deriveWholeChangeEventPayloadHash`, `deriveWholeChangeProjectionStateHash`, `sha256OfCanonical`.
- `packages/board/src/whole-change/aggregator.ts`: `WholeChangeAcceptanceAggregator` class + `buildWholeChangeAcceptance` free function. Fail-closed validation (empty queue, missing decision/snapshot, hash mismatch, invalid `acceptedBy`). Emits exactly one `BoardEvent` per run with `aggregateKind="whole_change"`, content-addressed `payloadHash`, `aggregatorHash`, and `idempotencyKey="<changeId>:<mergeQueueHash>:<eventType>"`. `mapOutcomeToStatus` enforces the canonical non-invertible map: `integrated -> accepted`, `rejected -> rejected`, `escalated -> blocked`, `blocked -> blocked`.
- `packages/board/src/whole-change/reducer.ts`: pure reducer + payload validator + replay helper + projection key helper + state verifier. Duplicate event replay is idempotent and foreign events are ignored.
- `packages/board/src/whole-change/projector.ts`: logical projection descriptor (`wholeChangeAcceptanceProjectionDescriptor`, `WHOLE_CHANGE_PROJECTION_VERSION`) and helper exports for the SQLite adapter layer.
- `packages/board/src/index.ts`: re-exports the whole-change barrel alongside the existing board event/projection/task/approval/link surfaces.
- `packages/board/test/whole-change-aggregator.test.mjs`: 32 tests covering outcome->status mapping, frozen output, audit hashes, payload parser, projection keys, reducer roundtrip, foreign-event ignore, idempotency, schema constants, and class/free-function equivalence.
- `packages/store-sqlite/src/whole-change-projector.ts`: `SqliteWholeChangeAcceptanceProjector` SQLite adapter wiring the board's pure reducer into the standard projection-store flow (`replay`, `rebuildAndSave`, `verify`). The board `sha256:` state hash is stripped before persistence.
- `packages/store-sqlite/test/whole-change-projector.test.mjs`: 5 tests covering SQLite-backed replay, persistence, null state before events, constructor validation, and drift verification against a real SQLite database.
- `packages/board-store/src/index.ts`: allowlists extended with `change.*` event types and the `whole_change` aggregate kind.
- `scripts/check-package-boundaries.mjs`: package-boundary allowlist updated so `@legion/store-sqlite` can consume `@legion/board` without allowing the reverse dependency.
- `docs/next/evidence/P09-T02/whole-change-snapshot.json`: canonical serialized whole-change acceptance output.

## Verification Evidence — P09-CLOSEOUT

- `pnpm --filter @legion/core test` — PASS, 226/226 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm --filter @legion/board test` — PASS, 32/32 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 135/135 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 10/10.
- `pnpm run validate:next` — PASS; all gates pass including package boundaries, worker bundles, runtime import boundaries, schema/doc drift, package contents, workspace tests, and pack dry-run.
- `git diff --cached --binary 657f14ef52974efb0b72f009f536f7105884ad9c -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 9 diff scan.

Full closeout transcripts are under `docs/next/evidence/P09-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P09-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-09-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml`.

## Accepted Change Lifecycle Cut Line

Phase 9 establishes these stable assumptions for downstream phases (P10+):

1. A whole-change integration is the deterministic aggregation of ordered `MergeQueueEntry` records, each anchored to frozen Phase 8 `WorkerContext` and `PerTaskReviewPipelineResult` evidence.
2. Merge queue entries are ordered by `sequenceIndex`; duplicate or out-of-order indices surface structured issues and do not erase audit evidence.
3. Path conflicts are detected before the rebase step advances. `overlapping_write` and `sequential_violation` remain stable issue codes that can be projected to board blockers.
4. The rebase sequencer is provider-neutral. `RebaseRunner` is injected; CLI/runtime adapters wrap git/Eve/host execution outside core.
5. `previousOutcome` is propagated so queued/conflict/rejected/escalated previous steps do not cause misleading downstream base-ref drift.
6. Whole-change integration fails closed: any rejected/conflict -> rejected; any escalated -> escalated; any queued -> blocked; otherwise integrated.
7. The merge snapshot carries `mergeQueueHash`; each step carries `stepSha256`; the integration decision carries `decisionSha256` and a grep-friendly rationale.
8. Whole-change acceptance lives in `@legion/board`, not `@legion/core`. Core stays provider-neutral; only the frozen `MergeQueueOrchestratorResult` crosses the core -> board boundary.
9. SQLite-backed projection lives in `@legion/store-sqlite`, not `@legion/board`. Board exposes pure reducer/descriptor; the SQLite adapter wraps persistence/replay/verification.
10. The outcome -> status map is non-invertible: `integrated -> accepted`, `rejected -> rejected`, `escalated -> blocked`, `blocked -> blocked`. Blocked states resolve only through a follow-up event with a different `mergeQueueHash`, never by mutating frozen state.
11. Every emitted `BoardEvent` carries a content-addressed audit trail: `mergeQueueHash`, `decisionSha256`, `workerContextHashes[]`, `aggregatorHash`, `payloadHash`, and `idempotencyKey="<changeId>:<mergeQueueHash>:<eventType>"`.
12. Aggregator validation is fail-closed: empty queue, missing decision, missing snapshot, mergeQueueHash mismatch, missing worker-context hashes, or invalid `acceptedBy` yields a typed `WholeChangeAggregatorIssue` failure shape.
13. Reducer replay is terminal and idempotent for the same `(changeId, mergeQueueHash)` pair; a fresh run must produce a new mergeQueueHash/projection event.
14. The independent closeout reviewer (`GPT-5.5 / otrlead`) is distinct from both the implementation assignee (`legionworker`) and the serialized acceptance actor (`ci-bot`) in the P09-T02 evidence snapshot.
15. Phase 5 RuntimeDriver neutrality, Phase 6 hidden-oracle sealing, Phase 7 TaskContract/preflight boundary, and Phase 8 fresh-context/per-task-review boundaries are preserved.

## Phase 10 Starting Point

Proceed to P10-T01 (`t_ec8b37af`): Release observation — canary monitoring, health checks, regression detection, and automated alerting.

Phase 10 should consume these inputs:

- `WholeChangeAcceptanceState.status` as the releaseability gate; only `accepted` whole-change states should enter release observation.
- `WholeChangeAcceptanceState.mergeQueueHash`, `decisionSha256`, `aggregatorHash`, `workerContextHashes[]`, `finalHeadRef`, `acceptedAt`, and `acceptedBy` as the immutable cut-line evidence handles.
- The emitted whole-change `BoardEvent.payloadHash` and `idempotencyKey` as replay/idempotency handles for monitoring and rollback evidence.
- Phase 9 `MergeQueueIssue` / `WholeChangeAggregatorIssue` codes as structured non-releaseable diagnostics when release observation sees a blocked/rejected state.

Recommended first checks for P10-T01:

1. Read this handoff, `docs/next/evidence/P09-CLOSEOUT/integration-report.yaml`, `packages/board/src/whole-change/contract.ts`, `packages/board/src/whole-change/reducer.ts`, and `packages/store-sqlite/src/whole-change-projector.ts` before editing.
2. Treat accepted whole-change state as immutable input. Release observation should append monitoring/health evidence, not rewrite the accepted state.
3. Preserve content-addressed handles in canary/regression reports so every release observation can be traced back to the exact task-run set and merge queue decision.
4. Keep command execution/provider-specific monitoring adapters outside `@legion/core`; use provider-neutral contracts and injected runners.
5. Fail closed on stale/missing/unverified whole-change projection state.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 9 source blocker because the local core/protocol/artifacts/board/store-sqlite/typecheck/workspace/validate-next/gitleaks gates passed; CI/release runners should continue to use the declared Node range.
