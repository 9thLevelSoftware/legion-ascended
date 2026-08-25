import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  hashContent,
  readCodeIndexSnapshot,
  stableProtocolJson,
  verifyCodeIndexSqlite
} from "../dist/index.js";

const HASH = "a".repeat(64);
const SNAPSHOT_ID = "idx_3f93b1d6df4af0fe5cc5a6e4";
const MAP_RUN_DIRECTORY = ".legion/project/map-runs/run_map-structural";
const SNAPSHOT_PATH = `${MAP_RUN_DIRECTORY}/snapshot.json`;
const SQLITE_PATH = `${MAP_RUN_DIRECTORY}/code-index.sqlite`;
const SQLITE_BYTES = Buffer.from("SQLite format 3 test bytes\n", "utf8");

async function withRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-artifacts-code-index-"));
  try {
    await mkdir(path.join(root, ".legion", "project"), { recursive: true });
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sqliteSha256(bytes = SQLITE_BYTES) {
  return hashContent(bytes).slice("sha256:".length);
}

function validSnapshot(sqlitePath = SQLITE_PATH, sqliteBytes = SQLITE_BYTES) {
  return {
    schemaVersion: 1,
    kind: "code_index_snapshot",
    snapshotId: SNAPSHOT_ID,
    mapRunId: "run_map-structural",
    generatedAt: "2026-08-25T12:00:00.000Z",
    profile: "structural",
    scope: ".",
    sourceFingerprint: HASH,
    extractor: {
      name: "tree-sitter",
      version: "0.26.13"
    },
    sqlite: {
      path: sqlitePath,
      sha256: sqliteSha256(sqliteBytes)
    },
    coverage: [
      {
        path: "src/a.ts",
        status: "parsed",
        language: "typescript",
        diagnostics: []
      }
    ],
    symbols: [],
    imports: [],
    exports: []
  };
}

async function writeSnapshot(root, snapshot, sqliteBytes = SQLITE_BYTES) {
  const snapshotAbsolutePath = path.join(root, ...SNAPSHOT_PATH.split("/"));
  const sqliteAbsolutePath = path.join(root, ...snapshot.sqlite.path.split("/"));
  await mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
  await mkdir(path.dirname(sqliteAbsolutePath), { recursive: true });
  await writeFile(sqliteAbsolutePath, sqliteBytes);
  await writeFile(snapshotAbsolutePath, stableProtocolJson(snapshot), "utf8");
}

function diagnosticCodes(result) {
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

test("reads a valid code index snapshot and verifies its SQLite materialization", async () => {
  await withRepository(async (repositoryRoot) => {
    const snapshot = validSnapshot();
    await writeSnapshot(repositoryRoot, snapshot);

    const read = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(read.ok, true, stableProtocolJson(read));
    if (!read.ok) return;

    assert.deepEqual(read.snapshot, snapshot);
    assert.equal(read.reference.path, SNAPSHOT_PATH);
    assert.equal(read.reference.sha256, hashContent(stableProtocolJson(snapshot)));

    const verification = await verifyCodeIndexSqlite({ repositoryRoot, snapshot: read.snapshot });
    assert.equal(verification.ok, true, stableProtocolJson(verification));
    if (!verification.ok) return;

    assert.equal(verification.reference.path, SQLITE_PATH);
    assert.equal(verification.reference.sha256, hashContent(SQLITE_BYTES));
  });
});

test("rejects tampered SQLite bytes with a diagnostic", async () => {
  await withRepository(async (repositoryRoot) => {
    const snapshot = validSnapshot();
    await writeSnapshot(repositoryRoot, snapshot);
    await writeFile(path.join(repositoryRoot, ...SQLITE_PATH.split("/")), Buffer.from("tampered SQLite bytes\n", "utf8"));

    const read = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(read.ok, true, stableProtocolJson(read));
    if (!read.ok) return;

    const verification = await verifyCodeIndexSqlite({ repositoryRoot, snapshot: read.snapshot });
    assert.equal(verification.ok, false, stableProtocolJson(verification));
    assert.ok(diagnosticCodes(verification).includes("hash_mismatch"));
    assert.equal(verification.diagnostics[0].source.path, SQLITE_PATH);
  });
});

test("returns diagnostics for malformed JSON and schema-invalid snapshots", async () => {
  await withRepository(async (repositoryRoot) => {
    const snapshotAbsolutePath = path.join(repositoryRoot, ...SNAPSHOT_PATH.split("/"));
    await mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });

    await writeFile(snapshotAbsolutePath, "{ invalid JSON\n", "utf8");
    const malformed = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(malformed.ok, false, stableProtocolJson(malformed));
    assert.ok(diagnosticCodes(malformed).includes("invalid_json"));

    const invalidSnapshot = { ...validSnapshot(), kind: "not_a_code_index_snapshot" };
    await writeFile(snapshotAbsolutePath, stableProtocolJson(invalidSnapshot), "utf8");
    const invalidSchema = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(invalidSchema.ok, false, stableProtocolJson(invalidSchema));
    assert.ok(diagnosticCodes(invalidSchema).includes("invalid_schema"));
  });
});

