import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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
  readBrownfieldAssessment,
  updateBrownfieldAssessmentState
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

async function runAssessmentChild(repositoryRoot, snapshot, onSpawn) {
  const moduleUrl = new URL("../dist/workflow/brownfield-assessment.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
      const { createBrownfieldAssessment } = await import(${JSON.stringify(moduleUrl)});
      const result = await createBrownfieldAssessment({
        repositoryRoot: process.env.BROWNFIELD_REPOSITORY_ROOT,
        effort: 1,
        scope: ".",
        snapshot: JSON.parse(process.env.BROWNFIELD_SNAPSHOT)
      });
      process.stdout.write(result.assessmentId);
    `
  ], {
    env: {
      ...process.env,
      BROWNFIELD_REPOSITORY_ROOT: repositoryRoot,
      BROWNFIELD_SNAPSHOT: JSON.stringify(snapshot)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  onSpawn?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 1_500);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`assessment child timed out; stderr: ${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runAssessmentUpdateChild(repositoryRoot, assessmentId, onSpawn) {
  const moduleUrl = new URL("../dist/workflow/brownfield-assessment.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `
      const { updateBrownfieldAssessmentState } = await import(${JSON.stringify(moduleUrl)});
      try {
        await updateBrownfieldAssessmentState({
          repositoryRoot: process.env.BROWNFIELD_REPOSITORY_ROOT,
          assessmentId: process.env.BROWNFIELD_ASSESSMENT_ID,
          phase: "signals_complete"
        });
        process.stdout.write("resolved");
      } catch (error) {
        process.stderr.write(String(error?.stack ?? error));
        process.exitCode = 1;
      }
    `
  ], {
    env: {
      ...process.env,
      BROWNFIELD_REPOSITORY_ROOT: repositoryRoot,
      BROWNFIELD_ASSESSMENT_ID: assessmentId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  onSpawn?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`assessment update child timed out; stderr: ${stderr}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
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

test("does not publish a replacement staging directory", async () => {
  const fixture = await writeMapFixture();
  let children = [];
  let watcher;
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const bundlePath = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    const parentPath = path.dirname(bundlePath);
    await rm(bundlePath, { recursive: true, force: true });

    const replacementTemplate = path.join(parentPath, ".replacement-stage-template");
    await mkdir(replacementTemplate);
    for (const fileName of ["state.json", "signals.json", "assumptions.json", "findings.json", "synthesis.json", "review.json"]) {
      await writeFile(path.join(replacementTemplate, fileName), fileName === "state.json" ? "replacement-stage\n" : "[]\n", "utf8");
    }

    let stagePath;
    let swapped = false;
    let swapError;
    const observingCandidates = new Set();
    let pauseResolve;
    const pauseReady = new Promise((resolve) => {
      pauseResolve = resolve;
    });
    watcher = watchDirectory(parentPath, (_eventType, entryName) => {
      if (stagePath !== undefined || entryName === null) return;
      const candidate = String(entryName);
      if (!candidate.startsWith(`.${path.basename(bundlePath)}.`) || !candidate.endsWith(".staging") ||
        observingCandidates.has(candidate)) return;
      observingCandidates.add(candidate);
      const candidatePath = path.join(parentPath, candidate);
      void (async () => {
        for (let attempt = 0; attempt < 1_000 && stagePath === undefined; attempt += 1) {
          try {
            const stageEntries = await readdir(candidatePath);
            if (stageEntries.length === 6 && children.length > 0) {
              stagePath = candidatePath;
              for (const child of children) child.kill("SIGSTOP");
              await new Promise((resolve) => setTimeout(resolve, 10));
              try {
                await rename(candidatePath, `${candidatePath}.hidden`);
                await cp(replacementTemplate, candidatePath, { recursive: true });
                swapped = true;
              } catch (error) {
                swapError = error;
              } finally {
                watcher?.close();
                for (const child of children) child.kill("SIGCONT");
                pauseResolve();
              }
              return;
            }
          } catch {
            return;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      })().catch(() => undefined);
    });

    const childResults = Array.from({ length: 16 }, () => runAssessmentChild(
      fixture.repositoryRoot,
      fixture.record,
      (processHandle) => children.push(processHandle)
    ));
    await Promise.race([pauseReady, Promise.all(childResults)]);
    assert.ok(stagePath !== undefined, "did not observe a complete staging directory");
    await pauseReady;
    assert.equal(swapError, undefined);
    assert.equal(swapped, true);
    await Promise.all(childResults);

    const entries = await readdir(parentPath);
    if (entries.includes(path.basename(bundlePath))) {
      assert.notEqual(await readFile(path.join(bundlePath, "state.json"), "utf8"), "replacement-stage\n");
    }
  } finally {
    watcher?.close();
    for (const child of children) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
    await fixture.cleanup();
  }
});
test("recovers a stale publication lock owned by a dead process", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const bundlePath = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    const parentPath = path.dirname(bundlePath);
    await rm(bundlePath, { recursive: true, force: true });
    const lockPath = path.join(parentPath, `.${path.basename(bundlePath)}.publish-lock`);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 99999999, acquiredAt: 0, token: "stale" }), "utf8");
    const staleTime = new Date(Date.now() - 120_000);
    await utimes(lockPath, staleTime, staleTime);

    const recreated = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    assert.equal(recreated.assessmentId, created.assessmentId);
    assert.deepEqual(await readdir(parentPath), [path.basename(bundlePath)]);
  } finally {
    await fixture.cleanup();
  }
});

test("does not block on FIFO publication lock metadata in the fallback path", async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is not available on Windows");
    return;
  }
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const bundlePath = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    const parentPath = path.dirname(bundlePath);
    await rm(bundlePath, { recursive: true, force: true });
    const lockPath = path.join(parentPath, `.${path.basename(bundlePath)}.publish-lock`);
    const ownerPath = path.join(lockPath, "owner.json");
    await mkdir(lockPath, { mode: 0o700 });
    try {
      await execFile("mkfifo", [ownerPath]);
    } catch {
      t.skip("mkfifo is unavailable or unsupported on this platform");
      return;
    }
    const staleTime = new Date(Date.now() - 120_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await runAssessmentChild(fixture.repositoryRoot, fixture.record);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, created.assessmentId);
    assert.deepEqual(await readdir(parentPath), [path.basename(bundlePath)]);
  } finally {
    await fixture.cleanup();
  }
});

