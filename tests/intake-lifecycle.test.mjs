import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";
import { directoryLinkType, requireDirSymlink, requireFileSymlink } from "./helpers/symlink-capability.mjs";
import { discoverGuidanceRuns } from "../packages/cli/dist/workflow/guidance-run.js";

import {
  acceptStagedDraft,
  classifyProjectMode,
  degradedCoverageWarning,
  discardStagedDraft,
  prepareIntakePreflight,
  publishDraftReview,
  recoverIntakeLifecycleArtifacts,
  resolveReviewedDraftDecision,
  resolveExplorationSelection,
  stageIntakeDraft as stageIntakeDraftBound
} from "../packages/cli/dist/workflow/intake/lifecycle.js";
import { handleStageDraft } from "../packages/cli/dist/workflow/intake/driver.js";
import { allocateSessionId, createSession, listSessions, recordAnswer, rollbackSessionCreation, saveSession } from "../packages/cli/dist/workflow/intake/session.js";
import { initProject, intakePreflightStateSchema } from "../packages/artifacts/dist/index.js";

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-intake-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function stageIntakeDraft(input) {
  const source = path.resolve(input.repositoryRoot, input.draftFile);
  const draft = JSON.parse(await readFile(source, "utf8"));
  draft.projectMode = await classifyProjectMode(input.repositoryRoot);
  let preflight;
  try {
    preflight = await prepareIntakePreflight({
      repositoryRoot: input.repositoryRoot,
      createdAt: draft.createdAt,
      explicitGoal: draft.initiative,
      withoutExploration: draft.explorationRefs.length === 0,
      ...(draft.projectMode === "brownfield" && draft.codebaseMapRef === undefined
        ? { mapFailure: "test fixture uses bounded review" }
        : {})
    });
  } catch (error) {
    // Concurrency tests deliberately call this convenience wrapper while a
    // transition owns the global lease. Preparation must now report busy; the
    // real staging call below is what those tests assert also rejects.
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
  }
  if (preflight?.mapFailure !== undefined) {
    draft.diagnostics = [degradedCoverageWarning(preflight.mapFailure.message)];
  }
  await writeFile(source, JSON.stringify(draft), "utf8");
  return stageIntakeDraftBound(input);
}

async function filesystemBytes(root) {
  const snapshot = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push({ path: relative, type: "directory" });
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        snapshot.push({ path: relative, type: "file", bytes: (await readFile(absolute)).toString("base64") });
      }
    }
  }
  await visit(root);
  return snapshot;
}

async function draftAndSessionBytes(root) {
  return (await filesystemBytes(root)).filter((entry) =>
    entry.type === "file" && (
      entry.path.startsWith(".legion/project/intake/drafts/") ||
      /^\.legion\/project\/intake\/itk_[^/]+\/session\.json$/u.test(entry.path)
    )
  );
}

async function outcomeWithin(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("documentation-only repositories remain distinct from brownfield repositories", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "README.md"), "# Notes\n", "utf8");
  await writeFile(path.join(root, "docs", "design.md"), "# Design\n", "utf8");

  assert.equal(await classifyProjectMode(root), "documentation-only");
});

test("source, dependency manifests, and build configuration classify a repository as brownfield", async (t) => {
  const names = ["src/main.ts", "package.json", "tsconfig.json"];
  for (const name of names) {
    await t.test(name, async (t) => {
      const root = await scratch(t);
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), "{}\n", "utf8");
      assert.equal(await classifyProjectMode(root), "brownfield");
    });
  }
});

test("generated and runtime directories do not make a repository brownfield", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, ".legion", "project"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
  await writeFile(path.join(root, "dist", "app.js"), "x", "utf8");
  await writeFile(path.join(root, ".legion", "project", "state.json"), "{}", "utf8");

  assert.equal(await classifyProjectMode(root), "greenfield");
});

async function exploration(root, runId, createdAt, options = {}) {
  const directory = path.join(root, ".legion", "project", "workflow", "explore", runId);
  await mkdir(directory, { recursive: true });
  const artifactPath = `.legion/project/workflow/explore/${runId}/exploration.json`;
  await writeFile(path.join(directory, "exploration.json"), options.corrupt ? "{" : JSON.stringify({
    schemaVersion: "0.2.0",
    createdAt,
    kind: "exploration",
    runId: `run_${runId}`,
    status: "exploratory",
    entry: "raw-idea",
    topic: runId,
    summary: runId,
    proposals: [],
    openQuestions: [],
    notes: []
  }), "utf8");
  await writeFile(path.join(directory, "workflow-run.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "workflow_run",
    workflow: "explore",
    runId,
    createdAt,
    status: options.status ?? "completed",
    input: { topic: runId },
    outputs: { explorationArtifactPath: artifactPath },
    nextAction: { command: options.command ?? "legion start", reason: "continue" },
    diagnostics: []
  }), "utf8");
}

test("automatic exploration selection skips incompatible candidates and chooses the newest readable completed handoff", async (t) => {
  const root = await scratch(t);
  await exploration(root, "older", "2026-08-01T00:00:00.000Z");
  await exploration(root, "oldest", "2026-07-31T00:00:00.000Z");
  await exploration(root, "unrelated", "2026-08-04T00:00:00.000Z", { command: "legion advise" });
  await exploration(root, "blocked", "2026-08-03T00:00:00.000Z", { status: "blocked" });
  await exploration(root, "corrupt", "2026-08-02T00:00:00.000Z", { corrupt: true });

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected?.candidate.runId, "older");
  assert.deepEqual(selected.diagnostics.map((entry) => entry.runId), ["unrelated", "blocked", "corrupt", "oldest"]);
  assert.equal(selected.diagnostics.at(-1).code, "competing_candidate");
});

test("automatic selection diagnoses invalid workflow-run JSON and continues", async (t) => {
  const root = await scratch(t);
  await exploration(root, "valid", "2026-08-01T00:00:00.000Z");
  await exploration(root, "invalid-json", "2026-08-02T00:00:00.000Z");
  await writeFile(path.join(root, ".legion/project/workflow/explore/invalid-json/workflow-run.json"), "{", "utf8");

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected?.candidate.runId, "valid");
  assert.ok(selected.diagnostics.some((entry) => entry.runId === "invalid-json" && entry.code === "unreadable"));
});

test("automatic selection diagnoses a structurally malformed workflow run and continues", async (t) => {
  const root = await scratch(t);
  await exploration(root, "valid", "2026-08-01T00:00:00.000Z");
  await exploration(root, "malformed", "2026-08-02T00:00:00.000Z");
  const runPath = path.join(root, ".legion/project/workflow/explore/malformed/workflow-run.json");
  const run = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(runPath, "utf8")));
  run.nextAction = null;
  await writeFile(runPath, JSON.stringify(run), "utf8");

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected?.candidate.runId, "valid");
  assert.ok(selected.diagnostics.some((entry) => entry.runId === "malformed" && entry.code === "unreadable"));
});

test("corrupt workflow-run diagnostics are stable by workflow and run ID", async (t) => {
  const root = await scratch(t);
  for (const runId of ["z-corrupt", "a-corrupt", "m-corrupt"]) {
    await exploration(root, runId, "2026-08-02T00:00:00.000Z");
    await writeFile(path.join(root, `.legion/project/workflow/explore/${runId}/workflow-run.json`), "{", "utf8");
  }
  const mapDirectory = path.join(root, ".legion/project/workflow/map/map-corrupt");
  await mkdir(mapDirectory, { recursive: true });
  await writeFile(path.join(mapDirectory, "workflow-run.json"), "{", "utf8");

  const discovery = await discoverGuidanceRuns({
    repositoryRoot: root,
    workflows: ["map", "explore"],
    limitPerWorkflow: Number.MAX_SAFE_INTEGER
  });

  assert.deepEqual(discovery.diagnostics.map(({ workflow, runId }) => `${workflow}/${runId}`), [
    "explore/a-corrupt",
    "explore/m-corrupt",
    "explore/z-corrupt",
    "map/map-corrupt"
  ]);
});

test("explicit selection and opt-out override automatic exploration selection", async (t) => {
  const root = await scratch(t);
  await exploration(root, "older", "2026-08-01T00:00:00.000Z");
  await exploration(root, "newer", "2026-08-02T00:00:00.000Z");

  const explicit = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T00:00:00.000Z", explicitRunId: "older" });
  assert.equal(explicit.selectedExplorationRunId, "older");
  assert.deepEqual(explicit.compatibleExplorations.map((entry) => entry.runId).sort(), ["newer", "older"]);

  await exploration(root, "broken", "2026-08-03T00:00:00.000Z", { corrupt: true });
  const optedOut = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T01:00:00.000Z", withoutExploration: true });
  assert.equal(optedOut.selectedExplorationRunId, undefined);
  assert.deepEqual(optedOut.compatibleExplorations.map((entry) => entry.runId).sort(), ["newer", "older"]);
  assert.ok(optedOut.diagnostics.some((entry) => entry.runId === "broken" && entry.code === "unreadable"));
});

async function rewriteExplorationArtifactPath(root, runId, artifactPath) {
  const runPath = path.join(root, ".legion/project/workflow/explore", runId, "workflow-run.json");
  const run = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(runPath, "utf8")));
  run.outputs.explorationArtifactPath = artifactPath;
  await writeFile(runPath, JSON.stringify(run), "utf8");
}

test("automatic selection rejects an exploration artifact path that traverses outside the repository", async (t) => {
  const root = await scratch(t);
  await exploration(root, "handoff", "2026-08-08T10:00:00.000Z");
  const outside = `${path.basename(root)}-outside.json`;
  const outsidePath = path.join(root, "..", outside);
  t.after(() => rm(outsidePath, { force: true }));
  await writeFile(outsidePath, await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/workflow/explore/handoff/exploration.json"))), "utf8");
  await rewriteExplorationArtifactPath(root, "handoff", `../${outside}`);

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected, undefined);
  assert.ok(selected.diagnostics.some((entry) => entry.runId === "handoff" && entry.code === "unreadable"));
});

test("automatic selection rejects a final exploration artifact symlink", async (t) => {
  if (!requireFileSymlink(t)) return;
  const root = await scratch(t);
  await exploration(root, "handoff", "2026-08-08T10:00:00.000Z");
  const artifact = path.join(root, ".legion/project/workflow/explore/handoff/exploration.json");
  const target = path.join(root, "exploration-target.json");
  await import("node:fs/promises").then(({ copyFile }) => copyFile(artifact, target));
  await rm(artifact);
  await symlink(target, artifact, "file");

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected, undefined);
  assert.ok(selected.diagnostics.some((entry) => entry.code === "unreadable"));
});

test("automatic selection rejects an exploration artifact that escapes through an ancestor symlink", async (t) => {
  if (!requireDirSymlink(t)) return;
  const root = await scratch(t);
  await exploration(root, "handoff", "2026-08-08T10:00:00.000Z");
  const outside = await mkdtemp(path.join(tmpdir(), "legion-exploration-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ copyFile }) => copyFile(path.join(root, ".legion/project/workflow/explore/handoff/exploration.json"), path.join(outside, "exploration.json")));
  const link = path.join(root, ".legion/project/workflow/explore/linked");
  await symlink(outside, link, directoryLinkType());
  await rewriteExplorationArtifactPath(root, "handoff", ".legion/project/workflow/explore/linked/exploration.json");

  const selected = await resolveExplorationSelection({ repositoryRoot: root });

  assert.equal(selected.selected, undefined);
  assert.ok(selected.diagnostics.some((entry) => entry.code === "unreadable"));
});

test("recording a draft answer preserves its immutable draft and answer anchor", () => {
  const session = createSession({
    sessionId: "itk_20260808-120000000",
    createdAt: "2026-08-08T12:00:00.000Z",
    schemaVersion: "0.3.0"
  }).session;
  const recorded = recordAnswer({
    session,
    nodeId: "project-name",
    value: "Asset Mapper",
    answeredAt: "2026-08-08T12:00:00.000Z",
    source: "draft-accepted",
    draftAcceptedFrom: { draftId: "itd_asset-mapper", answerAnchor: "project-name" }
  });

  assert.equal(recorded.ok, true);
  assert.deepEqual(recorded.session.answers[0].draftAcceptedFrom, {
    draftId: "itd_asset-mapper",
    answerAnchor: "project-name"
  });
});

test("a failed acceptance can roll back the just-created session record", async (t) => {
  const root = await scratch(t);
  const createdAt = "2026-08-08T12:00:00.000Z";
  const sessionId = await allocateSessionId(root, createdAt);
  await saveSession(root, createSession({ sessionId, createdAt, schemaVersion: "0.3.0" }).session);

  await rollbackSessionCreation(root, sessionId);

  assert.deepEqual(await listSessions(root), []);
});

function draftAnswer(nodeId, slot, value) {
  return {
    nodeId,
    slot,
    value,
    confidence: "researched",
    rationale: `Evidence for ${nodeId}.`,
    answerAnchor: nodeId,
    evidenceRefs: []
  };
}

function intakeDraft(proposedAnswers) {
  return {
    schemaVersion: "0.3.0",
    createdAt: "2026-08-08T12:00:00.000Z",
    kind: "intake-draft",
    id: "itd_asset-mapper",
    status: "draft",
    graphVersion: "1.2.0",
    projectMode: "greenfield",
    initiative: "Create an asset mapper.",
    explorationRefs: [],
    proposedAnswers,
    injectedQuestions: [],
    unresolvedNodes: [],
    diagnostics: []
  };
}

async function leaveRecoverableCommittedJournal(root) {
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([
    draftAnswer("project-name", "project.name", "Asset Mapper")
  ])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterDraftCommit: () => { throw new Error("simulated interruption after draft commit"); }
  });
  assert.equal(committed.ok, true);
  return path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
}

async function leaveTwoRecoverableCommittedJournals(root) {
  await stageReviewedDraft(root);
  const first = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterDraftCommit: () => { throw new Error("retain first committed journal"); }
  });
  assert.equal(first.ok, true);

  const secondDraft = { ...first.draft, id: "itd_second-committed" };
  const secondDraftPath = path.join(root, `.legion/project/intake/drafts/${secondDraft.id}.json`);
  await writeFile(secondDraftPath, `${JSON.stringify(secondDraft, undefined, 2)}\n`, "utf8");
  const secondSessionId = await allocateSessionId(root, "2026-08-08T20:00:00.001Z");
  const secondSession = {
    ...first.session,
    id: secondSessionId,
    createdAt: "2026-08-08T20:00:00.001Z",
    answers: first.session.answers.map((answer) => ({
      ...answer,
      answeredAt: "2026-08-08T20:00:00.001Z",
      draftAcceptedFrom: {
        ...answer.draftAcceptedFrom,
        draftId: secondDraft.id
      }
    }))
  };
  await saveSession(root, secondSession);
  const transactions = path.join(root, ".legion/project/intake/transactions");
  const firstJournalPath = path.join(transactions, `${first.draft.id}.json`);
  const secondJournalPath = path.join(transactions, `${secondDraft.id}.json`);
  await writeFile(secondJournalPath, `${JSON.stringify({
    schemaVersion: 1,
    draftId: secondDraft.id,
    sessionId: secondSession.id
  })}\n`, "utf8");
  return {
    first: { draft: first.draft, session: first.session, journalPath: firstJournalPath },
    second: { draft: secondDraft, session: secondSession, journalPath: secondJournalPath }
  };
}

