import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Escalations, counted from committed records rather than operational state.
 *
 * `escalated` exists in this repository only inside `packages/board/**`, an
 * event-sourced projection no workflow command writes to. Emitting board events
 * from build and review would put the answer in `.legion/var/board.sqlite` —
 * which `.gitignore` excludes and `validateProject` actively requires be
 * excluded. A retrospective reading escalations from there reports zero on a
 * fresh checkout, on CI, and for anyone but the machine that ran the build.
 */

const CREATED_AT = "2026-08-05T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Escalations",
  "project-summary": "Count work that stopped.",
  "project-owner": "dasbl",
  "problem-statement": "Escalations lived only in operational state.",
  "problem-users": "Retrospectives.",
  "problem-success": "A clone can count them.",
  "req-1-statement": "Escalations are derived from committed records",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A blocked run counts as an escalation",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/escalations.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Replacing the operational board",
  constraints: "Must survive a clone",
  "risk-tier": "R0",
  "risk-reason": "Read-only derivation.",
  "budget-files": "6",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

async function builtProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-esc-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  const planned = parseJsonOutput(await run("plan", "1", "--json"));
  git(["add", "-A"]);
  git(["commit", "-m", "planned"]);
  // The scratch project's verification command fails, so the run blocks — which
  // is the escalation under test.
  await run("build", "--executor", "fake", "--allow-dirty", "--json");
  return { root, run, changeId: planned.change.changeId };
}

test("a blocked task run counts as an escalation, with its reason", async (t) => {
  const { root, changeId } = await builtProject(t);
  const { collectEscalations } = await import("../packages/cli/dist/workflow/escalations.js");

  const summary = await collectEscalations({ repositoryRoot: root, changeId });
  assert.ok(summary.total > 0, "a blocked run is an escalation");
  assert.ok(summary.byKind.task_blocked > 0);
  // The error code names what stopped it, which is what makes a count worth reading.
  assert.ok(summary.escalations[0].reason.length > 0);
});

test("escalations are readable from a clone, not only from the machine that built", async (t) => {
  const { root, changeId } = await builtProject(t);
  const { collectEscalations } = await import("../packages/cli/dist/workflow/escalations.js");

  // The operational store is gitignored, so anything recorded there is invisible
  // to a fresh checkout. Committed task runs are not.
  const clone = await mkdtemp(path.join(tmpdir(), "legion-esc-clone-"));
  t.after(() => rm(clone, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", root, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "built"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  execFileSync("git", ["clone", "--local", root, clone], { stdio: ["ignore", "pipe", "ignore"] });

  const fromClone = await collectEscalations({ repositoryRoot: clone, changeId });
  const fromOriginal = await collectEscalations({ repositoryRoot: root, changeId });
  assert.equal(fromClone.total, fromOriginal.total, "a clone counts the same escalations");
});

test("a retrospective is given the escalation count it reports", async (t) => {
  const { root, run } = await builtProject(t);
  const dry = await run("retro", "--dry-run", "--executor", "fake", "--json");
  assert.equal(dry.exitCode, 0, dry.stderr);

  const evidence = parseJsonOutput(dry).evidence;
  assert.equal(typeof evidence.escalations, "number");
  assert.ok(Array.isArray(evidence.escalationReasons));
  assert.match(evidence.summary, /escalation/);
});
