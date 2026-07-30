import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

/** A second exploration run, used to push a pinned one past the discovery cap. */
async function seedNamedExplorationRun(root, runId) {
  const artifactDir = path.join(root, ".legion/project/workflow/explore", runId);
  await mkdir(artifactDir, { recursive: true });
  const explorationPath = `.legion/project/workflow/explore/${runId}/exploration.json`;
  await writeFile(
    path.join(artifactDir, "exploration.json"),
    JSON.stringify({
      schemaVersion: "0.2.0",
      createdAt: `2026-08-${String((Number(runId.slice(-2)) % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      kind: "exploration",
      runId: `run_${runId}`,
      status: "exploratory",
      entry: "raw-idea",
      topic: runId,
      summary: "A later brainstorm.",
      proposals: [],
      openQuestions: [],
      notes: []
    }),
    "utf8"
  );
  await writeFile(
    path.join(artifactDir, "workflow-run.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "workflow_run",
      workflow: "explore",
      runId,
      createdAt: `2026-08-${String((Number(runId.slice(-2)) % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      status: "completed",
      input: { topic: runId },
      outputs: { explorationArtifactPath: explorationPath },
      nextAction: { command: "legion start", reason: "seed intake" },
      diagnostics: []
    }),
    "utf8"
  );
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

  // The advice has to be followable. Finalizing already closed the session, so
  // refusing the retry would make the warning tell the operator to run a command
  // that cannot work.
  const advice = payload.warnings.find((entry) => /--force-roadmap/.test(entry.message)).message;
  const flags = /Replace it with: legion start (.+)$/.exec(advice)[1].trim().split(" ");
  const forced = await run("start", ...flags, "--json", "--created-at", CREATED_AT);

  assert.equal(forced.exitCode, 0, forced.stderr);
  const forcedPayload = parseJsonOutput(forced);
  assert.equal(forcedPayload.roadmap.written, true);

  const replaced = await readFile(roadmapPath, "utf8");
  assert.notEqual(replaced, handWritten);
  assert.match(replaced, /^## Phase 1: /m);

  // Re-finalizing is a re-render, not a second decision: the requirement set is
  // byte-identical, so a retry cannot quietly change the contract.
  assert.equal(forcedPayload.requirementSet.requirementSetHash, payload.requirementSet.requirementSetHash);
});

test("a re-finalized session rewrites identical requirements", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);

  const first = parseJsonOutput(await run("start", "--finalize", "--json", "--created-at", CREATED_AT));
  const requirementPath = path.join(root, ...first.requirementSet.paths[0].split("/"));
  const before = await readFile(requirementPath, "utf8");

  // No --created-at this time. The artifacts must still be identical, because
  // finalize timestamps from the session rather than from the clock — otherwise
  // every retry would produce a new hash and drift detection would fire on the
  // command that is supposed to establish the baseline.
  const again = await run("start", "--finalize", "--session", first.session.id, "--json");
  assert.equal(again.exitCode, 0, again.stderr);
  const second = parseJsonOutput(again);

  assert.equal(second.requirementSet.requirementSetHash, first.requirementSet.requirementSetHash);
  assert.equal(await readFile(requirementPath, "utf8"), before);
  assert.ok(
    second.warnings.some((entry) => /already finalized/.test(entry.message)),
    "a re-finalize should say it was one"
  );
});

test("an exploration edited mid-interview has its proposals withheld", async (t) => {
  const { root, run } = await scratchRepo(t);

  // Stand up a guidance run the way `legion explore` does, then seed from it.
  const runId = "explore-1";
  const artifactDir = path.join(root, ".legion/project/workflow/explore", runId);
  await mkdir(artifactDir, { recursive: true });
  const explorationPath = `.legion/project/workflow/explore/${runId}/exploration.json`;
  const exploration = {
    schemaVersion: "0.2.0",
    createdAt: CREATED_AT,
    kind: "exploration",
    runId: "run_explore-1",
    status: "exploratory",
    entry: "raw-idea",
    topic: "asset mapping",
    summary: "An idea about resolving assets.",
    proposals: [
      {
        slot: "project.name",
        value: "Asset Mapper",
        rationale: "The topic named it.",
        anchor: "framing",
        confidence: "inferred"
      }
    ],
    openQuestions: [],
    notes: []
  };
  await writeFile(path.join(artifactDir, "exploration.json"), JSON.stringify(exploration), "utf8");
  await writeFile(
    path.join(artifactDir, "workflow-run.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "workflow_run",
      workflow: "explore",
      runId,
      createdAt: CREATED_AT,
      status: "completed",
      input: { topic: "asset mapping" },
      outputs: { explorationArtifactPath: explorationPath },
      nextAction: { command: "legion start", reason: "seed intake" },
      diagnostics: []
    }),
    "utf8"
  );

  const seeded = await run(
    "start", "--from-exploration", "run_explore-1", "--json", "--created-at", CREATED_AT
  );
  assert.equal(seeded.exitCode, 0, seeded.stderr);
  assert.equal(
    parseJsonOutput(seeded).question.proposal?.value,
    "Asset Mapper",
    "a matching artifact should offer its proposal"
  );

  // Edit the exploration after seeding. The session records the hash it was
  // seeded from; accepting a proposal now would attest to bytes that no longer
  // exist.
  await writeFile(
    path.join(artifactDir, "exploration.json"),
    JSON.stringify({
      ...exploration,
      proposals: [{ ...exploration.proposals[0], value: "Something Else Entirely" }]
    }),
    "utf8"
  );

  const after = await run("start", "--next", "--json");
  assert.equal(after.exitCode, 0, after.stderr);
  const payload = parseJsonOutput(after);
  assert.equal(payload.question.proposal, undefined, "a changed exploration must not still propose");
  assert.ok(
    payload.warnings.some((entry) => /has changed since this session was seeded/.test(entry.message)),
    `the withholding must be explained, got ${JSON.stringify(payload.warnings)}`
  );

  // The question is still asked, so withholding costs a suggestion rather than
  // an answer.
  const answered = await run("start", "--answer", "project-name=Asset Mapper");
  assert.equal(answered.exitCode, 0, answered.stderr);

  const accepted = await run("start", "--accept-proposal", "--json");
  assert.equal(accepted.exitCode, 1, "no proposal is available to accept");
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

/** Stand up a guidance run the way `legion explore` does. */
async function seedExplorationRun(root) {
  const runId = "explore-1";
  const artifactDir = path.join(root, ".legion/project/workflow/explore", runId);
  await mkdir(artifactDir, { recursive: true });
  const explorationPath = `.legion/project/workflow/explore/${runId}/exploration.json`;
  const exploration = {
    schemaVersion: "0.2.0",
    createdAt: CREATED_AT,
    kind: "exploration",
    runId: "run_explore-1",
    status: "exploratory",
    entry: "raw-idea",
    topic: "asset mapping",
    summary: "An idea about resolving assets.",
    proposals: [
      {
        slot: "project.name",
        value: "Asset Mapper",
        rationale: "The topic named it.",
        anchor: "framing",
        confidence: "inferred"
      }
    ],
    openQuestions: [
      { nodeId: "which-runtime", slot: "open.runtime", question: "Which runtime?", why: "unsettled" }
    ],
    notes: []
  };
  await writeFile(path.join(artifactDir, "exploration.json"), JSON.stringify(exploration), "utf8");
  await writeFile(
    path.join(artifactDir, "workflow-run.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "workflow_run",
      workflow: "explore",
      runId,
      createdAt: CREATED_AT,
      status: "completed",
      input: { topic: "asset mapping" },
      outputs: { explorationArtifactPath: explorationPath },
      nextAction: { command: "legion start", reason: "seed intake" },
      diagnostics: []
    }),
    "utf8"
  );
  return { runId, artifactDir, exploration };
}

test("--from-exploration is honoured when the printed advice is followed", async (t) => {
  const { root, run } = await scratchRepo(t);
  await seedExplorationRun(root);

  // The no-argument start creates an unseeded session and prints
  // "--from-exploration <runId>". Resuming that session before reading the
  // option meant following the printed advice silently discarded the
  // exploration — every proposal and every open question with it.
  const first = await run("start", "--next", "--json", "--created-at", CREATED_AT);
  const firstPayload = parseJsonOutput(first);
  assert.equal(firstPayload.session.injectedNodes, 0);
  assert.ok(
    firstPayload.availableExplorations.some((entry) => entry.runId === "explore-1"),
    "the exploration should be offered"
  );

  const seeded = await run(
    "start", "--from-exploration", "explore-1", "--json", "--created-at", "2026-07-30T13:00:00.000Z"
  );
  assert.equal(seeded.exitCode, 0, seeded.stderr);
  const seededPayload = parseJsonOutput(seeded);
  assert.notEqual(seededPayload.session.id, firstPayload.session.id);
  assert.equal(seededPayload.session.explorationRunId, "run_explore-1");
  assert.equal(seededPayload.session.injectedNodes, 1);
  assert.equal(seededPayload.question.proposal?.value, "Asset Mapper");
});

test("--from-exploration refuses to discard an interview in progress", async (t) => {
  const { root, run } = await scratchRepo(t);
  await seedExplorationRun(root);

  await run("start", "--next", "--json", "--created-at", CREATED_AT);
  await run("start", "--answer", "project-name=Asset Mapper");

  // Silently replacing a session with answers would lose work; silently
  // resuming would ignore the option. Refusing says which is happening.
  const seeded = await run("start", "--from-exploration", "explore-1", "--json");
  assert.equal(seeded.exitCode, 1);
  assert.match(parseJsonOutput(seeded).diagnostics[0].message, /--abort/);
});

test("two sessions sharing a --created-at do not overwrite each other", async (t) => {
  const { root, run } = await scratchRepo(t);

  const first = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));
  await run("start", "--answer", "project-name=First Project");
  await run("start", "--abort");

  // The ID derives from the timestamp, so the same --created-at would produce
  // the same ID and saveSession would replace the earlier record — erasing a
  // durable decision record that requirement trace references point at.
  const second = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));
  assert.notEqual(second.session.id, first.session.id);

  const earlier = JSON.parse(
    await readFile(path.join(root, ".legion/project/intake", first.session.id, "session.json"), "utf8")
  );
  assert.equal(earlier.status, "aborted");
  assert.equal(earlier.answers[0].value, "First Project", "the first session's answers must survive");
});

