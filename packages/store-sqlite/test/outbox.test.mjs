import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOARD_OUTBOX_EFFECT_CLASSES,
  BOARD_OUTBOX_STATUSES,
  BoardOutboxConcurrencyError,
  BoardOutboxNotFoundError,
  BoardOutboxTerminalStatusError,
  openSqliteBoardOutboxRepository,
  openSqliteBoardStore,
  SqliteBoardOutboxRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t05-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildRepository(databasePath, now = () => "2026-06-21T12:00:00.000Z") {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  return {
    store,
    repository: openSqliteBoardOutboxRepository({ database: new DatabaseSync(databasePath), now })
  };
}

function createInput(overrides = {}) {
  return {
    effectClass: "S0",
    effectKind: "dispatch.test",
    targetHash: "a".repeat(64),
    payload: { z: 1, a: { b: 2 } },
    ...overrides
  };
}

test("P03-T05 enqueueOutbox canonicalizes payload JSON and supports filtered listing", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      const created = repository.enqueueOutbox(
        createInput({
          outboxId: "outbox_alpha",
          idempotencyKey: "idem-alpha"
        })
      );
      assert.equal(created.outboxId, "outbox_alpha");
      assert.equal(created.idempotencyKey, "idem-alpha");
      assert.equal(created.effectClass, "S0");
      assert.equal(created.effectKind, "dispatch.test");
      assert.equal(created.targetHash, "a".repeat(64));
      assert.equal(created.payloadJson, JSON.stringify({ a: { b: 2 }, z: 1 }));
      assert.deepEqual(created.payload, { a: { b: 2 }, z: 1 });
      assert.equal(created.status, "pending");
      assert.equal(created.attempts, 0);

      const listed = repository.listOutbox({
        status: ["pending"],
        effectClass: ["S0"],
        effectKind: "dispatch.test",
        availableBefore: "2026-06-21T12:00:00.000Z"
      });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].outboxId, "outbox_alpha");
      assert.deepEqual(repository.getOutbox("outbox_alpha"), created);
      assert.deepEqual(repository.getOutboxByIdempotencyKey("idem-alpha"), created);
    } finally {
      repository.closeDatabase();
      store.close();
    }
  });
});

test("P03-T05 enqueueOutbox reuses duplicate idempotency keys only for the same intent", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      const input = createInput({ idempotencyKey: "idem-duplicate" });
      const first = repository.enqueueOutbox(input);
      const replay = repository.enqueueOutbox(input);
      assert.deepEqual(replay, first);

      assert.throws(
        () =>
          repository.enqueueOutbox(
            createInput({
              outboxId: "outbox_beta",
              effectKind: "dispatch.other",
              payload: { first: true },
              idempotencyKey: "idem-duplicate"
            })
          ),
        /idempotencyKey .*different intent/
      );
      const other = repository.enqueueOutbox(
        createInput({ outboxId: "outbox_gamma", idempotencyKey: "idem-gamma" })
      );
      assert.equal(other.outboxId, "outbox_gamma");
      assert.equal(repository.listOutbox({}).length, 2);

      const raw = new DatabaseSync(databasePath);
      try {
        const outboxCount = raw.prepare("SELECT COUNT(*) AS count FROM board_outbox").get();
        const idempotencyCount = raw
          .prepare("SELECT COUNT(*) AS count FROM board_idempotency_records WHERE scope = ?")
          .get("board.outbox.enqueue");
        assert.equal(outboxCount.count, 2);
        assert.equal(idempotencyCount.count, 2);
      } finally {
        raw.close();
      }
    } finally {
      repository.closeDatabase();
      store.close();
    }
  });
});

test("P03-T05 claimOutbox and markOutboxAttempt track retries and terminal statuses", async () => {
  await withTempDatabase((databasePath) => {
    const clock = { current: "2026-06-21T12:00:00.000Z" };
    const { store, repository } = buildRepository(databasePath, () => clock.current);
    try {
      const created = repository.enqueueOutbox(createInput({ outboxId: "outbox_retry" }));
      const claimed = repository.claimOutbox({
        outboxId: created.outboxId,
        claimedBy: "worker-1",
        claimedUntil: "2026-06-21T13:00:00.000Z",
        now: clock.current
      });
      assert.equal(claimed.status, "claimed");
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.claimedBy, "worker-1");

      const failed = repository.markOutboxAttempt({
        outboxId: created.outboxId,
        result: "failed",
        lastError: "boom",
        nextAvailableAt: "2026-06-21T12:05:00.000Z",
        updatedAt: "2026-06-21T12:01:00.000Z"
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, "boom");
      assert.equal(failed.availableAt, "2026-06-21T12:05:00.000Z");
      assert.equal(failed.claimedBy, null);
      assert.equal(failed.attempts, 1);

      assert.throws(
        () =>
          repository.claimOutbox({
            outboxId: created.outboxId,
            claimedBy: "worker-2",
            claimedUntil: "2026-06-21T13:30:00.000Z",
            now: "2026-06-21T12:03:00.000Z"
          }),
        (error) => error instanceof BoardOutboxConcurrencyError
      );

      clock.current = "2026-06-21T12:06:00.000Z";
      const retried = repository.claimOutbox({
        outboxId: created.outboxId,
        claimedBy: "worker-2",
        claimedUntil: "2026-06-21T13:30:00.000Z",
        now: clock.current
      });
      assert.equal(retried.status, "claimed");
      assert.equal(retried.attempts, 2);

      const succeeded = repository.markOutboxAttempt({
        outboxId: created.outboxId,
        result: "succeeded",
        updatedAt: "2026-06-21T12:06:30.000Z"
      });
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.claimedBy, null);
      assert.equal(succeeded.attempts, 2);

      assert.throws(
        () =>
          repository.claimOutbox({
            outboxId: created.outboxId,
            claimedBy: "worker-3",
            claimedUntil: "2026-06-21T14:00:00.000Z",
            now: "2026-06-21T12:07:00.000Z"
          }),
        (error) => error instanceof BoardOutboxTerminalStatusError
      );
    } finally {
      repository.closeDatabase();
      store.close();
    }
  });
});

test("P03-T05 claimOutbox throws not found for missing rows", async () => {
  await withTempDatabase((databasePath) => {
    const { store, repository } = buildRepository(databasePath);
    try {
      assert.throws(
        () =>
          repository.claimOutbox({
            outboxId: "missing-outbox",
            claimedBy: "worker-1",
            claimedUntil: "2026-06-21T13:00:00.000Z"
          }),
        (error) => error instanceof BoardOutboxNotFoundError && error.outboxId === "missing-outbox"
      );
    } finally {
      repository.closeDatabase();
      store.close();
    }
  });
});
