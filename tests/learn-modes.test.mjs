import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion learn`'s record, recall, and list modes.
 *
 * The verb implemented one of the command's four modes, and implemented it
 * without the type system the other three are built on: records carried
 * `{id, lesson, createdAt, artifactPath}` and nothing else, so pattern, pitfall
 * and preference did not exist in the CLI's data model. Recall scores a tag
 * match 3 and a summary match 2, which is unimplementable over records that
 * store neither.
 */

async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-learn-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: ["ignore", "pipe", "ignore"] });
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

test("a recorded lesson keeps its kind, tags, and summary", async (t) => {
  const { run } = await scratchRepo(t);
  const recorded = await run(
    "learn", "prefer artifact-backed plans",
    "--type", "pattern", "--tags", "planning,evidence", "--summary", "Plans cite artifacts", "--json"
  );
  assert.equal(recorded.exitCode, 0, recorded.stderr);
  assert.equal(parseJsonOutput(recorded).kind, "pattern");

  const listed = parseJsonOutput(await run("learn", "--list", "--json"));
  assert.equal(listed.total, 1);
  assert.equal(listed.byKind.pattern, 1);
  assert.deepEqual(listed.lessons[0].tags, ["planning", "evidence"]);
  assert.equal(listed.lessons[0].summary, "Plans cite artifacts");
});

test("recall scores a tag match above a body match", async (t) => {
  const { run } = await scratchRepo(t);
  await run("learn", "tagged lesson", "--type", "pattern", "--tags", "evidence", "--json");
  await run("learn", "a lesson mentioning evidence in its body only", "--type", "pitfall", "--json");

  const recalled = parseJsonOutput(await run("learn", "--recall", "evidence", "--json"));
  assert.equal(recalled.matches.length, 2);
  // Tag 3, summary 2, body 1 — the command's rule, and the reason tags had to
  // persist rather than living in the host.
  assert.equal(recalled.matches[0].kind, "pattern");
  assert.ok(recalled.matches[0].score > recalled.matches[1].score);
});

test("recall reports which corpus it searched", async (t) => {
  const { run } = await scratchRepo(t);
  await run("learn", "something", "--json");
  const recalled = parseJsonOutput(await run("learn", "--recall", "something", "--json"));

  // Both corpora, since the retro index gave retrospective findings a read
  // surface. This was `["lessons"]` while those findings lived only in
  // run-scoped retro.md artifacts nothing read. Naming the corpus keeps a
  // future narrowing visible instead of letting recall quietly answer from
  // less than the caller assumes.
  assert.deepEqual(recalled.corpus, ["lessons", "retrospectives"]);
});

test("an unclassified lesson is still recorded and still counted", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("learn", "no type given", "--json")).exitCode, 0);

  const listed = parseJsonOutput(await run("learn", "--list", "--json"));
  assert.equal(listed.total, 1);
  assert.equal(listed.unclassified, 1);
  assert.equal(listed.lessons[0].kind, null);
});

test("an unknown lesson type is refused rather than stored", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("learn", "x", "--type", "nonsense", "--json");
  assert.notEqual(result.exitCode, 0);
  assert.match(parseJsonOutput(result).diagnostics[0].message, /pattern, pitfall, preference/);

  assert.equal(parseJsonOutput(await run("learn", "--list", "--json")).total, 0, "a refused record must not be stored");
});

test("recall and list read without recording a run", async (t) => {
  const { run } = await scratchRepo(t);
  await run("learn", "a lesson", "--json");
  const before = parseJsonOutput(await run("learn", "--list", "--json")).total;

  await run("learn", "--recall", "lesson", "--json");
  await run("learn", "--list", "--json");

  assert.equal(parseJsonOutput(await run("learn", "--list", "--json")).total, before, "reads must not add records");
});

test("recall keeps technical and non-ASCII topics searchable", async (t) => {
  const { run } = await scratchRepo(t);
  await run("learn", "prefer C++ move semantics", "--type", "pattern", "--tags", "c++", "--json");
  await run("learn", "日本語のレッスン", "--type", "pitfall", "--json");

  // An ASCII-only split erased `C++`, `C#`, `R`, and every non-Latin word, so
  // recall reported zero matches for a topic present verbatim in the lesson.
  const plus = parseJsonOutput(await run("learn", "--recall", "C++", "--json"));
  assert.ok(plus.matches.length > 0, "C++ must be searchable");

  const japanese = parseJsonOutput(await run("learn", "--recall", "日本語", "--json"));
  assert.ok(japanese.matches.length > 0, "a non-ASCII topic must be searchable");
});

test("list renders the entries it counts", async (t) => {
  const { run } = await scratchRepo(t);
  await run("learn", "a recorded lesson", "--type", "pattern", "--tags", "alpha", "--summary", "Alpha summary", "--json");

  // Counts alone made --list a tally of a thing it would not show.
  const rendered = await run("learn", "--list");
  assert.equal(rendered.exitCode, 0, rendered.stderr);
  assert.match(rendered.stdout, /Alpha summary/);
  assert.match(rendered.stdout, /alpha/);
});
