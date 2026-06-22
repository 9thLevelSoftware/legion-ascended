# Phase 3 Handoff — Transactional Kanban Control Plane

## Status

DONE.

Implementation batch: PR #22 final branch head after history rewrite/squash for sanitized evidence.

## Delivered Surface

- `@legion/board-store`: provider-neutral board contracts for tasks, claims, events, projections, outbox, comments, approvals, and task links.
- `@legion/store-sqlite`: SQLite-backed transactional repositories and store wrappers for the full Phase 3 board surface.
- `@legion/board`: re-export package for downstream consumers.
- `@legion/cli`: noninteractive `legion next board ...` commands for task, event, claim, and approval automation.
- `@legion/cli-e2e`: process-level CLI coverage for board task creation, claim leasing, event append, and approval creation.

## Verification Evidence

- `pnpm --filter @legion/store-sqlite test` — PASS, 130/130 tests.
- `pnpm --filter @legion/cli-e2e test` — PASS, 10/10 tests.
- `pnpm -r typecheck` — PASS.
- `pnpm run check:boundaries` — PASS.
- `pnpm run validate:next` — PASS.

Full transcripts are under `docs/next/evidence/P03-CLOSEOUT/`.

## Phase 4 Starting Point

Phase 4 can build functional worker bundles and persona purge work against the following stable assumptions:

1. Board task state is stored in `.legion/var/board.sqlite` and should remain operational state, not committed project truth.
2. Programmatic board automation should use `legion next board <domain> <action> --input <json-file> --json --repository-root <repo>`.
3. Task status/generation changes use repository methods with generation CAS guards; stale writers receive concurrency errors rather than silent overwrites.
4. Claim leases are single-live-claim per `(task_id, generation)`, with heartbeat, release, and expired-lease reclaim paths covered by tests.
5. Task repository mutations emit append-only board events atomically through event hooks; projections can rebuild deterministically from global event sequence order.
6. Outbox delivery state uses `pending -> claimed -> succeeded/failed/dead_lettered` with idempotent enqueue replay and claim attempt accounting.
7. Task dependency links reject cycles for DAG relations (`depends_on`, `blocks`) and provide topological ordering helpers. `relates_to` is intentionally non-DAG metadata.
8. Approval records use protocol-aligned statuses (`requested`, `granted`, `denied`, `expired`, `revoked`) and expose coarse lifecycle phases (`pending`, `approved`, `revoked`).

## Accepted Warning

Local closeout verification ran on Node v26.0.0 and emitted pnpm engine warnings because the packages declare `>=24.0.0 <26`. The gates passed despite that local warning. CI/release runners should continue to use the declared Node engine range.

## CI Remediation Notes

PR #22 initially exposed two closeout hygiene issues that are now addressed:

1. Windows Phase 1 CI hit SQLite temp-directory `EBUSY` cleanup failures. Store-sqlite tests now close repository `DatabaseSync` handles explicitly and use retrying temp-directory removal.
2. P03-T04 generated schema diagnostics contained synthetic UUID-shaped lease tokens. They are redacted in committed evidence to avoid secret-scanner false positives.

## Handoff Recommendation

Proceed to P04-T01 after this closeout commit is pushed and the closeout PR/CI gate confirms the same verification set.
