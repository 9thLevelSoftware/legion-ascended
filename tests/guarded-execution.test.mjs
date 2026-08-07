import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * End-to-end enforcement, driven by an executor that actually misbehaves.
 *
 * Every earlier reconciliation test operated on synthetic observations, because
 * the `fake` executor wrote nothing. That gap is why an unsatisfiable task
 * contract, an unreconciled auto-fix path, a double-resolved base SHA and a
 * missing containment step all shipped through a green suite. These tests script
 * real writes and assert the harness catches them.
 */

const PLAN_ENV = "LEGION_FAKE_EXECUTOR_PLAN";
const TASKGRAPH = ".legion/project/changes/chg_phase-1-foundation/taskgraph.json";

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function plannedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-guarded-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  // Byte-exact checkout so restore assertions do not depend on platform
  // line-ending conversion.
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "Guarded", "--summary", "Guarded execution", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build it\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  await run("plan", "1", "--from-roadmap", "ROADMAP.md");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  return { root, run };
}

async function withPlan(plan, fn) {
  process.env[PLAN_ENV] = JSON.stringify(plan);
  try {
    return await fn();
  } finally {
    delete process.env[PLAN_ENV];
  }
}

test("an in-contract source edit is accepted", async (t) => {
  const { root, run } = await plannedProject(t);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(parseJsonOutput(build).status, "executed");
  assert.equal(await readFile(path.join(root, "src/app/main.ts"), "utf8"), "export const a = 1;\n");
});

