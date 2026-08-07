import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Whole-change acceptance: the writer, the cascade it forces, and the first R2
 * change to ship end to end.
 *
 * `createChangeBundle` has always written `acceptance: {status: "not_ready"}`,
 * and until this release nothing in the workflow ever moved it — the change
 * service exported create, load, validate and diff, and had no write-after-create
 * path at all. So `whole_change_acceptance_evidence` had no producer, every R2
 * change was structurally unshippable, and `legion dev change archive`'s
 * `acceptance.status === "accepted"` precondition was unreachable.
 *
 * The defect this file exists for beyond that: **writing anything into
 * `change.yaml` breaks the change's own traceability.** `legion plan` records the
 * proposal's `{sha256, revision}` in the taskgraph's `artifactInputs` and
 * `legion build` copies that list into the evidence index, so an acceptance write
 * makes both records stale, `validateArtifactInputFreshness` reports two
 * `stale_revision_reference` diagnostics, and `legion ship` flattens those to
 * `change_traceability_broken` *before any gate is evaluated* — so the very gate
 * the acceptance was written for would never be reached to explain itself. The
 * accept re-points the two pins it invalidated, and does so under an exact-match
 * rule that refuses to launder anything it did not invalidate itself.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";

/**
 * R2 with an executable criterion declaring a real-interface surface.
 *
 * The same recipe tests/verification-surface-authoring drives, because R2 is the
 * tier that derives all seven gates this release closes the last of, and a
 * non-unit surface declaration is what `integration_or_real_interface_checks`
 * needs to answer anything but `unsatisfied`.
 */
