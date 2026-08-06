import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * The approval artifact service.
 *
 * `approvalSchema` has been complete in `@legion/protocol` since the protocol
 * was written, and had no path role, no service and no writer — so every gate
 * that needed to ask "was this approved" had nothing to read, and
 * `explicit_human_approval` answered from the existence of an accepted review
 * instead. This suite covers the storage half of closing that: the path, the
 * revisioned write, the in-place transition from granted to revoked, and the
 * listing's report of what it could not read.
 */

const CREATED_AT = "2026-08-01T12:00:00.000Z";

async function tempRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-approvals-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function protocol() {
  return import("../packages/protocol/dist/index.js");
}

async function artifacts() {
  return import("../packages/artifacts/dist/index.js");
}

function grantedApproval(ids, overrides = {}) {
  return {
    schemaVersion: ids.schemaVersion,
    createdAt: CREATED_AT,
    kind: "approval",
    id: ids.approvalId,
    projectId: ids.projectId,
    changeId: ids.changeId,
    taskId: ids.taskId,
    runId: ids.runId,
    requestedBy: { kind: "tool", id: "legion-review", displayName: "Legion Review Gate" },
    requestedAt: CREATED_AT,
    scope: {
      effectClass: "S1",
      action: "workflow.review.accept",
      targets: [
        { kind: "task", id: ids.taskId },
        { kind: "change", id: ids.changeId }
      ]
    },
    idempotencyKey: ids.idempotencyKey,
    status: "granted",
    decidedBy: { kind: "human", id: "dasbl" },
    decidedAt: CREATED_AT,
    decisionReason: "dasbl accepted this task's review.",
    ...overrides
  };
}

async function fixtureIds() {
  const { LEGION_PROTOCOL_VERSION, buildIdempotencyKey, formatEntityId } = await protocol();
  const { hashContent } = await artifacts();
  const projectId = formatEntityId("project", "approvals-test");
  const changeId = formatEntityId("change", "approvals-test-change");
  const taskId = formatEntityId("task", "approvals-test-task");
  const runId = formatEntityId("run", "approvals-test-task-attempt-1");
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    projectId,
    changeId,
    taskId,
    runId,
    approvalId: formatEntityId("approval", "approvals-test-change-approval-1"),
    idempotencyKey: buildIdempotencyKey({
      projectId,
      changeId,
      taskId,
      runId,
      effectKind: "workflow.review.accept",
      targetHash: hashContent("accepted review bytes")
    })
  };
}

test("an approval is addressed by change and id, under the change's approvals directory", async () => {
  // The path role is what makes an approval a first-class artifact rather than a
  // blob some command decided where to put. `artifactPathForRole` is an
  // exhaustive switch with no default arm, so adding "approval" to the role enum
  // without adding this case does not compile — which is the only reason the
  // role and the path cannot drift apart.
  const { artifactPathForRole } = await artifacts();
  const ids = await fixtureIds();

  assert.equal(
    artifactPathForRole({ role: "approval", changeId: ids.changeId, approvalId: ids.approvalId }),
    ".legion/project/changes/chg_approvals-test-change/approvals/apv_approvals-test-change-approval-1.json"
  );
});

