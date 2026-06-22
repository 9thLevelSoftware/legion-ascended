import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_APPROVAL_LIFECYCLE_PHASES,
  BOARD_APPROVAL_STATUSES,
  BOARD_APPROVAL_STATUS_TRANSITIONS,
  BOARD_APPROVAL_TERMINAL_STATUSES,
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_TASK_GENERATION_MIN,
  BoardApprovalAlreadyExistsError,
  BoardApprovalConcurrencyError,
  BoardApprovalIllegalStatusTransitionError,
  BoardApprovalNotFoundError,
  BoardApprovalTerminalStatusError,
  SQLITE_BOARD_MIGRATIONS,
  SqliteBoardApprovalRepository,
  openSqliteBoardStore,
  openSqliteBoardTaskRepository
} from "../dist/index.js";

const LATEST_SQLITE_BOARD_SCHEMA_VERSION = SQLITE_BOARD_MIGRATIONS.at(-1).version;

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t07-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildApprovalsContext(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const sharedDb = new DatabaseSync(databasePath);
  sharedDb.exec("PRAGMA foreign_keys = ON");
  const taskRepository = openSqliteBoardTaskRepository({ database: new DatabaseSync(databasePath) });
  const approvalRepository = new SqliteBoardApprovalRepository({ database: new DatabaseSync(databasePath) });
  const cleanupStore = {
    inspect: () => store.inspect(),
    close: () => {
      approvalRepository.closeDatabase();
      taskRepository.closeDatabase();
      sharedDb.close();
      store.close();
    }
  };
  return {
    store: cleanupStore,
    database: sharedDb,
    taskRepository,
    approvalRepository
  };
}

const PROJECT_ID = "prj_alpha";
const CHANGE_ID = "chg_alpha";
const TASK_ID = "tsk_alpha";
const TASK_ID_BETA = "tsk_beta";
const RUN_ID = "run_alpha_001";
const CONTRACT_ID = "ctr_alpha";
const CONTRACT_REVISION = 1;
const CONTRACT_HASH = "a".repeat(64);

function createTaskInput(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    contractRevision: CONTRACT_REVISION,
    contractHash: CONTRACT_HASH,
    initialStatus: "ready",
    ...overrides
  };
}

function createScopeInput(overrides = {}) {
  return {
    effectClass: "S2",
    action: "promote.release",
    targetsJson: JSON.stringify([{ kind: "task", id: TASK_ID }]),
    justification: "Promoting staged release for task " + TASK_ID,
    ...overrides
  };
}

function createRequesterInput(overrides = {}) {
  return {
    id: "user_alpha",
    displayName: "Alpha User",
    kind: "human",
    ...overrides
  };
}

function createApprovalInput(overrides = {}) {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    scope: createScopeInput(),
    requestedBy: createRequesterInput(),
    ...overrides
  };
}

function createDeciderInput(overrides = {}) {
  return {
    id: "approver_alpha",
    displayName: "Alpha Approver",
    kind: "human",
    ...overrides
  };
}

function seedRun(database, taskId, runId) {
  const now = "2026-07-01T09:00:00.000Z";
  database
    .prepare(
      "INSERT INTO board_task_runs (run_id, task_id, generation, attempt, status, " +
        "manifest_json, started_at, finished_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      runId,
      taskId,
      BOARD_TASK_GENERATION_MIN,
      1,
      "started",
      JSON.stringify({ seeded: true }),
      now,
      null,
      now,
      now
    );
}

function seedTaskAndRun(database, taskRepository, overrides = {}) {
  const input = createTaskInput(overrides);
  taskRepository.createTask(input);
  const runId = overrides.runId ?? RUN_ID;
  if (runId !== null && runId !== undefined) {
    seedRun(database, input.taskId, runId);
  }
  return input;
}

