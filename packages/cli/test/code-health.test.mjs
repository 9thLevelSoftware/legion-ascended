import assert from "node:assert/strict";
import test from "node:test";

import { scoreCodeHealth } from "../dist/workflow/code-health.js";

const files = [
  { path: "src/healthy.ts", sizeBytes: 200, lineCount: 20, symbols: ["run"] },
  { path: "src/large.ts", sizeBytes: 6_000, lineCount: 501, symbols: ["large"] },
  { path: "src/very-large.ts", sizeBytes: 12_000, lineCount: 1_001, symbols: ["veryLarge"] },
  { path: "src/no-symbols.ts", sizeBytes: 200, lineCount: 20, symbols: [] },
  { path: "src/no-exports.ts", sizeBytes: 200, lineCount: 20, symbols: ["internal"] },
  { path: "src/shared.ts", sizeBytes: 200, lineCount: 20, symbols: ["shared"] },
  ...Array.from({ length: 11 }, (_, index) => ({
    path: `src/importer-${index}.ts`,
    sizeBytes: 200,
    lineCount: 20,
    symbols: ["imported"]
  })),
  { path: "src/untested.ts", sizeBytes: 200, lineCount: 20, symbols: ["untested"] },
  { path: "src/empty.ts", sizeBytes: 0, lineCount: 0, symbols: [] },
  { path: "src/small.ts", sizeBytes: 40, lineCount: 4, symbols: ["small"] },
  { path: "src/index.ts", sizeBytes: 40, lineCount: 4, symbols: ["entry"] },
  { path: "src/helper.test.ts", sizeBytes: 40, lineCount: 2, symbols: [] },
  { path: "src/clamped.ts", sizeBytes: 20_000, lineCount: 1_201, symbols: [] }
];

const imports = Array.from({ length: 11 }, (_, index) => ({
  path: `src/importer-${index}.ts`,
  specifier: "./shared.js"
}));

const exports = [
  "healthy.ts",
  "large.ts",
  "very-large.ts",
  "no-symbols.ts",
  "shared.ts",
  ...Array.from({ length: 11 }, (_, index) => `importer-${index}.ts`),
  "untested.ts",
  "small.ts",
  "index.ts"
].map((name) => ({ path: `src/${name}`, name: "exported" }));

const testFiles = [
  "src/healthy.test.ts",
  "src/large.test.ts",
  "src/very-large.test.ts",
  "src/no-symbols.test.ts",
  "src/no-exports.test.ts",
  "src/shared.test.ts",
  ...Array.from({ length: 11 }, (_, index) => `src/importer-${index}.test.ts`),
  "src/small.test.ts",
  "src/clamped.test.ts"
];

function scoreFor(scores, path) {
  const score = scores.find((entry) => entry.path === path);
  assert.ok(score, `missing score for ${path}`);
  return score;
}

function signalCodes(score) {
  return score.signals.map((signal) => signal.code);
}

test("scores each deterministic health signal and clamps scores", () => {
  const scores = scoreCodeHealth({ files, imports, exports, testFiles });

  assert.equal(scores.length, files.length);
  assert.equal(scoreFor(scores, "src/healthy.ts").score, 10);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/healthy.ts")), []);

  assert.equal(scoreFor(scores, "src/large.ts").score, 9);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/large.ts")), ["large-file"]);
  assert.equal(scoreFor(scores, "src/large.ts").signals[0].severity, "warning");

  assert.equal(scoreFor(scores, "src/very-large.ts").score, 8);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/very-large.ts")), ["very-large-file"]);
  assert.equal(scoreFor(scores, "src/very-large.ts").signals[0].severity, "critical");

  assert.equal(scoreFor(scores, "src/no-symbols.ts").score, 9);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/no-symbols.ts")), ["no-symbols"]);
  assert.equal(scoreFor(scores, "src/no-symbols.ts").signals[0].severity, "warning");

  assert.equal(scoreFor(scores, "src/no-exports.ts").score, 9);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/no-exports.ts")), ["no-exports"]);
  assert.equal(scoreFor(scores, "src/no-exports.ts").signals[0].severity, "warning");

  const highFanIn = scoreFor(scores, "src/shared.ts");
  assert.equal(highFanIn.score, 9);
  assert.deepEqual(signalCodes(highFanIn), ["high-fan-in"]);
  assert.equal(highFanIn.signals[0].severity, "info");

  const noTests = scoreFor(scores, "src/untested.ts");
  assert.equal(noTests.score, 9);
  assert.deepEqual(signalCodes(noTests), ["no-tests"]);
  assert.equal(noTests.signals[0].severity, "warning");

  const empty = scoreFor(scores, "src/empty.ts");
  assert.equal(empty.score, 3);
  assert.deepEqual(signalCodes(empty), ["no-symbols", "no-exports", "no-tests", "empty-file", "very-small-file"]);
  assert.equal(empty.signals.find((signal) => signal.code === "empty-file")?.severity, "critical");

  assert.equal(scoreFor(scores, "src/small.ts").score, 9);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/small.ts")), ["very-small-file"]);
  assert.equal(scoreFor(scores, "src/small.ts").signals[0].severity, "info");

  const index = scoreFor(scores, "src/index.ts");
  assert.equal(index.score, 9);
  assert.deepEqual(signalCodes(index), ["no-tests"]);
  assert.equal(scoreFor(scores, "src/helper.test.ts").score, 8);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/helper.test.ts")), ["no-symbols", "very-small-file"]);

  assert.equal(scoreFor(scores, "src/clamped.ts").score, 6);
  assert.deepEqual(signalCodes(scoreFor(scores, "src/clamped.ts")), ["very-large-file", "no-symbols", "no-exports"]);
});

test("recognizes relative imports and conventional test neighbors", () => {
  const scores = scoreCodeHealth({
    files: [
      { path: "lib/target.ts", sizeBytes: 100, lineCount: 20, symbols: ["target"] },
      { path: "lib/target.test.ts", sizeBytes: 100, lineCount: 10, symbols: ["test"] },
      { path: "lib/consumer.ts", sizeBytes: 100, lineCount: 20, symbols: ["consumer"] }
    ],
    imports: [{ path: "lib/consumer.ts", specifier: "./target.js" }],
    exports: [{ path: "lib/target.ts", name: "target" }]
  });

  assert.deepEqual(signalCodes(scoreFor(scores, "lib/target.ts")), []);
  assert.deepEqual(signalCodes(scoreFor(scores, "lib/consumer.ts")), ["no-exports", "no-tests"]);
});
