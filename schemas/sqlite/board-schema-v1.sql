-- Legion Next board schema v1.
-- Source implementation: packages/store-sqlite/src/index.ts.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS board_metadata (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_idempotency_records (
  scope TEXT NOT NULL CHECK (length(scope) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS board_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
  contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
  generation INTEGER NOT NULL CHECK (generation > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'ready', 'claimed', 'running', 'blocked', 'completed', 'failed', 'canceled', 'superseded')),
  priority INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 1000),
  blocker_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_task_links (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('depends_on', 'blocks', 'supersedes', 'relates_to')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id, relation),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES board_tasks(task_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS board_task_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 8192),
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS board_task_events (
  event_id TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) > 0),
  aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence >= 0),
  global_sequence INTEGER NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_version TEXT NOT NULL CHECK (length(event_version) > 0),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  causation_id TEXT,
  correlation_id TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (aggregate_kind, aggregate_id, aggregate_sequence)
);

CREATE TABLE IF NOT EXISTS board_projections (
  projection_key TEXT PRIMARY KEY CHECK (length(projection_key) > 0),
  projection_version INTEGER NOT NULL CHECK (projection_version > 0),
  rebuilt_through_global_sequence INTEGER NOT NULL CHECK (rebuilt_through_global_sequence >= 0),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_claims (
  lease_token TEXT PRIMARY KEY CHECK (length(lease_token) > 0),
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  run_id TEXT,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('completed', 'blocked', 'failed', 'canceled', 'expired', 'superseded')),
  FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS board_task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('created', 'started', 'succeeded', 'failed', 'blocked', 'canceled', 'superseded')),
  manifest_json TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS board_approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'granted', 'denied', 'expired', 'revoked')),
  scope_json TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  decided_by_json TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (task_id) REFERENCES board_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES board_task_runs(run_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS board_outbox (
  outbox_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  effect_class TEXT NOT NULL CHECK (effect_class IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  effect_kind TEXT NOT NULL CHECK (length(effect_kind) > 0),
  target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_tasks_status_priority ON board_tasks(status, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_board_task_links_depends_on ON board_task_links(depends_on_task_id, task_id);
CREATE INDEX IF NOT EXISTS idx_board_task_events_aggregate_sequence ON board_task_events(aggregate_kind, aggregate_id, aggregate_sequence);
CREATE INDEX IF NOT EXISTS idx_board_task_events_global_sequence ON board_task_events(global_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_claims_live_task_generation ON board_claims(task_id, generation) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_board_task_runs_task ON board_task_runs(task_id, generation, attempt);
CREATE INDEX IF NOT EXISTS idx_board_outbox_status ON board_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS idx_board_idempotency_scope_key ON board_idempotency_records(scope, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_board_task_comments_task_id ON board_task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_board_claims_task_id ON board_claims(task_id);
CREATE INDEX IF NOT EXISTS idx_board_approvals_task_id ON board_approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_board_approvals_run_id ON board_approvals(run_id);
