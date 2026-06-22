# Phase 11 Handoff — Kanban Dashboard and Multi-Project Operations

## Status

DONE (P11-T01 shipped; P11-T02 + P11-T03 still TODO).

Implementation batch: Phase 11 P11-T01 on `codex/p03-t02-board-task-repository` after base `4977cad89a29f1bbad60ee7e940a6f3825de7518`. P11-T01 ships the dashboard projection + approval-gate projection + their SQLite projectors + CLI operator surface (`legion next board dashboard {status|rebuild|verify}` and `legion next board approval-gate {status|rebuild|verify}`). Closeout evidence lives under `docs/next/evidence/P11-T01/`.

Phase 11 opens the Kanban Dashboard and Multi-Project Operations cut line for Legion Next. The dashboard projection reads the existing append-only board event log (task.*, change.*, release.*) and surfaces status counts, event timeline, release-observation verdict pointers, and approval verdict pointers per projectId. The approval-gate projection is a per-(projectId, changeId) reduction that ties Phase 9 whole-change acceptance + Phase 10 release-observation together into a single operator-facing verdict.

## Delivered Surface — P11-T01

### Dashboard projection (board adapter layer)

- `packages/board/src/dashboard/contract.ts`: typed dashboard projection contract — `DashboardProjectionState` (project-scoped, content-addressed), `DashboardEventTailEntry`, `DashboardReleaseObservationPointer`, `DashboardApprovalPointer`, `DashboardTaskStatusCounts`, `DashboardAggregateKindCounts`, projection key helpers.
- `packages/board/src/dashboard/hash.ts`: deterministic SHA-256 helpers — `deriveDashboardProjectionStateHash` over canonical sorted JSON, `sha256OfCanonicalDashboardInput`.
- `packages/board/src/dashboard/reducer.ts`: pure `reduceDashboard` + `replayDashboard` reducers; project-scoped counter surface, foreign-event-safe, tail-bounded timeline (default 25, max 200), per-task live state threaded via the `priorEvents` hint so incremental callers (tests) and full-log callers (CLI projector) both produce identical results.
- `packages/board/src/dashboard/index.ts`: public dashboard barrel.
- `packages/board/test/dashboard-aggregator.test.mjs`: 21 dashboard reducer tests — projection key shape, schema constants, foreign-event safety, replay determinism, status counts (queued/ready/running), tail bound, idempotent timeline push.
- `packages/board/test/dashboard-fixture.mjs`: deterministic task/change/release event builders carrying `projectId`.

### Approval-gate projection (board adapter layer)

- `packages/board/src/approval-gate/contract.ts`: typed approval-gate projection contract — `ApprovalGateProjectionState`, `ApprovalGateVerdict` (`approved` | `rejected` | `blocked` | `pending`), projection key helpers.
- `packages/board/src/approval-gate/reducer.ts`: pure `reduceApprovalGate` + `replayApprovalGate` + `decideApprovalGateVerdict`; fail-closed verdict reduction (approved requires whole-change `accepted` AND release `promoted`; rejected for `rejected`/`regressed`/`rolled_back`; blocked for `blocked`/`escalated`; pending otherwise); foreign-event-safe (only whole-change + release-observation events move the verdict).
- `packages/board/src/approval-gate/index.ts`: public approval-gate barrel.
- `packages/board/test/approval-gate.test.mjs`: 19 approval-gate reducer tests — verdict reduction across all four terminal values, regression rollback, foreign-event safety, malformed payload rejection, release.observed non-terminal handling.
- `packages/board/test/approval-gate-fixture.mjs`: deterministic change/release event builders carrying `projectId`.
- `packages/board/src/index.ts`: board barrel extended with dashboard + approval-gate exports (typed contract, reducer, hash helpers, projection descriptor).

### SQLite-backed projectors (store-sqlite adapter layer)

- `packages/store-sqlite/src/dashboard-projector.ts`: `SqliteDashboardProjector` — `replay` / `rebuildAndSave` / `verify` for the dashboard projection; foreign-event-safe; threads `priorEvents` through the reducer for per-task live state; strips the `sha256:` prefix before persisting the SQLite state hash.
- `packages/store-sqlite/src/approval-gate-projector.ts`: `SqliteApprovalGateProjector` — `replay` / `rebuildAndSave` / `verify` for the approval-gate projection; fail-closed drift detection.
- `packages/store-sqlite/src/index.ts`: store-sqlite barrel extended with dashboard + approval-gate projector exports.
- `packages/store-sqlite/test/dashboard-projector.test.mjs`: 9 dashboard projector tests — replay, rebuild+verify, drift detection on appended event, foreign-project event filtering, constructor validation.
- `packages/store-sqlite/test/dashboard-fixture.mjs`: deterministic task/change/release append-input builders.
- `packages/store-sqlite/test/approval-gate-projector.test.mjs`: 10 approval-gate projector tests — `verdict=approved/rejected/pending`, regression rollback, rebuild+verify, drift detection, foreign-project/change filtering.
- `packages/store-sqlite/test/approval-gate-fixture.mjs`: deterministic change/release append-input builders.

