# Phase 7 Handoff — Planner Task Contracts and Preflight

## Status

DONE.

Implementation batch: Phase 7 changes on PR integration branch `codex/p03-t02-board-task-repository` after base `e7246c06ab670c56ba8ad2509e9a19c72de65eff`, with final closeout evidence under `docs/next/evidence/P07-CLOSEOUT/`.

Phase 7 closes the Planner Task Contracts and Preflight cut line for Legion Next. The branch now carries protocol-visible task-contract wave decomposition, explicit agent assignment, regenerated lifecycle fixtures and JSON Schema artifacts, and a fail-closed `preflightTaskContract` validator for dependency, resource, predecessor-artifact, and completeness checks.

## Delivered Surface

- `packages/protocol/src/entities/task-contract.ts`: canonical TaskContract schema now includes `wave` and `agents`, rejects duplicate agent assignments, exports `preflightTaskContract`, and returns structured issue codes for preflight failures.
- `packages/protocol/test/lifecycle.test.mjs`: lifecycle tests now assert wave/agent fields, validate the new preflight success/failure paths, and preserve existing unsafe-scope and verification-contract checks.
- `schemas/entities/fixtures/lifecycle-valid.json` and `schemas/entities/fixtures/lifecycle-invalid.json`: lifecycle fixtures updated for the new TaskContract shape.
- `schemas/entities/task-contract.schema.json` and `schemas/artifacts/taskgraph.schema.json`: generated schema artifacts refreshed to expose the new contract fields to protocol/artifact consumers.
- `packages/artifacts/test/archive.test.mjs`, `packages/artifacts/test/change-support.test.mjs`, and `packages/artifacts/test/traceability.test.mjs`: artifact service tests updated to consume the revised TaskContract contract shape.

## Verification Evidence

- `pnpm --filter @legion/protocol test` — PASS, 55/55 package tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 package tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS, 538/538 counted root/workspace tests.
- `pnpm run validate:next` — final closeout gate; transcript under `docs/next/evidence/P07-CLOSEOUT/validate-next.log`.
- `gitleaks detect` over the P07 worktree diff — final closeout security gate; transcript under `docs/next/evidence/P07-CLOSEOUT/gitleaks-p07-diff.log`.

Full transcripts are under `docs/next/evidence/P07-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P07-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-07-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-07/evidence-index.yaml`.

## Planner / Preflight Cut Line

Phase 7 establishes these stable assumptions for downstream phases:

1. Planner output can be represented as a TaskContract with explicit execution wave and unique assigned agents.
2. Preflight checks must run before execution and fail closed when dependencies, predecessor artifacts, or assigned agents are unavailable.
3. A task contract is incomplete unless it carries at least one source/design/predecessor context reference and declares at least one expected completion artifact.
4. Preflight failures are structured as `dependency_unsatisfied`, `resource_unavailable`, or `contract_incomplete` issues with paths suitable for user/operator reporting.
5. Generated schemas and lifecycle fixtures are part of the contract boundary; future TaskContract changes must refresh them and pass generated-drift checks.
6. Phase 6 hidden-oracle and fixture-hash boundaries still apply: planner/preflight context must reference public inputs and predecessor artifacts without exposing evaluator-only oracle material.
7. Runtime execution remains Phase 5 RuntimeDriver-neutral; preflight validates contract readiness and must not depend on provider-specific Eve/private-host state.

## Phase 8 Starting Point

Proceed to P08-T01 (`t_1111b940`): Fresh context execution — dispatcher spawns fresh worker contexts per task with no cross-task memory bleed.

Phase 8 should build fresh-context task execution against these inputs:

- Phase 7 TaskContract schema with wave/agents/preflight issue contracts.
- Phase 6 canonical baseline/oracle artifacts and sealed evaluator boundaries.
- Phase 5 RuntimeDriver contract, runtime-local evidence behavior, and fallback policy.
- Phase 4 worker bundle prompt-content contract.
- Phase 3 transactional board/task services and durable event/evidence records.

Recommended first checks for P08-T01:

1. Read this handoff, `docs/next/evidence/P07-CLOSEOUT/integration-report.yaml`, and `packages/protocol/src/entities/task-contract.ts` before editing.
2. Spawn each worker with a fresh context derived from the TaskContract, not from previous task memory or session-global prose.
3. Run `preflightTaskContract` before claiming/dispatching work and map structured issues into board blockers or operator-visible diagnostics.
4. Keep worker-visible context scoped to `context.specRefs`, `context.designRefs`, and approved predecessor artifact references; do not leak hidden oracle assertions or prior worker scratch state.
5. Preserve RuntimeDriver neutrality: execution manifests should reference contract hashes, worker bundles, and runtime outputs rather than provider-specific objects.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 7 source blocker because the local protocol/artifacts/typecheck/workspace gates passed; CI/release runners should continue to use the declared Node range.
