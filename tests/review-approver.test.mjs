import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion review --accept --approver <id>`, end to end at R3.
 *
 * Two defects live here, and neither was reachable by any fixture in the tree
 * before this suite existed. Every `review --accept` anywhere else runs at R0
 * (tests/ship-traceability) or against the hardcoded R2 fallback
 * (tests/cli-workflow-ux, tests/review-observation-gate), so nothing derived
 * `explicit_human_approval` and nothing exercised the approver rule at all.
 *
 * The first defect is the gate itself: it was satisfied by any accepted review,
 * while every review Legion writes records a tool as its reviewer, so R3's
 * strictest gate passed on changes no human had ever seen.
 *
 * The second is subtler and is what most of these tests are about — the ways an
 * approver can be silently invented. A default when the project has one owner, a
 * value slugified into a plausible actor, an environment variable, a git config
 * name: each satisfies the gate without a human doing anything, which is the
 * same fail-open wearing a different hat. So the refusals are asserted by name,
 * and the refusal that matters most is asserted to have written nothing.
 */

const CREATED_AT = "2026-07-30T12:00:00.000Z";

function answers(riskTier) {
  return {
    "project-name": "Asset Mapper",
    "project-summary": "Deterministic asset resolution.",
    "project-owner": "dasbl",
    "problem-statement": "Renames silently break downstream builds.",
    "problem-users": "Pipeline engineers.",
    "problem-success": "A broken reference fails at build time, loudly.",
    "req-1-statement": "Resolution fails loudly when an asset is missing",
    "req-1-priority": "must",
    "req-1-category": "behavior",
    "req-1-ac-1-statement": "Resolving a missing asset exits non-zero",
    "req-1-ac-1-proof": "manual",
    "req-1-ac-1-detail": "The scratch project has no test runner, so this is decided by inspection.",
    "req-1-ac-1-more": "false",
    "req-1-more": "false",
    "non-goals": "Automatic renaming",
    constraints: "TypeScript only",
    "risk-tier": riskTier,
    "risk-reason": "An R3 fixture so the human-approval gate is actually derived.",
    "budget-files": "20",
    "budget-lines": "2000",
    "budget-new-files": "10",
    "pref-verification": "legion validate"
  };
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** A project driven to a clean submitted review, and not accepted. */
async function reviewedProject(t, riskTier = "R3") {
  const root = await mkdtemp(path.join(tmpdir(), "legion-approver-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers(riskTier)), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  assert.equal((await run("start", "--finalize", "--json", "--created-at", CREATED_AT)).exitCode, 0);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);
  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  return { root, run, changeId };
}

async function reviewStatuses(root, changeId) {
  const reviewsRoot = path.join(root, ".legion/project/changes", changeId, "reviews");
  const files = (await readdir(reviewsRoot)).filter((name) => name.endsWith(".json"));
  const statuses = [];
  for (const name of files) {
    statuses.push(JSON.parse(await readFile(path.join(reviewsRoot, name), "utf8")).status);
  }
  return statuses;
}

async function approvalDocuments(root, changeId) {
  const approvalsRoot = path.join(root, ".legion/project/changes", changeId, "approvals");
  const names = await readdir(approvalsRoot).catch(() => []);
  const documents = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    documents.push(JSON.parse(await readFile(path.join(approvalsRoot, name), "utf8")));
  }
  return documents;
}

test("an R3 accept with no approver is refused, and refused before anything is written", async (t) => {
  // The refusal has to come *before* the writes, not after. `acceptLatestReview`
  // writes an accepted revision of every covering review and then rewrites the
  // whole evidence index, and there is no way back:
  // `cleanSubmittedReviewCoverage` selects only reviews still in `submitted`, so
  // a retry with the right approver dies with `review_not_clean`, and no verb in
  // this release can attach an approval to an already-accepted change.
  //
  // A test asserting only the exit code and the diagnostic would pass equally
  // for a version that refused after mutating the tree, which is why the reviews
  // and the evidence index are read back. Delete the `--approver` requirement
  // and this test fails on the exit code; keep the requirement but move it after
  // the accept loop and it fails on the review statuses.
  const { root, run, changeId } = await reviewedProject(t);

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 1, accepted.stdout + accepted.stderr);
  const payload = parseJsonOutput(accepted);
  assert.equal(payload.status, "blocked");
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "approver_required"),
    `expected approver_required, got ${JSON.stringify(payload.diagnostics)}`
  );

  assert.deepEqual(await reviewStatuses(root, changeId), ["submitted"]);
  const index = JSON.parse(
    await readFile(path.join(root, ".legion/project/changes", changeId, "evidence-index.json"), "utf8")
  );
  assert.ok(
    index.entries.every((entry) => entry.acceptance.status !== "accepted"),
    "a refused accept must leave the evidence index unaccepted"
  );
  assert.deepEqual(await approvalDocuments(root, changeId), []);
});

test("an approver the project does not record is refused, and no actor is invented from the value", async (t) => {
  // `ownerActor()` in workflow/input.ts never fails: it slugifies any string and
  // falls back to `operator-<slug>`, always producing a kind:"human" actor.
  // Routing `--approver` through it would turn a typo into an approver invented
  // on the spot. The only authority is the manifest's decisionOwners, and a
  // value that matches nobody in it names nobody.
  const { root, run, changeId } = await reviewedProject(t);

  const accepted = await run("review", "--accept", "--approver", "somebody-who-is-not-an-owner", "--json");
  assert.equal(accepted.exitCode, 1, accepted.stdout + accepted.stderr);
  const payload = parseJsonOutput(accepted);
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "approver_unknown"),
    `expected approver_unknown, got ${JSON.stringify(payload.diagnostics)}`
  );
  // The recorded owners are named, because otherwise the operator's only
  // recourse is to open the manifest themselves.
  assert.ok(payload.diagnostics.some((entry) => /dasbl/.test(entry.message)));
  assert.deepEqual(await reviewStatuses(root, changeId), ["submitted"]);
});

test("a decision owner who is not a human cannot answer the human-approval gate", async (t) => {
  // `decisionOwners` is an array of Actors and `actorSchema.kind` admits tool,
  // worker, system and runtime, so a project may legitimately record an
  // automation actor as an owner. Membership is necessary and not sufficient: a
  // check that asked only "is this value in the list" would let a bot satisfy
  // the one gate whose entire question is humanity.
  const { root, run, changeId } = await reviewedProject(t);

  const manifestPath = path.join(root, ".legion/project/project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.project.policy.decisionOwners.push({ kind: "tool", id: "release-bot", displayName: "Release Bot" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");

  const accepted = await run("review", "--accept", "--approver", "release-bot", "--json");
  assert.equal(accepted.exitCode, 1, accepted.stdout + accepted.stderr);
  const payload = parseJsonOutput(accepted);
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "approver_not_human"),
    `expected approver_not_human, got ${JSON.stringify(payload.diagnostics)}`
  );
  assert.deepEqual(await reviewStatuses(root, changeId), ["submitted"]);
});

test("--auto is the same door and is guarded the same way", async (t) => {
  // `runAutoReview` reaches `acceptLatestReview` on a clean cycle with no
  // operator step at all. A requirement enforced only on the `--accept` branch
  // would leave the whole fail-open intact behind a different flag, and nothing
  // else in the tree runs `--auto` against an R3 change, so it would have
  // shipped green.
  const { root, run, changeId } = await reviewedProject(t);

  const auto = await run("review", "--auto", "--max-cycles", "1", "--executor", "fake", "--json");
  assert.equal(auto.exitCode, 1, auto.stdout + auto.stderr);
  assert.ok(
    parseJsonOutput(auto).diagnostics.some((entry) => entry.code === "approver_required"),
    `expected approver_required from --auto, got ${auto.stdout}`
  );
  assert.ok(
    (await reviewStatuses(root, changeId)).every((status) => status !== "accepted"),
    "--auto must not accept a review it could not approve"
  );
});

test("a named human approver records the accept transition and a granted approval", async (t) => {
  // The whole path, and the shape of what it writes. `reviewer` stays the tool
  // that produced the review — that is a true statement and overwriting it would
  // trade one truth for another — while `acceptedBy` carries the actor who
  // performed the accept, taken verbatim from the manifest rather than rebuilt
  // from the string typed on the command line.
  const { root, run, changeId } = await reviewedProject(t);
  const { approvalSchema, reviewDecisionSchema } = await import("../packages/protocol/dist/index.js");

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);

  const reviewsRoot = path.join(root, ".legion/project/changes", changeId, "reviews");
  const reviewFile = (await readdir(reviewsRoot)).find((name) => name.endsWith(".json"));
  const review = JSON.parse(await readFile(path.join(reviewsRoot, reviewFile), "utf8"));
  const parsedReview = reviewDecisionSchema.safeParse(review);
  assert.equal(parsedReview.success, true, JSON.stringify(parsedReview.error?.issues));
  assert.equal(review.status, "accepted");
  assert.deepEqual(review.reviewer.kind, "tool");
  assert.equal(review.acceptedBy.kind, "human");
  assert.equal(review.acceptedBy.id, "dasbl");
  assert.equal(typeof review.acceptedAt, "string");

  const approvals = await approvalDocuments(root, changeId);
  assert.equal(approvals.length, 1);
  const parsedApproval = approvalSchema.safeParse(approvals[0]);
  assert.equal(parsedApproval.success, true, JSON.stringify(parsedApproval.error?.issues));
  assert.equal(approvals[0].status, "granted");
  assert.equal(approvals[0].scope.action, "workflow.review.accept");
  assert.equal(approvals[0].decidedBy.id, "dasbl");
  // The request and the decision are different acts by different actors, even
  // when one command performs both.
  assert.equal(approvals[0].requestedBy.kind, "tool");
  assert.ok(approvals[0].scope.targets.some((target) => target.kind === "task"));

  const shipped = await run("ship", "--json");
  const diagnostics = parseJsonOutput(shipped).diagnostics ?? [];
  assert.ok(
    !diagnostics.some((entry) => /Explicit Human Approval/i.test(entry.message)),
    `explicit_human_approval should be satisfied, got ${JSON.stringify(diagnostics)}`
  );
});

test("re-accepting rewrites the same approval instead of leaving a second one behind", async (t) => {
  // The supersession model, observed from outside. The approval id is derived
  // from what is approved — this change, this action, this task — so a second
  // accept is a new revision of one document. Derived from the review instead,
  // every review cycle would mint a new file and the grant from the first cycle
  // would survive on disk with nothing to revoke it, which is the fail-open this
  // artifact exists to close, reintroduced by the storage model.
  const { root, run, changeId } = await reviewedProject(t);

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  const first = await approvalDocuments(root, changeId);
  assert.equal(first.length, 1);

  const rebuilt = await run("build", "--executor", "fake", "--allow-dirty", "--json");
  assert.equal(rebuilt.exitCode, 0, rebuilt.stdout + rebuilt.stderr);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const second = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(second.exitCode, 0, second.stdout + second.stderr);

  const after = await approvalDocuments(root, changeId);
  assert.equal(after.length, 1, "a second accept of the same task must not mint a second approval");
  assert.equal(after[0].id, first[0].id);
  assert.equal(after[0].metadata.attributes.artifact_revision, 2);
  // The request instant survives; the decision instant moves. That is what lets
  // a later ordering gate ask when the decision was actually made.
  assert.equal(after[0].requestedAt, first[0].requestedAt);
  assert.notEqual(after[0].decidedAt, first[0].decidedAt);
});

/** Every ship diagnostic about the human-approval gate, or `[]`. */
async function humanApprovalDiagnostics(run) {
  const shipped = await run("ship", "--json");
  const diagnostics = parseJsonOutput(shipped).diagnostics ?? [];
  return diagnostics.filter((entry) => /Explicit Human Approval/i.test(entry.message));
}

test("re-reviewing a task strands the approval, and the gate is what notices", async (t) => {
  // A granted approval used to outlive the acceptance it approved with nothing
  // in the tree able to detect it. Nothing revokes the approval when the work is
  // reviewed again: `rejectLatestReview` does not, `legion review` does not, and
  // the approval's `artifacts` pin array is deliberately left unwritten because
  // the review file it would pin is legitimately rewritten by a later reject.
  // So `explicit_human_approval: satisfied` was a claim about an act with no
  // link to the bytes the act was about, and the two independent-review gates
  // masked it by going unsatisfied beside it in the one sequence anybody tried.
  //
  // This is the reachable form of that sequence. Rejecting straight after an
  // accept is refused — `latestSubmittedReviews` finds nothing in `submitted` —
  // so the way an accepted change moves on is a second review, which supersedes
  // the first while leaving it accepted on disk. Both independent-review gates
  // stay satisfied through this, which is precisely why the approval gate has to
  // answer for itself.
  const { root, run, changeId } = await reviewedProject(t);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.deepEqual(await humanApprovalDiagnostics(run), []);

  const resubmitted = await run("review", "--executor", "fake", "--json");
  assert.equal(resubmitted.exitCode, 0, resubmitted.stdout + resubmitted.stderr);

  const stale = await humanApprovalDiagnostics(run);
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0].message, /has since superseded/);
  // The approval on disk is untouched, which is the point: no writer noticed, and
  // the verdict moved anyway. A fix that depended on some later verb revoking the
  // grant would leave every path that forgets to call it fully approved.
  const approvals = await approvalDocuments(root, changeId);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "granted");
});

test("editing the accepted review after approval strands the grant", async (t) => {
  // The same staleness with the review's identity and status intact — a hand
  // edit, a host, a verb that rewrites in place. The id link alone still reports
  // satisfied here; what falsifies it is the content hash the approval carries
  // in its idempotency key, compared against the hash of the review as it is
  // now. This test is also the only thing that proves those two hashes are
  // comparable at all: one is computed by the artifact writer over the bytes it
  // wrote, the other by the reader over the bytes on disk, and if they ever
  // stopped agreeing the gate would report every honest approval as tampering.
  const { root, run, changeId } = await reviewedProject(t);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.deepEqual(await humanApprovalDiagnostics(run), []);

  const reviewsRoot = path.join(root, ".legion/project/changes", changeId, "reviews");
  const reviewFile = (await readdir(reviewsRoot)).find((name) => name.endsWith(".json"));
  const review = JSON.parse(await readFile(path.join(reviewsRoot, reviewFile), "utf8"));
  // Still schema-valid, still `accepted`, still the same id: only the bytes move.
  const edited = {
    ...review,
    metadata: {
      ...(review.metadata ?? {}),
      annotations: { ...(review.metadata?.annotations ?? {}), edited_after_approval: "yes" }
    }
  };
  await writeFile(path.join(reviewsRoot, reviewFile), `${JSON.stringify(edited)}\n`, "utf8");

  const stale = await humanApprovalDiagnostics(run);
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0].message, /rewritten since/);
});

test("--approver on a dry run is resolved, not ignored", async (t) => {
  // A dry run exists to answer "will this command line work". One that resolved
  // nothing answered yes to `--approver dasbi`, and the typo surfaced on the
  // accept — after a build and a review had already run. The rule the accept
  // path applies is that an approver on a run that accepts nothing is refused
  // rather than ignored; the dry run was the one place it was not applied.
  const { run } = await reviewedProject(t);

  const probed = await run("review", "--dry-run", "--accept", "--approver", "dasbi", "--json");
  assert.equal(probed.exitCode, 1, probed.stdout);
  const payload = parseJsonOutput(probed);
  assert.equal(payload.status, "blocked");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "approver_unknown"), JSON.stringify(payload.diagnostics));

  // The dry run still runs, and still writes nothing, for a value that resolves.
  const clean = await run("review", "--dry-run", "--accept", "--approver", "dasbl", "--json");
  assert.equal(clean.exitCode, 0, clean.stdout + clean.stderr);
  assert.equal(parseJsonOutput(clean).dryRun, true);
});

test("--approver with no value is a usage error, not a policy refusal", async (t) => {
  // Automation has to be able to tell malformed input from a project rule. The
  // same distinction `--phase` already makes, for the same reason.
  const { run } = await reviewedProject(t);
  const accepted = await run("review", "--accept", "--approver", "--json");
  assert.equal(accepted.exitCode, 1);
  assert.equal(parseJsonOutput(accepted).status, "usage_error");
});

test("--approver on a run that accepts nothing is refused rather than ignored", async (t) => {
  // The declared-options doctrine applied one level in: an option the taken
  // branch never reads returns a confident answer to a question the caller did
  // not ask. Here it would be worse than useless — the caller believes an
  // approver was recorded, and none was.
  const { run } = await reviewedProject(t);
  const submitted = await run("review", "--executor", "fake", "--approver", "dasbl", "--json");
  assert.equal(submitted.exitCode, 1);
  assert.equal(parseJsonOutput(submitted).status, "usage_error");
});

test("an R0 change still accepts with no approver, and records no approval", async (t) => {
  // The requirement is derived from the gate set with the identical
  // `deriveGateSet` call `ship-gates.ts` makes, not from `tier === "R3"`, so a
  // tier that does not derive `explicit_human_approval` is untouched. R0, R1 and
  // R2 accepts are the overwhelming majority of what this workflow does, and a
  // requirement that leaked down to them would break every existing flow.
  const { root, run, changeId } = await reviewedProject(t, "R0");

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  assert.deepEqual(await reviewStatuses(root, changeId), ["accepted"]);
  // No approver was named, so nothing claims one was. An approval written with a
  // defaulted identity would be worse than no approval at all.
  assert.deepEqual(await approvalDocuments(root, changeId), []);
  const review = JSON.parse(
    await readFile(
      path.join(
        root,
        ".legion/project/changes",
        changeId,
        "reviews",
        (await readdir(path.join(root, ".legion/project/changes", changeId, "reviews"))).find((name) => name.endsWith(".json"))
      ),
      "utf8"
    )
  );
  assert.equal(review.acceptedBy, undefined);
  assert.equal(review.acceptedAt, undefined);
});
