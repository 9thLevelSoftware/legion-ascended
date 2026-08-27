import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatEntityId } from "@legion/protocol";
import { hashContent, stableProtocolJson } from "@legion/artifacts";
import { writeCodeIndexStore } from "@legion/index-store";
import { discoverLatestStructuralCodeIndex, fingerprintSourceFiles, structuralSnapshotId } from "../dist/workflow/codebase-map.js";
import { buildStructuralCodeIndex } from "../dist/workflow/code-index.js";
import {
  createBrownfieldAssessment,
  readBrownfieldAssessment,
  updateBrownfieldAssessmentState
} from "../dist/workflow/brownfield-assessment.js";
import {
  synthesizeBrownfieldDesign,
  synthesizeBrownfieldAssessment
} from "../dist/workflow/brownfield-synthesis.js";

const HASH = "a".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceEvidence(path = "src/app.ts", note = "bounded source evidence") {
  return { kind: "source-file", path, sha256: HASH, note };
}

function structuralEvidence(factId = "imp_aaaaaaaaaaaaaaaaaaaaaaaa") {
  return {
    kind: "structural-fact",
    path: ".legion/project/workflow/map/run/semantic-index.sqlite",
    sha256: HASH,
    factId,
    note: "bounded structural fact"
  };
}

function finding({
  id,
  specialist = "code",
  title = "Unsafe boundary",
  statement = "The boundary is not verified.",
  severity = "major",
  confidence = "medium",
  evidence = [sourceEvidence()],
  recommendation = "Add a bounded verification."
}) {
  return { id, specialist, title, statement, severity, confidence, evidence, assumptions: [], recommendation };
}

function signals(overrides = {}) {
  return {
    summary: {
      sourceFiles: 3,
      coverageFiles: 3,
      symbols: 4,
      imports: 2,
      exports: 2,
      testFiles: 1,
      testToSourceLinks: 1,
      dependencyEdges: 2,
      highRiskSignals: 1,
      unsupportedSignals: 1
    },
    dependencyEdges: [],
    testFiles: ["test/app.test.ts"],
    testToSourceLinks: [{ testPath: "test/app.test.ts", sourcePath: "src/app.ts", reason: "conservative filename match" }],
    architectureSignals: [{
      code: "unsupported-file",
      severity: "moderate",
      statement: "One file has unsupported coverage.",
      evidence: [sourceEvidence("src/opaque.bin")]
    }],
    riskSignals: [],
    ...overrides
  };
}

function specialists({ findings = [], assumptions = [], executionRecords = [], ...rest } = {}) {
  return { ok: true, roster: [], packs: [], findings, assumptions, executionRecords, diagnostics: [], ...rest };
}

