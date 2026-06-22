# Phase 11 Handoff — Kanban Dashboard and Multi-Project Operations

## Status

DONE.

Implementation batch: Phase 11 P11-T01 + P11-T02 + P11-T03 closeout on `codex/p03-t02-board-task-repository` after base `4977cad89a29f1bbad60ee7e940a6f3825de7518`. P11-T01 ships project-scoped dashboard and approval-gate projections, SQLite projectors, and JSON CLI operator commands. P11-T02 ships the tenant-scoped portfolio projection with per-project rollups, cross-project dependency edges, resource allocation ledger, SQLite projector, and JSON CLI operator commands. P11-T03 finalizes the ledger, evidence index, independent review, Operator/UI Beta cut line, and Phase 12 handoff. Closeout evidence lives under `docs/next/evidence/P11-CLOSEOUT/`.

Phase 11 closes the Operator/UI Beta cut line for Legion Next. The branch now carries deterministic operator read models over the append-only board event log: per-project dashboards (`dashboard:<projectId>`), per-change approval gates (`approval-gate:<projectId>:<changeId>`), and tenant-scoped portfolios (`portfolio:<tenantId>`). Each projection can replay, rebuild, and verify drift through the SQLite projection store and can be surfaced as JSON by the CLI without adding an app-specific dashboard package.

## Delivered Surface — P11-T01

### Dashboard projection (board adapter layer)

- `packages/board/src/dashboard/contract.ts`: typed dashboard projection contract — `DashboardProjectionState`, `DashboardEventTailEntry`, release-observation pointers, approval pointers, status/aggregate counters, and projection key helpers.
- `packages/board/src/dashboard/hash.ts`: deterministic SHA-256 helpers over canonical sorted JSON.
- `packages/board/src/dashboard/reducer.ts`: pure `reduceDashboard` / `replayDashboard`; project-scoped task counters, aggregate-kind counts, bounded timeline, release-observation pointers, approval pointers, foreign-event safety, and `priorEvents` support.
- `packages/board/src/dashboard/index.ts`: public dashboard barrel.
- `packages/board/test/dashboard-aggregator.test.mjs`: 21 dashboard reducer tests covering key shape, schema constants, foreign-event safety, replay determinism, status counts, tail bound, idempotent duplicate events, and hash determinism.
- `packages/board/test/dashboard-fixture.mjs`: deterministic task/change/release event builders carrying `projectId`.

### Approval-gate projection (board adapter layer)

- `packages/board/src/approval-gate/contract.ts`: typed approval-gate projection contract — `ApprovalGateProjectionState`, `ApprovalGateVerdict` (`approved | rejected | blocked | pending`), and projection key helpers.
- `packages/board/src/approval-gate/reducer.ts`: pure `reduceApprovalGate` / `replayApprovalGate` / `decideApprovalGateVerdict`; fail-closed verdict reduction over whole-change + release-observation events, rollback/regression handling, and foreign-event safety.
- `packages/board/src/approval-gate/index.ts`: public approval-gate barrel.
- `packages/board/test/approval-gate.test.mjs`: 19 approval-gate reducer tests covering verdict reduction, release rollback, malformed payloads, foreign events, and helper compatibility.
- `packages/board/test/approval-gate-fixture.mjs`: deterministic change/release event builders.
- `packages/board/src/index.ts`: board barrel extended with dashboard and approval-gate exports.

### SQLite-backed dashboard / approval-gate projectors

- `packages/store-sqlite/src/dashboard-projector.ts`: `SqliteDashboardProjector` — replay, rebuild, persist, and verify dashboard projection drift through the standard SQLite projection-store flow.
- `packages/store-sqlite/src/approval-gate-projector.ts`: `SqliteApprovalGateProjector` — replay, rebuild, persist, and verify approval-gate drift for a `(projectId, changeId)` pair.
- `packages/store-sqlite/src/index.ts`: store-sqlite barrel extended with dashboard and approval-gate projector exports.
- `packages/store-sqlite/test/dashboard-projector.test.mjs`: 9 dashboard projector tests.
- `packages/store-sqlite/test/approval-gate-projector.test.mjs`: 10 approval-gate projector tests.

### CLI operator surface — P11-T01

