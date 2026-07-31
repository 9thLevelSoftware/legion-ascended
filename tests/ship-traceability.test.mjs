import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion ship` applying the artifacts traceability service.
 *
 * `validateChangeTraceability` encodes invariants nothing else checks —
 * requirement-level `acceptance.oracleRefs`, malformed oracles no task
 * references, evidence linked to a known requirement and oracle — and it had no
 * production caller.
 *
 * It belongs here rather than in `legion validate`. It requires *accepted*
 * evidence with review provenance, and `legion validate` is the default task
 * verification command, so calling it there deadlocked the loop: build runs
 * validate, validate demands accepted evidence, evidence is accepted at review,
 * review needs a passing build. Ship is the first point where accepted evidence
 * is a reasonable thing to require, and it is the last point before archive
 * applies the same rules.
 */

const CREATED_AT = "2026-07-30T12:00:00.000Z";

const ANSWERS = {
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
  "risk-tier": "R0",
  "risk-reason": "A scratch fixture with no external effect.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** A project driven all the way to accepted review. */
async function acceptedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-ship-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  assert.equal(
    (await run("start", "--finalize", "--json", "--created-at", CREATED_AT)).exitCode,
    0
  );

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);

  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stderr);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  return { root, run, changeId };
}

test("a fully accepted change ships", async (t) => {
  const { run } = await acceptedProject(t);
  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 0, shipped.stdout + shipped.stderr);
  assert.equal(parseJsonOutput(shipped).status, "ready");
});

test("ship blocks evidence that references a requirement nobody defined", async (t) => {
  const { root, run, changeId } = await acceptedProject(t);

  // An invariant only the traceability service checks: it walks evidence trace
  // references and rejects any pointing at a requirement the change does not
  // define. `legion validate` reads tasks and never looks at evidence links.
  const indexPath = path.join(
    root,
    ".legion/project/changes",
    changeId,
    "evidence-index.json"
  );
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.entries[0].evidence.traceRefs.push({
    path: `.legion/project/changes/${changeId}/taskgraph.json`,
    anchor: index.entries[0].evidence.taskId,
    relation: "verifies",
    entity: { kind: "requirement", id: "req_nobody-defined-this" }
  });
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}
`, "utf8");

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "a dangling evidence reference must not ship");
  const payload = parseJsonOutput(shipped);
  assert.ok(
    payload.diagnostics.some((entry) => entry.code === "change_traceability_broken"),
    `expected change_traceability_broken, got ${JSON.stringify(payload.diagnostics)}`
  );
  assert.ok(
    payload.diagnostics.some((entry) => /req_nobody-defined-this/.test(entry.message)),
    "the dangling requirement should be named"
  );
});

test("ship blocks a change with a malformed oracle no task references", async (t) => {
  const { root, run, changeId } = await acceptedProject(t);

  // `deriveOracleManifest` parses every oracle in the directory, so an extra
  // malformed one breaks the change even though no task points at it. The
  // task-only checks in `legion validate` never read it.
  await writeFile(
    path.join(root, ".legion/project/changes", changeId, "oracle", "orc_stray-artifact.yaml"),
    "not an oracle\n",
    "utf8"
  );

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1, "a malformed oracle must not ship");
  // Naming the stray artifact, not merely counting diagnostics: "something
  // failed" keeps passing if ship later grows any other failure mode, and stops
  // guarding the path this test was written for.
  const diagnostics = parseJsonOutput(shipped).diagnostics;
  assert.ok(
    diagnostics.some(
      (entry) => /orc_stray-artifact/.test(entry.message) || /orc_stray-artifact/.test(entry.path ?? "")
    ),
    `the stray oracle should be named: ${JSON.stringify(diagnostics)}`
  );
});

