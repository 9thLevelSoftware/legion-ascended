import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * A completed milestone's summary was whatever the caller typed.
 *
 * That is not wrong — an operator's narrative is worth recording — but on its
 * own it is unverifiable, and nothing beside it said whether the work it
 * describes happened. Derived metrics are recorded next to it, never instead of
 * it: a reader has to be able to see that the operator said one thing and the
 * artifacts say another.
 *
 * The derivation is asserted at its seam because reaching `--complete` needs
 * every covered phase's evidence accepted, and acceptance cannot override the
 * harness observations a fake executor's build fails. That gate is correct.
 */

const ANSWERS = {
  "project-name": "Metrics",
  "project-summary": "Derive milestone metrics.",
  "project-owner": "dasbl",
  "problem-statement": "A milestone summary was unverifiable.",
  "problem-users": "Anyone reading a completed milestone.",
  "problem-success": "The claim and the evidence sit side by side.",
  "req-1-statement": "Milestone metrics are derived",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "Derived metrics accompany the operator summary",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/milestone-metrics.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Replacing the operator's text",
  constraints: "One repository root",
  "risk-tier": "R0",
  "risk-reason": "Read-only derivation.",
  "budget-files": "6",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

const MILESTONES = [".legion", "project", "workflow", "milestone", "milestones.json"];

async function plannedProject(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-metrics-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--intake", "intake.json");
  await run("start", "--finalize", "--json");
  await run("plan", "1", "--json");
  return { root, run };
}

test("derived metrics count the artifacts behind a milestone's phases", async (t) => {
  const { root } = await plannedProject(t);
  const { deriveMilestoneMetrics, milestonePhaseProgress } = await import(
    "../packages/cli/dist/commands/workflow/contextual.js"
  );

  const progress = await milestonePhaseProgress(root, { id: "m", name: "MVP", phases: "1-2", status: "defined", createdAt: "x" });
  assert.equal(progress.ok, true);
  const metrics = await deriveMilestoneMetrics(root, progress.phases, "2026-08-04T00:00:00.000Z");

  // Phase 1 was planned and phase 2 was not, so the counts must differ from the
  // range's width. A derivation that just echoed the range would be arithmetic,
  // not evidence.
  assert.equal(metrics.phases, 2);
  assert.equal(metrics.changes, 1);
  assert.equal(metrics.phasesComplete, 0);
  assert.ok(metrics.tasks > 0, "the planned phase's tasks were not counted");
  assert.equal(metrics.generatedAt, "2026-08-04T00:00:00.000Z");
});

test("a milestone whose range does not parse is never completed, so never derived", async (t) => {
  const { root, run } = await plannedProject(t);
  const { milestonePhaseProgress } = await import("../packages/cli/dist/commands/workflow/contextual.js");

  // Metrics take a resolved phase list, so "derives nothing" is enforced by the
  // caller rather than by a guard inside the derivation: `--complete` refuses an
  // unresolvable range before any metric is computed. Zeroes would read as
  // "nothing was done" rather than "this cannot be evaluated".
  const progress = await milestonePhaseProgress(root, { id: "m", name: "MVP", phases: "the MVP ones", status: "defined", createdAt: "x" });
  assert.equal(progress.ok, false);
  assert.match(progress.reason, /do not parse/);

  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-2")).exitCode, 0);
  const indexPath = path.join(root, ...MILESTONES);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  await writeFile(
    indexPath,
    JSON.stringify({ ...index, milestones: index.milestones.map((e) => ({ ...e, phases: "the MVP ones" })) }),
    "utf8"
  );
  const completed = await run("milestone", "--complete", "milestone-mvp", "--summary", "Done", "--json");
  assert.notEqual(completed.exitCode, 0);
  assert.match(parseJsonOutput(completed).diagnostics[0].message, /do not parse/);
});

test("the operator's summary and the derived metrics are rendered separately", async (t) => {
  const { root, run } = await plannedProject(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-2")).exitCode, 0);
  const indexPath = path.join(root, ...MILESTONES);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  // Written directly: reaching --complete needs accepted evidence a fake
  // executor's build cannot produce, and the render is what this pins.
  await writeFile(
    indexPath,
    JSON.stringify({
      ...index,
      milestones: index.milestones.map((entry) => ({
        ...entry,
        status: "completed",
        summary: "Shipped the whole thing.",
        derived: {
          phases: 2,
          phasesComplete: 1,
          changes: 1,
          tasks: 3,
          passingReviews: 0,
          firstPassReviews: { passed: 0, reviewed: 0 },
          generatedAt: "2026-08-04T00:00:00.000Z"
        }
      }))
    }),
    "utf8"
  );

  const status = await run("milestone", "--status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  const [milestone] = parseJsonOutput(status).milestones;

  // Both survive to the payload, under distinct keys. Folding them together
  // would destroy the comparison that makes the summary checkable.
  assert.equal(milestone.summary, "Shipped the whole thing.");
  assert.equal(milestone.derived.phasesComplete, 1);

  // And the human render labels the summary as the operator's, so a reader sees
  // the claim say "the whole thing" while the artifacts say 1 of 2. Read from
  // the non-JSON call, since --json suppresses the rendered text.
  const human = await run("milestone", "--status");
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /Summary \(as recorded by the operator\): Shipped the whole thing\./);
  assert.match(human.stdout, /Phases: 1 of 2 complete/);
});
