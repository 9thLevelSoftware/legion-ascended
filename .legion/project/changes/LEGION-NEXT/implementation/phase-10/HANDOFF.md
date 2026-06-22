# Phase 10 Handoff — Release Observation and Rollback

## Status

IN PROGRESS.

Implementation batch: Phase 10 P10-T01 changes on `codex/p03-t02-board-task-repository` after base `4fa01551bfe7abd5ce4715ed3c19c313d92a6c1a`, with closeout evidence under `docs/next/evidence/P10-T01/`. P10-T01 implements the release observation canary monitoring, health checks, regression detection, and automated alerting on top of the accepted whole-change lifecycle.

## Delivered Surface

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
- `packages/board/src/release-observation/reducer.ts`: pure reducer + replay helper + projection key helpers + projection descriptor. Foreign events are ignored; the reducer applies the most recent release-observation event in `globalSequence` order.
- `packages/board/src/release-observation/index.ts`: public barrel exports.
- `packages/board/test/release-observation-aggregator.test.mjs`: 21 tests covering the status map, the aggregator's event envelope, validation, frozen output, projection keys, replay, class equivalence, and provider neutrality.
- `packages/board/test/release-observation-fixture.mjs`: deterministic report + event builders.
- `packages/board-store/src/index.ts`: allowlist extended with `release.observing | release.observed | release.promoted | release.regressed | release.rolled_back` event types and the `release_observation` aggregate kind.

### `@legion/store-sqlite` — SQLite projection adapter

- `packages/store-sqlite/src/release-observation-projector.ts`: `SqliteReleaseObservationProjector` class — provider-neutral projection surface, mirroring the P09-T02 `SqliteWholeChangeAcceptanceProjector` pattern. Owns one projection key per `(changeId, mergeQueueHash)` pair, walks the event log through the board's pure reducer, and persists/verifies the projection through the standard `SqliteBoardProjectionRebuilder` flow. Constructor enforces a non-empty `changeId` and a sha256-prefixed `mergeQueueHash`. Foreign events are silently skipped.
- `packages/store-sqlite/test/release-observation-projector.test.mjs`: 9 tests covering envelope helpers, replay, rebuild+save, verify, foreign-event filter, and constructor validation.
- `packages/store-sqlite/test/release-observation-fixture.mjs`: deterministic report builders + SQLite temp-database harness.
- `packages/store-sqlite/src/index.ts`: barrel exports `SqliteReleaseObservationProjector`, `envelopeReleaseObservationState`, `stateFromReleaseObservationEnvelope`, `releaseObservationProjectionKeyFor`.

## Verification Evidence — P10-T01

- `pnpm --filter @legion/core test` — PASS, 245/245 tests (226 existing + 19 new).
- `pnpm --filter @legion/board test` — PASS, 53/53 tests (32 existing + 21 new).
- `pnpm --filter @legion/store-sqlite test` — PASS, 144/144 tests (135 existing + 9 new).
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests (no protocol changes).
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests (no artifacts changes).
- `pnpm run typecheck` — PASS, all 10 workspace projects.
- `pnpm run validate:next` — PASS, all 12 gates: typecheck, package boundaries, worker bundles, default-runtime scan, runtime import boundaries, schema generation, protocol docs, schema-doc drift, package contents, tests, npm pack dry-run, pnpm pack dry-run.
- `git diff --cached --binary 657f14ef52974efb0b72f009f536f7105884ad9c -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml' ':!.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 10 diff scan.

Full transcripts are under `docs/next/evidence/P10-T01/`. The structured closeout report is `docs/next/evidence/P10-T01/integration-report.yaml`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml`; the phase-10 ledger is `.legion/project/changes/LEGION-NEXT/implementation/phase-10/ledger.yaml`.

## Phase 10 Cut Line

Phase 10-T01 establishes these stable assumptions for downstream phases (P10-T02, P10-T03, P11+):

1. Release observation is keyed by `(changeId, mergeQueueHash)` and only consumes `accepted` whole-change state. `rejected` / `blocked` / `escalated` merge queue results surface a typed `merge_integration_not_accepted` issue rather than emit a release-observation report.
2. Release observation has four sequential phases (canary → health-check → regression-detection → alert). Each phase is independently auditable and content-addressed via `phaseSha256` (per-phase) + `reportSha256` (top-level).
3. The releaseability map is non-invertible: `integrated → releaseable`, `rejected → non_releaseable`, `escalated → deferred`, `blocked → non_releaseable`. Only `releaseable` is allowed to enter release observation.
4. The status map is non-invertible: `observing | promoted | regressed | rolled_back`. Terminal statuses stay terminal; promotion requires a fresh `reportSha256`.
5. Every emitted `BoardEvent` carries a content-addressed audit trail: `changeId`, `mergeQueueHash`, `decisionSha256`, `reportSha256`, `observedBy`, and `idempotencyKey: <changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`.
6. Probe execution (`CanaryProbeRunner`, `HealthCheckRunner`, `RegressionDetectorRunner`, `AlertSink`) is provider-neutral and injected. The orchestrator never spawns CLI processes, reads `process.env`, or imports a runtime driver.
7. Window validation is fail-closed: `windowEnd <= windowStart` yields `window_invalid`; `observedAt > windowEnd` yields `window_expired`.
8. Aggregator validation is fail-closed: missing report, `reportSha256` mismatch, `changeId` mismatch, or invalid event type yields a typed `ReleaseObservationBoardIssue` failure shape.
9. Reducer replay is terminal and idempotent for the same `(changeId, mergeQueueHash, reportSha256)` tuple. Foreign events are silently skipped.
10. The board adapter layer never imports a runtime driver, eve, node:sqlite, or reads `process.env`. The core release-observation module never imports board persistence, runtime drivers, eve, or reads `process.env`.
11. `board-store` `BOARD_EVENT_TYPES` and `BOARD_EVENT_AGGREGATE_KINDS` allowlists are extended with the new event types and aggregate kind. No SQL migration is required because the existing CHECK constraints are length-based.
12. The `SqliteReleaseObservationProjector` mirrors the P09-T02 projector pattern: one projector per `(changeId, mergeQueueHash)`, replay + persist + verify through the standard SQLite projection flow, foreign-event filter.

## Phase 10-T02 Starting Point

Proceed to P10-T02 (`t_4e06d5c7`): Wire the release-observation board events into the CLI's existing whole-change acceptance flow.

Phase 10-T02 should consume these inputs:
- `ReleaseObservationBoardAggregatorSuccess.events` as the canonical event stream to append.
- `ReleaseObservationBoardAggregatorSuccess.idempotencyKey` as the re-run idempotency handle.
- `ReleaseObservationReport.status` as the CLI-facing releaseability verdict.
- `SqliteReleaseObservationProjector` as the canonical projection read surface for the CLI's whole-change status command.

Recommended first checks for P10-T02:
1. Read this handoff, `docs/next/evidence/P10-T01/integration-report.yaml`, `packages/board/src/release-observation/contract.ts`, and `packages/store-sqlite/src/release-observation-projector.ts` before editing.
2. Treat the release-observation BoardEvent as an append-only side-effect on the existing whole-change event log. Do not mutate accepted whole-change state in place.
3. Preserve content-addressed handles in the CLI's release-observation report so every canary failure can be traced back to the exact task-run set.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 10 source blocker because the local core/board/store-sqlite/typecheck/validate-next/gitleaks gates passed; CI/release runners should continue to use the declared Node range.
