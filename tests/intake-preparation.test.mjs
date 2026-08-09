import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";
import { directoryLinkType, requireDirSymlink, requireFileSymlink } from "./helpers/symlink-capability.mjs";
import { resolveMapState } from "../packages/cli/dist/workflow/codebase-map.js";

const CREATED_AT = "2026-08-08T12:00:00.000Z";

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-intake-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function start(root, ...args) {
  const result = await runCliCapture([
    "--repository-root", root,
    "start",
    "--json",
    "--created-at", CREATED_AT,
    ...args
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  return parseJsonOutput(result);
}

async function refreshMap(root, scope = ".") {
  const result = await runCliCapture([
    "--repository-root", root,
    "map",
    "--refresh",
    "--scope", scope,
    "--json",
    "--created-at", CREATED_AT
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  return parseJsonOutput(result);
}

async function writeMapRun(root, {
  runId,
  createdAt = "2026-08-09T12:00:00.000Z",
  artifactPath = `.legion/project/workflow/map/${runId}/map.json`,
  mapBytes
}) {
  const directory = path.join(root, ".legion", "project", "workflow", "map", runId);
  await mkdir(directory, { recursive: true });
  if (mapBytes !== undefined) {
    await mkdir(path.dirname(path.join(root, ...artifactPath.split("/"))), { recursive: true });
    await writeFile(path.join(root, ...artifactPath.split("/")), mapBytes);
  }
  await writeFile(path.join(directory, "workflow-run.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "workflow_run",
    workflow: "map",
    runId,
    createdAt,
    status: "completed",
    input: { mode: "refresh", scope: "." },
    outputs: { mapArtifactPath: artifactPath },
    nextAction: { command: "legion plan 1", reason: "continue" },
    diagnostics: []
  })}\n`, "utf8");
  return { directory, artifactPath };
}

async function writeExploration(root, directoryId, summary, createdAt = CREATED_AT, options = {}) {
  const directory = path.join(root, ".legion", "project", "workflow", "explore", directoryId);
  await mkdir(directory, { recursive: true });
  const artifactPath = `.legion/project/workflow/explore/${directoryId}/exploration.json`;
  await writeFile(path.join(directory, "exploration.json"), JSON.stringify({
    schemaVersion: "0.2.0",
    createdAt,
    kind: "exploration",
    runId: `run_${directoryId}`,
    status: "exploratory",
    entry: "raw-idea",
    topic: "Exploration topic",
    summary,
    proposals: [],
    openQuestions: [],
    notes: []
  }), "utf8");
  await writeFile(path.join(directory, "workflow-run.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "workflow_run",
    workflow: "explore",
    runId: directoryId,
    createdAt,
    status: "completed",
    input: { topic: "Exploration topic" },
    outputs: { explorationArtifactPath: artifactPath },
    nextAction: { command: options.command ?? "legion start", reason: "continue" },
    diagnostics: []
  }), "utf8");
}

async function fileExists(root, relative) {
  try {
    await readFile(path.join(root, ...relative.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function repositorySnapshot(root) {
  const snapshot = [];
  async function visit(directory, relativeDirectory = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) snapshot.push({ path: relative, bytes: (await readFile(absolute)).toString("base64") });
    }
  }
  await visit(root);
  return snapshot;
}

async function explorationRef(root, directoryId) {
  const artifactPath = `.legion/project/workflow/explore/${directoryId}/exploration.json`;
  const bytes = await readFile(path.join(root, ...artifactPath.split("/")));
  const artifact = JSON.parse(bytes.toString("utf8"));
  return {
    kind: "exploration",
    runId: artifact.runId,
    artifact: { path: artifactPath, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
  };
}

function draftFromPreparation(preparation, overrides = {}) {
  return {
    schemaVersion: "0.3.0",
    createdAt: CREATED_AT,
    kind: "intake-draft",
    id: overrides.id ?? "itd_prepared-change",
    status: "draft",
    graphVersion: "1.2.0",
    projectMode: preparation.preflight.projectMode,
    initiative: preparation.preparation.initiative.value,
    explorationRefs: [],
    proposedAnswers: [],
    injectedQuestions: [],
    unresolvedNodes: [],
    diagnostics: [],
    ...overrides
  };
}

function draftAnswer(nodeId, slot, value, overrides = {}) {
  return {
    nodeId,
    slot,
    value,
    confidence: "researched",
    rationale: `Repository evidence supports ${slot}.`,
    answerAnchor: nodeId,
    evidenceRefs: [],
    ...overrides
  };
}

function reviewDraft(preparation, id = "itd_contract-review", overrides = {}) {
  return draftFromPreparation(preparation, {
    id,
    proposedAnswers: [
      draftAnswer("project-name", "project.name", "Asset Mapper"),
      draftAnswer("project-summary", "project.summary", "Deterministic asset lookup."),
      draftAnswer("project-owner", "project.owner", "operator"),
      draftAnswer("problem-statement", "problem.statement", "Asset lookup is inconsistent."),
      draftAnswer("problem-users", "problem.users", "Application developers"),
      draftAnswer("problem-success", "problem.success", "Every lookup is deterministic."),
      draftAnswer("req-1-statement", "requirements.1.statement", "Lookups return one stable result."),
      draftAnswer("req-1-priority", "requirements.1.priority", "must"),
      draftAnswer("req-1-category", "requirements.1.category", "behavior"),
      draftAnswer("req-1-ac-1-statement", "requirements.1.criteria.1.statement", "Repeated lookup returns the same asset."),
      draftAnswer("req-1-ac-1-proof", "requirements.1.criteria.1.proof", "executable"),
      draftAnswer("req-1-ac-1-detail", "requirements.1.criteria.1.detail", "pnpm test --filter asset-map"),
      draftAnswer("req-1-ac-1-surface-kind", "requirements.1.criteria.1.surface.kind", "unit"),
      draftAnswer("req-1-ac-1-surface-interface", "requirements.1.criteria.1.surface.interface", "AssetResolver.resolve()"),
      draftAnswer("req-1-ac-1-surface-rationale", "requirements.1.criteria.1.surface.rationale", "Catches unstable in-repository resolution behavior."),
      draftAnswer("req-1-ac-1-surface-pins", "requirements.1.criteria.1.surface.pins", "README.md"),
      draftAnswer("req-1-ac-1-acceptance-paths", "requirements.1.criteria.1.acceptance-paths", "tests/asset-map.test.mjs"),
      draftAnswer("req-1-ac-1-more", "requirements.1.criteria.1.more", false),
      draftAnswer("req-1-more", "requirements.1.more", false),
      draftAnswer("non-goals", "scope.non-goals", "Remote asset hosting"),
      draftAnswer("constraints", "constraints.text", "No new runtime dependencies"),
      draftAnswer("risk-tier", "risk.tier", "R1", { confidence: "inferred" }),
      draftAnswer("risk-reason", "risk.reason", "Local and reversible"),
      draftAnswer("budget-files", "budget.max-files-changed", "12"),
      draftAnswer("budget-lines", "budget.max-lines-changed", "500"),
      draftAnswer("budget-new-files", "budget.max-new-files", "4"),
      draftAnswer("pref-verification", "preferences.verification", "pnpm test")
    ],
    unresolvedNodes: [{
      nodeId: "pref-notes",
      slot: "preferences.notes",
      question: "Anything else should an implementer know?",
      rationale: "No repository evidence answers this operator preference.",
      evidenceRefs: []
    }],
    diagnostics: ["One optional operator preference remains unresolved."],
    ...overrides
  });
}

async function stage(root, draft, filename = "draft.json", ...args) {
  const relative = `.legion/host-input/${filename}`;
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), JSON.stringify(draft), "utf8");
  return runCliCapture([
    "--repository-root", root,
    "start", "--stage-draft", relative,
    "--json", "--created-at", CREATED_AT,
    ...args
  ]);
}

test("greenfield and documentation-only preparation ask one initiative question and never request mapping", async (t) => {
  for (const fixture of [
    { name: "greenfield", files: [] },
    { name: "documentation-only", files: [["README.md", "# Product notes\n"]] }
  ]) {
    await t.test(fixture.name, async (t) => {
      const root = await scratch(t);
      for (const [relative, contents] of fixture.files) {
        await writeFile(path.join(root, relative), contents, "utf8");
      }

      const payload = await start(root);

      assert.equal(payload.status, "preflight");
      assert.equal(payload.preflight.projectMode, fixture.name);
      assert.equal(payload.preparation.status, "initiative_required");
      assert.deepEqual(payload.preparation.initiativeQuestion, {
        kind: "free-text",
        prompt: "What initiative should this project intake prepare?"
      });
      assert.equal(payload.preparation.map.action, "skip");
      assert.match(payload.nextAction.command, /legion start --goal/);
    });
  }
});

test("brownfield preparation refreshes absent, stale, and partial maps but uses a fresh full-project map", async (t) => {
  for (const state of ["absent", "stale", "partial", "fresh"]) {
    await t.test(state, async (t) => {
      const root = await scratch(t);
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
      await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");
      if (state === "partial") await refreshMap(root, "src");
      const refreshed = state === "fresh" || state === "stale" ? await refreshMap(root) : undefined;
      if (state === "stale") await writeFile(path.join(root, "src", "main.ts"), "export const value = 2;\n", "utf8");

      const payload = await start(root, "--goal", "Add deterministic asset lookup");

      assert.equal(payload.preflight.projectMode, "brownfield");
      assert.equal(payload.preflight.map.freshness, state);
      assert.equal(payload.preparation.initiative.value, "Add deterministic asset lookup");
      assert.equal(payload.preparation.initiative.source, "explicit");
      if (state === "fresh") {
        assert.equal(payload.preparation.status, "repository_review_required");
        assert.equal(payload.preparation.map.action, "use_fresh");
        assert.equal(payload.preparation.map.scope, ".");
        const mapBytes = await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")));
        assert.deepEqual(payload.preparation.map.artifact, {
          path: refreshed.mapArtifactPath,
          sha256: `sha256:${createHash("sha256").update(mapBytes).digest("hex")}`
        });
        assert.match(payload.nextAction.command, /stage-draft/);
      } else {
        assert.equal(payload.preparation.status, "map_refresh_required");
        assert.equal(payload.preparation.map.action, "refresh");
        assert.equal(payload.nextAction.command, "legion map --refresh --scope .");
      }
    });
  }
});

test("the documented ignored draft location keeps refresh-compose-stage map evidence fresh end to end", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  await start(root, "--goal", "Add deterministic asset lookup");
  const refreshed = await refreshMap(root);
  const prepared = await start(root);
  const draftPath = ".legion/var/intake-drafts/intake-draft.json";
  assert.equal(prepared.nextAction.command, `legion start --stage-draft ${draftPath}`);

  const mapBytes = await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")));
  const draft = draftFromPreparation(prepared, {
    id: "itd_documented-path",
    codebaseMapRef: {
      kind: "codebase-map",
      artifact: {
        path: refreshed.mapArtifactPath,
        sha256: `sha256:${createHash("sha256").update(mapBytes).digest("hex")}`
      },
      sourceFingerprint: refreshed.sourceFingerprint
    }
  });
  await mkdir(path.dirname(path.join(root, ...draftPath.split("/"))), { recursive: true });
  await writeFile(path.join(root, ...draftPath.split("/")), `${JSON.stringify(draft, undefined, 2)}\n`, "utf8");
  assert.equal((await resolveMapState(root, ".", CREATED_AT)).freshness, "fresh");

  const staged = await runCliCapture([
    "--repository-root", root,
    "start", "--stage-draft", draftPath,
    "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(staged.exitCode, 0, staged.stderr);
  assert.equal(parseJsonOutput(staged).status, "draft_review");
});

test("reported map failure continues with bounded direct review and prominent degraded coverage", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  await start(root, "--goal", "Add deterministic asset lookup");

  const payload = await start(root, "--map-failed", "permission denied while reading src/private");

  assert.equal(payload.status, "preflight");
  assert.equal(payload.preparation.status, "repository_review_required");
  assert.equal(payload.preparation.map.action, "bounded_direct_review");
  assert.equal(payload.preparation.map.coverage, "degraded");
  assert.match(payload.preparation.map.warning, /DEGRADED COVERAGE/i);
  assert.match(payload.preparation.map.warning, /permission denied/);
  assert.equal(payload.preparation.review.architectureAnalysis, "full_synthesis");
  assert.equal(payload.preparation.review.repositoryCoverage, "bounded_degraded");
  assert.deepEqual(payload.preparation.review.bounds, {
    maxFiles: 24,
    maxDepth: 4,
    selectionOrder: [
      "README and product documentation",
      "dependency manifests and scripts",
      "application and library entry points",
      "configuration",
      "tests",
      "CI commands"
    ],
    selectedPaths: ["src/main.ts"]
  });
  assert.deepEqual(payload.preparation.review.sourceClasses, [
    "README and product documentation",
    "dependency manifests and scripts",
    "application and library entry points",
    "configuration",
    "tests",
    "CI commands"
  ]);
  assert.match(payload.nextAction.command, /stage-draft/);
});

test("degraded direct review reserves every available high-signal class before deterministically filling its bound", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "docs"));
  for (let index = 0; index < 30; index += 1) {
    await writeFile(path.join(root, "docs", `${String(index).padStart(2, "0")}.md`), `# ${index}\n`, "utf8");
  }
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");
  await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "vite.config.ts"), "export default {};\n", "utf8");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests", "core.test.ts"), "export {};\n", "utf8");
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  const tooDeep = path.join(root, "a", "b", "c", "d", "e");
  await mkdir(tooDeep, { recursive: true });
  await writeFile(path.join(tooDeep, "README.md"), "# Outside bounded depth\n", "utf8");
  await start(root, "--goal", "Bound this review");

  const payload = await start(root, "--map-failed", "map unavailable");
  const bounds = payload.preparation.review.bounds;
  assert.equal(bounds.selectedPaths.length, bounds.maxFiles);
  assert.deepEqual(bounds.selectedPaths, [
    "docs/00.md",
    "package.json",
    "app.ts",
    "vite.config.ts",
    "tests/core.test.ts",
    ".github/workflows/ci.yml",
    ...Array.from({ length: 18 }, (_, index) => `docs/${String(index + 1).padStart(2, "0")}.md`)
  ]);
  assert.equal(bounds.selectedPaths.includes("a/b/c/d/e/README.md"), false);
});

