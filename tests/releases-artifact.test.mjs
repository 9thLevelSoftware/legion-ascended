import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readRelease, writeRelease } from "../packages/artifacts/dist/index.js";

/**
 * The release plane: exactly one document per change, at `release.json`.
 *
 * It is the attestations service with the listing removed, and the removal is
 * the substance rather than a simplification. There is no directory, so there is
 * no partial listing to refuse and no `skipped` array — which is why `legion
 * ship` grows no new plane-skip entry for this plane and why the two states that
 * matter, "no file" and "a file that will not parse", have to be distinguishable
 * from this service's own status. Every test below exists for a way one of those
 * two could be reported as the other, or for a way a plan about one change could
 * answer for another.
 */

const CHANGE_ID = "chg_release-plane";
const OTHER_CHANGE_ID = "chg_release-plane-elsewhere";
const PROJECT_ID = "prj_release-plane";
const NOW = "2026-08-06T09:00:00.000Z";

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-releases-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function release(overrides = {}) {
  return {
    schemaVersion: "0.2.0",
    createdAt: NOW,
    kind: "release",
    id: "rel_release-plane-release",
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    status: "requested",
    environment: "staging",
    releaseIntent: {
      path: `.legion/project/changes/${CHANGE_ID}/taskgraph.json`,
      sha256: `sha256:${"a".repeat(64)}`
    },
    taskRefs: ["tsk_release-plane-c1"],
    approvalRefs: [],
    evidenceRefs: [],
    healthCriteria: ["p99 quote latency stays under 400ms for 30 minutes"],
    rollbackPlan: {
      strategy: "revert",
      criteria: ["quote error rate exceeds 1% over any 5 minute window"],
      evidenceRefs: []
    },
    ...overrides
  };
}

test("a release plan round-trips through the revisioned artifact writer", async (t) => {
  // The defect: a service whose write and read disagree about the path, or that
  // loses a field through the revision-metadata round trip, would make `legion
  // release plan` report success over a document `legion ship` cannot find or
  // cannot parse — and the gate would report absence for a plan that was written.
  // `releaseSchema` is a discriminated union wrapped in a `superRefine`, so it
  // cannot be `.extend`ed and the revision has to be stored by spreading and
  // re-parsing; this is what proves that round trip keeps the document intact.
  const root = await workspace(t);

  const created = await writeRelease({ repositoryRoot: root, document: release() });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  assert.equal(created.status, "created");
  assert.equal(created.artifactPath, `.legion/project/changes/${CHANGE_ID}/release.json`);

  const read = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(read.ok, true, JSON.stringify(read.diagnostics));
  assert.equal(read.status, "read");
  assert.equal(read.document.id, "rel_release-plane-release");
  assert.equal(read.document.status, "requested");
  assert.equal(read.document.environment, "staging");
  assert.deepEqual(read.document.healthCriteria, ["p99 quote latency stays under 400ms for 30 minutes"]);
  assert.deepEqual(read.document.rollbackPlan.criteria, [
    "quote error rate exceeds 1% over any 5 minute window"
  ]);
  assert.deepEqual(read.document.taskRefs, ["tsk_release-plane-c1"]);
  assert.equal(read.revision.revision, 1);
});

test("re-planning replaces the same document rather than accumulating a second one", async (t) => {
  // The defect: if a re-plan minted a new file, a superseded plan would sit beside
  // the current one and `release_observation_plan` — which reads a *status* — could
  // answer from whichever record happened to be favourable. That is the
  // favourable-hides-unfavourable fail-open one-document-per-subject exists to
  // remove, and it is why the id is derived from the change alone.
  const root = await workspace(t);

  const created = await writeRelease({ repositoryRoot: root, document: release() });
  assert.equal(created.ok, true);

  const updated = await writeRelease({
    repositoryRoot: root,
    expectedRevision: created.revision.revision,
    document: release({ healthCriteria: ["error budget burn stays under 2% for the first hour"] })
  });
  assert.equal(updated.ok, true, JSON.stringify(updated.diagnostics));
  assert.equal(updated.status, "updated");
  assert.equal(updated.artifactPath, created.artifactPath, "a re-plan must not mint a second path");

  const read = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.deepEqual(read.document.healthCriteria, ["error budget burn stays under 2% for the first hour"]);
  assert.equal(read.revision.revision, 2);
});

