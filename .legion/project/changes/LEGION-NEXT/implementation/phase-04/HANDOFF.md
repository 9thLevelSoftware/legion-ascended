# Phase 4 Handoff — Functional Worker Bundles and Persona Purge

## Status

DONE.

Implementation batch: Phase 4 changes on `codex/p03-t02-board-task-repository` after base `28b83d4bee3c003992f5af002b3916a05ddce4bd`, with final closeout evidence under `docs/next/evidence/P04-CLOSEOUT/`.

## Delivered Surface

- `WorkerBundleManifest` in `packages/protocol/src/entities/task-run.ts`: functional `role`, `domain`, non-empty `capabilities`, and nested `promptContentContract` with `instructionsHash`, `requiredSections`, and `forbiddenSections`.
- `docs/next/migration/LEGACY-PERSONA-MAP.md`: 48 legacy v8 persona IDs mapped to functional roles/domain packs for migration-only semantics.
- Four extracted `workflow-common-*` domain packs at version `1.0.0` with `pack_status: extracted`.
- Canonical `bundles/` registry: nine v9 default worker bundle prompt files plus `bundles/index.json`, one per ADR-002 functional role.
- `scripts/validate-worker-bundles.mjs`: manifest schema, capability completeness, prompt hash, forbidden-section, role coverage, and domain-pack integrity validation.
- `scripts/scan-default-runtime.mjs`: automated scanner for the v9 default runtime prompt surface, wired into `validate:next`.
- Regression tests for workflow-common pack metadata, worker bundle validation, persona purge, and default runtime scan behavior.

## Verification Evidence

- `pnpm --filter @legion/protocol test` — PASS, 54/54 tests.
- `node --test tests/workflow-common-packs.test.mjs` — PASS, 1/1 tests.
- `node --test tests/worker-bundles.test.mjs` — PASS, 15/15 tests.
- `node --test tests/default-runtime-scan.test.mjs` — PASS, 8/8 tests.
- `node --test tests/persona-purge.test.mjs` — PASS, 6/6 tests.
- `pnpm run check:worker-bundles` — PASS, 0 schema/capability/domain-pack violations.
- `pnpm run check:default-runtime` — PASS, 15 files scanned, 0 violations.
- `pnpm run check:boundaries` — PASS.
- `pnpm run check:package-contents` — PASS.
- `pnpm run typecheck` — PASS.
- `pnpm -r --if-present test` — PASS, 312/312 workspace-package tests.
- `pnpm run validate:next` — PASS, 389/389 combined root/workspace tests and all validate-next gates.
- `gitleaks detect --source . --log-opts=28b83d4..HEAD --redact --no-banner` — PASS.

Full transcripts are under `docs/next/evidence/P04-CLOSEOUT/`.

## Phase 5 Starting Point

Phase 5 can implement the RuntimeDriver/Eve adapter against these stable assumptions:

1. Task runs carry a frozen, provider-neutral worker bundle contract: runtime, worker bundle, model, input, repository, workspace, policy, and idempotency metadata remain separate.
2. Runtime dispatch should select one of the nine ADR-002 functional roles, not a legacy persona ID.
3. Worker prompt content is content-addressed by `promptContentContract.instructionsHash`; runtime implementations must fail closed if rendered prompt bytes drift.
4. `promptContentContract.forbiddenSections` must continue to include biography, tone, and personality; runtime prompt assembly must not add those sections from adapter-specific templates.
5. `workflow-common-core` is the always-load shared pack; the github, memory, and domains packs are available as extracted v1.0.0 packs for opt-in bundle/domain routing.
6. Legacy persona IDs may be used only to interpret imported v8 plans, outcomes, and evidence; they are not a v9 default runtime router.
7. `validate:next` now runs worker-bundle validation and the default-runtime persona scan before schema generation and drift checks.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 4 source blocker because all local gates passed; CI/release runners should continue to use the declared Node range.

A pre-stage `validate:next` run failed only at generated schema/doc drift because the P04-T01 generated schema/fixture changes were not yet staged. After staging the generated schema artifacts, the final `validate:next` run passed. The diagnostic failure log is preserved as `docs/next/evidence/P04-CLOSEOUT/validate-next-prestage-failure.log`.

## Handoff Recommendation

Proceed to P05-T01 after this closeout commit is pushed and the GitHub PR/CI gate confirms the same verification set. Runtime-driver work should treat ADR-004 as the provider-neutral lifecycle contract and use this Phase 4 worker-bundle contract as the dispatch/prompt-content input surface.