test("a change built before evidence linking can still ship", async (t) => {
  const { root, run, changeId } = await acceptedProject(t);

  // Evidence written by an earlier release carried only a change reference,
  // because nothing wrote requirement or oracle links. Blocking on that would
  // tell a repository upgrading with an already-accepted change to run
  // `legion validate` — which cannot add the links — and force a rebuild and a
  // second review of work that was already approved.
  const indexPath = path.join(root, ".legion/project/changes", changeId, "evidence-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  // The service pools evidence-level and item-level references, so both are
  // reduced to the change-only shape the previous release produced.
  const changeOnly = (refs) => (refs ?? []).filter((ref) => ref.entity?.kind === "change");
  for (const entry of index.entries) {
    entry.evidence.traceRefs = changeOnly(entry.evidence.traceRefs);
    for (const item of entry.evidence.items ?? []) {
      item.traceRefs = changeOnly(item.traceRefs);
    }
  }
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}
`, "utf8");

  // Blocked by default. The same diagnostic is raised by current evidence that
  // has lost its links, and nothing in it distinguishes the two — so exempting
  // the code outright would discard the only signal that current evidence is
  // corrupt. The operator says which case this is.
  const blocked = await run("ship", "--json");
  assert.equal(blocked.exitCode, 1, "unlinked evidence must not be waved through by default");
  assert.match(
    parseJsonOutput(blocked).nextAction.command,
    /legion build/,
    "an evidence-linkage failure is repaired by rebuilding"
  );

  const shipped = await run("ship", "--allow-legacy-evidence", "--json");
  assert.equal(shipped.exitCode, 0, shipped.stdout + shipped.stderr);

  // Tolerated, not ignored: the gap is reported so it is visible and retires
  // itself when the task is rebuilt.
  const payload = parseJsonOutput(shipped);
  assert.ok(
    payload.warnings?.some((entry) => entry.code === "legacy_evidence_unlinked"),
    `the unlinked evidence should be reported: ${JSON.stringify(payload.warnings)}`
  );

  // Archive has to agree. Tolerating this in ship alone leaves an upgraded
  // repository between two gates that disagree about the same evidence: ready
  // here, refused there, with nothing the operator can do about it.
  // Archive applies the same exception through `isLegacyEvidenceDiagnostic`,
  // which both gates now share so they cannot diverge.
  //
  // That parity is deliberately not asserted end to end here. Archive checks
  // worktree cleanliness, acceptance and bundle validity before it reaches
  // traceability, so a fixture that gets that far needs more setup than this
  // suite builds — and two earlier versions of an assertion here passed for
  // those earlier failures rather than for the reason they named. A test that
  // cannot fail for the right reason is worse than a stated gap.
  const { isLegacyEvidenceDiagnostic } = await import("../packages/artifacts/dist/index.js");
  assert.equal(isLegacyEvidenceDiagnostic({ code: "orphan_evidence" }), true);
  assert.equal(isLegacyEvidenceDiagnostic({ code: "missing_requirement_oracle" }), false);
});

test("build still passes while a change is not yet accepted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-ship-loop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  await run("plan", "1", "--json");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);

  // The reason this check lives in ship and not validate. `legion validate` is
  // the default task verification command, so a traceability rule requiring
  // accepted evidence would make build fail its own verification, and evidence
  // is only accepted at review — which needs a passing build.
  const build = await run("build", "--executor", "fake", "--json");
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);
  assert.equal((await run("validate", "--json")).exitCode, 0);
});

test("a specification defect is not sent to legion build", async (t) => {
  const { root, run, changeId } = await acceptedProject(t);

  // `legion build` reruns task execution and rewrites evidence, so pointing
  // there for a malformed oracle sends the operator round a loop that returns
  // the same diagnostic.
  await writeFile(
    path.join(root, ".legion/project/changes", changeId, "oracle", "orc_stray-artifact.yaml"),
    "not an oracle\n",
    "utf8"
  );

  const shipped = await run("ship", "--json");
  assert.equal(shipped.exitCode, 1);

  // Asserting only that it is not `legion build` would shrug if the action
  // regressed to `legion validate` — the original defect that started this
  // thread. The command has to be the one that repairs a specification defect,
  // and it has to be runnable as printed.
  assert.equal(parseJsonOutput(shipped).nextAction.command, "legion plan 1");
});
