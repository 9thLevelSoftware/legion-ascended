# Phase 6 Handoff — Baseline Specification and Oracle Pipeline

## Status

DONE.

Implementation batch: Phase 6 changes on `codex/p03-t02-board-task-repository` after base `240ace3dd7a54444d04abdc81557994288729dae`, with final closeout evidence under `docs/next/evidence/P06-CLOSEOUT/`.

Phase 6 closes the Baseline Specification and Oracle Pipeline cut line for Legion Next. The branch now carries a canonical baseline corpus manifest, manifest and oracle-assertion schemas, sealed hidden-oracle fixture governance, LF-normalized fixture hashing, baseline harness documentation updates, and review evidence proving the existing artifact/oracle/taskgraph/evidence-index pipeline enforces manifest hashing and provenance checks.

## Delivered Surface

- `evals/baseline/manifest.yaml`: canonical corpus manifest for `legion-v8-baseline-corpus@1.0.0`, including source baseline identity, public/evaluator roots, fixture-hash policy, scoring rubric, and eight scenario records.
- `evals/baseline/schema/manifest.schema.json`: reviewable schema for the canonical manifest, including fixed scenario families, risk tiers, hidden-material policy, and baseline commit format.
- `evals/baseline/schema/oracle-assertions.schema.json`: evaluator-only oracle assertion schema requiring `visible_to_worker: false`, critical assertions, and calibration examples.
- `evals/baseline/schema/corpus-manifest.schema.json` and `evals/baseline/schema/score.schema.json`: tightened alias/score schemas aligned to the canonical manifest and scoring model.
- `evals/baseline/fixture-hashes.sha256`: lowercase SHA-256 digests over LF-normalized UTF-8 fixture bytes using POSIX-relative paths.
- `tests/baseline-spec.test.mjs`: regression coverage for manifest governance, alias sealing, scenario held-out paths, oracle assertion visibility, and fixture-hash canonicalization.
- `docs/next/baseline/*`, `evals/baseline/README.md`, and `scripts/baseline/*`: operator-facing baseline corpus, scoring, harness, and PowerShell capture documentation updates.
- `docs/next/evidence/P06-T02/oracle-taskgraph-proof.json`: proof that the existing `@legion/artifacts` services satisfy oracle/taskgraph/evidence-index hashing and provenance acceptance.

## Verification Evidence

- `node --check tests/baseline-spec.test.mjs` — PASS.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 package tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS, 537/537 counted root/workspace tests.
- `pnpm run validate:next` — PASS, including typecheck, package boundaries, worker bundles, default-runtime scan, runtime-import-boundaries, schema/doc drift, package contents, workspace tests, and pack dry-run.
- `gitleaks detect` over the P06 worktree diff — PASS, no leaks found.

Full transcripts are under `docs/next/evidence/P06-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P06-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-06-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-06/evidence-index.yaml`.

## Baseline / Oracle Cut Line

Phase 6 establishes these stable assumptions for downstream phases:

1. Planner/preflight code consumes `evals/baseline/manifest.yaml` as the baseline corpus source of truth; `corpus-manifest.yaml` remains a sealed alias pointer.
2. Evaluator-only oracle material remains under `evals/fixtures/evaluator` and must not be copied into worker context packets, planner prompts, or runtime manifests.
3. Fixture hashes are lowercase SHA-256 over LF-normalized UTF-8 text with POSIX-relative paths; changes require explicit version/impact evidence.
4. Scenarios remain the eight accepted Phase 0 families with risk tiers R1/R2/R3 as declared in the canonical manifest.
5. Runtime outputs from Phase 5 should be referenced as RuntimeDriver final-output/evidence records, not provider-specific Eve internals.
6. Artifact/oracle/taskgraph/evidence-index services must keep revalidating manifest hashes and provenance on read; accepted evidence references should stay durable without retaining bulk logs.
7. `validate:next` remains the broad gate before phase closeout and includes the P06 baseline-spec tests through the root test suite.

## Phase 7 Starting Point

Proceed to P07-T01 (`t_8c382c22`): Planner Task Contracts and Preflight.

Phase 7 should build planner/preflight contracts against these inputs:

- Phase 6 canonical baseline manifest and oracle assertion schemas.
- Phase 6 fixture-hash normalization and hidden-oracle visibility rules.
- Phase 6 artifact/oracle/taskgraph/evidence-index provenance proof.
- Phase 5 RuntimeDriver contract and runtime fallback policy.
- Phase 4 functional worker bundles and prompt-content contract.

Recommended first checks for P07-T01:

1. Read this handoff, the Phase 6 closeout report, and `docs/next/baseline/BENCHMARK-CORPUS.md` before editing.
2. Define planner task contracts so they reference baseline scenario IDs and public inputs without exposing evaluator-only assertions.
3. Add preflight validation for manifest/schema/hash consistency before a planner run can be accepted.
4. Preserve fail-closed behavior for missing hashes, stale taskgraph inputs, or provenance mismatches.
5. Keep planner packets provider-neutral and RuntimeDriver-aligned; do not introduce Eve/private-host assumptions into planner contracts.

## Accepted Warnings

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 6 source blocker because every local gate passed; CI/release runners should continue to use the declared Node range.

PowerShell is not installed in this environment, so `scripts/baseline/capture-run.ps1` was verified by code inspection and the Node/Pnpm gates rather than direct `pwsh` execution.