async function leaveMixedAcceptanceJournals(root, phase) {
  await stageReviewedDraft(root);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterDraftCommit: () => { throw new Error("retain committed journal beside prepared acceptance"); }
  });
  assert.equal(committed.ok, true);

  const preparedDraft = {
    ...intakeDraft([draftAnswer("project-name", "project.name", "Mixed Prepared")]),
    id: "itd_mixed-prepared"
  };
  const preparedDraftPath = path.join(root, `.legion/project/intake/drafts/${preparedDraft.id}.json`);
  const preparedDraftRaw = Buffer.from(`${JSON.stringify(preparedDraft, undefined, 2)}\n`);
  await writeFile(preparedDraftPath, preparedDraftRaw);
  const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
  await writeFile(reviewPath, `${JSON.stringify({
    schemaVersion: 1,
    state: "reviewed",
    draftId: preparedDraft.id,
    draftSha256: `sha256:${createHash("sha256").update(preparedDraftRaw).digest("hex")}`,
    token: "mixed-prepared-review",
    updatedAt: "2026-08-08T20:00:00.001Z"
  }, undefined, 2)}\n`, "utf8");

  const sessionId = await allocateSessionId(root, "2026-08-08T20:00:00.001Z");
  const reservationPath = path.join(root, `.legion/project/intake/${sessionId}`);
  const journalPath = path.join(root, `.legion/project/intake/transactions/${preparedDraft.id}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    draftId: preparedDraft.id,
    sessionId
  })}\n`, "utf8");
  let transactionPath = journalPath;
  if (phase === "rolling-back") {
    transactionPath = `${journalPath}.rollback`;
    await rename(journalPath, transactionPath);
    await rmdir(reservationPath);
  }
  return {
    committed: {
      ...committed,
      journalPath: path.join(root, `.legion/project/intake/transactions/${committed.draft.id}.json`)
    },
    prepared: {
      draft: preparedDraft,
      draftPath: preparedDraftPath,
      reviewPath,
      reservationPath,
      transactionPath,
      reservationPresent: phase === "prepared"
    }
  };
}

function legacyPublishedClaim({ generation = 1, token, pid = process.pid, expiresAt }) {
  return `${JSON.stringify({
    schemaVersion: 1,
    generation,
    token,
    pid,
    createdAt: "2026-08-08T19:00:00.000Z",
    expiresAt
  })}\n`;
}

async function interruptAcceptanceAfterJournal(root, draftId, createdAt = "2026-08-08T20:00:00.000Z") {
  let observedJournal;
  let releaseAcceptance;
  const journalPublished = new Promise((resolve) => { observedJournal = resolve; });
  const continueAcceptance = new Promise((resolve) => { releaseAcceptance = resolve; });
  const acceptance = acceptStagedDraft({
    repositoryRoot: root,
    draftId,
    createdAt,
    requireReviewed: true,
    afterAcceptanceJournal: async () => {
      observedJournal(JSON.parse(await readFile(
        path.join(root, `.legion/project/intake/transactions/${draftId}.json`),
        "utf8"
      )));
      await continueAcceptance;
    }
  });
  const journal = await outcomeWithin(journalPublished, 2_000, `prepared acceptance journal for ${draftId}`);
  const reservationPath = path.join(root, `.legion/project/intake/${journal.sessionId}`);
  assert.deepEqual(await readdir(reservationPath), [], "prepared acceptance reservation is not empty");
  await rm(path.join(root, ".legion/project/intake/transactions/intake-transition.lock"));
  releaseAcceptance();
  const interrupted = await outcomeWithin(acceptance, 2_000, `interrupted acceptance unwind for ${draftId}`);
  assert.equal(interrupted.ok, false);
  assert.deepEqual(await readdir(reservationPath), [], "lease-lost acceptance mutated its reservation");
  return {
    journal,
    journalPath: path.join(root, `.legion/project/intake/transactions/${draftId}.json`),
    reservationPath
  };
}

async function stageReviewedDraft(root, draft = intakeDraft([
  draftAnswer("project-name", "project.name", "Asset Mapper")
]), sourceName = `${draft.id}.source.json`) {
  const source = path.join(root, sourceName);
  await writeFile(source, JSON.stringify(draft), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: draft.id })).ok, true);
  return source;
}

const lifecycleModuleUrl = new URL("../packages/cli/dist/workflow/intake/lifecycle.js", import.meta.url).href;

async function crashAcceptanceAt(root, hookName, exitCode) {
  const script = `
    import { acceptStagedDraft } from ${JSON.stringify(lifecycleModuleUrl)};
    const result = await acceptStagedDraft({
      repositoryRoot: process.env.LEGION_CRASH_ROOT,
      draftId: "itd_asset-mapper",
      createdAt: "2026-08-08T20:00:00.000Z",
      requireReviewed: true,
      [process.env.LEGION_CRASH_HOOK]: () => process.exit(Number(process.env.LEGION_CRASH_EXIT))
    });
    process.stderr.write(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      LEGION_CRASH_ROOT: root,
      LEGION_CRASH_HOOK: hookName,
      LEGION_CRASH_EXIT: String(exitCode)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await outcomeWithin(once(child, "exit"), 5_000, `${hookName} child crash`);
  assert.equal(signal, null, stderr);
  assert.equal(code, exitCode, stderr);
}

test("staging materializes dynamic requirement and acceptance-criterion nodes through the intake graph", async (t) => {
  const root = await scratch(t);
  const proposedAnswers = [
    draftAnswer("project-name", "project.name", "Asset Mapper"),
    draftAnswer("project-summary", "project.summary", "Deterministic mapping."),
    draftAnswer("project-owner", "project.owner", "dasbl"),
    draftAnswer("problem-statement", "problem.statement", "References break."),
    draftAnswer("problem-users", "problem.users", "Builders"),
    draftAnswer("problem-success", "problem.success", "Broken references fail."),
    draftAnswer("req-1-statement", "requirements.1.statement", "Missing assets fail loudly"),
    draftAnswer("req-1-priority", "requirements.1.priority", "must"),
    draftAnswer("req-1-category", "requirements.1.category", "behavior"),
    draftAnswer("req-1-ac-1-statement", "requirements.1.criteria.1.statement", "Resolution exits non-zero"),
    draftAnswer("req-1-ac-1-proof", "requirements.1.criteria.1.proof", "executable"),
    draftAnswer("req-1-ac-1-detail", "requirements.1.criteria.1.detail", "pnpm test --filter resolver"),
    draftAnswer("req-1-ac-1-more", "requirements.1.criteria.1.more", false),
    draftAnswer("req-1-more", "requirements.1.more", false)
  ];
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft(proposedAnswers)), "utf8");

  const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });

  assert.equal(staged.ok, true);
  assert.deepEqual(staged.diagnostics, []);
  assert.equal(staged.previewSession.answers.at(-1).nodeId, "req-1-more");
  assert.equal(staged.draft.proposedAnswers.length, 14);
  assert.equal(await import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json")).then(() => true)), true);
  assert.equal(await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, ".legion/project/intake")).then((entries) => entries.some((entry) => entry.startsWith("itk_")))), false);
});

test("draft questions use the exploration namespace and deterministic duplicate handling", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([]);
  await exploration(root, "source", "2026-08-08T10:00:00.000Z");
  draft.injectedQuestions = [
    { nodeId: "project-name", slot: "custom.one", prompt: "One?", origin: { runId: "run_source", anchor: "custom.one" } },
    { nodeId: "open-project-name", slot: "custom.two", prompt: "Two?", origin: { runId: "run_source", anchor: "custom.two" } }
  ];
  const artifactPath = ".legion/project/workflow/explore/source/exploration.json";
  const absoluteArtifact = path.join(root, artifactPath);
  const artifact = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(absoluteArtifact, "utf8")));
  artifact.openQuestions = [
    { nodeId: "project-name", slot: "custom.one", question: "One?", why: "Unknown" },
    { nodeId: "open-project-name", slot: "custom.two", question: "Two?", why: "Unknown" }
  ];
  const artifactBytes = JSON.stringify(artifact);
  await writeFile(absoluteArtifact, artifactBytes, "utf8");
  draft.explorationRefs = [{ kind: "exploration", runId: "run_source", artifact: { path: artifactPath, sha256: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}` } }];
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(draft), "utf8");
  const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
  assert.equal(staged.ok, true);
  assert.deepEqual(staged.previewSession.injectedNodes.map((node) => node.nodeId), ["open-project-name", "open-project-name-1"]);
  assert.deepEqual(staged.previewSession.injectedNodes[0].origin, { runId: "run_source", anchor: "custom.one" });
});

test("draft questions cannot collide with built-in or injected slots", async (t) => {
  for (const questions of [
    [{ nodeId: "custom", slot: "project.name", prompt: "Conflict?", origin: { runId: "run_source", anchor: "one" } }],
    [
      { nodeId: "custom-a", slot: "custom.same", prompt: "A?", origin: { runId: "run_source", anchor: "one" } },
      { nodeId: "custom-b", slot: "custom.same", prompt: "B?", origin: { runId: "run_source", anchor: "two" } }
    ]
  ]) {
    const root = await scratch(t);
    const draft = intakeDraft([]);
    draft.injectedQuestions = questions;
    const source = path.join(root, "draft.json");
    await writeFile(source, JSON.stringify(draft), "utf8");
    const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
    assert.equal(staged.ok, false);
    assert.equal(staged.diagnostics[0].code, "injected_slot_conflict");
  }
});

test("draft questions cannot collide with later bounded requirement slots", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([]);
  draft.injectedQuestions = [{
    nodeId: "late-conflict",
    slot: "requirements.2.criteria.3.statement",
    prompt: "Conflict?",
    origin: { runId: "run_source", anchor: "requirements.2.criteria.3.statement" }
  }];
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(draft), "utf8");
  const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
  assert.equal(staged.ok, false);
  assert.equal(staged.diagnostics[0].code, "injected_slot_conflict");
});

test("draft question origins must resolve to a cited exploration question", async (t) => {
  for (const mode of ["unreferenced", "forged-anchor"]) {
    const root = await scratch(t);
    const draft = intakeDraft([]);
    if (mode === "forged-anchor") {
      await exploration(root, "source", "2026-08-08T10:00:00.000Z");
      const artifactPath = ".legion/project/workflow/explore/source/exploration.json";
      const absolute = path.join(root, artifactPath);
      const artifact = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(absolute, "utf8")));
      artifact.openQuestions = [{ nodeId: "real-question", slot: "custom.real", question: "Real?", why: "Unknown" }];
      const bytes = JSON.stringify(artifact);
      await writeFile(absolute, bytes, "utf8");
      draft.explorationRefs = [{ kind: "exploration", runId: "run_source", artifact: { path: artifactPath, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } }];
    }
    draft.injectedQuestions = [{
      nodeId: "invented",
      slot: "custom.invented",
      prompt: "Invented?",
      origin: { runId: "run_source", anchor: "custom.invented" }
    }];
    const source = path.join(root, "draft.json");
    await writeFile(source, JSON.stringify(draft), "utf8");
    const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
    assert.equal(staged.ok, false, mode);
    assert.equal(staged.diagnostics[0].code, "unverified_injected_origin", mode);
  }
});

test("staging rejects unknown, inapplicable, conflicting, and invalid proposed answers with actionable diagnostics", async (t) => {
  const cases = [
    ["unknown_node", [draftAnswer("mystery-node", "mystery.slot", "value")]],
    ["inapplicable_answer", [
      draftAnswer("req-1-priority", "requirements.1.priority", "wont"),
      draftAnswer("req-1-ac-1-statement", "requirements.1.criteria.1.statement", "not asked")
    ]],
    ["conflicting_slot", [draftAnswer("project-name", "project.summary", "Asset Mapper")]],
    ["unknown_option", [draftAnswer("risk-tier", "risk.tier", "R9")]]
  ];
  for (const [expectedCode, answers] of cases) {
    await t.test(expectedCode, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft(answers)), "utf8");
      const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
      assert.equal(staged.ok, false);
      assert.ok(staged.diagnostics.some((entry) => entry.code === expectedCode), JSON.stringify(staged.diagnostics));
    });
  }
});

test("acceptance creates one session containing every draft answer and immutable provenance", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  const answers = [
    draftAnswer("project-name", "project.name", "Asset Mapper"),
    draftAnswer("project-summary", "project.summary", "Deterministic mapping.")
  ];
  await writeFile(source, JSON.stringify(intakeDraft(answers)), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  const accepted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T13:00:00.000Z"
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, "interview");
  assert.equal(accepted.session.answers.length, 2);
  assert.ok(accepted.session.answers.every((answer) => answer.source === "draft-accepted"));
  assert.deepEqual(accepted.session.answers.map((answer) => answer.draftAcceptedFrom), [
    { draftId: "itd_asset-mapper", answerAnchor: "project-name" },
    { draftId: "itd_asset-mapper", answerAnchor: "project-summary" }
  ]);
  const persistedDraft = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8")));
  assert.equal(persistedDraft.status, "accepted");
});

test("resuming review after direct-file drift invalidates immutable content and requires a new draft ID", async (t) => {
  const root = await scratch(t);
  const citedPath = "src/name.ts";
  await mkdir(path.join(root, "src"));
  const original = "export const name = 'Asset Mapper';\n";
  await writeFile(path.join(root, citedPath), original, "utf8");
  const answer = draftAnswer("project-name", "project.name", "Asset Mapper");
  answer.evidenceRefs = [{
    kind: "repository-file",
    artifact: {
      path: citedPath,
      sha256: `sha256:${createHash("sha256").update(original).digest("hex")}`
    },
    anchor: "name"
  }];
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([answer])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
  await writeFile(path.join(root, citedPath), "export const name = 'Changed';\n", "utf8");

  const accepted = await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" });

  assert.equal(accepted.ok, false);
  assert.ok(accepted.diagnostics.some((entry) => entry.code === "evidence_drift"));
  assert.ok(accepted.diagnostics.some((entry) => entry.code === "replacement_draft_required"));
  const intakeEntries = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, ".legion/project/intake")));
  assert.equal(intakeEntries.some((entry) => entry.startsWith("itk_")), false);
  const persistedDraft = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8")));
  assert.equal(persistedDraft.status, "invalidated");
  assert.deepEqual(persistedDraft.proposedAnswers, [answer]);
  assert.deepEqual(persistedDraft.unresolvedNodes, []);
});

