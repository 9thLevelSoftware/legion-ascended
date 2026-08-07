import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  LEGION_PROTOCOL_MIGRATIONS,
  LEGION_PROTOCOL_VERSION,
  PREVIOUS_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  applyMigrations,
  createMigrationRegistry,
  legionProtocol020To030,
  negotiateProtocolVersion,
  requirementSchema,
  upcastProtocolRecords
} from "../dist/index.js";

/**
 * Protocol 0.3.0, and the reasons an identity migration needs a test at all.
 *
 * The defect this file exists for: `upcastProtocolRecords` swallows a missing
 * migration path in a `catch` and returns the record unchanged, and
 * `schemaVersionSchema` is a regex rather than a literal, so every entity schema
 * accepts any semver. Deleting the 0.2.0 -> 0.3.0 hop therefore reddened nothing
 * anywhere in the tree — a registered claim with no falsifier, which is the
 * exact shape this series has spent ten releases closing.
 *
 * Four claims are made here, each with a mutant that kills it:
 *
 *  1. 0.3.0 is current and both older versions remain supported. Killed by
 *     dropping 0.2.0 from `SUPPORTED_PROTOCOL_VERSIONS` (the registry then
 *     refuses to build at all).
 *  2. A 0.1.0 record still reaches the current version. Killed by deleting the
 *     new migration: with no 0.2.0 -> 0.3.0 edge the breadth-first path search
 *     returns null and `applyMigrations` throws.
 *  3. The hop changes nothing but the version. Killed by any mutant that adds,
 *     drops or rewrites a field — nothing else in the tree checks this, because
 *     "identity" is a claim about what did *not* happen.
 *  4. A kind no migration claims keeps the version it was written under. Killed
 *     by widening `appliesToKinds`. This is the falsifiable direction of that
 *     field; removing a kind from it is *not* falsifiable, because
 *     `migratableKinds()` unions across migrations and the 0.1.0 hop already
 *     claims both. Saying so is better than implying a protection that is not
 *     there.
 */

const FIXED_TIME = "2026-06-22T02:00:00.000Z";

const registry = () =>
  createMigrationRegistry({
    currentVersion: CURRENT_PROTOCOL_VERSION,
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    migrations: LEGION_PROTOCOL_MIGRATIONS
  });

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
    statement: "Legacy requirements remain readable after the 0.3.0 revision.",
    acceptance: {
      language: "Prose acceptance recorded under protocol 0.1.0.",
      criteria: ["The legacy criterion is preserved."],
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

function currentTaskContract() {
  const ref = (path) => ({ path, sha256: `sha256:${"a".repeat(64)}`, mediaType: "text/typescript" });
  return {
    schemaVersion: "0.2.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id: "ctr_two-oh",
    projectId: "prj_legion",
    changeId: "chg_two-oh",
    revision: 1,
    title: "A 0.2.0 contract",
    objective: "Prove the 0.3.0 hop rewrites nothing but the version.",
    requirementIds: ["req_two-oh"],
    wave: "A",
    agents: ["implementer"],
    dependencies: [],
    context: { specRefs: [], designRefs: [ref("design.md")], predecessorArtifacts: [] },
    scope: {
      read: ["a.ts"],
      write: ["b.ts"],
      forbidden: [],
      sequentialFiles: [],
      budget: { maxFilesChanged: 1, maxLinesChanged: 200, maxNewFiles: 1 }
    },
    interfaces: { consumes: [], produces: [{ name: "E", description: "Evidence." }] },
    oracleRefs: ["orc_two-oh"],
    verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0 }],
    risk: { tier: "R2", reasons: ["two-oh"] },
    approvals: [],
    completion: {
      expectedArtifacts: [ref("b.ts")],
      requiredEvidence: ["test output"],
      blockedConditions: ["Verification fails."],
      diffReconciliation: { required: true, allowUnlistedReads: true }
    }
  };
}

test("0.3.0 is current and both older versions remain supported", () => {
  assert.equal(CURRENT_PROTOCOL_VERSION, "0.3.0");
  assert.equal(LEGION_PROTOCOL_VERSION, CURRENT_PROTOCOL_VERSION);
  // The three constants are asserted by value as well as by membership, because
  // `PREVIOUS_PROTOCOL_VERSION` moved in this release — it named 0.1.0 while
  // 0.2.0 was current — and a reader who assumes otherwise gets a silently wrong
  // answer rather than a type error.
  assert.equal(LEGACY_PROTOCOL_VERSION, "0.1.0");
  assert.equal(PREVIOUS_PROTOCOL_VERSION, "0.2.0");
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ["0.1.0", "0.2.0", "0.3.0"]);
});

