import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * The interview driven through the actual command surface.
 *
 * The unit tests cover the graph as data; these cover the part that only exists
 * across process boundaries — that state survives on disk, that the batch and
 * interactive entrances produce the same contract, and that finalizing refuses
 * rather than improvising when something is missing.
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
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "pnpm test --filter resolver",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Automatic renaming",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "Every downstream consumer is affected.",
  "budget-files": "12",
  "budget-lines": "600",
  "budget-new-files": "4",
  "pref-verification": "pnpm test"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-intake-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

/** Drive the interview one `--answer` per invocation, as a host would. */
async function interview(run, answers = ANSWERS) {
  const asked = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const next = await run("start", "--next", "--json", "--created-at", CREATED_AT);
    assert.equal(next.exitCode, 0, next.stderr);
    const payload = parseJsonOutput(next);
    if (payload.status === "complete") return asked;

    const nodeId = payload.question.nodeId;
    asked.push(nodeId);
    const value = answers[nodeId];

    // An unscripted optional node is declined, which is the only way the
    // `--skip` path gets exercised end to end.
    if (value === undefined) {
      assert.equal(
        payload.question.required,
        false,
        `no scripted answer for required node ${nodeId}`
      );
      const skipped = await run("start", "--skip");
      assert.equal(skipped.exitCode, 0, `${nodeId}: ${skipped.stderr}`);
      continue;
    }

    const recorded = await run("start", "--answer", `${nodeId}=${value}`);
    assert.equal(recorded.exitCode, 0, `${nodeId}: ${recorded.stderr}`);
  }
  throw new Error("the interview did not terminate");
}

test("an interrupted interview resumes from disk, not from memory", async (t) => {
  const { root, run } = await scratchRepo(t);

  const first = await run("start", "--next", "--json", "--created-at", CREATED_AT);
  const sessionId = parseJsonOutput(first).session.id;
  await run("start", "--answer", "project-name=Asset Mapper");
  await run("start", "--answer", "project-summary=Deterministic asset resolution.");

  // Every invocation above was a separate process. Nothing carried over except
  // the file, which is the whole point.
  const resumed = await run("start", "--next", "--json");
  const payload = parseJsonOutput(resumed);
  assert.equal(payload.session.id, sessionId, "the active session should be resumed, not replaced");
  assert.equal(payload.question.nodeId, "project-owner");
  assert.equal(payload.session.answered, 2);

  const session = JSON.parse(
    await readFile(path.join(root, ".legion/project/intake", sessionId, "session.json"), "utf8")
  );
  assert.equal(session.cursor, "project-owner");
  assert.equal(session.answers.length, 2);
  assert.equal(session.status, "active");
});