const ANSWERS = {
  "project-name": "Order Router",
  "project-summary": "Routes orders to the pricing service.",
  "project-owner": "dasbl",
  "problem-statement": "Orders are priced against a stub, so drift ships.",
  "problem-users": "Payments engineers.",
  "problem-success": "A pricing change that breaks the contract fails before release.",
  "req-1-statement": "Orders are priced against the real pricing service",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A quote request reaches the running pricing service",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --version",
  "req-1-ac-1-surface-kind": "real-interface",
  "req-1-ac-1-surface-interface": "POST /v1/quote",
  "req-1-ac-1-surface-rationale":
    "The check starts the pricing service and posts a real quote, with no HTTP stub in the path.",
  "req-1-ac-1-surface-pins": COMPOSE_PATH,
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Currency conversion",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "A new surface other services depend on.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

/** Every gate DEFAULT_RISK_POLICY derives at R2, named rather than counted. */
const R2_GATES = [
  "approved_delta_spec",
  "protected_oracle",
  "task_contract",
  "deterministic_verification",
  "task_level_independent_review",
  "integration_or_real_interface_checks",
  "whole_change_acceptance_evidence"
];

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Make a file genuinely unwritable, on this platform.
 *
 * `chmod 0o444` is not enough on Windows: NTFS ignores the mode bits Node maps
 * onto it for this purpose, and the write succeeds. `attrib +R` is what actually
 * refuses there — and `attrib` is a Windows binary, so calling it unconditionally
 * threw `spawnSync attrib ENOENT` on Linux and macOS and failed the two tests
 * that use it for a reason having nothing to do with what they assert.
 *
 * Both are applied where both exist, and only the applicable one elsewhere. The
 * POSIX side is `chmod` alone, which is sufficient for any non-root user; CI
 * runners are not root. Both operations live here rather than half here and half
 * at the call site, so the platform question is asked once.
 */
async function makeUnwritable(filePath) {
  await chmod(filePath, 0o444);
  if (process.platform === "win32") execFileSync("attrib", ["+R", filePath], { stdio: "ignore" });
}

/**
 * The two tests below need one file inside the change directory to refuse a
 * write while its siblings still accept one. That is constructible on Windows
 * and not on POSIX.
 *
 * Artifact writes here are atomic: write a temp file, then `rename` it over the
 * target. POSIX `rename` consults the *directory's* permissions, not the
 * target file's, so `chmod 0o444` on `taskgraph.json` does not stop it — the
 * accept simply succeeded and these tests failed asserting exit 1. Making the
 * directory read-only would work, but it would also block the `change.yaml`
 * write that both tests require to land, since that is the half they exist to
 * prove is not lost. Windows refuses to replace a read-only file even by
 * rename, which is why `attrib +R` gives exactly the one-file granularity
 * needed and nothing on POSIX does.
 *
 * So these run on Windows, where the failure they describe is reachable. What
 * is not covered elsewhere is named rather than left implied: on Linux and
 * macOS the `change_inputs_not_repointed` recovery path is exercised by no test
 * in this suite. Inducing it portably needs a fault-injection seam in the
 * artifact writer, which is a larger change than this fix.
 */
const testWhereOneFileCanRefuseAWrite = process.platform === "win32" ? test : test.skip;

/**
 * Undo {@link makeUnwritable}, so the write under test can be retried.
 *
 * A missing file is not an error here. This runs both inside a test — where the
 * file certainly exists and restoring it is the point — and from a `t.after`
 * hook that is only a safety net so a read-only file cannot block the temp
 * tree's removal on Windows. By the time that hook runs the tree may already be
 * gone, and "restore writability on a file that no longer exists" is a no-op
 * rather than a failure.
 */
async function makeWritable(filePath) {
  if (process.platform === "win32") execFileSync("attrib", ["-R", filePath], { stdio: "ignore" });
  try {
    await chmod(filePath, 0o666);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** An R2 change driven to a submitted review, one command short of acceptance. */
async function reviewedR2(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  const finalized = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalized.exitCode, 0, finalized.stdout + finalized.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  const approved = await run("approve", "spec", "--approver", "dasbl", "--json");
  assert.equal(approved.exitCode, 0, approved.stdout + approved.stderr);
  // Committed, because `legion build` refuses a dirty worktree and the approval
  // it just wrote is an untracked file.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve spec"]);

  const built = await run("build", "--executor", "fake", "--json");
  assert.equal(built.exitCode, 0, built.stdout + built.stderr);
  const reviewed = await run("review", "--executor", "fake", "--json");
  assert.equal(reviewed.exitCode, 0, reviewed.stdout + reviewed.stderr);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const changeDir = path.join(root, ".legion/project/changes", changeId);
  const readArtifact = async (name) => JSON.parse(await readFile(path.join(changeDir, name), "utf8"));
  return { root, run, changeId, changeDir, readArtifact };
}

test("an R2 change ships ready, end to end, for the first time", async (t) => {
  // The milestone. Before this release `legion ship` on this exact fixture
  // reported one unmet gate — `whole_change_acceptance_evidence`, `unevaluable`,
  // "Legion does not yet produce evidence for this gate." — and zero
  // `unsatisfied`. Nothing else stood between an R2 change and `ready`.
  //
  // The count alone would be "seven of seven" whether the seventh row is this
  // gate or a duplicate of the sixth, so it is pinned from three directions: the
  // tier and task count that make seven the right number, the counts themselves,
  // and — at the end — the observation that demoting the acceptance and nothing
  // else takes exactly this gate away and leaves the other six standing.
  const { run, changeDir, changeId, readArtifact, root } = await reviewedR2(t);

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  const acceptance = parseJsonOutput(accepted).acceptance;
  assert.equal(acceptance.status, "accepted");
  assert.equal(acceptance.acceptedBy, "dasbl");

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 0, shipped.stdout + shipped.stderr);
  const payload = parseJsonOutput(shipped);
  assert.equal(payload.status, "ready");
  assert.equal(payload.riskGates.unevaluable, 0);
  assert.equal(payload.riskGates.unsatisfied, 0);
  assert.equal(payload.riskGates.satisfied, R2_GATES.length);

  // The count above is only "every R2 gate" if the change really has one R2
  // task. Both halves are asserted, because a lowered tier or an extra task
  // would make seven-of-seven true for nothing.
  const taskgraph = await readArtifact("taskgraph.json");
  assert.equal(taskgraph.tasks.length, 1, "the recipe plans exactly one task, so seven rows is seven gates");
  assert.deepEqual(
    [...new Set(taskgraph.tasks.map((task) => task.risk.tier))],
    ["R2"],
    "the milestone is about R2; a lowered tier would derive fewer gates and pass for nothing"
  );

  // On disk, the acceptance is a real revisioned write of the proposal.
  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.revision, 2, "the bundle was created at 1 and the acceptance is its first update");
  assert.equal(bundle.change.acceptance.status, "accepted");
  assert.equal(bundle.change.acceptance.acceptedBy, "dasbl", "acceptedBy is an actor id string, not an Actor object");

  // The sign-off's instant is byte-identical to the evidence's, because
  // `legion review --accept` computes it once. That equality is what makes the
  // gate's `>=` the only workable comparison.
  const evidence = await readArtifact("evidence-index.json");
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.entries[0].acceptance.acceptedAt, bundle.change.acceptance.acceptedAt);

  // `artifactRevisions` is stored twice — on the bundle and on `bundle.change` —
  // and nothing in the tree compares the two. A rewrite that reconstructed one
  // and not the other would parse cleanly, disagree with itself, and be caught by
  // no existing assertion anywhere.
  assert.deepEqual(bundle.artifactRevisions, bundle.change.artifactRevisions);
  assert.ok(bundle.artifactRevisions.length > 0);
  assert.equal(
    bundle.artifactRevisions.some((revision) => revision.role === "proposal"),
    false,
    "the proposal is not among its own recorded revisions, which is why rewriting it cannot invalidate them"
  );

  // And the seventh row really is this gate. Demote the acceptance — the whole
  // of the change to the repository — and exactly one gate leaves the satisfied
  // set. Without this, "7 satisfied" would be a number rather than a claim about
  // which gates, and a future gate quietly going unevaluable would shrink the
  // total rather than name itself.
  const { updateChangeAcceptance } = await import("../packages/artifacts/dist/index.js");
  const demoted = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: { status: "not_ready" },
    expectedRevision: bundle.revision
  });
  assert.equal(demoted.ok, true, JSON.stringify(demoted.diagnostics ?? []));

  const blocked = await run("ship", "--json");
  assert.equal(blocked.exitCode, 1);
  const blockedPayload = parseJsonOutput(blocked);
  assert.deepEqual(
    blockedPayload.diagnostics.map((entry) => entry.gate),
    ["whole_change_acceptance_evidence"],
    "demoting the acceptance must take this gate and only this gate out of the satisfied set"
  );
});

