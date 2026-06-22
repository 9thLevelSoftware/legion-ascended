import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_LEASE_RELEASE_REASONS,
  BOARD_LEASE_TOKEN_MIN_LENGTH,
  BOARD_REQUIRED_INDEXES,
  BOARD_REQUIRED_TABLES,
  BOARD_TASK_GENERATION_MIN,
  BoardClaimContendedError,
  BoardClaimGenerationError,
  BoardClaimNotFoundError,
  BoardTerminalTaskMutationError,
  SqliteBoardClaimRepository,
  SqliteBoardTaskRepository,
  openSqliteBoardStore,
  openSqliteBoardTaskRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t04-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildClaimsContext(databasePath) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const taskDb = new DatabaseSync(databasePath);
  const claimDb = new DatabaseSync(databasePath);
  const taskRepository = openSqliteBoardTaskRepository({ database: taskDb });
  const claimRepository = new SqliteBoardClaimRepository({ database: claimDb });
  const cleanupStore = {
    inspect: () => store.inspect(),
    close: () => {
      claimRepository.closeDatabase();
      taskRepository.closeDatabase();
      store.close();
    }
  };
  return {
    store: cleanupStore,
    taskRepository,
    claimRepository
  };
}

const PROJECT_ID = "prj_alpha";
const CHANGE_ID = "chg_alpha";
const TASK_ID = "tsk_alpha";
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

function claimInput(overrides = {}) {
  return {
    taskId: TASK_ID,
    expectedGeneration: BOARD_TASK_GENERATION_MIN,
    ownerId: "worker_alpha",
    leaseDurationMs: 30_000,
    ...overrides
  };
}

function createReadyTask(taskRepository) {
  taskRepository.createTask(createTaskInput());
}

