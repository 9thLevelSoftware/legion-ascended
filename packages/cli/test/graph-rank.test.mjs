import assert from "node:assert/strict";
import test from "node:test";

import { rankModules } from "../dist/workflow/graph-rank.js";

const COVERAGE = [
  "src/app.ts",
  "src/feature.ts",
  "src/service.ts",
  "src/shared.ts",
  "src/utils.ts",
  "src/leaf.ts",
  "src/isolated.ts"
].map((path) => ({ path }));

const IMPORTS = [
  { path: "src/app.ts", specifier: "./feature.js" },
  { path: "src/app.ts", specifier: "./service.js" },
  { path: "src/app.ts", specifier: "./shared.js" },
  { path: "src/feature.ts", specifier: "./service.js" },
  { path: "src/feature.ts", specifier: "./shared.js" },
  { path: "src/service.ts", specifier: "./shared.js" },
  { path: "src/service.ts", specifier: "./utils.js" },
  { path: "src/leaf.ts", specifier: "./shared.js" },
  { path: "src/utils.ts", specifier: "./shared.js" }
];

const EXPORTS = [
  { path: "src/app.ts", name: "main", kind: "function" },
  { path: "src/feature.ts", name: "feature", kind: "function" },
  { path: "src/service.ts", name: "service", kind: "function" },
  { path: "src/shared.ts", name: "shared", kind: "function" },
  { path: "src/utils.ts", name: "format", kind: "function" },
  { path: "src/leaf.ts", name: "leaf", kind: "constant" }
];

function graphInput(overrides = {}) {
  return {
    imports: IMPORTS,
    exports: EXPORTS,
    coverage: COVERAGE,
    ...overrides
  };
}

test("ranks modules with more incoming dependencies as more important", () => {
  const result = rankModules(graphInput());
  const byPath = new Map(result.ranked.map((module) => [module.path, module]));

  assert.equal(result.ranked.length, COVERAGE.length);
  assert.equal(byPath.get("src/shared.ts")?.fanIn, 5);
  assert.equal(byPath.get("src/shared.ts")?.fanOut, 0);
  assert.ok((byPath.get("src/shared.ts")?.rank ?? 0) > (byPath.get("src/service.ts")?.rank ?? 0));
  assert.deepEqual(byPath.get("src/shared.ts")?.symbols, ["shared"]);
  assert.ok(result.ranked.every((module, index, ranked) => index === 0 || module.rank <= ranked[index - 1].rank));
});

test("truncates ranked modules to the token budget", () => {
  const result = rankModules(graphInput({ tokenBudget: 160, tokensPerModule: 80 }));

  assert.equal(result.ranked.length, 2);
});
