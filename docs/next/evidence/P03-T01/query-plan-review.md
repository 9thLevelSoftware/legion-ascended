# P03-T01 Query Plan Review

Database: `docs/next/evidence/P03-T01/board-diagnostics.sqlite` (temporary real file, removed after report generation).

Every query below was inspected with `EXPLAIN QUERY PLAN` after applying schema version 1 to a real SQLite file.

## ready task scan

Expected index: `idx_board_tasks_status_priority`

```sql
SELECT task_id FROM board_tasks WHERE status = 'ready' ORDER BY priority, updated_at;
```

Plan:

```text
SEARCH board_tasks USING INDEX idx_board_tasks_status_priority (status=?)
```

Result: PASS

## dependent task lookup

Expected index: `idx_board_task_links_depends_on`

```sql
SELECT task_id FROM board_task_links WHERE depends_on_task_id = 'tsk_alpha' ORDER BY task_id;
```

Plan:

```text
SEARCH board_task_links USING COVERING INDEX idx_board_task_links_depends_on (depends_on_task_id=?)
```

Result: PASS

## aggregate event replay

Expected index: `idx_board_task_events_aggregate_sequence`

```sql
SELECT event_id FROM board_task_events WHERE aggregate_kind = 'task' AND aggregate_id = 'tsk_alpha' ORDER BY aggregate_sequence;
```

Plan:

```text
SEARCH board_task_events USING INDEX idx_board_task_events_aggregate_sequence (aggregate_kind=? AND aggregate_id=?)
```

Result: PASS

## pending outbox scan

Expected index: `idx_board_outbox_status`

```sql
SELECT outbox_id FROM board_outbox WHERE status = 'pending' AND available_at <= '2026-06-22T00:00:00.000Z' ORDER BY available_at;
```

Plan:

```text
SEARCH board_outbox USING INDEX idx_board_outbox_status (status=? AND available_at<?)
```

Result: PASS

## task comment cascade lookup

Expected index: `idx_board_task_comments_task_id`

```sql
SELECT comment_id FROM board_task_comments WHERE task_id = 'tsk_alpha';
```

Plan:

```text
SEARCH board_task_comments USING COVERING INDEX idx_board_task_comments_task_id (task_id=?)
```

Result: PASS

## claim cascade lookup

Expected index: `idx_board_claims_task_id`

```sql
SELECT lease_token FROM board_claims WHERE task_id = 'tsk_alpha';
```

Plan:

```text
SEARCH board_claims USING INDEX idx_board_claims_task_id (task_id=?)
```

Result: PASS

## approval task cascade lookup

Expected index: `idx_board_approvals_task_id`

```sql
SELECT approval_id FROM board_approvals WHERE task_id = 'tsk_alpha';
```

Plan:

```text
SEARCH board_approvals USING INDEX idx_board_approvals_task_id (task_id=?)
```

Result: PASS

## approval run nullification lookup

Expected index: `idx_board_approvals_run_id`

```sql
SELECT approval_id FROM board_approvals WHERE run_id = 'run_alpha';
```

Plan:

```text
SEARCH board_approvals USING INDEX idx_board_approvals_run_id (run_id=?)
```

Result: PASS