### CLI operator surface

- `packages/cli/src/commands/board/dashboard.ts`: `legion next board dashboard {status|rebuild|verify}` CLI adapter; `projectId` required input; `tailLimit` optional (1..200, default 25).
- `packages/cli/src/commands/board/approval-gate.ts`: `legion next board approval-gate {status|rebuild|verify}` CLI adapter; `projectId` + `changeId` required input.
- `packages/cli/src/commands/board/index.ts`: board command tree extended with the `dashboard` and `approval-gate` domains (and the BOARD_HELP menu).
- `apps/cli-e2e/test/cli-e2e.test.mjs`: 4 new CLI e2e tests — dashboard status/rebuild/verify round-trip, dashboard verify fails closed on missing projection, approval-gate status/rebuild/verify, approval-gate pending on no events.

### Evidence

- `docs/next/evidence/P11-T01/dashboard-snapshot.json`: canonical dashboard projection snapshot for `(proj-p11-t01-snapshot-001, chg-p11-t01-snapshot-001)` with frozen task status counts (queued + ready + running), release-observation pointer, approval pointer, and content-addressed `stateHash`.
- `docs/next/evidence/P11-T01/approval-gate-snapshot.json`: canonical approval-gate snapshot for `(proj-p11-t01-snapshot-001, chg-p11-t01-snapshot-001)` with `verdict=approved` after `change.aggregated(status=accepted)` + `release.promoted`.
- `docs/next/evidence/P11-T01/integration-report.yaml`: structured closeout report (verification evidence, blockers, delivered artifacts, decisions, preserved boundaries, Phase 12 handoff).
- `.legion/project/changes/LEGION-NEXT/implementation/phase-11/ledger.yaml`: phase-11 ledger tracking P11-T01 + P11-T02 + P11-T03 tasks and decisions.
- `.legion/project/changes/LEGION-NEXT/implementation/phase-11/HANDOFF.md`: this file.

## Verification Evidence — P11-T01

- `pnpm --filter @legion/core test` — PASS, 245/245 tests (no core changes).
- `pnpm --filter @legion/board test` — PASS, 93/93 tests (53 existing whole-change/release-observation + 21 new dashboard + 19 new approval-gate).
- `pnpm --filter @legion/store-sqlite test` — PASS, 163/163 tests (144 existing + 9 new dashboard projector + 10 new approval-gate projector).
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests (no protocol changes).
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests (no artifacts changes).
- `pnpm --filter @legion/cli-e2e test` — PASS, 17/17 tests (14 existing + 1 new dashboard CLI + 2 new approval-gate CLI scenarios).
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e`.
- `pnpm run validate:next` — PASS; typecheck, package boundaries, worker bundles, default-runtime scan, runtime import boundaries, schema generation, protocol docs, schema-doc drift, package contents, tests, npm pack dry-run, pnpm pack dry-run.
- `git diff --cached --binary 4977cad89a29f1bbad60ee7e940a6f3825de7518 -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml' ':!.legion/project/changes/LEGION-NEXT/implementation/phase-11/evidence-index.yaml' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 11 diff scan; phase-10/phase-11 evidence indexes excluded to avoid self-referential scan.

Full closeout transcripts are under `docs/next/evidence/P11-T01/`. The structured closeout report is `docs/next/evidence/P11-T01/integration-report.yaml`. The phase-11 ledger is `.legion/project/changes/LEGION-NEXT/implementation/phase-11/ledger.yaml`.

## Dashboard Cut Line

Phase 11 establishes these stable assumptions for downstream phases (P12+):

