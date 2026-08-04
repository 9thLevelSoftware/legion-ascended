import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * The retrospective-to-plan loop.
 *
 * `legion retro` wrote findings into its own run directory and nothing read
 * them, so a retrospective changed nothing about the next phase. `learn
 * --recall` said so in its payload — `corpus: ["lessons"]` — and answered from
 * a corpus that excluded every lesson a retrospective drew.
 *
 * These pin the read ends. Writing the index without a reader would satisfy the
 * plan's wording and close nothing.
 */

const INDEX_PATH = [".legion", "project", "workflow", "retro", "retro-index.json"];

const ANSWERS = {
  "project-name": "Retro Loop",
  "project-summary": "Close the retrospective loop.",
  "project-owner": "dasbl",
  "problem-statement": "Retrospective findings were written and never read.",
  "problem-users": "Planning.",
  "problem-success": "Planning reports outstanding retrospective actions.",
  "req-1-statement": "Planning consumes retrospectives",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "plan reports outstanding actions",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/retro-loop.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Acting on the actions automatically",
  constraints: "One repository root",
  "risk-tier": "R0",
  "risk-reason": "Read-only reporting.",
  "budget-files": "6",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

async function repoWithRetroIndex(t, retrospectives, { project = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-retro-loop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.autocrlf", "false"]);
  if (project) {
    await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
    await runCliCapture(["--repository-root", root, "start", "--intake", "intake.json"]);
    await runCliCapture(["--repository-root", root, "start", "--finalize", "--json"]);
  }
  await mkdir(path.join(root, ...INDEX_PATH.slice(0, -1)), { recursive: true });
  await writeFile(
    path.join(root, ...INDEX_PATH),
    JSON.stringify({ schemaVersion: 1, kind: "retro_index", retrospectives }, undefined, 2),
    "utf8"
  );
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

const ENTRY = {
  id: "run_retro_1",
  createdAt: "2026-08-01T00:00:00.000Z",
  artifactPath: ".legion/project/workflow/retro/run_retro_1/retro.md",
  summary: "Tasks were sized past the file budget.",
  actions: [
    { id: "f1", title: "Split tasks that touch more than six files", body: "Three tasks overran.", severity: "major" },
    { id: "f2", title: "Typo in a comment", body: "Cosmetic.", severity: "minor" }
  ]
};

test("plan reports outstanding retrospective actions", async (t) => {
  const { run } = await repoWithRetroIndex(t, [ENTRY], { project: true });
  // A dry run reaches the report without needing a planned project: a preview is
  // exactly when a caller decides how to decompose, so it must show them too.
  const result = await run("plan", "1", "--dry-run", "--json");

  const payload = parseJsonOutput(result);
  assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
  assert.notEqual(payload.retrospectiveActions, undefined, "plan did not reach the retrospective read");
  const titles = payload.retrospectiveActions.map((action) => action.title);
  assert.ok(titles.includes("Split tasks that touch more than six files"));
  // Minor findings are excluded: an unranked list of twelve observations buries
  // the two that change the decomposition.
  assert.ok(!titles.includes("Typo in a comment"));
});

test("learn --recall searches retrospective findings, not only lessons", async (t) => {
  const { run } = await repoWithRetroIndex(t, [ENTRY]);
  const result = await run("learn", "--recall", "tasks", "--json");

  const payload = parseJsonOutput(result);
  assert.deepEqual(payload.corpus, ["lessons", "retrospectives"]);
  // No lesson was ever recorded here, so every match is a retrospective one.
  // Before this, recall answered zero and reported a corpus that excluded them.
  assert.ok(payload.matches.length > 0, "recall found nothing in the retrospective corpus");
  assert.equal(payload.matches[0].source, "retrospective");
  assert.equal(payload.matches[0].artifactPath, ENTRY.artifactPath);
});

test("a malformed retro index does not fail planning or recall", async (t) => {
  const { root, run } = await repoWithRetroIndex(t, []);

  // Matching readLessonIndex: planning must not fail because a retrospective
  // file was hand-edited. Reporting broader corruption is validate's job.
  // The second case is the one an envelope-only check let through: valid JSON
  // with the right two keys and a structurally empty entry. Both planning and
  // recall then dereferenced `entry.actions` and threw — the exact crash the
  // empty fallback promises not to be.
  for (const contents of ['{ not json', '{"kind":"retro_index","retrospectives":[{}]}', "[]", "null"]) {
    await writeFile(path.join(root, ...INDEX_PATH), contents, "utf8");
    const recall = await run("learn", "--recall", "tasks", "--json");
    assert.equal(recall.exitCode, 0, `${contents}: ${recall.stderr}`);
    assert.deepEqual(parseJsonOutput(recall).matches, []);
  }
});

test("a malformed entry is dropped without voiding the entries beside it", async (t) => {
  const { root, run } = await repoWithRetroIndex(t, []);
  await writeFile(
    path.join(root, ...INDEX_PATH),
    JSON.stringify({ schemaVersion: 1, kind: "retro_index", retrospectives: [{}, ENTRY, { actions: "no" }] }),
    "utf8"
  );

  // One hand-mangled entry should not erase every retrospective recorded
  // beside it, which is what voiding the whole file on any bad entry would do.
  const recall = await run("learn", "--recall", "tasks", "--json");
  assert.equal(recall.exitCode, 0, recall.stderr);
  assert.ok(recall.stdout.includes("Split tasks"), "the valid entry survived");
});

test("a blocked retrospective is not indexed", async (t) => {
  const { root, run } = await repoWithRetroIndex(t, [ENTRY]);
  // The manual adapter blocks with a `manual-execution-required` finding, and a
  // timed-out executor behaves the same way. Those are the adapter's findings,
  // not the retrospective's. Indexing them would have every later plan report an
  // adapter failure as planning guidance and recall return it as institutional
  // knowledge.
  const result = await run("retro", "--executor", "manual", "--json");
  assert.notEqual(result.exitCode, 0);

  const index = JSON.parse(await readFile(path.join(root, ...INDEX_PATH), "utf8"));
  assert.equal(index.retrospectives.length, 1, "a blocked run appended to the index");
  assert.equal(parseJsonOutput(result).retroIndexArtifactPath, undefined);
});

test("retro appends to the index it writes", async (t) => {
  const { root, run } = await repoWithRetroIndex(t, [ENTRY]);
  const result = await run("retro", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  const index = JSON.parse(await readFile(path.join(root, ...INDEX_PATH), "utf8"));
  // Appended, not replaced. An index that only ever holds the newest
  // retrospective loses the loop it exists to carry.
  assert.equal(index.retrospectives.length, 2);
  assert.equal(index.retrospectives[0].id, ENTRY.id);
  assert.equal(parseJsonOutput(result).retrospectiveCount, 2);
});
