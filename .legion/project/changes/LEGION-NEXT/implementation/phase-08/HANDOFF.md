# Phase 8 Handoff — Fresh Context Task Execution and Per-Task Review

## Status

DONE.

Implementation batch: Phase 8 changes on `codex/p03-t02-board-task-repository` after base `ef0581f8803dc13e1975a8f049515afff21cec28`, with final closeout evidence under `docs/next/evidence/P08-CLOSEOUT/`.

Phase 8 closes the CLI-first MVP cut line for Legion Next. The branch now carries fresh-context task execution and per-task review/acceptance primitives: each task can be preflighted, isolated into a frozen WorkerContext, deterministically verified, independently reviewed, and mapped into an accepted/rejected/escalated task decision before Phase 9 performs merge-queue and whole-change aggregation.

## Delivered Surface

- `packages/core/src/dispatch/*`: FreshContextDispatcher, WorkerContext contract, deterministic worker context hash/isolation tag, worker bundle selection, structured issue rendering, and issue-to-board-blocker mapping.
- `packages/core/src/review/*`: PerTaskReviewPipeline, deterministic verification runner contract, independent reviewer record, ADR-006 acceptance gate evaluator, deterministic hashes, rendering helpers, and public barrel exports.
- `packages/core/test/dispatch.test.mjs`: P08-T01 coverage for ready dispatch, all preflight/resource/scope failure paths, no extra context keys, deep-freeze invariants, determinism, provider-neutral source scan, and board-blocker rendering.
- `packages/core/test/review.test.mjs`: P08-T02 coverage for verification failures, missing runner, reviewer independence, blocking findings without evidence, R0-R3 behavior, custom policy, deep-freeze invariants, hash determinism, and provider-neutral source scan.
- `docs/next/evidence/P08-T01/worker-context.json`: canonical serialized WorkerContext output.
- `docs/next/evidence/P08-T02/review-pipeline-result.json`: canonical serialized per-task review pipeline output.

## Verification Evidence

- `pnpm --filter @legion/core test` — PASS, 185/185 package tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 package tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 package tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across the root and recursive workspace package suites, including `apps/cli-e2e` 10/10.
- `pnpm run validate:next` — final closeout gate; transcript under `docs/next/evidence/P08-CLOSEOUT/validate-next.log`.
- `git diff --binary ef0581f...HEAD -- ':!.legion/project/changes/LEGION-NEXT/implementation/phase-08/evidence-index.yaml' | gitleaks detect --pipe --no-color --redact` — final full Phase 8 diff secret scan, excluding the self-referential hash index; transcript under `docs/next/evidence/P08-CLOSEOUT/gitleaks-p08-diff.log`.

Full transcripts are under `docs/next/evidence/P08-CLOSEOUT/`. The structured closeout report is `docs/next/evidence/P08-CLOSEOUT/integration-report.yaml`; the independent review is `docs/next/reviews/PHASE-08-INDEPENDENT-REVIEW.md`; the SHA-256 artifact index is `.legion/project/changes/LEGION-NEXT/implementation/phase-08/evidence-index.yaml`.

## CLI-First MVP Cut Line

Phase 8 establishes these stable assumptions for downstream phases:

1. A worker-visible task input is a fresh `WorkerContext` derived from a preflighted `TaskContract`, never from previous worker scratch state or session memory.
2. `WorkerContext` is content-addressed, deeply frozen, and constrained to the `WORKER_CONTEXT_KEYS` allowlist.
3. Dispatch failures remain structured: P07 preflight issue codes are preserved, and Phase 8 adds `context_reference_out_of_scope` for unresolved source/design references.
4. Per-task verification is deterministic and injected; core review code does not spawn CLI processes, import RuntimeDriver implementations, import board persistence, or read `process.env`.
5. Independent review is enforced by actor identity; implementers cannot approve their own task output, and blocking findings must cite evidence refs.
6. Per-task acceptance has three outcomes: `accepted`, `rejected`, and `escalated`; R3 gates intentionally escalate for explicit approval rather than being silently accepted or rejected.
7. Phase 6 hidden-oracle boundaries still apply: worker/reviewer-visible data must be public task/evidence/artifact references, not evaluator-only oracle assertions.
8. Source-scan tests that inspect TypeScript files must use `fileURLToPath(new URL(...))` rather than URL.pathname so Windows CI does not synthesize duplicate drive-letter paths.

## Phase 9 Starting Point

Proceed to P09-T01 (`t_cf3bdb25`): Merge queue — ordered merge queue with conflict detection, rebase, and sequential integration.

Phase 9 should build merge queue and whole-change acceptance against these inputs:

- Phase 8 `WorkerContext.workerContextHash` and `isolationTag` as the immutable task-run identity handles.
- Phase 8 `PerTaskReviewPipelineResult.reviewPipelineHash`, `VerificationReport.reportSha256`, `ReviewRecord.reviewSha256`, and `AcceptanceDecision.decisionSha256` as task-level acceptance handles.
- Phase 7 TaskContract/preflight data as the planning/source-of-truth boundary.
- Phase 6 oracle sealing rules and Phase 5 RuntimeDriver neutrality.

Recommended first checks for P09-T01:

1. Read this handoff, `docs/next/evidence/P08-CLOSEOUT/integration-report.yaml`, `packages/core/src/dispatch/contract.ts`, and `packages/core/src/review/contract.ts` before editing.
2. Model merge queue entries as ordered, conflict-detectable records that reference accepted task-level review evidence, not unstructured prose summaries.
3. Reject or block whole-change integration if any task decision is `rejected`; preserve `escalated` as an explicit approval route.
4. Keep rebase/conflict detection deterministic and auditable; record command outputs as evidence artifacts for whole-change acceptance.
5. Preserve hidden-oracle and provider-neutral boundaries while aggregating task results.

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The warning is not a Phase 8 source blocker because the local core/protocol/artifacts/typecheck/workspace/validate-next/gitleaks gates passed; CI/release runners should continue to use the declared Node range.