1. The dashboard projection is **project-scoped**: one projection key per `projectId`. Multi-project boards host multiple dashboards in parallel without collisions. Foreign-project events are silently dropped by the reducer.
2. The approval-gate projection is **change-scoped**: one projection key per `(projectId, changeId)`. The gate is purely derived from `change.*` + `release.*` board events; provider-specific reviewer/approval execution is injected, never hardcoded into the board layer.
3. Both reducers are **foreign-event-safe**: events with mismatching `aggregateKind` / `aggregateId` / `projectId` (dashboard) or `changeId` (approval-gate) are ignored silently so an interleaved board event log replays without throwing.
4. The dashboard reducer is **deterministic over the full event log**: same event log ⇒ same `DashboardProjectionState` ⇒ same `stateHash`. The reducer threads `priorEvents` through `reduceDashboard` so incremental callers (tests) and full-log callers (CLI projector) produce identical results without leaking transient state into the public projection shape.
5. The approval-gate verdict is **fail-closed**:
   - `approved`  ⇐ whole-change `accepted` AND release `promoted`
   - `rejected`  ⇐ whole-change `rejected`, or release `regressed`/`rolled_back` after a promotion
   - `blocked`   ⇐ whole-change `blocked`/`escalated`, or aggregated status `blocked`
   - `pending`   ⇐ otherwise (no terminal verdict yet)
   The verdict is non-invertible: a fresh event with a new `reportSha256` / `mergeQueueHash` is the only way to move off a terminal verdict.
6. The dashboard projection state hash is content-addressed over the canonical sorted JSON: `schemaVersion`, `kind`, `projectId`, `rebuiltThroughGlobalSequence`, `eventCount`, `taskStatusCounts`, `aggregateKindCounts`, `releaseObservationPointers`, `approvalPointers`, `eventTimeline`. The SQLite projector strips the `sha256:` prefix before persisting.
7. The approval-gate projection state hash is content-addressed over the canonical sorted JSON: `schemaVersion`, `kind`, `projectId`, `changeId`, `verdict`, `mergeQueueHash`, `decisionSha256`, `aggregatorHash`, `releaseObservationReportSha256`, `releaseObservationStatus`, `lastEventType`, `lastGlobalSequence`, `lastOccurredAt`, `reason`, `eventCount`, `wholeChangeStatus`, `wholeChangeOutcome`.
8. The dashboard and approval-gate never mutate frozen whole-change or release-observation state. They derive read-only aggregates from the same append-only event log.
9. Provider-specific command execution (canary probes, host monitoring, reviewer/approval workflows) stays outside `@legion/core` and `@legion/board`. The CLI surface is `status`/`rebuild`/`verify` only.
10. Phase 8 per-task, Phase 9 whole-change, and Phase 10 release-observation hashes are preserved so dashboard anomalies and approval-gate decisions can be traced back to exact task and release evidence.
11. The dashboard and approval-gate modules never import a runtime driver, git, eve, board-store (only types), or `node:sqlite`. Those belong to `@legion/store-sqlite` and the CLI adapter layer.
12. Phase 11 does **not** introduce a new app/dashboard package. The dashboard surface lives inside the CLI adapter layer and JSON outputs that any external UI can consume.

## Phase 12 Starting Point

Proceed to P11-T02 (`t_86857911`): Multi-project routing, approval inbox, and operator-friendly JSON snapshots on top of the P11-T01 dashboard + approval-gate projector foundations.

Phase 12 should consume these inputs:

- `DashboardProjectionState` keyed by `dashboard:<projectId>` as the canonical project-scoped read surface (status counts, event timeline, release-observation + approval verdict pointers).
- `ApprovalGateProjectionState` keyed by `approval-gate:<projectId>:<changeId>` as the canonical per-change verdict (approved / rejected / blocked / pending).
- The dashboard + approval-gate audit handles: `changeId`, `mergeQueueHash`, `decisionSha256`, `aggregatorHash`, `reportSha256`, `stateHash`, `observedBy`, `idempotencyKey`.
- Phase 9 whole-change + Phase 10 release-observation hashes as trace-back handles for approval-gate anomalies.

Recommended first checks for P11-T02:

1. Read this handoff, `docs/next/evidence/P11-T01/integration-report.yaml`, `packages/board/src/dashboard/contract.ts`, `packages/board/src/approval-gate/contract.ts`, `packages/store-sqlite/src/dashboard-projector.ts`, `packages/store-sqlite/src/approval-gate-projector.ts`, `packages/cli/src/commands/board/dashboard.ts`, and `packages/cli/src/commands/board/approval-gate.ts` before editing.
2. Treat dashboard + approval-gate state as derived read-only state, not mutate frozen projections.
3. Preserve content-addressed handles in approval inbox + multi-project routing outputs so a red dashboard state can be linked back to the exact task-run, whole-change, and release-observation evidence.
4. Keep host-specific routing / notification command execution outside `@legion/core`; dashboard + approval-gate commands can surface status and evidence, not become probe runners by default.
5. Fail closed on absent, stale, or drifted dashboard or approval-gate projection state.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 11 source blocker because the local core/board/store-sqlite/protocol/artifacts/cli-e2e/typecheck/workspace/validate-next/gitleaks gates passed; CI/release runners should continue to use the declared Node range.