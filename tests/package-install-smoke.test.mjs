import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("npm package dry-run includes workflow CLI and packaged quickstart", async () => {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
  const pack = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = JSON.parse(pack.stdout)[0];
  const files = new Set(payload.files.map((entry) => entry.path));

  assert.equal(files.has("bin/legion.js"), true);
  assert.equal(files.has("dist/legion-cli.mjs"), true);
  assert.equal(files.has("dist/legion-cli.mjs.map"), true);
  assert.equal(files.has("docs/cli/WORKFLOW-QUICKSTART.md"), true);
  assert.equal(files.has("adapters/codex-cli.md"), true);
});

test("package entrypoint exposes workflow-first help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });

  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.match(result.stdout, /build\s+Execute approved task contracts/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
});