test("a changed selected exploration blocks acceptance even when a proposal omitted a duplicate evidence reference", async (t) => {
  const root = await scratch(t);
  await exploration(root, "handoff", "2026-08-08T10:00:00.000Z");
  const artifactPath = ".legion/project/workflow/explore/handoff/exploration.json";
  const artifactBytes = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, artifactPath)));
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  draft.explorationRefs = [{
    kind: "exploration",
    runId: "run_handoff",
    artifact: { path: artifactPath, sha256: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}` }
  }];
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(draft), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
  await writeFile(path.join(root, artifactPath), "{}", "utf8");

  const accepted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T13:00:00.000Z",
    requireReviewed: true
  });
  assert.equal(accepted.ok, false);
  assert.ok(accepted.diagnostics.some((entry) => entry.code === "preflight_exploration_mismatch"));
  const persisted = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8"));
  assert.equal(persisted.status, "invalidated");
  assert.deepEqual(persisted.proposedAnswers, draft.proposedAnswers);
  const second = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T13:01:00.000Z"
  });
  assert.equal(second.ok, false);
  assert.ok(second.diagnostics.some((entry) => entry.code === "draft_not_open"));
});

test("a changed codebase-map source fingerprint returns the draft to review", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "src"));
  const sourceBytes = "export const value = 1;\n";
  await writeFile(path.join(root, "src/app.ts"), sourceBytes, "utf8");
  const refreshed = await runCliCapture([
    "--repository-root", root, "map", "--refresh", "--scope", ".", "--json",
    "--created-at", "2026-08-08T12:00:00.000Z"
  ]);
  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  const refreshPayload = parseJsonOutput(refreshed);
  const mapPath = refreshPayload.mapArtifactPath;
  const mapBytes = await readFile(path.join(root, ...mapPath.split("/")));
  const map = JSON.parse(mapBytes.toString("utf8"));
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  draft.codebaseMapRef = {
    kind: "codebase-map",
    artifact: { path: mapPath, sha256: `sha256:${createHash("sha256").update(mapBytes).digest("hex")}` },
    sourceFingerprint: map.sourceFingerprint
  };
  const draftPath = ".legion/input-draft.json";
  await writeFile(path.join(root, draftPath), JSON.stringify(draft), "utf8");
  const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: draftPath });
  assert.equal(staged.ok, true, JSON.stringify(staged.diagnostics));
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
  await writeFile(path.join(root, "src/app.ts"), "export const value = 2;\n", "utf8");

  const accepted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T13:00:00.000Z",
    requireReviewed: true
  });
  assert.equal(accepted.ok, false);
  assert.ok(accepted.diagnostics.some((entry) => entry.code === "preflight_map_mismatch"));
  const persisted = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8"));
  assert.equal(persisted.status, "invalidated");
  assert.deepEqual(persisted.proposedAnswers, draft.proposedAnswers);
});

test("inventory map state round-trips through the strict intake preflight schema", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/main.ts"), "export const value = 1;\n", "utf8");

  const preflight = await prepareIntakePreflight({
    repositoryRoot: root,
    createdAt: "2026-08-08T14:00:00.000Z",
    explicitGoal: "Keep the inventory map compatible",
    withoutExploration: true
  });
  const persisted = JSON.parse(await readFile(path.join(root, ".legion/project/intake/preflight.json"), "utf8"));

  assert.equal(preflight.map.indexProfile, undefined);
  assert.equal(preflight.map.snapshotId, undefined);
  assert.equal(intakePreflightStateSchema.safeParse(persisted).success, true);
  assert.deepEqual(intakePreflightStateSchema.parse(persisted), persisted);
});

test("preflight is durable before session creation and resumes draft review", async (t) => {
  const root = await scratch(t);
  await writeFile(path.join(root, "README.md"), "# Draft project\n", "utf8");
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  const first = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T14:00:00.000Z" });
  const resumed = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T15:00:00.000Z" });

  assert.equal(first.status, "draft_review");
  assert.equal(first.projectMode, "documentation-only");
  assert.equal(first.activeDraftId, "itd_asset-mapper");
  assert.equal(first.activeSessionId, undefined);
  assert.equal(resumed.createdAt, first.createdAt, "an interrupted preflight should be resumed, not replaced");
  const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake/preflight.json"), "utf8")));
  assert.equal(persisted.status, "draft_review");
});

test("preflight write failpoints preserve prior bytes and release the global transition lease", async (t) => {
  for (const hook of ["beforePreflightWrite", "beforePreflightPublish"]) {
    await t.test(hook, async (t) => {
      const root = await scratch(t);
      await prepareIntakePreflight({
        repositoryRoot: root,
        createdAt: "2026-08-08T15:00:00.000Z",
        explicitGoal: "Original initiative"
      });
      const preflightPath = path.join(root, ".legion/project/intake/preflight.json");
      const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
      const before = await readFile(preflightPath);

      await assert.rejects(prepareIntakePreflight({
        repositoryRoot: root,
        createdAt: "2026-08-08T15:00:01.000Z",
        explicitGoal: "Replacement initiative",
        [hook]: () => { throw new Error(`injected ${hook}`); }
      }), new RegExp(`injected ${hook}`, "u"));

      assert.deepEqual(await readFile(preflightPath), before);
      await assert.rejects(readFile(lockPath), { code: "ENOENT" });
      const retried = await outcomeWithin(prepareIntakePreflight({
        repositoryRoot: root,
        createdAt: "2026-08-08T15:00:02.000Z",
        explicitGoal: "Replacement initiative"
      }), 2_000, "preflight retry after failpoint");
      assert.equal(retried.initiative.value, "Replacement initiative");
    });
  }
});

test("stage revalidates the durable preflight after acquiring the global transition lease", async (t) => {
  const root = await scratch(t);
  await prepareIntakePreflight({
    repositoryRoot: root,
    createdAt: "2026-08-08T15:00:00.000Z",
    explicitGoal: "Create an asset mapper.",
    withoutExploration: true
  });
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  const preflightPath = path.join(root, ".legion/project/intake/preflight.json");
  const replacement = JSON.parse(await readFile(preflightPath, "utf8"));
  replacement.updatedAt = "2026-08-08T15:00:01.000Z";
  replacement.initiative = { value: "A newer preparation initiative", source: "explicit" };

  const staged = await outcomeWithin(stageIntakeDraftBound({
    repositoryRoot: root,
    draftFile: source,
    afterLeaseAcquired: async () => {
      await writeFile(preflightPath, `${JSON.stringify(replacement, undefined, 2)}\n`, "utf8");
    }
  }), 2_000, "stage preflight revalidation");

  assert.equal(staged.ok, false);
  assert.ok(staged.diagnostics.some((entry) => entry.code === "preflight_initiative_mismatch"));
  await assert.rejects(
    readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json")),
    { code: "ENOENT" }
  );
});

test("preflight resume discards structurally invalid persisted state", async (t) => {
  const root = await scratch(t);
  const intake = path.join(root, ".legion/project/intake");
  await mkdir(intake, { recursive: true });
  await writeFile(path.join(intake, "preflight.json"), JSON.stringify({
    schemaVersion: 1,
    status: "preflight",
    createdAt: "yesterday",
    updatedAt: "yesterday",
    projectMode: "greenfield",
    map: { freshness: "absent" },
    explorationSelectionIntent: { mode: "automatic" },
    compatibleExplorations: [],
    diagnostics: []
  }), "utf8");
  const prepared = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T15:00:00.000Z" });
  assert.equal(prepared.createdAt, "2026-08-08T15:00:00.000Z");
  assert.equal(prepared.map.freshness, "absent");
  assert.equal(typeof prepared.map.sourceFingerprint, "string");
});

test("bare preparation selects or declines exploration before the explicit interview entrance", async (t) => {
  const automaticRoot = await scratch(t);
  await exploration(automaticRoot, "handoff", "2026-08-08T10:00:00.000Z");
  const automatic = await runCliCapture([
    "--repository-root", automaticRoot, "start", "--json", "--created-at", "2026-08-08T16:00:00.000Z"
  ]);
  assert.equal(automatic.exitCode, 0, automatic.stderr);
  const automaticPayload = parseJsonOutput(automatic);
  assert.equal(automaticPayload.status, "preflight");
  assert.equal(automaticPayload.preflight.selectedExplorationRunId, "handoff");
  assert.deepEqual(automaticPayload.preparation.initiative, {
    value: "handoff",
    source: "exploration",
    explorationRunId: "handoff"
  });
  const automaticEntries = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(automaticRoot, ".legion/project/intake")));
  assert.equal(automaticEntries.filter((entry) => entry.startsWith("itk_")).length, 0);

  const optOutRoot = await scratch(t);
  await exploration(optOutRoot, "handoff", "2026-08-08T10:00:00.000Z");
  const optOutPreparation = await runCliCapture([
    "--repository-root", optOutRoot, "start", "--without-exploration", "--json", "--created-at", "2026-08-08T16:00:00.000Z"
  ]);
  assert.equal(optOutPreparation.exitCode, 0, optOutPreparation.stderr);
  assert.equal(parseJsonOutput(optOutPreparation).preflight.selectedExplorationRunId, undefined);
  const optOut = await runCliCapture([
    "--repository-root", optOutRoot, "start", "--next", "--json", "--created-at", "2026-08-08T16:00:00.000Z"
  ]);
  assert.equal(optOut.exitCode, 0, optOut.stderr);
  const optOutPayload = parseJsonOutput(optOut);
  assert.equal(optOutPayload.preflight.selectedExplorationRunId, undefined);
  assert.equal(optOutPayload.session.explorationRunId, undefined);
  assert.equal(optOutPayload.question.nodeId, "project-name");
});

test("the start command stages and accepts a durable draft without a throwaway session", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([
    draftAnswer("project-name", "project.name", "Asset Mapper"),
    draftAnswer("project-summary", "project.summary", "Deterministic mapping.")
  ])), "utf8");
  await prepareIntakePreflight({
    repositoryRoot: root,
    createdAt: "2026-08-08T17:00:00.000Z",
    explicitGoal: "Create an asset mapper.",
    withoutExploration: true
  });

  const staged = await runCliCapture([
    "--repository-root", root, "start", "--draft", "draft.json", "--json", "--created-at", "2026-08-08T17:00:00.000Z"
  ]);
  assert.equal(staged.exitCode, 0, staged.stderr);
  assert.equal(parseJsonOutput(staged).status, "draft_review");
  const afterStage = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, ".legion/project/intake")));
  assert.equal(afterStage.some((entry) => entry.startsWith("itk_")), false);

  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_asset-mapper", "--json", "--created-at", "2026-08-08T18:00:00.000Z"
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  const payload = parseJsonOutput(accepted);
  assert.equal(payload.status, "interview");
  assert.equal(payload.session.answers.length, 2);
  assert.equal(payload.session.answers[0].draftAcceptedFrom.draftId, "itd_asset-mapper");
});

test("staging refuses to overwrite an immutable accepted draft with the same ID", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z" })).ok, true);

  const restaged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });

  assert.equal(restaged.ok, false);
  assert.ok(restaged.diagnostics.some((entry) => entry.code === "draft_already_exists"));
});

test("interrupted draft publish leaves no truncated final and retry succeeds", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  await assert.rejects(
    stageIntakeDraft({
      repositoryRoot: root,
      draftFile: source,
      beforeDraftPublish: () => { throw new Error("simulated staging interruption"); }
    }),
    /simulated staging interruption/
  );
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"))), { code: "ENOENT" });
  await writeFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json.abandoned.tmp"), "{", "utf8");

  const retried = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
  assert.equal(retried.ok, true);
  const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8")));
  assert.equal(persisted.id, "itd_asset-mapper");
  const draftFiles = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, ".legion/project/intake/drafts")));
  assert.deepEqual(draftFiles, ["itd_asset-mapper.json"]);
});

test("post-publish interruption is cleaned by immutable retry before initialization", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  await assert.rejects(stageIntakeDraft({
    repositoryRoot: root,
    draftFile: source,
    afterDraftPublish: () => { throw new Error("simulated crash after exclusive publish"); }
  }), /simulated crash after exclusive publish/);
  const drafts = path.join(root, ".legion/project/intake/drafts");
  const afterCrash = await import("node:fs/promises").then(({ readdir }) => readdir(drafts));
  assert.equal(afterCrash.some((name) => name.endsWith(".tmp")), true);
  const original = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(drafts, "itd_asset-mapper.json"), "utf8"));

  const retry = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
  assert.equal(retry.ok, false);
  assert.equal(retry.diagnostics[0].code, "draft_already_exists");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(drafts, "itd_asset-mapper.json"), "utf8")), original);
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(drafts)), ["itd_asset-mapper.json"]);
  const initialized = await initProject({
    repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
    decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
  });
  assert.equal(initialized.ok, true);
});

test("replacement journal recovers exactly one open draft at every publish failpoint", async (t) => {
  for (const failpoint of ["afterReplacementJournal", "afterPriorInvalidated", "afterReplacementPublished"]) {
    await t.test(failpoint, async (t) => {
      const root = await scratch(t);
      const firstSource = path.join(root, "first.json");
      const secondSource = path.join(root, "second.json");
      const prior = { ...intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper")
      ]), id: "itd_replace-old" };
      await writeFile(firstSource, JSON.stringify(prior), "utf8");
      await writeFile(secondSource, JSON.stringify({ ...intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper Revised")
      ]), id: "itd_replace-new" }), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: firstSource })).ok, true);

      await assert.rejects(stageIntakeDraft({
        repositoryRoot: root,
        draftFile: secondSource,
        [failpoint]: () => { throw new Error(`replacement crash at ${failpoint}`); }
      }), new RegExp(`replacement crash at ${failpoint}`));
      await recoverIntakeLifecycleArtifacts(root);

      const oldDraft = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_replace-old.json"), "utf8"));
      const newDraft = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_replace-new.json"), "utf8"));
      assert.equal(oldDraft.status, "invalidated");
      assert.deepEqual(oldDraft.proposedAnswers, prior.proposedAnswers);
      assert.equal(newDraft.status, "draft");
      const open = [oldDraft, newDraft].filter((draft) => draft.status === "draft");
      assert.deepEqual(open.map((draft) => draft.id), ["itd_replace-new"]);
    });
  }
});

test("replacement revalidates constant ownership after journaling before prior CAS", async (t) => {
  const root = await scratch(t);
  const firstSource = path.join(root, "first.json");
  const secondSource = path.join(root, "second.json");
  await writeFile(firstSource, JSON.stringify({ ...intakeDraft([]), id: "itd_boundary-old" }), "utf8");
  await writeFile(secondSource, JSON.stringify({ ...intakeDraft([]), id: "itd_boundary-new" }), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: firstSource })).ok, true);

  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: "successor-after-journal",
    createdAt: "2026-08-08T20:00:00.000Z"
  })}\n`;
  const result = await stageIntakeDraft({
    repositoryRoot: root,
    draftFile: secondSource,
    afterReplacementJournal: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { encoding: "utf8", flag: "wx" });
    }
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "draft_transition_lease_lost"));
  assert.equal(JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_boundary-old.json"), "utf8")).status, "draft");
  await assert.rejects(readFile(path.join(root, ".legion/project/intake/drafts/itd_boundary-new.json")), { code: "ENOENT" });
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("replacement clears the old displayed decision until the new bytes are displayed", async (t) => {
  const root = await scratch(t);
  const firstSource = path.join(root, "first.json");
  const secondSource = path.join(root, "second.json");
  await writeFile(firstSource, JSON.stringify({ ...intakeDraft([]), id: "itd_review-a" }), "utf8");
  await writeFile(secondSource, JSON.stringify({ ...intakeDraft([]), id: "itd_review-b" }), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: firstSource })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_review-a" })).ok, true);
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: secondSource })).ok, true);

  const beforeDisplay = await resolveReviewedDraftDecision({ repositoryRoot: root });
  assert.equal(beforeDisplay.ok, false);
  assert.ok(beforeDisplay.diagnostics.some((entry) => entry.code === "draft_review_required"));
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_review-b" })).ok, true);
  assert.deepEqual(await resolveReviewedDraftDecision({ repositoryRoot: root }), { ok: true, draftId: "itd_review-b" });
});

test("accept and discard races cannot be overwritten by replacement", async (t) => {
  for (const transition of ["accept", "discard"]) {
    await t.test(transition, async (t) => {
      const root = await scratch(t);
      const firstSource = path.join(root, "first.json");
      const secondSource = path.join(root, "second.json");
      await writeFile(firstSource, JSON.stringify({ ...intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper")
      ]), id: `itd_${transition}-old` }), "utf8");
      await writeFile(secondSource, JSON.stringify({ ...intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper Revised")
      ]), id: `itd_${transition}-new` }), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: firstSource })).ok, true);
      let entered;
      let release;
      const atLease = new Promise((resolve) => { entered = resolve; });
      const proceed = new Promise((resolve) => { release = resolve; });
      const transitionPromise = transition === "accept"
        ? acceptStagedDraft({
            repositoryRoot: root,
            draftId: `itd_${transition}-old`,
            createdAt: "2026-08-08T20:00:00.000Z",
            afterLeaseAcquired: async () => { entered(); await proceed; }
          })
        : discardStagedDraft({
            repositoryRoot: root,
            draftId: `itd_${transition}-old`,
            afterLeaseAcquired: async () => { entered(); await proceed; }
          });
      await atLease;
      const replacement = await stageIntakeDraft({ repositoryRoot: root, draftFile: secondSource });
      assert.equal(replacement.ok, false);
      assert.ok(replacement.diagnostics.some((entry) => entry.code === "draft_transition_in_progress"));
      release();
      const transitioned = await transitionPromise;
      assert.equal(transitioned.ok, true);
      const oldDraft = JSON.parse(await readFile(path.join(root, `.legion/project/intake/drafts/itd_${transition}-old.json`), "utf8"));
      assert.equal(oldDraft.status, transition === "accept" ? "accepted" : "discarded");
      await assert.rejects(readFile(path.join(root, `.legion/project/intake/drafts/itd_${transition}-new.json`)), { code: "ENOENT" });
    });
  }
});