test("P03-T07 schema exposes board_approvals, indexes, and protocol-aligned status enum", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      const expected = ["requested", "granted", "denied", "expired", "revoked"];
      assert.deepEqual([...BOARD_APPROVAL_STATUSES], expected);

      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      assert.equal(created.status, "requested");
      assert.equal(created.lifecyclePhase, "pending");
      assert.equal(created.taskId, TASK_ID);
      assert.equal(created.runId, RUN_ID);
      assert.equal(created.decidedAt, null);
      assert.equal(created.decidedBy, null);

      const diagnostics = store.inspect();
      assert.ok(diagnostics.tables.includes("board_approvals"));
      assert.ok(diagnostics.indexes.includes("idx_board_approvals_task_id"));
      assert.ok(diagnostics.indexes.includes("idx_board_approvals_run_id"));
      assert.equal(diagnostics.userVersion, LATEST_SQLITE_BOARD_SCHEMA_VERSION);
      for (const table of BOARD_REQUIRED_TABLES) {
        assert.ok(diagnostics.tables.includes(table), "missing table " + table);
      }
      for (const index of BOARD_REQUIRED_INDEXES) {
        assert.ok(diagnostics.indexes.includes(index), "missing index " + index);
      }
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval round-trips scope, requester, and expiresAt", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const expiresAt = "2026-12-31T23:59:59.000Z";
      const created = approvalRepository.createApproval(
        createApprovalInput({
          expiresAt,
          idempotencyKey: "approval-create-001"
        })
      );
      assert.equal(created.expiresAt, expiresAt);
      assert.equal(created.scope.effectClass, "S2");
      assert.equal(created.scope.action, "promote.release");
      assert.deepEqual(JSON.parse(created.scope.targetsJson), [{ kind: "task", id: TASK_ID }]);
      assert.equal(created.scope.justification, "Promoting staged release for task " + TASK_ID);
      assert.equal(created.requestedBy.id, "user_alpha");
      assert.equal(created.requestedBy.kind, "human");
      assert.equal(created.requestedBy.displayName, "Alpha User");

      const fetched = approvalRepository.getApproval(created.approvalId);
      assert.deepEqual(fetched, created);

      const replayed = approvalRepository.createApproval(
        createApprovalInput({
          expiresAt,
          idempotencyKey: "approval-create-001"
        })
      );
      assert.equal(replayed.approvalId, created.approvalId);
      assert.deepEqual(replayed, created);

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({
              scope: createScopeInput({ action: "rollback.release" }),
              expiresAt,
              idempotencyKey: "approval-create-001"
            })
          ),
        /idempotencyKey .*different intent/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval assigns approval_id when not provided and refuses duplicates", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const first = approvalRepository.createApproval(createApprovalInput());
      assert.match(first.approvalId, /^apv_[0-9a-f-]+/);

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ approvalId: first.approvalId })
          ),
        (error) => error instanceof BoardApprovalAlreadyExistsError && error.approvalId === first.approvalId
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval rejects unknown task with a foreign-key error", async () => {
  await withTempDatabase((databasePath) => {
    const { store, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ taskId: "tsk_does_not_exist" })
          ),
        /unknown task|do(es)? not exist/i
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 grantApproval transitions requested -> granted with expectedStatus guard", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      const grantedAt = "2026-07-01T10:00:00.000Z";
      const granted = approvalRepository.grantApproval({
        approvalId: created.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "All checks green",
        decidedAt: grantedAt
      });
      assert.equal(granted.status, "granted");
      assert.equal(granted.lifecyclePhase, "approved");
      assert.equal(granted.decidedAt, grantedAt);
      assert.equal(granted.approvedAt, grantedAt);
      assert.equal(granted.decidedBy.id, "approver_alpha");
      assert.equal(granted.decisionReason, null);

      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: granted.approvalId,
            expectedStatus: "requested",
            decidedBy: createDeciderInput(),
            decisionReason: "no"
          }),
        (error) =>
          error instanceof BoardApprovalConcurrencyError &&
          error.expectedStatus === "requested" &&
          error.actualStatus === "granted"
      );

      const fetched = approvalRepository.getApproval(granted.approvalId);
      assert.equal(fetched.status, "granted");
      assert.equal(fetched.lifecyclePhase, "approved");
    } finally {
      store.close();
    }
  });
});