async function makeAssessmentFixture() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-synthesis-"));
  const generatedAt = new Date().toISOString();
  const runId = `${generatedAt.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-fixture`;
  const sourcePath = "src/app.ts";
  const sourceText = "export const answer = 42;\n";
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await writeFile(path.join(repositoryRoot, sourcePath), sourceText, "utf8");
  const sourceFile = { path: sourcePath, sha256: sha256(sourceText), sizeBytes: Buffer.byteLength(sourceText), lineCount: 2, symbols: [], headings: [], summary: "fixture" };
  const sourceFingerprint = fingerprintSourceFiles([sourceFile]);
  const snapshotId = structuralSnapshotId(runId, sourceFingerprint);
  const mapRunId = formatEntityId("run", `map-${sha256(runId).slice(0, 32)}`);
  const draft = await buildStructuralCodeIndex({ snapshotId, mapRunId, generatedAt, scope: ".", sourceFingerprint, files: [{ path: sourcePath, sha256: sourceFile.sha256, text: sourceText }] });
  const artifactRoot = `.legion/project/workflow/map/${runId}`;
  const absoluteRoot = path.join(repositoryRoot, ...artifactRoot.split("/"));
  await mkdir(absoluteRoot, { recursive: true });
  const sqlitePath = path.join(absoluteRoot, "semantic-index.sqlite");
  writeCodeIndexStore({ databasePath: sqlitePath, snapshot: { symbols: draft.symbols, imports: draft.imports, exports: draft.exports } });
  const sqliteBytes = await readFile(sqlitePath);
  const snapshot = { schemaVersion: 1, kind: "code_index_snapshot", ...draft, sqlite: { path: `${artifactRoot}/semantic-index.sqlite`, sha256: sha256(sqliteBytes) } };
  const semanticIndexText = stableProtocolJson(snapshot);
  const map = { schemaVersion: 1, kind: "codebase_map", generatedAt, scope: ".", sourceFingerprint, sourceFileCount: 1, files: [sourceFile] };
  const mapText = stableProtocolJson(map);
  await writeFile(path.join(absoluteRoot, "semantic-index.json"), semanticIndexText, "utf8");
  await writeFile(path.join(absoluteRoot, "map.json"), mapText, "utf8");
  await writeFile(path.join(absoluteRoot, "workflow-run.json"), stableProtocolJson({
    schemaVersion: 1, kind: "workflow_run", workflow: "map", runId, createdAt: generatedAt, status: "completed", input: { profile: "structural" },
    outputs: { indexProfile: "structural", mapRunId, snapshotId, sourceFingerprint, sourceFileCount: 1, generatedAt, semanticIndexArtifactPath: `${artifactRoot}/semantic-index.json`, semanticSqliteArtifactPath: `${artifactRoot}/semantic-index.sqlite`, mapArtifactPath: `${artifactRoot}/map.json`, semanticIndexSha256: hashContent(semanticIndexText).slice("sha256:".length), mapArtifactSha256: hashContent(mapText).slice("sha256:".length) },
    nextAction: { command: "legion map", reason: "fixture" }, diagnostics: []
  }), "utf8");
  const discovery = await discoverLatestStructuralCodeIndex(repositoryRoot);
  assert.ok(discovery.record, JSON.stringify(discovery.diagnostics));
  return { repositoryRoot, snapshot: discovery.record, async cleanup() { await rm(repositoryRoot, { recursive: true, force: true }); } };
}

test("deduplicates only identical finding semantics with identical evidence", () => {
  const duplicateA = finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa" });
  const duplicateB = finding({ id: "af_bbbbbbbbbbbbbbbbbbbbbbbb" });
  const sameTitleDifferentEvidence = finding({ id: "af_cccccccccccccccccccccccc", evidence: [sourceEvidence("src/other.ts")] });
  const design = synthesizeBrownfieldDesign({ signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }), specialists: specialists({ findings: [duplicateB, sameTitleDifferentEvidence, duplicateA] }) });
  assert.equal(design.prioritizedFindings.filter((entry) => entry.title === "Unsafe boundary").length, 2);
  assert.deepEqual(design.prioritizedFindings.filter((entry) => entry.title === "Unsafe boundary").map((entry) => entry.evidence[0].path), ["src/app.ts", "src/other.ts"]);
});

test("preserves dissent and records it as input requiring resolution", () => {
  const first = finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa", specialist: "architecture", title: "Module boundary", statement: "The module boundary is intentionally public.", severity: "minor" });
  const second = finding({ id: "af_bbbbbbbbbbbbbbbbbbbbbbbb", specialist: "security", title: "Module boundary", statement: "The module boundary exposes an unintended entry point.", severity: "major", confidence: "high" });
  const design = synthesizeBrownfieldDesign({ signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }), specialists: specialists({ findings: [second, first] }) });
  assert.equal(design.prioritizedFindings.filter((entry) => entry.title === "Module boundary").length, 2);
  assert.ok(design.assumptionsRequiringInput.some((entry) => /disagree|dissent/i.test(entry.statement)));
  assert.ok(design.openQuestions.some((entry) => /module boundary/i.test(entry)));
});