test("a ready ship says out loud that a plane it did not need was unreadable", async (t) => {
  // An R2 change does not derive `release_observation_plan`, so a corrupt
  // `release.json` cannot block it — and should not. But "this gate did not
  // apply" and "an artifact in this change could not be read" are different
  // facts, and only the first one was reaching the operator.
  //
  // The warning was assembled into `planeSkips`, put in the JSON payload, and
  // then omitted from the `human` string that a terminal run actually prints.
  // So `legion ship` told someone piping JSON that a file was unreadable and
  // told the person at the keyboard "Ship ready." — the rule two lines above it
  // in that same array exists precisely to forbid that.
  const { run, changeDir } = await reviewedR2(t);

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);

  await writeFile(path.join(changeDir, "release.json"), "{ this is not json\n", "utf8");

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 0, "an R2 change does not derive the release gate, so this must not block");
  const payload = parseJsonOutput(shipped);
  assert.equal(payload.status, "ready");
  const planeWarning = (payload.warnings ?? []).find((entry) => /release/i.test(entry.message));
  assert.ok(planeWarning, `the unreadable plane must be reported, got ${JSON.stringify(payload.warnings)}`);

  // The assertion this test exists for: the same sentence reaches the terminal.
  const human = await run("ship");
  assert.equal(human.exitCode, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Ship ready\./);
  assert.match(
    human.stdout,
    /warning: .*release/i,
    `a terminal run must not print "Ship ready." while hiding the unreadable plane, got:\n${human.stdout}`
  );
});

test("the accept re-points the artifact inputs its own write invalidated", async (t) => {
  // Without this the milestone above is unreachable: the taskgraph and the
  // evidence index both pin `change.yaml`'s `{sha256, revision}`, so the
  // acceptance write makes both stale and `legion ship` returns
  // `change_traceability_broken` before evaluating a single gate.
  const { run, changeDir, changeId, readArtifact, root } = await reviewedR2(t);

  const before = await readArtifact("taskgraph.json");
  const beforePin = before.artifactInputs.find((entry) => entry.artifact.path.endsWith("change.yaml"));
  assert.equal(beforePin.revision, 1, "the plan pinned the bundle at its creation revision");

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);

  // Reported, not silent. Two artifact-input lists were rewritten by a command
  // the operator ran for another reason, and a payload that did not say so would
  // make the next reader of `git diff` wonder what touched the taskgraph.
  const repointed = parseJsonOutput(accepted).acceptance.repointed;
  assert.equal(repointed.length, 2);
  assert.deepEqual(
    repointed.map((entry) => path.posix.basename(entry.artifactPath)),
    ["taskgraph.json", "evidence-index.json"],
    "the taskgraph first: its own revision bump is what the evidence index also has to be re-pointed at"
  );

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  const after = await readArtifact("taskgraph.json");
  const afterPin = after.artifactInputs.find((entry) => entry.artifact.path.endsWith("change.yaml"));
  assert.equal(afterPin.revision, bundle.revision);
  const evidence = await readArtifact("evidence-index.json");
  const evidencePin = evidence.artifactManifest.inputs.find((entry) => entry.artifact.path.endsWith("change.yaml"));
  assert.equal(evidencePin.revision, bundle.revision);
  const graphPin = evidence.artifactManifest.inputs.find((entry) => entry.artifact.path.endsWith("taskgraph.json"));
  assert.equal(graphPin.revision, after.revision, "the taskgraph's own bump cascades into the evidence index");

  // The authority, rather than a re-implementation of it in the assertion.
  const { validateChangeTraceability } = await import("../packages/artifacts/dist/index.js");
  const traceability = await validateChangeTraceability({ repositoryRoot: root, changeId });
  assert.equal(traceability.ok, true, JSON.stringify(traceability.diagnostics ?? []));
});

test("the re-point declines to launder an edit it did not make", async (t) => {
  // The safety argument for the cascade, and the only thing separating it from
  // "make everything current". `validateArtifactInputFreshness` is the *only*
  // detector of a hand-written or back-dated `change.acceptance`: the proposal is
  // not in `bundle.artifactRevisions` and `loadChangeBundle` never re-checks its
  // own bytes, so the pins in the taskgraph and the evidence index are all that
  // stand behind the field this gate now reads.
  //
  // Here the bundle is edited out of band before the accept. The recorded pin no
  // longer names the revision the accept superseded, the exact-match rule
  // declines, and `legion ship` keeps reporting the drift. Weaken `namesRevision`
  // to compare paths and this test goes green while the detector is gone.
  const { run, changeDir } = await reviewedR2(t);

  const proposalPath = path.join(changeDir, "change.yaml");
  const edited = JSON.parse(await readFile(proposalPath, "utf8"));
  edited.change.title = `${edited.change.title} (edited by hand)`;
  await writeFile(proposalPath, `${JSON.stringify(edited)}\n`, "utf8");

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  assert.equal(
    parseJsonOutput(accepted).acceptance.repointed,
    undefined,
    "nothing was re-pointed, because nothing recorded the revision this write superseded"
  );

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "an out-of-band edit to the bundle must still be reported");
  const diagnostics = parseJsonOutput(shipped).diagnostics;
  assert.ok(
    diagnostics.some((entry) => entry.code === "change_traceability_broken" && /change\.yaml records revision/.test(entry.message)),
    `expected the stale change.yaml pin to be named: ${JSON.stringify(diagnostics)}`
  );
});