test("does not read through an ordinary directory rebind", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, scope: ".", snapshot: fixture.record });
    const bundlePath = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    const assessmentParent = path.dirname(bundlePath);
    const hiddenPath = `${assessmentParent}.ordinary-race-hidden`;
    const replacementPath = `${assessmentParent}.ordinary-race-replacement`;
    await cp(assessmentParent, replacementPath, { recursive: true });
    const replacementStatePath = path.join(replacementPath, path.basename(bundlePath), "state.json");
    const replacementState = JSON.parse(await readFile(replacementStatePath, "utf8"));
    replacementState.phase = "signals";
    await writeFile(replacementStatePath, stableProtocolJson(replacementState), "utf8");

    let stop = false;
    let swaps = 0;
    const mutator = (async () => {
      while (!stop && swaps < 2_000) {
        try {
          await rename(assessmentParent, hiddenPath);
          await rename(replacementPath, assessmentParent);
          swaps += 1;
          await new Promise((resolve) => setImmediate(resolve));
          await rename(assessmentParent, replacementPath);
          await rename(hiddenPath, assessmentParent);
        } catch {
          await rename(assessmentParent, replacementPath).catch(() => undefined);
          await rename(hiddenPath, assessmentParent).catch(() => undefined);
        }
      }
    })();

    const observations = await Promise.all(Array.from({ length: 128 }, async () => {
      try {
        const result = await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId });
        return result.state.phase;
      } catch {
        return "rejected";
      }
    }));
    stop = true;
    await mutator;
    assert.ok(swaps > 0, "ordinary-directory rebind did not run");
    assert.ok(!observations.includes("signals"), `read bundle through ordinary directory rebind: ${observations.join(",")}`);
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

