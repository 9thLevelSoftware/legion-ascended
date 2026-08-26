import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
    const importHit = queryCodeIndexStore({ databasePath, query: "legion assets", limit: 10 })[0];
    assert.ok(importHit);
    assert.equal(importHit.specifier, "@legion/assets");
    assert.equal(Object.hasOwn(importHit, "name"), false);
    assert.equal(queryCodeIndexStore({ databasePath, query: "public resolver", limit: 10 })[0]?.id, EXPORT_ID);

    const fact = findCodeIndexFact({ databasePath, id: SECOND_SYMBOL_ID });
    assert.equal(fact?.extractorVersion, "0.26.13");
    assert.equal(findCodeIndexFact({ databasePath, id: "sym_ffffffffffffffffffffffff" }), undefined);

    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "!!!", limit: 10 }),
      /query must contain at least one alphanumeric token/
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: 123, limit: 10 }),
      /query must be a string/
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "a".repeat(4_097), limit: 10 }),
      /query must be at most 4096 UTF-16 code units/
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: Array.from({ length: 129 }, (_, index) => `token${index}`).join(" "), limit: 10 }),
      /query must contain at most 128 tokens/
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

test("rejects an unknown SQLite fact kind instead of treating it as an export", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-kind-"));
  const databasePath = path.join(temporaryDirectory, "kind.sqlite");

  try {
    writeCodeIndexStore({ databasePath, snapshot: validSnapshot() });
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE facts SET fact_kind = ? WHERE id = ?").run("bogus", SYMBOL_ID);
    database.close();

    assert.throws(
      () => findCodeIndexFact({ databasePath, id: SYMBOL_ID }),
      /Unknown code index fact kind: bogus/
    );
    assert.throws(
      () => queryCodeIndexStore({ databasePath, query: "load asset", limit: 10 }),
      /Unknown code index fact kind: bogus/
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("atomically replaces an existing database with a queryable snapshot", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-replace-"));
  const databasePath = path.join(temporaryDirectory, "replace.sqlite");

  try {
    writeCodeIndexStore({ databasePath, snapshot: validSnapshot() });
    const replacement = validSnapshot();
    replacement.symbols = [{ ...replacement.symbols[0], name: "replacementAsset" }];
    replacement.imports = [];
    replacement.exports = [];
    writeCodeIndexStore({ databasePath, snapshot: replacement });

    assert.equal(queryCodeIndexStore({ databasePath, query: "replacement asset", limit: 10 })[0]?.id, SYMBOL_ID);
    assert.deepEqual(queryCodeIndexStore({ databasePath, query: "resolve asset", limit: 10 }), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("removes pre-existing database sidecars after a successful write", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-sidecars-"));
  const databasePath = path.join(temporaryDirectory, "sidecars.sqlite");

  try {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      writeFileSync(databasePath + suffix, "stale sidecar");
    }
    writeCodeIndexStore({ databasePath, snapshot: validSnapshot() });

    assert.equal(existsSync(databasePath), true);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.equal(existsSync(databasePath + suffix), false);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("cleans up the materialized temporary database when final rename fails", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "legion-index-store-rename-"));
  const databasePath = path.join(temporaryDirectory, "blocked.sqlite");
  const temporaryPath = path.join(temporaryDirectory, `.${path.basename(databasePath)}.${process.pid}.tmp`);
  const directoryMarker = path.join(databasePath, "keep.txt");
  mkdirSync(databasePath);
  writeFileSync(directoryMarker, "keep this directory");

  try {
    assert.throws(
      () => writeCodeIndexStore({ databasePath, snapshot: validSnapshot() }),
      /EISDIR|directory|rename/i
    );
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      assert.equal(existsSync(temporaryPath + suffix), false);
    }
    assert.equal(statSync(databasePath).isDirectory(), true);
    assert.equal(existsSync(directoryMarker), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