test("P03-T07 denyApproval transitions requested -> denied with the same guards", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      const denied = approvalRepository.denyApproval({
        approvalId: created.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput({ id: "approver_beta" }),
        decisionReason: "Missing smoke test"
      });
      assert.equal(denied.status, "denied");
      assert.equal(denied.lifecyclePhase, "revoked");
      assert.equal(denied.decidedBy.id, "approver_beta");
      assert.ok(denied.decidedAt && denied.decidedAt.length > 0);
      assert.equal(denied.approvedAt, null);

      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: denied.approvalId,
            expectedStatus: "denied",
            decidedBy: createDeciderInput(),
            decisionReason: "no"
          }),
        (error) =>
          error instanceof BoardApprovalIllegalStatusTransitionError &&
          error.from === "denied" &&
          error.to === "granted"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 expireApproval moves requested -> expired and rejects terminal transitions", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      const expired = approvalRepository.expireApproval({
        approvalId: created.approvalId,
        expectedStatus: "requested",
        now: "2026-07-01T12:00:00.000Z"
      });
      assert.equal(expired.status, "expired");
      assert.equal(expired.lifecyclePhase, "revoked");
      assert.equal(expired.decidedBy, null);
      assert.equal(expired.approvedAt, null);

      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: expired.approvalId,
            expectedStatus: "expired",
            decidedBy: createDeciderInput(),
            decisionReason: "no"
          }),
        (error) => error instanceof BoardApprovalIllegalStatusTransitionError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 revokeApproval is reachable from requested AND from granted; denied/expired/revoked reject revoke", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      // Case 1: revoke while requested.
      seedTaskAndRun(database, taskRepository);
      const pending = approvalRepository.createApproval(createApprovalInput());
      const revokedPending = approvalRepository.revokeApproval({
        approvalId: pending.approvalId,
        expectedStatus: "requested",
        revokedBy: createDeciderInput({ id: "reviewer_a" }),
        revokeReason: "Requester withdrew"
      });
      assert.equal(revokedPending.status, "revoked");
      assert.equal(revokedPending.lifecyclePhase, "revoked");
      assert.equal(revokedPending.decidedBy.id, "reviewer_a");
      assert.equal(revokedPending.approvedAt, null);

      // Case 2: revoke while granted (a previously-granted approval can
      // still be revoked).
      const secondTask = approvalRepository.createApproval(
        createApprovalInput({ approvalId: "apv_second", taskId: TASK_ID })
      );
      const granted = approvalRepository.grantApproval({
        approvalId: secondTask.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "ok"
      });
      const revokedGranted = approvalRepository.revokeApproval({
        approvalId: granted.approvalId,
        expectedStatus: "granted",
        revokedBy: createDeciderInput({ id: "reviewer_b" }),
        revokeReason: "Compliance pulled the grant"
      });
      assert.equal(revokedGranted.status, "revoked");
      assert.equal(revokedGranted.lifecyclePhase, "revoked");
      assert.equal(revokedGranted.decidedBy.id, "reviewer_b");
      assert.equal(revokedGranted.approvedAt, null);

      // Case 3: revoke a denied approval must be rejected.
      const third = approvalRepository.createApproval(
        createApprovalInput({ approvalId: "apv_third", taskId: TASK_ID })
      );
      const denied = approvalRepository.denyApproval({
        approvalId: third.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "no"
      });
      assert.throws(
        () =>
          approvalRepository.revokeApproval({
            approvalId: denied.approvalId,
            expectedStatus: "denied",
            revokedBy: createDeciderInput(),
            revokeReason: "x"
          }),
        (error) => error instanceof BoardApprovalIllegalStatusTransitionError
      );

      // Case 4: revoke an already-revoked approval must be rejected.
      assert.throws(
        () =>
          approvalRepository.revokeApproval({
            approvalId: revokedPending.approvalId,
            expectedStatus: "revoked",
            revokedBy: createDeciderInput(),
            revokeReason: "x"
          }),
        (error) => error instanceof BoardApprovalIllegalStatusTransitionError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 listApprovals filters by taskId, runId, status, and lifecyclePhase", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository, { runId: "run_one" });
      taskRepository.createTask(
        createTaskInput({ taskId: TASK_ID_BETA, contractId: "ctr_beta" })
      );
      seedRun(database, TASK_ID_BETA, "run_two");

      const a1 = approvalRepository.createApproval(
        createApprovalInput({ approvalId: "apv_a1", runId: "run_one" })
      );
      const a2 = approvalRepository.createApproval(
        createApprovalInput({ approvalId: "apv_a2", taskId: TASK_ID_BETA, runId: "run_two" })
      );
      const a3 = approvalRepository.createApproval(
        createApprovalInput({ approvalId: "apv_a3", runId: "run_two" })
      );

      approvalRepository.grantApproval({
        approvalId: a1.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "yes"
      });
      approvalRepository.denyApproval({
        approvalId: a2.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "no"
      });

      // by task
      const byTaskAlpha = approvalRepository.listApprovals({ taskId: TASK_ID });
      assert.equal(byTaskAlpha.length, 2);
      assert.deepEqual(
        byTaskAlpha.map((a) => a.approvalId).sort(),
        ["apv_a1", "apv_a3"].sort()
      );
      const byTaskBeta = approvalRepository.listApprovals({ taskId: TASK_ID_BETA });
      assert.equal(byTaskBeta.length, 1);
      assert.equal(byTaskBeta[0].approvalId, a2.approvalId);

      // by run
      const byRunTwo = approvalRepository.listApprovals({ runId: "run_two" });
      assert.equal(byRunTwo.length, 2);
      assert.deepEqual(
        byRunTwo.map((a) => a.approvalId).sort(),
        ["apv_a2", "apv_a3"].sort()
      );
      const byRunOne = approvalRepository.listApprovals({ runId: "run_one" });
      assert.equal(byRunOne.length, 1);
      assert.equal(byRunOne[0].approvalId, a1.approvalId);

      // by status
      const requested = approvalRepository.listApprovals({ status: ["requested"] });
      assert.equal(requested.length, 1);
      assert.equal(requested[0].approvalId, a3.approvalId);

      // by lifecyclePhase (approved == granted)
      const approved = approvalRepository.listApprovals({ lifecyclePhase: ["approved"] });
      assert.equal(approved.length, 1);
      assert.equal(approved[0].approvalId, a1.approvalId);

      // pending (requested) + approved
      const live = approvalRepository.listApprovals({
        lifecyclePhase: ["pending", "approved"]
      });
      assert.equal(live.length, 2);

      // revoked phase groups denied + expired + revoked
      const revoked = approvalRepository.listApprovals({ lifecyclePhase: ["revoked"] });
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].approvalId, a2.approvalId);

      // default includeTerminal=false should hide denied/expired/revoked.
      const liveOnly = approvalRepository.listApprovals();
      assert.equal(liveOnly.length, 2);

      // includeTerminal=true returns everything.
      const all = approvalRepository.listApprovals({ includeTerminal: true });
      assert.equal(all.length, 3);

      assert.deepEqual(
        approvalRepository.listApprovals({ status: ["denied"], includeTerminal: false }),
        []
      );
      assert.deepEqual(
        approvalRepository.listApprovals({ lifecyclePhase: ["revoked"], includeTerminal: false }),
        []
      );

      // limit honored.
      const limited = approvalRepository.listApprovals({ limit: 1 });
      assert.equal(limited.length, 1);
    } finally {
      store.close();
    }
  });
});