test("stage binds drafts to the completed CLI preflight contract", async (t) => {
  await t.test("requires a completed preflight", async (t) => {
    const root = await scratch(t);
    const result = await stage(root, {
      schemaVersion: "0.3.0", createdAt: CREATED_AT, kind: "intake-draft", id: "itd_unbound",
      status: "draft", graphVersion: "1.2.0", projectMode: "greenfield", initiative: "Unbound",
      explorationRefs: [], proposedAnswers: [], injectedQuestions: [], unresolvedNodes: [], diagnostics: []
    });
    assert.equal(result.exitCode, 1);
    assert.match(parseJsonOutput(result).diagnostics[0].code, /preflight/);
  });

  await t.test("rejects project mode and initiative mismatches", async (t) => {
    const root = await scratch(t);
    const prepared = await start(root, "--goal", "Current initiative");
    for (const [label, overrides, code] of [
      ["mode", { projectMode: "brownfield" }, "preflight_project_mode_mismatch"],
      ["initiative", { initiative: "Stale initiative" }, "preflight_initiative_mismatch"]
    ]) {
      const result = await stage(root, draftFromPreparation(prepared, { id: `itd_${label}`, ...overrides }), `${label}.json`);
      assert.equal(result.exitCode, 1);
      assert.ok(parseJsonOutput(result).diagnostics.some((entry) => entry.code === code));
    }
  });

  await t.test("requires exactly the selected exploration evidence", async (t) => {
    const root = await scratch(t);
    await writeExploration(root, "handoff", "Exploration-derived initiative");
    const prepared = await start(root);
    const artifactPath = ".legion/project/workflow/explore/handoff/exploration.json";
    const bytes = await readFile(path.join(root, ...artifactPath.split("/")));
    const exact = {
      kind: "exploration",
      runId: "run_handoff",
      artifact: { path: artifactPath, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
    };
    for (const [label, explorationRefs] of [
      ["missing", []],
      ["wrong", [{ ...exact, artifact: { ...exact.artifact, sha256: `sha256:${"0".repeat(64)}` } }]]
    ]) {
      const result = await stage(root, draftFromPreparation(prepared, { id: `itd_exploration-${label}`, explorationRefs }), `${label}.json`);
      assert.equal(result.exitCode, 1);
      assert.ok(parseJsonOutput(result).diagnostics.some((entry) => entry.code === "preflight_exploration_mismatch"));
    }
    const accepted = await stage(root, draftFromPreparation(prepared, { id: "itd_exploration-exact", explorationRefs: [exact] }), "exact.json");
    assert.equal(accepted.exitCode, 0, accepted.stderr);
  });

  await t.test("requires the current fresh full-project map evidence", async (t) => {
    const root = await scratch(t);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/main.ts"), "export const value = 1;\n", "utf8");
    await refreshMap(root);
    const prepared = await start(root, "--goal", "Mapped initiative");
    const map = prepared.preparation.map;
    const mapRef = { kind: "codebase-map", artifact: map.artifact, sourceFingerprint: map.sourceFingerprint };

    const missing = await stage(root, draftFromPreparation(prepared, { id: "itd_map-missing" }), "missing-map.json");
    assert.equal(missing.exitCode, 1);
    assert.ok(parseJsonOutput(missing).diagnostics.some((entry) => entry.code === "preflight_map_mismatch"));

    const exact = await stage(root, draftFromPreparation(prepared, { id: "itd_map-exact", codebaseMapRef: mapRef }), "exact-map.json");
    assert.equal(exact.exitCode, 0, exact.stderr);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    const accept = await runCliCapture([
      "--repository-root", root, "start", "--accept-draft", "itd_map-exact", "--json", "--created-at", CREATED_AT
    ]);
    assert.equal(accept.exitCode, 1);
    assert.ok(parseJsonOutput(accept).diagnostics.some((entry) => entry.code === "preflight_map_mismatch"));
  });

  await t.test("requires and rechecks the current degraded coverage diagnostic", async (t) => {
    const root = await scratch(t);
    await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
    await start(root, "--goal", "Degraded initiative");
    const prepared = await start(root, "--map-failed", "first failure");
    const warning = prepared.preparation.map.warning;

    const missing = await stage(root, draftFromPreparation(prepared, { id: "itd_degraded-missing" }), "missing-warning.json");
    assert.equal(missing.exitCode, 1);
    assert.ok(parseJsonOutput(missing).diagnostics.some((entry) => entry.code === "preflight_degraded_coverage_mismatch"));

    const exactDraft = draftFromPreparation(prepared, { id: "itd_degraded-exact", diagnostics: [warning] });
    const exact = await stage(root, exactDraft, "exact-warning.json");
    assert.equal(exact.exitCode, 0, exact.stderr);
    const changed = await runCliCapture([
      "--repository-root", root, "start", "--map-failed", "second failure", "--json", "--created-at", CREATED_AT
    ]);
    assert.equal(changed.exitCode, 1);
    assert.equal(parseJsonOutput(changed).status, "rejected");
    const accept = await runCliCapture([
      "--repository-root", root, "start", "--accept-draft", "itd_degraded-exact", "--json", "--created-at", CREATED_AT
    ]);
    assert.equal(accept.exitCode, 1);
    assert.ok(parseJsonOutput(accept).diagnostics.some((entry) => entry.code === "preflight_degraded_coverage_mismatch"));
  });
});

test("acceptance rechecks goal edits made after staging", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Original initiative");
  const staged = await stage(root, draftFromPreparation(prepared));
  assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
  const changed = await runCliCapture([
    "--repository-root", root, "start", "--goal", "Edited initiative", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(changed.exitCode, 1);
  assert.equal(parseJsonOutput(changed).status, "rejected");

  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_prepared-change", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(accepted.exitCode, 1);
  assert.ok(parseJsonOutput(accepted).diagnostics.some((entry) => entry.code === "preflight_initiative_mismatch"));
});

test("staging and acceptance preserve explicit older exploration and opt-out intent", async (t) => {
  await t.test("explicit older exploration", async (t) => {
    const root = await scratch(t);
    await writeExploration(root, "older", "Older initiative", "2026-08-07T12:00:00.000Z");
    await writeExploration(root, "newer", "Newer initiative", "2026-08-08T12:00:00.000Z");
    const prepared = await start(root, "--goal", "Explicit initiative");
    assert.deepEqual(prepared.preflight.explorationSelectionIntent, { mode: "automatic" });
    assert.equal(prepared.preflight.selectedExplorationRunId, "newer");
    const draft = draftFromPreparation(prepared, {
      id: "itd_explicit-older",
      explorationRefs: [await explorationRef(root, "older")]
    });

    const staged = await stage(root, draft, "explicit-older.json", "--from-exploration", "older");
    assert.equal(staged.exitCode, 0, staged.stderr);
    assert.deepEqual(parseJsonOutput(staged).preflight.explorationSelectionIntent, { mode: "explicit", runId: "older" });
    assert.equal(parseJsonOutput(staged).preflight.selectedExplorationRunId, "older");
    const accepted = await runCliCapture([
      "--repository-root", root, "start", "--accept-draft", draft.id, "--json", "--created-at", CREATED_AT
    ]);
    assert.equal(accepted.exitCode, 0, accepted.stderr);
  });

  await t.test("explicit opt-out", async (t) => {
    const root = await scratch(t);
    await writeExploration(root, "older", "Older initiative", "2026-08-07T12:00:00.000Z");
    await writeExploration(root, "newer", "Newer initiative", "2026-08-08T12:00:00.000Z");
    const prepared = await start(root, "--goal", "Independent initiative");
    assert.deepEqual(prepared.preflight.explorationSelectionIntent, { mode: "automatic" });
    const draft = draftFromPreparation(prepared, { id: "itd_opted-out" });

    const staged = await stage(root, draft, "opted-out.json", "--without-exploration");
    assert.equal(staged.exitCode, 0, staged.stderr);
    assert.deepEqual(parseJsonOutput(staged).preflight.explorationSelectionIntent, { mode: "none" });
    assert.equal(parseJsonOutput(staged).preflight.selectedExplorationRunId, undefined);
    const accepted = await runCliCapture([
      "--repository-root", root, "start", "--accept-draft", draft.id, "--json", "--created-at", CREATED_AT
    ]);
    assert.equal(accepted.exitCode, 0, accepted.stderr);
  });
});

test("a later explicit exploration override replaces persisted selection intent", async (t) => {
  const root = await scratch(t);
  await writeExploration(root, "older", "Older initiative", "2026-08-07T12:00:00.000Z");
  await writeExploration(root, "newer", "Newer initiative", "2026-08-08T12:00:00.000Z");
  const { prepareIntakePreflight } = await import("../packages/cli/dist/workflow/intake/lifecycle.js");
  await prepareIntakePreflight({ repositoryRoot: root, createdAt: CREATED_AT, explicitRunId: "older" });

  const overridden = await prepareIntakePreflight({ repositoryRoot: root, createdAt: CREATED_AT, explicitRunId: "newer" });

  assert.deepEqual(overridden.explorationSelectionIntent, { mode: "explicit", runId: "newer" });
  assert.equal(overridden.selectedExplorationRunId, "newer");
  assert.equal(overridden.initiative?.value, "Newer initiative");
});

test("stage-time explicit exploration refuses missing, corrupt, and incompatible runs without draft mutation", async (t) => {
  for (const fixture of [
    { name: "missing", expectedCode: "unreadable" },
    { name: "corrupt", expectedCode: "unreadable" },
    { name: "incompatible", expectedCode: "unrelated_next_action" }
  ]) {
    await t.test(fixture.name, async (t) => {
      const root = await scratch(t);
      if (fixture.name !== "missing") {
        await writeExploration(root, fixture.name, `${fixture.name} initiative`, CREATED_AT, {
          ...(fixture.name === "incompatible" ? { command: "legion advise" } : {})
        });
      }
      if (fixture.name === "corrupt") {
        await writeFile(path.join(root, ".legion/project/workflow/explore/corrupt/exploration.json"), "{", "utf8");
      }
      const prepared = await start(root, "--goal", "Independent initiative");
      const draft = draftFromPreparation(prepared, { id: `itd_explicit-${fixture.name}` });

      const staged = await stage(root, draft, `${fixture.name}.json`, "--from-exploration", fixture.name);

      assert.equal(staged.exitCode, 1, staged.stderr);
      const payload = parseJsonOutput(staged);
      assert.equal(payload.status, "rejected");
      assert.ok(payload.diagnostics.some((entry) => entry.code === fixture.expectedCode), JSON.stringify(payload.diagnostics));
      assert.equal(await fileExists(root, `.legion/project/intake/drafts/${draft.id}.json`), false);
      assert.equal((await readdir(path.join(root, ".legion/project/intake"))).some((entry) => entry.startsWith("itk_")), false);
    });
  }
});

test("direct staging and acceptance reject unresolved explicit preflight intent", async (t) => {
  const root = await scratch(t);
  const lifecycle = await import("../packages/cli/dist/workflow/intake/lifecycle.js");
  const preflight = await lifecycle.prepareIntakePreflight({
    repositoryRoot: root,
    createdAt: CREATED_AT,
    explicitRunId: "missing",
    explicitGoal: "Independent initiative"
  });
  assert.deepEqual(preflight.explorationSelectionIntent, { mode: "explicit", runId: "missing" });
  assert.equal(preflight.selectedExplorationRunId, undefined);
  const draft = {
    schemaVersion: "0.3.0", createdAt: CREATED_AT, kind: "intake-draft",
    id: "itd_unresolved-explicit", status: "draft", graphVersion: "1.2.0",
    projectMode: "greenfield", initiative: "Independent initiative", explorationRefs: [], proposedAnswers: [],
    injectedQuestions: [], unresolvedNodes: [], diagnostics: []
  };
  const source = ".legion/host-input/unresolved-explicit.json";
  await mkdir(path.dirname(path.join(root, source)), { recursive: true });
  await writeFile(path.join(root, source), JSON.stringify(draft), "utf8");

  const staged = await lifecycle.stageIntakeDraft({ repositoryRoot: root, draftFile: source, createdAt: CREATED_AT });

  assert.equal(staged.ok, false);
  assert.ok(staged.diagnostics.some((entry) => entry.code === "preflight_exploration_mismatch"));
  assert.equal(await fileExists(root, `.legion/project/intake/drafts/${draft.id}.json`), false);

  const stagedPath = `.legion/project/intake/drafts/${draft.id}.json`;
  await mkdir(path.dirname(path.join(root, stagedPath)), { recursive: true });
  const stagedBytes = JSON.stringify(draft);
  await writeFile(path.join(root, stagedPath), stagedBytes, "utf8");
  const accepted = await lifecycle.acceptStagedDraft({ repositoryRoot: root, draftId: draft.id, createdAt: CREATED_AT });
  assert.equal(accepted.ok, false);
  assert.ok(accepted.diagnostics.some((entry) => entry.code === "preflight_exploration_mismatch"));
  const invalidated = JSON.parse(await readFile(path.join(root, stagedPath), "utf8"));
  assert.equal(invalidated.status, "invalidated");
  assert.deepEqual(invalidated.proposedAnswers, draft.proposedAnswers);
  assert.deepEqual(invalidated.unresolvedNodes, draft.unresolvedNodes);
  assert.equal((await readdir(path.join(root, ".legion/project/intake"))).some((entry) => entry.startsWith("itk_")), false);
});

test("a degraded draft requires fresh map evidence when mapping later succeeds", async (t) => {
  const root = await scratch(t);
  await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
  await start(root, "--goal", "Recover mapping");
  const degraded = await start(root, "--map-failed", "temporary map failure");
  const draft = draftFromPreparation(degraded, {
    id: "itd_degraded-then-fresh",
    diagnostics: [degraded.preparation.map.warning]
  });
  const staged = await stage(root, draft, "degraded-then-fresh.json");
  assert.equal(staged.exitCode, 0, staged.stderr);
  await refreshMap(root);

  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", draft.id, "--json", "--created-at", CREATED_AT
  ]);

  assert.equal(accepted.exitCode, 1);
  assert.ok(parseJsonOutput(accepted).diagnostics.some((entry) => entry.code === "preflight_map_mismatch"));
  const resumed = await runCliCapture([
    "--repository-root", root, "start", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal(parseJsonOutput(resumed).preflight.map.freshness, "fresh");
  assert.equal(parseJsonOutput(resumed).preflight.mapFailure, undefined);
});

test("full-project maps include every classified language family and extensionless build configuration", async (t) => {
  const root = await scratch(t);
  const authoredFiles = [
    "src/main.c", "src/main.cc", "src/main.cpp", "src/main.cs", "src/main.css", "src/main.go",
    "src/main.h", "src/main.hpp", "src/main.html", "src/main.java", "src/main.js", "src/main.jsx",
    "src/main.kt", "src/main.kts", "src/main.mjs", "src/main.php", "src/main.py", "src/main.rb",
    "src/main.rs", "src/main.scala", "src/main.sh", "src/main.sql", "src/main.swift", "src/main.ts",
    "src/main.tsx", "src/main.vue", "Makefile"
  ];
  await mkdir(path.join(root, "src"));
  for (const relative of authoredFiles) await writeFile(path.join(root, relative), "original\n", "utf8");
  const refreshed = await refreshMap(root);
  const map = JSON.parse(await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")), "utf8"));
  assert.deepEqual(map.files.map((file) => file.path).filter((file) => authoredFiles.includes(file)).sort(), [...authoredFiles].sort());

  for (const relative of authoredFiles) {
    await writeFile(path.join(root, relative), "changed\n", "utf8");
    const state = await resolveMapState(root, ".", CREATED_AT);
    assert.equal(state.freshness, "stale", `${relative} must participate in the full-project fingerprint`);
    await writeFile(path.join(root, relative), "original\n", "utf8");
  }
});

test("every brownfield-causing file participates in hidden, oversized, and opaque map fingerprints", async (t) => {
  for (const fixture of [
    { name: "hidden", relative: ".private/main.ts", bytes: Buffer.from("export const hidden = 1;\n") },
    { name: "oversized", relative: "src/large.ts", bytes: Buffer.alloc(600 * 1024, 0x61) },
    { name: "opaque", relative: "src/opaque.ts", bytes: Buffer.from([0x65, 0x78, 0x70, 0x00, 0x6f, 0x72, 0x74]) }
  ]) {
    await t.test(fixture.name, async (t) => {
      const root = await scratch(t);
      await mkdir(path.dirname(path.join(root, fixture.relative)), { recursive: true });
      await writeFile(path.join(root, fixture.relative), fixture.bytes);
      const lifecycle = await import("../packages/cli/dist/workflow/intake/lifecycle.js");
      assert.equal(await lifecycle.classifyProjectMode(root), "brownfield");
      const refreshed = await refreshMap(root);
      const map = JSON.parse(await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")), "utf8"));
      assert.ok(map.files.some((file) => file.path === fixture.relative), `${fixture.relative} must be represented in the map`);

      const changed = Buffer.concat([fixture.bytes, Buffer.from([0x01])]);
      await writeFile(path.join(root, fixture.relative), changed);
      const state = await resolveMapState(root, ".", CREATED_AT);
      assert.equal(state.freshness, "stale");
    });
  }
});

test("shared traversal still excludes generated and runtime directories from classification and maps", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "generated"), { recursive: true });
  await writeFile(path.join(root, "src/main.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(root, "node_modules/generated/main.ts"), "export const generated = 1;\n", "utf8");
  const refreshed = await refreshMap(root);
  const map = JSON.parse(await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")), "utf8"));
  assert.equal(map.files.some((file) => file.path.startsWith("node_modules/")), false);

  await writeFile(path.join(root, "node_modules/generated/main.ts"), "export const generated = 2;\n", "utf8");
  assert.equal((await resolveMapState(root, ".", CREATED_AT)).freshness, "fresh");
});

test("latest map discovery rejects unsafe or inconsistent candidates and deterministically falls back with diagnostics", async (t) => {
  const fixtures = [
    {
      name: "traversal output",
      code: "map_artifact_path_invalid",
      artifactPath: "../outside-map.json"
    },
    {
      name: "malformed JSON",
      code: "map_artifact_json_invalid",
      bytes: () => "{"
    },
    {
      name: "malformed schema",
      code: "map_artifact_schema_invalid",
      bytes: (map) => JSON.stringify({ ...map, kind: "not_a_codebase_map" })
    },
    {
      name: "duplicate file path",
      code: "map_artifact_duplicate_path",
      bytes: (map) => JSON.stringify({ ...map, sourceFileCount: map.files.length + 1, files: [...map.files, map.files[0]] })
    },
    {
      name: "unsafe file path",
      code: "map_artifact_unsafe_path",
      bytes: (map) => JSON.stringify({ ...map, files: [{ ...map.files[0], path: "../outside.ts" }] })
    },
    {
      name: "declared count mismatch",
      code: "map_artifact_count_mismatch",
      bytes: (map) => JSON.stringify({ ...map, sourceFileCount: map.sourceFileCount + 1 })
    },
    {
      name: "declared fingerprint mismatch",
      code: "map_artifact_fingerprint_mismatch",
      bytes: (map) => JSON.stringify({ ...map, sourceFingerprint: "0".repeat(64) })
    }
  ];
  for (const [index, fixture] of fixtures.entries()) {
    await t.test(fixture.name, async (t) => {
      const root = await scratch(t);
      await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
      const refreshed = await refreshMap(root);
      const baseBytes = await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")));
      const baseMap = JSON.parse(baseBytes.toString("utf8"));
      const runId = `invalid-${String(index).padStart(2, "0")}`;
      await writeMapRun(root, {
        runId,
        ...(fixture.artifactPath === undefined ? {} : { artifactPath: fixture.artifactPath }),
        ...(fixture.bytes === undefined ? {} : { mapBytes: fixture.bytes(baseMap) })
      });

      const state = await resolveMapState(root, ".", "2026-08-09T12:00:00.000Z");

      assert.equal(state.freshness, "fresh");
      assert.equal(state.mapArtifact.path, refreshed.mapArtifactPath);
      assert.deepEqual(state.diagnostics.map(({ runId: id, code }) => ({ runId: id, code })), [
        { runId, code: fixture.code }
      ]);
      assert.match(state.diagnostics[0].message, new RegExp(runId));
    });
  }
});

test("latest map discovery rejects final and escaping ancestor symlinks through artifact guards", async (t) => {
  await t.test("final symlink", async (t) => {
    if (!requireFileSymlink(t)) return;
    const root = await scratch(t);
    await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
    const refreshed = await refreshMap(root);
    const baseBytes = await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")));
    const run = await writeMapRun(root, { runId: "linked-final" });
    const finalPath = path.join(root, ...run.artifactPath.split("/"));
    const target = path.join(root, "map-target.json");
    await writeFile(target, baseBytes);
    await symlink(target, finalPath, "file");

    const state = await resolveMapState(root, ".", "2026-08-09T12:00:00.000Z");
    assert.equal(state.mapArtifact.path, refreshed.mapArtifactPath);
    assert.equal(state.diagnostics[0].code, "map_artifact_path_invalid");
  });

  await t.test("escaping ancestor symlink", async (t) => {
    if (!requireDirSymlink(t)) return;
    const root = await scratch(t);
    await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
    const refreshed = await refreshMap(root);
    const baseBytes = await readFile(path.join(root, ...refreshed.mapArtifactPath.split("/")));
    const outside = await mkdtemp(path.join(tmpdir(), "legion-map-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, "map.json"), baseBytes);
    await symlink(outside, path.join(root, ".legion/project/workflow/map/linked-ancestor"), directoryLinkType());
    await writeMapRun(root, {
      runId: "ancestor-output",
      artifactPath: ".legion/project/workflow/map/linked-ancestor/map.json"
    });

    const state = await resolveMapState(root, ".", "2026-08-09T12:00:00.000Z");
    assert.equal(state.mapArtifact.path, refreshed.mapArtifactPath);
    assert.equal(state.diagnostics[0].code, "map_artifact_path_invalid");
  });
});

test("explicit goal and edits outrank selected exploration initiative, which outranks the initiative question", async (t) => {
  const explorationRoot = await scratch(t);
  await writeExploration(explorationRoot, "handoff", "Exploration-derived initiative");
  const selected = await start(explorationRoot);
  assert.deepEqual(selected.preparation.initiative, {
    value: "Exploration-derived initiative",
    source: "exploration",
    explorationRunId: "handoff"
  });

  const explicit = await start(explorationRoot, "--goal", "Explicit operator initiative");
  assert.deepEqual(explicit.preparation.initiative, {
    value: "Explicit operator initiative",
    source: "explicit"
  });

  const resumed = await start(explorationRoot);
  assert.deepEqual(resumed.preparation.initiative, {
    value: "Explicit operator initiative",
    source: "explicit"
  });

  const emptyRoot = await scratch(t);
  const missing = await start(emptyRoot);
  assert.equal(missing.preparation.status, "initiative_required");
});

test("repository preparation contract stays initiative-scoped and keeps unsupported claims unresolved", async (t) => {
  const root = await scratch(t);
  await writeFile(path.join(root, "README.md"), "# Product notes\n", "utf8");
  const payload = await start(root, "--goal", "Add deterministic asset lookup");

  assert.equal(payload.preparation.status, "repository_review_required");
  assert.equal(payload.preparation.review.scope, "initiative");
  assert.deepEqual(payload.preparation.review.inferencePrecedence, [
    "explicit_user_statement_or_edit",
    "selected_exploration",
    "repository_inference"
  ]);
  assert.equal(payload.preparation.review.architectureAnalysis, "full");
  assert.deepEqual(payload.preparation.review.propose, [
    "compatibility obligations",
    "acceptance criteria",
    "executable proof commands",
    "protected tests",
    "constraints",
    "verification defaults",
    "risk indicators"
  ]);
  assert.equal(payload.preparation.review.unrelatedBehavior, "architecture_context_only");
  assert.equal(payload.preparation.review.conflicts, "unresolved_questions");
  assert.equal(payload.preparation.review.unsupportedAssumptions, "unresolved_questions");
  assert.equal(payload.preparation.review.absentNonGoalsAndConstraints, "unresolved_questions");
});

test("preflight JSON exposes one stable host-facing contract without allocating session state", async (t) => {
  const root = await scratch(t);
  const payload = await start(root);

  assert.equal(payload.status, "preflight");
  assert.equal(payload.projectMode, "greenfield");
  assert.deepEqual(payload.exploration, {
    intent: { mode: "automatic" },
    selectedRunId: null,
    compatible: []
  });
  assert.equal(payload.mapState.freshness, "absent");
  assert.deepEqual(payload.activeDraft, null);
  assert.deepEqual(payload.activeSession, null);
  assert.deepEqual(payload.warnings, []);
  assert.deepEqual(payload.diagnostics, []);
  assert.deepEqual(payload.initiative, null);
  assert.equal(payload.reviewContract.scope, "initiative");
  assert.deepEqual(payload.preparation.map, { action: "skip", coverage: "not_applicable", scope: "." });
  assert.deepEqual(payload.nextAction, {
    command: 'legion start --goal "<initiative>"',
    reason: "One initiative is required before repository synthesis."
  });
  assert.equal(payload.session, undefined);
});

test("draft review JSON and human output group the validated graph contract and offer all decisions", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const staged = await stage(root, reviewDraft(prepared));
  assert.equal(staged.exitCode, 0, staged.stderr);
  const payload = parseJsonOutput(staged);

  assert.equal(payload.status, "draft_review");
  assert.equal(payload.draftSummary.id, "itd_contract-review");
  assert.equal(payload.draftSummary.status, "draft");
  assert.match(payload.draftSummary.entity.sha256, /^sha256:[0-9a-f]{64}$/);
  const durableDraftBytes = await readFile(path.join(root, ...payload.draftSummary.entity.path.split("/")));
  assert.equal(
    payload.draftSummary.entity.sha256,
    `sha256:${createHash("sha256").update(durableDraftBytes).digest("hex")}`
  );
  assert.deepEqual(payload.review.projectAndProblem.map((entry) => entry.slot), [
    "project.name", "project.summary", "project.owner",
    "problem.statement", "problem.users", "problem.success"
  ]);
  assert.deepEqual(payload.review.requirements.map((entry) => entry.slot), [
    "requirements.1.statement", "requirements.1.priority", "requirements.1.category"
  ]);
  assert.deepEqual(payload.review.criteriaAndProofs.map((entry) => entry.slot), [
    "requirements.1.criteria.1.statement", "requirements.1.criteria.1.proof",
    "requirements.1.criteria.1.detail", "requirements.1.criteria.1.surface.kind",
    "requirements.1.criteria.1.surface.interface", "requirements.1.criteria.1.surface.rationale",
    "requirements.1.criteria.1.surface.pins", "requirements.1.criteria.1.acceptance-paths",
    "requirements.1.criteria.1.more"
  ]);
  assert.equal(payload.review.constraints[0].value, "No new runtime dependencies");
  assert.equal(payload.review.nonGoals[0].value, "Remote asset hosting");
  assert.equal(payload.review.defaults.risk[0].value, "R1");
  assert.equal(payload.review.defaults.budget.length, 3);
  assert.equal(payload.review.defaults.verification[0].value, "pnpm test");
  assert.deepEqual(payload.unresolvedItems.map((entry) => entry.nodeId), ["pref-notes"]);
  assert.deepEqual(payload.confidenceSummary, { researched: 26, inferred: 1, assumed: 0 });
  assert.equal(payload.evidenceSummary.totalReferences, 0);
  assert.deepEqual(payload.actions, {
    accept: { command: "legion start --accept-draft", draftId: "itd_contract-review" },
    revise: { command: "legion start --stage-draft .legion/var/intake-drafts/intake-draft.json", replacesDraftId: "itd_contract-review" },
    discard: { command: "legion start --discard-draft", draftId: "itd_contract-review" }
  });
  const humanReview = await runCliCapture(["--repository-root", root, "start"]);
  assert.equal(humanReview.exitCode, 0, humanReview.stderr);
  for (const heading of ["Project and problem", "Requirements", "Criteria and proofs", "Constraints", "Non-goals", "Risk, budget, and verification defaults", "Evidence and confidence", "Diagnostics and unresolved items", "Decision required"]) {
    assert.match(humanReview.stdout, new RegExp(heading, "i"));
  }
  assert.match(humanReview.stdout, /accept.*revise.*discard/is);
});

test("active-draft accept asks only the unresolved graph node and preserves legacy acceptance fields", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared))).exitCode, 0);

  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  const legacyPayload = parseJsonOutput(accepted);
  assert.equal(legacyPayload.status, "interview");
  assert.equal(legacyPayload.draft.id, "itd_contract-review");
  assert.equal(legacyPayload.session.answers.length, 27);

  const next = await runCliCapture(["--repository-root", root, "start", "--json"]);
  assert.equal(next.exitCode, 0, next.stderr);
  const payload = parseJsonOutput(next);
  assert.equal(payload.status, "question");
  assert.equal(payload.question.nodeId, "pref-notes");
  assert.equal(payload.question.slot, "preferences.notes");
  assert.equal(payload.session.id, legacyPayload.session.id);
  assert.match(payload.nextAction.command, /--answer/);
});