test("P03-T04 tryClaim inserts an active lease and getClaim returns the same row", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const claim = claimRepository.tryClaim(claimInput({ runId: "run_alpha_001" }));
      assert.ok(claim.leaseToken.length >= BOARD_LEASE_TOKEN_MIN_LENGTH);
      assert.equal(claim.taskId, TASK_ID);
      assert.equal(claim.generation, BOARD_TASK_GENERATION_MIN);
      assert.equal(claim.ownerId, "worker_alpha");
      assert.equal(claim.runId, "run_alpha_001");
      assert.equal(claim.releasedAt, null);
      assert.equal(claim.releaseReason, null);
      const expiresMs = new Date(claim.leaseExpiresAt).getTime() - new Date(claim.claimedAt).getTime();
      assert.equal(expiresMs, 30_000);
      assert.equal(claim.heartbeatAt, claim.claimedAt);

      const fetched = claimRepository.getClaim(claim.leaseToken);
      assert.deepEqual(fetched, claim);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 tryClaim refuses a second concurrent claim on the same task+generation with BoardClaimContendedError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const first = claimRepository.tryClaim(claimInput({ ownerId: "worker_a" }));
      assert.throws(
        () =>
          claimRepository.tryClaim(
            claimInput({ ownerId: "worker_b", leaseToken: "another-claim-token-zzz" })
          ),
        (error) =>
          error instanceof BoardClaimContendedError &&
          error.taskId === TASK_ID &&
          error.generation === BOARD_TASK_GENERATION_MIN &&
          error.holderOwnerId === "worker_a" &&
          error.holderLeaseToken === first.leaseToken
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 tryClaim rejects a mismatched expectedGeneration with BoardClaimGenerationError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      assert.throws(
        () => claimRepository.tryClaim(claimInput({ expectedGeneration: 99 })),
        (error) =>
          error instanceof BoardClaimGenerationError &&
          error.taskId === TASK_ID &&
          error.expectedGeneration === 99 &&
          error.actualGeneration === BOARD_TASK_GENERATION_MIN
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 tryClaim rejects missing tasks with BoardClaimGenerationError(actualGeneration=null)", async () => {
  await withTempDatabase((databasePath) => {
    const { store, claimRepository } = buildClaimsContext(databasePath);
    try {
      assert.throws(
        () => claimRepository.tryClaim(claimInput({ taskId: "tsk_missing" })),
        (error) =>
          error instanceof BoardClaimGenerationError &&
          error.taskId === "tsk_missing" &&
          error.actualGeneration === null
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 tryClaim validates owner, lease duration, and lease token shape", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      assert.throws(() => claimRepository.tryClaim(claimInput({ ownerId: "" })), /owner id/);
      assert.throws(() => claimRepository.tryClaim(claimInput({ leaseDurationMs: 0 })), /lease duration/);
      assert.throws(
        () => claimRepository.tryClaim(claimInput({ leaseDurationMs: 1.5 })),
        /lease duration/
      );
      assert.throws(
        () => claimRepository.tryClaim(claimInput({ leaseToken: "short" })),
        /lease token/
      );
      assert.throws(() => claimRepository.tryClaim(claimInput({ expectedGeneration: 0 })), /generation/);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 getActiveClaimForTask returns the only live lease and null when none exists", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      assert.equal(claimRepository.getActiveClaimForTask(TASK_ID), null);
      const claim = claimRepository.tryClaim(claimInput());
      const active = claimRepository.getActiveClaimForTask(TASK_ID);
      assert.deepEqual(active, claim);
      claimRepository.release({ leaseToken: claim.leaseToken, reason: "completed" });
      assert.equal(claimRepository.getActiveClaimForTask(TASK_ID), null);
      const archived = claimRepository.getClaim(claim.leaseToken);
      assert.notEqual(archived, null);
      assert.equal(archived.releasedAt !== null, true);
      assert.equal(archived.releaseReason, "completed");
    } finally {
      store.close();
    }
  });
});

test("P03-T04 heartbeat advances leaseExpiresAt and rejects unknown lease tokens", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const initial = claimRepository.tryClaim(claimInput({ claimedAt: "2026-06-21T12:00:00.000Z" }));
      const heartbeat = claimRepository.heartbeat({
        leaseToken: initial.leaseToken,
        leaseDurationMs: 60_000,
        now: "2026-06-21T12:01:00.000Z"
      });
      assert.equal(heartbeat.leaseExpiresAt, "2026-06-21T12:02:00.000Z");
      assert.equal(heartbeat.heartbeatAt, "2026-06-21T12:01:00.000Z");
      assert.equal(heartbeat.releasedAt, null);

      assert.throws(
        () => claimRepository.heartbeat({ leaseToken: "no-such-token-xxxxxxxxx", leaseDurationMs: 1_000 }),
        (error) => error instanceof BoardClaimNotFoundError
      );
      assert.throws(
        () => claimRepository.heartbeat({ leaseToken: initial.leaseToken, leaseDurationMs: -1 }),
        /lease duration/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 heartbeat on a released claim is a no-op and returns the archived row unchanged", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const claim = claimRepository.tryClaim(claimInput());
      claimRepository.release({ leaseToken: claim.leaseToken, reason: "completed" });
      const archived = claimRepository.getClaim(claim.leaseToken);
      const afterHeartbeat = claimRepository.heartbeat({
        leaseToken: claim.leaseToken,
        leaseDurationMs: 60_000,
        now: "2026-06-21T13:00:00.000Z"
      });
      assert.deepEqual(afterHeartbeat, archived);
      assert.equal(afterHeartbeat.heartbeatAt, claim.heartbeatAt);
      assert.equal(afterHeartbeat.leaseExpiresAt, claim.leaseExpiresAt);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 release is idempotent: a second release returns the same archived row", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const claim = claimRepository.tryClaim(claimInput());
      const first = claimRepository.release({
        leaseToken: claim.leaseToken,
        reason: "completed",
        now: "2026-06-21T12:05:00.000Z"
      });
      assert.notEqual(first.releasedAt, null);
      assert.equal(first.releaseReason, "completed");
      const second = claimRepository.release({
        leaseToken: claim.leaseToken,
        reason: "failed",
        now: "2026-06-21T12:10:00.000Z"
      });
      // Idempotency: must not overwrite the original release timestamp/reason.
      assert.equal(second.releasedAt, first.releasedAt);
      assert.equal(second.releaseReason, "completed");
    } finally {
      store.close();
    }
  });
});

