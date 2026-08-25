import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findCodeIndexFact,
  queryCodeIndexStore,
  writeCodeIndexStore
} from "../dist/index.js";

const HASH = "a".repeat(64);
const SNAPSHOT_ID = "idx_3f93b1d6df4af0fe5cc5a6e4";
const SYMBOL_ID = "sym_000000000000000000000001";
const SECOND_SYMBOL_ID = "sym_000000000000000000000002";
const IMPORT_ID = "imp_000000000000000000000001";
const EXPORT_ID = "exp_000000000000000000000001";
const RANGE = {
  startByte: 0,
  endByte: 24,
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 24
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
        path: "src/assets.ts",
        status: "parsed",
        language: "typescript",
        diagnostics: []
      },
      {
        path: "src/resolver.ts",
        status: "parsed",
        language: "typescript",
        diagnostics: []
      }
    ],
    symbols: [
      {
        id: SYMBOL_ID,
        path: "src/assets.ts",
        sourceSha256: HASH,
        range: RANGE,
        extractorVersion: "0.26.13",
        name: "loadAsset",
        kind: "function",
        exported: false
      },
      {
        id: SECOND_SYMBOL_ID,
        path: "src/resolver.ts",
        sourceSha256: HASH,
        range: RANGE,
        extractorVersion: "0.26.13",
        name: "resolveAsset",
        kind: "function",
        exported: true
      }
    ],
    imports: [
      {
        id: IMPORT_ID,
        path: "src/resolver.ts",
        sourceSha256: HASH,
        range: RANGE,
        extractorVersion: "0.26.13",
        specifier: "@legion/assets"
      }
    ],
    exports: [
      {
        id: EXPORT_ID,
        path: "src/resolver.ts",
        sourceSha256: HASH,
        range: RANGE,
        extractorVersion: "0.26.13",
        name: "publicResolver",
        kind: "function"
      }
    ]
  };
}

test("materializes and queries a structural code index snapshot", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-"));
  const databasePath = path.join(temporaryDirectory, "code-index.sqlite");

  try {
    const write = writeCodeIndexStore({ databasePath, snapshot: validSnapshot() });
    assert.equal(write.databasePath, databasePath);
    assert.equal(write.factCount, 4);
    assert.equal(existsSync(databasePath), true);

    const [hit] = queryCodeIndexStore({ databasePath, query: "resolve asset", limit: 10 });
    assert.ok(hit);
    assert.deepEqual(
      {
        id: hit.id,
        kind: hit.kind,
        path: hit.path,
        name: hit.name,
        range: hit.range,
        sourceSha256: hit.sourceSha256
      },
      {
        id: SECOND_SYMBOL_ID,
        kind: "function",
        path: "src/resolver.ts",
        name: "resolveAsset",
        range: RANGE,
        sourceSha256: HASH
      }
    );

    assert.equal(queryCodeIndexStore({ databasePath, query: "legion assets", limit: 10 })[0]?.id, IMPORT_ID);
    assert.equal(queryCodeIndexStore({ databasePath, query: "public resolver", limit: 10 })[0]?.id, EXPORT_ID);

    const fact = findCodeIndexFact({ databasePath, id: SECOND_SYMBOL_ID });
    assert.equal(fact?.extractorVersion, "0.26.13");
    assert.equal(findCodeIndexFact({ databasePath, id: "sym_ffffffffffffffffffffffff" }), undefined);

    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "!!!", limit: 10 }),
      /query must contain at least one alphanumeric token/
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "resolve", limit: 0 }),
      RangeError
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "resolve", limit: 1001 }),
      RangeError
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a failed snapshot write leaves no target database", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-failure-"));
  const databasePath = path.join(temporaryDirectory, "failed.sqlite");
  const snapshot = validSnapshot();
  snapshot.symbols[0].id = "invalid";

  try {
    assert.throws(() => writeCodeIndexStore({ databasePath, snapshot }), /Invalid code index/);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
    assert.equal(existsSync(path.join(temporaryDirectory, ".failed.sqlite." + process.pid + ".tmp")), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
