import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
 * Each defect test below fails against the behaviour that shipped before this
 * change; the control tests alongside them pass against both.
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

test("legion map --why refuses write and ambiguous combinations", async (t) => {
  const { run } = await scratchRepo(t);
  const combinations = [
    ["--refresh"],
    ["--check"],
    ["--query", "resolveAsset"],
    ["--scope", "src"]
  ];
  for (const extra of combinations) {
    const result = await run("map", "--why", "sym_ffffffffffffffffffffffff", ...extra, "--json");
    assert.notEqual(result.exitCode, 0, `--why ${extra.join(" ")} must be rejected`);
    assert.match(`${result.stdout}${result.stderr}`, /--why|one mode|--scope/);
  }

  const ambiguous = await run("map", "--query", "resolveAsset", "--profile", "inventory", "--json");
  assert.notEqual(ambiguous.exitCode, 0);
  assert.match(`${ambiguous.stdout}${ambiguous.stderr}`, /profile|inventory/);
});

test("structural map read modes preserve run count and inventory query uses lexical fallback", async (t) => {
  const { root, run } = await scratchRepo(t);
  const structural = await run("map", "--refresh", "--profile", "structural", "--json");
  assert.equal(structural.exitCode, 0, structural.stderr);
  const structuralPayload = parseJsonOutput(structural);
  const structuralQuery = await run("map", "--query", "resolveAsset", "--profile", "structural", "--json");
  assert.equal(structuralQuery.exitCode, 0, structuralQuery.stderr);
  const factId = parseJsonOutput(structuralQuery).matches[0].id;
  const before = await guidanceRunCount(root);
  assert.equal((await run("map", "--check", "--profile", "structural", "--json")).exitCode, 0);
  assert.equal((await run("map", "--query", "resolveAsset", "--profile", "structural", "--json")).exitCode, 0);
  assert.equal((await run("map", "--why", factId, "--json")).exitCode, 0);
  assert.equal(await guidanceRunCount(root), before, "structural read modes must not append runs");

  const inventoryRepo = await scratchRepo(t);
  const inventory = await inventoryRepo.run("map", "--refresh", "--profile", "inventory", "--json");
  assert.equal(inventory.exitCode, 0, inventory.stderr);
  const inventoryQuery = await inventoryRepo.run("map", "--query", "resolveAsset", "--json");
  assert.equal(inventoryQuery.exitCode, 0, inventoryQuery.stderr);
  const inventoryPayload = parseJsonOutput(inventoryQuery);
  assert.equal(inventoryPayload.matches[0].path, "src/asset.ts");
  assert.equal(Object.hasOwn(inventoryPayload, "snapshotId"), false);
  assert.equal(Object.hasOwn(inventoryPayload, "indexProfile"), false);
  assert.equal(structuralPayload.indexProfile, "structural");
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

  // `--complete` now gates on the phases the milestone covers. Phases 1-3 were
  // never planned here, so it refuses and names them — the command's stated
  // "no partial completions" invariant, which previously only checked that the
  // id existed.
  const completed = await run("milestone", "--complete", "milestone-mvp", "--summary", "done", "--json");
  assert.notEqual(completed.exitCode, 0);
  assert.match(parseJsonOutput(completed).diagnostics[0].message, /incomplete phase\(s\).*not planned/s);

  const archived = await run("milestone", "--archive", "milestone-mvp", "--json");
  assert.equal(archived.exitCode, 0, archived.stderr);
  assert.ok(await guidanceRunCount(root) > afterDefine, "mutations must still be recorded");

  const status = await run("milestone", "--status", "--json");
  assert.equal(parseJsonOutput(status).milestones[0].status, "archived", "status must read what the mutations wrote");
});

test("legion retro --phase refuses a phase that was never planned", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("retro", "--phase", "7", "--executor", "fake", "--json");

  // Resolved to a change now rather than pasted into a prompt topic. The only
  // phase-to-change link is the derived `chg_phase-<N>-` ID, because no phase
  // field exists on a change.
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}${result.stderr}`, /no change for that phase|legion plan 7/);
});

test("legion retro --milestone resolves through the phase range, then gates", async (t) => {
  const { run } = await scratchRepo(t);
  const missing = await run("retro", "--milestone", "MVP", "--executor", "fake", "--json");
  assert.notEqual(missing.exitCode, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /found no such milestone/);

  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-3")).exitCode, 0);
  const result = await run("retro", "--milestone", "MVP", "--executor", "fake", "--json");

  // Resolved now: the milestone is found, its range parses to phases 1-3, and
  // each is looked up. The refusal is about those phases being incomplete, not
  // about there being no milestone-to-phase path — which is what it was before
  // the range parser existed.
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}${result.stderr}`, /incomplete phase\(s\)/);
});

