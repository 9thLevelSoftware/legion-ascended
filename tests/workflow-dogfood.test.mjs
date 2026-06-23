import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("workflow dogfood script completes the synthetic workflow loop", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/dogfood-workflow.mjs",
    "--json"
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.executor, "fake");
  assert.equal(payload.source, "synthetic");
  assert.equal(payload.finalStage, "ship_ready");
  assert.equal(payload.shipStatus, "ready");
  assert.equal(payload.taskRuns > 0, true);
});
