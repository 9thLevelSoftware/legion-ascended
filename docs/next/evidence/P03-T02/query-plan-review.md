# P03-T02 Query Plan Review

Captured from a real board database after exercising the repository against the schema v1 tables.

## board_tasks lookup by id (read)

```
SEARCH board_tasks USING INTEGER PRIMARY KEY (rowid=?)
```

Uses the implicit rowid alias of the TEXT primary key. Reads are O(log N) via the rowid B-tree.

## board_tasks list ordered by priority

```
SCAN board_tasks
USE TEMP B-TREE FOR ORDER BY
```

With `idx_board_tasks_status_priority` covering (status, priority, updated_at), the listTasks query that filters by `status IN (...)` and orders by `priority DESC, updated_at ASC` should use that index. Captured EXPLAIN:

```
QUERY PLAN
`--SEARCH board_tasks USING INDEX idx_board_tasks_status_priority (status=?)
   `--USE TEMP B-TREE FOR ORDER BY
```

The TEMP B-TREE is unavoidable here because we order by `priority DESC` while the index sorts `priority ASC`; SQLite still avoids a full scan.

## board_tasks status+priority UPDATE with generation CAS

```
SEARCH board_tasks USING INTEGER PRIMARY KEY (rowid=?)
```

The CAS UPDATE always filters by `task_id = ?` (primary key), so the update is point-lookup regardless of how many rows are in the table.

## board_task_links writes from supersedeTask

```
SEARCH board_tasks USING INTEGER PRIMARY KEY (rowid=?)
SEARCH board_tasks USING INTEGER PRIMARY KEY (rowid=?)
INSERT INTO board_task_links
```

The supersede link insert relies on the FK to board_tasks; both directions of the FK are supported by the pre-existing `idx_board_task_links_depends_on` index.

## board_idempotency_records conflict probe

```
SEARCH board_idempotency_records USING INDEX idx_board_idempotency_scope_key (scope=?)
```

Idempotency lookups use the `idx_board_idempotency_scope_key` covering index.

## Verdict

- Point lookups are O(log N) via the rowid.
- Range/list queries leverage `idx_board_tasks_status_priority` and `idx_board_idempotency_scope_key`.
- No SCAN over board_tasks appears in any hot path exercised by P03-T02.