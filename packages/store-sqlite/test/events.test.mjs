import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BoardEventAppendError,
  openSqliteBoardEventRepository,
  openSqliteBoardStore,
  SqliteBoardEventRepository,
  SqliteBoardStoreWithRepository
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function withTempDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-p03-t03-events-"));
  try {
    return await fn(path.join(root, "board.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function buildEventRepository(databasePath, now) {
  const store = openSqliteBoardStore({ databasePath, busyTimeoutMs: 7_500 });
  store.migrate();
  const database = new DatabaseSync(databasePath);
  const options = now ? { database, now } : { database };
  const eventRepository = openSqliteBoardEventRepository(options);
  const cleanupStore = {
    close: () => {
      eventRepository.closeDatabase();
      store.close();
    }
  };
  return { store: cleanupStore, eventRepository };
}

function baseEvent(overrides = {}) {
  return {
    aggregateKind: "task",
    aggregateId: "tsk_alpha",
    eventType: "task.created",
    payload: { taskId: "tsk_alpha" },
    ...overrides
  };
}

test("P03-T03 appendEvent persists an immutable event with monotonic aggregate and global sequences", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const result = eventRepository.appendEvent(baseEvent());
      assert.equal(result.event.aggregateKind, "task");
      assert.equal(result.event.aggregateId, "tsk_alpha");
      assert.equal(result.event.aggregateSequence, 0);
      assert.equal(result.event.globalSequence, 0);
      assert.equal(result.event.eventType, "task.created");
      assert.equal(result.event.schemaVersion, "0.1.0");
      assert.equal(typeof result.event.eventId, "string");
      assert.ok(result.event.eventId.startsWith("evt_"));

      const fetched = eventRepository.getEvent(result.event.eventId);
      assert.deepEqual(fetched, result.event);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent assigns independent aggregate sequences per aggregate", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const alphaOne = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_alpha" }));
      const betaOne = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_beta" }));
      const alphaTwo = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_alpha", eventType: "task.transitioned", payload: { taskId: "tsk_alpha" } }));

      assert.equal(alphaOne.event.aggregateSequence, 0);
      assert.equal(betaOne.event.aggregateSequence, 0);
      assert.equal(alphaTwo.event.aggregateSequence, 1);
      assert.equal(alphaOne.event.globalSequence, 0);
      assert.equal(betaOne.event.globalSequence, 1);
      assert.equal(alphaTwo.event.globalSequence, 2);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvents batches multiple events in one transaction", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const result = eventRepository.appendEvents({
        events: [
          baseEvent({ aggregateId: "tsk_alpha", payload: { taskId: "tsk_alpha" } }),
          baseEvent({ aggregateId: "tsk_beta", payload: { taskId: "tsk_beta" } }),
          baseEvent({ aggregateId: "tsk_alpha", eventType: "task.transitioned", payload: { taskId: "tsk_alpha" } })
        ]
      });
      assert.equal(result.events.length, 3);
      assert.equal(result.events[0].globalSequence, 0);
      assert.equal(result.events[1].globalSequence, 1);
      assert.equal(result.events[2].globalSequence, 2);
      assert.equal(result.events[2].aggregateSequence, 1);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent supports explicit event id, causation, correlation, and occurredAt", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const result = eventRepository.appendEvent({
        ...baseEvent(),
        eventId: "evt_explicit_12345678901234567890",
        causationId: "evt_cause_1234567890123456789012",
        correlationId: "corr-abc",
        occurredAt: "2026-06-21T12:00:00.000Z"
      });
      assert.equal(result.event.eventId, "evt_explicit_12345678901234567890");
      assert.equal(result.event.causationId, "evt_cause_1234567890123456789012");
      assert.equal(result.event.correlationId, "corr-abc");
      assert.equal(result.event.occurredAt, "2026-06-21T12:00:00.000Z");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent rejects duplicate event ids", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const eventId = "evt_duplicate_12345678901234567890";
      eventRepository.appendEvent({ ...baseEvent(), eventId });
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), eventId }),
        (error) => error instanceof BoardEventAppendError && error.context.cause === "duplicate_event_id" && error.context.eventId === eventId
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent enforces expectedAggregateSequence", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), expectedAggregateSequence: 5 }),
        (error) => error instanceof BoardEventAppendError && error.context.cause === "aggregate_sequence_conflict" && error.context.expected === 5 && error.context.actual === 0
      );
      eventRepository.appendEvent({ ...baseEvent(), expectedAggregateSequence: 0 });
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent enforces expectedGlobalSequence", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), expectedGlobalSequence: 5 }),
        (error) => error instanceof BoardEventAppendError && error.context.cause === "global_sequence_conflict" && error.context.expected === 5 && error.context.actual === 0
      );
      eventRepository.appendEvent({ ...baseEvent(), expectedGlobalSequence: 0 });
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent supports idempotencyKey replay with identical payload", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const idempotencyKey = "idem-create-alpha";
      const first = eventRepository.appendEvent({ ...baseEvent(), idempotencyKey });
      const second = eventRepository.appendEvent({ ...baseEvent(), idempotencyKey });
      assert.deepEqual(second, first);
      assert.equal(eventRepository.countEvents(), 1);

      const byIdem = eventRepository.getEventByIdempotencyKey(idempotencyKey);
      assert.equal(byIdem.eventId, first.event.eventId);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent rejects idempotencyKey replay with different payload", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const idempotencyKey = "idem-conflict";
      eventRepository.appendEvent({ ...baseEvent(), idempotencyKey, payload: { taskId: "tsk_alpha" } });
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), idempotencyKey, payload: { taskId: "tsk_beta" } }),
        (error) => error instanceof BoardEventAppendError && error.context.cause === "payload_hash_mismatch"
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T03 listEvents filters and orders by global_sequence", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      const a = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_alpha", payload: { taskId: "tsk_alpha" } }));
      eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_beta", eventType: "task.created", payload: { taskId: "tsk_beta" } }));
      const c = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_alpha", eventType: "task.transitioned", payload: { taskId: "tsk_alpha" } }));

      const all = eventRepository.listEvents({ order: "asc" });
      assert.equal(all.length, 3);

      const alpha = eventRepository.listEvents({ aggregateKind: "task", aggregateId: "tsk_alpha" });
      assert.equal(alpha.length, 2);
      assert.equal(alpha[0].eventId, a.event.eventId);
      assert.equal(alpha[1].eventId, c.event.eventId);

      const created = eventRepository.listEvents({ eventType: "task.created" });
      assert.equal(created.length, 2);

      const desc = eventRepository.listEvents({ order: "desc", limit: 1 });
      assert.equal(desc.length, 1);
      assert.equal(desc[0].eventId, c.event.eventId);

      const ranged = eventRepository.listEvents({ fromGlobalSequence: 1, untilGlobalSequence: 2 });
      assert.equal(ranged.length, 2);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 tail returns the most recent events", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_a", payload: { taskId: "tsk_a" } }));
      eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_b", payload: { taskId: "tsk_b" } }));
      const last = eventRepository.appendEvent(baseEvent({ aggregateId: "tsk_c", payload: { taskId: "tsk_c" } }));

      const tail = eventRepository.tail(2);
      assert.equal(tail.length, 2);
      assert.equal(tail[0].eventId, last.event.eventId);
      assert.equal(tail[1].aggregateId, "tsk_b");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 appendEvent rejects unknown aggregate kinds and event types", async () => {
  await withTempDatabase((databasePath) => {
    const { store, eventRepository } = buildEventRepository(databasePath);
    try {
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), aggregateKind: "unknown" }),
        (error) => error instanceof BoardEventAppendError
      );
      assert.throws(
        () => eventRepository.appendEvent({ ...baseEvent(), eventType: "task.unknown" }),
        (error) => error instanceof BoardEventAppendError
      );
    } finally {
      store.close();
    }
  });
});

