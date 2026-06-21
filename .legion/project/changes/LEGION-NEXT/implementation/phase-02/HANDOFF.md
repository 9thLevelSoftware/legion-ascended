# Phase 2 Handoff

## Status

PASS

## Delivered Capabilities

- Git-tracked project artifact path contract rooted at `.legion/project`.
- Atomic, revisioned artifact writes with content hashes, CAS checks, and path-security guards.
- Project manifest and constitution service with idempotent init, dry-run support, validation, and `.legion/var` ignore ownership.
- Current-spec Markdown service with deterministic derived index, semantic diff helpers, rename/deprecate/update flows, and typed diagnostics.
- Change-bundle services for proposal, delta specs, design, decision logs, stale-base validation, and deterministic diffing.
- Reviewable oracle artifacts, taskgraphs, evidence indexes, artifact manifest hashing, and provenance validation.
- Traceability graph validation and invalidation/impact analysis across requirements, oracles, tasks, evidence, reviews, and artifacts.
- Accepted-change archive planning/apply service with evidence gates, stale-base checks, idempotency, and rollback safety.
- Legacy `.planning` import dry-run/apply/rollback with checksummed backups, explicit review requirement, source preservation, lexical and symlink-resolved backup-root safety across repository, `.legion`, planning source, and staging boundaries, and rollback manifest integrity checks.
- Codex `.legion` migration dry-run/apply/rollback that preserves legacy protocol bytes under `.legion/legacy-protocol`.
- Noninteractive `legion next ...` CLI surface over Phase 2 services and process-level E2E coverage.

## Public Contracts And Schemas

- Path contract: `docs/next/artifacts/PATH-CONTRACT.md`.
- Artifact services package: `packages/artifacts/src/index.ts`.
- Legacy migration bridge package: `packages/legacy-bridge/src/index.ts`.
- CLI package: `packages/cli/src/index.ts`.
- Generated artifact schemas: `schemas/artifacts/*.schema.json`.
- Generated protocol schemas and docs: `schemas/protocol/*.schema.json`, `docs/next/protocol/*.md`.

Phase 3 should consume Phase 2 through the exported package APIs, not by rewriting artifact files directly.

## Decisions And Deviations

- Project manifest path is `.legion/project/project.json`, following the accepted P02-T01 path contract. The older Phase 2 prose that mentioned `project.yaml` is stale.
- `.legion/project` is committed reviewable intent. `.legion/var` is ignored operational state and is the correct root for the Phase 3 board store.
- Legacy Codex protocol bytes are preserved under `.legion/legacy-protocol`; Phase 3 initialization and runtime code should treat that namespace as migrated legacy input, not mutable board state.
- `@legion/legacy-bridge` owns v8 source-format migration policy so artifact services stay focused on v9 project truth.
- The root package `legion` binary remains the v8-compatible installer entrypoint. The v9 CLI surface is explicitly namespaced under `legion next ...`.
- The long-running directive's absolute roadmap path `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-roadmap.md` does not exist. The checked-in roadmap index `docs/legion-next-roadmap.md` and the v8 rebuild phase documents are the active sources.

## Verification Summary

- `pnpm --filter @legion/legacy-bridge test`: PASS, 30 tests. Evidence: `docs/next/evidence/P02-CLOSEOUT/legacy-bridge-test.log`.
- `pnpm --filter @legion/artifacts test`: PASS, 59 tests. Evidence: `docs/next/evidence/P02-CLOSEOUT/artifacts-test.log`.
- `pnpm --filter @legion/cli-e2e test`: PASS, 9 tests. Evidence: `docs/next/evidence/P02-CLOSEOUT/cli-e2e-test.log`.
- `pnpm run validate:next`: PASS. Evidence: `docs/next/evidence/P02-CLOSEOUT/validate-next.log`.
- Independent phase review: PASS. Evidence: `docs/next/reviews/PHASE-02-INDEPENDENT-REVIEW.md`.

## Known Risks And Deferred Work

- Phase 3 still needs the operational board/store implementation under `.legion/var`; Phase 2 only establishes the committed artifact model and migration surface it must not overwrite.
- Phase 3 should keep board status, leases, queues, retry state, and runtime cursors out of `.legion/project`.
- The v9 CLI is intentionally private and namespaced. Packaging/publishing changes belong to later host-bridge and migration phases.

## Exact Starting Point For The Next Phase

- Current verified base before closeout PR: `70cea9a73cf862f1459ee9383844edef068dbd11`.
- Phase 3 should start from the merge commit that accepts this closeout PR into `main`.
- Source document: `C:/Users/dasbl/Documents/legion/docs/rebuild/03-phase-transactional-kanban-control-plane.md`.
- Required artifacts:
  - `docs/legion-next-roadmap.md`.
  - `docs/next/artifacts/PATH-CONTRACT.md`.
  - `.legion/project/changes/LEGION-NEXT/implementation/phase-02/ledger.yaml`.
  - `.legion/project/changes/LEGION-NEXT/implementation/phase-02/evidence-index.yaml`.
  - `docs/next/evidence/P02-CLOSEOUT/integration-report.yaml`.
  - `docs/next/reviews/PHASE-02-INDEPENDENT-REVIEW.md`.
- Exact ignored operational root for Phase 3 store: `.legion/var`.
- Recommended first task: P03-T01, create the transactional board/store package boundary, database schema, and migration runner without writing mutable status into Git-tracked artifacts.