- `packages/cli/src/commands/board/dashboard.ts`: `legion next board dashboard {status|rebuild|verify}`; requires `projectId`, optional `tailLimit`.
- `packages/cli/src/commands/board/approval-gate.ts`: `legion next board approval-gate {status|rebuild|verify}`; requires `projectId` and `changeId`.
- `packages/cli/src/commands/board/index.ts`: board command tree extended with dashboard and approval-gate domains.
- `apps/cli-e2e/test/cli-e2e.test.mjs`: dashboard and approval-gate status/rebuild/verify scenarios, including fail-closed missing-projection behavior.

## Delivered Surface — P11-T02

### Portfolio projection (board adapter layer)

- `packages/board/src/portfolio/contract.ts`: typed portfolio projection contract — `PortfolioProjectionState`, per-project rollups, cross-project dependency edges, resource allocation ledger, tenant/scoped projection helpers, and reducer options.
- `packages/board/src/portfolio/hash.ts`: deterministic SHA-256 helpers over canonical sorted JSON.
- `packages/board/src/portfolio/reducer.ts`: pure `reducePortfolio` / `replayPortfolio` / `makePortfolioReducer`; tenant-scoped multi-project event reduction, per-project rollups, priority bands, claim utilization, blocked pressure, cross-project dependency edge map, optional project scope filter, terminal project count, foreign-event safety, and `priorEvents` support.
- `packages/board/src/portfolio/index.ts`: public portfolio barrel.
- `packages/board/test/portfolio-reducer.test.mjs`: 20 portfolio reducer tests covering projection key, schema constants, foreign-event safety, replay determinism, task accumulation, transitions, priority bands, cross-project dependency edges, same-project edge filtering, release/approval verdict exposure, scope filters, terminal projects, and priorEvents threading.
- `packages/board/test/portfolio-fixture.mjs`: deterministic task/change/release/link event builders carrying `projectId`, `toProjectId`, and relation.

### SQLite-backed portfolio projector

- `packages/store-sqlite/src/portfolio-projector.ts`: `SqlitePortfolioProjector` — replay, rebuild, persist, and verify tenant-scoped portfolio projection drift; scope filter persisted in the projection envelope; state hashes strip the `sha256:` prefix before SQLite persistence.
- `packages/store-sqlite/test/portfolio-projector.test.mjs`: 8 portfolio projector tests covering replay, rebuild+verify, drift, missing projection, scope filter, replay determinism, and constructor validation.
- `packages/store-sqlite/test/portfolio-fixture.mjs`: SQLite event builders for task, link, change, and release portfolio scenarios.

### CLI operator surface — P11-T02

- `packages/cli/src/commands/board/portfolio.ts`: `legion next board portfolio {status|rebuild|verify}`; requires `tenantId`, optional `projectIds` scope filter.
- `packages/cli/src/commands/board/index.ts`: board command tree extended with the portfolio domain.
- `apps/cli-e2e/test/cli-e2e.test.mjs`: 4 portfolio CLI e2e tests — multi-project status/rebuild/verify round-trip, fail-closed missing projection, tenant-wide empty rollup, scoped sub-portfolio.

### Canonical serialized evidence

- `docs/next/evidence/P11-T01/dashboard-snapshot.json`: canonical dashboard projection snapshot for `(proj-p11-t01-snapshot-001, chg-p11-t01-snapshot-001)` with task status counts, release pointer, approval pointer, event timeline, and `stateHash`.
- `docs/next/evidence/P11-T01/approval-gate-snapshot.json`: canonical approval-gate snapshot with `verdict=approved` after whole-change accepted + release promoted.
- `docs/next/evidence/P11-T02/portfolio-snapshot.json`: canonical tenant portfolio snapshot for `tnt-portfolio-snapshot-001` with two projects, cross-project links, release/approval status, resource ledger, and content-addressed `stateHash`.

## Verification Evidence — P11-CLOSEOUT