test("P03-T03 SQLite provider exports the event repository contracts", async () => {
  await withTempDatabase((databasePath) => {
    const { store } = buildEventRepository(databasePath);
    try {
      assert.equal(typeof SqliteBoardEventRepository, "function");
      assert.equal(typeof openSqliteBoardEventRepository, "function");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 task repository mutations emit board_task_events atomically through SqliteBoardStoreWithRepository", async () => {
  await withTempDatabase((databasePath) => {
    const store = SqliteBoardStoreWithRepository.open({ databasePath, busyTimeoutMs: 7_500 });
    try {
      store.migrate();
      const repository = store.repository;
      repository.createTask({
        projectId: "prj_alpha",
        changeId: "chg_alpha",
        taskId: "tsk_alpha",
        contractId: "ctr_alpha",
        contractRevision: 1,
        contractHash: "a".repeat(64),
        initialStatus: "ready"
      });
      repository.transitionTaskStatus("tsk_alpha", { toStatus: "claimed" }, 1);
      repository.updateTaskPriority("tsk_alpha", 900, 1);

      const events = repository.eventRepository.listEvents({ aggregateKind: "task", aggregateId: "tsk_alpha", order: "asc" });
      assert.equal(events.length, 3);
      assert.equal(events[0].eventType, "task.created");
      assert.equal(events[1].eventType, "task.transitioned");
      assert.equal(events[2].eventType, "task.priority_changed");
      assert.equal(events[0].aggregateSequence, 0);
      assert.equal(events[1].aggregateSequence, 1);
      assert.equal(events[2].aggregateSequence, 2);
    } finally {
      store.close();
    }
  });
});

test("P03-T03 task supersede emits task.superseded and task.linked events", async () => {
  await withTempDatabase((databasePath) => {
    const store = SqliteBoardStoreWithRepository.open({ databasePath, busyTimeoutMs: 7_500 });
    try {
      store.migrate();
      const repository = store.repository;
      repository.createTask({
        projectId: "prj_alpha",
        changeId: "chg_alpha",
        taskId: "tsk_alpha",
        contractId: "ctr_alpha",
        contractRevision: 1,
        contractHash: "a".repeat(64)
      });
      repository.supersedeTask({ taskId: "tsk_alpha", expectedGeneration: 1, successorTaskId: "tsk_beta" });

      const superseded = repository.eventRepository.listEvents({ aggregateId: "tsk_alpha", eventType: "task.superseded" });
      assert.equal(superseded.length, 1);
      const linked = repository.eventRepository.listEvents({ aggregateKind: "task_link", aggregateId: "tsk_beta" });
      assert.equal(linked.length, 1);
      assert.equal(linked[0].eventType, "task.linked");
    } finally {
      store.close();
    }
  });
});

test("P03-T03 task delete emits task.deleted event", async () => {
  await withTempDatabase((databasePath) => {
    const store = SqliteBoardStoreWithRepository.open({ databasePath, busyTimeoutMs: 7_500 });
    try {
      store.migrate();
      const repository = store.repository;
      repository.createTask({
        projectId: "prj_alpha",
        changeId: "chg_alpha",
        taskId: "tsk_alpha",
        contractId: "ctr_alpha",
        contractRevision: 1,
        contractHash: "a".repeat(64)
      });
      repository.deleteTask("tsk_alpha", 1);

      const deleted = repository.eventRepository.listEvents({ aggregateId: "tsk_alpha", eventType: "task.deleted" });
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0].payload.generation, 1);
    } finally {
      store.close();
    }
  });
});
