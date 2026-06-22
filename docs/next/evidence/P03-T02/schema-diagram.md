# P03-T02 Board Task Repository — Schema Surface

```
                              +------------------------+
                              |       board_tasks       |
                              +------------------------+
                              | PK task_id             |
                              |    project_id          |
                              |    change_id           |
                              |    contract_id         |
                              |    contract_revision   |
                              |    contract_hash       |
                              |    generation          |
                              |    status              |
                              |    priority            |
                              |    blocker_json        |
                              |    created_at          |
                              |    updated_at          |
                              +------------------------+
                              | IX  status,priority,   |
                              |     updated_at         |
                              +------------------------+
                                       |
            +--------------------------+------------------------------+
            |                          |                              |
            v                          v                              v
   +------------------+      +---------------------+      +--------------------+
   | board_task_links  |      | board_task_comments |      | board_claims       |
   +------------------+      +---------------------+      +--------------------+
   | PK (task_id,      |      | PK comment_id       |      | PK lease_token     |
   |    depends_on,    |      |    task_id (FK)     |      |    task_id (FK)    |
   |    relation)      |      |    actor_json       |      |    generation      |
   |    task_id (FK)   |      |    body             |      |    owner_id        |
   |    depends_on(FK) |      |    created_at       |      |    run_id          |
   |    relation enum  |      +---------------------+      |    claimed_at      |
   |    created_at     |                                     |    lease_expires_at|
   +------------------+                                     |    heartbeat_at    |
                                                             |    released_at     |
                                                             |    release_reason  |
                                                             +--------------------+
            |
            v
   +-------------------------+
   | board_task_events        |  (P03-T03 surfaces this for the
   +-------------------------+   task repository's emit hooks)
   | PK event_id             |
   |    aggregate_kind       |
   |    aggregate_id         |
   |    aggregate_sequence   |
   |    global_sequence UNQ  |
   |    event_type           |
   |    event_version        |
   |    payload_json         |
   |    payload_hash         |
   |    causation_id         |
   |    correlation_id       |
   |    occurred_at          |
   +-------------------------+

   +-----------------------------+
   | board_idempotency_records   |  (P03-T02 uses scope="board.task.create")
   +-----------------------------+
   | PK (scope, idempotency_key) |
   |    result_hash              |
   |    result_json              |
   |    created_at               |
   +-----------------------------+
```

## BoardTaskRepository operations

| Method | Board effect | Generation impact |
| --- | --- | --- |
| `createTask` | INSERT into `board_tasks` + optional `board_idempotency_records` row | generation = input.initialGeneration ?? 1 |
| `getTask` | SELECT by primary key | read-only |
| `listTasks` | SELECT with status/project/change filters, ORDER BY priority DESC, updated_at ASC | read-only |
| `updateTaskPriority` | UPDATE priority+updated_at with `generation = expectedGeneration` CAS | unchanged |
| `transitionTaskStatus` | UPDATE status+blocker+updated_at with generation CAS; optional `advanceGeneration` increments generation by N | conditional bump when `advanceGeneration` set |
| `bumpGeneration` | UPDATE contract_id/revision/hash + generation = current+1 | increments by 1 |
| `supersedeTask` | UPDATE retired row status='superseded' generation=current+1 + INSERT successor + INSERT `board_task_links` row with relation='supersedes' | retired row bumped by 1; successor created at initialGeneration |
| `deleteTask` | DELETE row (cascades via FK to comments, links, claims) | unchanged; for test cleanup only |

## Status transition matrix (BOARD_TASK_STATUS_TRANSITIONS)

```
queued    -> ready, canceled, superseded
ready     -> claimed, canceled, superseded
claimed   -> running, blocked, canceled, superseded
running   -> completed, failed, blocked, canceled, superseded
blocked   -> ready, canceled, superseded
completed -> (terminal)
failed    -> ready
canceled  -> (terminal)
superseded -> (terminal)
```

## Idempotency contract

The `board_idempotency_records` table is reused for `createTask` with `scope="board.task.create"`. A second call with the same `idempotencyKey` short-circuits and returns the existing task projection instead of inserting a duplicate row.