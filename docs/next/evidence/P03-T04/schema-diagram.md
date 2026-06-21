# P03-T04 Board Claims and Leases — Schema Surface

This diagram covers the `board_claims` table and the indexes / constraints
that back atomic single-worker claims, heartbeats, expired-lease reclaims,
and idempotent releases. The full board schema diagram lives at
`docs/next/evidence/P03-T02/schema-diagram.md`; this document focuses on
the claims surface added by P03-T04.

## Table

```
+-----------------------------+
|       board_claims          |
+-----------------------------+
| PK lease_token              |   -- opaque string (>= 16 chars; default
|                               --   is node:crypto.randomUUID())
|    task_id (FK CASCADE)     |   -- references board_tasks.task_id
|    generation               |   -- mirrors the task generation CAS
|    owner_id                 |   -- non-empty worker identity
|    run_id (nullable)        |   -- optional run binding for the claim
|    claimed_at               |   -- ISO-8601 issuance timestamp
|    lease_expires_at         |   -- ISO-8601 deadline; rows past this
|                               --   timestamp are eligible for reclaim
|    heartbeat_at             |   -- last refresh, equals claimed_at on insert
|    released_at (nullable)   |   -- populated once the lease is archived
|    release_reason (enum)    |   -- completed | blocked | failed |
|                               --   canceled | expired | superseded
+-----------------------------+
| CK release_reason IN (...)  |
| UNQ idx_...live_task_gen    |   -- (task_id, generation) live leases
| UNQ PK lease_token          |
| FK task_id -> board_tasks   |
+-----------------------------+
```

The `release_reason` CHECK constraint was widened during P03-T04 to add
`'superseded'` so the dispatcher can stamp claims that lose their
generation race when `supersedeTask` advances the task generation.

## Indexes

| Index name                              | Purpose                                                            |
|-----------------------------------------|--------------------------------------------------------------------|
| `sqlite_autoindex_board_claims_1`       | B-tree on the `lease_token` PRIMARY KEY; drives `getClaim`, `heartbeat`, `release`, and `expireOne`. |
| `idx_board_claims_live_task_generation` | Partial UNIQUE index on `(task_id, generation) WHERE released_at IS NULL`; backstops the `SELECT … WHERE released_at IS NULL` lookups inside `selectActiveForTask` and `selectExpired`. |
| `idx_board_claims_task_id`              | Covering index on `task_id`; helps `getActiveClaimForTask` and ad-hoc task-scoped queries. |

## Reads and writes driven by the repository

```
tryClaim
  SELECT generation FROM board_tasks WHERE task_id = ?                  -- generation CAS
  SELECT *        FROM board_claims WHERE task_id = ? AND released_at IS NULL
                                                                      -- live-claim check
                                                                      -- (idx_board_claims_live_task_generation partial unique)
  INSERT          INTO board_claims (...)                               -- atomic lease insert

heartbeat
  SELECT *        FROM board_claims WHERE lease_token = ?               -- existence + released-at check
  UPDATE          board_claims SET heartbeat_at, lease_expires_at
                  WHERE lease_token = ? AND released_at IS NULL        -- (PK + partial filter)

release
  SELECT *        FROM board_claims WHERE lease_token = ?               -- idempotent return when archived
  UPDATE          board_claims SET released_at, release_reason
                  WHERE lease_token = ? AND released_at IS NULL        -- (PK + partial filter)

reclaimExpiredLeases
  SELECT *        FROM board_claims
                  WHERE released_at IS NULL AND lease_expires_at <= ? -- (idx_board_claims_live_task_generation)
  UPDATE          board_claims SET released_at, release_reason='expired'
                  WHERE lease_token = ? AND released_at IS NULL        -- per-row CAS
```

## Cross-references

- `board_tasks.generation` is the source of truth that the claim
  repository reads at `tryClaim` time. When `supersedeTask` advances the
  generation (P03-T02), every live claim on the prior generation becomes
  stale; `tryClaim` against the new generation on a successor task
  succeeds because the partial unique index only covers live rows.
- The `idx_board_claims_live_task_generation` index is the only piece of
  the schema that enforces single-worker semantics in the storage
  layer. P03-T05 (outbox) and P03-T06 (comments) reuse the same
  partial-index pattern for their own dedupe.