test("a corrupt session stops the command instead of being stepped over", async (t) => {
  const { root, run } = await scratchRepo(t);
  const started = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));

  await writeFile(
    path.join(root, ".legion/project/intake", started.session.id, "session.json"),
    "{ not json",
    "utf8"
  );

  // Skipping it would resume an older interview or open a new one while the
  // record of the interview in progress sat corrupt, and the operator would be
  // answering a different session without being told.
  const next = await run("start", "--next", "--json");
  assert.equal(next.exitCode, 1);
  const payload = parseJsonOutput(next);
  assert.equal(payload.status, "invalid_session");
  assert.match(payload.diagnostics[0].message, new RegExp(started.session.id));
});

test("finalize refuses when the interview disagrees with an initialized project", async (t) => {
  const { root, run } = await scratchRepo(t);

  // Direct initialization first, then an interview naming a different project.
  // initProject returns already_initialized and applies none of the interview's
  // identity, so reporting success would leave project.json — which downstream
  // context and escalation read — disagreeing with what was just agreed.
  await run("start", "--name", "Original Name", "--owner", "someone-else");
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);

  const finalize = await run("start", "--finalize", "--json");
  assert.equal(finalize.exitCode, 1);
  const payload = parseJsonOutput(finalize);
  assert.equal(payload.status, "identity_conflict");
  assert.ok(
    payload.diagnostics.some((entry) => /Original Name/.test(entry.message)),
    `the conflict should name both values, got ${JSON.stringify(payload.diagnostics)}`
  );
});