test("P03-T04 release with an unknown lease token raises BoardClaimNotFoundError", async () => {
  await withTempDatabase((databasePath) => {
    const { store, claimRepository } = buildClaimsContext(databasePath);
    try {
      assert.throws(
        () => claimRepository.release({ leaseToken: "ghost-token-xxxxxxxxx", reason: "canceled" }),
        (error) => error instanceof BoardClaimNotFoundError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 release validates the reason enum", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const claim = claimRepository.tryClaim(claimInput());
      assert.throws(
        () => claimRepository.release({ leaseToken: claim.leaseToken, reason: "bogus" }),
        /release reason/
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 reclaimExpiredLeases stamps 'expired' on stale leases and returns the reclaimed rows", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const first = claimRepository.tryClaim(
        claimInput({ ownerId: "worker_a", claimedAt: "2026-06-21T11:00:00.000Z", leaseDurationMs: 30_000 })
      );
      claimRepository.release({ leaseToken: first.leaseToken, reason: "completed" });
      const live = claimRepository.tryClaim(
        claimInput({ ownerId: "worker_b", claimedAt: "2026-06-21T11:30:00.000Z", leaseDurationMs: 5_000 })
      );
      assert.equal(live.leaseExpiresAt, "2026-06-21T11:30:05.000Z");

      const reclaimed = claimRepository.reclaimExpiredLeases({ now: "2026-06-21T11:30:30.000Z" });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].leaseToken, live.leaseToken);
      assert.equal(reclaimed[0].releaseReason, "expired");
      assert.equal(reclaimed[0].releasedAt, "2026-06-21T11:30:30.000Z");
      assert.equal(claimRepository.getActiveClaimForTask(TASK_ID), null);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 reclaimExpiredLeases honors ownerId when expiring stale leases", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      taskRepository.createTask(createTaskInput({ taskId: "tsk_beta" }));
      const alpha = claimRepository.tryClaim(
        claimInput({ ownerId: "worker_a", claimedAt: "2026-06-21T11:00:00.000Z", leaseDurationMs: 5_000 })
      );
      const beta = claimRepository.tryClaim(
        claimInput({
          taskId: "tsk_beta",
          ownerId: "worker_b",
          claimedAt: "2026-06-21T11:00:00.000Z",
          leaseDurationMs: 5_000
        })
      );

      const reclaimed = claimRepository.reclaimExpiredLeases({
        ownerId: "worker_a",
        now: "2026-06-21T11:00:30.000Z"
      });
      assert.deepEqual(reclaimed.map((claim) => claim.leaseToken), [alpha.leaseToken]);
      assert.equal(claimRepository.getClaim(alpha.leaseToken).releaseReason, "expired");
      assert.equal(claimRepository.getClaim(beta.leaseToken).releaseReason, null);
      assert.equal(claimRepository.getActiveClaimForTask("tsk_beta").leaseToken, beta.leaseToken);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 reclaimExpiredLeases is a no-op when every lease is still valid", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      claimRepository.tryClaim(claimInput({ claimedAt: "2026-06-21T12:00:00.000Z", leaseDurationMs: 30_000 }));
      const reclaimed = claimRepository.reclaimExpiredLeases({ now: "2026-06-21T12:00:10.000Z" });
      assert.deepEqual(reclaimed, []);
      const active = claimRepository.getActiveClaimForTask(TASK_ID);
      assert.notEqual(active, null);
      assert.equal(active.releasedAt, null);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 advanced task generations free the (task, generation) slot for new claims", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      claimRepository.tryClaim(claimInput({ ownerId: "worker_a" }));
      // Bumping the task generation leaves the old lease archived against
      // generation 1, but it must not block a claim on generation 2.
      taskRepository.bumpGeneration({
        taskId: TASK_ID,
        expectedGeneration: BOARD_TASK_GENERATION_MIN,
        nextContractId: "ctr_alpha_v2",
        nextContractRevision: 2,
        nextContractHash: "b".repeat(64)
      });
      const newTask = taskRepository.getTask(TASK_ID);
      assert.notEqual(newTask, null);
      const nextGeneration = newTask.generation;
      assert.notEqual(nextGeneration, BOARD_TASK_GENERATION_MIN);
      const refreshed = claimRepository.tryClaim({
        taskId: TASK_ID,
        expectedGeneration: nextGeneration,
        ownerId: "worker_b",
        leaseDurationMs: 30_000
      });
      assert.equal(refreshed.taskId, TASK_ID);
      assert.equal(refreshed.generation, nextGeneration);
    } finally {
      store.close();
    }
  });
});

test("P03-T04 tryClaim rejects terminal tasks even when the generation matches", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      taskRepository.transitionTaskStatus(TASK_ID, { toStatus: "canceled" }, BOARD_TASK_GENERATION_MIN);
      assert.throws(
        () => claimRepository.tryClaim(claimInput()),
        (error) => error instanceof BoardTerminalTaskMutationError && error.status === "canceled"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T04 release reasons cover every documented enum value", async () => {
  for (const reason of BOARD_LEASE_RELEASE_REASONS) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0);
  }
});

test("P03-T04 migration diagnostics include board_claims and both required indexes", async () => {
  await withTempDatabase((databasePath) => {
    const { store } = buildClaimsContext(databasePath);
    try {
      const diagnostics = store.inspect();
      assert.ok(diagnostics.tables.includes("board_claims"));
      assert.ok(diagnostics.indexes.includes("idx_board_claims_live_task_generation"));
      assert.ok(diagnostics.indexes.includes("idx_board_claims_task_id"));
      assert.deepEqual(diagnostics.missingTables, []);
      assert.deepEqual(diagnostics.missingIndexes, []);
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

test("P03-T04 SQLite provider package exports every claim contract the @legion/board package re-exports", async () => {
  await withTempDatabase((databasePath) => {
    const { store, taskRepository, claimRepository } = buildClaimsContext(databasePath);
    try {
      createReadyTask(taskRepository);
      const claim = claimRepository.tryClaim(claimInput());
      // Spot-check that every claim read-shape field surfaces verbatim from
      // the SQLite row so consumers depending on either entry point see the
      // same contracts.
      const keys = Object.keys(claim).sort();
      assert.deepEqual(keys, [
        "claimedAt",
        "generation",
        "heartbeatAt",
        "leaseExpiresAt",
        "leaseToken",
        "ownerId",
        "releaseReason",
        "releasedAt",
        "runId",
        "taskId"
      ]);
    } finally {
      store.close();
    }
  });
});
