import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatEntityId } from "@legion/protocol";
import { hashContent, stableProtocolJson } from "@legion/artifacts";
import { writeCodeIndexStore } from "@legion/index-store";
import {
  discoverLatestStructuralCodeIndex,
  fingerprintSourceFiles,
  structuralSnapshotId
} from "../dist/workflow/codebase-map.js";
import { buildStructuralCodeIndex } from "../dist/workflow/code-index.js";
import {
  createBrownfieldAssessment,
  readBrownfieldAssessment
} from "../dist/workflow/brownfield-assessment.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mapRunId(runId) {
  return formatEntityId("run", `map-${sha256(runId).slice(0, 32)}`);
}

function encodedRunId(createdAt) {
  return `${createdAt.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-fixture`;
}

async function writeMapFixture({ ageDays = 0 } = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-assessment-"));
  const createdAt = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  const runId = encodedRunId(createdAt);
  const sourcePath = "src/app.ts";
  const sourceText = "export const answer = 42;\n";
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await writeFile(path.join(repositoryRoot, sourcePath), sourceText, "utf8");
  const sourceFile = {
    path: sourcePath,
    sha256: sha256(sourceText),
    sizeBytes: Buffer.byteLength(sourceText),
    lineCount: 2,
    symbols: [],
    headings: [],
    summary: "fixture"
  };
  const sourceFingerprint = fingerprintSourceFiles([sourceFile]);
  const snapshotId = structuralSnapshotId(runId, sourceFingerprint);
  const draft = await buildStructuralCodeIndex({
    snapshotId,
    mapRunId: mapRunId(runId),
    generatedAt: createdAt,
    scope: ".",
    sourceFingerprint,
    files: [{ path: sourcePath, sha256: sourceFile.sha256, text: sourceText }]
  });

  const artifactRoot = `.legion/project/workflow/map/${runId}`;
  const absoluteRoot = path.join(repositoryRoot, ...artifactRoot.split("/"));
  await mkdir(absoluteRoot, { recursive: true });
  const sqlitePath = path.join(absoluteRoot, "semantic-index.sqlite");
  writeCodeIndexStore({
    databasePath: sqlitePath,
    snapshot: { symbols: draft.symbols, imports: draft.imports, exports: draft.exports }
  });
  const sqliteBytes = await readFile(sqlitePath);
  const snapshot = {
    schemaVersion: 1,
    kind: "code_index_snapshot",
    ...draft,
    sqlite: {
      path: `${artifactRoot}/semantic-index.sqlite`,
      sha256: sha256(sqliteBytes)
    }
  };
  const semanticIndexText = stableProtocolJson(snapshot);
  const map = {
    schemaVersion: 1,
    kind: "codebase_map",
    generatedAt: createdAt,
    scope: ".",
    sourceFingerprint,
    sourceFileCount: 1,
    files: [sourceFile]
  };
  await writeFile(path.join(absoluteRoot, "semantic-index.json"), semanticIndexText, "utf8");
  const mapText = stableProtocolJson(map);
  await writeFile(path.join(absoluteRoot, "map.json"), mapText, "utf8");
  await writeFile(path.join(absoluteRoot, "workflow-run.json"), stableProtocolJson({
    schemaVersion: 1,
    kind: "workflow_run",
    workflow: "map",
    runId,
    createdAt,
    status: "completed",
    input: { profile: "structural" },
    outputs: {
      indexProfile: "structural",
      mapRunId: mapRunId(runId),
      snapshotId,
      sourceFingerprint,
      sourceFileCount: 1,
      generatedAt: createdAt,
      semanticIndexArtifactPath: `${artifactRoot}/semantic-index.json`,
      semanticSqliteArtifactPath: `${artifactRoot}/semantic-index.sqlite`,
      mapArtifactPath: `${artifactRoot}/map.json`,
      semanticIndexSha256: hashContent(semanticIndexText).slice("sha256:".length),
      mapArtifactSha256: hashContent(mapText).slice("sha256:".length)
    },
    nextAction: { command: "legion map", reason: "fixture" },
    diagnostics: []
  }), "utf8");

  const discovery = await discoverLatestStructuralCodeIndex(repositoryRoot);
  assert.ok(discovery.record, JSON.stringify(discovery.diagnostics));
  return {
    repositoryRoot,
    record: discovery.record,
    absoluteRoot,
    async cleanup() {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  };
}

async function expectDiagnostic(action, pattern) {
  await assert.rejects(action, (error) => {
    assert.match(String(error?.message ?? error), pattern);
    return true;
  });
}

test("refuses setup when no fresh structural snapshot exists", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-assessment-absent-"));
  try {
    await expectDiagnostic(
      () => createBrownfieldAssessment({ repositoryRoot, effort: 1, snapshot: {} }),
      /legion map --refresh --profile structural/iu
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("refuses setup when the structural snapshot is stale", async () => {
  const fixture = await writeMapFixture({ ageDays: 31 });
  try {
    await expectDiagnostic(
      () => createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record }),
      /legion map --refresh --profile structural/iu
    );
  } finally {
    await fixture.cleanup();
  }
});

test("binds setup and resume to semantic JSON and SQLite hashes", async () => {
  const semanticFixture = await writeMapFixture();
  try {
    await writeFile(path.join(semanticFixture.absoluteRoot, "semantic-index.json"), "tampered\n", "utf8");
    await expectDiagnostic(
      () => createBrownfieldAssessment({ repositoryRoot: semanticFixture.repositoryRoot, effort: 1, snapshot: semanticFixture.record }),
      /structural snapshot|legion map --refresh --profile structural/iu
    );
  } finally {
    await semanticFixture.cleanup();
  }

  const sqliteFixture = await writeMapFixture();
  try {
    await writeFile(path.join(sqliteFixture.absoluteRoot, "semantic-index.sqlite"), "tampered\n", "utf8");
    await expectDiagnostic(
      () => createBrownfieldAssessment({ repositoryRoot: sqliteFixture.repositoryRoot, effort: 1, snapshot: sqliteFixture.record }),
      /structural snapshot|legion map --refresh --profile structural/iu
    );
  } finally {
    await sqliteFixture.cleanup();
  }
});

test("rejects assessment path traversal and symlink escapes", async () => {
  const fixture = await writeMapFixture();
  try {
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: "../outside" }),
      /assessment ID|invalid/iu
    );

    const outside = await mkdtemp(path.join(tmpdir(), "legion-brownfield-assessment-outside-"));
    try {
      await mkdir(path.join(fixture.repositoryRoot, ".legion", "project"), { recursive: true });
      await symlink(outside, path.join(fixture.repositoryRoot, ".legion", "project", "assessment"));
      await expectDiagnostic(
        () => createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record }),
        /symlink|symbolic|outside|assessment/iu
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("creates deterministic idempotent bundles with atomic files", async () => {
  const fixture = await writeMapFixture();
  try {
    const first = await createBrownfieldAssessment({
      repositoryRoot: fixture.repositoryRoot,
      effort: 3,
      scope: ".",
      snapshot: fixture.record
    });
    const firstState = await readFile(path.join(fixture.repositoryRoot, ...first.paths.state.split("/")), "utf8");
    const firstMtime = (await stat(path.join(fixture.repositoryRoot, ...first.paths.state.split("/")))).mtimeMs;
    const second = await createBrownfieldAssessment({
      repositoryRoot: fixture.repositoryRoot,
      effort: 3,
      scope: ".",
      snapshot: fixture.record
    });
    const secondState = await readFile(path.join(fixture.repositoryRoot, ...second.paths.state.split("/")), "utf8");
    assert.equal(second.assessmentId, first.assessmentId);
    assert.deepEqual(second.paths, first.paths);
    assert.equal(secondState, firstState);
    assert.equal(firstMtime, (await stat(path.join(fixture.repositoryRoot, ...first.paths.state.split("/")))).mtimeMs);

    const entries = await readdir(path.dirname(path.join(fixture.repositoryRoot, ...first.paths.state.split("/"))));
    assert.deepEqual(entries.sort(), ["assumptions.json", "findings.json", "review.json", "signals.json", "state.json", "synthesis.json"]);
    const loaded = await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: first.assessmentId });
    assert.equal(loaded.state.phase, "setup");
    assert.equal(loaded.state.repositoryRoot, "repository");
    assert.equal(loaded.state.scope, ".");
    assert.deepEqual(loaded.state.assumptions, []);
    assert.deepEqual(loaded.state.findings, []);
    assert.deepEqual(loaded.state.nextActions, []);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent creators publish one complete bundle without overwriting state", async () => {
  const fixture = await writeMapFixture();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => createBrownfieldAssessment({
      repositoryRoot: fixture.repositoryRoot,
      effort: 1,
      scope: ".",
      snapshot: fixture.record
    })));
    const ids = new Set(results.map((result) => result.assessmentId));
    assert.deepEqual([...ids], [results[0].assessmentId]);

    const root = path.join(fixture.repositoryRoot, ...results[0].paths.root.split("/"));
    const entries = await readdir(root);
    assert.deepEqual(entries.sort(), ["assumptions.json", "findings.json", "review.json", "signals.json", "state.json", "synthesis.json"]);
    assert.deepEqual(await readdir(path.dirname(root)), [path.basename(root)]);
    const stateText = await readFile(path.join(root, "state.json"), "utf8");
    assert.equal(stateText, stableProtocolJson(JSON.parse(stateText)));
    const loaded = await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: results[0].assessmentId });
    assert.equal(loaded.state.effort, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when persisted effort no longer matches the assessment identity", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId });

    const statePath = path.join(fixture.repositoryRoot, ...created.paths.state.split("/"));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.effort = 5;
    await writeFile(statePath, stableProtocolJson(state), "utf8");
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /identity|assessment ID|effort/iu
    );
    await expectDiagnostic(
      () => createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record }),
      /identity|assessment ID|effort/iu
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects partial bundles and strict/tampered state on read", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 2, snapshot: fixture.record });
    const root = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    await rm(path.join(root, "review.json"));
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /missing|partial|review/iu
    );

    await writeFile(path.join(root, "review.json"), "[]\n", "utf8");
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.unknown = true;
    await writeFile(statePath, stableProtocolJson(state), "utf8");
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /unrecognized|unknown|schema/iu
    );

    delete state.unknown;
    state.sourceFingerprint = "a".repeat(64);
    await writeFile(statePath, stableProtocolJson(state), "utf8");
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /identity|provenance|fingerprint|snapshot|legion map --refresh --profile structural/iu
    );
  } finally {
    await fixture.cleanup();
  }
});

test("revalidates the latest structural snapshot on every read", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId });
    await writeFile(path.join(fixture.absoluteRoot, "semantic-index.sqlite"), "tampered-after-setup\n", "utf8");
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /structural snapshot|SQLite|legion map --refresh --profile structural/iu
    );
  } finally {
    await fixture.cleanup();
  }
});