test("constant transition lock linearizes two first-stage acquisitions", async (t) => {
  const root = await scratch(t);
  const firstSource = path.join(root, "first.json");
  const secondSource = path.join(root, "second.json");
  await writeFile(firstSource, JSON.stringify({ ...intakeDraft([]), id: "itd_first-a" }), "utf8");
  await writeFile(secondSource, JSON.stringify({ ...intakeDraft([]), id: "itd_first-b" }), "utf8");
  let entered;
  let release;
  const atLease = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  let firstFinished = false;
  const first = stageIntakeDraft({
    repositoryRoot: root,
    draftFile: firstSource,
    afterLeaseAcquired: async (leasePath) => { entered(leasePath); await proceed; }
  }).finally(() => { firstFinished = true; });
  const observed = await Promise.race([
    atLease.then((leasePath) => ({ entered: true, leasePath })),
    first.then(() => ({ entered: false })),
    new Promise((resolve) => setTimeout(() => resolve({ entered: false }), 250))
  ]);
  assert.equal(observed.entered, true, "stage never exposed constant-lock ownership");
  assert.match(observed.leasePath, /intake-transition\.lock$/u);
  const second = await stageIntakeDraft({ repositoryRoot: root, draftFile: secondSource });
  assert.equal(second.ok, false);
  assert.equal(second.diagnostics[0].code, "draft_transition_in_progress");
  release();
  assert.equal((await first).ok, true);
  assert.equal(firstFinished, true);
  await assert.rejects(readFile(path.join(root, ".legion/project/intake/drafts/itd_first-b.json")), { code: "ENOENT" });
});

test("a definitively dead constant lock owner is reclaimed", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  assert.ok(Number.isInteger(deadPid));
  await once(child, "exit");
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(transactions, { recursive: true });
  const lockPath = path.join(transactions, "intake-transition.lock");
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: deadPid,
    token: "dead-owner",
    createdAt: "2026-08-08T12:00:00.000Z"
  })}\n`, "utf8");

  const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
  assert.equal(staged.ok, true, JSON.stringify(staged.diagnostics));
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("malformed or incomplete constant lock metadata remains busy", async (t) => {
  for (const [name, bytes] of [["incomplete", ""], ["malformed", "{"], ["missing-token", `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    createdAt: "2026-08-08T12:00:00.000Z"
  })}\n`]]) {
    await t.test(name, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
      const transactions = path.join(root, ".legion/project/intake/transactions");
      await mkdir(transactions, { recursive: true });
      const lockPath = path.join(transactions, "intake-transition.lock");
      await writeFile(lockPath, bytes, "utf8");

      const staged = await stageIntakeDraft({ repositoryRoot: root, draftFile: source });
      assert.equal(staged.ok, false);
      assert.equal(staged.diagnostics[0].code, "draft_transition_in_progress");
      assert.equal(await readFile(lockPath, "utf8"), bytes);
      await assert.rejects(readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json")), { code: "ENOENT" });
    });
  }
});

test("release cannot delete a successor constant lock", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  let successorBytes;
  const accepted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    beforeLeaseRelease: async () => {
      const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
      await rm(lockPath);
      successorBytes = `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        token: "successor-owner",
        createdAt: "2026-08-08T20:00:00.001Z"
      })}\n`;
      await writeFile(lockPath, successorBytes, { flag: "wx" });
    }
  });
  assert.equal(accepted.ok, true);
  assert.equal(
    await readFile(path.join(root, ".legion/project/intake/transactions/intake-transition.lock"), "utf8"),
    successorBytes
  );
});

test("release revalidates immediately before renaming the constant lock", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "late-release-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  const discarded = await discardStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    beforeLeaseReleaseRename: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.equal(discarded.ok, true);
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("concurrent replacements of the same prior publish only one draft", async (t) => {
  const root = await scratch(t);
  const oldSource = path.join(root, "old.json");
  const firstSource = path.join(root, "first.json");
  const secondSource = path.join(root, "second.json");
  await writeFile(oldSource, JSON.stringify({ ...intakeDraft([]), id: "itd_concurrent-old" }), "utf8");
  await writeFile(firstSource, JSON.stringify({ ...intakeDraft([]), id: "itd_concurrent-a" }), "utf8");
  await writeFile(secondSource, JSON.stringify({ ...intakeDraft([]), id: "itd_concurrent-b" }), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: oldSource })).ok, true);
  let entered;
  let release;
  const atLease = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  const first = stageIntakeDraft({
    repositoryRoot: root,
    draftFile: firstSource,
    afterLeaseAcquired: async () => { entered(); await proceed; }
  });
  const observed = await Promise.race([atLease.then(() => true), first.then(() => false), new Promise((resolve) => setTimeout(() => resolve(false), 250))]);
  assert.equal(observed, true, "replacement never exposed transition ownership");
  const second = await stageIntakeDraft({ repositoryRoot: root, draftFile: secondSource });
  assert.equal(second.ok, false);
  assert.equal(second.diagnostics[0].code, "draft_transition_in_progress");
  release();
  assert.equal((await first).ok, true);
  const drafts = await Promise.all(["old", "a"].map(async (suffix) => JSON.parse(await readFile(
    path.join(root, `.legion/project/intake/drafts/itd_concurrent-${suffix}.json`), "utf8"
  ))));
  assert.deepEqual(drafts.filter((draft) => draft.status === "draft").map((draft) => draft.id), ["itd_concurrent-a"]);
  await assert.rejects(readFile(path.join(root, ".legion/project/intake/drafts/itd_concurrent-b.json")), { code: "ENOENT" });
});

test("replacement recovery never publishes beside a different open draft", async (t) => {
  const root = await scratch(t);
  const drafts = path.join(root, ".legion/project/intake/drafts");
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(drafts, { recursive: true });
  await mkdir(transactions, { recursive: true });
  const prior = { ...intakeDraft([]), id: "itd_recovery-prior", status: "invalidated" };
  const other = { ...intakeDraft([]), id: "itd_recovery-other" };
  const replacement = { ...intakeDraft([]), id: "itd_recovery-new" };
  await writeFile(path.join(drafts, "itd_recovery-prior.json"), `${JSON.stringify(prior, undefined, 2)}\n`, "utf8");
  await writeFile(path.join(drafts, "itd_recovery-other.json"), `${JSON.stringify(other, undefined, 2)}\n`, "utf8");
  await writeFile(path.join(transactions, "draft-replacement.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "draft-replacement",
    priorDraftId: prior.id,
    priorDraftSha256: `sha256:${"0".repeat(64)}`,
    replacement
  }, undefined, 2)}\n`, "utf8");

  await recoverIntakeLifecycleArtifacts(root);

  await assert.rejects(readFile(path.join(drafts, "itd_recovery-new.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(drafts, "itd_recovery-other.json"), "utf8")).status, "draft");
  await readFile(path.join(transactions, "draft-replacement.json"));
});

test("concurrent acceptors create exactly one session for a draft", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  const results = await Promise.all([
    acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z" }),
    acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.001Z" })
  ]);

  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.equal((await listSessions(root)).length, 1);
  assert.ok(results.some((entry) => !entry.ok && entry.diagnostics.some((diagnostic) => diagnostic.code === "draft_acceptance_in_progress" || diagnostic.code === "draft_not_open")));
});

test("stage rechecks active session under its transition lease after driver preparation", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const originalSource = path.join(root, "original.json");
  const replacementRelative = ".legion/host-input/replacement.json";
  const replacementSource = path.join(root, replacementRelative);
  const original = {
    ...intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]),
    id: "itd_stage-session-original"
  };
  const replacement = {
    ...intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper Revised")]),
    id: "itd_stage-session-replacement"
  };
  await writeFile(originalSource, JSON.stringify(original), "utf8");
  await mkdir(path.dirname(replacementSource), { recursive: true });
  await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: originalSource })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: original.id })).ok, true);

  let signalPaused;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  let resumeStage;
  const resume = new Promise((resolve) => { resumeStage = resolve; });
  const context = {
    repositoryRoot: root,
    cwd: root,
    json: true,
    noColor: true,
    args: {
      positionals: [],
      options: new Map([
        ["stage-draft", replacementRelative],
        ["goal", original.initiative],
        ["created-at", "2026-08-08T20:00:00.000Z"]
      ])
    }
  };
  const staging = handleStageDraft(context, {
    afterPreparationBeforeStage: async () => {
      signalPaused();
      await resume;
    }
  });
  const boundary = await outcomeWithin(Promise.race([
    paused.then(() => "paused"),
    staging.then(() => "completed")
  ]), 2_000, "driver preparation/stage boundary");
  assert.equal(boundary, "paused", "stage completed before the driver-boundary failpoint");

  let accepted;
  try {
    accepted = await outcomeWithin(acceptStagedDraft({
      repositoryRoot: root,
      draftId: original.id,
      createdAt: "2026-08-08T20:00:01.000Z",
      requireReviewed: true
    }), 2_000, "acceptance during stage preparation release");
    assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
  } finally {
    resumeStage();
  }
  const sessionPath = path.join(root, `.legion/project/intake/${accepted.session.id}/session.json`);
  const sessionBytes = await readFile(sessionPath);
  const staged = await outcomeWithin(staging, 2_000, "stage resumed after acceptance");

  assert.equal(staged.exitCode, 1);
  assert.equal(staged.payload.status, "rejected");
  assert.ok(staged.payload.diagnostics.some((entry) => entry.code === "active_session"));
  await assert.rejects(
    readFile(path.join(root, ".legion/project/intake/drafts/itd_stage-session-replacement.json")),
    { code: "ENOENT" }
  );
  assert.deepEqual(await readFile(sessionPath), sessionBytes);
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_stage-session-original.json"), "utf8")).status,
    "accepted"
  );
});

test("acceptance fences every preparation rewrite until its matching draft commits", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([
    draftAnswer("project-name", "project.name", "Asset Mapper")
  ])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
  await exploration(root, "alternate", "2026-08-08T19:59:59.000Z");

  const preflightPath = path.join(root, ".legion/project/intake/preflight.json");
  const beforePreflight = await readFile(preflightPath);
  let signalPaused;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  let releaseAcceptance;
  const release = new Promise((resolve) => { releaseAcceptance = resolve; });
  const acceptance = acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterInitialBindingValidation: async () => {
      signalPaused();
      await release;
    }
  });

  const boundary = await outcomeWithin(Promise.race([
    paused.then(() => "paused"),
    acceptance.then(() => "completed")
  ]), 2_000, "acceptance binding pause");
  assert.equal(boundary, "paused", "acceptance completed before the binding-validation pause");
  const pausedSnapshot = await filesystemBytes(root);

  const preparationAttempts = [
    ["--goal", "Concurrent replacement initiative"],
    ["--from-exploration", "alternate"],
    ["--without-exploration"],
    ["--map-failed", "concurrent map failure"]
  ];
  for (const [index, args] of preparationAttempts.entries()) {
    const attempted = await outcomeWithin(runCliCapture([
      "--repository-root", root,
      "start", ...args,
      "--json", "--created-at", `2026-08-08T20:00:0${index + 1}.000Z`
    ]), 3_000, `busy preparation ${args[0]}`);
    assert.equal(attempted.exitCode, 1, `${attempted.stderr}\n${attempted.stdout}`);
    const payload = parseJsonOutput(attempted);
    assert.equal(payload.status, "rejected");
    assert.ok(payload.diagnostics.some((entry) => entry.code === "intake_transition_in_progress"));
    assert.deepEqual(await filesystemBytes(root), pausedSnapshot, `${args[0]} mutated state while acceptance held the lease`);
    assert.deepEqual(await readFile(preflightPath), beforePreflight);
  }

  releaseAcceptance();
  const accepted = await outcomeWithin(acceptance, 2_000, "acceptance release");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.draft.initiative, "Create an asset mapper.");
  assert.equal(accepted.session.answers[0].value, "Asset Mapper");

  const updated = await outcomeWithin(prepareIntakePreflight({
    repositoryRoot: root,
    createdAt: "2026-08-08T20:00:10.000Z",
    explicitGoal: "Preparation after acceptance"
  }), 2_000, "preparation after acceptance");
  assert.equal(updated.initiative.value, "Preparation after acceptance");
});

test("an incomplete fresh acceptance lease is never stolen", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(transactions, { recursive: true });
  await writeFile(path.join(transactions, "itd_asset-mapper.json.lock.00000001.incomplete.json"), "", "utf8");

  const attempted = await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z" });

  assert.equal(attempted.ok, false);
  assert.equal(attempted.diagnostics[0].code, "draft_acceptance_in_progress");
  assert.deepEqual(await listSessions(root), []);
});

test("an aged malformed published lease claim remains blocking and migration-required", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(transactions, { recursive: true });
  const claim = path.join(transactions, "itd_asset-mapper.json.lock.00000001.malformed.json");
  await writeFile(claim, "{", "utf8");
  await import("node:fs/promises").then(({ utimes }) => utimes(claim, new Date(0), new Date(0)));

  const attempted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z"
  });

  assert.equal(attempted.ok, false);
  assert.equal(attempted.diagnostics[0].code, "draft_acceptance_in_progress");
  await import("node:fs/promises").then(({ stat }) => stat(claim));
  const initialized = await initProject({
    repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
    decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
  });
  assert.equal(initialized.ok, false);
  assert.equal(initialized.status, "migration_required");
});

test("expired generation zero and negative published claims remain and block acquisition", async (t) => {
  for (const { label, generation, fileGeneration } of [
    { label: "zero", generation: 0, fileGeneration: "00000000" },
    { label: "negative", generation: -1, fileGeneration: "00000001" }
  ]) {
    await t.test(label, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper")
      ])), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
      const transactions = path.join(root, ".legion/project/intake/transactions");
      await mkdir(transactions, { recursive: true });
      const claim = path.join(
        transactions,
        `itd_asset-mapper.json.lock.${fileGeneration}.${label}.json`
      );
      const claimBytes = JSON.stringify({
        schemaVersion: 1,
        generation,
        token: label,
        pid: 99999999,
        createdAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:01:00.000Z"
      });
      await writeFile(claim, claimBytes, "utf8");
      await utimes(claim, new Date(0), new Date(0));

      const before = await filesystemBytes(root);
      await assert.rejects(
        prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:00.000Z" }),
        (error) => error?.code === "EPENDINGACCEPTANCEBLOCKED"
      );

      assert.deepEqual(await filesystemBytes(root), before, `${label} claim did not block byte-for-byte`);
      assert.equal(await readFile(claim, "utf8"), claimBytes, `${label} claim was age-deleted`);
      const attempted = await acceptStagedDraft({
        repositoryRoot: root,
        draftId: "itd_asset-mapper",
        createdAt: "2026-08-08T20:00:01.000Z"
      });
      assert.equal(attempted.ok, false);
      assert.equal(attempted.diagnostics[0].code, "draft_acceptance_in_progress");
      assert.equal(await readFile(claim, "utf8"), claimBytes, `${label} claim changed during acquisition`);
    });
  }
});