test("re-finalizing is byte-identical even when the first run set --created-at", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);

  // The first finalize passes --created-at; the documented forced-roadmap retry
  // does not. Honouring the flag here would rewrite every requirement timestamp
  // on the retry and change the hash, during what the command calls an
  // identical re-render.
  const first = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", "2026-01-01T00:00:00.000Z")
  );
  const requirementPath = path.join(root, ...first.requirementSet.paths[0].split("/"));
  const before = await readFile(requirementPath, "utf8");

  const second = parseJsonOutput(
    await run("start", "--finalize", "--session", first.session.id, "--json")
  );
  assert.equal(second.requirementSet.requirementSetHash, first.requirementSet.requirementSetHash);
  assert.equal(await readFile(requirementPath, "utf8"), before);
});

test("a symlinked requirements directory is refused, not written through", async (t) => {
  const { root, run } = await scratchRepo(t);
  const outside = await mkdtemp(path.join(tmpdir(), "legion-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  // A bystander file that the cleanup pass would delete: it matches `req_*.json`
  // but belongs to whoever owns the directory the link points at.
  const bystander = path.join(outside, "req_someone-elses.json");
  await writeFile(bystander, "{}\n", "utf8");

  await mkdir(path.join(root, ".legion/project"), { recursive: true });
  try {
    await symlink(outside, path.join(root, ".legion/project/requirements"), "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("symlink creation is not permitted here");
    throw error;
  }

  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);

  // Writing by hand-joined path would have followed the link, scattering
  // predictably-named requirement files outside the repository and deleting the
  // bystander on the way past.
  assert.equal(finalize.exitCode, 1, "finalizing through a symlinked control directory must be refused");
  assert.equal(await readFile(bystander, "utf8"), "{}\n", "an unrelated file must not be touched");
});

test("a requirements path that is not a directory is refused", async (t) => {
  const { root, run } = await scratchRepo(t);

  // The symlink case above is the dangerous one, but it cannot run where
  // symlink creation needs elevation. A plain file exercises the same guard —
  // that the requirements root is resolved and checked rather than assumed —
  // on every platform.
  await mkdir(path.join(root, ".legion/project"), { recursive: true });
  await writeFile(path.join(root, ".legion/project/requirements"), "not a directory\n", "utf8");

  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);

  assert.equal(finalize.exitCode, 1);
  assert.equal(
    await readFile(path.join(root, ".legion/project/requirements"), "utf8"),
    "not a directory\n",
    "the blocking file must be left as it was"
  );
});

test("a symlinked ROADMAP.md is refused, not written through", async (t) => {
  const { root, run } = await scratchRepo(t);
  const outside = await mkdtemp(path.join(tmpdir(), "legion-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  // A dangling link is the sharper case: `access` reports the path absent, so
  // the write would create the target outside the repository rather than
  // refusing.
  const target = path.join(outside, "someone-elses-notes.md");
  try {
    await symlink(target, path.join(root, "ROADMAP.md"));
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("symlink creation is not permitted here");
    throw error;
  }

  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);

  assert.equal(finalize.exitCode, 0, finalize.stderr);
  const payload = parseJsonOutput(finalize);
  assert.equal(payload.roadmap.written, false);
  assert.ok(
    payload.warnings.some((entry) => /symbolic link/i.test(entry.message)),
    `the refusal must be explained, got ${JSON.stringify(payload.warnings)}`
  );
  assert.equal(existsSync(target), false, "the link target must not have been created");
});

test("finalizing under a different intake graph is refused", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
  const sessionId = parseJsonOutput(applied).session.id;

  // Finalize was made re-runnable on a finalized session, and the version check
  // exempted every non-active session — so a re-finalize after a graph upgrade
  // would reinterpret the answers and overwrite the artifacts under a graph that
  // never collected them. Reading history stays exempt; producing artifacts does
  // not.
  const sessionPath = path.join(root, ".legion/project/intake", sessionId, "session.json");
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  await writeFile(
    sessionPath,
    JSON.stringify({ ...session, graphVersion: "0.9.0" }, undefined, 2),
    "utf8"
  );

  const finalize = await run("start", "--finalize", "--session", sessionId, "--json");
  assert.equal(finalize.exitCode, 1);
  assert.match(parseJsonOutput(finalize).diagnostics[0].message, /0\.9\.0/);
});

test("a malformed requirement file reports drift instead of throwing", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  await writeFile(requirementPath, "{ not json", "utf8");

  // An unguarded JSON.parse rejected out of verifyRequirementSet rather than
  // returning the advertised invalid result — so the one condition drift
  // detection exists to name was the one that crashed it.
  const validated = await run("validate", "--json");
  assert.notEqual(validated.exitCode, 2, "a parse error must not escape as an unhandled rejection");
  assert.doesNotMatch(validated.stderr, /Unexpected token|SyntaxError/);
});

