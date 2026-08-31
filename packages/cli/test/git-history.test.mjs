import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeGitHistory } from "../dist/workflow/git-history.js";

function git(repositoryRoot, args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

async function makeRepository() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-git-history-"));
  git(repositoryRoot, ["init", "--quiet", "-b", "main"]);
  git(repositoryRoot, ["config", "user.name", "Fixture Committer"]);
  git(repositoryRoot, ["config", "user.email", "committer@example.com"]);

  async function commit(files, message, authorName, authorEmail, date) {
    for (const [relativePath, contents] of files) {
      const absolutePath = path.join(repositoryRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }
    git(repositoryRoot, ["add", "--all"]);
    git(repositoryRoot, ["commit", "--quiet", "-m", message], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      }
    });
  }

  await commit([
    ["src/app.ts", "export const version = 1;\n"],
    ["src/shared.ts", "export const shared = 1;\n"]
  ], "initial source", "Alice", "alice@example.com", "2024-01-01T00:00:00Z");
  await commit([
    ["docs/README.md", "# Fixture\n"]
  ], "initial docs", "Alice", "alice@example.com", "2024-01-01T00:01:00Z");
  await commit([
    ["src/app.ts", "export const version = 2;\n"],
    ["src/shared.ts", "export const shared = 2;\n"]
  ], "update source", "Bob", "bob@example.com", "2024-01-02T00:00:00Z");
  await commit([
    ["src/app.ts", "export const version = 3;\n"]
  ], "release source", "Alice", "alice@example.com", "2024-01-03T00:00:00Z");

  return {
    repositoryRoot,
    async cleanup() {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  };
}

test("analyzes hotspots, ownership, bus factor, and co-change pairs", async () => {
  const fixture = await makeRepository();
  try {
    const result = await analyzeGitHistory({
      repositoryRoot: fixture.repositoryRoot,
      files: ["src/app.ts", "src/shared.ts", "docs/README.md"]
    });

    assert.deepEqual(result.hotspots, [
      { path: "src/app.ts", changeCount: 3, lastChanged: "2024-01-03T00:00:00Z" },
      { path: "src/shared.ts", changeCount: 2, lastChanged: "2024-01-02T00:00:00Z" },
      { path: "docs/README.md", changeCount: 1, lastChanged: "2024-01-01T00:01:00Z" }
    ]);
    assert.deepEqual(result.ownership, [
      { path: "docs/README.md", lastAuthor: "alice@example.com", lastChanged: "2024-01-01T00:01:00Z" },
      { path: "src/app.ts", lastAuthor: "alice@example.com", lastChanged: "2024-01-03T00:00:00Z" },
      { path: "src/shared.ts", lastAuthor: "bob@example.com", lastChanged: "2024-01-02T00:00:00Z" }
    ]);
    assert.deepEqual(result.busFactor, [
      { directory: "docs", contributorCount: 1, topContributors: ["alice@example.com"] },
      { directory: "src", contributorCount: 2, topContributors: ["alice@example.com", "bob@example.com"] }
    ]);
    assert.deepEqual(result.coChangePairs, [
      { pathA: "src/app.ts", pathB: "src/shared.ts", coChangeCount: 2 }
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("respects the commit limit while retaining newest history", async () => {
  const fixture = await makeRepository();
  try {
    const result = await analyzeGitHistory({
      repositoryRoot: fixture.repositoryRoot,
      files: ["src/app.ts", "src/shared.ts", "docs/README.md"],
      maxCommits: 1
    });
    assert.deepEqual(result.hotspots, [
      { path: "src/app.ts", changeCount: 1, lastChanged: "2024-01-03T00:00:00Z" }
    ]);
    assert.deepEqual(result.ownership, [
      { path: "src/app.ts", lastAuthor: "alice@example.com", lastChanged: "2024-01-03T00:00:00Z" }
    ]);
    assert.deepEqual(result.busFactor, [
      { directory: "src", contributorCount: 1, topContributors: ["alice@example.com"] }
    ]);
    assert.deepEqual(result.coChangePairs, []);
  } finally {
    await fixture.cleanup();
  }
});
