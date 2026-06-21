# P03-T01 Board Schema Diagram

Source schema: `schemas/sqlite/board-schema-v1.sql`
Provider package: `packages/store-sqlite`

```mermaid
erDiagram
  board_tasks ||--o{ board_task_links : "task_id"
  board_tasks ||--o{ board_task_links : "depends_on_task_id"
  board_tasks ||--o{ board_task_comments : "task_id"
  board_tasks ||--o{ board_claims : "task_id"
  board_tasks ||--o{ board_task_runs : "task_id"
  board_tasks ||--o{ board_approvals : "task_id"
  board_task_runs ||--o{ board_approvals : "run_id"

  board_schema_migrations {
    integer version PK
    text name
    text checksum
    text applied_at
  }

  board_tasks {
    text task_id PK
    text project_id
    text change_id
    text contract_id
    integer contract_revision
    text contract_hash
    integer generation
    text status
    integer priority
    text blocker_json
    text created_at
    text updated_at
  }

  board_task_events {
    text event_id PK
    text aggregate_kind
    text aggregate_id
    integer aggregate_sequence
    integer global_sequence
    text event_type
    text event_version
    text payload_json
    text payload_hash
    text causation_id
    text correlation_id
    text occurred_at
  }

  board_claims {
    text lease_token PK
    text task_id FK
    integer generation
    text owner_id
    text run_id
    text claimed_at
    text lease_expires_at
    text heartbeat_at
    text released_at
    text release_reason
  }

  board_task_runs {
    text run_id PK
    text task_id FK
    integer generation
    integer attempt
    text status
    text manifest_json
    text started_at
    text finished_at
    text created_at
    text updated_at
  }

  board_outbox {
    text outbox_id PK
    text idempotency_key
    text effect_class
    text effect_kind
    text target_hash
    text payload_json
    text status
    integer attempts
    text available_at
    text claimed_by
    text claimed_until
    text last_error
    text created_at
    text updated_at
  }
```

Ownership notes:

- `@legion/board-store` owns provider-neutral table/index diagnostics and board store contracts.
- `@legion/store-sqlite` owns concrete SQLite pragmas, SQL statements, migrations, transaction rollback, and real-file diagnostics.
- `.legion/var/board.sqlite` is mutable operational state. Git-tracked artifacts remain under `.legion/project`.
