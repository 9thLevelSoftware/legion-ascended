# Phase 9 Independent Review

## Status

PASS

## Scope

- Phase: P09 - Merge Queue and Whole Change Acceptance
- Branch reviewed: `codex/p03-t02-board-task-repository`
- Base reviewed: `657f14ef52974efb0b72f009f536f7105884ad9c`
- Implementation batch reviewed: P09-T01 through P09-T02 plus P09-T03 closeout artifacts
- Reviewer mode: independent closeout review by GPT-5.5 / `otrlead`
- Evidence report: `docs/next/evidence/P09-CLOSEOUT/integration-report.yaml`

## Review History

Phase 9 establishes the Accepted Change Lifecycle cut line for Legion Next. P09-T01 adds a provider-neutral merge queue in `@legion/core`: accepted task-review records are sequenced, path conflicts are detected before rebase, the injected rebase runner advances one accepted entry at a time, and the fail-closed integration gate derives a frozen `MergeIntegrationDecision`. P09-T02 projects that frozen merge-queue result into the board layer: `@legion/board` emits exactly one content-addressed whole-change `BoardEvent` per run and `@legion/store-sqlite` persists/replays the projection without violating the board/store package boundary.

The closeout review checked the P09 source surfaces, tests, serialized merge queue and whole-change snapshots, task integration reports, ledger/HANDOFF files, and final closeout verification transcripts.

## Final Verdicts

- Requirement coverage: PASS
- Architecture compliance: PASS
- Implementation quality: PASS
- Test and evidence sufficiency: PASS
- Operational handoff readiness: PASS
- Unresolved risk: PASS

## Final Reviewer Finding Summary

No critical or important findings remain that should block Phase 9 technical closeout.

The reviewer verified that the merge queue stays provider-neutral, detects deterministic path conflicts before invoking any rebase runner, preserves Phase 8 frozen `WorkerContext` and per-task review hashes as audit inputs, and fails closed across rejected, escalated, conflict, queued, and empty-queue states. The whole-change acceptance layer maps `integrated` to `accepted`, rejected decisions to `rejected`, and escalated/blocked integration to `blocked`; it validates missing or inconsistent inputs fail-closed, emits exactly one content-addressed whole-change event per run, keeps duplicate event replay idempotent, ignores foreign events, and persists the projection through `@legion/store-sqlite` without importing SQLite from `@legion/board`.

The P09-T03 closeout reviewer (`GPT-5.5 / otrlead`) is distinct from the implementation assignee (`legionworker`) and from the serialized whole-change `acceptedBy` actor (`ci-bot`) recorded in `docs/next/evidence/P09-T02/whole-change-snapshot.json`; no same-actor review issue is present at this cut line.

## Evidence Reviewed

- `docs/next/evidence/P09-CLOSEOUT/core-test.log`: `pnpm --filter @legion/core test`, 226 tests passed.
- `docs/next/evidence/P09-CLOSEOUT/protocol-test.log`: `pnpm --filter @legion/protocol test`, 55 tests passed.
- `docs/next/evidence/P09-CLOSEOUT/artifacts-test.log`: `pnpm --filter @legion/artifacts test`, 59 tests passed.
- `docs/next/evidence/P09-CLOSEOUT/board-test.log`: `pnpm --filter @legion/board test`, 32 tests passed.
- `docs/next/evidence/P09-CLOSEOUT/store-sqlite-test.log`: `pnpm --filter @legion/store-sqlite test`, 135 tests passed.
- `docs/next/evidence/P09-CLOSEOUT/typecheck.log`: `pnpm run typecheck`, passed across 10 workspace projects.
- `docs/next/evidence/P09-CLOSEOUT/workspace-tests.log`: `pnpm run test`, root and recursive workspace suites passed through `apps/cli-e2e`.
- `docs/next/evidence/P09-CLOSEOUT/validate-next.log`: final `pnpm run validate:next` closeout transcript.
- `docs/next/evidence/P09-CLOSEOUT/gitleaks-p09-diff.log`: final Phase 9 diff secret scan transcript with no leaks found.
- `docs/next/evidence/P09-T01/integration-report.yaml` and `docs/next/evidence/P09-T02/integration-report.yaml`: task-level implementation summaries and handoffs.
- `docs/next/evidence/P09-T01/merge-queue-snapshot.json` and `docs/next/evidence/P09-T02/whole-change-snapshot.json`: serialized canonical Phase 9 output artifacts.
- `.legion/project/changes/LEGION-NEXT/implementation/phase-09/ledger.yaml` and `.legion/project/changes/LEGION-NEXT/implementation/phase-09/evidence-index.yaml`: final phase ledger and hash index.

## Notes and Accepted Warnings

The local machine emitted pnpm engine warnings because Node v26.0.0 is outside the declared `>=24.0.0 <26` range. The warning is not a Phase 9 source blocker because all package, typecheck, workspace, validate-next, and secret-scan gates passed in the closeout environment; CI/release runners should continue to use the declared Node range.

GitHub Windows Phase 1 CI initially exposed an `EBUSY` cleanup failure while removing `board.sqlite-wal` in `packages/store-sqlite/test/whole-change-projector.test.mjs`. The closeout fix closes the explicit `DatabaseSync` handle before temporary directory removal; local `@legion/store-sqlite` and `validate:next` reruns passed afterward.

## Closeout Notes

Phase 10 can begin after this closeout commit is pushed and the PR/CI gate confirms the same verification set. Release observation should consume the accepted whole-change event/projection as the immutable release cut-line input, preserve `mergeQueueHash`, `decisionSha256`, `aggregatorHash`, `workerContextHashes[]`, and `idempotencyKey` in canary/regression evidence, and treat `blocked` whole-change states as non-releaseable until a new merge-queue hash produces an accepted state.