test("P03-T07 expectedStatus mismatches raise BoardApprovalConcurrencyError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: created.approvalId,
            expectedStatus: "granted",
            decidedBy: createDeciderInput(),
            decisionReason: "x"
          }),
        (error) =>
          error instanceof BoardApprovalConcurrencyError &&
          error.expectedStatus === "granted" &&
          error.actualStatus === "requested"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 missing approval raises BoardApprovalNotFoundError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      assert.equal(approvalRepository.getApproval("apv_missing"), null);
      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: "apv_missing",
            expectedStatus: "requested",
            decidedBy: createDeciderInput(),
            decisionReason: "x"
          }),
        (error) => error instanceof BoardApprovalNotFoundError && error.approvalId === "apv_missing"
      );
      assert.throws(
        () =>
          approvalRepository.expireApproval({
            approvalId: "apv_missing",
            expectedStatus: "requested"
          }),
        (error) => error instanceof BoardApprovalNotFoundError
      );
      assert.throws(
        () =>
          approvalRepository.revokeApproval({
            approvalId: "apv_missing",
            expectedStatus: "requested",
            revokedBy: createDeciderInput(),
            revokeReason: "x"
          }),
        (error) => error instanceof BoardApprovalNotFoundError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval rejects malformed scope, requester, and timestamps", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ scope: createScopeInput({ effectClass: "S9" }) })
          ),
        /effectClass must be one of/
      );

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ scope: createScopeInput({ action: "Invalid-Action" }) })
          ),
        /action must match/
      );

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ scope: createScopeInput({ targetsJson: "[]" }) })
          ),
        /non-empty array/
      );

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ scope: createScopeInput({ targetsJson: "not-json" }) })
          ),
        /not valid JSON/
      );

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({
              requestedBy: { id: "x", kind: "robot" }
            })
          ),
        /kind must be one of/
      );

      assert.throws(
        () =>
          approvalRepository.createApproval(
            createApprovalInput({ expiresAt: "yesterday" })
          ),
        /valid ISO-8601 timestamp/
      );

      const created = approvalRepository.createApproval(createApprovalInput());
      assert.throws(
        () =>
          approvalRepository.grantApproval({
            approvalId: created.approvalId,
            expectedStatus: "requested",
            decidedBy: createDeciderInput(),
            decisionReason: ""
          }),
        /decision reason must be a non-empty string/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T07 lifecycle phase map matches the documented pending/approved/revoked grouping", () => {
  const expected = {
    requested: "pending",
    granted: "approved",
    denied: "revoked",
    expired: "revoked",
    revoked: "revoked"
  };
  for (const status of BOARD_APPROVAL_STATUSES) {
    const phase = expected[status];
    assert.ok(
      BOARD_APPROVAL_LIFECYCLE_PHASES.includes(phase),
      "phase " + phase + " not in BOARD_APPROVAL_LIFECYCLE_PHASES"
    );
  }

  assert.deepEqual(BOARD_APPROVAL_STATUS_TRANSITIONS.requested, [
    "granted",
    "denied",
    "expired",
    "revoked"
  ]);
  assert.deepEqual(BOARD_APPROVAL_STATUS_TRANSITIONS.granted, ["revoked"]);
  assert.deepEqual(BOARD_APPROVAL_STATUS_TRANSITIONS.denied, []);
  assert.deepEqual(BOARD_APPROVAL_STATUS_TRANSITIONS.expired, []);
  assert.deepEqual(BOARD_APPROVAL_STATUS_TRANSITIONS.revoked, []);

  assert.deepEqual(
    [...BOARD_APPROVAL_TERMINAL_STATUSES].sort(),
    ["denied", "expired", "revoked"].sort()
  );
});