/**
 * Tear an acceptance write: rewrite the proposal with no cascade after it.
 *
 * Reconstructed with the real writer rather than described, because the claim is
 * about what the artifact services do. This is exactly what a process death, an
 * I/O failure on `taskgraph.json` or a Ctrl-C between two renames leaves behind:
 * a sign-off on disk with the taskgraph and evidence index still pinning the
 * revision it replaced.
 */
async function tearAcceptanceWrite({ root, changeId, changeDir }) {
  const { loadChangeBundle, stableProtocolJson, writeRevisionedArtifact } = await import(
    "../packages/artifacts/dist/index.js"
  );
  const before = await loadChangeBundle({ repositoryRoot: root, changeId });
  assert.equal(before.ok, true);
  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  await writeRevisionedArtifact({
    repositoryRoot: root,
    artifactPath: before.artifactPath,
    role: "proposal",
    // `change.updatedAt` and nothing else. The bytes have to move for the
    // revision to move, and moving `acceptance.acceptedAt` would back-date the
    // sign-off — which is a *different* defect this gate reports on its own, and
    // would make the repair look as though it had not worked.
    content: stableProtocolJson({
      ...bundle,
      revision: bundle.revision + 1,
      change: { ...bundle.change, updatedAt: "2026-08-05T09:00:00.000Z" }
    }),
    expectedRevision: bundle.revision,
    currentRevision: bundle.revision,
    mediaType: "application/json",
    supersedes: before.reference
  });
}

test("a torn acceptance write has a route out, and it is a verb", async (t) => {
  // **The defect this test exists for was terminal.** There is no transaction
  // across the proposal write and the two re-points — each `writeRevisionedArtifact`
  // is individually atomic and they take three separate per-file locks — so any
  // I/O failure or process death between them left the change permanently
  // unshippable. The re-point matched only the exact revision *that call*
  // superseded, so no later call could ever recognize the pins left behind:
  // `legion plan` refused with `artifact_already_exists`, `legion build` did not
  // rewrite `taskgraph.artifactInputs`, `legion validate` reported valid, and
  // every retry of the accept walked the bundle one revision further while
  // repairing nothing. The hand correction `legion ship` advertised was not
  // performable either — editing `taskgraph.artifactInputs` trips
  // `taskgraph_manifest_inputs_mismatch`, and repairing that trips
  // `manifest_hash_mismatch` on a hash no command recomputes.
  const { run, changeDir, changeId, readArtifact, root } = await reviewedR2(t);
  const { validateChangeTraceability } = await import("../packages/artifacts/dist/index.js");

  // A whole accept first, so `legion ship` gets past its own preconditions — it
  // refuses before any gate runs unless an accepted review and accepted evidence
  // both exist — and so the state being torn is a *second* acceptance write over
  // a repository that is otherwise entirely consistent.
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.equal((await run("ship", "--json")).exitCode, 0, "the fixture is ship-ready before it is torn");

  const graph = await readArtifact("taskgraph.json");
  assert.equal(graph.artifactInputs.find((entry) => entry.artifact.path.endsWith("change.yaml")).revision, 2);
  await tearAcceptanceWrite({ root, changeId, changeDir });

  const broken = await validateChangeTraceability({ repositoryRoot: root, changeId });
  assert.equal(broken.ok, false, "a proposal rewritten without the re-point must not read as current");
  assert.equal(
    broken.diagnostics.filter((entry) => entry.code === "stale_revision_reference").length,
    2,
    `expected the taskgraph and the evidence index to both report: ${JSON.stringify(broken.diagnostics)}`
  );

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "the torn state blocks the ship, before any gate is evaluated");
  assert.ok(parseJsonOutput(shipped).diagnostics.some((entry) => entry.code === "change_traceability_broken"));

  // The route out, through the CLI an operator actually has.
  const repaired = await run("dev", "change", "repoint", changeId, "--json");
  assert.equal(repaired.exitCode, 0, repaired.stdout + repaired.stderr);
  assert.equal(parseJsonOutput(repaired).status, "repointed");
  assert.equal(parseJsonOutput(repaired).repointed.length, 2);
  assert.equal((await validateChangeTraceability({ repositoryRoot: root, changeId })).ok, true);
  assert.equal((await run("ship", "--json")).exitCode, 0, "the repaired change ships again");

  // Idempotent, so it is safe to run when unsure: nothing is superseded now, so
  // nothing is substituted and no revision moves.
  const graphBefore = (await readArtifact("taskgraph.json")).revision;
  const again = await run("dev", "change", "repoint", changeId, "--json");
  assert.equal(again.exitCode, 0);
  assert.equal(parseJsonOutput(again).status, "current");
  assert.deepEqual(parseJsonOutput(again).repointed, []);
  assert.equal((await readArtifact("taskgraph.json")).revision, graphBefore);
});