test("ranks by severity, confidence, evidence count, source path, and fact id", () => {
  const findings = [
    finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa", title: "Informational", severity: "informational", confidence: "high" }),
    finding({ id: "af_bbbbbbbbbbbbbbbbbbbbbbbb", title: "Major low", severity: "major", confidence: "low", evidence: [sourceEvidence("src/z.ts")] }),
    finding({ id: "af_cccccccccccccccccccccccc", title: "Critical unknown", severity: "critical", confidence: "unknown", evidence: [structuralEvidence("imp_zzzzzzzzzzzzzzzzzzzzzzzz")] }),
    finding({ id: "af_dddddddddddddddddddddddd", title: "Major high", severity: "major", confidence: "high", evidence: [sourceEvidence("src/z.ts"), sourceEvidence("src/a.ts")] }),
    finding({ id: "af_eeeeeeeeeeeeeeeeeeeeeeee", title: "Major high path", severity: "major", confidence: "high", evidence: [sourceEvidence("src/a.ts")] })
  ];
  const design = synthesizeBrownfieldDesign({ signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }), specialists: specialists({ findings }) });
  assert.deepEqual(design.prioritizedFindings.slice(0, 5).map((entry) => entry.title), ["Critical unknown", "Major high", "Major high path", "Major low", "Informational"]);
  assert.ok(design.assumptionsRequiringInput.some((entry) => /needs-user-input/i.test(entry.statement)));
});

test("produces deterministic output regardless of input ordering", () => {
  const base = signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } });
  const f1 = finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa", title: "Finding A", severity: "major", confidence: "high", evidence: [sourceEvidence("src/a.ts")], statement: "A" });
  const f2 = finding({ id: "af_bbbbbbbbbbbbbbbbbbbbbbbb", title: "Finding B", severity: "minor", confidence: "medium", evidence: [sourceEvidence("src/b.ts")], statement: "B" });
  const spec = specialists({ findings: [f1, f2] });
  const forward = synthesizeBrownfieldDesign({ signals: base, specialists: spec, openQuestions: ["Q2", "Q1"], strengths: ["S2", "S1"], unrunCommands: ["cmd:beta", "cmd:alpha"] });
  const reversed = synthesizeBrownfieldDesign({ signals: base, specialists: spec, openQuestions: ["Q1", "Q2"], strengths: ["S1", "S2"], unrunCommands: ["cmd:alpha", "cmd:beta"] });
  assert.deepEqual(forward, reversed);
  for (const key of ["evidenceBackedStrengths", "behavioralProofGaps", "openQuestions", "nonGoals"]) {
    assert.deepEqual(forward[key].slice().sort(), forward[key]);
  }
});

test("sorts and deduplicates before capping when input exceeds bounds", () => {
  const spec = specialists({ findings: [] });
  const forwardCommands = Array.from({ length: 300 }, (_, i) => `unrun:cmd-${String(i).padStart(3, "0")}`);
  const reversedCommands = [...forwardCommands].reverse();
  const forward = synthesizeBrownfieldDesign({
    signals: signals({ architectureSignals: [], testFiles: [], testToSourceLinks: [], summary: { ...signals().summary, unsupportedSignals: 0 } }),
    specialists: spec,
    unrunCommands: forwardCommands,
    unsupportedAreas: [],
    openQuestions: [],
    strengths: []
  });
  const reversed = synthesizeBrownfieldDesign({
    signals: signals({ architectureSignals: [], testFiles: [], testToSourceLinks: [], summary: { ...signals().summary, unsupportedSignals: 0 } }),
    specialists: spec,
    unrunCommands: reversedCommands,
    unsupportedAreas: [],
    openQuestions: [],
    strengths: []
  });
  assert.deepEqual(forward, reversed);
  assert.equal(forward.behavioralProofGaps.length, 256);
  assert.ok(forward.behavioralProofGaps[0] < forward.behavioralProofGaps[1]);
});

test("deduplicates strengths deterministically", () => {
  const spec = specialists({ findings: [] });
  const forward = synthesizeBrownfieldDesign({
    signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }),
    specialists: spec,
    strengths: ["Dup", "dup", "Z", "A", "a"]
  });
  const reversed = synthesizeBrownfieldDesign({
    signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }),
    specialists: spec,
    strengths: ["a", "A", "dup", "Dup", "Z"]
  });
  assert.deepEqual(forward, reversed);
  assert.ok(forward.evidenceBackedStrengths.length <= 4);
});

