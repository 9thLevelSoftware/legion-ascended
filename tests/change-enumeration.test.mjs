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

test("retro --phase validates the whole value, not a parseInt prefix", async (t) => {
  const { run } = await plannedProject(t);
  // `Number.parseInt` returns 1 for all of these, which would resolve phase 1's
  // change while the prompt and the saved run kept the caller's label — a
  // retrospective labelled for a scope it did not resolve.
  for (const value of ["1.5", "1foo", "1e2", "01"]) {
    const result = await run("retro", "--phase", value, "--executor", "fake", "--json");
    assert.notEqual(result.exitCode, 0, `--phase ${value} was accepted`);
    assert.match(`${result.stdout}${result.stderr}`, /positive integer/);
  }
});

test("first-pass review rate counts reviews whose supersedes array is empty", async (t) => {
  const { root, run, planned } = await plannedProject(t);
  const { mkdir } = await import("node:fs/promises");
  const changeId = planned.change.changeId;
  const reviewsDir = path.join(root, ".legion", "project", "changes", changeId, "reviews");
  await mkdir(reviewsDir, { recursive: true });
  // `status` reports the project id, so the fixture does not depend on any
  // artifact's on-disk shape.
  const projectId = parseJsonOutput(await run("status", "--json")).workflowState.projectId;
  assert.ok(projectId, "status did not report a project id");
  // A first review: `supersedes` is a required array and is `[]` here, never
  // absent. A presence test therefore matches nothing, so any project with
  // reviews reported "no task reviewed yet" and the metric read zero forever.
  await writeFile(
    path.join(reviewsDir, "rev_first.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "review",
      id: "rev_first",
      projectId,
      changeId,
      reviewer: { kind: "human", id: "dasbl" },
      status: "accepted",
      verdicts: { specification: "pass", integration: "pass", evidence: "pass" },
      confidence: "high",
      findings: [],
      supersedes: [],
      submittedAt: CREATED_AT,
      createdAt: CREATED_AT
    }),
    "utf8"
  );

  const result = await run("retro", "--executor", "fake", "--json");
  assert.equal(result.exitCode, 0, result.stderr);
  // The prompt artifact the executor was handed, which is where the metric has
  // to appear: a number rendered only into the markdown afterwards never
  // reached the reasoning it was gathered for. The run record names it.
  const runRecord = JSON.parse(
    await readFile(path.join(root, parseJsonOutput(result).artifactPath), "utf8")
  );
  const prompt = await readFile(path.join(root, runRecord.outputs.promptArtifactPath), "utf8");
  assert.match(prompt, /First-pass review rate: 1 of 1/);
});

test("a scoped retrospective excludes project-wide stage and recent runs", async (t) => {
  const { root, run, planned } = await plannedProject(t);
  const { gatherRetroEvidence, renderRetroEvidence } = await import(
    "../packages/cli/dist/commands/workflow/contextual.js"
  );
  const { resolveWorkflowState } = await import("../packages/cli/dist/workflow/state.js");
  await run("build", "--executor", "fake", "--allow-dirty", "--json");

  // Gathered at the seam rather than through a scoped run: reaching one needs a
  // change whose evidence is accepted, and acceptance cannot override the
  // harness observations a fake executor's build fails. That gate is correct, so
  // the exclusion is pinned where it is decided.
  const state = await resolveWorkflowState({ repositoryRoot: root, args: { options: new Map(), positionals: [] } });
  const runs = [{ workflow: "build", runId: "run_x", status: "completed" }];

  const unscoped = await gatherRetroEvidence(root, state, runs);
  assert.equal(unscoped.stage, state.stage);
  assert.deepEqual(unscoped.recentRuns, ["build/run_x: completed"]);

  const scoped = await gatherRetroEvidence(root, state, runs, {
    label: `phase 1`,
    changeIds: [planned.change.changeId]
  });
  // A phase completed before later ones would otherwise be reflected on against
  // the project's *current* stage and whatever ran most recently — the
  // mislabelled-scope defect this selector exists to prevent. A guidance run
  // records no change, so there is nothing to filter on: scoped mode omits them.
  assert.equal(scoped.stage, undefined);
  assert.deepEqual(scoped.recentRuns, []);
  assert.equal(scoped.scopeLabel, "phase 1");
  assert.equal(scoped.changeCount, 1, "the scope narrowed to its one change");

  const rendered = renderRetroEvidence(scoped);
  assert.doesNotMatch(rendered, /Workflow stage:/);
  assert.doesNotMatch(rendered, /Recent workflow runs/);
  assert.match(rendered, /Evidence from phase 1 alone/);
});