test("a retried accept repairs a torn write rather than tearing further", async (t) => {
  // The other half of the terminal state, and the worse half: the documented
  // retry loop made it strictly worse on every round. Because the re-point
  // matched only its own superseded revision, a second `legion review` +
  // `legion review --accept` exited 0 while writing a **false** `blocked` — false
  // because the traceability defect it recorded was the tear itself — and left
  // the pins exactly where they were. Rounds two and three walked the bundle
  // further, each recording another false verdict.
  //
  // The accept now repairs the pins before it derives the verdict, so the retry
  // an operator will reach for first is the one that works.
  const { run, changeDir, changeId, root } = await reviewedR2(t);
  const { validateChangeTraceability } = await import("../packages/artifacts/dist/index.js");

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  await tearAcceptanceWrite({ root, changeId, changeDir });
  assert.equal((await validateChangeTraceability({ repositoryRoot: root, changeId })).ok, false);

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const retried = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(retried.exitCode, 0, retried.stdout + retried.stderr);
  assert.equal(
    parseJsonOutput(retried).acceptance.status,
    "accepted",
    "the retry must not record a block about the tear it is repairing"
  );

  assert.equal((await validateChangeTraceability({ repositoryRoot: root, changeId })).ok, true);
  assert.equal((await run("ship", "--json")).exitCode, 0);
});

testWhereOneFileCanRefuseAWrite("a re-point that cannot write says so by name, and says the sign-off landed", async (t) => {
  // `writeTaskGraph` and `writeEvidenceIndex` catch only
  // `ArtifactRevisionConflictError` and rethrow everything else, and the re-point
  // caught nothing — so the designed `change_inputs_not_repointed` diagnostic
  // fired for one failure class and never for the reachable one. With
  // `taskgraph.json` unwritable, the accept exited 1 with a raw
  // `{"code":"unhandled_error","message":"EPERM: … rename …"}`: no nextAction, no
  // route to a repair, and no statement anywhere that `change.yaml` had already
  // recorded the sign-off. An operator reading that has every reason to believe
  // the accept did nothing.
  const { run, changeDir, changeId } = await reviewedR2(t);

  const graphPath = path.join(changeDir, "taskgraph.json");
  await makeUnwritable(graphPath);
  t.after(() => makeWritable(graphPath));

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 1);
  const payload = parseJsonOutput(accepted);
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "change_inputs_not_repointed"),
    `expected the named diagnostic rather than an unhandled_error: ${JSON.stringify(payload.diagnostics)}`
  );
  assert.ok(
    payload.diagnostics.every((entry) => entry.code !== "unhandled_error"),
    accepted.stdout
  );

  // The acceptance is on disk. The message must say so, and must send the
  // operator to the command that repairs what is actually broken — not to
  // `legion validate`, which returns exit 0 and `{"status":"valid"}` on this
  // exact repository.
  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.change.acceptance.status, "accepted");
  assert.equal(bundle.revision, 2);
  assert.equal(payload.nextAction.command, `legion dev change repoint ${changeId}`);
  assert.match(payload.nextAction.reason, /whole-change acceptance WAS written/);

  await makeWritable(graphPath);
  const repaired = await run("dev", "change", "repoint", changeId, "--json");
  assert.equal(repaired.exitCode, 0, repaired.stdout + repaired.stderr);
  assert.equal((await run("ship", "--json")).exitCode, 0, "the advertised repair actually repairs it");
});