test("the batch and interactive entrances produce identical requirements", async (t) => {
  const interactive = await scratchRepo(t);
  const batch = await scratchRepo(t);

  await interview(interactive.run);
  const interactiveFinalize = await interactive.run(
    "start", "--finalize", "--json", "--created-at", CREATED_AT
  );
  assert.equal(interactiveFinalize.exitCode, 0, interactiveFinalize.stderr);

  await writeFile(path.join(batch.root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  const applied = await batch.run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  assert.equal(applied.exitCode, 0, applied.stderr);
  const batchFinalize = await batch.run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(batchFinalize.exitCode, 0, batchFinalize.stderr);

  const left = parseJsonOutput(interactiveFinalize).requirementSet;
  const right = parseJsonOutput(batchFinalize).requirementSet;
  // A CI entrance that produced a different contract from the interactive one
  // would be a way around the interview rather than an alternative to it.
  assert.equal(left.requirementSetHash, right.requirementSetHash);
  assert.deepEqual(left.paths, right.paths);

  for (const relative of left.paths) {
    assert.equal(
      await readFile(path.join(interactive.root, ...relative.split("/")), "utf8"),
      await readFile(path.join(batch.root, ...relative.split("/")), "utf8"),
      `${relative} should be byte-identical across entrances`
    );
  }
});

test("finalizing an unfinished interview refuses and names what is open", async (t) => {
  const { run } = await scratchRepo(t);
  await run("start", "--next", "--json", "--created-at", CREATED_AT);
  await run("start", "--answer", "project-name=Asset Mapper");

  const finalize = await run("start", "--finalize", "--json");
  assert.equal(finalize.exitCode, 1);
  const payload = parseJsonOutput(finalize);
  assert.equal(payload.status, "incomplete");
  assert.equal(payload.question.nodeId, "project-summary");
});

test("a batch file missing an answer stops at the gap instead of skipping it", async (t) => {
  const { root, run } = await scratchRepo(t);
  const incomplete = { ...ANSWERS };
  delete incomplete["risk-reason"];
  await writeFile(path.join(root, "intake.json"), JSON.stringify(incomplete), "utf8");

  const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
  assert.equal(applied.exitCode, 1);
  const payload = parseJsonOutput(applied);
  assert.equal(payload.status, "incomplete");
  assert.ok(
    payload.diagnostics.some((entry) => entry.nodeId === "risk-reason"),
    `expected the gap to be named, got ${JSON.stringify(payload.diagnostics)}`
  );
  // Everything before the gap was still applied, so a corrected file resumes
  // rather than starting over.
  assert.ok(payload.applied.length > 10);
});

test("an invalid answer is rejected without advancing the cursor", async (t) => {
  const { run } = await scratchRepo(t);
  await interview(run, { ...ANSWERS });

  const before = parseJsonOutput(await run("start", "--session-status", "--json"));
  const rejected = await run("start", "--answer", "budget-files=twelve", "--json");
  assert.equal(rejected.exitCode, 1);
  assert.equal(parseJsonOutput(rejected).status, "rejected");

  const after = parseJsonOutput(await run("start", "--session-status", "--json"));
  assert.equal(after.session.answered, before.session.answered);
});

test("--back undoes the most recent answer", async (t) => {
  const { run } = await scratchRepo(t);
  await run("start", "--next", "--json", "--created-at", CREATED_AT);
  await run("start", "--answer", "project-name=Asset Mapper");
  await run("start", "--answer", "project-summary=Deterministic asset resolution.");

  const back = await run("start", "--back", "--json");
  assert.equal(back.exitCode, 0, back.stderr);
  const payload = parseJsonOutput(back);
  assert.equal(payload.undone, "project-summary");
  assert.equal(payload.question.nodeId, "project-summary");
  assert.equal(payload.session.answered, 1);
});

test("an aborted session is not silently resumed", async (t) => {
  const { run } = await scratchRepo(t);
  const first = await run("start", "--next", "--json", "--created-at", CREATED_AT);
  const firstId = parseJsonOutput(first).session.id;

  const aborted = await run("start", "--abort", "--json");
  assert.equal(aborted.exitCode, 0, aborted.stderr);
  assert.equal(parseJsonOutput(aborted).status, "aborted");

  const answer = await run("start", "--answer", "project-name=Asset Mapper", "--json");
  assert.equal(answer.exitCode, 1, "an aborted session must not accept answers");

  // A new session starts clean rather than inheriting the abandoned one.
  const fresh = await run("start", "--next", "--json", "--created-at", "2026-07-30T13:00:00.000Z");
  assert.notEqual(parseJsonOutput(fresh).session.id, firstId);
  assert.equal(parseJsonOutput(fresh).question.nodeId, "project-name");
});

test("a hand-written ROADMAP.md is not overwritten", async (t) => {
  const { root, run } = await scratchRepo(t);
  const roadmapPath = path.join(root, "ROADMAP.md");
  const handWritten = "# My Roadmap\n\nWritten by a person.\n";
  await writeFile(roadmapPath, handWritten, "utf8");

  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);

  assert.equal(finalize.exitCode, 0, finalize.stderr);
  const payload = parseJsonOutput(finalize);
  assert.equal(payload.roadmap.written, false);
  assert.equal(await readFile(roadmapPath, "utf8"), handWritten);
  assert.ok(
    payload.warnings.some((entry) => /--force-roadmap/.test(entry.message)),
    "refusing to overwrite must say how to override it"
  );

  // Re-finalizing with the override replaces it, and the replacement is a
  // roadmap this command would recognise as its own next time.
  const forced = await run(
    "start", "--finalize", "--session", payload.session.id, "--force-roadmap", "--json", "--created-at", CREATED_AT
  );
  assert.equal(forced.exitCode, 1, "a finalized session must not finalize twice");
});

test("a finalized project can be planned against", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);

  // The roadmap is a rendered view, so the phase parser that predates the
  // interview has to keep working against it unchanged.
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  const validated = await run("validate", "--json");
  assert.equal(validated.exitCode, 0, validated.stderr);
});

test("direct initialization still works and says what it skipped", async (t) => {
  const { run } = await scratchRepo(t);
  const initialized = await run(
    "start", "--name", "Asset Mapper", "--summary", "Deterministic resolution.", "--owner", "dasbl", "--json"
  );

  assert.equal(initialized.exitCode, 0, initialized.stderr);
  const payload = parseJsonOutput(initialized);
  assert.equal(payload.status, "initialized");
  assert.equal(payload.intake.status, "skipped");
  assert.ok(
    payload.warnings.some((entry) => entry.code === "intake_skipped"),
    "skipping the interview should be visible, not silent"
  );
});
