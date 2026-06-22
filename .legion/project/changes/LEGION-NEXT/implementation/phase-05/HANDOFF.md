# Phase 5 Handoff — Runtime Driver and Eve Integration

## Status

DONE.

Implementation batch: Phase 5 changes on `codex/p03-t02-board-task-repository` after base `43d059902f5dc35fc2604e2bd22b076186d8f5d7`, with final closeout evidence under `docs/next/evidence/P05-CLOSEOUT/`.

Phase 5 closes the Durable Operational Kernel cut line for Legion Next. The branch now carries a provider-neutral ADR-004 `RuntimeDriver` contract, deterministic `runtime-local`, certified `runtime-eve`, reduced-guarantee `runtime-legacy-cli`, a tested fallback selector, runtime import-boundary enforcement, and a Phase 6-ready evidence/review bundle.

## Delivered Surface

- `packages/core/src/runtime/contract.ts`: canonical provider-neutral RuntimeDriver interface with the seven ADR-004 lifecycle methods: start, resume, cancel, inspect, stream, approve, and artifact.
- `packages/core/src/runtime/local-driver.ts`: deterministic in-memory `runtime-local` driver emitting Legion protocol events, checkpoint generations, approvals, terminal stream events, and final-output artifact bundles.
- `packages/core/src/runtime/legacy-cli-driver.ts`: transitional `runtime-legacy-cli` compatibility driver with explicit reduced checkpoint, stream, and artifact guarantees.
- `packages/core/src/runtime/selector.ts`: core fallback selector with default precedence `runtime-eve -> runtime-local -> runtime-legacy-cli` and fail-closed requested-driver behavior.
- `packages/runtime-eve/`: isolated `@legion/runtime-eve` adapter package with driver, transport boundary, fake and real transports, subagent/sandbox/eval helpers, and public-contract certification tests.
- `scripts/scan-runtime-import-boundaries.mjs` and `tests/runtime-import-boundaries.test.mjs`: validate-next guard preventing Eve, host CLI, sqlite, non-protocol workspace imports, deep workspace imports, and legacy prompt assets from entering `packages/core/src/runtime/`.
- `docs/next/runtime-fallback-policy.md`: operator-facing fallback policy and reduced-guarantee notes.

## Verification Evidence

- `pnpm --filter @legion/core test` — PASS, 127/127 tests. Covers runtime-local, runtime-legacy-cli, selector, skeleton/fake driver, and core lifecycle regressions.
- `pnpm --filter @legion/runtime-eve test` — PASS, 29/29 tests. Covers runtime-eve public contract, transport behavior, subagent/sandbox/eval helpers, and package-level fallback selection.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS, 532/532 counted root/workspace tests.
- `pnpm run validate:next` — PASS, including typecheck, package boundaries, worker bundles, default-runtime scan, runtime-import-boundaries, schema/doc drift, package contents, workspace tests, and pack dry-run.
- `gitleaks detect --source . --log-opts=43d059902f5dc35fc2604e2bd22b076186d8f5d7..HEAD --redact --no-banner` — PASS, 10 commits scanned, no leaks found.

Full transcripts are under `docs/next/evidence/P05-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P05-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-05-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-05/evidence-index.yaml`.

## Durable Operational Kernel Cut Line

Phase 5 establishes these stable assumptions for downstream phases:

1. Runtime consumers depend on the `RuntimeDriver` contract from `@legion/core`, not on Eve internals or host CLI APIs.
2. `runtime-eve` is the preferred durable runtime candidate when registered and available.
3. `runtime-local` remains the deterministic local/test fallback and must continue to produce provider-neutral protocol events.
4. `runtime-legacy-cli` is a compatibility fallback only; its reduced guarantees are documented, test-visible, and should remain audit-visible in Phase 6+ evidence.
5. Requested-driver overrides must fail closed when unavailable instead of silently downgrading.
6. Runtime import boundaries are part of `validate:next`; future runtime work must keep Eve/CLI/sqlite imports outside `packages/core/src/runtime/`.
7. Worker bundle prompt content from Phase 4 remains data passed into runtime manifests; provider adapters must not reintroduce legacy persona routing or prompt prose.

## Phase 6 Starting Point

Proceed to P06-T01 (`t_5008bcfb`): Baseline specification schema — oracle manifest, baseline corpus governance, scoring fixtures, and hashes from `evals/baseline`.

Phase 6 should build baseline/oracle artifacts against these inputs:

- Phase 5 RuntimeDriver contract and fallback policy.
- Phase 4 functional worker bundles and prompt-content contract.
- Phase 2 traceability/artifact model and evidence-index patterns.
- The Phase 5 closeout report and review artifacts named above.

Recommended first checks for P06-T01:

1. Read this handoff, `docs/next/runtime-fallback-policy.md`, and the Phase 6 source document before editing.
2. Treat runtime output artifacts as RuntimeDriver final-output/evidence references, not provider-specific Eve objects.
3. Store baseline/oracle hashes in durable evidence files and wire any new validation into `validate:next` before P06 closeout.
4. Preserve fail-closed behavior for missing or mismatched oracle/baseline hashes; do not let Phase 6 fixtures silently regenerate without review evidence.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 5 source blocker because every local gate passed; CI/release runners should continue to use the declared Node range.
