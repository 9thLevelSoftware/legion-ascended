import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CURRENT_PROTOCOL_VERSION,
  applyMigrations,
  assertVersionedRecord,
  createMigrationRegistry,
  generateCompatibilityReport,
  negotiateProtocolVersion,
  protocolEvolutionPolicyDocumentation,
  registerMigration
} from "../../dist/index.js";

async function readCompatibilityFixture(name) {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(await readFile(join(testDirectory, "fixtures", name), "utf8"));
}

function syntheticV1Record() {
  return {
    schemaVersion: "0.1.0",
    id: "synthetic-record",
    payload: {
      count: 1,
      label: "workflow"
    }
  };
}

function syntheticV2Record() {
  return {
    ...syntheticV1Record(),
    schemaVersion: "0.2.0",
    status: "active"
  };
}

function v1ToV2Migration() {
  return {
    id: "synthetic.v1-to-v2",
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    kind: "upcast",
    description: "Adds an explicit status while preserving synthetic payload fields.",
    preserves: ["id", "payload.count", "payload.label"],
    migrate(record) {
      return {
        ...record,
        schemaVersion: "0.2.0",
        status: "active"
      };
    }
  };
}

test("P01-T09 versioned records fail closed without a valid schemaVersion", () => {
  assert.throws(() => assertVersionedRecord({ id: "missing-version" }), /schemaVersion/);
  assert.throws(() => assertVersionedRecord({ schemaVersion: "1.0", id: "invalid-version" }), /semantic schema version/);

  const record = assertVersionedRecord({ schemaVersion: CURRENT_PROTOCOL_VERSION, id: "current-version" });
  assert.equal(record.schemaVersion, CURRENT_PROTOCOL_VERSION);
});

test("P01-T09 canonical compatibility fixtures remain readable", async () => {
  const v1 = await readCompatibilityFixture("synthetic-v1.json");
  const v2 = await readCompatibilityFixture("synthetic-v2.json");

  assert.deepEqual(v1, syntheticV1Record());
  assert.deepEqual(v2, syntheticV2Record());
  assert.equal(assertVersionedRecord(v1).schemaVersion, "0.1.0");
  assert.equal(assertVersionedRecord(v2).schemaVersion, "0.2.0");
});

test("P01-T09 protocol negotiation rejects unsupported old and future versions", () => {
  const current = negotiateProtocolVersion({
    readerVersion: CURRENT_PROTOCOL_VERSION,
    writerVersion: CURRENT_PROTOCOL_VERSION
  });
  assert.equal(current.status, "compatible");
  assert.deepEqual(current.migrationsRequired, []);

  const future = negotiateProtocolVersion({
    readerVersion: CURRENT_PROTOCOL_VERSION,
    writerVersion: "9.0.0"
  });
  assert.equal(future.status, "rejected");
  assert.equal(future.reason, "unsupported_future_version");
  assert.match(future.message, /newer than reader/);

  const old = negotiateProtocolVersion({
    readerVersion: CURRENT_PROTOCOL_VERSION,
    writerVersion: "0.0.1"
  });
  assert.equal(old.status, "rejected");
  assert.equal(old.reason, "unsupported_old_version");
  assert.match(old.message, /no registered migration path/);
});

test("P01-T09 explicit migrations apply in order and are idempotent when repeated", async () => {
  const registry = registerMigration(
    createMigrationRegistry({
      currentVersion: "0.2.0",
      supportedVersions: ["0.1.0", "0.2.0"]
    }),
    v1ToV2Migration()
  );
  const original = await readCompatibilityFixture("synthetic-v1.json");

  const migrated = applyMigrations(original, {
    registry,
    targetVersion: "0.2.0"
  });

  assert.deepEqual(migrated.appliedMigrations, ["synthetic.v1-to-v2"]);
  assert.equal(migrated.record.schemaVersion, "0.2.0");
  assert.equal(migrated.record.status, "active");
  assert.deepEqual(migrated.record.payload, original.payload);
  assert.deepEqual(original, syntheticV1Record());

  const repeated = applyMigrations(migrated.record, {
    registry,
    targetVersion: "0.2.0"
  });
  assert.deepEqual(repeated.appliedMigrations, []);
  assert.deepEqual(repeated.record, migrated.record);
  assert.notEqual(repeated.record, migrated.record);
});

test("P01-T09 migration failures do not partially mutate caller input", async () => {
  const registry = registerMigration(
    createMigrationRegistry({
      currentVersion: "0.2.0",
      supportedVersions: ["0.1.0", "0.2.0"]
    }),
    {
      id: "synthetic.failing-v1-to-v2",
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      kind: "upcast",
      description: "Fails after mutating its private copy.",
      preserves: ["id"],
      migrate(record) {
        record.payload.count = 99;
        throw new Error("synthetic migration failure");
      }
    }
  );
  const original = await readCompatibilityFixture("synthetic-v1.json");

  assert.throws(
    () =>
      applyMigrations(original, {
        registry,
        targetVersion: "0.2.0"
      }),
    /synthetic migration failure/
  );
  assert.deepEqual(original, syntheticV1Record());
});

test("P01-T09 downcasts require explicit information-preservation evidence", () => {
  const registry = createMigrationRegistry({
    currentVersion: "0.2.0",
    supportedVersions: ["0.1.0", "0.2.0"]
  });

  assert.throws(
    () =>
      registerMigration(registry, {
        id: "synthetic.v2-to-v1-lossy",
        fromVersion: "0.2.0",
        toVersion: "0.1.0",
        kind: "downcast",
        description: "Attempts to remove v2 data without proof.",
        preserves: ["id"],
        migrate(record) {
          return {
            ...record,
            schemaVersion: "0.1.0"
          };
        }
      }),
    /information-preserving/
  );
});

test("P01-T09 compatibility reports include matrix and evolution policy text", () => {
  const registry = registerMigration(
    createMigrationRegistry({
      currentVersion: "0.2.0",
      supportedVersions: ["0.1.0", "0.2.0"]
    }),
    v1ToV2Migration()
  );

  const negotiated = negotiateProtocolVersion({
    readerVersion: "0.2.0",
    writerVersion: "0.1.0",
    migrations: registry.migrations,
    supportedVersions: registry.supportedVersions
  });
  assert.equal(negotiated.status, "compatible");
  assert.deepEqual(negotiated.migrationsRequired, ["synthetic.v1-to-v2"]);

  const report = generateCompatibilityReport({ registry });
  assert.match(report, /Compatibility Matrix/);
  assert.match(report, /synthetic\.v1-to-v2/);
  assert.match(report, /Breaking schema changes require a major protocol version or an explicit migration/);
  assert.match(protocolEvolutionPolicyDocumentation, /Deprecated fields require a removal version/);
});
