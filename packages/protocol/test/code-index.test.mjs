import assert from "node:assert/strict";
import { test } from "node:test";

import { codeIndexSnapshotSchema } from "../dist/index.js";

const HASH = "a".repeat(64);
const SNAPSHOT_ID = "idx_3f93b1d6df4af0fe5cc5a6e4";
const RANGE = {
  startByte: 0,
  endByte: 8,
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 8
};

function validSnapshot() {
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
      path: ".legion/index/code-index.sqlite",
      sha256: HASH
    },
    coverage: "parsed",
    symbols: [],
    imports: [],
    exports: []
  };
}

function symbol(id, path) {
  return {
    id,
    path,
    sourceSha256: HASH,
    range: RANGE,
    extractorVersion: "0.26.13",
    name: "parse",
    kind: "function",
    exported: true
  };
}

test("valid structural code index snapshot parses", () => {
  const snapshot = validSnapshot();

  assert.deepEqual(codeIndexSnapshotSchema.parse(snapshot), snapshot);
});

test("code index snapshot rejects unknown fields", () => {
  assert.equal(codeIndexSnapshotSchema.safeParse({ ...validSnapshot(), unexpected: true }).success, false);
});

test("code index snapshot rejects non-SHA-256 source fingerprints", () => {
  assert.equal(codeIndexSnapshotSchema.safeParse({ ...validSnapshot(), sourceFingerprint: `sha256:${HASH}` }).success, false);
});

test("code index source ranges reject negative offsets and inverted byte bounds", () => {
  const negative = validSnapshot();
  negative.symbols = [symbol("sym_000000000000000000000001", "src/a.ts")];
  negative.symbols[0].range = { ...RANGE, startByte: -1 };
  assert.equal(codeIndexSnapshotSchema.safeParse(negative).success, false);

  const inverted = validSnapshot();
  inverted.symbols = [symbol("sym_000000000000000000000002", "src/a.ts")];
  inverted.symbols[0].range = { ...RANGE, startByte: 9, endByte: 8 };
  assert.equal(codeIndexSnapshotSchema.safeParse(inverted).success, false);
});

test("code index snapshot rejects duplicate fact IDs", () => {
  const snapshot = validSnapshot();
  snapshot.symbols = [
    symbol("sym_000000000000000000000001", "src/a.ts"),
    symbol("sym_000000000000000000000001", "src/b.ts")
  ];

  assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, false);
});

test("code index snapshot rejects fact arrays that are not sorted by path, byte, and ID", () => {
  const snapshot = validSnapshot();
  snapshot.symbols = [
    symbol("sym_000000000000000000000002", "src/b.ts"),
    symbol("sym_000000000000000000000001", "src/a.ts")
  ];

  assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, false);
});