test("a build that rewrites its own contract is blocked and reverted", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  const build = await withPlan(
    { writes: [{ path: TASKGRAPH, content: '{"tampered":true}\n' }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.equal(payload.status, "blocked");
  assert.ok(
    payload.diagnostics.some((entry) => /protected control artifact/i.test(entry.message)),
    `expected a protected-artifact diagnostic, got ${JSON.stringify(payload.diagnostics)}`
  );
  assert.ok(
    payload.diagnostics.some((entry) => /Restored 1 protected path/.test(entry.message)),
    "the diagnostic should say the artifact was restored, not merely that it was touched"
  );

  // Detection without containment would leave the rewrite for the next command.
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("committing the tampering does not launder it", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  // The case that defeats a re-resolved base SHA: diffing against the
  // executor's own commit would show a clean tree.
  const build = await withPlan(
    { writes: [{ path: TASKGRAPH, content: '{"tampered":true}\n' }], commit: true },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  assert.equal(parseJsonOutput(build).status, "blocked");
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("exceeding the file budget blocks the run", async (t) => {
  const { run } = await plannedProject(t);

  const writes = Array.from({ length: 40 }, (_, index) => ({
    path: `src/app/file-${index}.ts`,
    content: `export const v${index} = ${index};\n`
  }));

  const build = await withPlan({ writes }, () => run("build", "--executor", "fake", "--json"));

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.ok(
    payload.diagnostics.some((entry) => /budget/i.test(entry.message)),
    `expected a budget diagnostic, got ${JSON.stringify(payload.diagnostics)}`
  );
});

test("a false filesChanged report is recorded as a mismatch", async (t) => {
  const { root, run } = await plannedProject(t);

  const build = await withPlan(
    {
      writes: [{ path: "src/app/real.ts", content: "export const real = 1;\n" }],
      claimFilesChanged: ["src/app/imaginary.ts"]
    },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  const evidence = JSON.parse(
    await readFile(
      path.join(root, ".legion/project/changes/chg_phase-1-foundation/evidence-index.json"),
      "utf8"
    )
  );
  const ids = evidence.entries.at(-1).evidence.items.map((item) => item.id);
  assert.ok(
    ids.includes("claim-observation-mismatch"),
    `expected a claim/observation mismatch, got ${ids.join(", ")}`
  );
});

test("a large pre-existing control artifact survives a run", async (t) => {
  const { root, run } = await plannedProject(t);

  // Anything too big to snapshot was previously absent from the map, which
  // restoration read as "did not exist before" and deleted. A stale executor
  // log would be destroyed on every writable run.
  const bulky = ".legion/project/changes/chg_phase-1-foundation/bulky.log";
  const contents = `${"x".repeat(9 * 1024 * 1024)}\n`;
  await writeFile(path.join(root, ...bulky.split("/")), contents, "utf8");
  // Committed so the run starts from a clean worktree; the oversized path is
  // what is under test, not the dirty-worktree pre-flight.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "bulky log"]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal((await readFile(path.join(root, ...bulky.split("/")), "utf8")).length, contents.length);
});

test("a pre-existing symlink in the control tree is left alone", async (t) => {
  const { root, run } = await plannedProject(t);
  const planted = ".legion/project/planted-link";

  // Skipping symlinks made a planted link invisible to both the snapshot and
  // the post-run scan, so it survived containment for a later command to follow.
  try {
    await symlink(path.join(root, "ROADMAP.md"), path.join(root, ...planted.split("/")));
  } catch (error) {
    // Windows refuses symlink creation without elevation or developer mode.
    if (error?.code === "EPERM") return t.skip("symlink creation is not permitted here");
    throw error;
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "planted link"]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 2;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  // Present before dispatch, so it is part of the baseline and left alone.
  assert.equal(existsSync(path.join(root, ...planted.split("/"))), true);
});

test("a control artifact deleted by the run is restored", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  // Deletion leaves nothing in the post-run listing, so a scan that only walked
  // observed files would report clean.
  const build = await withPlan({ deletes: [TASKGRAPH] }, () =>
    run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("committing tampering and then tidying the tree is still caught", async (t) => {
  const { root, run } = await plannedProject(t);
  const original = await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8");

  // The attack a working-tree-only guard misses: commit the rewrite, then put
  // the file back. Nothing differs from the pre-dispatch snapshot, so the
  // protected-path comparison finds nothing — while the poisoned blob sits in
  // history for the next reset or merge to surface.
  const build = await withPlan(
    {
      writes: [{ path: TASKGRAPH, content: '{"tampered":true}\n' }],
      commit: true,
      writesAfterCommit: [{ path: TASKGRAPH, content: original }]
    },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.equal(payload.status, "blocked");
  assert.ok(
    payload.diagnostics.some((entry) => /committed changes to .* protected control artifact/i.test(entry.message)),
    `expected the committed rewrite to be reported, got ${JSON.stringify(payload.diagnostics)}`
  );

  // The working tree is clean, which is exactly why the tree alone is not enough.
  assert.equal(await readFile(path.join(root, ...TASKGRAPH.split("/")), "utf8"), original);
});

test("a symlink created by the run is detected and removed", async (t) => {
  const { root, run } = await plannedProject(t);
  const planted = ".legion/project/planted-link";

  // The case the previous test's name claimed but did not cover: the link is
  // created *during* dispatch, so it is absent from the snapshot and has to be
  // caught by the post-run scan and cleared without following it.
  const build = await withPlan(
    { symlinks: [{ path: planted, target: path.join(root, "ROADMAP.md") }] },
    () => run("build", "--executor", "fake", "--json")
  );

  if (!existsSync(path.join(root, ...planted.split("/"))) && build.exitCode === 0) {
    return t.skip("symlink creation is not permitted here");
  }

  assert.equal(build.exitCode, 1);
  assert.match(parseJsonOutput(build).diagnostics[0].message, /protected control artifact/i);
  assert.equal(existsSync(path.join(root, ...planted.split("/"))), false);
  // The link must be unlinked, never followed — its target stays intact.
  assert.match(await readFile(path.join(root, "ROADMAP.md"), "utf8"), /Phase 1: Foundation/);
});

// --- protected acceptance paths ---------------------------------------------
//
// The second population the harness watches, and the one it deliberately does
// *not* restore. Every test below exists for one defect: until this release the
// harness watched only `.legion/project`, so an implementer's run could delete
// the assertion in the test that decides its own acceptance criterion and every
// gate downstream would report a clean, in-contract, verified task. The word
// "protected" in `oracle.protectedPaths` named the control plane and nothing
// else, and nothing anywhere read a declaration about the tests.
//
// The direction of these assertions is the whole point and is the inverse of the
// control-plane tests above: a control artifact IS rolled back and DOES block,
// and an acceptance path is reported and left exactly as the run left it. A test
// that asserted the same thing of both would be asserting the conflation this
// release exists to prevent.

const ORACLE_DOCUMENT = ".legion/project/changes/chg_phase-1-foundation/oracle/orc_phase-1-foundation.yaml";
const ORACLE_DIR = ".legion/project/changes/chg_phase-1-foundation/oracle";
const RUNS_DIR = ".legion/project/changes/chg_phase-1-foundation/runs";

/**
 * Declare protected acceptance paths on the change's oracle, and commit.
 *
 * Written onto the planned oracle rather than authored through an interview
 * because these tests are about the *harness*, and driving a full intake to
 * reach it would make a harness failure look like an authoring failure. The
 * authoring path has its own suite; what this needs is an oracle on disk that
 * declares something, which is exactly what `legion plan` produces from a
 * criterion that named one.
 */
async function declareAcceptancePaths(root, paths, { extraOracle } = {}) {
  const target = path.join(root, ...ORACLE_DOCUMENT.split("/"));
  const document = JSON.parse(await readFile(target, "utf8"));
  document.oracle.acceptancePaths = paths;
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  if (extraOracle !== undefined) {
    const second = JSON.parse(JSON.stringify(document));
    second.oracle.id = extraOracle.oracleId;
    second.oracle.acceptancePaths = extraOracle.paths;
    await writeFile(
      path.join(root, ...ORACLE_DIR.split("/"), `${extraOracle.oracleId}.yaml`),
      `${JSON.stringify(second, null, 2)}\n`,
      "utf8"
    );
  }

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "declare protected acceptance paths"]);
}

/** The report the run wrote, read off disk rather than off the payload. */
async function protectedPathsReport(root) {
  const runs = path.join(root, ...RUNS_DIR.split("/"));
  const entries = readdirSync(runs).sort();
  const latest = entries.at(-1);
  return JSON.parse(await readFile(path.join(runs, latest, "protected-paths.json"), "utf8"));
}

/** The `protected-acceptance-paths` verdict recorded for the run's task. */
async function acceptanceItemVerdict(root) {
  const index = JSON.parse(
    await readFile(
      path.join(root, ".legion", "project", "changes", "chg_phase-1-foundation", "evidence-index.json"),
      "utf8"
    )
  );
  const entry = index.entries.at(-1);
  return entry.evidence.items.find((item) => item.id === "protected-acceptance-paths")?.verdict;
}

test("a run that edits a protected acceptance test is reported and NOT restored", async (t) => {
  // The defect: an implementer whose criterion is decided by a test file could
  // edit that file and every downstream gate would report a clean run. This is
  // the direct inverse of "a build that rewrites its own contract is blocked and
  // reverted" above — the run stays in contract, the new bytes stay on disk, and
  // the decision about whether that was legitimate belongs to the approval plane
  // rather than to the harness. Restoring here would also make the harness
  // silently undo a task's own work, which is why nothing in this file may.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const build = await withPlan(
    { writes: [{ path: acceptance, content: "assert(true);\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(parseJsonOutput(build).status, "executed");
  // NOT restored: the bytes the run left are the bytes on disk.
  assert.equal(await readFile(path.join(root, acceptance), "utf8"), "assert(true);\n");

  const report = await protectedPathsReport(root);
  assert.equal(report.verdict, "fail");
  assert.equal(report.status, "established");
  const observation = report.observations.find((entry) => entry.path === acceptance);
  assert.equal(observation.verdict, "changed");
  assert.equal(observation.note, "modified");
  assert.notEqual(observation.before.sha256, observation.after.sha256);
  assert.equal(await acceptanceItemVerdict(root), "fail");
});

test("a run that adds a declared acceptance test is reported, not restored and not blocked", async (t) => {
  // A task may legitimately create the test that decides it, which is exactly
  // why the harness reports rather than restores. It is still `changed`: writing
  // the bar you are judged against is the same self-grading act as lowering it,
  // and the gate is where that is decided. A `created` observation folded into
  // `unchanged` would let a run author and immediately weaken its own oracle.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await declareAcceptancePaths(root, [acceptance]);

  const build = await withPlan(
    { writes: [{ path: acceptance, content: "assert(price === 10);\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(existsSync(path.join(root, acceptance)), true, "the added file must survive the run");
  const observation = (await protectedPathsReport(root)).observations[0];
  assert.equal(observation.before.kind, "absent");
  assert.equal(observation.verdict, "changed");
  assert.equal(observation.note, "created");
});

test("a run that deletes a protected acceptance test is reported as deleted, and the deletion stands", async (t) => {
  // Deletion leaves nothing in a post-run listing, so a scan that only walked
  // files that exist would call it clean — the defect `protectedPathsTouched`
  // already closed for the control plane, restated here because this is a second
  // walker with its own comparison and no shared code path with that one.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const build = await withPlan({ deletes: [acceptance] }, () =>
    run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(existsSync(path.join(root, acceptance)), false, "the harness must not put it back");
  const observation = (await protectedPathsReport(root)).observations[0];
  assert.equal(observation.after.kind, "absent");
  assert.equal(observation.verdict, "changed");
  assert.equal(observation.note, "deleted");
  assert.equal(await acceptanceItemVerdict(root), "fail");
});

test("a run that leaves the protected acceptance tests alone records a pass", async (t) => {
  // The positive control. Without it every assertion above is satisfied by a
  // harness that reports `changed` unconditionally, and the gate would block
  // every honest run — which is the failure mode an operator would learn to work
  // around by deleting the declaration.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  const report = await protectedPathsReport(root);
  assert.equal(report.verdict, "pass");
  assert.equal(report.observations[0].verdict, "unchanged");
  assert.equal(await acceptanceItemVerdict(root), "pass");
});

test("a second run is judged against what this change first saw, not against what the last run left", async (t) => {
  // Guarantee 7, and the reason it exists. Each run used to take its own
  // pre-dispatch snapshot of the tree as it stood, so the sequence "gut the test,
  // then build again" produced a `fail` followed by a `pass`: run 2 hashed the
  // already-gutted file as its own `before`, saw it unchanged, and reported a
  // clean run over bytes nobody restored. Every gate downstream reads the latest
  // attempt, so the second report is the one that decides — which made a bare
  // rebuild a laundering machine for the exact act this population exists to
  // catch.
  //
  // The falsifier is the `before` digest of run 2. Remove the anchoring and it
  // becomes the digest of `assert(true);` and the verdict flips to pass.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const first = await withPlan(
    { writes: [{ path: acceptance, content: "assert(true);\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );
  assert.equal(first.exitCode, 0, first.stderr);
  const original = (await protectedPathsReport(root)).observations[0].before.sha256;
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "first build"]);

  // Nothing is restored and the executor writes nothing at all.
  const second = await withPlan({ writes: [] }, () => run("build", "--executor", "fake", "--json"));
  assert.equal(second.exitCode, 0, second.stderr);
  const report = await protectedPathsReport(root);
  const observation = report.observations.find((entry) => entry.path === acceptance);
  assert.equal(observation.before.sha256, original, "the anchor must be the state this change first saw");
  assert.equal(observation.verdict, "changed");
  assert.equal(report.verdict, "fail");
  assert.equal(await acceptanceItemVerdict(root), "fail");

  // And putting the bytes back does clear it, which is the half of the ship
  // gate's recovery that was never checked.
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "restore"]);
  const third = await withPlan({ writes: [] }, () => run("build", "--executor", "fake", "--json"));
  assert.equal(third.exitCode, 0, third.stderr);
  assert.equal((await protectedPathsReport(root)).verdict, "pass");
  assert.equal(await acceptanceItemVerdict(root), "pass");
});

test("a run whose predecessor's report cannot be read back is unknown, never re-baselined", async (t) => {
  // The anchor is reached through the evidence item that cites it, so the report
  // is not optional: deleting it to lose an inconvenient `before` has to answer
  // "unestablished", not "hash whatever is on disk now" — which is the laundering
  // above with one extra step. A scan of `runs/` for a file name would have made
  // the deletion invisible instead.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const first = await withPlan(
    { writes: [{ path: acceptance, content: "assert(true);\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );
  assert.equal(first.exitCode, 0, first.stderr);
  const runs = path.join(root, ...RUNS_DIR.split("/"));
  const firstRun = readdirSync(runs).sort().at(-1);
  await rm(path.join(runs, firstRun, "protected-paths.json"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "drop the report"]);

  const second = await withPlan({ writes: [] }, () => run("build", "--executor", "fake", "--json"));
  assert.equal(second.exitCode, 0, second.stderr);
  const report = await protectedPathsReport(root);
  assert.equal(report.status, "unestablished");
  assert.equal(report.verdict, "unknown");
  assert.match(report.reason, /is no longer there/);
  assert.equal(await acceptanceItemVerdict(root), "unknown");
});

test("a declaration naming a file that is not there is unknown, never a pass", async (t) => {
  // A declaration nothing can falsify must not read as one that held. Absent on
  // both sides is also the case-folded-alias hole: a criterion declaring
  // `tests/Foo.test.mjs` against a checkout carrying `tests/foo.test.mjs` is
  // absent before and after on a case-sensitive filesystem, and a `pass` there
  // would be a gate satisfied by a typo.
  const { root, run } = await plannedProject(t);
  await declareAcceptancePaths(root, ["tests/never-written.test.mjs"]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  const report = await protectedPathsReport(root);
  assert.equal(report.observations[0].verdict, "unknown");
  assert.equal(report.verdict, "unknown");
  assert.equal(await acceptanceItemVerdict(root), "unknown");
});

test("the snapshot covers every oracle of the change, not only the ones this task names", async (t) => {
  // `legion plan` materialises one task per executable criterion, so a per-task
  // declaration set leaves task B's run free to weaken a test task A's oracle
  // protects: B never snapshotted it, and A's evidence predates the edit. The
  // union is therefore taken over the change's whole oracle plane.
  //
  // The falsifier is an oracle the dispatched task does not reference at all —
  // exactly what `oraclesForTask` would not return. Narrow the union back to the
  // task and this run's report loses the path it touched and records a pass.
  const { root, run } = await plannedProject(t);
  // Both files exist, so the only reason this run's verdict can be anything but
  // `pass` is the second oracle's declaration being in the union.
  await writeFile(path.join(root, "acceptance.test.mjs"), "assert(price === 10);\n", "utf8");
  await writeFile(path.join(root, "other.test.mjs"), "assert(quote === 7);\n", "utf8");
  await declareAcceptancePaths(root, ["acceptance.test.mjs"], {
    extraOracle: { oracleId: "orc_phase-1-foundation-c2", paths: ["other.test.mjs"] }
  });

  const build = await withPlan(
    { writes: [{ path: "other.test.mjs", content: "assert(true);\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 0, build.stderr);
  const report = await protectedPathsReport(root);
  assert.equal(report.verdict, "fail");
  const observation = report.observations.find((entry) => entry.path === "other.test.mjs");
  assert.equal(observation.verdict, "changed");
  assert.equal(
    report.declaredBy.some((entry) => entry.oracleId === "orc_phase-1-foundation-c2"),
    true,
    "the report must name the oracle that declared the touched path"
  );
});

test("a control-plane path cannot be declared as a protected acceptance path", async (t) => {
  // The two populations get opposite treatment, so an overlap would be a control
  // artifact reported as a mere observation and an acceptance test fed to the
  // restore machinery. The schema refuses it, which makes the disjointness a
  // property of the documents rather than of the walkers — and an oracle carrying
  // one does not read at all, so the run blocks on the criteria it could not
  // evaluate rather than proceeding on a declaration nobody could honour.
  const { root, run } = await plannedProject(t);
  await declareAcceptancePaths(root, [TASKGRAPH]);

  const build = await withPlan(
    { writes: [{ path: "src/app/main.ts", content: "export const a = 1;\n" }] },
    () => run("build", "--executor", "fake", "--json")
  );

  assert.equal(build.exitCode, 1);
  const payload = parseJsonOutput(build);
  assert.ok(
    payload.diagnostics.some((entry) => /oracle\(s\) that could not be read/i.test(entry.message)),
    `expected the oracle to be refused, got ${JSON.stringify(payload.diagnostics)}`
  );
  // And the set is reported as unestablished rather than as empty: "the plane
  // would not read" must never be spelled the same way as "nothing is protected".
  const report = await protectedPathsReport(root);
  assert.equal(report.status, "unestablished");
  assert.equal(report.verdict, "unknown");
});

test("a protected acceptance test swapped for a symlink is changed, even when the bytes match", async (t) => {
  // A hash-only comparison calls this clean: the link resolves to a file with the
  // same bytes. `protectedPathsTouched` closed that hole for the control plane
  // deliberately — "a file swapped for a link, or the reverse, is a change even
  // when the bytes behind it happen to match" — and this is a second walker with
  // its own comparison, so the hole is closed again rather than inherited.
  const { root, run } = await plannedProject(t);
  const acceptance = "acceptance.test.mjs";
  await writeFile(path.join(root, acceptance), "assert(price === 10);\n", "utf8");
  await writeFile(path.join(root, "decoy.test.mjs"), "assert(price === 10);\n", "utf8");
  await declareAcceptancePaths(root, [acceptance]);

  const build = await withPlan(
    { deletes: [acceptance], symlinks: [{ path: acceptance, target: path.join(root, "decoy.test.mjs") }] },
    () => run("build", "--executor", "fake", "--json")
  );

  const report = await protectedPathsReport(root);
  const observation = report.observations.find((entry) => entry.path === acceptance);
  if (observation.after.kind !== "symlink") {
    // Windows refuses symlink creation without elevation or developer mode.
    return t.skip("symlink creation is not permitted here");
  }
  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(observation.verdict, "changed");
  assert.equal(observation.note, "kind-changed");
});