test("P03-T07 grantApproval then revokeApproval exercises the granted->revoked path explicitly", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const created = approvalRepository.createApproval(createApprovalInput());
      const granted = approvalRepository.grantApproval({
        approvalId: created.approvalId,
        expectedStatus: "requested",
        decidedBy: createDeciderInput(),
        decisionReason: "OK"
      });
      assert.equal(granted.status, "granted");
      const revoked = approvalRepository.revokeApproval({
        approvalId: granted.approvalId,
        expectedStatus: "granted",
        revokedBy: createDeciderInput({ id: "auditor" }),
        revokeReason: "Policy v2 forbids this action"
      });
      assert.equal(revoked.status, "revoked");
      assert.equal(revoked.lifecyclePhase, "revoked");
      assert.equal(revoked.decidedBy.id, "auditor");

      const history = approvalRepository.listApprovals({ includeTerminal: true });
      assert.equal(history.length, 1);
      assert.equal(history[0].lifecyclePhase, "revoked");
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval with null runId is allowed when no run association exists", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository, { runId: null });
      const created = approvalRepository.createApproval(
        createApprovalInput({ runId: null })
      );
      assert.equal(created.runId, null);
      const fetched = approvalRepository.getApproval(created.approvalId);
      assert.equal(fetched.runId, null);
    } finally {
      store.close();
    }
  });
});

test("P03-T07 createApproval defaults approvalId to a UUID when not provided", async () => {
  await withTempDatabase((databasePath) => {
    const { store, database, taskRepository, approvalRepository } = buildApprovalsContext(databasePath);
    try {
      seedTaskAndRun(database, taskRepository);
      const a = approvalRepository.createApproval(createApprovalInput());
      const b = approvalRepository.createApproval(createApprovalInput());
      assert.notEqual(a.approvalId, b.approvalId);
      assert.match(a.approvalId, /^apv_/);
      assert.match(b.approvalId, /^apv_/);
    } finally {
      store.close();
    }
  });
});

void BoardApprovalTerminalStatusError;