test("an accept whose traceability is broken records blocked, with the reason", async (t) => {
  // The promotion runs *after* the reviews, the evidence index and the approvals
  // are already on disk, so "refuse the accept" is not available — only "refuse
  // the promotion". Refusing it silently would leave `not_ready`, which
  // `legion ship` reports as "nobody decided" with no mention of the defect, and
  // would send the operator to run the accept again.
  const { run, changeDir, readArtifact } = await reviewedR2(t);

  // An evidence trace reference pointing at a requirement the change does not
  // define. Only the traceability service checks this; `legion validate` reads
  // tasks and never looks at evidence links.
  const indexPath = path.join(changeDir, "evidence-index.json");
  const index = await readArtifact("evidence-index.json");
  index.entries[0].evidence.traceRefs.push({
    path: path.posix.join(".legion/project/changes", path.basename(changeDir), "taskgraph.json"),
    anchor: index.entries[0].evidence.taskId,
    relation: "verifies",
    entity: { kind: "requirement", id: "req_nobody-defined-this" }
  });
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  const acceptance = parseJsonOutput(accepted).acceptance;
  assert.equal(acceptance.status, "blocked");
  // The reason names the defect. Without it the operator learns only that
  // something is wrong, from a field whose whole purpose is saying what.
  assert.match(acceptance.reason, /removed_target_reference|req_nobody-defined-this/);

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.change.acceptance.status, "blocked");

  // And the route out works. Repair the artifact, submit a fresh review — the
  // accept path refuses when no clean *submitted* review covers the entries, so
  // the already-accepted ones will not do — and accept again. The verdict is
  // re-derived from scratch, so `blocked` is replaced rather than argued with.
  const repaired = await readArtifact("evidence-index.json");
  repaired.entries[0].evidence.traceRefs = repaired.entries[0].evidence.traceRefs.filter(
    (ref) => ref.entity?.id !== "req_nobody-defined-this"
  );
  await writeFile(indexPath, `${JSON.stringify(repaired, undefined, 2)}\n`, "utf8");

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const reaccepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(reaccepted.exitCode, 0, reaccepted.stdout + reaccepted.stderr);
  assert.equal(parseJsonOutput(reaccepted).acceptance.status, "accepted");

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 0, shipped.stdout + shipped.stderr);
  assert.equal(parseJsonOutput(shipped).status, "ready");
});

test("an accept with no approver records ready, which is short of accepted", async (t) => {
  // Every task's evidence accepted and nobody named signing off on the change as
  // a whole. `acceptanceStateSchema`'s `ready` arm *permits* `acceptedAt` and
  // `acceptedBy` and requires neither, so a half-filled one parses cleanly and
  // reads to a human as an abandoned sign-off — all or nothing, on the rule the
  // review write already states for its own accept transition.
  const { run, changeDir } = await reviewedR2(t);

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  assert.equal(parseJsonOutput(accepted).acceptance.status, "ready");

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.deepEqual(bundle.change.acceptance, { status: "ready" });

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "a change nobody signed off is not ready");
  const diagnostics = parseJsonOutput(shipped).diagnostics;
  const gate = diagnostics.find((entry) => entry.gate === "whole_change_acceptance_evidence");
  assert.equal(gate.code, "risk_gate_unevaluable");
  assert.match(gate.message, /no named approver signed off/);
  // Change-scoped, so the diagnostic names the change rather than the task.
  assert.match(gate.message, /is not satisfied for chg_/);
});

test("rejecting a review demotes the change acceptance with it", async (t) => {
  // The fail-open this release would otherwise open. `rejectLatestReview`
  // rewrites every evidence entry to `rejected` and used to touch nothing else,
  // so accept-then-reject would leave `accepted` standing on disk with an
  // `acceptedAt` later than any *accepted* evidence — because a reject leaves
  // none — and the staleness branch cannot catch that: it compares against the
  // newest accepted instant, and there is none.
  //
  // `not_ready`, not `rejected`: the *review* was rejected, not the change.
  // `not_ready` with the reason recorded is the true statement, and it blocks
  // ship exactly as an `unsatisfied` would.
  const { run, changeDir } = await reviewedR2(t);

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  const accepted = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(accepted.change.acceptance.status, "accepted");

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const rejected = await run("review", "--reject-reason", "the pricing contract moved", "--json");
  assert.equal(rejected.exitCode, 0, rejected.stdout + rejected.stderr);
  assert.equal(parseJsonOutput(rejected).acceptance.status, "not_ready");

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.change.acceptance.status, "not_ready");
  assert.match(bundle.change.acceptance.reason, /the pricing contract moved/);
});

test("rejecting a change nobody accepted writes nothing at all", async (t) => {
  // The demotion above inherits the accept's three-rename tear window, and for a
  // reject on a never-accepted change it buys nothing in exchange: rejecting a
  // `not_ready` change to `not_ready` records no fact a reader can act on.
  //
  // It fired anyway, on every reject, because `updateChangeAcceptance` compares
  // the whole acceptance object — deliberately, since a stale `acceptedAt` under
  // an unchanged `status` is the fail-open the accept path exists to close — and
  // `{status:"not_ready"}` and `{status:"not_ready", reason}` are different
  // objects. So `legion review --reject-reason`, which before this release wrote
  // no bundle at all, moved the bundle to revision 2 and re-pointed both pinned
  // artifacts every time it ran. This asserts the guard that stops it: what the
  // demotion exists to prevent is a sign-off outliving its evidence, and a change
  // already recorded as undecided cannot be that.
  const { run, changeDir, readArtifact } = await reviewedR2(t);

  const pinsOf = (document) => document.artifactInputs ?? document.artifactManifest.inputs;
  const graphBefore = await readArtifact("taskgraph.json");
  const indexPinsBefore = pinsOf(await readArtifact("evidence-index.json"));

  const rejected = await run("review", "--reject-reason", "not good", "--json");
  assert.equal(rejected.exitCode, 0, rejected.stdout + rejected.stderr);
  assert.equal(
    parseJsonOutput(rejected).acceptance,
    undefined,
    "a reject that decided nothing about the change reports nothing about it"
  );

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.revision, 1, "the bundle was never rewritten");
  assert.deepEqual(bundle.change.acceptance, { status: "not_ready" });
  // The taskgraph is untouched entirely. The evidence index is rewritten — a
  // reject flips every entry's acceptance, which it always did — but its recorded
  // inputs must not move, because nothing rewrote what they pin.
  assert.deepEqual(await readArtifact("taskgraph.json"), graphBefore);
  assert.deepEqual(pinsOf(await readArtifact("evidence-index.json")), indexPinsBefore);
});