- `pnpm --filter @legion/cli-e2e test` — PASS, 21/21 tests (P10 release-observation + P11 dashboard/approval-gate/portfolio CLI coverage included).
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 113/113 tests (dashboard, approval-gate, portfolio, release-observation, and whole-change reducers included).
- `pnpm --filter @legion/store-sqlite test` — PASS, 171/171 tests (dashboard, approval-gate, portfolio, release-observation, whole-change projectors included).
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across root and recursive workspace package suites, including `apps/cli-e2e` 21/21.
- `pnpm run validate:next` — PASS; typecheck, package boundaries, worker bundles, default-runtime scan, runtime import boundaries, schema generation, protocol docs, schema-doc drift, package contents, tests, npm pack dry-run, and pnpm pack dry-run completed.
- `git diff --cached --binary 4977cad89a29f1bbad60ee7e940a6f3825de7518 -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-10/evidence-index.yaml' ':!.legion/project/changes/LEGION-NEXT/implementation/phase-11/evidence-index.yaml' ':!docs/next/evidence/P11-CLOSEOUT/gitleaks-p11-diff.log' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 11 diff scan.

Full closeout transcripts are under `docs/next/evidence/P11-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P11-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-11-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-11/evidence-index.yaml`.

## Operator/UI Beta Cut Line

Phase 11 establishes these stable assumptions for downstream phases (P12+):

1. The dashboard projection is **project-scoped**: one projection key per `projectId`, content-addressed by `dashboard:<projectId>`, and safe to replay from a global interleaved event log.
2. The dashboard public state includes task status counts, aggregate-kind counts, bounded event timeline, release-observation pointers, approval pointers, and deterministic state hashes.
3. The approval-gate projection is **change-scoped**: one projection key per `(projectId, changeId)`, content-addressed by `approval-gate:<projectId>:<changeId>`, with fail-closed verdicts over whole-change + release-observation evidence.
4. The portfolio projection is **tenant-scoped**: one projection key per `tenantId`, content-addressed by `portfolio:<tenantId>`, with optional `projectIds` scope included in hash inputs.
5. The portfolio public state includes per-project rollups, cross-project dependency edges, resource allocation ledgers, crossProjectDependencyCount, terminalProjectCount, and deterministic state hashes.
6. Dashboard, approval-gate, and portfolio reducers are foreign-event-safe and deterministic: same event log and scope inputs imply the same projection state and hash.
7. Dashboard, approval-gate, and portfolio projections are derived read-only state. They do not mutate whole-change, release-observation, dashboard, approval-gate, or portfolio state in place.
8. The CLI operator surface is JSON-first and restricted to status/rebuild/verify; host-specific probes, notifications, approvals, V8 migration execution, and bridge commands belong in adapter layers.
9. `@legion/core` remains provider-neutral and does not own these read-side operator projections; `@legion/board` owns pure logical reducers; `@legion/store-sqlite` owns SQLite persistence; `@legion/cli` owns command routing.
10. Phase 8 per-task, Phase 9 whole-change, Phase 10 release-observation, and Phase 11 dashboard/approval-gate/portfolio hashes must be preserved in downstream traces so every operator anomaly remains auditable back to exact evidence.

## Phase 12 Starting Point

Proceed to P12-T01 (`t_ca438233`): Host Bridges and V8 Migration.

Phase 12 should consume these inputs:

- `DashboardProjectionState` keyed by `dashboard:<projectId>` as the canonical project-scoped operator read surface.
- `ApprovalGateProjectionState` keyed by `approval-gate:<projectId>:<changeId>` as the canonical per-change approval verdict and trace-back handle.
- `PortfolioProjectionState` keyed by `portfolio:<tenantId>` as the canonical cross-project read surface for project rollups, dependency edges, and resource allocation.
- P11 JSON CLI commands (`dashboard`, `approval-gate`, `portfolio` status/rebuild/verify) as stable local operator surfaces that a host bridge can invoke or mirror.
- Phase 8/9/10/11 content hashes (`workerContextHash`, whole-change `mergeQueueHash`, release-observation `reportSha256`, dashboard/approval-gate/portfolio `stateHash`) as audit handles for host bridge traces.

Recommended first checks for P12-T01:

1. Read this handoff, `docs/next/evidence/P11-CLOSEOUT/integration-report.yaml`, `docs/next/reviews/PHASE-11-INDEPENDENT-REVIEW.md`, the P11-T01/P11-T02 integration reports, and the dashboard/approval-gate/portfolio contracts before editing.
2. Treat P11 projections as read-only derived state. Host bridge work should append new events and rebuild/verify projections, not patch projection rows directly.
3. Keep host-specific V8 bridge execution outside `@legion/core` and `@legion/board`; adapter/CLI layers may invoke hosts, but board/core state must remain deterministic and provider-neutral.
4. Preserve P11 projection keys and hashes in every operator-facing host bridge trace.
5. Fail closed on absent, stale, drifted, or mismatched projection state.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 11 source blocker because the local CLI e2e, core, board, store-sqlite, protocol, artifacts, typecheck, workspace, validate-next, and gitleaks gates passed; CI/release runners should continue to use the declared Node range.