test("a 0.1.0 record still reaches the current version, by chaining both hops", () => {
  // The claim the identity migration actually carries. Without the 0.2.0 ->
  // 0.3.0 edge there is no path from 0.1.0 to 0.3.0 at all, so every 0.1.0
  // document on disk would stop being readable the moment the current version
  // moved — and `upcastProtocolRecords`' catch would hide it.
  const { record, appliedMigrations } = applyMigrations(legacyRequirement(), { registry: registry() });

  assert.deepEqual(appliedMigrations, [
    "legion.protocol.0-1-0.to.0-2-0",
    "legion.protocol.0-2-0.to.0-3-0"
  ]);
  assert.equal(record.schemaVersion, "0.3.0");

  // And the 0.1.0 hop's work survives the second hop rather than being flattened
  // by it: the migrated criterion still parses as a criterion object.
  const parsed = requirementSchema.parse(record);
  assert.equal(parsed.acceptance.criteria[0].id, "ac_migrated-1");
  assert.equal(parsed.acceptance.criteria[0].proof.mode, "manual");
});

test("the 0.2.0 to 0.3.0 hop changes nothing but the version", () => {
  // "Identity" is a claim about what did not happen, so it is asserted over a
  // whole contract rather than over a field list that would go stale.
  const before = currentTaskContract();
  const after = legionProtocol020To030.migrate(before);

  assert.equal(after.schemaVersion, "0.3.0");
  assert.deepEqual({ ...after, schemaVersion: "0.2.0" }, before);
  assert.equal(legionProtocol020To030.informationPreserving, true);
});

test("a 0.2.0 document of a claimed kind is renumbered on read", () => {
  // The read path, not the registry. This is the assertion that dies when the
  // migration is deleted, because `upcastProtocolRecords` catches the resulting
  // throw and hands the record back untouched.
  const upcast = upcastProtocolRecords(currentTaskContract());
  assert.equal(upcast.schemaVersion, "0.3.0");
  assert.deepEqual(upcast.scope.budget, { maxFilesChanged: 1, maxLinesChanged: 200, maxNewFiles: 1 });
});

test("a kind no migration claims keeps the version it was written under", () => {
  // `review` is a kind this release changed — PR 7 added `domains` to it — and
  // it is deliberately NOT claimed. The migration renumbers nothing, so claiming
  // more kinds buys no readability and only widens which on-disk documents get
  // renumbered when a writer round-trips them.
  const review = {
    schemaVersion: "0.2.0",
    kind: "review",
    id: "rev_x",
    domains: ["architecture"],
    nested: { a: 1 }
  };
  assert.deepEqual(upcastProtocolRecords(review), review);
});

test("negotiateProtocolVersion refuses 0.3.0 at a 0.2.0 reader, and accepts 0.2.0 at a 0.3.0 one", () => {
  // The condition the version exists to signal, asserted rather than argued. A
  // bump nobody can observe is a number in a file.
  //
  // **The title names the function, and that is the correction of an
  // overclaim.** It used to read "a 0.2.0 reader refuses a 0.3.0 document",
  // which states more than this test checks and more than is true of the
  // shipping reader: nothing in this tree's production read path calls
  // `negotiateProtocolVersion`, so the previous release's CLI, pointed at a
  // workspace whose task contracts are on disk at `schemaVersion: "0.3.0"`,
  // neither refuses nor warns — measured, it evaluates every gate and reports
  // `{"ok":true,"status":"ready"}`. What actually refuses an unrepresentable
  // 0.3.0 document at an older reader is `z.strictObject`'s unknown-key rule,
  // and only for a document that exercises a new field. ADR-011 states the
  // narrow claim; this title now states it too, because a reader checking the
  // bump's justification lands here.
  const older = negotiateProtocolVersion({
    readerVersion: "0.2.0",
    writerVersion: "0.3.0",
    supportedVersions: ["0.1.0", "0.2.0"]
  });
  assert.equal(older.status, "rejected");
  assert.equal(older.reason, "unsupported_future_version");

  const newer = negotiateProtocolVersion({
    readerVersion: CURRENT_PROTOCOL_VERSION,
    writerVersion: "0.2.0",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    migrations: LEGION_PROTOCOL_MIGRATIONS
  });
  assert.equal(newer.status, "compatible");
});