test("an approval id is a function of what is approved, and cannot overflow the id length", async (t) => {
  // Two claims, both load-bearing.
  //
  // The id depends on the change, the action and the subject and on nothing
  // else, which is what makes re-deciding a new revision of one document rather
  // than a second document. Add a sequence number, a timestamp or the review id
  // and the second decision lands somewhere new, leaving the first grant on disk
  // with nothing to supersede it.
  //
  // And the tail is a digest rather than the readable subject because
  // `derivedSuffix` shortens only the base: a readable tail like
  // `-workflow-review-accept-tsk-<long task name>` pushes the reserved length
  // past the 64-character entity suffix limit and throws a RangeError at the
  // moment of writing. This asserts against a change id long enough to force the
  // shortening branch, which is where that would surface.
  const { approvalIdForSubject } = await import("../packages/cli/dist/workflow/run-artifacts.js");
  const { approvalIdSchema, formatEntityId } = await protocol();

  // 61 characters, so the derived suffix would be 83 and the shortening branch
  // in `derivedSuffix` has to run.
  const changeId = formatEntityId("change", `phase-1-${"long-slug-".repeat(5)}end`);
  const first = approvalIdForSubject({
    changeId,
    action: "workflow.review.accept",
    subject: { kind: "task", id: "tsk_a-genuinely-long-task-slug-of-the-kind-planning-produces" }
  });
  const again = approvalIdForSubject({
    changeId,
    action: "workflow.review.accept",
    subject: { kind: "task", id: "tsk_a-genuinely-long-task-slug-of-the-kind-planning-produces" }
  });
  assert.equal(first, again);
  assert.equal(approvalIdSchema.safeParse(first).success, true, first);

  for (const different of [
    { action: "spec.delta.approve", subject: { kind: "task", id: "tsk_a-genuinely-long-task-slug-of-the-kind-planning-produces" } },
    { action: "workflow.review.accept", subject: { kind: "task", id: "tsk_some-other-task" } },
    { action: "workflow.review.accept", subject: { kind: "change", id: changeId } }
  ]) {
    assert.notEqual(approvalIdForSubject({ changeId, ...different }), first, JSON.stringify(different));
  }
});

test("a granted approval round trips, and revoking it rewrites the same document", async (t) => {
  // The supersession model, which is the whole reason this service exists in the
  // shape it does. An approval's lifecycle lives at one path under one id as
  // successive revisions; a revocation is the *same bytes* at the next revision,
  // not a second document pointing back at the first.
  //
  // Written the other way, a revocation is a file that can be lost, renamed or
  // corrupted independently of the grant it revokes — and losing it promotes a
  // withdrawn approval back to live, which is precisely the failure the approval
  // artifact was introduced to prevent. Here, losing the revocation means losing
  // the grant too, and a change with no approval is unevaluable rather than
  // approved.
  const { readApproval, writeApproval, stableProtocolJson } = await artifacts();
  const { approvalSchema } = await protocol();
  const root = await tempRepo(t);
  const ids = await fixtureIds();

  // Round-tripped through the real schema inside the test: a fixture the schema
  // would reject exercises nothing, and this one has three ways to be wrong
  // (a missing decisionReason, a decidedAt before requestedAt, a malformed
  // idempotency key) that all present as a passing test if left unchecked.
  const granted = grantedApproval(ids);
  assert.equal(approvalSchema.safeParse(granted).success, true, JSON.stringify(approvalSchema.safeParse(granted).error));

  const created = await writeApproval({ repositoryRoot: root, document: granted });
  assert.equal(created.ok, true, stableProtocolJson(created));
  assert.equal(created.status, "created");
  assert.equal(created.revision.revision, 1);

  const revoked = await writeApproval({
    repositoryRoot: root,
    expectedRevision: 1,
    document: {
      ...granted,
      status: "revoked",
      updatedAt: "2026-08-01T13:00:00.000Z",
      decidedAt: "2026-08-01T13:00:00.000Z",
      decisionReason: "Withdrawn after the change was rebuilt."
    }
  });
  assert.equal(revoked.ok, true, stableProtocolJson(revoked));
  assert.equal(revoked.status, "updated");
  assert.equal(revoked.revision.revision, 2);

  const loaded = await readApproval({ repositoryRoot: root, changeId: ids.changeId, approvalId: ids.approvalId });
  assert.equal(loaded.ok, true, stableProtocolJson(loaded));
  assert.equal(loaded.document.status, "revoked");
  assert.equal(loaded.revision.revision, 2);
  // The request instant survives the transition, which is what keeps the
  // listing's sort order stable across a re-decision.
  assert.equal(loaded.document.createdAt, CREATED_AT);
});