test("acceptance acquisition interleaving keeps the first atomic lease owner", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  let enteredResolve;
  let continueResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const proceed = new Promise((resolve) => { continueResolve = resolve; });
  const first = acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterLeaseAcquired: async () => { enteredResolve(true); await proceed; }
  });
  const observed = await Promise.race([entered, new Promise((resolve) => setTimeout(() => resolve(false), 100))]);
  assert.equal(observed, true, "acceptance did not expose the acquisition interleaving failpoint");
  const second = await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.001Z" });
  assert.equal(second.ok, false);
  assert.equal(second.diagnostics[0].code, "draft_acceptance_in_progress");
  continueResolve();
  assert.equal((await first).ok, true);
  assert.equal((await listSessions(root)).length, 1);
});

test("a live PID owner cannot be stolen even when its timestamp is old", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  let firstEntered;
  let firstProceed;
  const firstAtLease = new Promise((resolve) => { firstEntered = resolve; });
  const releaseFirst = new Promise((resolve) => { firstProceed = resolve; });
  const first = acceptStagedDraft({
    repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z",
    afterLeaseAcquired: async (leasePath) => { firstEntered(leasePath); await releaseFirst; }
  });
  const lockPath = await firstAtLease;
  const owner = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(lockPath, "utf8")));
  owner.createdAt = "2000-01-01T00:00:00.000Z";
  await writeFile(lockPath, JSON.stringify(owner), "utf8");
  const second = await acceptStagedDraft({
    repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.001Z"
  });
  assert.equal(second.ok, false);
  assert.equal(second.diagnostics[0].code, "draft_acceptance_in_progress");
  firstProceed();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal((await listSessions(root)).length, 1);
});

test("an owner that loses the constant token cannot progress or delete its successor", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  let firstLeasePath;
  let entered;
  let proceed;
  const atLease = new Promise((resolve) => { entered = resolve; });
  const releaseOwner = new Promise((resolve) => { proceed = resolve; });
  const first = acceptStagedDraft({
    repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z",
    afterLeaseAcquired: async (leasePath) => { firstLeasePath = leasePath; entered(); await releaseOwner; }
  });
  await atLease;
  await rm(firstLeasePath);
  const successorBytes = `${JSON.stringify({
    schemaVersion: 1, pid: process.pid, token: "successor-token", createdAt: "2026-08-08T20:00:00.001Z"
  })}\n`;
  await writeFile(firstLeasePath, successorBytes, { flag: "wx" });
  proceed();
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "draft_acceptance_lease_lost");
  assert.equal(await readFile(firstLeasePath, "utf8"), successorBytes);
  assert.deepEqual(await listSessions(root), []);
});

test("acceptance recovery cannot delete a prepared session or journal after token loss", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const crashedId = await allocateSessionId(root, "2026-08-08T20:00:00.000Z");
  const journal = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify({ schemaVersion: 1, draftId: "itd_asset-mapper", sessionId: crashedId }), "utf8");
  const reservationPath = path.join(root, `.legion/project/intake/${crashedId}`);
  const beforeJournal = await readFile(journal);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "recovery-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  const attempted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:01.000Z",
    beforeAcceptanceRecoveryMutation: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "draft_acceptance_lease_lost"));
  assert.deepEqual(await readdir(reservationPath), []);
  assert.deepEqual(await readFile(journal), beforeJournal);
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("acceptance cannot publish a session after late token loss", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "session-publish-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  const attempted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    beforeSessionPublish: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.equal(attempted.ok, false);
  assert.equal(JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8")).status, "draft");
  assert.deepEqual(await listSessions(root), []);
  await assert.rejects(readFile(path.join(root, ".legion/project/intake/itk_20260808-200000000/session.json")), { code: "ENOENT" });
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("acceptance revalidates durable binding immediately before session and draft publication", async (t) => {
  for (const hook of ["beforeSessionPublish", "beforeDraftCommit"]) {
    await t.test(hook, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([
        draftAnswer("project-name", "project.name", "Asset Mapper")
      ])), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
      assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
      const preflightPath = path.join(root, ".legion/project/intake/preflight.json");

      const attempted = await acceptStagedDraft({
        repositoryRoot: root,
        draftId: "itd_asset-mapper",
        createdAt: "2026-08-08T20:00:00.000Z",
        requireReviewed: true,
        [hook]: async () => {
          const changed = JSON.parse(await readFile(preflightPath, "utf8"));
          changed.updatedAt = "2026-08-08T20:00:00.001Z";
          changed.initiative = { value: "Changed at the commit boundary", source: "explicit" };
          await writeFile(preflightPath, `${JSON.stringify(changed, undefined, 2)}\n`, "utf8");
        }
      });

      assert.equal(attempted.ok, false);
      assert.ok(attempted.diagnostics.some((entry) => entry.code === "preflight_initiative_mismatch"));
      assert.deepEqual(await listSessions(root), []);
      const draft = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8"));
      assert.equal(draft.status, "draft");
    });
  }
});

test("discard revalidates durable binding immediately before its draft CAS", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
  const preflightPath = path.join(root, ".legion/project/intake/preflight.json");

  const attempted = await discardStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    requireReviewed: true,
    afterInitialBindingValidation: async () => {
      const changed = JSON.parse(await readFile(preflightPath, "utf8"));
      changed.updatedAt = "2026-08-08T20:00:00.001Z";
      changed.initiative = { value: "Changed before discard CAS", source: "explicit" };
      await writeFile(preflightPath, `${JSON.stringify(changed, undefined, 2)}\n`, "utf8");
    }
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "preflight_initiative_mismatch"));
  const draft = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8"));
  assert.equal(draft.status, "draft");
});

test("discard revalidates the exact reviewed record immediately before its draft CAS", { timeout: 15_000 }, async (t) => {
  for (const variant of ["mutated-token", "deleted", "rebound"]) {
    await t.test(variant, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
      assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
      const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
      const beforeDecisionBytes = await draftAndSessionBytes(root);

      const attempted = await outcomeWithin(discardStagedDraft({
        repositoryRoot: root,
        draftId: "itd_asset-mapper",
        requireReviewed: true,
        afterInitialBindingValidation: async () => {
          if (variant === "deleted") {
            await rm(reviewPath);
            return;
          }
          const review = JSON.parse(await readFile(reviewPath, "utf8"));
          review.token = variant === "mutated-token" ? "mutated-after-initial-validation" : "rebound-after-initial-validation";
          if (variant === "rebound") review.draftId = "itd_rebound-review";
          await writeFile(reviewPath, `${JSON.stringify(review, undefined, 2)}\n`, "utf8");
        }
      }), 2_000, `discard active-review ${variant}`);

      assert.equal(attempted.ok, false, `${variant} review change was discarded`);
      assert.ok(attempted.diagnostics.some((entry) =>
        entry.code === "stale_draft_decision" || entry.code === "draft_review_required"
      ), JSON.stringify(attempted.diagnostics));
      assert.deepEqual(await draftAndSessionBytes(root), beforeDecisionBytes);
    });
  }
});

test("accept and discard cannot rebind a digest-mismatched review after token loss", async (t) => {
  for (const transition of ["accept", "discard"]) {
    await t.test(transition, async (t) => {
      const root = await scratch(t);
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
      assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: "itd_asset-mapper" })).ok, true);
      const draftPath = path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json");
      const changed = JSON.parse(await readFile(draftPath, "utf8"));
      changed.diagnostics.push("changed after display");
      await writeFile(draftPath, `${JSON.stringify(changed, undefined, 2)}\n`, "utf8");
      const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
      const beforeReview = await readFile(reviewPath);
      const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
      const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: `${transition}-digest-successor`, createdAt: "2026-08-08T20:00:00.001Z" })}\n`;
      const beforeActiveReviewMismatchRebind = async () => {
        await rm(lockPath);
        await writeFile(lockPath, successor, { flag: "wx" });
      };

      const attempted = transition === "accept"
        ? await acceptStagedDraft({
            repositoryRoot: root,
            draftId: "itd_asset-mapper",
            createdAt: "2026-08-08T20:00:01.000Z",
            requireReviewed: true,
            beforeActiveReviewMismatchRebind
          })
        : await discardStagedDraft({
            repositoryRoot: root,
            draftId: "itd_asset-mapper",
            requireReviewed: true,
            beforeActiveReviewMismatchRebind
          });

      assert.equal(attempted.ok, false);
      assert.ok(attempted.diagnostics.some((entry) => entry.code.includes("lease_lost")));
      assert.deepEqual(await readFile(reviewPath), beforeReview);
      assert.equal(await readFile(lockPath, "utf8"), successor);
      assert.equal(JSON.parse(await readFile(draftPath, "utf8")).status, "draft");
    });
  }
});

test("review display cannot publish a reviewed binding after late token loss", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
  const beforeReview = await readFile(reviewPath);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "display-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  const displayed = await publishDraftReview({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    beforeReviewPublication: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.equal(displayed.ok, false);
  assert.ok(displayed.diagnostics.some((entry) => entry.code === "draft_transition_lease_lost"));
  assert.deepEqual(await readFile(reviewPath), beforeReview);
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("a failed accepted-draft commit rolls back and a later acceptance recovers", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  const failed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    beforeDraftCommit: () => { throw new Error("injected accepted-draft write failure"); }
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(await listSessions(root), []);

  const recovered = await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:01.000Z" });
  assert.equal(recovered.ok, true);
  assert.equal((await listSessions(root)).length, 1);
});

test("a crash after acceptance-journal temporary write is attributable, recoverable, and exactly retryable", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);

  await crashAcceptanceAt(root, "afterAcceptanceJournalTemporaryWrite", 86);

  const temporaryPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json.tmp`);
  const temporary = JSON.parse(await readFile(temporaryPath, "utf8"));
  assert.deepEqual({
    schemaVersion: temporary.schemaVersion,
    phase: temporary.phase,
    draftId: temporary.draftId,
    sessionId: temporary.sessionId
  }, {
    schemaVersion: 2,
    phase: "publishing-session",
    draftId: draft.id,
    sessionId: "itk_20260808-200000000"
  });
  assert.deepEqual(await readdir(path.join(root, `.legion/project/intake/${temporary.sessionId}`)), []);

  const recovered = await recoverIntakeLifecycleArtifacts(root);
  assert.equal(recovered?.ok, true);
  assert.deepEqual(recovered.rolledBackDraftIds, [draft.id]);
  await assert.rejects(readFile(temporaryPath), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(root, `.legion/project/intake/${temporary.sessionId}`)), { code: "ENOENT" });
  const stable = await filesystemBytes(root);
  await recoverIntakeLifecycleArtifacts(root);
  assert.deepEqual(await filesystemBytes(root), stable, "journal-publication recovery was not idempotent");

  const retried = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: draft.id,
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.session.id, temporary.sessionId);
  assert.deepEqual(retried.session.answers.map((answer) => answer.draftAcceptedFrom), [
    { draftId: draft.id, answerAnchor: "project-name" }
  ]);
  assert.deepEqual(await listSessions(root), [temporary.sessionId]);
});

test("crashes after temporary and final session publication roll back exact journaled bytes and retry once", { timeout: 30_000 }, async (t) => {
  for (const fixture of [
    { hook: "afterSessionTemporaryWrite", exitCode: 87, entry: "session.json.tmp" },
    { hook: "afterSessionPublish", exitCode: 88, entry: "session.json" }
  ]) {
    await t.test(fixture.hook, { timeout: 15_000 }, async (t) => {
      const root = await scratch(t);
      const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
      await stageReviewedDraft(root, draft);

      await crashAcceptanceAt(root, fixture.hook, fixture.exitCode);

      const journalPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json`);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(journal.schemaVersion, 2);
      assert.equal(journal.phase, "publishing-session");
      assert.match(journal.draftSha256, /^sha256:[0-9a-f]{64}$/u);
      assert.match(journal.sessionSha256, /^sha256:[0-9a-f]{64}$/u);
      const reservation = path.join(root, `.legion/project/intake/${journal.sessionId}`);
      assert.deepEqual(await readdir(reservation), [fixture.entry]);

      const recovered = await recoverIntakeLifecycleArtifacts(root);
      assert.equal(recovered?.ok, true);
      assert.deepEqual(recovered.rolledBackDraftIds, [draft.id]);
      await assert.rejects(readFile(journalPath), { code: "ENOENT" });
      await assert.rejects(readdir(reservation), { code: "ENOENT" });
      const stable = await filesystemBytes(root);
      await recoverIntakeLifecycleArtifacts(root);
      assert.deepEqual(await filesystemBytes(root), stable, `${fixture.hook} recovery was not idempotent`);

      const retried = await acceptStagedDraft({
        repositoryRoot: root,
        draftId: draft.id,
        createdAt: "2026-08-08T20:00:00.000Z",
        requireReviewed: true
      });
      assert.equal(retried.ok, true);
      assert.equal(retried.session.id, journal.sessionId);
      assert.deepEqual(retried.session.answers.map((answer) => answer.draftAcceptedFrom), [
        { draftId: draft.id, answerAnchor: "project-name" }
      ]);
      assert.deepEqual(await listSessions(root), [journal.sessionId]);
    });
  }
});

test("session-publication recovery revalidates its fence before touching an attributable final session", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  await crashAcceptanceAt(root, "afterSessionPublish", 89);

  const journalPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json`);
  const journalBefore = await readFile(journalPath);
  const journal = JSON.parse(journalBefore.toString("utf8"));
  const sessionPath = path.join(root, `.legion/project/intake/${journal.sessionId}/session.json`);
  const sessionBefore = await readFile(sessionPath);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "session-recovery-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  const attempted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: draft.id,
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    beforeAcceptanceRecoveryMutation: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "draft_acceptance_lease_lost"));
  assert.deepEqual(await readFile(journalPath), journalBefore);
  assert.deepEqual(await readFile(sessionPath), sessionBefore);
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("mismatched bytes in a journaled session-publication phase block byte-identically", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  await crashAcceptanceAt(root, "afterSessionPublish", 90);
  const journalPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const sessionPath = path.join(root, `.legion/project/intake/${journal.sessionId}/session.json`);
  const changed = JSON.parse(await readFile(sessionPath, "utf8"));
  changed.diagnostics = ["unattributed mutation"];
  await writeFile(sessionPath, `${JSON.stringify(changed, undefined, 2)}\n`, "utf8");
  const journalBefore = await readFile(journalPath);
  const sessionBefore = await readFile(sessionPath);
  const draftBefore = await readFile(path.join(root, `.legion/project/intake/drafts/${draft.id}.json`));

  const recovered = await recoverIntakeLifecycleArtifacts(root);

  assert.equal(recovered?.ok, false);
  assert.ok(recovered.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await readFile(journalPath), journalBefore);
  assert.deepEqual(await readFile(sessionPath), sessionBefore);
  assert.deepEqual(await readFile(path.join(root, `.legion/project/intake/drafts/${draft.id}.json`)), draftBefore);
});

test("journaled session rollback resumes after catch cleanup removed the reservation", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  await crashAcceptanceAt(root, "afterSessionPublish", 91);

  const journalPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const reservationPath = path.join(root, `.legion/project/intake/${journal.sessionId}`);
  await rm(path.join(reservationPath, "session.json"));
  await rmdir(reservationPath);

  const recovered = await recoverIntakeLifecycleArtifacts(root);

  assert.equal(recovered?.ok, true);
  assert.deepEqual(recovered.rolledBackDraftIds, [draft.id]);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
  await assert.rejects(readdir(reservationPath), { code: "ENOENT" });
  const retried = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: draft.id,
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.session.id, journal.sessionId);
});