/**
 * Regressions for the review round that found the requirement-set hash was
 * written and never read.
 *
 * The test that was supposed to cover drift asserted only that `legion validate`
 * did not crash, which was trivially true while nothing consumed the hash. These
 * assert the diagnostic itself, so they fail if the wiring is removed again.
 */

async function finalizedProject(t) {
  const scratch = await scratchRepo(t);
  await writeFile(path.join(scratch.root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await scratch.run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await scratch.run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);
  return { ...scratch, finalize: parseJsonOutput(finalize) };
}

test("legion validate reports an edited requirement as drift", async (t) => {
  const { root, run, finalize } = await finalizedProject(t);

  const clean = await run("validate", "--json");
  assert.equal(clean.exitCode, 0, "a freshly finalized set must validate");

  // A semantically valid edit, not a corruption: the file still parses and still
  // satisfies the schema. Only the recorded hash can tell that the contract
  // moved, which is the whole reason it is recorded.
  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.statement = "Something nobody agreed to";
  await writeFile(requirementPath, `${JSON.stringify(requirement, undefined, 2)}\n`, "utf8");

  const drifted = await run("validate", "--json");
  assert.equal(drifted.exitCode, 1, "an edited requirement must fail validation");
  const codes = parseJsonOutput(drifted).diagnostics.map((entry) => entry.code);
  assert.ok(
    codes.includes("requirement_content_drift"),
    `expected requirement_content_drift, got ${codes.join(", ")}`
  );
});

test("legion validate reports a removed requirement as drift", async (t) => {
  const { root, run, finalize } = await finalizedProject(t);

  // Deleting a file the index still names is invisible to any per-file hash;
  // only the set-level check sees it.
  await rm(path.join(root, ...finalize.requirementSet.paths[0].split("/")), { force: true });

  const drifted = await run("validate", "--json");
  assert.equal(drifted.exitCode, 1);
  assert.ok(
    parseJsonOutput(drifted).diagnostics.some((entry) => /requirement/.test(entry.code)),
    "a missing requirement must be reported"
  );
});

test("a failed --from-exploration leaves no session directory behind", async (t) => {
  const { root, run } = await scratchRepo(t);

  // The ID is reserved by creating its directory. Claiming it before the
  // exploration was validated left an `itk_*` directory with no session.json,
  // which `findActiveSession` then read as a corrupt record and refused — so one
  // typo permanently bricked every later `legion start` in that repository.
  const failed = await run("start", "--from-exploration", "does-not-exist", "--json");
  assert.equal(failed.exitCode, 1);

  assert.equal(
    existsSync(path.join(root, ".legion/project/intake")),
    false,
    "a rejected exploration must not leave a reserved session directory"
  );

  const recovered = await run("start", "--next", "--json", "--created-at", CREATED_AT);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.equal(parseJsonOutput(recovered).question.nodeId, "project-name");
});

test("a stale graph version does not deadlock recovery", async (t) => {
  const { root, run } = await scratchRepo(t);
  const started = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));
  const sessionPath = path.join(root, ".legion/project/intake", started.session.id, "session.json");
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  await writeFile(sessionPath, JSON.stringify({ ...session, graphVersion: "0.9.0" }), "utf8");

  // Advancing the interview is refused, as intended.
  const advance = await run("start", "--answer", "project-name=Asset Mapper", "--json");
  assert.equal(advance.exitCode, 1);

  // But the recovery the refusal itself names has to work, and so does reading
  // state. A check that forbids its own escape hatch is a deadlock, not a guard.
  const status = await run("start", "--session-status", "--session", started.session.id, "--json");
  assert.equal(status.exitCode, 0, status.stderr);

  const aborted = await run("start", "--abort", "--session", started.session.id, "--json");
  assert.equal(aborted.exitCode, 0, aborted.stderr);
  assert.equal(parseJsonOutput(aborted).status, "aborted");

  const fresh = await run("start", "--next", "--json", "--created-at", "2026-07-30T13:00:00.000Z");
  assert.equal(fresh.exitCode, 0, fresh.stderr);
});

