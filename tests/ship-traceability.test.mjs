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
  assert.ok(parseJsonOutput(shipped).diagnostics.length > 0);
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
