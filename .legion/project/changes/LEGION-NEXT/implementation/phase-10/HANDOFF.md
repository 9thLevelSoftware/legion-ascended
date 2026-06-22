# Phase 10 Handoff — Release Observation and Rollback

## Status

DONE.

Implementation batch: Phase 10 P10-T01 + P10-T02 + P10-T03 closeout changes on `codex/p03-t02-board-task-repository` after base `4fa01551bfe7abd5ce4715ed3c19c313d92a6c1a`. P10-T01 ships the provider-neutral release-observation orchestrator + board adapter + SQLite projector. P10-T02 wires the P10-T01 board adapter into the CLI as `legion next board release-observation aggregate | status | rebuild | verify`. P10-T03 finalizes the ledger, evidence index, independent review, Production Lifecycle cut line, and Phase 11 handoff. Closeout evidence lives under `docs/next/evidence/P10-CLOSEOUT/`.

Phase 10 closes the Production Lifecycle cut line for Legion Next. The branch now carries an accepted-change-to-release-observation lifecycle: only accepted whole-change state can enter release observation; canary, health-check, regression-detection, and alert phases are content-addressed and provider-neutral; release-observation board events are append-only/idempotent; SQLite projections can replay, rebuild, and verify drift; and the CLI exposes the operator commands needed for production lifecycle inspection.

## Delivered Surface — P10-T01

### `@legion/core` — provider-neutral release observation orchestrator

- `packages/core/src/release-observation/contract.ts`: typed contract — `ReleaseObservationInput`, `ReleaseObservationReport`, `CanaryPhaseResult`, `HealthCheckPhaseResult`, `RegressionPhaseResult`, `AlertPhaseResult`, `ReleaseObservationEventPayload`, `ReleaseObservationEventType`, `ReleaseObservationStatus` (`observing | promoted | regressed | rolled_back`), `ReleaseabilityState` (`releaseable | non_releaseable | deferred`), `ReleaseObservationIssue`, `ReleaseObservationIssueCode` allowlist, `RELEASE_OBSERVATION_KEYS` allowlist, `mapIntegrationOutcomeToReleaseability` helper, `eventTypeForReleaseStatus` helper.
- `packages/core/src/release-observation/hash.ts`: deterministic SHA-256 hashing for canary/health/regression/alert phase results + the top-level report. Hashes are content-addressed over a canonicalized string built from sorted keys, so two orchestrator runs against the same merge queue + same probes produce identical hashes.
- `packages/core/src/release-observation/orchestrator.ts`: `ReleaseObservationOrchestrator` class + `buildReleaseObservation` free function. Runs the four phases in order, derives the final status with the canonical non-invertible map, produces a deeply-frozen `ReleaseObservationReport` + `ReleaseObservationEventPayload` pair. `CanaryProbeRunner`, `HealthCheckRunner`, `RegressionDetectorRunner`, and `AlertSink` are injected; the orchestrator is pure with respect to its inputs. Validation is fail-closed: empty queue, missing decision/snapshot, non-releaseable outcome, invalid window, missing changeId, missing runner, or any non-integer phase result yields a typed `ReleaseObservationIssue` failure shape.
- `packages/core/src/release-observation/index.ts`: public barrel exports.
- `packages/core/test/release-observation.test.mjs`: 19 tests covering the releaseability map, the four phases, status resolution, determinism, frozen output, window validation, runner-unavailable error, and provider neutrality.
- `packages/core/test/release-observation-fixture.mjs`: deterministic builders for orchestrator results, canary/health/regression/alert inputs, and observers.
- `docs/next/evidence/P10-T01/release-observation-snapshot.json`: canonical serialized release-observation report from a happy-path orchestrator run.

### `@legion/board` — board adapter layer

- `packages/board/src/release-observation/contract.ts`: typed board adapter contract — `ReleaseObservationBoardAggregatorInput`, `ReleaseObservationBoardAggregatorSuccess`, `ReleaseObservationBoardAggregatorFailure`, `ReleaseObservationBoardIssue`, `ReleaseObservationProjectionState`, `ReleaseObservationProjectionDescriptor`, `ReleaseObservationBoardEventType`, `RELEASE_OBSERVATION_BOARD_EVENT_TYPES` allowlist, `RELEASE_OBSERVATION_ADAPTER_KIND` discriminator, `eventTypeForReleaseObservationStatus` helper, `releaseObservationIdempotencyKey` helper.
- `packages/board/src/release-observation/hash.ts`: deterministic SHA-256 hashing for board adapter event payloads + projection states.
- `packages/board/src/release-observation/aggregator.ts`: `ReleaseObservationBoardAggregator` class + `buildReleaseObservationBoardEvent` free function. Translates `ReleaseObservationStatus` → `ReleaseObservationEventType` via the canonical non-invertible map (`observing → release.observing`, `promoted → release.promoted`, `regressed → release.regressed`, `rolled_back → release.rolled_back`). Emits exactly one `BoardEvent` per run with `aggregateKind: "release_observation"`, content-addressed `payloadHash`, and `idempotencyKey: <changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`. Validation is fail-closed: missing report, hash mismatch, changeId mismatch, or invalid event type yields a typed `ReleaseObservationBoardIssue` failure shape.
- `packages/board/src/release-observation/reducer.ts`: pure reducer + replay helper + projection key helpers + projection descriptor. Foreign events are ignored; the reducer applies release-observation events in `globalSequence` order.
- `packages/board/src/release-observation/index.ts`: public barrel exports.
- `packages/board/test/release-observation-aggregator.test.mjs`: 21 tests covering the status map, the aggregator's event envelope, validation, frozen output, projection keys, replay, class equivalence, and provider neutrality.
- `packages/board/test/release-observation-fixture.mjs`: deterministic report + event builders.
- `packages/board-store/src/index.ts`: allowlist extended with `release.observing | release.observed | release.promoted | release.regressed | release.rolled_back` event types and the `release_observation` aggregate kind.