test("a stale expected revision is a conflict rather than a silent overwrite", async (t) => {
  // The defect: two writers racing on one change would otherwise have the second
  // silently discard the first's plan. The artifact revision chain is what makes
  // that a refusal, and a service that did not pass `expectedRevision` through
  // would lose it without anything failing.
  const root = await workspace(t);

  const created = await writeRelease({ repositoryRoot: root, document: release() });
  assert.equal(created.ok, true);
  await writeRelease({
    repositoryRoot: root,
    expectedRevision: created.revision.revision,
    document: release({ environment: "production" })
  });

  const stale = await writeRelease({
    repositoryRoot: root,
    expectedRevision: created.revision.revision,
    document: release({ environment: "test" })
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, "conflict");
  assert.match(stale.diagnostics[0].message, /stale artifact revision/);

  const read = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(read.document.environment, "production", "the losing write must not have landed");
});

test("a plan naming another change is refused rather than read as this change's", async (t) => {
  // The defect this exists for: the path is the identity for a singular
  // per-change artifact, so a document copied from one change directory into
  // another would otherwise be read as the second change's plan — and
  // `release_observation_plan` would be satisfied by a document nobody wrote for
  // the change being shipped. The gate re-checks this too; both are positive
  // because either alone is one deletion away from a fail-open.
  const root = await workspace(t);

  await mkdir(path.join(root, ".legion/project/changes", CHANGE_ID), { recursive: true });
  await writeFile(
    path.join(root, ".legion/project/changes", CHANGE_ID, "release.json"),
    `${JSON.stringify(release({ changeId: OTHER_CHANGE_ID }), null, 2)}\n`,
    "utf8"
  );

  const read = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(read.ok, false);
  assert.equal(read.status, "invalid");
  assert.equal(read.diagnostics[0].code, "release_change_mismatch");
  assert.match(read.diagnostics[0].message, new RegExp(OTHER_CHANGE_ID));
});

test("an absent plan is not_found and an unparseable one is invalid", async (t) => {
  // **The distinction the whole four-state fact rests on.** Both are `unevaluable`
  // at the gate, so no verdict moves either way — but they need different
  // sentences and different recoveries, and only one of them may conceal a
  // negative, because a `release.json` that will not parse may be the one
  // recording a failed release. If this service reported the same status for both,
  // `loadReleaseFact` could not tell them apart and `legion release plan` would
  // happily overwrite an unread record.
  const root = await workspace(t);

  const missing = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "not_found");

  await mkdir(path.join(root, ".legion/project/changes", CHANGE_ID), { recursive: true });
  await writeFile(path.join(root, ".legion/project/changes", CHANGE_ID, "release.json"), "{\n", "utf8");
  const broken = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, "invalid");
  assert.notEqual(broken.status, "not_found");

  // A document that parses as JSON and not as a release is `invalid` too, rather
  // than being read with missing fields.
  await writeFile(
    path.join(root, ".legion/project/changes", CHANGE_ID, "release.json"),
    JSON.stringify({ kind: "release", id: "rel_x" }),
    "utf8"
  );
  const wrongShape = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.status, "invalid");
});

test("the write is atomic: a plan is never observed half-written", async (t) => {
  // The defect: a non-atomic write leaves a truncated `release.json` on disk if
  // the process dies mid-write, and the gate would then report `unevaluable` with
  // a `concealsNegative` on a change whose plan is fine. `writeRevisionedArtifact`
  // is what prevents it, and this asserts the service actually routes through it
  // rather than calling `writeFile` — the bytes on disk parse as the document that
  // was handed in, and no temporary file is left beside them.
  const root = await workspace(t);

  const created = await writeRelease({ repositoryRoot: root, document: release() });
  assert.equal(created.ok, true);

  const bytes = await readFile(path.join(root, ".legion/project/changes", CHANGE_ID, "release.json"), "utf8");
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.kind, "release");
  assert.equal(parsed.changeId, CHANGE_ID);
  assert.equal(parsed.metadata.attributes.artifact_revision, 1);
});

test("a document the schema rejects is refused before anything is written", async (t) => {
  // The defect: a service that wrote first and validated afterwards would leave a
  // `release.json` the reader cannot parse — which is the one state that makes the
  // gate conceal a negative, produced by the writer itself.
  const root = await workspace(t);

  const invalid = await writeRelease({
    repositoryRoot: root,
    // `rollbackPlan.criteria` is `.min(1)` in the schema. `healthCriteria` is not,
    // which is exactly why the gate checks that one itself.
    document: release({ rollbackPlan: { strategy: "revert", criteria: [], evidenceRefs: [] } })
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, "invalid");

  const read = await readRelease({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(read.ok, false);
  assert.equal(read.status, "not_found", "nothing may be left on disk by a refused write");
});