test("milestone status reports progress in its JSON payload", async (t) => {
  const { run } = await plannedProject(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-2")).exitCode, 0);

  const status = await run("milestone", "--status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  const [milestone] = parseJsonOutput(status).milestones;

  // Computed only for the human string, a percentage is unreachable to every
  // JSON client — and the host is told to render status from `--json`.
  assert.equal(milestone.progress.status, "resolved");
  assert.equal(milestone.progress.total, 2);
  assert.equal(milestone.progress.complete, 0);
  // Phase 1 was planned here and phase 2 was not, so the two rows must differ.
  const [first, second] = milestone.progress.phases;
  assert.match(first.changeId, /^chg_phase-1-/);
  assert.equal(second.changeId, null);
  assert.equal(second.reason, "not planned");
});

test("a milestone whose range does not parse is unresolvable, not zero percent", async (t) => {
  const { root, run } = await plannedProject(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-2")).exitCode, 0);
  const indexPath = path.join(root, ".legion", "project", "workflow", "milestone", "milestones.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  // What a milestone defined before the parser existed holds.
  await writeFile(
    indexPath,
    JSON.stringify({ ...index, milestones: index.milestones.map((e) => ({ ...e, phases: "the MVP ones" })) }),
    "utf8"
  );

  const status = await run("milestone", "--status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  // A milestone nobody can evaluate is a different thing from one with nothing
  // done. Reporting it as 0% would be a wrong number where the caller needs a
  // repairable finding.
  const { progress } = parseJsonOutput(status).milestones[0];
  assert.equal(progress.status, "unresolvable");
  assert.match(progress.reason, /do not parse/);
});

test("changes that exist but none of them valid is not reported as unplanned phases", async (t) => {
  const { root, run, planned } = await plannedProject(t);
  assert.equal((await run("milestone", "--define", "MVP", "--phases", "1-2")).exitCode, 0);
  // `listWorkflowChanges` reports `ok: false` when change directories exist and
  // none holds a valid bundle. Corrupting the only real change reaches that
  // state; adding a bad directory beside a good one does not, because one valid
  // bundle is enough.
  await writeFile(path.join(root, planned.change.artifactPath), "not: [valid", "utf8");

  const status = await run("milestone", "--status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  const { progress } = parseJsonOutput(status).milestones[0];
  // Swallowing the discovery failure would report every covered phase as
  // `not planned` and 0% complete, hiding a real fault behind a plausible
  // answer in the one place a caller would act on it.
  assert.equal(progress.status, "unresolvable");
  assert.match(progress.reason, /could not be read/);
});

test("build can be scoped to a change rather than always the newest", async (t) => {
  const { root, planned } = await plannedProject(t);
  const { handleBuildWorkflow } = await import("../packages/cli/dist/commands/workflow/build.js");

  // `legion review --phase N --auto` fixes the selected phase and then rebuilds.
  // Without this seam the rebuild resolved the newest change, so the fix cycle
  // would execute an unrelated task graph and modify its files, then re-read the
  // selected phase's stale evidence.
  const context = {
    repositoryRoot: root,
    args: {
      positionals: ["build"],
      options: new Map([
        ["executor", "fake"],
        ["allow-dirty", true]
      ]),
      invalidOptions: []
    }
  };
  const result = await handleBuildWorkflow(context, planned.change.changeId);
  assert.equal(result.payload.changeId, planned.change.changeId);
});

test("retro evidence caps review findings and says how many it dropped", async (t) => {
  const { root, run, planned } = await plannedProject(t);
  const { gatherRetroEvidence, renderRetroEvidence } = await import(
    "../packages/cli/dist/commands/workflow/contextual.js"
  );
  const { resolveWorkflowState } = await import("../packages/cli/dist/workflow/state.js");
  const { mkdir } = await import("node:fs/promises");

  const changeId = planned.change.changeId;
  const reviewsDir = path.join(root, ".legion", "project", "changes", changeId, "reviews");
  await mkdir(reviewsDir, { recursive: true });
  const projectId = parseJsonOutput(await run("status", "--json")).workflowState.projectId;
  // Twenty findings: one blocking, the rest minor. An unbounded list would bury
  // the one that matters, and a cap that dropped by discovery order would keep
  // whichever happened to be written first.
  const findings = [
    // `major`, not `blocking`: a blocking finding is schema-required to carry
    // evidenceRefs, and referencing evidence this fixture never produced makes
    // the whole review unreadable. The ranking assertion works the same.
    { id: "f-major", title: "Contract broken", body: "The serious one.", severity: "major" },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `f-minor-${index}`,
      title: `Nitpick ${index}`,
      body: "Cosmetic.",
      severity: "minor"
    }))
  ];
  await writeFile(
    path.join(reviewsDir, "rev_many.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "review",
      id: "rev_many",
      projectId,
      changeId,
      reviewer: { kind: "worker", id: "task-reviewer" },
      status: "accepted",
      verdicts: { specification: "pass", integration: "pass", evidence: "pass" },
      confidence: "high",
      findings,
      supersedes: [],
      submittedAt: CREATED_AT,
      createdAt: CREATED_AT
    }),
    "utf8"
  );

  const state = await resolveWorkflowState({ repositoryRoot: root, args: { options: new Map(), positionals: [] } });
  const evidence = await gatherRetroEvidence(root, state, []);

  assert.equal(evidence.retroFindingBodies.length, 12, "the cap was not applied");
  assert.equal(evidence.findingsOmitted, 8);
  // Ranked first. A cap is only defensible if what survives it is the part
  // worth reading; dropping by discovery order would keep whichever findings
  // happened to be written first.
  assert.match(evidence.retroFindingBodies[0], /\[major\] Contract broken/);
  // Ranked across every change, not within each one. Capping inside the
  // per-change loop let the oldest change fill all twelve slots with minor
  // findings while a later change's serious one was dropped — and changes are
  // gathered oldest-first, so that is the common case, not the unlucky one.
  assert.ok(
    evidence.retroFindingBodies.every((body) => !body.startsWith("[minor]")) ||
      evidence.retroFindingBodies.some((body) => body.startsWith("[major]")),
    "a serious finding was displaced by minor ones"
  );

  // And the omission is stated. A silent truncation reads as complete coverage,
  // which is worse than no list at all.
  assert.match(renderRetroEvidence(evidence), /showing 12, 8 omitted/);
});