test("an unscoped retro still runs", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("retro", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  // The refusal is scoped to the scope flags. An unscoped retrospective claims
  // nothing it cannot deliver, so it still runs and still writes its artifact.
  const payload = parseJsonOutput(result);
  assert.equal(payload.workflow, "retro");
  assert.ok(payload.markdownArtifactPath, "an unscoped retro still writes its artifact");
});

test("a bare legion map summarizes and writes nothing", async (t) => {
  const { root, run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);
  const before = await guidanceRunCount(root);

  // A bare `legion map` walked the repository and overwrote the artifact set
  // with no prompt. The destructive path now has to be asked for by name.
  const result = await run("map", "--json");
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = parseJsonOutput(result);
  assert.equal(payload.mode, "summary");
  assert.equal(payload.status, "fresh");
  assert.equal(await guidanceRunCount(root), before, "a summary must not record a run");
});

test("legion map --check and --query leave no run records", async (t) => {
  const { root, run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);
  const afterRefresh = await guidanceRunCount(root);

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await run("map", "--check", "--json")).exitCode, 0);
    assert.equal((await run("map", "--query", "resolveAsset", "--json")).exitCode, 0);
  }

  // getLatestCodebaseMap finds the map by scanning the newest twenty map runs,
  // so recording reads evicted the refresh that produced it and the CLI then
  // reported no map existed. Reads destroyed the ability to find what they read.
  assert.equal(await guidanceRunCount(root), afterRefresh, "reads must not record runs");
  assert.equal(parseJsonOutput(await run("map", "--check", "--json")).status, "fresh");
});

test("legion map distinguishes absent from stale", async (t) => {
  const { root, run } = await scratchRepo(t);

  // A project that never ran map reported the same status as one whose
  // fingerprint had moved, because freshness was a single boolean.
  assert.equal(parseJsonOutput(await run("map", "--check", "--json")).status, "absent");

  assert.equal((await run("map", "--refresh")).exitCode, 0);
  assert.equal(parseJsonOutput(await run("map", "--check", "--json")).status, "fresh");

  await writeFile(path.join(root, "src", "added.ts"), "export const added = 2;\n");
  assert.equal(parseJsonOutput(await run("map", "--check", "--json")).status, "stale");
});

test("a map older than the age limit is stale even when nothing changed", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh", "--created-at", "2026-01-01T00:00:00.000Z")).exitCode, 0);

  const same = await run("map", "--check", "--created-at", "2026-01-10T00:00:00.000Z", "--json");
  assert.equal(parseJsonOutput(same).status, "fresh", "unchanged and recent");

  // The fingerprint still matches; the schema and the reader have moved on.
  const later = await run("map", "--check", "--created-at", "2026-03-01T00:00:00.000Z", "--json");
  assert.equal(parseJsonOutput(later).status, "stale");
  assert.match(parseJsonOutput(later).nextAction.reason, /30-day/);
});

test("refreshing a tree with no source files refuses instead of mapping nothing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-empty-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: ["ignore", "pipe", "ignore"] });

  // Previously this wrote all five artifacts over an empty file set, fingerprinted
  // the empty string, and reported "refreshed for 0 source files" as a success —
  // a map of nothing that every later read would trust.
  const result = await runCliCapture(["--repository-root", root, "map", "--refresh", "--json"]);
  assert.notEqual(result.exitCode, 0);
  const payload = parseJsonOutput(result);
  assert.equal(payload.status, "absent");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "map_no_source"));
  assert.equal(await guidanceRunCount(root), 0, "a refusal must not leave a run directory behind");
});

