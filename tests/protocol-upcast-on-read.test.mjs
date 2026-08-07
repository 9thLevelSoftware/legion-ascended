import assert from "node:assert/strict";
import { test } from "node:test";

import { upcastProtocolRecords } from "../packages/protocol/dist/index.js";

const FIXED_TIME = "2026-06-22T02:00:00.000Z";
const REF = (path) => ({ path, sha256: `sha256:${"a".repeat(64)}`, mediaType: "text/typescript" });

function legacyTaskContract(id = "ctr_legacy") {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id,
    projectId: "prj_legion",
    changeId: "chg_legacy",
    revision: 1,
    title: "Legacy task",
    objective: "Prove nested contracts upcast on read.",
    requirementIds: ["req_legacy"],
    wave: "A",
    agents: ["implementer"],
    dependencies: [],
    context: { specRefs: [], designRefs: [REF("design.md")], predecessorArtifacts: [] },
    scope: {
      read: ["a.ts"],
      write: ["b.ts", "c.ts"],
      forbidden: [],
      sequentialFiles: []
    },
    interfaces: { consumes: [], produces: [{ name: "E", description: "Evidence." }] },
    oracleRefs: ["orc_legacy"],
    verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0 }],
    risk: { tier: "R2", reasons: ["legacy"] },
    approvals: [],
    completion: {
      expectedArtifacts: [REF("b.ts")],
      requiredEvidence: ["test output"],
      blockedConditions: ["Verification fails."]
    }
  };
}

test("a legacy task contract gains the fields 0.2.0 requires", () => {
  const upcast = upcastProtocolRecords(legacyTaskContract());

  // 0.3.0, not 0.2.0: the walk chains every registered hop up to the current
  // version, and the 0.2.0 -> 0.3.0 identity is what keeps this record readable
  // at all now that the current version has moved past the hop that repairs it.
  assert.equal(upcast.schemaVersion, "0.3.0");
  // Two declared write paths -> the tightest budget that still permits them.
  assert.deepEqual(upcast.scope.budget, { maxFilesChanged: 2, maxLinesChanged: 400, maxNewFiles: 2 });
  assert.equal(upcast.completion.diffReconciliation.required, true);
});

test("task contracts nested inside a taskgraph are upcast, not just the envelope", () => {
  // The failure this guards against: renumbering the outer schemaVersion while
  // leaving contents at the old shape produces a document that claims to be
  // current and is not.
  const legacyTaskgraph = {
    schemaVersion: "0.1.0",
    kind: "taskgraph",
    changeId: "chg_legacy",
    revision: 1,
    artifactInputs: [],
    tasks: [legacyTaskContract("ctr_one"), legacyTaskContract("ctr_two")],
    artifactManifest: {
      schemaVersion: "0.1.0",
      kind: "change-artifact-manifest",
      changeId: "chg_legacy",
      inputs: [],
      evidenceRefs: [],
      manifestHash: `sha256:${"b".repeat(64)}`
    }
  };

  const upcast = upcastProtocolRecords(legacyTaskgraph);

  assert.equal(upcast.tasks.length, 2);
  for (const task of upcast.tasks) {
    assert.equal(task.schemaVersion, "0.3.0");
    assert.ok(task.scope.budget !== undefined, `${task.id} did not gain a budget`);
    assert.ok(task.completion.diffReconciliation !== undefined);
  }

  // Artifact envelopes are versioned by their own constants, not by the
  // protocol version, and the manifest embeds a hash over its own fields.
  // Rewriting these on read invalidated that self-hash and made every taskgraph
  // read fail with manifest_hash_mismatch.
  assert.equal(upcast.schemaVersion, "0.1.0");
  assert.equal(upcast.artifactManifest.schemaVersion, "0.1.0");
  assert.equal(upcast.artifactManifest.manifestHash, legacyTaskgraph.artifactManifest.manifestHash);
});

test("only kinds a migration claims are touched", () => {
  // The guard that keeps the walk from guessing. `change-artifact-manifest` has
  // no registered migration, so its version is left exactly as written.
  const envelope = {
    schemaVersion: "0.1.0",
    kind: "change-artifact-manifest",
    changeId: "chg_x",
    inputs: [],
    evidenceRefs: [],
    manifestHash: `sha256:${"c".repeat(64)}`
  };
  assert.deepEqual(upcastProtocolRecords(envelope), envelope);
});

test("legacy prose acceptance criteria become criterion objects", () => {
  const legacyRequirement = {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "requirement",
    id: "req_legacy",
    projectId: "prj_legion",
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: "Legacy requirement.",
    acceptance: { language: "Prose.", criteria: ["The old criterion."], oracleRefs: [] },
    traceRefs: [
      {
        path: ".legion/project/specs/req_legacy.md",
        anchor: "req_legacy",
        relation: "defines",
        entity: { kind: "requirement", id: "req_legacy" }
      }
    ],
    supersedes: []
  };

  const upcast = upcastProtocolRecords(legacyRequirement);

  assert.equal(upcast.acceptance.criteria[0].statement, "The old criterion.");
  assert.equal(upcast.acceptance.criteria[0].proof.mode, "manual");
});

test("current documents pass through untouched", () => {
  const current = { schemaVersion: "0.3.0", kind: "requirement", id: "req_x", nested: { a: 1 } };
  assert.deepEqual(upcastProtocolRecords(current), current);
});

test("a document written under the previous version is renumbered, not passed through", () => {
  // The positive claim the 0.3.0 bump makes, and the reason the fixture above
  // had to be retargeted rather than left alone: a 0.2.0 requirement is no
  // longer current, so "passes through untouched" and "is upcast" are now two
  // different documents. Asserting only the first would have retired the second
  // in silence.
  const previous = { schemaVersion: "0.2.0", kind: "requirement", id: "req_x", nested: { a: 1 } };
  assert.deepEqual(upcastProtocolRecords(previous), { ...previous, schemaVersion: "0.3.0" });
});

test("non-protocol values are returned as-is", () => {
  assert.equal(upcastProtocolRecords("text"), "text");
  assert.equal(upcastProtocolRecords(7), 7);
  assert.deepEqual(upcastProtocolRecords([1, 2]), [1, 2]);
  // An object with a version but no kind is not a protocol record.
  const versionless = { schemaVersion: "0.1.0", note: "not an entity" };
  assert.deepEqual(upcastProtocolRecords(versionless), versionless);
});

test("an unparseable schemaVersion is left for the schema to reject", () => {
  const broken = { schemaVersion: "not-a-version", kind: "requirement", id: "req_x" };
  assert.deepEqual(upcastProtocolRecords(broken), broken);
});
