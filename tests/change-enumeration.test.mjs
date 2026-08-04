import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Enumerating changes and phases, and asking whether one named change is done.
 *
 * `findLatestWorkflowChangeId` built the whole list of valid changes and
 * returned only its last element, so nothing could reason across changes. A
 * first attempt at retro evidence counted raw directories instead — which counts
 * a docs folder with no change.yaml as a change.
 *
 * `resolveWorkflowState` answers only for the newest change, so nothing could
 * ask "is change X complete", which a scoped retrospective and a milestone gate
 * both need.
 */

const CREATED_AT = "2026-08-05T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Enumeration",
  "project-summary": "Reason across changes.",
  "project-owner": "dasbl",
  "problem-statement": "Nothing could list changes or ask whether one was done.",
  "problem-users": "Retrospectives and milestones.",
  "problem-success": "A named change can be asked whether it is complete.",
  "req-1-statement": "Changes can be enumerated and asked about",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "Listing returns only valid bundles",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/change-enumeration.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Cross-project enumeration",
  constraints: "One repository root",
  "risk-tier": "R0",
  "risk-reason": "Read-only enumeration.",
  "budget-files": "6",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

async function plannedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-enum-"));
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
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  return { root, run, planned: parseJsonOutput(planned) };
}

test("a directory without a change bundle is not counted as a change", async (t) => {
  const { root, run } = await plannedProject(t);
  const { mkdir } = await import("node:fs/promises");
  // A docs folder beside the real changes. The first retro evidence gatherer
  // counted directories and would have counted this.
  await mkdir(path.join(root, ".legion", "project", "changes", "NOT-A-CHANGE"), { recursive: true });
  await writeFile(path.join(root, ".legion", "project", "changes", "NOT-A-CHANGE", "notes.md"), "# notes\n");

  const status = await run("status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  // Status resolves the latest change; an invalid directory must not become it.
  assert.match(parseJsonOutput(status).workflowState.stage, /^(planned|build_ready|ship_ready|blocked)$/);
});

test("a planned but unbuilt change is not complete", async (t) => {
  const { root, run, planned } = await plannedProject(t);
  const { isChangeComplete } = await import("../packages/cli/dist/workflow/state.js");

  const result = await isChangeComplete({ repositoryRoot: root, changeId: planned.change.changeId });
  assert.equal(result.complete, false);
  // The reason names what is missing rather than reporting a bare false.
  assert.match(result.reason, /evidence/i);
});

test("listing returns valid bundles oldest first", async (t) => {
  const { root, planned } = await plannedProject(t);
  const { listWorkflowChanges } = await import("../packages/cli/dist/workflow/state.js");

  const listed = await listWorkflowChanges(root);
  assert.equal(listed.ok, true);
  assert.ok(listed.changes.some((entry) => entry.changeId === planned.change.changeId));
  for (const [index, entry] of listed.changes.entries()) {
    if (index === 0) continue;
    assert.ok(listed.changes[index - 1].createdAt <= entry.createdAt, "changes are ordered oldest first");
  }
});

test("phases are enumerated from the roadmap, not from its progress table", async (t) => {
  const { root } = await plannedProject(t);
  const { enumerateRoadmapPhases } = await import("../packages/cli/dist/workflow/phase-compat.js");

  const roadmap = await readFile(path.join(root, "ROADMAP.md"), "utf8");
  const phases = enumerateRoadmapPhases(roadmap, "ROADMAP.md");

  // The progress table is written once by --finalize and never updated, so
  // every row reads Pending forever. Enumeration reads the headings instead.
  assert.ok(phases.length >= 1, "at least the planned phase is found");
  assert.equal(phases[0].number, 1);
  assert.ok(phases[0].name.length > 0);
});

test("retro --phase selects that phase's change and refuses while it is incomplete", async (t) => {
  const { run, planned } = await plannedProject(t);
  // `legion plan 1` produced this change. The only phase-to-change link is the
  // derived `chg_phase-<N>-<slug>` ID, so the selector must find it by prefix.
  assert.match(planned.change.changeId, /^chg_phase-1-/);

  const scoped = await run("retro", "--phase", "1", "--executor", "fake", "--json");

  // Selection worked — the refusal is about completeness, not about a missing
  // change. Nothing here is accepted yet, and a retrospective runs on completed
  // work. Before this, `--phase` reached a prompt string and selected nothing.
  assert.notEqual(scoped.exitCode, 0);
  const text = `${scoped.stdout}${scoped.stderr}`;
  assert.match(text, /Phase 1 is not complete/);
  assert.doesNotMatch(text, /no change for that phase/);
});
