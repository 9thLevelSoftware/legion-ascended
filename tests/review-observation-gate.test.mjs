import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

const EVIDENCE_PATH = ".legion/project/changes/chg_phase-1-foundation/evidence-index.json";

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** Drive start -> plan -> build -> review so an evidence index exists. */
async function reviewedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-review-gate-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);

  await run("start", "--name", "Review Gate", "--summary", "Observation gate", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Do the thing\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  await run("plan", "1", "--from-roadmap", "ROADMAP.md");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  await run("build", "--executor", "fake");
  await run("review", "--executor", "fake");

  return { root, run };
}

async function readEvidence(root) {
  return JSON.parse(await readFile(path.join(root, ...EVIDENCE_PATH.split("/")), "utf8"));
}

async function writeEvidence(root, document) {
  await writeFile(path.join(root, ...EVIDENCE_PATH.split("/")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

test("a clean run can be accepted", async (t) => {
  const { root, run } = await reviewedProject(t);

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.equal(parseJsonOutput(accepted).status, "accepted");

  const evidence = await readEvidence(root);
  const ids = evidence.entries[0].evidence.items.map((item) => item.id);
  // The observations the gate depends on are actually present.
  assert.ok(ids.includes("declared-verification"));
  assert.ok(ids.includes("diff-reconciliation"));
});

test("acceptance refuses a failed harness observation", async (t) => {
  const { root, run } = await reviewedProject(t);

  // Flip the recorded verification observation to a failure, leaving the
  // bundle otherwise acceptable. A human must not be able to accept past this.
  const evidence = await readEvidence(root);
  evidence.entries[0].evidence.items = evidence.entries[0].evidence.items.map((item) =>
    item.id === "declared-verification" ? { ...item, verdict: "fail" } : item
  );
  await writeEvidence(root, evidence);

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 1);
  const payload = parseJsonOutput(accepted);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.diagnostics[0].code, "unresolved_failed_observation");
  assert.match(payload.diagnostics[0].message, /cannot override a harness observation/);
});

test("acceptance refuses a failed observation even when the bundle is not collected", async (t) => {
  const { root, run } = await reviewedProject(t);

  // This is the mixed-index hole: coverage checking skips non-collected
  // bundles, so a failure recorded on one would otherwise vanish by omission.
  const evidence = await readEvidence(root);
  evidence.entries[0].evidence.status = "failed";
  evidence.entries[0].evidence.items = evidence.entries[0].evidence.items.map((item) =>
    item.id === "diff-reconciliation" ? { ...item, verdict: "fail" } : item
  );
  await writeEvidence(root, evidence);

  const accepted = await run("review", "--accept", "--json");
  assert.equal(accepted.exitCode, 1);
  assert.equal(parseJsonOutput(accepted).diagnostics[0].code, "unresolved_failed_observation");
});
