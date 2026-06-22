# Phase 12 Handoff — Host Bridges and V8 Migration

## Status

DONE.

Implementation batch: Phase 12 P12-T01 + P12-T02 + P12-T03 closeout changes on PR integration branch `codex/p03-t02-board-task-repository` after base `33ddf60180235dcb1a852838f6559a8cbecb7c11`. P12-T01 aligns the host bridge documentation with `bin/runtime-metadata`, refreshes the README package checksum, and adds a regression test that keeps README/runtime-audit/certification docs aligned with runtime metadata. P12-T02 exposes `legion next migrate --verify` as an explicit compatibility verification alias for the existing dry-run migration path and covers it in Codex legacy migration CLI e2e. P12-T03 finalizes the ledger, evidence index, independent review, Migration/Host Beta cut line, and Phase 13 handoff. Closeout evidence lives under `docs/next/evidence/P12-CLOSEOUT/`.

Phase 12 closes the Migration/Host Beta cut line for Legion Next. The branch now carries a metadata-aligned host bridge support matrix, package checksum coverage for shipped README changes, a docs alignment regression test, and an explicit non-mutating migration verification flag that preserves legacy source bytes before apply/rollback.

## Delivered Surface — P12-T01

### Host bridge matrix and package checksum alignment

- `README.md`: describes the supported host surface as **10 installable AI CLI runtimes plus the Kilo Code plugin** and calls out Aider as manual-only instead of counting it as an installable CLI runtime.
- `checksums.sha256`: refreshes the README checksum so installer/package verification stays green after the documentation update.
- `tests/runtime-bridge-docs.test.mjs`: root regression test asserting runtime metadata exposes 10 installable CLI runtimes plus Kilo Code plugin support and that README, `docs/runtime-audit.md`, and `docs/runtime-certification-checklists.md` mention every runtime metadata label.

## Delivered Surface — P12-T02

### Legacy migration compatibility verification

- `packages/cli/src/commands/migrate/index.ts`: help text now advertises `--verify` for planning and Codex migration sources; action parsing maps `--verify` to the existing dry-run migration action.
- `packages/cli/src/index.ts`: root CLI help now describes migration as verify/dry-run/apply/rollback.
- `apps/cli-e2e/test/cli-e2e.test.mjs`: Codex legacy migration e2e now invokes `--verify`, asserts the result is the existing `dry_run` status, checks that the legacy source tree hash is preserved, then still verifies apply and rollback restore source bytes.
- `docs/next/evidence/P12-T02/integration-report.yaml`: structured task-level report for the verify alias.

## Verification Evidence — P12-CLOSEOUT

- `node --test tests/runtime-bridge-docs.test.mjs` — PASS, 1/1 tests.
- `pnpm --filter @legion/cli-e2e test` — PASS, 21/21 tests.
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 113/113 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 171/171 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across root and recursive workspace package suites, including `apps/cli-e2e` 21/21.
- `pnpm run validate:next` — PASS in pre-closeout verification; final closeout transcript is `docs/next/evidence/P12-CLOSEOUT/validate-next.log`.
- `git diff --cached --binary 33ddf60180235dcb1a852838f6559a8cbecb7c11 -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-12/evidence-index.yaml' ':!docs/next/evidence/P12-CLOSEOUT/gitleaks-p12-diff.log' | gitleaks detect --pipe --no-color --redact` — PASS, no leaks found in the final Phase 12 diff scan.

Full closeout transcripts are under `docs/next/evidence/P12-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P12-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-12-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-12/evidence-index.yaml`.

## Migration/Host Beta Cut Line

Phase 12 establishes these stable assumptions for downstream phases (P13+):

1. `bin/runtime-metadata` is the canonical source for runtime bridge names, support tiers, native surfaces, and installability.
2. The shipped README describes the host bridge support envelope as 10 installable AI CLI runtimes plus Kilo Code plugin support; Aider is present as an experimental manual-only fallback and is not counted as installable.
3. README changes remain package-verified through `checksums.sha256`.
4. Runtime bridge docs across README, runtime audit, and certification checklists are covered by a metadata-alignment regression test.
5. Legacy migration compatibility verification is explicit: `legion next migrate --verify` routes to the existing dry-run path and returns `status: dry_run`.
6. `--verify` must be non-mutating: it stages/reports compatibility results without changing the legacy `.legion` source tree.
7. Migration apply and rollback remain a single safety chain: verify/dry-run first, apply with backups/review acceptance, rollback from backup manifest, source hash restored.
8. Host-specific bridge execution remains in installer/CLI/adapter surfaces. `@legion/core` and `@legion/board` remain provider-neutral and deterministic.
9. Phase 8 per-task, Phase 9 whole-change, Phase 10 release-observation, Phase 11 operator projections, and Phase 12 host/migration evidence are now the cut-line evidence set for release-grade P13 evals.

## Phase 13 Starting Point

Proceed to P13-T01 (`t_12f977b4`): Behavioral evals — release-grade workflow evals with v8/v9 A/B comparison on sealed scenarios.

Phase 13 should consume these inputs:

- Runtime bridge matrix and docs-alignment test as the host support baseline.
- `legion next migrate --verify` as the compatibility preflight for migration scenarios.
- Codex legacy migration e2e evidence proving verify/apply/rollback preserve user artifacts and legacy source bytes.
- Phase 8/9/10/11 content-addressed handles plus Phase 12 host/migration evidence as trace-back references in sealed v8/v9 eval runs.

Recommended first checks for P13-T01:

1. Read this handoff, `docs/next/evidence/P12-CLOSEOUT/integration-report.yaml`, `docs/next/reviews/PHASE-12-INDEPENDENT-REVIEW.md`, `tests/runtime-bridge-docs.test.mjs`, `packages/cli/src/commands/migrate/index.ts`, and `apps/cli-e2e/test/cli-e2e.test.mjs` before editing.
2. Treat absent, stale, or drifted host/migration evidence as fail-closed eval diagnostics, not as green release evidence.
3. Include at least one sealed scenario that exercises host bridge selection/installability claims and one that exercises migration verify/apply/rollback preservation.
4. Preserve user artifacts and legacy bytes during eval dry-runs.
5. Keep eval/security execution in adapter/test harness layers unless the code is deterministic protocol/core logic.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 12 source blocker because the local runtime-docs, CLI e2e, core, board, store-sqlite, protocol, artifacts, typecheck, workspace, validate-next, and gitleaks gates passed; CI/release runners should continue to use the declared Node range.