test("legion status and legion map agree about the same map", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);

  // status had its own comparison — fingerprint only — so once map gained the
  // age limit and the scope check the two commands disagreed about one map, and
  // a user reading both was told to refresh and told not to bother.
  const checked = parseJsonOutput(await run("map", "--check", "--json")).status;
  const reported = parseJsonOutput(await run("status", "--json")).map.status;
  assert.equal(reported, checked);
  assert.equal(reported, "fresh");
});

test("legion retro --dry-run reports the evidence and writes nothing", async (t) => {
  const { root, run } = await scratchRepo(t);
  const result = await run("retro", "--dry-run", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  // Only the verb can suppress the verb's writes: retro.md and the run record
  // both landed before the handler returned, so a host-side flag could suppress
  // rendering but not persistence — the opposite of what the flag promises.
  const payload = parseJsonOutput(result);
  assert.equal(payload.dryRun, true);
  assert.ok(payload.evidence.summary.length > 0);
  assert.equal(await guidanceRunCount(root), 0, "a dry run must write nothing");
});

test("a retrospective is given the evidence it is drawn from", async (t) => {
  const { root, run } = await scratchRepo(t);
  const result = await run("retro", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  // The stage and recent runs were read before the run and handed to the
  // renderer afterwards, so the model producing the findings had seen none of
  // it. The prompt artifact is the check that it now does.
  const runs = await readdir(path.join(root, ".legion", "project", "workflow", "retro"));
  const promptPath = path.join(root, ".legion", "project", "workflow", "retro", runs[0], "executor-prompt.md");
  const prompt = await readFile(promptPath, "utf8").catch(() => "");
  assert.match(prompt, /Evidence from the project's committed artifacts/);
  assert.match(prompt, /Workflow stage:/);
});

test("completing a milestone twice is refused", async (t) => {
  const { root, run } = await scratchRepo(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-3")).exitCode, 0);
  // Recorded as already completed directly. Reaching this state through the CLI
  // now needs every covered phase complete, and a fake executor's build fails
  // the harness observations acceptance cannot override — so the first
  // completion is unreachable in a fixture. The invariant under test is the
  // second one, which must refuse before the phase gate is consulted.
  const indexPath = path.join(root, ".legion", "project", "workflow", "milestone", "milestones.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  await writeFile(
    indexPath,
    JSON.stringify({
      ...index,
      milestones: index.milestones.map((entry) => ({ ...entry, status: "completed", summary: "done" }))
    }),
    "utf8"
  );

  // The only check was that the id existed, so a second completion silently
  // overwrote the recorded summary of the first.
  const again = await run("milestone", "--complete", "milestone-mvp", "--summary", "different", "--json");
  assert.notEqual(again.exitCode, 0);
  assert.match(parseJsonOutput(again).diagnostics[0].message, /already completed/);

  const status = await run("milestone", "--status", "--json");
  assert.equal(parseJsonOutput(status).milestones[0].summary, "done", "the first summary must survive");
});

test("an unreadable requirement set is never reported as traceable, from any entrance", async (t) => {
  const { root, run } = await scratchRepo(t);
  await mkdir(path.join(root, ".legion", "project", "requirements"), { recursive: true });
  await writeFile(path.join(root, ".legion", "project", "requirements", "index.json"), "{ not json");

  // The guard existed in resolveTraceabilityStatus and only there, so status
  // refused while validate and doctor reported "0 of 0 planned" over the same
  // broken set. It lives in checkTraceability now, where the rule is.
  for (const command of ["validate", "doctor"]) {
    const result = await run(command, "--json");
    const payload = parseJsonOutput(result);
    assert.ok(
      payload.diagnostics.some((entry) => entry.code === "requirement_set_unreadable"),
      `${command} must report the unreadable set, got ${JSON.stringify(payload.diagnostics)}`
    );
  }
});

test("a query with no searchable terms is refused, not answered", async (t) => {
  const { run } = await scratchRepo(t);
  assert.equal((await run("map", "--refresh")).exitCode, 0);

  // An empty query was refused and `!!` was not, though neither searches for
  // anything. Zero results reads as "nothing matches", not "nothing was asked".
  const result = await run("map", "--query", "!!", "--json");
  assert.notEqual(result.exitCode, 0);
  assert.match(parseJsonOutput(result).diagnostics[0].message, /no searchable terms/);

  const real = await run("map", "--query", "resolveAsset", "--json");
  assert.equal(real.exitCode, 0, "a real query still works");
});
