# ADR-008: Local Store Selection

## Status
Accepted

## Context

Legion Next is rebuilding a workflow orchestration tool similar in spirit to Superpowers or Get-Shit-Done: it coordinates phases, tasks, reviews, evidence, approvals, and tool/runtime adapters. The local store is therefore operational workflow infrastructure. It must survive process loss, retries, duplicate dispatch, and workspace churn, but it must not turn Phase 1 into a hosted application or dashboard project.

ADR-003 assigns mutable task, run, event, lease, approval, comment, and outbox state to `.legion/var/board.sqlite`. ADR-005 requires append-only events, idempotent handlers, transactional outbox writes, and explicit replay versus re-execution semantics.

## Decision

Use `node:sqlite` as the default local persistence provider for the CLI-first MVP.

The implementation must expose a provider-neutral `LegionStore` interface. Core packages may depend on event, task, run, approval, outbox, and migration contracts, but they must not depend on SQLite statements, connection objects, pragma names, rowids, or file paths.

`better-sqlite3` remains a fallback candidate only if Node's built-in SQLite module fails a required Phase 3 semantic or platform check. Postgres remains a hosted/team-mode target and may not change the local-first default before a separate ADR proves migration compatibility.

## Required Store Capabilities

| Capability | Requirement |
| --- | --- |
| Event append | Event insert, projection mutation, and outbox intent can commit atomically. |
| Atomic claim | One task generation can be claimed by only one worker lease. |
| Heartbeat/reclaim | Expired leases can be detected and reconciled before redispatch. |
| Projection rebuild | Current task state can be rebuilt from events when projections drift. |
| Migration | Failed migrations roll back without partial schema ownership. |
| Backup/restore | Logical event/task hashes match after restore. |
| Portability | Domain contracts do not depend on SQLite-specific types. |

## Consequences

Phase 1 can define protocol and core packages without selecting application hosting infrastructure. Phase 3 can implement the board and dispatcher against a concrete local provider while keeping a future hosted-store path open.

The synchronous API requires short transactions and strict side-effect boundaries. A dispatcher must commit state before invoking runtime drivers, shell commands, network calls, Git operations, or external providers.

## Evidence

- Comparison: `docs/next/spikes/STORAGE-COMPARISON.md`
- Executable spike: `spikes/store/node-sqlite-workflow-spike.mjs`
- Draft provider-neutral interface: `spikes/store/store-interface.d.ts`
- Raw run output: `docs/next/evidence/P00-T07/storage-spike.log`
- Package metadata check for fallback: `docs/next/evidence/P00-T07/storage-package-metadata.log`

## Review And Approval

- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only with a later accepted ADR that preserves the ADR-003 state ownership matrix, ADR-005 idempotency semantics, and a working local-first workflow path.
