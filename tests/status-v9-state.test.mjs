import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion status` over the artifacts phases C and D introduced.
 *
 * Status previously read `project.json`, the specs root and the changes root,
 * and nothing else — so an interview in progress, a written requirement set and
 * a drifted hash were all invisible to the one command whose job is to say where
 * the project stands. These cover the three it could not see.
 */

const CREATED_AT = "2026-08-01T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Status Surface",
  "project-summary": "Report the state the interview writes.",
  "project-owner": "dasbl",
  "problem-statement": "Status cannot see the artifacts the interview writes.",
  "problem-users": "Operators resuming after a context loss.",
  "problem-success": "Status names the interview and the requirement set.",
  "req-1-statement": "Status reports the requirement set and its hash",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A drifted requirement set is reported as drifted",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/status-v9-state.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Converting the other commands",
  constraints: "The stage machine is unchanged",
  "risk-tier": "R0",
  "risk-reason": "A read-only reporting surface.",
  "budget-files": "8",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-status-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

async function status(run) {
  const result = await run("status", "--json");
  assert.equal(result.exitCode, 0, result.stderr);
  return parseJsonOutput(result);
}

/** Answer up to `stopAfter` questions, or the whole interview when omitted. */
async function interview(run, stopAfter = Infinity) {
  let answered = 0;
  for (let guard = 0; guard < 200 && answered < stopAfter; guard += 1) {
    const next = await run("start", "--next", "--json", "--created-at", CREATED_AT);
    assert.equal(next.exitCode, 0, next.stderr);
    const payload = parseJsonOutput(next);
    if (payload.status === "complete") return answered;

    const nodeId = payload.question.nodeId;
    const value = ANSWERS[nodeId];
    if (value === undefined) {
      assert.equal(payload.question.required, false, `no scripted answer for required node ${nodeId}`);
      const skipped = await run("start", "--skip");
      assert.equal(skipped.exitCode, 0, `${nodeId}: ${skipped.stderr}`);
    } else {
      const recorded = await run("start", "--answer", `${nodeId}=${value}`);
      assert.equal(recorded.exitCode, 0, `${nodeId}: ${recorded.stderr}`);
    }
    answered += 1;
  }
  return answered;
}

test("a project with nothing on disk reports no interview and no requirements", async (t) => {
  const { run } = await scratchRepo(t);
  const payload = await status(run);

  assert.equal(payload.intake.status, "none");
  assert.equal(payload.requirements.status, "none");
  assert.equal(payload.traceability.status, "none");
  assert.equal(payload.nextAction.command, "legion start");
});

test("an interview in progress is named, with the question it is waiting on", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run, 3);

  const payload = await status(run);
  assert.equal(payload.intake.status, "active");
  assert.match(payload.intake.sessionId, /^itk_/);
  assert.equal(payload.intake.answered, 3);
  assert.equal(payload.intake.pendingNodeId, "problem-statement");

  // The verb is unchanged, but the reason must not tell someone three questions
  // into an interview that no project exists — that invites starting over.
  assert.equal(payload.nextAction.command, "legion start");
  assert.match(payload.nextAction.reason, /in progress/);
  assert.match(payload.nextAction.reason, /problem-statement/);
});

test("interview progress is reported as counts, never as a percentage", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run, 3);
  const early = await status(run);

  // The graph expands as answers arrive, so `applicable` is a floor and can rise
  // between two readings. Asserting it never shrinks is the honest invariant;
  // a percentage built on it would fall while the operator made progress.
  await interview(run, 6);
  const later = await status(run);

  assert.ok(later.intake.answered > early.intake.answered);
  assert.ok(later.intake.applicable >= early.intake.applicable);
  assert.equal(Object.hasOwn(later.intake, "percentComplete"), false);
});

test("an interview that has answered every question routes to finalize", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run);

  const payload = await status(run);
  assert.equal(payload.intake.status, "active");
  assert.equal(payload.intake.pendingNodeId, undefined);
  assert.equal(payload.nextAction.command, "legion start --finalize");
});

test("a finalized project reports its requirement count and a verified hash", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run);
  const finalized = await run("start", "--finalize");
  assert.equal(finalized.exitCode, 0, finalized.stderr);

  const payload = await status(run);
  assert.equal(payload.intake.status, "none", "a finalized session is no longer active");
  assert.equal(payload.requirements.status, "ready");
  assert.equal(payload.requirements.count, 1);
  assert.match(payload.requirements.setHash, /^sha256:/);

  // Written but not yet planned: the requirement exists and no task covers it.
  assert.equal(payload.traceability.status, "incomplete");
  assert.equal(payload.traceability.requirements, 1);
  assert.equal(payload.traceability.planned, 0);
  assert.equal(payload.traceability.unplanned.length, 1);
});

test("a requirement edited behind its hash is reported as drift and routes to validate", async (t) => {
  const { root, run } = await scratchRepo(t);
  await interview(run);
  assert.equal((await run("start", "--finalize")).exitCode, 0);

  const requirementsRoot = path.join(root, ".legion", "project", "requirements");
  const entries = await readdir(requirementsRoot);
  const target = entries.find((entry) => entry !== "index.json");
  assert.ok(target, "the finalized project wrote a requirement file");

  const requirementPath = path.join(requirementsRoot, target);
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.statement = `${requirement.statement} (edited behind the hash)`;
  await writeFile(requirementPath, JSON.stringify(requirement, null, 2));

  const payload = await status(run);
  assert.equal(payload.requirements.status, "drifted");
  assert.ok(payload.requirements.drift.length > 0);
  assert.ok(payload.requirements.drift.some((entry) => entry.code === "requirement_content_drift"));

  // Drift is a repair, and planning off a drifted set is exactly what the
  // recorded hash exists to prevent.
  assert.equal(payload.nextAction.command, "legion validate");
  assert.match(payload.nextAction.reason, /hash/);
});

test("drift outranks a resumable interview when both are present", async (t) => {
  const { root, run } = await scratchRepo(t);
  await interview(run);
  assert.equal((await run("start", "--finalize")).exitCode, 0);

  const requirementsRoot = path.join(root, ".legion", "project", "requirements");
  const entries = await readdir(requirementsRoot);
  const target = entries.find((entry) => entry !== "index.json");
  const requirementPath = path.join(requirementsRoot, target);
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.statement = `${requirement.statement} (edited)`;
  await writeFile(requirementPath, JSON.stringify(requirement, null, 2));

  // A second interview, open alongside the drifted set.
  await interview(run, 2);

  const payload = await status(run);
  assert.equal(payload.intake.status, "active", "the second interview is still reported");
  assert.equal(payload.nextAction.command, "legion validate", "repair outranks resuming");
});

test("an unreadable intake session is reported rather than skipped", async (t) => {
  const { root, run } = await scratchRepo(t);
  await interview(run, 2);

  const sessions = await readdir(path.join(root, ".legion", "project", "intake"));
  const sessionId = sessions.find((entry) => entry.startsWith("itk_"));
  assert.ok(sessionId, "the interview wrote a session directory");
  await writeFile(
    path.join(root, ".legion", "project", "intake", sessionId, "session.json"),
    "{ not json"
  );

  const payload = await status(run);
  assert.equal(payload.intake.status, "unreadable");
  assert.equal(payload.nextAction.command, "legion start --session-status");
});

test("the human rendering names every v9 section", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run);
  assert.equal((await run("start", "--finalize")).exitCode, 0);

  const result = await run("status");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^Intake: /m);
  assert.match(result.stdout, /^Requirements: 1, hash verified$/m);
  assert.match(result.stdout, /^Traceability: 0 of 1 requirements planned$/m);
});