testWhereOneFileCanRefuseAWrite("a reject whose demotion cannot land routes to the repair, not to a dead end", async (t) => {
  // The reject side of the tear, which nothing covered. The demotion runs only
  // after an accept, so this drives accept → build → review → reject with the
  // taskgraph unwritable. Before the fix the reject exited with a raw
  // `unhandled_error` and the natural continuation — build, review, accept — then
  // reported success while leaving the change permanently unshippable.
  const { run, changeDir, changeId } = await reviewedR2(t);

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);

  const graphPath = path.join(changeDir, "taskgraph.json");
  await makeUnwritable(graphPath);
  t.after(() => makeWritable(graphPath));

  const rejected = await run("review", "--reject-reason", "the pricing contract moved", "--json");
  assert.equal(rejected.exitCode, 1);
  const payload = parseJsonOutput(rejected);
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "change_inputs_not_repointed"),
    `expected the named diagnostic rather than an unhandled_error: ${JSON.stringify(payload.diagnostics)}`
  );
  assert.equal(payload.nextAction.command, `legion dev change repoint ${changeId}`);
  assert.match(payload.nextAction.reason, /demotion WAS written/);

  await makeWritable(graphPath);
  assert.equal((await run("dev", "change", "repoint", changeId, "--json")).exitCode, 0);

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "a rejected change still does not ship");
  assert.ok(
    parseJsonOutput(shipped).diagnostics.every((entry) => entry.code !== "change_traceability_broken"),
    "but it is blocked on the rejection, not on an unrepairable tear"
  );
});

test("the accept the operator forgot --approver on is recoverable by the command the gate names", async (t) => {
  // **The highest-frequency operator mistake this release introduces, and the
  // defect PR 3's lesson forbids by name.** An accept with no `--approver` records
  // `{status:"ready"}`, and `legion ship` reports the gate `unevaluable`. The
  // recovery it printed was `legion review --accept --approver <id>` — which
  // exits 1 with `review_not_clean` in that exact state, because the accept that
  // recorded `ready` flipped the covering review from `submitted` to `accepted`
  // and `cleanSubmittedReviewCoverage` selects only submitted reviews. Five of
  // this gate's unmet states are reachable only after an accept and every one of
  // them was routed to that command.
  //
  // This drives both halves against the real CLI: the command the gate names now
  // works, and the one it used to name still does not.
  const { run } = await reviewedR2(t);

  assert.equal((await run("review", "--accept", "--json")).exitCode, 0);

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1);
  const payload = parseJsonOutput(shipped);
  const gate = payload.diagnostics.find((entry) => entry.gate === "whole_change_acceptance_evidence");
  assert.equal(gate.code, "risk_gate_unevaluable");
  // `shipGateRecovery` prefers the verdict's own recovery over the gate-id table,
  // and this is the only unmet gate, so what ship prints is this gate's answer.
  assert.equal(payload.nextAction.command, "legion review");
  assert.match(payload.nextAction.reason, /clean \*submitted\* review/);

  // The old advice, run verbatim. It has to still fail, or this test would pass
  // for the wrong reason and the recovery change would be untested.
  const straightRetry = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(straightRetry.exitCode, 1, "an accept over an already-accepted review is refused");
  assert.ok(
    parseJsonOutput(straightRetry).diagnostics.some((entry) => entry.code === "review_not_clean"),
    straightRetry.stdout
  );

  // The advice the gate gives now, in order.
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stdout + accepted.stderr);
  assert.equal(parseJsonOutput(accepted).acceptance.status, "accepted");
  assert.equal((await run("ship", "--json")).exitCode, 0, "the recovery the gate names actually ships the change");
});

test("an acceptance is refused on a bundle whose own parts have drifted", async (t) => {
  // The deliberate divergence from `writeEvidenceIndex`'s discipline: the
  // optimistic re-read goes through `loadChangeBundle`, which re-hashes every
  // delta spec, the design and the decision log against what the bundle records.
  // Signing off on a bundle whose parts no longer match what it says they are is
  // the fail-open this series closes, one artifact over.
  //
  // It is a real behaviour change for an existing command: before this, a
  // hand-edited `design.md` blocked only `legion ship` and archive.
  const { run, changeDir } = await reviewedR2(t);

  const designPath = path.join(changeDir, "design.md");
  await writeFile(designPath, `${await readFile(designPath, "utf8")}\nEdited out of band.\n`, "utf8");

  const accepted = await run("review", "--accept", "--approver", "dasbl", "--json");
  assert.equal(accepted.exitCode, 1, "a drifted bundle must not receive a sign-off");
  assert.ok(
    parseJsonOutput(accepted).diagnostics.some((entry) => entry.code === "design_artifact_mismatch"),
    accepted.stdout
  );

  const bundle = JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8"));
  assert.equal(bundle.revision, 1, "nothing was written");
  assert.equal(bundle.change.acceptance.status, "not_ready");
});