### `@legion/store-sqlite` — SQLite projection adapter

- `packages/store-sqlite/src/release-observation-projector.ts`: `SqliteReleaseObservationProjector` class — provider-neutral projection surface, mirroring the P09-T02 `SqliteWholeChangeAcceptanceProjector` pattern. Owns one projection key per `(changeId, mergeQueueHash)` pair, walks the event log through the board's pure reducer, and persists/verifies the projection through the standard `SqliteBoardProjectionRebuilder` flow. Constructor enforces a non-empty `changeId` and a sha256-prefixed `mergeQueueHash`. Foreign events are silently skipped.
- `packages/store-sqlite/test/release-observation-projector.test.mjs`: 9 tests covering envelope helpers, replay, rebuild+save, verify, foreign-event filter, and constructor validation.
- `packages/store-sqlite/test/release-observation-fixture.mjs`: deterministic report builders + SQLite temp-database harness.
- `packages/store-sqlite/src/index.ts`: barrel exports `SqliteReleaseObservationProjector`, `envelopeReleaseObservationState`, `stateFromReleaseObservationEnvelope`, `releaseObservationProjectionKeyFor`.

## Delivered Surface — P10-T02

### `@legion/cli` — `legion next board release-observation` command tree

- `packages/cli/src/commands/board/release-observation.ts`: typed CLI adapter — `aggregate | status | rebuild | verify` subcommands. Reuses the P10-T01 `ReleaseObservationBoardAggregator` for fail-closed report → board event translation, and the P10-T01 `SqliteReleaseObservationProjector` for replay/rebuild/verify through the SQLite board store. All four subcommands route through `SqliteBoardStoreWithEventRepository.open(...)` so the SQLite handle is opened/closed atomically and the WAL is released before temp directory cleanup. Validation is fail-closed: missing `changeId`, missing `report`, invalid `mergeQueueHash` (must match `sha256:[0-9a-f]{64}`), or a non-`(changeId, mergeQueueHash)` projection key yields a typed `usageError` rather than a silent partial result.
- `packages/cli/src/commands/board/index.ts`: board root dispatcher wired to `handleReleaseObservationCommand`; `BOARD_HELP` extended with the release-observation domain entry.
- `packages/cli/package.json`: dependencies extended with `@legion/board`, `@legion/board-store`, `@legion/core` (workspace links).
- `packages/cli/tsconfig.json`: project references extended with board, board-store, core.
- `apps/cli-e2e/test/cli-e2e.test.mjs`: three new e2e tests — `aggregate/status/rebuild/verify idempotency`, `validation failure surface`, and `verify fails closed on missing projection`.

### `scripts/check-package-boundaries.mjs`

- `@legion/cli` `allowedWorkspaceImports` extended with `@legion/board`, `@legion/board-store`, `@legion/core` so the CLI can consume the board adapter and the SQLite projector. No reverse imports are introduced; the package-boundary and runtime-import-boundary scans continue to pass after the CLI surface extension.

## Verification Evidence — P10-CLOSEOUT