test("returns diagnostics for missing snapshots and SQLite materializations", async () => {
  await withRepository(async (repositoryRoot) => {
    const missingSnapshot = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(missingSnapshot.ok, false, stableProtocolJson(missingSnapshot));
    assert.ok(diagnosticCodes(missingSnapshot).includes("not_found"));
    assert.equal(missingSnapshot.diagnostics[0].source.path, SNAPSHOT_PATH);

    const snapshot = validSnapshot();
    await writeSnapshot(repositoryRoot, snapshot);
    await rm(path.join(repositoryRoot, ...SQLITE_PATH.split("/")));

    const read = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
    assert.equal(read.ok, true, stableProtocolJson(read));
    if (!read.ok) return;

    const missingSqlite = await verifyCodeIndexSqlite({ repositoryRoot, snapshot: read.snapshot });
    assert.equal(missingSqlite.ok, false, stableProtocolJson(missingSqlite));
    assert.ok(diagnosticCodes(missingSqlite).includes("not_found"));
    assert.equal(missingSqlite.diagnostics[0].source.path, SQLITE_PATH);
  });
});

test("rejects unsafe and symlink-escaping snapshot and SQLite paths without reading outside the repository", async (t) => {
  await withRepository(async (repositoryRoot) => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-artifacts-code-index-outside-"));
    try {
      const outsideMapRunDirectory = path.join(outsideRoot, "run_map-structural");
      await mkdir(outsideMapRunDirectory, { recursive: true });
      await writeFile(path.join(outsideMapRunDirectory, "snapshot.json"), "{ invalid outside JSON\n", "utf8");
      await writeFile(path.join(outsideMapRunDirectory, "code-index.sqlite"), SQLITE_BYTES);

      const mapRunsDirectory = path.join(repositoryRoot, ".legion", "project", "map-runs");
      await mkdir(mapRunsDirectory, { recursive: true });
      const symlinkPath = path.join(mapRunsDirectory, "run_map-structural");
      try {
        await symlink(outsideMapRunDirectory, symlinkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      const read = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: SNAPSHOT_PATH });
      assert.equal(read.ok, false, stableProtocolJson(read));
      assert.ok(diagnosticCodes(read).includes("invalid_path"));
      assert.equal(read.diagnostics.some((diagnostic) => diagnostic.code === "invalid_json"), false);

      const verification = await verifyCodeIndexSqlite({
        repositoryRoot,
        snapshot: validSnapshot()
      });
      assert.equal(verification.ok, false, stableProtocolJson(verification));
      assert.ok(diagnosticCodes(verification).includes("invalid_path"));
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("rejects absolute snapshot paths without accessing them", async () => {
  await withRepository(async (repositoryRoot) => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "legion-artifacts-code-index-absolute-"));
    try {
      const outsideSnapshotPath = path.join(outsideRoot, "snapshot.json");
      await writeFile(outsideSnapshotPath, "{ invalid outside JSON\n", "utf8");

      const read = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: outsideSnapshotPath });
      assert.equal(read.ok, false, stableProtocolJson(read));
      assert.ok(diagnosticCodes(read).includes("invalid_path"));
      assert.equal(read.diagnostics.some((diagnostic) => diagnostic.code === "invalid_json"), false);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
