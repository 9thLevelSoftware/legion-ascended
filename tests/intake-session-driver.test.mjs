import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