test("a stale expected revision is refused rather than overwriting the current decision", async (t) => {
  // Two operators deciding at once, or one retrying against a document that
  // moved. Without the compare-and-swap the later write wins silently, and the
  // decision that lost is a revocation as often as it is a grant.
  const { writeApproval, stableProtocolJson } = await artifacts();
  const root = await tempRepo(t);
  const ids = await fixtureIds();
  const granted = grantedApproval(ids);

  assert.equal((await writeApproval({ repositoryRoot: root, document: granted })).ok, true);
  const stale = await writeApproval({
    repositoryRoot: root,
    expectedRevision: 7,
    document: { ...granted, decisionReason: "A decision made against bytes that are not there." }
  });
  assert.equal(stale.ok, false, stableProtocolJson(stale));
  assert.equal(stale.status, "conflict");
  assert.ok(stale.diagnostics.some((diagnostic) => diagnostic.code === "revision_conflict"));
});

test("the listing reports every entry it could not read instead of dropping it in silence", async (t) => {
  // The review listing quietly `continue`s past anything it cannot parse and
  // still reports ok: true. Copied here, that silence is sharper than a
  // miscount: an approval file carries the current state of one decision, so a
  // dropped file is a dropped *revocation* as readily as a dropped grant, and a
  // caller answering from what it kept would report a withdrawn approval as
  // live. `skipped` is how the caller learns it must not answer at all.
  const { listApprovalsForChange, writeApproval, stableProtocolJson } = await artifacts();
  const { formatEntityId } = await protocol();
  const root = await tempRepo(t);
  const ids = await fixtureIds();

  assert.equal((await writeApproval({ repositoryRoot: root, document: grantedApproval(ids) })).ok, true);

  const approvalsRoot = path.join(root, ".legion", "project", "changes", ids.changeId, "approvals");
  const corruptId = formatEntityId("approval", "approvals-test-change-approval-2");
  await writeFile(path.join(approvalsRoot, `${corruptId}.json`), "{ invalid json", "utf8");
  await writeFile(path.join(approvalsRoot, "not-an-approval.json"), "{}", "utf8");
  await mkdir(path.join(approvalsRoot, "leftovers"), { recursive: true });

  const listed = await listApprovalsForChange({ repositoryRoot: root, changeId: ids.changeId });
  assert.equal(listed.ok, true, stableProtocolJson(listed));
  assert.equal(listed.approvals.length, 1);
  assert.equal(listed.approvals[0].document.id, ids.approvalId);
  assert.deepEqual(listed.skipped, [`${corruptId}.json`, "leftovers", "not-an-approval.json"].sort());
});

test("a change with no approvals directory lists empty rather than failing", async (t) => {
  // Absence of the directory is absence of approvals, which is what every
  // change accepted by an earlier Legion looks like. Reporting it as a failure
  // would make `legion ship` blame the reader for the state of the tree; the
  // distinction that matters — read and empty, versus could not read — is
  // carried by `ok` and `skipped`, not by whether the directory exists.
  const { listApprovalsForChange } = await artifacts();
  const root = await tempRepo(t);
  const ids = await fixtureIds();

  const listed = await listApprovalsForChange({ repositoryRoot: root, changeId: ids.changeId });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.approvals, []);
  assert.deepEqual(listed.skipped, []);
});

test("an approval filed under another change is refused rather than trusted", async (t) => {
  // The document names its own change and id, and so does the path. A file
  // moved, copied or renamed on disk would otherwise let an approval granted for
  // one change answer a gate about another.
  const { readApproval, writeApproval } = await artifacts();
  const { formatEntityId } = await protocol();
  const root = await tempRepo(t);
  const ids = await fixtureIds();

  assert.equal((await writeApproval({ repositoryRoot: root, document: grantedApproval(ids) })).ok, true);

  const otherChangeId = formatEntityId("change", "approvals-test-other-change");
  const otherRoot = path.join(root, ".legion", "project", "changes", otherChangeId, "approvals");
  await mkdir(otherRoot, { recursive: true });
  const original = path.join(root, ".legion", "project", "changes", ids.changeId, "approvals", `${ids.approvalId}.json`);
  const { readFile } = await import("node:fs/promises");
  await writeFile(path.join(otherRoot, `${ids.approvalId}.json`), await readFile(original, "utf8"), "utf8");

  const misfiled = await readApproval({ repositoryRoot: root, changeId: otherChangeId, approvalId: ids.approvalId });
  assert.equal(misfiled.ok, false);
  assert.ok(misfiled.diagnostics.some((diagnostic) => diagnostic.code === "approval_change_mismatch"));
});