test("acceptance exposes the durable journal publication boundary before publishing its session", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([
    draftAnswer("project-name", "project.name", "Asset Mapper")
  ])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  let observedJournal;
  let releaseAcceptance;
  const journalPublished = new Promise((resolve) => { observedJournal = resolve; });
  const continueAcceptance = new Promise((resolve) => { releaseAcceptance = resolve; });
  const acceptance = acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterAcceptanceJournal: async () => {
      const journal = JSON.parse(await readFile(
        path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json"),
        "utf8"
      ));
      assert.equal(journal.draftId, "itd_asset-mapper");
      assert.deepEqual(
        await readdir(path.join(root, `.legion/project/intake/${journal.sessionId}`)),
        [],
        "the session reservation was not empty at the journal boundary"
      );
      observedJournal(journal);
      await continueAcceptance;
    }
  });

  const journal = await outcomeWithin(journalPublished, 2_000, "acceptance journal publication hook");
  assert.equal(journal.sessionId, "itk_20260808-200000000");
  releaseAcceptance();
  assert.equal((await outcomeWithin(acceptance, 2_000, "acceptance after journal hook")).ok, true);
});

test("pending acceptance journal blocks replacement before the accepting draft can be invalidated", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  const replacementSource = path.join(root, "replacement.json");
  const original = intakeDraft([
    draftAnswer("project-name", "project.name", "Asset Mapper")
  ]);
  const replacementDraft = { ...original, id: "itd_pending-replacement" };
  await writeFile(source, JSON.stringify(original), "utf8");
  await writeFile(replacementSource, JSON.stringify(replacementDraft), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  assert.equal((await publishDraftReview({ repositoryRoot: root, draftId: original.id })).ok, true);

  let observedJournal;
  let releaseAcceptance;
  const journalPublished = new Promise((resolve) => { observedJournal = resolve; });
  const continueAcceptance = new Promise((resolve) => { releaseAcceptance = resolve; });
  const acceptance = acceptStagedDraft({
    repositoryRoot: root,
    draftId: original.id,
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterAcceptanceJournal: async () => {
      observedJournal(JSON.parse(await readFile(
        path.join(root, `.legion/project/intake/transactions/${original.id}.json`),
        "utf8"
      )));
      await continueAcceptance;
    }
  });
  const journal = await outcomeWithin(journalPublished, 2_000, "prepared acceptance journal");
  const reservation = path.join(root, `.legion/project/intake/${journal.sessionId}`);
  assert.deepEqual(await readdir(reservation), [], "acceptance published session bytes before the crash boundary");
  assert.deepEqual(await listSessions(root), [], "empty acceptance reservation became an active session");

  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  await rm(lockPath);
  releaseAcceptance();
  const interrupted = await outcomeWithin(acceptance, 2_000, "interrupted acceptance unwind");
  assert.equal(interrupted.ok, false);
  assert.deepEqual(await readdir(reservation), [], "lease-lost acceptance removed or populated its reservation");

  const replacement = await stageIntakeDraftBound({
    repositoryRoot: root,
    draftFile: replacementSource,
    createdAt: "2026-08-08T20:00:01.000Z"
  });
  const originalPath = path.join(root, `.legion/project/intake/drafts/${original.id}.json`);
  const replacementPath = path.join(root, `.legion/project/intake/drafts/${replacementDraft.id}.json`);
  const journalPath = path.join(root, `.legion/project/intake/transactions/${original.id}.json`);
  let replacementStatus = "absent";
  try { replacementStatus = JSON.parse(await readFile(replacementPath, "utf8")).status; } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  let journalPresent = true;
  try { await readFile(journalPath); } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") journalPresent = false;
    else throw error;
  }
  let reservationPresent = true;
  try { await readdir(reservation); } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") reservationPresent = false;
    else throw error;
  }
  const initialized = journalPresent
    ? await initProject({
        repositoryRoot: root,
        slug: "asset-mapper",
        name: "Asset Mapper",
        decisionOwners: [{ kind: "human", id: "owner" }],
        createdAt: "2026-08-08T21:00:00.000Z"
      })
    : undefined;

  assert.deepEqual({
    replacementOk: replacement.ok,
    originalStatus: JSON.parse(await readFile(originalPath, "utf8")).status,
    replacementStatus,
    journalPresent,
    reservationPresent,
    initializationStatus: initialized?.status ?? "not_attempted"
  }, {
    replacementOk: false,
    originalStatus: "draft",
    replacementStatus: "absent",
    journalPresent: false,
    reservationPresent: false,
    initializationStatus: "not_attempted"
  });
});

test("prepared recovery exposes the boundary after its reservation leaves the canonical session path", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);
  let observedBoundary;
  let releaseBoundary;
  const boundaryReached = new Promise((resolve) => { observedBoundary = resolve; });
  const continueRecovery = new Promise((resolve) => { releaseBoundary = resolve; });

  const recovery = recoverIntakeLifecycleArtifacts(root, {
    afterAcceptanceReservationRemoved: async () => {
      await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
      observedBoundary();
      await continueRecovery;
    }
  });

  await outcomeWithin(boundaryReached, 2_000, "acceptance reservation rollback hook");
  releaseBoundary();
  await outcomeWithin(recovery, 2_000, "acceptance rollback after reservation hook");
});

test("prepared rollback resumes after interruption between reservation and journal removal", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);
  const markerPath = `${pending.journalPath}.rollback`;
  const journalBytes = await readFile(pending.journalPath);
  const draftPath = path.join(root, `.legion/project/intake/drafts/${draft.id}.json`);
  const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
  const draftBytes = await readFile(draftPath);
  const reviewBytes = await readFile(reviewPath);

  await recoverIntakeLifecycleArtifacts(root, {
    afterAcceptanceReservationRemoved: () => {
      throw new Error("injected interruption after acceptance reservation removal");
    }
  });

  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(markerPath), journalBytes);
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(draftPath), draftBytes);
  assert.deepEqual(await readFile(reviewPath), reviewBytes);

  await recoverIntakeLifecycleArtifacts(root);

  await assert.rejects(readFile(markerPath), { code: "ENOENT" });
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(draftPath), draftBytes);
  assert.deepEqual(await readFile(reviewPath), reviewBytes);
  const recovered = await filesystemBytes(root);
  await recoverIntakeLifecycleArtifacts(root);
  assert.deepEqual(await filesystemBytes(root), recovered, "repeated rollback recovery changed reconciled state");
});

test("preparation stops after prepared rollback before recovering a coexisting replacement journal", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);
  const draftPath = path.join(root, `.legion/project/intake/drafts/${draft.id}.json`);
  const originalRaw = await readFile(draftPath);
  const original = JSON.parse(originalRaw.toString("utf8"));
  const replacement = { ...original, id: "itd_replacement-after-pending" };
  const replacementPath = path.join(root, `.legion/project/intake/drafts/${replacement.id}.json`);
  const replacementJournalPath = path.join(root, ".legion/project/intake/transactions/draft-replacement.json");
  const replacementJournalBytes = `${JSON.stringify({
    schemaVersion: 1,
    kind: "draft-replacement",
    priorDraftId: original.id,
    priorDraftSha256: `sha256:${createHash("sha256").update(originalRaw).digest("hex")}`,
    replacement
  }, undefined, 2)}\n`;
  await writeFile(replacementJournalPath, replacementJournalBytes, "utf8");
  const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
  const reviewRaw = await readFile(reviewPath);

  await assert.rejects(
    prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" }),
    (error) => error?.code === "EPENDINGACCEPTANCERECOVERED"
  );

  assert.deepEqual(await readFile(draftPath), originalRaw);
  assert.deepEqual(await readFile(reviewPath), reviewRaw);
  await assert.rejects(readFile(replacementPath), { code: "ENOENT" });
  assert.equal(await readFile(replacementJournalPath, "utf8"), replacementJournalBytes);
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  await assert.rejects(readFile(`${pending.journalPath}.rollback`), { code: "ENOENT" });
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
});

test("general recovery rolls back a verified empty pending acceptance exactly once", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);
  const draftPath = path.join(root, `.legion/project/intake/drafts/${draft.id}.json`);
  const reviewPath = path.join(root, ".legion/project/intake/active-review.json");
  const beforeDraft = await readFile(draftPath);
  const beforeReview = await readFile(reviewPath);

  await recoverIntakeLifecycleArtifacts(root);

  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(draftPath), beforeDraft);
  assert.deepEqual(await readFile(reviewPath), beforeReview);
  const recovered = await filesystemBytes(root);
  await recoverIntakeLifecycleArtifacts(root);
  assert.deepEqual(await filesystemBytes(root), recovered, "repeated recovery changed already reconciled state");
});

test("discard stops after pending acceptance rollback and succeeds only on explicit retry", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);
  const draftPath = path.join(root, `.legion/project/intake/drafts/${draft.id}.json`);
  const beforeDraft = await readFile(draftPath);
  const beforeReview = await readFile(path.join(root, ".legion/project/intake/active-review.json"));

  const first = await discardStagedDraft({ repositoryRoot: root, draftId: draft.id, requireReviewed: true });

  assert.equal(first.ok, false);
  assert.ok(first.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
  assert.deepEqual(await readFile(draftPath), beforeDraft);
  assert.deepEqual(await readFile(path.join(root, ".legion/project/intake/active-review.json")), beforeReview);
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });

  const retried = await discardStagedDraft({ repositoryRoot: root, draftId: draft.id, requireReviewed: true });
  assert.equal(retried.ok, true);
  assert.equal(retried.draft.status, "discarded");
});

test("bare review stops after pending acceptance recovery and displays the original draft on retry", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);

  const displayed = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--created-at", "2026-08-08T20:00:01.000Z"
  ]);

  assert.equal(displayed.exitCode, 1, displayed.stderr);
  const payload = parseJsonOutput(displayed);
  assert.equal(payload.status, "rejected");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(
    path.join(root, `.legion/project/intake/drafts/${draft.id}.json`),
    "utf8"
  )).status, "draft");

  const repeated = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--created-at", "2026-08-08T20:00:01.000Z"
  ]);
  assert.equal(repeated.exitCode, 0, repeated.stderr);
  assert.equal(parseJsonOutput(repeated).status, "draft_review");
  assert.equal(parseJsonOutput(repeated).draft.id, draft.id);
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
});

test("acceptance retry reuses the recovery authority and publishes exactly one new session", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const pending = await interruptAcceptanceAfterJournal(root, draft.id);

  const retried = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: draft.id,
    createdAt: "2026-08-08T20:00:01.000Z",
    requireReviewed: true
  });

  assert.equal(retried.ok, true);
  assert.notEqual(retried.session.id, pending.journal.sessionId);
  assert.deepEqual(await listSessions(root), [retried.session.id]);
  await assert.rejects(readFile(pending.journalPath), { code: "ENOENT" });
  await assert.rejects(readdir(pending.reservationPath), { code: "ENOENT" });
  const recovered = await filesystemBytes(root);
  await recoverIntakeLifecycleArtifacts(root);
  await recoverIntakeLifecycleArtifacts(root);
  assert.deepEqual(await filesystemBytes(root), recovered, "repeated recovery changed a completed acceptance");
});

test("invalid pending acceptance state blocks replacement byte-for-byte", async (t) => {
  for (const fixture of [
    {
      label: "malformed journal",
      prepare: async ({ journalPath }) => writeFile(journalPath, "{", "utf8")
    },
    {
      label: "mismatched draft",
      prepare: async ({ journalPath, sessionId }) => writeFile(journalPath, JSON.stringify({
        schemaVersion: 1,
        draftId: "itd_wrong-draft",
        sessionId
      }), "utf8")
    },
    {
      label: "missing reservation",
      prepare: async ({ journalPath }) => writeFile(journalPath, JSON.stringify({
        schemaVersion: 1,
        draftId: "itd_asset-mapper",
        sessionId: "itk_20260808-200000000"
      }), "utf8")
    },
    {
      label: "non-empty reservation",
      prepare: async ({ journalPath, sessionId, reservationPath }) => {
        await writeFile(path.join(reservationPath, "unexpected.bin"), "owned bytes\n", "utf8");
        await writeFile(journalPath, JSON.stringify({
          schemaVersion: 1,
          draftId: "itd_asset-mapper",
          sessionId
        }), "utf8");
      }
    }
  ]) {
    await t.test(fixture.label, async (t) => {
      const root = await scratch(t);
      const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
      await stageReviewedDraft(root, draft);
      const replacement = { ...draft, id: "itd_invalid-state-replacement" };
      const replacementSource = path.join(root, "replacement.json");
      await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
      const journalPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json`);
      await mkdir(path.dirname(journalPath), { recursive: true });
      const sessionId = fixture.label === "missing reservation"
        ? "itk_20260808-200000000"
        : await allocateSessionId(root, "2026-08-08T20:00:00.000Z");
      const reservationPath = path.join(root, `.legion/project/intake/${sessionId}`);
      await fixture.prepare({ journalPath, sessionId, reservationPath });
      const before = await filesystemBytes(root);

      const attempted = await stageIntakeDraftBound({
        repositoryRoot: root,
        draftFile: replacementSource,
        createdAt: "2026-08-08T20:00:01.000Z"
      });

      assert.equal(attempted.ok, false);
      assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
      assert.deepEqual(await filesystemBytes(root), before, `${fixture.label} changed durable state`);
    });
  }
});

test("acceptance-like transaction artifacts block replacement byte-for-byte", async (t) => {
  for (const artifactName of [
    "itd_asset-mapper.json.tmp",
    "itd_asset-mapper.json.partial",
    "itd_asset-mapper.json.lock.garbage"
  ]) {
    await t.test(artifactName, async (t) => {
      const root = await scratch(t);
      const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
      await stageReviewedDraft(root, draft);
      const replacement = { ...draft, id: "itd_transaction-artifact-replacement" };
      const replacementSource = path.join(root, "replacement.json");
      await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
      const transactions = path.join(root, ".legion/project/intake/transactions");
      await mkdir(transactions, { recursive: true });
      await writeFile(path.join(transactions, artifactName), "unexpected acceptance transaction bytes\n", "utf8");
      const before = await filesystemBytes(root);

      const attempted = await stageIntakeDraftBound({
        repositoryRoot: root,
        draftFile: replacementSource,
        createdAt: "2026-08-08T20:00:01.000Z"
      });

      assert.equal(attempted.ok, false);
      assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
      assert.deepEqual(await filesystemBytes(root), before, `${artifactName} changed durable state`);
    });
  }
});

test("the exact legacy journal publication temporary is recovered as an attributable phase", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const sessionId = await allocateSessionId(root, "2026-08-08T20:00:00.000Z");
  const temporaryPath = path.join(root, `.legion/project/intake/transactions/${draft.id}.json.tmp`);
  await mkdir(path.dirname(temporaryPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, draftId: draft.id, sessionId })}\n`, "utf8");

  const recovered = await recoverIntakeLifecycleArtifacts(root);

  assert.equal(recovered?.ok, true);
  assert.deepEqual(recovered.rolledBackDraftIds, [draft.id]);
  await assert.rejects(readFile(temporaryPath), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(root, `.legion/project/intake/${sessionId}`)), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(root, `.legion/project/intake/drafts/${draft.id}.json`), "utf8")).status, "draft");
});