test("discard durably closes the active draft without creating a session", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared))).exitCode, 0);

  const discarded = await runCliCapture([
    "--repository-root", root, "start", "--discard-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(discarded.exitCode, 0, discarded.stderr);
  const payload = parseJsonOutput(discarded);
  assert.equal(payload.status, "preflight");
  assert.equal(payload.discardedDraft.id, "itd_contract-review");
  assert.equal(payload.discardedDraft.status, "discarded");
  assert.deepEqual(payload.activeDraft, null);
  assert.deepEqual(payload.activeSession, null);
  assert.equal(payload.nextAction.command, "legion start --stage-draft .legion/var/intake-drafts/intake-draft.json");
  const persisted = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_contract-review.json"), "utf8"));
  assert.equal(persisted.status, "discarded");
  const intakeEntries = await readdir(path.join(root, ".legion/project/intake"));
  assert.equal(intakeEntries.some((entry) => entry.startsWith("itk_")), false);
});

test("staging a replacement invalidates only the prior open draft and returns full review", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared, "itd_review-one"), "one.json")).exitCode, 0);

  const replacement = await stage(root, reviewDraft(prepared, "itd_review-two", {
    diagnostics: ["Replacement incorporates the operator revision."]
  }), "two.json");
  assert.equal(replacement.exitCode, 0, replacement.stderr);
  const payload = parseJsonOutput(replacement);
  assert.equal(payload.status, "draft_review");
  assert.equal(payload.draftSummary.id, "itd_review-two");
  assert.equal(payload.replacesDraft.id, "itd_review-one");
  assert.equal(payload.replacesDraft.status, "invalidated");
  const prior = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_review-one.json"), "utf8"));
  assert.equal(prior.status, "invalidated");
});