test("a finalized session cannot be aborted", async (t) => {
  const { run, finalize } = await finalizedProject(t);

  // The finalized session is the provenance record every requirement traceRef
  // points at. Flipping it to aborted would make the record claim the interview
  // was abandoned, and would block the documented --force-roadmap retry.
  const aborted = await run("start", "--abort", "--session", finalize.session.id, "--json");
  assert.equal(aborted.exitCode, 1);

  const refinalized = await run(
    "start", "--finalize", "--session", finalize.session.id, "--json"
  );
  assert.equal(refinalized.exitCode, 0, "the record must still be usable");
});

test("--intake refuses values that are not answers", async (t) => {
  for (const [label, value] of [["null", null], ["an object", {}], ["a number-shaped object", { a: 1 }]]) {
    const { root, run } = await scratchRepo(t);
    await writeFile(
      path.join(root, "intake.json"),
      JSON.stringify({ ...ANSWERS, "project-name": value }),
      "utf8"
    );

    // String() coercion turned null into "null" and an object into
    // "[object Object]", both of which pass every free-text validator and become
    // the project name.
    const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
    assert.equal(applied.exitCode, 1, `${label} should be refused`);
    assert.ok(
      parseJsonOutput(applied).diagnostics.some((entry) => entry.nodeId === "project-name"),
      `${label} should be reported against the node it was given for`
    );
  }
});

test("a rejected answer reports real progress, not zero", async (t) => {
  const { run } = await scratchRepo(t);
  await run("start", "--next", "--json", "--created-at", CREATED_AT);
  await run("start", "--answer", "project-name=Asset Mapper");
  await run("start", "--answer", "project-summary=Deterministic resolution.");

  // The rejection payload is the screen the operator is asked to look at again;
  // reporting 0 of 0 makes the interview appear to reset on every mistake.
  const rejected = await run("start", "--answer", "project-owner=", "--json");
  assert.equal(rejected.exitCode, 1);
  const payload = parseJsonOutput(rejected);
  assert.equal(payload.session.answered, 2);
  assert.ok(payload.session.total > 2);
});

test("a resumed unanswered session still offers its explorations", async (t) => {
  const { root, run } = await scratchRepo(t);
  await seedExplorationRun(root);

  const first = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));
  assert.ok(first.availableExplorations?.some((entry) => entry.runId === "explore-1"));

  // commands/start.md tells the host to act on this field. An operator who
  // closed the terminal before answering previously had no way to learn the
  // exploration existed, even though seeding was still free.
  const resumed = parseJsonOutput(await run("start", "--next", "--json"));
  assert.equal(resumed.session.id, first.session.id);
  assert.ok(
    resumed.availableExplorations?.some((entry) => entry.runId === "explore-1"),
    "a session with no answers can still be seeded, so the offer must persist"
  );

  // Once an answer exists, seeding is no longer possible and the offer stops —
  // advice that cannot be followed is the failure being avoided here.
  await run("start", "--answer", "project-name=Asset Mapper");
  const answered = parseJsonOutput(await run("start", "--next", "--json"));
  assert.equal(answered.availableExplorations, undefined);
});

