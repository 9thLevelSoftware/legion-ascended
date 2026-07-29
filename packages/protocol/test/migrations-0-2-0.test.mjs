import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CURRENT_PROTOCOL_VERSION,
  LEGION_PROTOCOL_MIGRATIONS,
  MIGRATED_BUDGET_ANNOTATION,
  MIGRATED_CRITERIA_ANNOTATION,
  MIGRATED_VALUE,
  SUPPORTED_PROTOCOL_VERSIONS,
  applyMigrations,
  createMigrationRegistry,
  legionProtocol010To020,
  requirementSchema,
  taskContractSchema
} from "../dist/index.js";

const registry = () =>
  createMigrationRegistry({
    currentVersion: CURRENT_PROTOCOL_VERSION,
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    migrations: LEGION_PROTOCOL_MIGRATIONS
  });

const FIXED_TIME = "2026-06-22T02:00:00.000Z";

function legacyRequirement() {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "requirement",
    id: "req_legacy-import",
    projectId: "prj_legion",
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: "Legacy requirements remain readable after the 0.2.0 revision.",
    acceptance: {
      language: "Prose acceptance recorded under protocol 0.1.0.",
      criteria: ["The legacy criterion is preserved.", "A second criterion is preserved."],
      oracleRefs: []
    },
    traceRefs: [
      {
        path: ".legion/project/specs/req_legacy-import.md",
        anchor: "req_legacy-import",
        relation: "defines",
        entity: { kind: "requirement", id: "req_legacy-import" }
      }
    ],
    supersedes: []
  };
}

function legacyTaskContract() {
  const ref = (path) => ({
    path,
    sha256: `sha256:${"a".repeat(64)}`,
    mediaType: "text/typescript"
  });
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id: "ctr_legacy-task",
    projectId: "prj_legion",
    changeId: "chg_legacy",
    revision: 1,
    title: "Legacy task",
    objective: "Prove that 0.1.0 contracts upcast without inventing a wide budget.",
    requirementIds: ["req_legacy-import"],
    wave: "A",
    agents: ["legacy-agent"],
    dependencies: [],
    context: { specRefs: [], designRefs: [ref("design.md")], predecessorArtifacts: [] },
    scope: {
      read: ["packages/protocol/src/index.ts"],
      write: ["packages/protocol/src/a.ts", "packages/protocol/src/b.ts"],
      forbidden: [".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [],
      produces: [{ name: "Evidence", description: "Build evidence." }]
    },
    oracleRefs: ["orc_legacy"],
    verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0 }],
    risk: { tier: "R2", reasons: ["legacy"] },
    approvals: [],
    completion: {
      expectedArtifacts: [ref("packages/protocol/src/a.ts")],
      requiredEvidence: ["test output"],
      blockedConditions: ["Verification fails."]
    }
  };
}

test("0.2.0 is current and 0.1.0 remains supported", () => {
  assert.equal(CURRENT_PROTOCOL_VERSION, "0.2.0");
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes("0.1.0"));
  assert.equal(legionProtocol010To020.informationPreserving, false);
});

test("legacy requirements upcast to criterion objects that validate", () => {
  const { record, appliedMigrations } = applyMigrations(legacyRequirement(), { registry: registry() });

  assert.deepEqual(appliedMigrations, ["legion.protocol.0-1-0.to.0-2-0"]);
  assert.equal(record.schemaVersion, "0.2.0");

  const parsed = requirementSchema.parse(record);
  assert.equal(parsed.acceptance.criteria.length, 2);
  assert.equal(parsed.acceptance.criteria[0].id, "ac_migrated-1");
  assert.equal(parsed.acceptance.criteria[0].statement, "The legacy criterion is preserved.");
  // Prose criteria carried no command, so the upcast must not claim one.
  assert.equal(parsed.acceptance.criteria[0].proof.mode, "manual");
  assert.equal(record.metadata.annotations[MIGRATED_CRITERIA_ANNOTATION], MIGRATED_VALUE);
});

test("legacy task contracts receive a fail-safe budget rather than a fabricated one", () => {
  const { record } = applyMigrations(legacyTaskContract(), { registry: registry() });
  const parsed = taskContractSchema.parse(record);

  // Two declared write paths -> the tightest budget that still permits them.
  assert.deepEqual(parsed.scope.budget, {
    maxFilesChanged: 2,
    maxLinesChanged: 400,
    maxNewFiles: 2
  });
  assert.equal(parsed.completion.diffReconciliation.required, true);
  assert.equal(record.metadata.annotations[MIGRATED_BUDGET_ANNOTATION], MIGRATED_VALUE);
});

test("the upcast is idempotent for already-migrated records", () => {
  const once = applyMigrations(legacyTaskContract(), { registry: registry() }).record;
  const twice = legionProtocol010To020.migrate({ ...once, schemaVersion: "0.1.0" });

  assert.deepEqual(twice.scope.budget, once.scope.budget);
  assert.deepEqual(twice.completion.diffReconciliation, once.completion.diffReconciliation);
});

test("records of unrelated kinds pass through with only a version change", () => {
  const decision = {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "decision",
    id: "dec_unrelated"
  };
  const migrated = legionProtocol010To020.migrate(decision);

  assert.equal(migrated.schemaVersion, "0.2.0");
  assert.equal(migrated.kind, "decision");
  assert.equal(migrated.id, "dec_unrelated");
});
