import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { codeIndexSnapshotSchema, entityJsonSchemas } from "../dist/index.js";

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

test("code index coverage accepts each status and bounded per-file metadata", () => {
  const statuses = ["parsed", "metadata-only", "size-limited", "opaque", "parser-error", "unsupported"];

  for (const [index, status] of statuses.entries()) {
    const snapshot = validSnapshot();
    snapshot.coverage = [
      {
        path: `src/file-${index}.ts`,
        status,
        language: "typescript",
        diagnostics: ["parser note"]
      }
    ];

    assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, true, status);
  }

  const oversizedDiagnostic = validSnapshot();
  oversizedDiagnostic.coverage[0].diagnostics = ["x".repeat(513)];
  assert.equal(codeIndexSnapshotSchema.safeParse(oversizedDiagnostic).success, false);

  const extraMetadata = validSnapshot();
  extraMetadata.coverage[0].encoding = "utf-8";
  assert.equal(codeIndexSnapshotSchema.safeParse(extraMetadata).success, false);
});

test("code index coverage rejects invalid statuses and paths", () => {
  const invalidStatus = validSnapshot();
  invalidStatus.coverage[0].status = "partial";
  assert.equal(codeIndexSnapshotSchema.safeParse(invalidStatus).success, false);

  const invalidPath = validSnapshot();
  invalidPath.coverage[0].path = "../outside.ts";
  assert.equal(codeIndexSnapshotSchema.safeParse(invalidPath).success, false);
});

test("code index source paths accept safe ampersand and Unicode names but reject traversal and controls", () => {
  const sourcePath = "src/build-&-config-配置.ts";
  const accepted = validSnapshot();
  accepted.coverage = [{ path: sourcePath, status: "parsed", language: "typescript" }];
  accepted.symbols = [symbol("sym_000000000000000000000001", sourcePath)];

  const parsed = codeIndexSnapshotSchema.safeParse(accepted);
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  if (parsed.success) {
    assert.equal(parsed.data.coverage[0].path, sourcePath);
    assert.equal(parsed.data.symbols[0].path, sourcePath);
  }

  for (const invalidPath of [
    "../outside.ts",
    "src/../outside.ts",
    "src\\outside.ts",
    "/absolute.ts",
    "C:/outside.ts",
    "src//empty-segment.ts",
    "src/./same-file.ts",
    "src/with-\u0000-nul.ts"
  ]) {
    const invalid = validSnapshot();
    invalid.coverage = [{ path: invalidPath, status: "parsed", language: "typescript" }];
    assert.equal(codeIndexSnapshotSchema.safeParse(invalid).success, false, invalidPath);
  }
});

test("code index coverage rejects duplicate repository-relative paths", () => {
  const snapshot = validSnapshot();
  snapshot.coverage = [
    snapshot.coverage[0],
    {
      path: "src/a.ts",
      status: "metadata-only",
      language: "typescript",
      diagnostics: []
    }
  ];

  assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, false);
});

test("code index coverage rejects more than 100000 entries", () => {
  const snapshot = validSnapshot();
  snapshot.coverage = Array.from({ length: 100_001 }, (_, index) => ({
    path: `src/file-${String(index).padStart(6, "0")}.ts`,
    status: "parsed"
  }));

  assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, false);
});

test("code index coverage rejects paths that are not in canonical order", () => {
  const snapshot = validSnapshot();
  snapshot.coverage = [
    {
      path: "src/z.ts",
      status: "parsed"
    },
    {
      path: "src/a.ts",
      status: "parsed"
    }
  ];

  assert.equal(codeIndexSnapshotSchema.safeParse(snapshot).success, false);
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

test("code index generated JSON schema matches its committed artifact", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(testDirectory, "..", "..", "..", "schemas", "entities", "code-index.schema.json");
  const committed = JSON.parse(await readFile(schemaPath, "utf8"));

  assert.deepEqual(committed, entityJsonSchemas.codeIndex);
});