test("rejects a phase update when the persisted assessment ID is tampered", async () => {
  const fixture = await writeMapFixture();
  let child;
  let watcher;
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const statePath = path.join(fixture.repositoryRoot, ...created.paths.state.split("/"));
    const parentPath = path.dirname(path.dirname(statePath));
    const stagePrefix = `.${path.basename(created.paths.root)}.`;
    let stopped = false;
    let stopResolve;
    const stoppedReady = new Promise((resolve) => { stopResolve = resolve; });
    watcher = watchDirectory(parentPath, (_eventType, entryName) => {
      const name = String(entryName ?? "");
      if (stopped || !name.startsWith(stagePrefix) || !name.endsWith(".staging")) return;
      stopped = true;
      child.kill("SIGSTOP");
      stopResolve();
    });

    const update = runAssessmentUpdateChild(fixture.repositoryRoot, created.assessmentId, (processHandle) => {
      child = processHandle;
    });
    const stageObserved = await Promise.race([
      stoppedReady.then(() => ({ observed: true })),
      update.then((result) => ({ observed: false, result }))
    ]);
    assert.equal(stageObserved.observed, true, `did not observe the update staging directory: ${JSON.stringify(stageObserved)}`);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.assessmentId = "assess_bbbbbbbbbbbbbbbbbbbbbbbb";
    await writeFile(statePath, stableProtocolJson(state), "utf8");
    child.kill("SIGCONT");
    watcher.close();
    watcher = undefined;

    const result = await update;
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /identity mismatch under the publication lock/iu);
  } finally {
    watcher?.close();
    child?.kill("SIGCONT");
    child?.kill("SIGKILL");
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

test("rejects a bundle file beyond the bounded read limit", async () => {
  const fixture = await writeMapFixture();
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const signalsPath = path.join(fixture.repositoryRoot, ...created.paths.signals.split("/"));
    const oversizedJson = `[${"0,".repeat(8 * 1024 * 1024)}0]`;
    await writeFile(signalsPath, oversizedJson, "utf8");
    await expectDiagnostic(
      () => readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId }),
      /bounded read limit/iu
    );
  } finally {
    await fixture.cleanup();
  }
});

test("does not read a bundle through an intermediate symlink swap", async () => {
  const fixture = await writeMapFixture();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-assessment-race-outside-"));
  try {
    const created = await createBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, effort: 1, snapshot: fixture.record });
    const bundlePath = path.join(fixture.repositoryRoot, ...created.paths.root.split("/"));
    const outsideBundlePath = path.join(outsideRoot, path.basename(bundlePath));
    await cp(bundlePath, outsideBundlePath, { recursive: true });
    const outsideStatePath = path.join(outsideBundlePath, "state.json");
    const outsideState = JSON.parse(await readFile(outsideStatePath, "utf8"));
    outsideState.phase = "signals";
    await writeFile(outsideStatePath, stableProtocolJson(outsideState), "utf8");

    const assessmentParent = path.dirname(bundlePath);
    const hiddenPath = `${assessmentParent}.race-hidden`;
    let stop = false;
    const mutator = (async () => {
      while (!stop) {
        try {
          await rename(assessmentParent, hiddenPath);
          await symlink(outsideRoot, assessmentParent);
          await new Promise((resolve) => setImmediate(resolve));
        } catch {
          // Readers may transiently hold the path between the swap steps.
        } finally {
          await rm(assessmentParent, { recursive: true, force: true }).catch(() => undefined);
          await rename(hiddenPath, assessmentParent).catch(() => undefined);
        }
      }
    })();

    const observations = await Promise.all(Array.from({ length: 64 }, async () => {
      try {
        const result = await readBrownfieldAssessment({ repositoryRoot: fixture.repositoryRoot, assessmentId: created.assessmentId });
        return result.state.phase;
      } catch {
        return "rejected";
      }
    }));
    stop = true;
    await mutator;
    assert.ok(!observations.includes("signals"), `read bundle through swapped parent: ${observations.join(",")}`);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});