test("revision after acceptance is refused without mutating the accepted draft", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared, "itd_accepted-review"), "accepted.json")).exitCode, 0);
  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);

  const replacement = await stage(root, reviewDraft(prepared, "itd_too-late"), "too-late.json");
  assert.equal(replacement.exitCode, 1);
  assert.ok(parseJsonOutput(replacement).diagnostics.some((entry) => entry.code === "active_session"));
  const durable = JSON.parse(await readFile(path.join(root, ".legion/project/intake/drafts/itd_accepted-review.json"), "utf8"));
  assert.equal(durable.status, "accepted");
  assert.equal(await fileExists(root, ".legion/project/intake/drafts/itd_too-late.json"), false);
});

test("staging rejects unresolved items that do not belong to the validated graph", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const invalid = reviewDraft(prepared, "itd_unknown-unresolved", {
    unresolvedNodes: [{
      nodeId: "invented-node",
      slot: "invented.slot",
      question: "Invented?",
      rationale: "This structure is not owned by the CLI graph.",
      evidenceRefs: []
    }]
  });
  const result = await stage(root, invalid);
  assert.equal(result.exitCode, 1);
  assert.ok(parseJsonOutput(result).diagnostics.some((entry) => entry.code === "unknown_unresolved_node"));
});

test("complete remains a stable legacy-readable state after a fully answered accepted draft", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const completeDraft = reviewDraft(prepared, "itd_complete-review", {
    proposedAnswers: [
      ...reviewDraft(prepared).proposedAnswers,
      draftAnswer("pref-notes", "preferences.notes", "No additional notes.")
    ],
    unresolvedNodes: [],
    diagnostics: []
  });
  assert.equal((await stage(root, completeDraft)).exitCode, 0);
  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_complete-review", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  const result = await runCliCapture(["--repository-root", root, "start", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = parseJsonOutput(result);
  assert.equal(payload.status, "complete");
  assert.equal(payload.question, null);
  assert.equal(payload.session.answered, payload.session.total);
  assert.match(payload.nextAction.command, /--finalize/);
});

