# Storage Comparison

## Scope

Legion Next is a workflow tool. The local store exists to make workflow state durable: task contracts, append-only events, atomic claims, leases, approvals, outbox rows, run manifests, and rebuildable projections. It is not a product database for a standalone app.

## Candidates

| Candidate | Version evidence | Install friction | Transaction semantics | Windows posture | Decision |
| --- | --- | --- | --- | --- | --- |
| `node:sqlite` | Runtime probe on Node `v25.9.0`; target Node 24+ exposes the same built-in module family. | Built into Node, no native package install. | Synchronous SQLite connection with explicit transactions, WAL, rollback, and `VACUUM INTO` backup in the spike. | No compiler or postinstall step. | Selected local MVP store. |
| `better-sqlite3` | `npm view better-sqlite3` returned `12.11.1`, MIT, engines `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`. | Native dependency; avoid unless `node:sqlite` blocks required semantics. | Mature synchronous SQLite wrapper, but adds package and build risk. | Usually good, still depends on native package availability. | Fallback candidate only. |
| Postgres/hosted store | Phase 3+ compatibility target. | Requires service provisioning and credentials. | Strong transactional semantics, good for team/hosted mode. | Not suitable as local-only default. | Interface constraint, not Phase 1 dependency. |

## Spike Result

The executable spike at `spikes/store/node-sqlite-workflow-spike.mjs` verifies the workflow-board cases required before Phase 1:

- append event and projection in a transaction;
- guarded atomic task claim so a second claimer cannot own the same generation;
- event-log projection rebuild after an event exists without a projection row;
- failed migration rolls back;
- backup restore preserves task/event hashes;
- WAL mode is enabled.

Raw output is recorded in `docs/next/evidence/P00-T07/storage-spike.log`.

## Selected Shape

Use `node:sqlite` behind a provider-neutral `LegionStore` interface. Keep SQLite-specific handles, statements, row IDs, and pragma choices inside the store package. Core protocol packages may reference store capabilities, transaction boundaries, and event/outbox semantics, but must not import SQLite-specific types.

## Hosted Migration Constraints

- Event IDs, idempotency keys, task generations, and outbox keys must be portable scalar values.
- Task projections must be rebuildable from append-only events.
- SQL migrations must be written so they can be translated to Postgres later without changing core semantics.
- Do not rely on SQLite rowid ordering for domain order.
- Backup/restore evidence must hash logical task/event rows, not database file bytes.

## Accepted Limitations

- `node:sqlite` is synchronous; dispatchers must keep transactions short and never hold a transaction while invoking a model, CLI runtime, filesystem-heavy operation, network call, or Git side effect.
- Cross-OS execution evidence in Phase 0 is Windows-local. Phase 3 must add Linux and macOS CI cells before the board is considered release-ready.
- `better-sqlite3` remains a fallback if Node's built-in module lacks a required feature on the Phase 3 target Node release.