test("a quoted shell metacharacter is a usable acceptance criterion", async (t) => {
  const { run } = await scratchRepo(t);
  const answers = {
    ...ANSWERS,
    "req-1-ac-1-detail": 'pnpm test --grep "resolve|reject"'
  };

  let recorded = false;
  for (let guard = 0; guard < 200; guard += 1) {
    const next = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));
    if (next.status === "complete") break;
    const nodeId = next.question.nodeId;
    const value = answers[nodeId];
    if (value === undefined) {
      await run("start", "--skip");
      continue;
    }
    const result = await run("start", "--answer", `${nodeId}=${value}`);
    // The tokenizer already strips the quotes, so `resolve|reject` reaches the
    // runner as one literal argument. Refusing it left the operator no way to
    // express the criterion at all.
    assert.equal(result.exitCode, 0, `${nodeId} was refused: ${result.stdout}${result.stderr}`);
    if (nodeId === "req-1-ac-1-detail") recorded = true;
  }
  assert.equal(recorded, true, "the criterion detail should have been asked");

  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);
});

test("the enforcement answers reach the generated task contract", async (t) => {
  const { root, run } = await scratchRepo(t);
  // Deliberately unlike every default: R3 rather than the hardcoded R2, a
  // three-file budget rather than the repository-wide twenty, and a real
  // verification command rather than `legion validate` checking its own output.
  const answers = {
    ...ANSWERS,
    "risk-tier": "R3",
    "risk-reason": "Touches credentials.",
    "budget-files": "3",
    "budget-lines": "150",
    "budget-new-files": "1",
    "pref-verification": "pnpm run verify --strict"
  };
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  // Recorded on the requirement set, which is what planning reads.
  const index = JSON.parse(
    await readFile(path.join(root, ".legion/project/requirements/index.json"), "utf8")
  );
  assert.deepEqual(index.enforcement.budget, {
    maxFilesChanged: 3,
    maxLinesChanged: 150,
    maxNewFiles: 1
  });
  assert.equal(index.enforcement.risk.tier, "R3");

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  const taskgraph = JSON.parse(
    await readFile(
      path.join(root, ...parseJsonOutput(planned).taskgraph.artifactPath.split("/")),
      "utf8"
    )
  );
  const task = taskgraph.tasks[0];

  // Choosing R3 previously had no effect: phaseRiskProfile hardcoded R2, which
  // silently weakened the gate set on the projects that asked for the strictest.
  assert.equal(task.risk.tier, "R3");
  assert.ok(task.risk.reasons.includes("Touches credentials."));

  // A budget that is asked for and ignored is worse than not asking, because the
  // operator believes a limit is in force.
  assert.deepEqual(task.scope.budget, {
    maxFilesChanged: 3,
    maxLinesChanged: 150,
    maxNewFiles: 1
  });

  // `legion validate` alone is a tautology: it checks the artifacts plan just
  // wrote, not the code the task changes.
  assert.equal(task.verification[0].command, "pnpm");
  assert.deepEqual(task.verification[0].args, ["run", "verify", "--strict"]);
});

test("a project with no interview still plans on repository defaults", async (t) => {
  const { root, run } = await scratchRepo(t);
  await run("start", "--name", "Bare Project", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build it\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);

  // Direct initialization records no policy, so the fallback has to remain
  // reachable rather than the planner assuming an interview happened.
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  const taskgraph = JSON.parse(
    await readFile(
      path.join(root, ...parseJsonOutput(planned).taskgraph.artifactPath.split("/")),
      "utf8"
    )
  );
  assert.equal(taskgraph.tasks[0].risk.tier, "R2");
  assert.equal(taskgraph.tasks[0].verification[0].command, "legion");
});

test("legion doctor does not disagree with legion validate", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  assert.equal((await run("validate", "--json")).exitCode, 0);
  assert.equal((await run("doctor", "--json")).exitCode, 0);

  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.statement = "Something nobody agreed to";
  await writeFile(requirementPath, `${JSON.stringify(requirement, undefined, 2)}\n`, "utf8");

  // Two validation entrances that disagree teach operators to trust whichever
  // one is currently passing.
  assert.equal((await run("validate", "--json")).exitCode, 1);
  const doctored = await run("doctor", "--json");
  assert.equal(doctored.exitCode, 1, "doctor must not report a project validate refuses");
  assert.equal(parseJsonOutput(doctored).checks.requirementSet.ok, false);
});

test("--session without a value is refused rather than guessed", async (t) => {
  const { run } = await scratchRepo(t);
  await run("start", "--next", "--json", "--created-at", CREATED_AT);

  // `--session` with no value parses as `true`, which read as absent and fell
  // through to the newest active session — so this could abort a different
  // interview than the operator named.
  const aborted = await run("start", "--abort", "--session", "--json");
  assert.equal(aborted.exitCode, 1);
  assert.match(parseJsonOutput(aborted).diagnostics[0].message, /--session/);

  const status = parseJsonOutput(await run("start", "--session-status", "--json"));
  assert.equal(status.session.status, "active", "the session must not have been touched");
});