test("draft decisions are bound to the single displayed draft bytes", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const first = await stage(root, reviewDraft(prepared, "itd_displayed-a"), "a.json");
  assert.equal(first.exitCode, 0, first.stderr);
  const second = await stage(root, reviewDraft(prepared, "itd_displayed-b"), "b.json");
  assert.equal(second.exitCode, 0, second.stderr);

  const staleExplicit = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_displayed-a", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(staleExplicit.exitCode, 1);
  assert.equal(parseJsonOutput(staleExplicit).status, "rejected");

  await rm(path.join(root, ".legion/project/intake/active-review.json"), { force: true });
  const undisplayed = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(undisplayed.exitCode, 1);
  assert.ok(parseJsonOutput(undisplayed).diagnostics.some((entry) => entry.code === "draft_review_required"));
  assert.equal(await fileExists(root, ".legion/project/intake/drafts/itd_displayed-b.json"), true);
  assert.equal((await readdir(path.join(root, ".legion/project/intake"))).some((entry) => entry.startsWith("itk_")), false);
});

test("accept rejects when displayed draft bytes change and never creates a session", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared, "itd_digest-bound"))).exitCode, 0);
  const durablePath = path.join(root, ".legion/project/intake/drafts/itd_digest-bound.json");
  const durable = JSON.parse(await readFile(durablePath, "utf8"));
  durable.diagnostics.push("Bytes changed after display.");
  await writeFile(durablePath, `${JSON.stringify(durable, undefined, 2)}\n`, "utf8");

  const attempted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_digest-bound", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(attempted.exitCode, 1);
  const payload = parseJsonOutput(attempted);
  assert.equal(payload.status, "rejected");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "displayed_draft_changed"));
  assert.equal((await readdir(path.join(root, ".legion/project/intake"))).some((entry) => entry.startsWith("itk_")), false);
});