- `pnpm --filter @legion/cli-e2e test` — PASS, 13/13 tests (10 existing + 3 release-observation CLI tests).
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 53/53 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 144/144 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 13/13.
- `pnpm run validate:next` — PASS; all gates pass including package boundaries, worker bundles, default-runtime scan, runtime import boundaries, schema/doc drift, package contents, workspace tests, and pack dry-run.
- `git diff --cached --binary 4fa01551bfe7abd5ce4715ed3c19c313d92a6c1a -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml' ':!docs/next/evidence/P10-CLOSEOUT/gitleaks-p10-diff.log' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 10 diff scan.

Full closeout transcripts are under `docs/next/evidence/P10-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P10-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-10-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml`.

## Production Lifecycle Cut Line

Phase 10 establishes these stable assumptions for downstream phases (P11+):

1. Release observation consumes accepted whole-change state as immutable input; rejected, escalated, blocked, missing, stale, or malformed merge/whole-change state fails closed and does not emit release-ready evidence.
2. Release observation has four sequential phases (canary → health-check → regression-detection → alert). Each phase is independently auditable and content-addressed via `phaseSha256` (per-phase) + `reportSha256` (top-level).
3. The releaseability map is non-invertible: `integrated → releaseable`, `rejected → non_releaseable`, `escalated → deferred`, `blocked → non_releaseable`. Only `releaseable` is allowed to enter release observation.
4. The status map is non-invertible: `observing | promoted | regressed | rolled_back`. Terminal statuses stay terminal; a new observation requires a fresh `reportSha256`.
5. Every emitted `BoardEvent` carries a content-addressed audit trail: `changeId`, `mergeQueueHash`, `decisionSha256`, `reportSha256`, `observedBy`, `payloadHash`, and `idempotencyKey: <changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`.
6. Probe execution (`CanaryProbeRunner`, `HealthCheckRunner`, `RegressionDetectorRunner`, `AlertSink`) is provider-neutral and injected. The orchestrator never spawns CLI processes, reads `process.env`, or imports a runtime driver.
7. Window validation is fail-closed: `windowEnd <= windowStart` yields `window_invalid`; `observedAt > windowEnd` yields `window_expired`.
8. Aggregator validation is fail-closed: missing report, `reportSha256` mismatch, `changeId` mismatch, or invalid event type yields a typed `ReleaseObservationBoardIssue` failure shape.
9. Reducer replay is idempotent for the same `(changeId, mergeQueueHash, reportSha256)` tuple and ignores foreign events.
10. The board adapter layer never imports a runtime driver, eve, node:sqlite, or reads `process.env`. The core release-observation module never imports board persistence, runtime drivers, eve, or reads `process.env`.
11. `board-store` `BOARD_EVENT_TYPES` and `BOARD_EVENT_AGGREGATE_KINDS` allowlists are extended with the new event types and aggregate kind. No SQL migration is required because the existing CHECK constraints are length-based.
12. The `SqliteReleaseObservationProjector` mirrors the P09-T02 projector pattern: one projector per `(changeId, mergeQueueHash)`, replay + persist + verify through the standard SQLite projection flow, foreign-event filter.
13. The CLI operator surface is `legion next board release-observation { aggregate | status | rebuild | verify }`. All four subcommands route through `SqliteBoardStoreWithEventRepository` so the SQLite handle is opened/closed atomically.
14. Dashboard/UI consumers should treat `release-observation:<changeId>:<mergeQueueHash>` as the canonical projection handle and preserve `stateHash`, `reportSha256`, `lastEventType`, and `idempotencyKey` in operator traces.
15. Missing or drifted release-observation projections are fail-closed diagnostics; absent production lifecycle evidence is never green.
16. Phase 5 RuntimeDriver neutrality, Phase 8 fresh-context/per-task-review boundaries, and Phase 9 accepted whole-change lifecycle boundaries are preserved.

## Phase 11 Starting Point

Proceed to P11-T01 (`t_249912d8`): Kanban dashboard and multi-project operator surface.

Phase 11 should consume these inputs:

- `ReleaseObservationProjectionState` keyed by `release-observation:<changeId>:<mergeQueueHash>` as the canonical production-lifecycle projection.
- `ReleaseObservationReport.status` as the operator-facing release verdict (`promoted` release-ready; `observing` non-terminal; `regressed` / `rolled_back` rollback or forward-fix).
- The release-observation audit handles: `changeId`, `mergeQueueHash`, `decisionSha256`, `reportSha256`, `lastEventType`, `stateHash`, `observedBy`, and `idempotencyKey`.
- Phase 8 per-task and Phase 9 whole-change hashes as trace-back handles for dashboard anomalies.

Recommended first checks for P11-T01:

1. Read this handoff, `docs/next/evidence/P10-CLOSEOUT/integration-report.yaml`, `docs/next/reviews/PHASE-10-INDEPENDENT-REVIEW.md`, `packages/board/src/release-observation/contract.ts`, `packages/board/src/release-observation/reducer.ts`, `packages/store-sqlite/src/release-observation-projector.ts`, and `packages/cli/src/commands/board/release-observation.ts` before editing.
2. Treat release-observation state as append-only projection evidence. Dashboard/API work should read/rebuild/verify through the board event/projection surfaces, not mutate frozen whole-change or release-observation states in place.
3. Preserve production lifecycle handles in every operator-facing trace so a red dashboard state can be linked back to the exact task-run, whole-change, and release-observation evidence.
4. Keep host-specific monitoring/probe command execution outside `@legion/core`; dashboard commands can surface status and evidence, not become probe runners by default.
5. Fail closed on absent, stale, or drifted production lifecycle projection state.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 10 source blocker because the local CLI e2e, core, board, store-sqlite, protocol, artifacts, typecheck, workspace, validate-next, and gitleaks gates passed; CI/release runners should continue to use the declared Node range.