test("follow-up commands name the session that emitted them", async (t) => {
  const { run } = await scratchRepo(t);
  const first = parseJsonOutput(await run("start", "--next", "--json", "--created-at", CREATED_AT));

  // With concurrent starts preserved rather than overwritten, "the newest active
  // session" and "the session that asked this question" are no longer the same
  // thing, so a follow-up that omits --session can answer the wrong interview.
  assert.match(first.nextAction.command, new RegExp(`--session ${first.session.id}`));

  const answered = parseJsonOutput(
    await run("start", "--session", first.session.id, "--answer", "project-name=Asset Mapper", "--json")
  );
  assert.match(answered.nextAction.command, new RegExp(`--session ${first.session.id}`));
});

test("a pinned exploration stays resolvable behind newer runs", async (t) => {
  const { root, run } = await scratchRepo(t);
  await seedExplorationRun(root);

  const seeded = parseJsonOutput(
    await run("start", "--from-exploration", "explore-1", "--json", "--created-at", CREATED_AT)
  );
  assert.equal(seeded.question.proposal?.value, "Asset Mapper");

  // The discovery cap is for the list a human reads. Applying it to resolution
  // meant a dozen newer brainstorms silently withheld the proposals of the one
  // this session is pinned to.
  for (let index = 0; index < 14; index += 1) {
    await seedNamedExplorationRun(root, `later-${String(index).padStart(2, "0")}`);
  }

  const resumed = parseJsonOutput(await run("start", "--next", "--json"));
  assert.equal(
    resumed.question.proposal?.value,
    "Asset Mapper",
    "the pinned exploration must still resolve"
  );
  assert.equal(resumed.warnings, undefined, "no proposals should be withheld");
});

test("every value-taking option is refused when given without a value", async (t) => {
  const { run } = await scratchRepo(t);
  await run("start", "--next", "--json", "--created-at", CREATED_AT);

  // Fixing `--session` alone left `--from-exploration` broken in exactly the
  // same way, so this asserts the class rather than the case: the parser stores
  // `true`, `stringOption` reads that as absent, and the command silently falls
  // through to a default.
  for (const option of ["session", "from-exploration", "intake", "answer", "slug"]) {
    const result = await run("start", `--${option}`, "--json");
    assert.equal(result.exitCode, 1, `--${option} without a value should be refused`);
    assert.match(
      parseJsonOutput(result).diagnostics[0].message,
      new RegExp(`--${option}`),
      `--${option} should be named in the diagnostic`
    );
  }

  const status = parseJsonOutput(await run("start", "--session-status", "--json"));
  assert.equal(status.session.status, "active", "no session should have been touched");
});

test("an all-wont requirement set does not route to legion plan 1", async (t) => {
  const { root, run } = await scratchRepo(t);
  const answers = {
    ...ANSWERS,
    "req-1-priority": "wont",
    "req-1-category": "constraint"
  };
  delete answers["req-1-ac-1-statement"];
  delete answers["req-1-ac-1-proof"];
  delete answers["req-1-ac-1-detail"];
  delete answers["req-1-ac-1-more"];
  await writeFile(path.join(root, "intake.json"), JSON.stringify(answers), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);

  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  // renderRoadmap emits no `## Phase 1:` heading when nothing is buildable, and
  // parseRoadmapPhase requires it — so the advertised next action would have
  // failed with phase_source_missing.
  const payload = parseJsonOutput(finalize);
  assert.doesNotMatch(payload.nextAction.command, /plan 1/);
  assert.match(payload.nextAction.reason, /nothing to plan/i);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.notEqual(planned.exitCode, 0, "the advice was right to steer away from plan");
});

test("an overlong risk reason is rejected, not silently truncated", async (t) => {
  const { root, run } = await scratchRepo(t);
  const tooLong = "x".repeat(200);
  await writeFile(
    path.join(root, "intake.json"),
    JSON.stringify({ ...ANSWERS, "risk-reason": tooLong }),
    "utf8"
  );

  // Accepting it and truncating at finalize left the session recording one
  // rationale and the requirement set another, dropping the tail — which is
  // usually the qualifier that justified the tier.
  const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
  assert.equal(applied.exitCode, 1);
  assert.ok(
    applied.stdout.includes("risk-reason") || applied.stderr.includes("risk-reason"),
    "the overlong reason should be reported against its node"
  );
});