test("ambiguous open drafts reject a bare decision conservatively", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared, "itd_ambiguous-a"))).exitCode, 0);
  const duplicate = reviewDraft(prepared, "itd_ambiguous-b");
  await writeFile(
    path.join(root, ".legion/project/intake/drafts/itd_ambiguous-b.json"),
    `${JSON.stringify(duplicate, undefined, 2)}\n`,
    "utf8"
  );

  const attempted = await runCliCapture([
    "--repository-root", root, "start", "--discard-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(attempted.exitCode, 1);
  const payload = parseJsonOutput(attempted);
  assert.equal(payload.status, "rejected");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "ambiguous_active_drafts"));
});

test("start terminal and preparation actions are mutually exclusive before mutation", async (t) => {
  for (const args of [
    ["--accept-draft", "--discard-draft"],
    ["--stage-draft", ".legion/host-input/missing.json", "--accept-draft"],
    ["--goal", "Changed goal", "--discard-draft"],
    ["--answer", "project-name=Ignored", "--finalize"],
    ["--accept-draft", "--without-exploration"],
    ["--discard-draft", "--from-exploration", "run_missing"],
    ["--accept-draft", "--next"],
    ["--discard-draft", "--session", "itk_20260808-120000000"],
    ["--from-exploration", "run_missing", "--without-exploration"]
  ]) {
    await t.test(args.join(" "), async (t) => {
      const root = await scratch(t);
      const before = await start(root, "--goal", "Original goal");
      assert.equal((await stage(root, reviewDraft(before, "itd_exclusive"))).exitCode, 0);
      const draftPath = path.join(root, ".legion/project/intake/drafts/itd_exclusive.json");
      const draftBytes = await readFile(draftPath);
      const preflightBytes = await readFile(path.join(root, ".legion/project/intake/preflight.json"));

      const attempted = await runCliCapture([
        "--repository-root", root, "start", ...args, "--json", "--created-at", CREATED_AT
      ]);
      assert.equal(attempted.exitCode, 1);
      const payload = parseJsonOutput(attempted);
      assert.equal(payload.status, "usage_error");
      assert.ok(payload.diagnostics.some((entry) => entry.code === "usage_error"));
      assert.deepEqual(await readFile(draftPath), draftBytes);
      assert.deepEqual(await readFile(path.join(root, ".legion/project/intake/preflight.json")), preflightBytes);
    });
  }
});

