import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion approve spec`, the writer behind `approved_delta_spec`.
 *
 * The gate reads an approval that pins the delta spec's bytes; this is the only
 * thing that writes one. Two claims can be checked here and nowhere else, and
 * both would be invisible to the gate's own unit suite:
 *
 *  - **The writer's hash and the reader's hash are comparable.** The approval
 *    pins the reference the change bundle minted over the bytes the artifact
 *    writer wrote; `legion ship` re-hashes the file on disk and compares. Those
 *    are two different code paths over two different byte sources, and if they
 *    ever disagreed the gate would report every honest approval as tampering.
 *    A unit test with a stubbed verifier cannot see that.
 *  - **The approval reaches the gate at all.** The document has to parse under
 *    `approvalSchema`, land at the path `listApprovalsForChange` reads, and pin
 *    a path `ship.ts` pre-resolved. Any one of those wrong and the gate stays
 *    `unevaluable` forever while looking implemented.
 *
 * The fixture mirrors tests/cli-workflow-ux: a temp directory that is not a git
 * repository, so `legion build` is not stopped by a dirty worktree, and a
 * project whose single recorded decision owner is `dasbl`.
 */

async function tempRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-approve-spec-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function planPhaseOne(t) {
  const root = await tempRepo(t);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "resolve-asset.ts"), "export function resolveAsset() {\n  return 1;\n}\n");
  await writeFile(
    path.join(root, "ROADMAP.md"),
    [
      "# Roadmap\n",
      "\n",
      "## Phase 1: Editor MVP\n",
      "Build the editor surface.\n",
      "\n",
      "### Acceptance\n",
      "- Asset metadata can be edited.\n",
      "\n",
      "## Phase 2: Package\n",
      "Ship the app.\n"
    ].join(""),
    "utf8"
  );

  const start = await runCliCapture([
    "--repository-root", root,
    "start",
    "--name", "Asset Mapper",
    "--summary", "Metadata authoring and deterministic asset resolution",
    "--owner", "dasbl",
    "--created-at", "2026-06-22T12:00:00.000Z",
    "--json"
  ]);
  assert.equal(start.exitCode, 0, start.stderr);

  const plan = await runCliCapture([
    "--repository-root", root, "plan", "1", "--from-roadmap", "ROADMAP.md", "--json"
  ]);
  assert.equal(plan.exitCode, 0, plan.stderr);
  return root;
}

async function acceptedThrough(root) {
  for (const args of [
    ["build", "--executor", "fake"],
    ["review", "--executor", "fake"],
    ["review", "--accept"]
  ]) {
    const result = await runCliCapture(["--repository-root", root, ...args, "--json"]);
    assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  }
}

async function pathMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  return false;
}

test("legion approve spec writes a granted approval pinning the delta spec bytes", async (t) => {
  const root = await planPhaseOne(t);

  const approved = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(approved.exitCode, 0, approved.stderr);
  const payload = parseJsonOutput(approved);
  assert.equal(payload.status, "approved");
  assert.equal(payload.approvals.length, 1);
  assert.deepEqual(payload.unapproved, []);

  const [entry] = payload.approvals;
  assert.equal(entry.action, "grant");
  assert.equal(entry.status, "granted");
  assert.deepEqual(entry.decidedBy, { kind: "human", id: "dasbl", displayName: "dasbl" });

  const document = JSON.parse(await readFile(path.join(root, ...entry.artifactPath.split("/")), "utf8"));
  assert.equal(document.kind, "approval");
  assert.equal(document.scope.action, "spec.delta.approve");
  assert.deepEqual(
    document.scope.targets.map((target) => target.kind),
    ["requirement", "change"]
  );
  // No task and no run. This approval is taken between `legion plan` and
  // `legion build`, so there is no run to name and naming a task would assert a
  // pairing the decision does not make. The idempotency key carries the
  // change-scoped form for the same reason — the shape the protocol gained in
  // this release rather than a fabricated `run_` segment.
  assert.equal(document.taskId, undefined);
  assert.equal(document.runId, undefined);
  assert.match(document.idempotencyKey, /^prj_[^:]+:chg_[^:]+:spec\.delta\.approve:sha256:[0-9a-f]{64}$/);

  // The pin is the delta spec, and it is the hash of the bytes actually on disk.
  const pin = document.artifacts[0];
  assert.equal(pin.path, entry.deltaSpecPath);
  const { hashContent } = await import("../packages/artifacts/dist/index.js");
  assert.equal(pin.sha256, hashContent(await readFile(path.join(root, ...pin.path.split("/")))));
});

test("an approved delta spec clears the approved_delta_spec gate on a real ship", async (t) => {
  // The end-to-end claim, and the only thing that proves the writer's hash and
  // the reader's hash are comparable at all: one is minted by the artifact
  // writer over the bytes it wrote, the other computed by `resolvePinnedReferences`
  // over the bytes on disk. If they ever stopped agreeing, the gate would report
  // every honest approval as tampering — and every unit test in
  // tests/ship-delta-spec-approval would still pass, because they stub the
  // verifier.
  const root = await planPhaseOne(t);
  await acceptedThrough(root);

  const before = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.equal(before.exitCode, 1);
  const blocked = parseJsonOutput(before);
  assert.equal(
    blocked.diagnostics.filter((entry) => entry.gate === "approved_delta_spec").length,
    1,
    "the gate should block before anything is approved"
  );

  const approved = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(approved.exitCode, 0, approved.stderr);

  const after = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  // Still blocked — three R2 gates have no producer yet — but not on this one.
  assert.equal(after.exitCode, 1);
  const stillBlocked = parseJsonOutput(after);
  assert.deepEqual(
    stillBlocked.diagnostics.filter((entry) => entry.gate === "approved_delta_spec"),
    [],
    "an approved, pin-clean delta spec should satisfy its gate"
  );
  assert.ok(stillBlocked.diagnostics.length > 0, "the remaining producerless gates must still block");
  // And the advice loses the approve step once it has been taken, rather than
  // repeating a recovery the operator already ran.
  assert.doesNotMatch(stillBlocked.nextAction.reason, /legion approve spec/);
});

test("re-running approve reports unchanged and does not move the decision instant", async (t) => {
  // Re-approving in place is the storage model: one document per (change,
  // action, requirement), re-decided as the next revision. But a rerun that
  // rewrote a live grant would mint a new revision and move `decidedAt` forward
  // for a decision nobody re-made — and `decidedAt` is what the ordering gate
  // added later compares against a run's start, so a harmless rerun would turn a
  // valid ordering into an invalid one.
  const root = await planPhaseOne(t);

  const first = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const firstPayload = parseJsonOutput(first);
  const artifactPath = path.join(root, ...firstPayload.approvals[0].artifactPath.split("/"));
  const firstBytes = await readFile(artifactPath, "utf8");

  const second = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(second.exitCode, 0, second.stderr);
  const secondPayload = parseJsonOutput(second);
  assert.equal(secondPayload.status, "unchanged");
  assert.equal(secondPayload.approvals[0].action, "unchanged");
  assert.equal(await readFile(artifactPath, "utf8"), firstBytes, "a no-op rerun rewrote the approval");
});

test("--dry-run resolves the approver and writes nothing", async (t) => {
  // A dry run exists to answer "will this command line work". One that resolved
  // nothing answered yes to a typo and left it to surface on the real run —
  // which for `legion review --accept` meant after a build and a review had
  // already happened. That defect is closed there; this is the same rule stated
  // for the verb that was written after it.
  const root = await planPhaseOne(t);

  const typo = await runCliCapture([
    "--repository-root", root, "approve", "spec", "--approver", "dasbi", "--dry-run", "--json"
  ]);
  assert.equal(typo.exitCode, 1);
  assert.equal(parseJsonOutput(typo).diagnostics[0].code, "approver_unknown");

  const dryRun = await runCliCapture([
    "--repository-root", root, "approve", "spec", "--approver", "dasbl", "--dry-run", "--json"
  ]);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const payload = parseJsonOutput(dryRun);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.approvals[0].action, "grant");
  // No `status` and no `decidedAt`: nothing was decided, and a dry-run payload
  // carrying them would read as a record of a decision to anything parsing it.
  assert.equal(payload.approvals[0].status, undefined);
  assert.equal(payload.approvals[0].decidedAt, undefined);

  assert.equal(
    await pathMissing(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "approvals")),
    true,
    "a dry run wrote an approvals directory"
  );
});

test("approve spec refuses to run without a named human approver", async (t) => {
  // No environment variable, no git config, no "the project has one owner so it
  // must be them". A silently defaulted approver is the same fail-open the
  // review verb refused, in a new costume — and here it is worse, because the
  // whole artifact this verb writes is a human's decision.
  const root = await planPhaseOne(t);

  const missing = await runCliCapture(["--repository-root", root, "approve", "spec", "--json"]);
  assert.equal(missing.exitCode, 1);
  const payload = parseJsonOutput(missing);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.diagnostics[0].code, "approver_required");
  assert.match(payload.nextAction.command, /--approver/);

  assert.equal(
    await pathMissing(path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "approvals")),
    true
  );
});

test("--requirement naming nothing in the change is refused rather than approving nothing", async (t) => {
  // Blocked, not a usage error: the argv is well formed and what refuses is the
  // change's own contents. A command that approves nothing and exits 0 is the
  // fail-open shape — the operator would read success and stop.
  const root = await planPhaseOne(t);

  const result = await runCliCapture([
    "--repository-root", root, "approve", "spec", "--requirement", "req_not-in-this-change", "--approver", "dasbl", "--json"
  ]);
  assert.equal(result.exitCode, 1);
  const payload = parseJsonOutput(result);
  assert.equal(payload.diagnostics[0].code, "requirement_not_in_change");
  assert.match(payload.diagnostics[0].message, /This change's delta specs cover: req_/);
});

test("a delta spec edited after approval stops the change loading, before any gate is derived", async (t) => {
  // Recorded because the gate specification names "the delta spec was edited
  // after approval" as its drift case, and that state cannot be reached through
  // the CLI. Delta specs are create-only — `legion plan` refuses to re-plan an
  // existing change and nothing else writes one — and `loadChangeBundle`
  // re-reads every delta spec and refuses the bundle when the bytes disagree
  // with the reference it carries. So `legion ship` dies at change discovery
  // with `delta_artifact_mismatch` and never derives a gate at all.
  //
  // This is why tests/ship-delta-spec-approval drives the `drift` arm through
  // `verifyPin` directly and says in its comment that it does. A test that
  // edited the file here and asserted `unsatisfied` would be asserting change
  // discovery failure while claiming to test the gate.
  //
  // It also pins the recovery. `legion ship` advises `legion plan 1` for this
  // state, which cannot perform the repair it promises — plan is create-only and
  // exits with `artifact_already_exists`. `legion approve spec` must not
  // reproduce that, and must not offer to re-approve the edited bytes, which
  // would launder an out-of-band edit into a governance record.
  const root = await planPhaseOne(t);
  const approved = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(approved.exitCode, 0, approved.stderr);

  const deltaSpec = path.join(root, ...parseJsonOutput(approved).approvals[0].deltaSpecPath.split("/"));
  await appendFile(deltaSpec, "\nAn edit nothing in Legion can make.\n");

  const ship = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.equal(ship.exitCode, 1);
  const shipPayload = parseJsonOutput(ship);
  assert.ok(
    shipPayload.diagnostics.some((entry) => entry.code === "delta_artifact_mismatch"),
    "an edited delta spec should fail change discovery"
  );
  assert.equal(
    shipPayload.diagnostics.some((entry) => entry.gate === "approved_delta_spec"),
    false,
    "no gate is derived at all in this state"
  );

  const reapprove = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(reapprove.exitCode, 1);
  const reapprovePayload = parseJsonOutput(reapprove);
  assert.ok(reapprovePayload.diagnostics.some((entry) => entry.code === "delta_artifact_mismatch"));
  assert.notEqual(reapprovePayload.nextAction.command, "legion plan 1");
  assert.match(reapprovePayload.nextAction.reason, /restore the file/);
});

/**
 * Read and rewrite the approval `legion approve spec` wrote, by hand.
 *
 * Every mutation below is a shape the gate rejects and a hand edit or a foreign
 * writer can produce. The point of driving them through the real file rather
 * than through the gate's unit suite is that the *command* has to see them: the
 * defect was a writer whose idea of "already approved" was weaker than the
 * reader's idea of "satisfied", and only an end-to-end run puts both in the same
 * repository.
 */
async function editApproval(root, artifactPath, edit) {
  const absolute = path.join(root, ...artifactPath.split("/"));
  const document = JSON.parse(await readFile(absolute, "utf8"));
  await writeFile(absolute, `${JSON.stringify(edit(document), null, 2)}\n`, "utf8");
  return absolute;
}

const GATE_REJECTED_SHAPES = [
  [
    "the delta spec pinned twice",
    (document) => ({ ...document, artifacts: [document.artifacts[0], { ...document.artifacts[0] }] })
  ],
  ["a stray taskId", (document) => ({ ...document, taskId: "tsk_phase-1-editor-mvp" })],
  [
    "a requirement target naming something else",
    (document) => ({
      ...document,
      scope: {
        ...document.scope,
        targets: document.scope.targets.map((target) =>
          target.kind === "requirement" ? { ...target, id: "req_something-else" } : target
        )
      }
    })
  ],
  [
    "a scope.action the gate does not read",
    (document) => ({ ...document, scope: { ...document.scope, action: "workflow.review.accept" } })
  ]
];

for (const [name, mutate] of GATE_REJECTED_SHAPES) {
  test(`approve spec re-grants over an approval the gate rejects: ${name}`, async (t) => {
    // The no-route-out defect, driven end to end. `plannedActionFor` decided
    // "unchanged" from a weaker predicate than the gate's `satisfied`, so in each
    // of these states `legion ship` exited 1 on `approved_delta_spec` while
    // `legion approve spec` exited 0 saying "Already approved", wrote nothing,
    // and would have done so forever — there is no `--force` and no other verb
    // writes this artifact. The command now asks the gate itself, so anything the
    // gate would not accept falls through to a write.
    const root = await planPhaseOne(t);
    const first = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
    assert.equal(first.exitCode, 0, first.stderr);
    const { artifactPath } = parseJsonOutput(first).approvals[0];
    await editApproval(root, artifactPath, mutate);

    const again = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
    assert.equal(again.exitCode, 0, again.stderr);
    const payload = parseJsonOutput(again);
    assert.equal(payload.status, "approved", `${name} was reported as needing no decision`);
    assert.equal(payload.approvals[0].action, "regrant");
    assert.deepEqual(payload.unapproved, []);

    // And the repair is real: a third run finds nothing left to decide, which is
    // only true if the second one wrote a document the gate accepts.
    const third = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
    assert.equal(parseJsonOutput(third).approvals[0].action, "unchanged");
  });
}

test("--dry-run on an unapproved change advises approving it, not building", async (t) => {
  // The dry run called the same next-action helper as the write path, and that
  // helper asked "was every delta *selected*" rather than "is every delta
  // *granted*" — so on a change where nothing had been approved it emitted
  // `nextAction: legion build` with the reason "Every delta spec in this change
  // is approved". `commands/approve.md` makes the dry run step 1 and tells the
  // host to present `nextAction` as its recommendation, so the one command that
  // promises to write nothing and tell the truth routed the operator straight
  // past itself into a build that leaves ship blocked on this very gate. The
  // human text said "No approval was written."; the JSON, which is what hosts
  // parse, said the opposite.
  const root = await planPhaseOne(t);

  const dryRun = await runCliCapture([
    "--repository-root", root, "approve", "spec", "--approver", "dasbl", "--dry-run", "--json"
  ]);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const payload = parseJsonOutput(dryRun);
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.unapproved, payload.approvals.map((entry) => entry.requirementId));
  assert.match(payload.nextAction.command, /^legion approve spec/);
  assert.match(payload.nextAction.reason, /no approval was written/i);
  assert.doesNotMatch(payload.nextAction.reason, /Every delta spec in this change is approved/);

  // Once the decision has actually been taken, the dry run says so and the
  // advice becomes the build — the arm that was previously reached whether or
  // not anything had been approved.
  const approved = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(approved.exitCode, 0, approved.stderr);
  const after = await runCliCapture([
    "--repository-root", root, "approve", "spec", "--approver", "dasbl", "--dry-run", "--json"
  ]);
  const afterPayload = parseJsonOutput(after);
  assert.deepEqual(afterPayload.unapproved, []);
  assert.equal(afterPayload.nextAction.command, "legion build");
});

test("re-granting over a revoked approval preserves the withdrawal in the plane", async (t) => {
  // Re-granting overwrote the revocation and left no trace of it anywhere.
  // `writeApproval` computes a `supersedes` reference, but `atomic-write.ts`
  // uses it only as a pre-write hash check before `rename()` replaces the file —
  // it is a sha256 of bytes that are then deleted and is never persisted into
  // any document. So the withdrawal, its reason and the person who made it
  // vanished from the one plane whose purpose is holding the negative fact, and
  // the command reported it in a `previousStatus` field and exited 0.
  //
  // Refusing instead would be worse: a change that can never recover from a
  // withdrawn approval pushes operators to delete artifacts to unblock a ship.
  // So the withdrawal is copied to its own document first, and the grant then
  // supersedes it — which is the supersession rule the gate already implements
  // and that until now no Legion writer could produce.
  const root = await planPhaseOne(t);
  await acceptedThrough(root);
  const first = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const { artifactPath } = parseJsonOutput(first).approvals[0];

  const WITHDRAWAL = "Withdrawn: the spec says the wrong thing about metadata.";
  await editApproval(root, artifactPath, (document) => ({
    ...document,
    status: "revoked",
    decisionReason: WITHDRAWAL
  }));

  const blocked = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.equal(blocked.exitCode, 1);
  assert.ok(
    parseJsonOutput(blocked).diagnostics.some(
      (entry) => entry.gate === "approved_delta_spec" && entry.code === "risk_gate_unsatisfied"
    ),
    "a revoked approval must block the ship"
  );

  const regrant = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(regrant.exitCode, 0, regrant.stderr);
  const payload = parseJsonOutput(regrant);
  assert.equal(payload.approvals[0].action, "regrant");
  assert.equal(payload.approvals[0].previousStatus, "revoked");

  // The withdrawal is named in the payload rather than reported as a bare
  // `previousStatus`, and it is on disk, and it is a complete document: the
  // decider, the instant and the words they wrote.
  assert.equal(payload.warnings.length, 1);
  assert.match(payload.warnings[0].message, /revoked/);
  assert.equal(payload.supersededDecisions.length, 1);
  const preserved = JSON.parse(
    await readFile(path.join(root, ...payload.supersededDecisions[0].artifactPath.split("/")), "utf8")
  );
  assert.equal(preserved.status, "revoked");
  assert.equal(preserved.decisionReason, WITHDRAWAL);
  assert.equal(preserved.metadata.attributes.superseded_approval_id, payload.approvals[0].approvalId);
  assert.notEqual(preserved.id, payload.approvals[0].approvalId);

  // And the change ships again — the preserved revocation is a standing negative
  // that a strictly later grant supersedes, so keeping it does not brick the
  // change it was withdrawn from.
  const after = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.deepEqual(
    parseJsonOutput(after).diagnostics.filter((entry) => entry.gate === "approved_delta_spec"),
    []
  );
});

test("a withdrawal dated at or after now is refused rather than half-superseded", async (t) => {
  // The one refusal in the re-grant path, and it exists because preserving the
  // withdrawal is only safe when the new grant actually supersedes it. The gate
  // requires a *strictly later* grant, so a revocation dated in the future would
  // survive the copy, keep standing, and leave the change unshippable — with the
  // command that could repair it reporting success. Refusing names both instants
  // and touches nothing.
  //
  // Driven with a hand-set future timestamp because no clock in the test can
  // produce one, which is also the only way this state arises in the wild: a
  // machine whose clock is wrong wrote the withdrawal.
  const root = await planPhaseOne(t);
  const first = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(first.exitCode, 0, first.stderr);
  const { artifactPath } = parseJsonOutput(first).approvals[0];
  const absolute = await editApproval(root, artifactPath, (document) => ({
    ...document,
    status: "revoked",
    decidedAt: "2099-01-01T00:00:00.000Z",
    decisionReason: "Withdrawn by a machine whose clock is wrong."
  }));
  const before = await readFile(absolute, "utf8");

  const refused = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(refused.exitCode, 1);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.diagnostics[0].code, "withdrawal_not_superseded");
  assert.match(payload.diagnostics[0].message, /2099-01-01T00:00:00\.000Z/);
  assert.equal(await readFile(absolute, "utf8"), before, "a refused re-grant rewrote the withdrawal");
});

test("a file the approvals listing cannot read is named, not silently fatal", async (t) => {
  // Any non-`.json` or non-parsing file under `approvals/` makes the plane
  // absent — deliberately, because a listing that dropped a file may have
  // dropped a withdrawal. What was wrong was that the filename was read and
  // discarded, so `approved_delta_spec` was pinned to `unevaluable` forever,
  // ship advised `legion approve spec`, and that command reported the change
  // fully approved and wrote nothing. Two individually honest commands and a
  // loop with no exit and no clue in it. A `.DS_Store`, a `Thumbs.db`, an editor
  // swap file or a `.gitkeep` all produce it.
  const root = await planPhaseOne(t);
  await acceptedThrough(root);
  const approved = await runCliCapture(["--repository-root", root, "approve", "spec", "--approver", "dasbl", "--json"]);
  assert.equal(approved.exitCode, 0, approved.stderr);

  const before = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.deepEqual(
    parseJsonOutput(before).diagnostics.filter((entry) => entry.gate === "approved_delta_spec"),
    [],
    "the gate should be satisfied before the junk file lands"
  );

  const approvals = path.join(root, ".legion", "project", "changes", "chg_phase-1-editor-mvp", "approvals");
  await writeFile(path.join(approvals, ".DS_Store"), "  not json\n");

  const after = await runCliCapture(["--repository-root", root, "ship", "--json"]);
  assert.equal(after.exitCode, 1);
  const payload = parseJsonOutput(after);
  assert.ok(
    payload.diagnostics.some((entry) => entry.gate === "approved_delta_spec" && entry.code === "risk_gate_unevaluable"),
    "the collapsed plane must still block"
  );
  const named = payload.diagnostics.filter((entry) => entry.code === "artifact_plane_incomplete");
  assert.equal(named.length, 1);
  assert.match(named[0].message, /\.DS_Store/);
  assert.match(named[0].path, /approvals$/);
  // The cause is reported before the consequence, so an operator reading top
  // down is not sent to the recovery command first.
  assert.ok(
    payload.diagnostics.indexOf(named[0]) <
      payload.diagnostics.findIndex((entry) => entry.gate === "approved_delta_spec")
  );
});

test("legion approve refuses an unknown subject and a bare invocation", async (t) => {
  // A bare `legion approve` is a usage error rather than a help screen: a host
  // that mis-splits its argv must not read a help screen as a completed
  // approval. `legion approve --help` still helps.
  const root = await planPhaseOne(t);

  const bare = await runCliCapture(["--repository-root", root, "approve", "--json"]);
  assert.equal(bare.exitCode, 1);
  assert.equal(parseJsonOutput(bare).status, "usage_error");

  // `protected-path` rather than `oracle`, which this test used to name: oracle
  // is a subject now, and a test whose "unknown subject" quietly becomes a known
  // one asserts that the CLI refuses something it accepts. The replacement is
  // the next subject this verb is expected to grow, so the same drift is
  // possible again and the same fix will be needed.
  const unknown = await runCliCapture(["--repository-root", root, "approve", "protected-path", "--json"]);
  assert.equal(unknown.exitCode, 1);
  const payload = parseJsonOutput(unknown);
  assert.equal(payload.status, "usage_error");
  assert.match(payload.diagnostics[0].message, /Supported subjects: spec, oracle, surface/);

  // And the subject that *is* known is accepted as one, so the assertion above
  // cannot pass by the handler refusing everything.
  const known = await runCliCapture(["--repository-root", root, "approve", "oracle", "--json"]);
  assert.notEqual(parseJsonOutput(known).status, "usage_error");

  const help = await runCliCapture(["--repository-root", root, "approve", "--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /legion approve spec/);
});

test("each subject refuses the other's narrowing flag rather than ignoring it", async (t) => {
  // `declared-options.ts` holds one list for every `legion approve <subject>`,
  // because `undeclaredOptionError` runs before the handler and cannot see which
  // subject was named — so the per-subject boundary has to be the handler's. It
  // is a refusal rather than a silent ignore: `legion approve surface
  // --requirement req_x`, typed by someone who meant `spec`, would otherwise
  // re-affirm every drifted pin in the change and report success, having quietly
  // discarded the one word that said what they wanted.
  //
  // The comment on that options list predicted this exact hazard when a second
  // subject arrived. This is now the third, and the third is what broke the
  // mechanism: the guard used to be `subject === "spec" ? "path" : "requirement"`,
  // a two-way ternary that does not generalise. With a third subject it refused
  // `--requirement` for `oracle` by accident and **accepted `legion approve
  // oracle --path ops/x.yml` in silence** — the exact failure it exists to
  // prevent, failing open, with nothing in the tree asserting otherwise. It is a
  // per-subject owned-option table now, and the loop below drives every ordered
  // pair rather than the two that happened to be wired.
  const root = await planPhaseOne(t);

  // subject → the flags it does *not* own, and the subject each belongs to.
  //
  // The fourth subject is where the mechanism changed again. `protected-paths`
  // narrows by oracle id — the honest flag for a decision about the criteria one
  // oracle states — so `--oracle` is now owned by two subjects and `owns` is a
  // list rather than a string. The membership test that replaces it must still
  // refuse positively, so the loop drives every ordered pair, and the shared flag
  // is asserted *accepted* on both owners immediately after: a list-valued `owns`
  // with the test inverted is exactly how the silent-accept comes back.
  const FOREIGN = {
    spec: [["path", "surface"], ["oracle", "oracle"]],
    oracle: [["path", "surface"], ["requirement", "spec"]],
    surface: [["oracle", "oracle"], ["requirement", "spec"]],
    "protected-paths": [["path", "surface"], ["requirement", "spec"]]
  };

  for (const [subject, foreigners] of Object.entries(FOREIGN)) {
    for (const [flag, owner] of foreigners) {
      const result = await runCliCapture([
        "--repository-root",
        root,
        "approve",
        subject,
        `--${flag}`,
        "anything",
        "--approver",
        "dasbl",
        "--json"
      ]);
      assert.equal(result.exitCode, 1, `${subject} --${flag}`);
      const refused = parseJsonOutput(result);
      assert.equal(refused.status, "usage_error", `${subject} --${flag}`);
      assert.match(
        refused.diagnostics[0].message,
        new RegExp(`--${flag} is not an option of legion approve ${subject}`),
        `${subject} --${flag}`
      );
      // The refusal says what the flag would have done where it belongs, so an
      // operator who typed the wrong subject learns which one they meant.
      assert.match(refused.diagnostics[0].message, new RegExp(`legion approve ${owner} --${flag}`));
    }
  }

  const specWithPath = await runCliCapture([
    "--repository-root",
    root,
    "approve",
    "spec",
    "--path",
    "ops/compose.yml",
    "--approver",
    "dasbl",
    "--json"
  ]);
  assert.equal(specWithPath.exitCode, 1);
  assert.equal(parseJsonOutput(specWithPath).status, "usage_error");
  assert.match(parseJsonOutput(specWithPath).diagnostics[0].message, /--path is not an option of legion approve spec/);

  // The shared flag, in the direction the refusal loop cannot check: `--oracle`
  // belongs to two subjects now, and both must take it. A refusal here would mean
  // the fourth subject could never be narrowed at all, and the operator's only
  // route would be to decide every declaring oracle at once.
  for (const subject of ["oracle", "protected-paths"]) {
    const accepted = await runCliCapture([
      "--repository-root",
      root,
      "approve",
      subject,
      "--oracle",
      "orc_phase-1",
      "--approver",
      "dasbl",
      "--json"
    ]);
    const payload = parseJsonOutput(accepted);
    assert.notEqual(payload.status, "usage_error", `${subject} --oracle was refused`);
  }

  const surfaceWithRequirement = await runCliCapture([
    "--repository-root",
    root,
    "approve",
    "surface",
    "--requirement",
    "req_anything",
    "--approver",
    "dasbl",
    "--json"
  ]);
  assert.equal(surfaceWithRequirement.exitCode, 1);
  assert.match(
    parseJsonOutput(surfaceWithRequirement).diagnostics[0].message,
    /--requirement is not an option of legion approve surface/
  );
});