test("separates static inventory and unsupported areas from behavioral proof", () => {
  const behaviorClaim = finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa", title: "Runtime behavior", statement: "The integration executes safely at runtime.", severity: "major", confidence: "low" });
  const design = synthesizeBrownfieldDesign({ signals: signals(), specialists: specialists({ findings: [behaviorClaim], executionRecords: [{ specialist: { name: "tests", pass: 1, focus: "proof" }, status: "failed" }] }), unrunCommands: ["pnpm test --filter runtime"], unsupportedAreas: ["binary parser"] });
  assert.ok(design.behavioralProofGaps.some((entry) => /test inventory|execution|coverage/i.test(entry)));
  assert.ok(design.behavioralProofGaps.some((entry) => /pnpm test/i.test(entry)));
  assert.ok(design.behavioralProofGaps.some((entry) => /binary parser/i.test(entry)));
  assert.ok(design.behavioralProofGaps.some((entry) => /specialist/i.test(entry)));
  assert.ok(!design.behavioralProofGaps.some((entry) => /credential|secret|password/i.test(entry)));
});

test("creates stable bounded improvement items with evidence and blockers", () => {
  const input = { signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }), specialists: specialists({ findings: [finding({ id: "af_aaaaaaaaaaaaaaaaaaaaaaaa", title: "Critical item", severity: "critical", confidence: "low", statement: "A critical item needs verification." })] }) };
  const first = synthesizeBrownfieldDesign(input);
  const second = synthesizeBrownfieldAssessment(input);
  assert.deepEqual(first, second);
  assert.equal(first.improvementPlan.length, 1);
  const item = first.improvementPlan[0];
  assert.match(item.id, /^imp_[a-f0-9]{24}$/);
  assert.equal(item.priority, "P0");
  assert.ok(item.objective.length > 0 && item.rationale.length > 0 && item.evidence.length > 0);
  assert.ok(item.verification.some((entry) => /needs-user-input|run|verify|test/i.test(entry)));
});

test("null specialists yield a typed blocking assumption without leaking unbounded input", () => {
  const design = synthesizeBrownfieldDesign({ signals: signals({ architectureSignals: [], summary: { ...signals().summary, unsupportedSignals: 0 } }), specialists: null, title: "x".repeat(10_000) });
  assert.equal(design.title.length <= 256, true);
  assert.ok(design.assumptionsRequiringInput.some((entry) => entry.confidence === "unknown" && entry.blocking));
  assert.ok(design.assumptionsRequiringInput.every((entry) => entry.evidence.length > 0));
  assert.ok(JSON.stringify(design).length < 100_000);
});

test("updates assessment state only through monotonic, provenance-checked phase transitions", async () => {
  const fixture = await makeAssessmentFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, scope: ".", snapshot: fixture.snapshot });
    await updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "signals_complete" });
    assert.equal((await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId })).state.phase, "signals");
    await updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "specialists_complete" });
    await assert.rejects(() => updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "signals_complete" }), /monotonic|transition/i);
    await updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "synthesis_complete" });
    await updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "review_complete" });
    const loaded = await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId });
    assert.equal(loaded.state.phase, "review");
    assert.equal(await readFile(path.join(fixture.repositoryRoot, ...loaded.paths.signals.split("/")), "utf8"), "[]\n");
  } finally { await fixture.cleanup(); }
});

test("rejects a phase update when the bound structural snapshot is tampered", async () => {
  const fixture = await makeAssessmentFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.snapshot });
    await writeFile(path.join(fixture.repositoryRoot, ...fixture.snapshot.semanticIndexArtifactPath.split("/")), "tampered\n", "utf8");
    await assert.rejects(() => updateBrownfieldAssessmentState({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId, phase: "signals_complete" }), /snapshot|provenance|structural/i);
  } finally { await fixture.cleanup(); }
});