test("draft staging intentionally combines with preparation edits", async (t) => {
  const root = await scratch(t);
  const initial = await start(root, "--goal", "Original goal");
  const draft = reviewDraft(initial, "itd_stage-goal", { initiative: "Revised goal" });
  const staged = await stage(root, draft, "stage-goal.json", "--goal", "Revised goal");
  assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
  assert.equal(parseJsonOutput(staged).draft.initiative, "Revised goal");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".legion/project/intake/preflight.json"), "utf8")).initiative, {
    value: "Revised goal",
    source: "explicit"
  });
});

test("draft staging intentionally combines with exploration preparation selectors", async (t) => {
  await t.test("from-exploration", async (t) => {
    const root = await scratch(t);
    await writeExploration(root, "stage-source", "Exploration selected during staging");
    const initial = await start(root, "--goal", "Explicit initiative survives selection");
    const reference = await explorationRef(root, "stage-source");
    const draft = reviewDraft(initial, "itd_stage-from", { explorationRefs: [reference] });

    const staged = await stage(root, draft, "stage-from.json", "--from-exploration", "stage-source");

    assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
    assert.equal(parseJsonOutput(staged).preflight.selectedExplorationRunId, "stage-source");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".legion/project/intake/preflight.json"), "utf8")).explorationSelectionIntent, {
      mode: "explicit",
      runId: "stage-source"
    });
  });

  await t.test("without-exploration", async (t) => {
    const root = await scratch(t);
    await writeExploration(root, "stage-opt-out", "Automatically selected exploration");
    const initial = await start(root, "--goal", "Explicit initiative survives opt-out");
    const draft = reviewDraft(initial, "itd_stage-without");

    const staged = await stage(root, draft, "stage-without.json", "--without-exploration");

    assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
    assert.equal(parseJsonOutput(staged).preflight.selectedExplorationRunId, undefined);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".legion/project/intake/preflight.json"), "utf8")).explorationSelectionIntent, {
      mode: "none"
    });
  });
});

test("draft staging preserves a same-command degraded map failure", async (t) => {
  const root = await scratch(t);
  await writeFile(path.join(root, "app.ts"), "export {};\n", "utf8");
  const prepared = await start(root, "--goal", "Bound the repository review");
  const { degradedCoverageWarning } = await import("../packages/cli/dist/workflow/intake/lifecycle.js");
  const reason = "map worker unavailable";
  const draft = reviewDraft(prepared, "itd_stage-map-failure", {
    diagnostics: [degradedCoverageWarning(reason)]
  });
  const staged = await stage(root, draft, "stage-map-failure.json", "--map-failed", reason);
  assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
  assert.equal(parseJsonOutput(staged).draft.id, "itd_stage-map-failure");
});

