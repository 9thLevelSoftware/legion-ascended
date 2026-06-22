# P03-T04 Query Plan Review

Captured via `EXPLAIN QUERY PLAN` on a real board database populated by
the new `SqliteBoardClaimRepository`. The repository was exercised
through every claim code path (`tryClaim` → `heartbeat` → `release`,
plus a second `tryClaim` followed by `reclaimExpiredLeases`) so the
planner sees realistic index state.

## tryClaim — generation CAS

```
SEARCH board_tasks USING INDEX sqlite_autoindex_board_tasks_1 (task_id=?)
```

The `SELECT generation FROM board_tasks WHERE task_id = ?` lookup is a
single-row point read against the `task_id` PRIMARY KEY. P03-T04 uses
this to surface `BoardClaimGenerationError` with the *actual* generation
when the caller's `expectedGeneration` does not match.

## tryClaim — live-claim contention probe

```
SEARCH board_claims USING INDEX idx_board_claims_task_id (task_id=?)
USE TEMP B-TREE FOR ORDER BY
```

The active-claim probe `SELECT … FROM board_claims WHERE task_id = ?
AND released_at IS NULL ORDER BY claimed_at ASC LIMIT 1` walks the
`task_id` index and filters by `released_at IS NULL` in a TEMP B-TREE
during the ORDER BY. Because the index is *not* partial, the planner
scans at most one task's lease history; in practice the active-claim
set is tiny (≤ a handful of entries per task) so the TEMP B-TREE is
trivial.

The `idx_board_claims_live_task_generation` partial UNIQUE index is
the storage-level enforcement of single-worker semantics: a second
INSERT into the same `(task_id, generation)` with `released_at IS NULL`
fails with `SQLITE_CONSTRAINT_UNIQUE`, which the application code
translates to `BoardClaimContendedError`.

## getClaim / heartbeat / release / expireOne — by lease token

```
SEARCH board_claims USING INDEX sqlite_autoindex_board_claims_1 (lease_token=?)
```

All four statements filter by `lease_token = ?` and ride the implicit
rowid alias of the TEXT primary key. The lease token is a `randomUUID`
on insert and stays unique per live or archived claim, so each lookup
is O(log N) without secondary indexes.

The `WHERE lease_token = ? AND released_at IS NULL` filter inside the
heartbeat, release, and expireOne UPDATEs is intentionally narrowed to
live rows so a heartbeat on an archived claim returns the existing row
without touching it (see `heartbeat` idempotency test) and a release on
an archived claim does not overwrite the original `released_at` /
`release_reason` (see `release` idempotency test).

## reclaimExpiredLeases — sweep

```
SCAN board_claims USING INDEX idx_board_claims_live_task_generation
```

The reclaim scan walks the partial UNIQUE index `idx_board_claims_
live_task_generation` whose `WHERE released_at IS NULL` predicate
matches the reclaim filter exactly. The scan visits only live rows, so
the cost scales with the number of *active* leases in the table —
which is the operationally interesting quantity, not the total claim
history.

Each scanned row is then individually expired with a single-row
`UPDATE … WHERE lease_token = ? AND released_at IS NULL` so concurrent
reclaimers cannot double-stamp the same lease.

## Verdict

- The `lease_token` PK keeps single-claim lookups O(log N) and removes
  the need for a secondary index on `lease_token`.
- `idx_board_claims_task_id` is sufficient for the active-claim
  contention probe because the active set per task is bounded and the
  planner only sorts a tiny window.
- `idx_board_claims_live_task_generation` carries both the live-claim
  uniqueness guarantee and the reclaim scan in one index.
- No SCAN appears on `board_tasks` from claim code; the only path into
  that table is the point-read generation CAS.
