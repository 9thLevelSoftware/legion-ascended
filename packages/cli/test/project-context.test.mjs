import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateProjectContext } from "../dist/workflow/project-context.js";

const files = [
  { path: "src/index.ts", sizeBytes: 180, lineCount: 12, symbols: ["start"] },
  { path: "src/workflow/runner.ts", sizeBytes: 420, lineCount: 28, symbols: ["run", "Runner"] },
  { path: "src/commands/cli.ts", sizeBytes: 260, lineCount: 18, symbols: ["main"] },
  { path: "bin/legion.js", sizeBytes: 80, lineCount: 4, symbols: [] },
  { path: "test/runner.test.ts", sizeBytes: 300, lineCount: 20, symbols: ["testRunner"] }
];

const imports = [
  { path: "src/index.ts", specifier: "./workflow/runner.js" },
  { path: "src/commands/cli.ts", specifier: "express" },
  { path: "src/workflow/runner.ts", specifier: "./commands/cli.js" }
];

const exports = [
  { path: "src/workflow/runner.ts", name: "run", kind: "function" },
  { path: "src/workflow/runner.ts", name: "Runner", kind: "class" },
  { path: "src/index.ts", name: "start", kind: "function" },
  { path: "src/commands/cli.ts", name: "main", kind: "function" }
];

const coverage = files.map(({ path: filePath }) => ({ path: filePath, status: "parsed" }));

async function createFixture() {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "project-context-"));
  await mkdir(path.join(repositoryRoot, "src", "workflow"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "src", "commands"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "test"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "bin"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
    name: "fixture-app",
    packageManager: "pnpm@10.0.0",
    scripts: { build: "tsc -p tsconfig.json", test: "node --test", lint: "eslint ." },
    dependencies: { express: "^5.0.0", "@types/node": "^24.0.0" }
  }), "utf8");
  await writeFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  for (const file of files) await writeFile(path.join(repositoryRoot, file.path), "export {}\n", "utf8");
  return repositoryRoot;
}

test("generates concise structural project context", async () => {
  const repositoryRoot = await createFixture();
  try {
    const input = { repositoryRoot, scope: ".", files, imports, exports, coverage };
    const context = generateProjectContext(input);

    assert.ok(context.techStack.includes("Node.js"));
    assert.ok(context.techStack.includes("TypeScript"));
    assert.ok(context.techStack.includes("Express"));
    assert.ok(context.techStack.includes("pnpm"));
    assert.ok(context.entryPoints.includes("src/index.ts"));
    assert.ok(context.entryPoints.includes("bin/legion.js"));
    assert.ok(context.buildCommands.includes("pnpm build"));
    assert.ok(context.testCommands.includes("pnpm test"));
    assert.ok(context.agentsMd.length < 2_048);
    assert.match(context.agentsMd, /^# Project Context/m);
    assert.match(context.agentsMd, /^## Tech Stack/m);
    assert.match(context.agentsMd, /^## Entry Points/m);
    assert.match(context.agentsMd, /^## Architecture/m);
    assert.match(context.agentsMd, /^## Key Modules/m);
    assert.match(context.agentsMd, /^## Build & Test/m);
    assert.match(context.agentsMd, /src\/workflow\/ — 1 file/);
    assert.match(context.agentsMd, /src\/workflow\/runner\.ts/);

    assert.deepEqual(generateProjectContext(input), context);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
