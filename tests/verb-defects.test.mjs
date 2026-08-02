import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Three defects the phase-16 capability inventory surfaced (P16-B012).
 *
 * All three share a shape: the verb accepted an input, reported success, and
 * did something other than what the caller asked for. None of them failed, so
 * none of them showed up as a bug — they showed up as an answer.
 *
 * Each test below fails against the behaviour that shipped before this change.
 */

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-defects-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "asset.ts"), "export function resolveAsset() {\n  return 1;\n}\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial"]);
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

/** Every workflow-run record currently on disk, across all workflows. */
async function guidanceRunCount(root) {
  const workflowRoot = path.join(root, ".legion", "project", "workflow");
  let total = 0;
  let workflows;
  try {
    workflows = await readdir(workflowRoot);
  } catch {
    return 0;
  }
  for (const workflow of workflows) {
    try {
      const runs = await readdir(path.join(workflowRoot, workflow));
      total += runs.filter((entry) => entry !== "milestones.json" && entry !== "knowledge-index.json").length;
    } catch {
      // Not a directory; nothing to count.
    }
  }
  return total;
}

test("legion map --query refuses --scope rather than silently ignoring it", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);

  const result = await run("map", "--query", "resolveAsset", "--scope", "src", "--json");

  // Previously this ran an unscoped query over the whole map and exited 0, so a
  // caller who asked about one path got an answer drawn from all of them and
  // had no way to tell.
  assert.notEqual(result.exitCode, 0, "a scoped query the CLI cannot honour must not report success");
  assert.match(`${result.stdout}${result.stderr}`, /--scope/);
});

test("legion map --query still works without --scope", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);

  const result = await run("map", "--query", "resolveAsset", "--json");
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = parseJsonOutput(result);
  assert.equal(payload.mode, "query");
});

test("legion milestone status writes nothing", async (t) => {
  const { root, run } = await scratchRepo(t);
  const defined = await run("milestone", "--define", "MVP", "--phases", "1-3", "--json");
  assert.equal(defined.exitCode, 0, defined.stderr);

  const before = await guidanceRunCount(root);
  const first = await run("milestone", "--status", "--json");
  assert.equal(first.exitCode, 0, first.stderr);
  const second = await run("milestone", "--json");
  assert.equal(second.exitCode, 0, second.stderr);

  // Two reads used to append two run records and rewrite both artifacts. A host
  // rendering status on every display would fill the history with entries
  // recording nothing but that someone looked.
  assert.equal(await guidanceRunCount(root), before, "reading milestone status must not append a run record");

  const payload = parseJsonOutput(first);
  assert.equal(payload.mode, "status");
  assert.equal(payload.milestones.length, 1);
  assert.equal(payload.milestones[0].name, "MVP");
  assert.equal(Object.hasOwn(payload, "indexArtifactPath"), false, "a read must not report writing an artifact");
});

test("legion milestone define, complete, and archive still record", async (t) => {
  const { root, run } = await scratchRepo(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-3")).exitCode, 0);
  const afterDefine = await guidanceRunCount(root);
  assert.ok(afterDefine > 0, "define must still write a run record");

  const completed = await run("milestone", "--complete", "milestone-mvp", "--summary", "done", "--json");
  assert.equal(completed.exitCode, 0, completed.stderr);
  assert.equal(parseJsonOutput(completed).status, "accepted");

  const archived = await run("milestone", "--archive", "milestone-mvp", "--json");
  assert.equal(archived.exitCode, 0, archived.stderr);
  assert.ok(await guidanceRunCount(root) > afterDefine, "mutations must still be recorded");

  const status = await run("milestone", "--status", "--json");
  assert.equal(parseJsonOutput(status).milestones[0].status, "archived", "status must read what the mutations wrote");
});

test("a scoped retro says plainly that no scoped evidence was gathered", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("retro", "--phase", "3", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  const payload = parseJsonOutput(result);
  const scope = payload.diagnostics.find((entry) => entry.id === "retro_scope_not_evidenced");

  // The flags reach the run slug, the run record, and the prompt topic. They
  // gather no phase evidence, so what comes back is an unscoped retrospective
  // wearing a scoped label — and previously nothing said so.
  assert.ok(scope, `expected a scope diagnostic, got ${JSON.stringify(payload.diagnostics)}`);
  assert.match(scope.body, /phase 3/);
  assert.match(scope.body, /unscoped/);

  const rendered = await run("retro", "--phase", "3", "--executor", "fake");
  assert.equal(rendered.exitCode, 0, rendered.stderr);
  assert.match(rendered.stdout, /WARNING: /, "the warning must reach the human rendering, not only --json");
});

test("an unscoped retro carries no scope warning", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("retro", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  const payload = parseJsonOutput(result);
  assert.equal(
    payload.diagnostics.some((entry) => entry.id === "retro_scope_not_evidenced"),
    false,
    "a retro that claimed no scope has no scope to warn about"
  );

  const rendered = await run("retro", "--executor", "fake");
  assert.doesNotMatch(rendered.stdout, /WARNING: /);
});
