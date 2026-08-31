import assert from "node:assert/strict";
import test from "node:test";

import { renderCodebaseDocuments, renderPathTree } from "../dist/workflow/codebase-map-render.js";

const MAP = {
  schemaVersion: 1,
  kind: "codebase_map",
  generatedAt: "2026-08-29T00:00:00.000Z",
  scope: ".",
  sourceFingerprint: "a".repeat(64),
  sourceFileCount: 3,
  files: [
    { path: "src/app.ts", sha256: "b".repeat(64), sizeBytes: 40, lineCount: 4, symbols: ["boot"], headings: [], summary: "src/app.ts has 4 lines" },
    { path: "src/dep.ts", sha256: "c".repeat(64), sizeBytes: 20, lineCount: 2, symbols: ["helper"], headings: [], summary: "src/dep.ts has 2 lines" },
    { path: "package.json", sha256: "d".repeat(64), sizeBytes: 12, lineCount: 3, symbols: [], headings: [], summary: "package.json has 3 lines" }
  ]
};

const SNAPSHOT = {
  coverage: [{ path: "src/app.ts" }, { path: "src/dep.ts" }],
  exports: [
    { path: "src/app.ts", name: "boot", kind: "function" },
    { path: "src/dep.ts", name: "helper", kind: "function" }
  ],
  imports: [{ path: "src/app.ts", specifier: "./dep.js" }],
  symbols: [
    { path: "src/app.ts", name: "boot", kind: "function", exported: true },
    { path: "src/dep.ts", name: "helper", kind: "function", exported: true }
  ]
};

test("renders a directory tree instead of first-content inventory lines", () => {
  const tree = renderPathTree(MAP.files.map((file) => file.path));
  assert.match(tree, /src\//);
  assert.match(tree, /app\.ts/);
  assert.doesNotMatch(tree, /has 4 lines/);
});

test("structural map documents expose modules, exports, and a reference graph", () => {
  const documents = renderCodebaseDocuments({ map: MAP, snapshot: SNAPSHOT });
  assert.match(documents.codebaseMarkdown, /## Tree/);
  assert.match(documents.codebaseMarkdown, /## Modules/);
  assert.match(documents.codebaseMarkdown, /fn boot/);
  assert.match(documents.codebaseMarkdown, /## Reference graph/);
  assert.match(documents.codebaseMarkdown, /src\/app\.ts -> src\/dep\.ts/);
  assert.match(documents.codebaseMarkdown, /Highest fan-in/);
  assert.doesNotMatch(documents.codebaseMarkdown, /first content:/);
  assert.deepEqual(documents.symbolRecords.map((entry) => entry.symbol).sort(), ["boot", "helper"]);
});

test("preview keeps each reference-graph section bounded instead of slicing mid-heading", () => {
  const imports = Array.from({ length: 40 }, (_entry, index) => ({
    path: `src/mod-${String(index).padStart(2, "0")}.ts`,
    specifier: "./dep.js"
  }));
  const documents = renderCodebaseDocuments({
    map: {
      ...MAP,
      sourceFileCount: 42,
      files: [
        ...MAP.files,
        ...imports.map((item, index) => ({
          path: item.path,
          sha256: "e".repeat(64),
          sizeBytes: 8,
          lineCount: 1,
          symbols: [`n${index}`],
          headings: [],
          summary: `${item.path} has 1 lines`
        }))
      ]
    },
    snapshot: {
      ...SNAPSHOT,
      coverage: [...SNAPSHOT.coverage, ...imports.map((item) => ({ path: item.path }))],
      imports: [...SNAPSHOT.imports, ...imports]
    }
  });
  assert.match(documents.preview, /## Reference graph/);
  assert.match(documents.preview, /### Highest fan-in/);
  assert.match(documents.preview, /### Highest fan-out/);
  const fanInIndex = documents.preview.indexOf("### Highest fan-in");
  const fanOutIndex = documents.preview.indexOf("### Highest fan-out");
  assert.ok(fanInIndex >= 0 && fanOutIndex > fanInIndex);
});