test("an abandoned session reservation does not block initialization", async (t) => {
  const { root, run } = await scratchRepo(t);

  // What a process interrupted between claiming an ID and writing the record
  // leaves behind. listSessions already skips these; initProject rejecting them
  // meant an interrupted start could complete a whole interview and then never
  // finalize it.
  await mkdir(path.join(root, ".legion/project/intake/itk_20260101-000000000"), { recursive: true });

  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
  assert.equal(applied.exitCode, 0, applied.stderr);

  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);
  assert.equal(parseJsonOutput(finalize).projectStatus, "initialized");
});

test("answers to injected exploration questions reach the requirement set", async (t) => {
  const { root, run } = await scratchRepo(t);
  await seedExplorationRun(root);

  await run("start", "--from-exploration", "explore-1", "--json", "--created-at", CREATED_AT);
  const answers = { ...ANSWERS, "open-which-runtime": "Node 24, no browser build" };

  for (let guard = 0; guard < 200; guard += 1) {
    const next = parseJsonOutput(await run("start", "--next", "--json"));
    if (next.status === "complete") break;
    const nodeId = next.question.nodeId;
    const value = answers[nodeId];
    if (value === undefined) {
      assert.equal(next.question.required, false, `no scripted answer for ${nodeId}`);
      await run("start", "--skip");
      continue;
    }
    const result = await run("start", "--answer", `${nodeId}=${value}`);
    assert.equal(result.exitCode, 0, `${nodeId}: ${result.stderr}`);
  }

  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  // The C0 contract is that exploration may only add questions, so a fuzzier
  // idea produces a longer interview. That only means something if the answers
  // are usable: requirementDrafts reads the built-in req-<n>-* slots only, so an
  // injected answer was recorded and consumed by nothing, and two interviews
  // disagreeing about an injected constraint produced identical contracts.
  const index = JSON.parse(
    await readFile(path.join(root, ".legion/project/requirements/index.json"), "utf8")
  );
  const resolved = index.resolvedQuestions ?? [];
  assert.equal(resolved.length, 1, `expected the injected answer, got ${JSON.stringify(resolved)}`);
  assert.equal(resolved[0].nodeId, "open-which-runtime");
  assert.equal(resolved[0].answer, "Node 24, no browser build");
  assert.equal(resolved[0].fromExploration, "run_explore-1");
});

test("a second session cannot overwrite another session's requirement set", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const first = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  // Concurrent starts are preserved and --session can complete either, so two
  // valid interviews could silently replace each other's durable contracts and
  // delete the requirements the other authored.
  const second = parseJsonOutput(
    await run("start", "--next", "--json", "--created-at", "2026-07-30T13:00:00.000Z")
  );
  assert.notEqual(second.session.id, first.session.id);
  await run("start", "--session", second.session.id, "--intake", "intake.json");

  const clash = await run("start", "--finalize", "--session", second.session.id, "--json");
  assert.equal(clash.exitCode, 1);
  assert.equal(parseJsonOutput(clash).status, "requirement_set_conflict");

  // The first session's set is intact, and re-finalizing it still works.
  const index = JSON.parse(
    await readFile(path.join(root, ".legion/project/requirements/index.json"), "utf8")
  );
  assert.equal(index.intakeSessionId, first.session.id);
  assert.equal(
    (await run("start", "--finalize", "--session", first.session.id, "--json")).exitCode,
    0
  );
});

test("planning refuses a corrupt requirement set instead of falling back", async (t) => {
  const { root, run } = await scratchRepo(t);
  await writeFile(
    path.join(root, "intake.json"),
    JSON.stringify({ ...ANSWERS, "risk-tier": "R3", "budget-files": "3", "budget-new-files": "1" }),
    "utf8"
  );
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  await writeFile(path.join(root, ...finalize.requirementSet.paths[0].split("/")), "{ not json", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);

  // `not_found` means no interview and repository defaults apply. `invalid`
  // means the set exists and is damaged — treating them alike silently emitted
  // a task under an R2 default the operator never chose.
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 1);
  assert.equal(parseJsonOutput(planned).status, "requirement_set_invalid");
});

test("requirement text is bounded at the question, not at the schema", async (t) => {
  const { root, run } = await scratchRepo(t);
  // Under the session cap of 8192 but over the requirement schema's 2048, so it
  // used to pass both validation layers and throw out of requirementSchema.parse
  // during --finalize — a stack trace where the operator should have got the
  // question back.
  await writeFile(
    path.join(root, "intake.json"),
    JSON.stringify({ ...ANSWERS, "req-1-statement": "x".repeat(3_000) }),
    "utf8"
  );

  const applied = await run("start", "--intake", "intake.json", "--json", "--created-at", CREATED_AT);
  assert.equal(applied.exitCode, 1);
  assert.ok(
    applied.stdout.includes("req-1-statement") || applied.stderr.includes("req-1-statement"),
    "the over-long statement should be reported against its node"
  );
  assert.doesNotMatch(applied.stderr, /ZodError|Unhandled/);
});
