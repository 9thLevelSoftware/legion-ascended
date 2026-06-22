import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("root bin shows workflow help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
});

test("root bin routes install help to the installer", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "install", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});

test("legacy installer flags still route to installer help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--codex", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});