// --- the writer, directly ---------------------------------------------------

test("re-writing the same acceptance writes nothing and moves no revision", async (t) => {
  // The idempotence predicate is deep equality over the whole acceptance object,
  // never `status` alone. Short-circuiting on `status === "accepted"` would leave
  // a stale `acceptedAt` in place after a rebuild: the writer would report
  // success having written nothing, the gate would report the sign-off as older
  // than the evidence it covers, and no flag anywhere would make it write. That
  // is the no-route-out loop recorded at `isLiveDeltaSpecGrant`, in a new
  // costume.
  const { run, changeDir, changeId, root } = await reviewedR2(t);
  const { loadChangeBundle, updateChangeAcceptance } = await import("../packages/artifacts/dist/index.js");

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  const loaded = await loadChangeBundle({ repositoryRoot: root, changeId });
  assert.equal(loaded.bundle.revision, 2);

  const same = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: loaded.bundle.change.acceptance,
    expectedRevision: 2
  });
  assert.equal(same.ok, true);
  assert.equal(same.status, "unchanged");
  assert.deepEqual(same.repointed, []);
  assert.equal(JSON.parse(await readFile(path.join(changeDir, "change.yaml"), "utf8")).revision, 2);

  // The same status with a *different instant* is a different fact, so it is
  // written. This is the case a `status`-only short-circuit would swallow.
  const later = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: { ...loaded.bundle.change.acceptance, acceptedAt: "2026-09-01T00:00:00.000Z" },
    expectedRevision: 2
  });
  assert.equal(later.ok, true);
  assert.equal(later.status, "updated");
  assert.equal(later.bundle.revision, 3);
});

test("a stale expected revision is a conflict with a message that says which", async (t) => {
  // `writeRevisionedArtifact` maps a concurrent lock and a stale revision to the
  // same `revision_conflict` code with different messages, so a test asserting
  // only the code proves less than it looks. The wording is byte-identical to
  // `writeEvidenceIndex`'s and `writeTaskGraph`'s, so one grep finds all three.
  const { run, changeId, root } = await reviewedR2(t);
  const { updateChangeAcceptance } = await import("../packages/artifacts/dist/index.js");

  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const conflict = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: { status: "ready" },
    expectedRevision: 1
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.diagnostics[0].code, "revision_conflict");
  assert.equal(conflict.diagnostics[0].message, "stale artifact revision: expected 1, current 2");
});

test("revision 0 names no state a change bundle can be in", async (t) => {
  // `writeEvidenceIndex` and `writeTaskGraph` default `expectedRevision` to 0 and
  // read it as "create". Copying that here would be wrong twice over: creation is
  // a different function whose preflight refuses an existing file, and
  // `changeBundleSchema.revision` is `positive()`, so a bundle is created at 1
  // and 0 is not a revision it ever had.
  const { changeId, root } = await reviewedR2(t);
  const { updateChangeAcceptance } = await import("../packages/artifacts/dist/index.js");

  for (const expectedRevision of [0, -1, 1.5]) {
    const refused = await updateChangeAcceptance({
      repositoryRoot: root,
      changeId,
      acceptance: { status: "ready" },
      expectedRevision
    });
    assert.equal(refused.ok, false, `expectedRevision ${expectedRevision}`);
    assert.equal(refused.diagnostics[0].code, "invalid_expected_revision");
  }
});

test("an acceptance the schema refuses is refused by name, not by a zod dump", async (t) => {
  // `accepted` requires both `acceptedAt` and `acceptedBy`, and `acceptedBy` is a
  // bare actor-id string — not the `Actor` object that `reviewDecision.acceptedBy`
  // and `approval.decidedBy` both are. Three same-named fields, two types, one
  // code path, and a caller that passes the object straight through has to learn
  // so from a named diagnostic rather than from an unhandled parse error.
  const { changeId, root } = await reviewedR2(t);
  const { updateChangeAcceptance } = await import("../packages/artifacts/dist/index.js");

  const halfWritten = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: { status: "accepted", acceptedAt: "2026-08-05T09:00:00.000Z" },
    expectedRevision: 1
  });
  assert.equal(halfWritten.ok, false);
  assert.equal(halfWritten.diagnostics[0].code, "invalid_acceptance");

  const actorObject = await updateChangeAcceptance({
    repositoryRoot: root,
    changeId,
    acceptance: {
      status: "accepted",
      acceptedAt: "2026-08-05T09:00:00.000Z",
      acceptedBy: { kind: "human", id: "dasbl" }
    },
    expectedRevision: 1
  });
  assert.equal(actorObject.ok, false);
  assert.equal(actorObject.diagnostics[0].code, "invalid_acceptance");
});