test("exact legacy acceptance ownership artifacts are validated or recovered under the global lease", async (t) => {
  const claimName = (token) => `itd_asset-mapper.json.lock.00000001.${token}.json`;
  const publicationName = "itd_asset-mapper.json.lock.00000000-0000-4000-8000-000000000000.tmp";
  for (const fixture of [
    {
      label: "malformed regular claim",
      artifactName: claimName("malformed"),
      outcome: "blocked",
      create: (artifactPath) => writeFile(artifactPath, "{", "utf8")
    },
    {
      label: "claim directory",
      artifactName: claimName("directory"),
      outcome: "blocked",
      create: (artifactPath) => mkdir(artifactPath)
    },
    {
      label: "invalid claim payload",
      artifactName: claimName("payload"),
      outcome: "blocked",
      create: (artifactPath) => writeFile(artifactPath, legacyPublishedClaim({
        generation: 2,
        token: "payload",
        expiresAt: "2999-01-01T00:00:00.000Z"
      }), "utf8")
    },
    {
      label: "live valid claim",
      artifactName: claimName("live"),
      outcome: "blocked",
      create: (artifactPath) => writeFile(artifactPath, legacyPublishedClaim({
        token: "live",
        expiresAt: "2999-01-01T00:00:00.000Z"
      }), "utf8")
    },
    {
      label: "fresh publication temp",
      artifactName: publicationName,
      outcome: "blocked",
      create: (artifactPath) => writeFile(artifactPath, "incomplete live publication\n", "utf8")
    },
    {
      label: "expired dead valid claim",
      artifactName: claimName("expired"),
      outcome: "recovered",
      create: (artifactPath) => writeFile(artifactPath, legacyPublishedClaim({
        token: "expired",
        pid: 99999999,
        expiresAt: "2000-01-01T00:01:00.000Z"
      }), "utf8")
    },
    {
      label: "aged resumable publication temp",
      artifactName: publicationName,
      outcome: "recovered",
      create: async (artifactPath) => {
        await writeFile(artifactPath, "abandoned partial publication\n", "utf8");
        await utimes(artifactPath, new Date(0), new Date(0));
      }
    }
  ]) {
    await t.test(fixture.label, async (t) => {
      const root = await scratch(t);
      const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
      await stageReviewedDraft(root, draft);
      const replacement = { ...draft, id: "itd_legacy-ownership-replacement" };
      const replacementSource = path.join(root, "replacement.json");
      await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
      const transactions = path.join(root, ".legion/project/intake/transactions");
      await mkdir(transactions, { recursive: true });
      const artifactPath = path.join(transactions, fixture.artifactName);
      await fixture.create(artifactPath);
      const before = await filesystemBytes(root);

      const attempted = await stageIntakeDraftBound({
        repositoryRoot: root,
        draftFile: replacementSource,
        createdAt: "2026-08-08T20:00:01.000Z"
      });

      if (fixture.outcome === "blocked") {
        assert.equal(attempted.ok, false, `${fixture.label} was silently ignored`);
        assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
        assert.deepEqual(await filesystemBytes(root), before, `${fixture.label} changed durable state`);
      } else {
        assert.equal(attempted.ok, true, fixture.label);
        await assert.rejects(lstat(artifactPath), { code: "ENOENT" });
      }
    });
  }
});

test("bare acceptance rechecks a live legacy per-draft owner acquired after the global lease", { timeout: 15_000 }, async (t) => {
  const root = await scratch(t);
  await stageReviewedDraft(root);
  let signalGlobalLease;
  let releaseAcceptance;
  const globalLeaseHeld = new Promise((resolve) => { signalGlobalLease = resolve; });
  const continueAcceptance = new Promise((resolve) => { releaseAcceptance = resolve; });
  const acceptance = acceptStagedDraft({
    repositoryRoot: root,
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterLeaseAcquired: async () => {
      signalGlobalLease();
      await continueAcceptance;
    }
  });
  await outcomeWithin(globalLeaseHeld, 2_000, "bare acceptance global lease");
  const claimPath = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json.lock.00000001.legacy-live.json");
  const claimBytes = legacyPublishedClaim({ token: "legacy-live", expiresAt: "2999-01-01T00:00:00.000Z" });
  await writeFile(claimPath, claimBytes, "utf8");
  const beforeDraftAndSessions = await draftAndSessionBytes(root);
  releaseAcceptance();

  const attempted = await outcomeWithin(acceptance, 2_000, "bare acceptance versus legacy owner");

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.equal(await readFile(claimPath, "utf8"), claimBytes);
  assert.deepEqual(await draftAndSessionBytes(root), beforeDraftAndSessions);
});

test("CLI bare accept blocks a live legacy per-draft owner byte-for-byte", async (t) => {
  const root = await scratch(t);
  await stageReviewedDraft(root);
  const claimPath = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json.lock.00000001.cli-live.json");
  const claimBytes = legacyPublishedClaim({ token: "cli-live", expiresAt: "2999-01-01T00:00:00.000Z" });
  await mkdir(path.dirname(claimPath), { recursive: true });
  await writeFile(claimPath, claimBytes, "utf8");
  const before = await filesystemBytes(root);

  const attempted = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--accept-draft", "--created-at", "2026-08-08T20:00:00.000Z"
  ]);

  assert.equal(attempted.exitCode, 1, `${attempted.stderr}\n${attempted.stdout}`);
  const payload = parseJsonOutput(attempted);
  assert.equal(payload.status, "rejected");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("a malformed sibling journal blocks before a valid pending acceptance is rolled back", async (t) => {
  const root = await scratch(t);
  const draft = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, draft);
  const sessionId = await allocateSessionId(root, "2026-08-08T20:00:00.000Z");
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(transactions, { recursive: true });
  await writeFile(path.join(transactions, `${draft.id}.json`), JSON.stringify({
    schemaVersion: 1,
    draftId: draft.id,
    sessionId
  }), "utf8");
  await writeFile(path.join(transactions, "itd_malformed-sibling.json"), "{", "utf8");
  const replacement = { ...draft, id: "itd_sibling-block-replacement" };
  const replacementSource = path.join(root, "replacement.json");
  await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
  const before = await filesystemBytes(root);

  const attempted = await stageIntakeDraftBound({
    repositoryRoot: root,
    draftFile: replacementSource,
    createdAt: "2026-08-08T20:00:01.000Z"
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("multiple strictly valid pending acceptance journals remain an immutable conservative block", async (t) => {
  const root = await scratch(t);
  const first = intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]);
  await stageReviewedDraft(root, first);
  const second = { ...first, id: "itd_second-pending" };
  const drafts = path.join(root, ".legion/project/intake/drafts");
  await writeFile(path.join(drafts, `${second.id}.json`), `${JSON.stringify(second, undefined, 2)}\n`, "utf8");
  const transactions = path.join(root, ".legion/project/intake/transactions");
  await mkdir(transactions, { recursive: true });
  for (const [draft, createdAt] of [
    [first, "2026-08-08T20:00:00.000Z"],
    [second, "2026-08-08T20:00:00.001Z"]
  ]) {
    const sessionId = await allocateSessionId(root, createdAt);
    await writeFile(path.join(transactions, `${draft.id}.json`), JSON.stringify({
      schemaVersion: 1,
      draftId: draft.id,
      sessionId
    }), "utf8");
  }
  const replacement = { ...first, id: "itd_ambiguous-pending-replacement" };
  const replacementSource = path.join(root, "replacement.json");
  await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
  const before = await filesystemBytes(root);

  const attempted = await stageIntakeDraftBound({
    repositoryRoot: root,
    draftFile: replacementSource,
    createdAt: "2026-08-08T20:00:01.000Z"
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("committed acceptance with mismatched session provenance blocks byte-for-byte", async (t) => {
  const root = await scratch(t);
  await stageReviewedDraft(root);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterDraftCommit: () => { throw new Error("retain committed journal for provenance test"); }
  });
  assert.equal(committed.ok, true);
  const sessionPath = path.join(root, `.legion/project/intake/${committed.session.id}/session.json`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  session.answers[0].draftAcceptedFrom.draftId = "itd_wrong-provenance";
  await writeFile(sessionPath, `${JSON.stringify(session, undefined, 2)}\n`, "utf8");
  const replacement = { ...intakeDraft([]), id: "itd_provenance-replacement" };
  const replacementSource = path.join(root, "replacement.json");
  await writeFile(replacementSource, JSON.stringify(replacement), "utf8");
  const before = await filesystemBytes(root);

  const attempted = await stageIntakeDraftBound({
    repositoryRoot: root,
    draftFile: replacementSource,
    createdAt: "2026-08-08T20:00:01.000Z"
  });

  assert.equal(attempted.ok, false);
  assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("committed acceptance cleanup requires one regular session file in one regular directory", async (t) => {
  for (const mode of ["extra-file", "linked-parent"]) {
    await t.test(mode, async (t) => {
      if (mode === "linked-parent" && !requireDirSymlink(t)) return;
      const root = await scratch(t);
      const journalPath = await leaveRecoverableCommittedJournal(root);
      const journalBytes = await readFile(journalPath);
      const journal = JSON.parse(journalBytes.toString("utf8"));
      const sessionDirectory = path.join(root, `.legion/project/intake/${journal.sessionId}`);
      const sessionPath = path.join(sessionDirectory, "session.json");
      const sessionBytes = await readFile(sessionPath);
      if (mode === "extra-file") {
        await writeFile(path.join(sessionDirectory, "unexpected.bin"), "unexpected committed state\n", "utf8");
      } else {
        const target = path.join(root, "linked-committed-session");
        await mkdir(target);
        await writeFile(path.join(target, "session.json"), sessionBytes);
        await rm(sessionPath);
        await rmdir(sessionDirectory);
        await symlink(target, sessionDirectory, directoryLinkType());
        assert.equal((await lstat(sessionDirectory)).isSymbolicLink(), true);
      }
      const before = await filesystemBytes(root);

      const attempted = await acceptStagedDraft({
        repositoryRoot: root,
        draftId: journal.draftId,
        createdAt: "2026-08-08T20:00:01.000Z"
      });

      assert.equal(attempted.ok, false);
      assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
      assert.deepEqual(await readFile(journalPath), journalBytes);
      assert.deepEqual(await readFile(sessionPath), sessionBytes);
      assert.deepEqual(await filesystemBytes(root), before, `${mode} changed durable state`);
    });
  }
});

test("acceptance retry returns the same committed session and cleans its validated journal", async (t) => {
  const root = await scratch(t);
  await stageReviewedDraft(root);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterDraftCommit: () => { throw new Error("retain committed journal for retry"); }
  });
  assert.equal(committed.ok, true);
  const journalPath = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  await readFile(journalPath);

  const recovered = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:01.000Z",
    requireReviewed: true
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.session.id, committed.session.id);
  assert.deepEqual(recovered.session, committed.session);
  assert.deepEqual(await listSessions(root), [committed.session.id]);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
});

test("CLI accept-draft replays a committed acceptance and returns the same session", async (t) => {
  const root = await scratch(t);
  await stageReviewedDraft(root);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    requireReviewed: true,
    afterDraftCommit: () => { throw new Error("retain committed journal for CLI retry"); }
  });
  assert.equal(committed.ok, true);
  const journalPath = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  await readFile(journalPath);

  const retried = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--accept-draft", "--created-at", "2026-08-08T20:00:01.000Z"
  ]);

  assert.equal(retried.exitCode, 0, `${retried.stderr}\n${retried.stdout}`);
  const payload = parseJsonOutput(retried);
  assert.equal(payload.status, "interview");
  assert.equal(payload.draft.id, committed.draft.id);
  assert.equal(payload.session.id, committed.session.id);
  assert.deepEqual(payload.session, committed.session);
  assert.deepEqual(await listSessions(root), [committed.session.id]);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
});

test("CLI bare accept rejects two committed candidates without changing either transaction", async (t) => {
  const root = await scratch(t);
  await leaveTwoRecoverableCommittedJournals(root);
  const before = await filesystemBytes(root);

  const attempted = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--accept-draft", "--created-at", "2026-08-08T20:00:01.000Z"
  ]);

  assert.equal(attempted.exitCode, 1, `${attempted.stderr}\n${attempted.stdout}`);
  const payload = parseJsonOutput(attempted);
  assert.equal(payload.status, "rejected");
  assert.ok(payload.diagnostics.some((entry) =>
    entry.code === "pending_acceptance_blocked" && entry.message.includes("Multiple committed acceptance journals")
  ));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("CLI explicit committed replay cleans only its selected journal and leaves the other selectable", async (t) => {
  const root = await scratch(t);
  const candidates = await leaveTwoRecoverableCommittedJournals(root);
  const secondJournalBytes = await readFile(candidates.second.journalPath);
  const secondDraftBytes = await readFile(path.join(root, `.legion/project/intake/drafts/${candidates.second.draft.id}.json`));
  const secondSessionBytes = await readFile(path.join(root, `.legion/project/intake/${candidates.second.session.id}/session.json`));

  const selectedFirst = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--accept-draft", candidates.first.draft.id,
    "--created-at", "2026-08-08T20:00:01.000Z"
  ]);

  assert.equal(selectedFirst.exitCode, 0, `${selectedFirst.stderr}\n${selectedFirst.stdout}`);
  const firstPayload = parseJsonOutput(selectedFirst);
  assert.equal(firstPayload.status, "interview");
  assert.equal(firstPayload.draft.id, candidates.first.draft.id);
  assert.deepEqual(firstPayload.session, candidates.first.session);
  await assert.rejects(readFile(candidates.first.journalPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(candidates.second.journalPath), secondJournalBytes);
  assert.deepEqual(await readFile(path.join(root, `.legion/project/intake/drafts/${candidates.second.draft.id}.json`)), secondDraftBytes);
  assert.deepEqual(await readFile(path.join(root, `.legion/project/intake/${candidates.second.session.id}/session.json`)), secondSessionBytes);

  const selectedSecond = await runCliCapture([
    "--repository-root", root,
    "start", "--json", "--accept-draft", candidates.second.draft.id,
    "--created-at", "2026-08-08T20:00:02.000Z"
  ]);

  assert.equal(selectedSecond.exitCode, 0, `${selectedSecond.stderr}\n${selectedSecond.stdout}`);
  const secondPayload = parseJsonOutput(selectedSecond);
  assert.equal(secondPayload.status, "interview");
  assert.equal(secondPayload.draft.id, candidates.second.draft.id);
  assert.deepEqual(secondPayload.session, candidates.second.session);
  await assert.rejects(readFile(candidates.second.journalPath), { code: "ENOENT" });
});