test("every non-preparation start mode rejects every preparation selector before mutation", async (t) => {
  const selectors = [
    { label: "goal", args: ["--goal", "Ignored goal"] },
    { label: "map-failed", args: ["--map-failed", "ignored failure"] },
    { label: "from-exploration", args: ["--from-exploration", "run_different"] },
    { label: "without-exploration", args: ["--without-exploration"] }
  ];
  const modes = [
    { label: "answer", args: (sessionId) => ["--session", sessionId, "--answer", "project-name=Ignored"] },
    { label: "accept-proposal", args: (sessionId) => ["--session", sessionId, "--accept-proposal"] },
    { label: "skip", args: (sessionId) => ["--session", sessionId, "--skip"] },
    { label: "back", args: (sessionId) => ["--session", sessionId, "--back"] },
    { label: "session-status", args: (sessionId) => ["--session-status", "--session", sessionId] },
    { label: "finalize", args: (sessionId) => ["--finalize", "--session", sessionId] },
    { label: "abort", args: (sessionId) => ["--abort", "--session", sessionId] },
    { label: "intake", args: (sessionId) => ["--session", sessionId, "--intake", ".legion/host-input/missing.json"] },
    { label: "bare-session", args: (sessionId) => ["--session", sessionId] },
    { label: "direct", args: () => ["--name", "Ignored direct project"] }
  ];

  for (const mode of modes) {
    for (const selector of selectors) {
      await t.test(`${mode.label}+${selector.label}`, async (t) => {
        const root = await scratch(t);
        await start(root, "--goal", "Original goal");
        const question = await start(root, "--next");
        const sessionId = question.session.id;
        const before = await repositorySnapshot(root);

        const attempted = await runCliCapture([
          "--repository-root", root,
          "start",
          ...mode.args(sessionId),
          ...selector.args,
          "--json",
          "--created-at", CREATED_AT
        ]);

        assert.equal(attempted.exitCode, 1);
        const payload = parseJsonOutput(attempted);
        assert.equal(payload.status, "usage_error");
        assert.deepEqual(await repositorySnapshot(root), before, `${mode.label}+${selector.label} mutated repository state`);
        if (mode.label === "session-status" && selector.label === "from-exploration") {
          assert.equal(JSON.parse(await readFile(path.join(root, `.legion/project/intake/${sessionId}/session.json`), "utf8")).status, "active");
        }
      });
    }
  }
});

test("documented session-selected interview forms remain valid", async (t) => {
  const root = await scratch(t);
  await start(root, "--goal", "Original goal");
  const question = await start(root, "--next");
  const sessionId = question.session.id;
  const answered = await runCliCapture([
    "--repository-root", root, "start", "--session", sessionId,
    "--answer", "project-name=Asset Mapper", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(answered.exitCode, 0, answered.stderr);
  const status = await runCliCapture([
    "--repository-root", root, "start", "--session-status", "--session", sessionId,
    "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(parseJsonOutput(status).session.id, sessionId);
});

test("draft review next action is an explicit human decision and human evidence is inspectable", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const evidencePath = ".legion/project/evidence/evidence.txt";
  await mkdir(path.dirname(path.join(root, evidencePath)), { recursive: true });
  const evidenceBytes = Buffer.from("stable evidence\n");
  await writeFile(path.join(root, evidencePath), evidenceBytes);
  const evidence = {
    kind: "repository-file",
    artifact: { path: evidencePath, sha256: `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}` },
    anchor: "line:1"
  };
  const draft = reviewDraft(prepared, "itd_evidence-review");
  draft.proposedAnswers[0].evidenceRefs = [evidence, evidence];
  const staged = await stage(root, draft);
  assert.equal(staged.exitCode, 0, `${staged.stderr}\n${staged.stdout}`);
  const payload = parseJsonOutput(staged);
  assert.equal(payload.nextAction.type, "human_decision");
  assert.notEqual(payload.nextAction.command, "legion start");
  assert.equal(payload.evidenceSummary.uniqueReferences, 1);

  const human = await runCliCapture(["--repository-root", root, "start"]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /repository-file/);
  assert.match(human.stdout, /\.legion\/project\/evidence\/evidence\.txt/);
  assert.match(human.stdout, /sha256:[0-9a-f]{64}/);
  assert.match(human.stdout, /line:1/);
});

test("draft review and rejection payloads remain disjoint stable shapes", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  const successResult = await stage(root, reviewDraft(prepared, "itd_shape-table"));
  const successPayload = parseJsonOutput(successResult);
  for (const key of [
    "draft", "draftSummary", "artifactPath", "preflight", "review", "unresolvedItems",
    "warnings", "diagnostics", "confidenceSummary", "evidenceSummary", "actions", "nextAction"
  ]) assert.ok(Object.hasOwn(successPayload, key), `draft_review missing ${key}`);

  const invalidDraft = reviewDraft(prepared, "itd_shape-invalid", {
    unresolvedNodes: [{
      nodeId: "unknown-node", slot: "unknown.slot", question: "Unknown?",
      rationale: "Invalid shape fixture.", evidenceRefs: []
    }]
  });
  const invalidStage = parseJsonOutput(await stage(root, invalidDraft, "invalid-shape.json"));
  const staleDecision = parseJsonOutput(await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "itd_not-displayed", "--json", "--created-at", CREATED_AT
  ]));
  await rm(path.join(root, ".legion/project/intake/active-review.json"), { force: true });
  const missingReview = parseJsonOutput(await runCliCapture([
    "--repository-root", root, "start", "--discard-draft", "--json", "--created-at", CREATED_AT
  ]));

  for (const [label, payload] of [["invalid stage", invalidStage], ["stale decision", staleDecision], ["missing review", missingReview]]) {
    assert.equal(payload.status, "rejected", label);
    assert.equal(payload.ok, false, label);
    assert.ok(Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0, label);
    assert.equal(payload.review, undefined, `${label} leaked a partial draft_review contract`);
  }
});

test("displayed entity digest is the exact persisted raw digest used by decisions", async (t) => {
  const root = await scratch(t);
  const prepared = await start(root, "--goal", "Make lookup deterministic");
  assert.equal((await stage(root, reviewDraft(prepared, "itd_raw-digest"))).exitCode, 0);
  const durablePath = path.join(root, ".legion/project/intake/drafts/itd_raw-digest.json");
  const parsed = JSON.parse(await readFile(durablePath, "utf8"));
  const reordered = Object.fromEntries(Object.entries(parsed).reverse());
  const raw = Buffer.from(JSON.stringify(reordered));
  await writeFile(durablePath, raw);

  const displayed = await runCliCapture([
    "--repository-root", root, "start", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(displayed.exitCode, 0, displayed.stderr);
  const payload = parseJsonOutput(displayed);
  const expectedDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  assert.equal(payload.draftSummary.entity.sha256, expectedDigest);
  const activeReview = JSON.parse(await readFile(path.join(root, ".legion/project/intake/active-review.json"), "utf8"));
  assert.equal(activeReview.draftSha256, expectedDigest);

  const accepted = await runCliCapture([
    "--repository-root", root, "start", "--accept-draft", "--json", "--created-at", CREATED_AT
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.equal(parseJsonOutput(accepted).draft.id, "itd_raw-digest");
});

test("malformed candidate artifacts block display, decisions, and replacement without mutation", async (t) => {
  for (const candidate of ["corrupt-file", "candidate-directory"]) {
    for (const action of ["display", "accept", "discard", "replace"]) {
      await t.test(`${candidate} blocks ${action}`, async (t) => {
        const root = await scratch(t);
        const prepared = await start(root, "--goal", "Make lookup deterministic");
        assert.equal((await stage(root, reviewDraft(prepared, "itd_candidate-good"))).exitCode, 0);
        const draftPath = path.join(root, ".legion/project/intake/drafts/itd_candidate-good.json");
        const before = await readFile(draftPath);
        const candidatePath = path.join(root, ".legion/project/intake/drafts/itd_candidate-bad.json");
        if (candidate === "corrupt-file") await writeFile(candidatePath, "{", "utf8");
        else await mkdir(candidatePath);

        const attempted = action === "display"
          ? await runCliCapture(["--repository-root", root, "start", "--json", "--created-at", CREATED_AT])
          : action === "accept"
            ? await runCliCapture(["--repository-root", root, "start", "--accept-draft", "--json", "--created-at", CREATED_AT])
            : action === "discard"
              ? await runCliCapture(["--repository-root", root, "start", "--discard-draft", "--json", "--created-at", CREATED_AT])
              : await stage(root, reviewDraft(prepared, "itd_candidate-replacement"), "replacement.json");
        assert.equal(attempted.exitCode, 1);
        const payload = parseJsonOutput(attempted);
        assert.equal(payload.status, "rejected");
        assert.ok(payload.diagnostics.some((entry) => entry.code === "invalid_draft_candidate"));
        assert.deepEqual(await readFile(draftPath), before);
        assert.equal(await fileExists(root, ".legion/project/intake/drafts/itd_candidate-replacement.json"), false);
      });
    }
  }
});