test("mixed prepared and committed acceptance reconciles the prepared side and stops every lifecycle caller", { timeout: 120_000 }, async (t) => {
  const callers = [
    "bare-accept",
    "explicit-committed-accept",
    "explicit-prepared-accept",
    "stage-replacement",
    "discard",
    "preparation",
    "bare-review"
  ];
  for (const phase of ["prepared", "rolling-back"]) {
    for (const caller of callers) {
      await t.test(`${phase} through ${caller}`, async (t) => {
        const root = await scratch(t);
        const mixed = await leaveMixedAcceptanceJournals(root, phase);
        const replacementSource = path.join(root, "mixed-replacement.json");
        await writeFile(replacementSource, JSON.stringify({
          ...mixed.prepared.draft,
          id: "itd_mixed-replacement"
        }), "utf8");
        const relative = (absolute) => path.relative(root, absolute).split(path.sep).join("/");
        const expectedRemoved = new Set([
          relative(mixed.prepared.transactionPath),
          ...(mixed.prepared.reservationPresent ? [relative(mixed.prepared.reservationPath)] : [])
        ]);
        const before = await filesystemBytes(root);
        const expectedAfterPreparedRecovery = before.filter((entry) => !expectedRemoved.has(entry.path));

        if (caller === "bare-accept" || caller === "explicit-committed-accept" || caller === "explicit-prepared-accept") {
          const explicitId = caller === "explicit-committed-accept"
            ? mixed.committed.draft.id
            : caller === "explicit-prepared-accept"
              ? mixed.prepared.draft.id
              : undefined;
          const attempted = await runCliCapture([
            "--repository-root", root,
            "start", "--json", "--accept-draft",
            ...(explicitId === undefined ? [] : [explicitId]),
            "--created-at", "2026-08-08T20:00:01.000Z"
          ]);
          assert.equal(attempted.exitCode, 1, `${attempted.stderr}\n${attempted.stdout}`);
          const payload = parseJsonOutput(attempted);
          assert.equal(payload.status, "rejected");
          assert.ok(payload.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
        } else if (caller === "stage-replacement") {
          const attempted = await stageIntakeDraftBound({
            repositoryRoot: root,
            draftFile: replacementSource,
            createdAt: "2026-08-08T20:00:01.000Z"
          });
          assert.equal(attempted.ok, false);
          assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
        } else if (caller === "discard") {
          const attempted = await discardStagedDraft({
            repositoryRoot: root,
            draftId: mixed.prepared.draft.id,
            requireReviewed: true
          });
          assert.equal(attempted.ok, false);
          assert.ok(attempted.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
        } else if (caller === "preparation") {
          await assert.rejects(
            prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" }),
            (error) => error?.code === "EPENDINGACCEPTANCERECOVERED"
          );
        } else {
          const attempted = await runCliCapture([
            "--repository-root", root,
            "start", "--json", "--created-at", "2026-08-08T20:00:01.000Z"
          ]);
          assert.equal(attempted.exitCode, 1, `${attempted.stderr}\n${attempted.stdout}`);
          const payload = parseJsonOutput(attempted);
          assert.equal(payload.status, "rejected");
          assert.ok(payload.diagnostics.some((entry) => entry.code === "pending_acceptance_recovered"));
        }

        assert.deepEqual(
          await filesystemBytes(root),
          expectedAfterPreparedRecovery,
          `${caller} crossed or cleaned committed state while recovering ${phase}`
        );

        const replayed = await runCliCapture([
          "--repository-root", root,
          "start", "--json", "--accept-draft", mixed.committed.draft.id,
          "--created-at", "2026-08-08T20:00:02.000Z"
        ]);
        assert.equal(replayed.exitCode, 0, `${replayed.stderr}\n${replayed.stdout}`);
        const replayPayload = parseJsonOutput(replayed);
        assert.equal(replayPayload.status, "interview");
        assert.deepEqual(replayPayload.draft, mixed.committed.draft);
        assert.deepEqual(replayPayload.session, mixed.committed.session);
        await assert.rejects(readFile(mixed.committed.journalPath), { code: "ENOENT" });

        const recovered = await filesystemBytes(root);
        await recoverIntakeLifecycleArtifacts(root);
        await recoverIntakeLifecycleArtifacts(root);
        assert.deepEqual(await filesystemBytes(root), recovered, "repeated mixed-state recovery changed reconciled state");
      });
    }
  }
});

test("non-empty prepared acceptance remains blocking and byte-identical", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const crashedId = await allocateSessionId(root, "2026-08-08T20:00:00.000Z");
  await saveSession(root, createSession({ sessionId: crashedId, createdAt: "2026-08-08T20:00:00.000Z", schemaVersion: "0.3.0" }).session);
  const journalDirectory = path.join(root, ".legion/project/intake/transactions");
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(path.join(journalDirectory, "itd_asset-mapper.json"), JSON.stringify({ schemaVersion: 1, draftId: "itd_asset-mapper", sessionId: crashedId }), "utf8");
  await writeFile(path.join(journalDirectory, "itd_asset-mapper.json.lock.00000001.expired-owner.json"), JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    token: "expired-owner",
    pid: process.pid,
    createdAt: "2000-01-01T00:00:00.000Z",
    expiresAt: "2000-01-01T00:01:00.000Z"
  }), "utf8");
  const before = await filesystemBytes(root);

  await assert.rejects(
    prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:00.500Z" }),
    (error) => error?.code === "EPENDINGACCEPTANCEBLOCKED"
  );
  assert.deepEqual(await filesystemBytes(root), before);

  const recovered = await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:01.000Z" });

  assert.equal(recovered.ok, false);
  assert.ok(recovered.diagnostics.some((entry) => entry.code === "pending_acceptance_blocked"));
  assert.deepEqual(await filesystemBytes(root), before);
});

test("a failure after draft commit preserves the committed session and recovers cleanup", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);

  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterDraftCommit: () => { throw new Error("simulated interruption after CAS"); }
  });
  assert.equal(committed.ok, true);
  assert.equal((await listSessions(root)).length, 1);
  const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json"), "utf8")));
  assert.equal(persisted.status, "accepted");
  await import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json")));

  const resumed = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" });
  assert.equal(resumed.activeSessionId, committed.session.id);
  assert.equal((await listSessions(root)).length, 1);
  const initialized = await initProject({
    repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
    decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
  });
  assert.equal(initialized.ok, true);
});

test("journal cleanup failure cannot roll back an accepted draft session", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const accepted = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    beforeJournalCleanup: () => { throw new Error("simulated journal removal failure"); }
  });
  assert.equal(accepted.ok, true);
  assert.equal((await listSessions(root)).length, 1);
  await import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json")));
  const resumed = await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" });
  assert.equal(resumed.activeSessionId, accepted.session.id);
  const initialized = await initProject({
    repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
    decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
  });
  assert.equal(initialized.ok, true);
});

test("general recovery cannot delete a committed acceptance journal after token loss", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterDraftCommit: () => { throw new Error("retain committed journal"); }
  });
  assert.equal(committed.ok, true);
  const journal = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  const beforeJournal = await readFile(journal);
  const sessionPath = path.join(root, `.legion/project/intake/${committed.session.id}/session.json`);
  const beforeSession = await readFile(sessionPath);
  const lockPath = path.join(root, ".legion/project/intake/transactions/intake-transition.lock");
  const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "general-recovery-successor", createdAt: "2026-08-08T20:00:00.001Z" })}\n`;

  await recoverIntakeLifecycleArtifacts(root, {
    beforeAcceptanceJournalCleanup: async () => {
      await rm(lockPath);
      await writeFile(lockPath, successor, { flag: "wx" });
    }
  });

  assert.deepEqual(await readFile(journal), beforeJournal);
  assert.deepEqual(await readFile(sessionPath), beforeSession);
  assert.equal(await readFile(lockPath, "utf8"), successor);
});

test("direct initialization recovers a retained committed acceptance journal without preflight", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterDraftCommit: () => { throw new Error("simulated interruption after CAS"); }
  });
  assert.equal(committed.ok, true);
  const journal = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  await import("node:fs/promises").then(({ stat }) => stat(journal));

  const initialized = await runCliCapture([
    "--repository-root", root,
    "start", "--name", "Asset Mapper", "--json", "--created-at", "2026-08-08T21:00:00.000Z"
  ]);

  assert.equal(initialized.exitCode, 0, initialized.stderr);
  assert.equal(parseJsonOutput(initialized).status, "initialized");
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(journal)), { code: "ENOENT" });
});

test("invalid direct initialization validates the complete project before lifecycle recovery", async (t) => {
  for (const { label, options } of [
    { label: "overlong name", options: ["--name", "N".repeat(161), "--slug", "asset-mapper"] },
    { label: "overlong description", options: ["--name", "Asset Mapper", "--summary", "S".repeat(2_049)] },
    { label: "valueless description", options: ["--name", "Asset Mapper", "--summary"] }
  ]) {
    await t.test(label, async (t) => {
      const root = await scratch(t);
      await leaveRecoverableCommittedJournal(root);
      const before = await filesystemBytes(root);

      const initialized = await runCliCapture([
        "--repository-root", root,
        "start", ...options, "--json", "--created-at", "2026-08-08T21:00:00.000Z"
      ]);

      assert.notEqual(initialized.exitCode, 0);
      assert.deepEqual(await filesystemBytes(root), before, "invalid direct init changed lifecycle bytes");
    });
  }
});

test("direct initialization dry-run leaves recoverable lifecycle state byte-for-byte unchanged", async (t) => {
  const root = await scratch(t);
  await leaveRecoverableCommittedJournal(root);
  const transactions = path.join(root, ".legion/project/intake/transactions");
  const expiredClaim = path.join(transactions, "itd_asset-mapper.json.lock.00000001.expired.json");
  await writeFile(expiredClaim, JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    token: "expired",
    pid: 99999999,
    createdAt: "2000-01-01T00:00:00.000Z",
    expiresAt: "2000-01-01T00:01:00.000Z"
  }), "utf8");
  const leaseTemp = path.join(transactions, "itd_asset-mapper.json.lock.00000000-0000-4000-8000-000000000000.tmp");
  await writeFile(leaseTemp, "abandoned lease publish bytes\n", "utf8");
  await utimes(leaseTemp, new Date(0), new Date(0));
  const draftTemp = path.join(root, ".legion/project/intake/drafts/itd_asset-mapper.json.abandoned.tmp");
  await writeFile(draftTemp, "abandoned draft publish bytes\n", "utf8");
  const before = await filesystemBytes(root);

  const dryRun = await runCliCapture([
    "--repository-root", root,
    "start", "--name", "Asset Mapper", "--dry-run", "--json",
    "--created-at", "2026-08-08T21:00:00.000Z"
  ]);

  const payload = parseJsonOutput(dryRun);
  assert.ok(["dry_run", "migration_required"].includes(payload.status), dryRun.stderr);
  assert.deepEqual(await filesystemBytes(root), before, "dry-run changed lifecycle bytes or paths");
});

test("interactive dry-run is refused before any lifecycle write", async (t) => {
  const root = await scratch(t);
  await leaveRecoverableCommittedJournal(root);
  const before = await filesystemBytes(root);

  const dryRun = await runCliCapture([
    "--repository-root", root,
    "start", "--dry-run", "--json", "--created-at", "2026-08-08T21:00:00.000Z"
  ]);

  assert.notEqual(dryRun.exitCode, 0);
  assert.deepEqual(await filesystemBytes(root), before, "interactive dry-run changed lifecycle bytes or paths");
});

test("committed-journal recovery replays validator-normalized draft values", async (t) => {
  const root = await scratch(t);
  const source = path.join(root, "draft.json");
  await writeFile(source, JSON.stringify(intakeDraft([
    draftAnswer("req-1-priority", "requirements.1.priority", "must"),
    draftAnswer("req-1-ac-1-more", "requirements.1.criteria.1.more", "no")
  ])), "utf8");
  assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
  const committed = await acceptStagedDraft({
    repositoryRoot: root,
    draftId: "itd_asset-mapper",
    createdAt: "2026-08-08T20:00:00.000Z",
    afterDraftCommit: () => { throw new Error("simulated interruption after normalized draft commit"); }
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.session.answers.find((answer) => answer.nodeId === "req-1-ac-1-more").value, false);
  const journal = path.join(root, ".legion/project/intake/transactions/itd_asset-mapper.json");
  await import("node:fs/promises").then(({ stat }) => stat(journal));

  await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" });

  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(journal)), { code: "ENOENT" });
  const initialized = await initProject({
    repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
    decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
  });
  assert.equal(initialized.ok, true);
});

test("normal lifecycle entry removes abandoned lease publication temp without accepting malformed transactions", async (t) => {
  for (const mode of ["abandoned-temp", "malformed-claim", "mismatched-journal"]) {
    const root = await scratch(t);
    const transactions = path.join(root, ".legion/project/intake/transactions");
    await mkdir(transactions, { recursive: true });
    const name = mode === "abandoned-temp"
      ? "itd_asset-mapper.json.lock.00000000-0000-4000-8000-000000000000.tmp"
      : mode === "malformed-claim" ? "itd_asset-mapper.json.lock.00000001.bad.json" : "itd_asset-mapper.json";
    const artifact = path.join(transactions, name);
    if (mode === "mismatched-journal") {
      const draft = { ...intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")]), status: "accepted" };
      const drafts = path.join(root, ".legion/project/intake/drafts");
      await mkdir(drafts, { recursive: true });
      await writeFile(path.join(drafts, "itd_asset-mapper.json"), JSON.stringify(draft), "utf8");
      const unrelatedId = await allocateSessionId(root, "2026-08-08T19:00:00.000Z");
      await saveSession(root, createSession({ sessionId: unrelatedId, createdAt: "2026-08-08T19:00:00.000Z", schemaVersion: "0.3.0" }).session);
      await writeFile(artifact, JSON.stringify({ schemaVersion: 1, draftId: "itd_asset-mapper", sessionId: unrelatedId }), "utf8");
    } else {
      await writeFile(artifact, "{", "utf8");
    }
    if (mode === "abandoned-temp") {
      await import("node:fs/promises").then(({ utimes }) => utimes(artifact, new Date(0), new Date(0)));
      await writeFile(path.join(transactions, "itd_asset-mapper.json.lock.00000001.expired.json"), JSON.stringify({
        schemaVersion: 1, generation: 1, token: "expired", pid: 99999999,
        createdAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:01:00.000Z"
      }), "utf8");
    }
    if (mode === "mismatched-journal" || mode === "malformed-claim") {
      const before = await filesystemBytes(root);
      await assert.rejects(
        prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" }),
        (error) => error?.code === "EPENDINGACCEPTANCEBLOCKED"
      );
      assert.deepEqual(await filesystemBytes(root), before);
    } else {
      await prepareIntakePreflight({ repositoryRoot: root, createdAt: "2026-08-08T20:00:01.000Z" });
    }
    const initialized = await initProject({
      repositoryRoot: root, slug: "asset-mapper", name: "Asset Mapper",
      decisionOwners: [{ kind: "human", id: "owner" }], createdAt: "2026-08-08T21:00:00.000Z"
    });
    assert.equal(initialized.ok, mode === "abandoned-temp", mode);
    if (mode !== "abandoned-temp") assert.equal(initialized.status, "migration_required");
  }
});

test("accepted and mistyped draft attempts do not poison later project initialization", async (t) => {
  for (const mode of ["accepted", "mistyped"]) {
    const root = await scratch(t);
    if (mode === "accepted") {
      const source = path.join(root, "draft.json");
      await writeFile(source, JSON.stringify(intakeDraft([draftAnswer("project-name", "project.name", "Asset Mapper")])), "utf8");
      assert.equal((await stageIntakeDraft({ repositoryRoot: root, draftFile: source })).ok, true);
      assert.equal((await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_asset-mapper", createdAt: "2026-08-08T20:00:00.000Z" })).ok, true);
    } else {
      assert.equal((await acceptStagedDraft({ repositoryRoot: root, draftId: "itd_mistyped", createdAt: "2026-08-08T20:00:00.000Z" })).ok, false);
    }
    const initialized = await initProject({
      repositoryRoot: root,
      slug: "asset-mapper",
      name: "Asset Mapper",
      decisionOwners: [{ kind: "human", id: "owner" }],
      createdAt: "2026-08-08T21:00:00.000Z"
    });
    assert.equal(initialized.ok, true, `${mode} acceptance left migration-poisoning state`);
  }
});

test("batch intake retains its direct initialization semantics when an automatic exploration exists", async (t) => {
  const root = await scratch(t);
  await exploration(root, "handoff", "2026-08-08T10:00:00.000Z");
  await writeFile(path.join(root, "answers.json"), JSON.stringify({ "project-name": "Asset Mapper" }), "utf8");

  const applied = await runCliCapture([
    "--repository-root", root, "start", "--intake", "answers.json", "--json", "--created-at", "2026-08-08T19:00:00.000Z"
  ]);

  assert.equal(applied.exitCode, 1, "the intentionally partial batch remains incomplete");
  const sessionId = parseJsonOutput(applied).session.id;
  const session = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, ".legion/project/intake", sessionId, "session.json"), "utf8")));
  assert.equal(session.explorationRef, undefined);
  assert.deepEqual(session.injectedNodes, []);
});
