import assert from "node:assert/strict";
import test from "node:test";

import * as adapterModule from "../dist/workflow/executor/adapters.js";

const {
  processTreeStillExistsForPlatform,
  windowsProcessRowsForTests,
  windowsTaskkillPidsForTests
} = adapterModule;

test("bounds Windows process-table probes and fails closed when both probes time out", () => {
  assert.equal(typeof windowsProcessRowsForTests, "function");
  if (typeof windowsProcessRowsForTests !== "function") return;
  const calls = [];
  const timeoutError = new Error("process-table probe timed out");
  assert.throws(() => windowsProcessRowsForTests((command, _args, options) => {
    calls.push({ command, timeout: options.timeout });
    throw timeoutError;
  }), (error) => error === timeoutError);

  assert.deepEqual(calls, [
    { command: "wmic", timeout: 2_000 },
    { command: "powershell.exe", timeout: 2_000 }
  ]);
  assert.equal(processTreeStillExistsForPlatform(111, "win32", {
    processStillExists: () => false,
    windowsDescendantPids: () => {
      throw timeoutError;
    }
  }), true);
});

test("kills the leader and each enumerated Windows descendant with taskkill", async () => {
  assert.equal(typeof windowsTaskkillPidsForTests, "function");
  if (typeof windowsTaskkillPidsForTests !== "function") return;
  const commands = [];
  await windowsTaskkillPidsForTests(111, [222, 333], async (args) => {
    commands.push(args);
  });

  assert.deepEqual(commands, [
    ["/pid", "111", "/t", "/f"],
    ["/pid", "222", "/t", "/f"],
    ["/pid", "333", "/t", "/f"]
  ]);
});

test("treats a live Windows descendant as non-quiescent after the leader exits", () => {
  assert.equal(typeof processTreeStillExistsForPlatform, "function");
  if (typeof processTreeStillExistsForPlatform !== "function") return;
  const livePids = new Set([222]);
  const descendants = [];
  const treeStillExists = processTreeStillExistsForPlatform(111, "win32", {
    windowsDescendantPids: (pid) => {
      descendants.push(pid);
      return [222, 333];
    },
    processStillExists: (pid) => livePids.has(pid)
  });

  assert.deepEqual(descendants, [111]);
  assert.equal(treeStillExists, true);
});

test("keeps non-Windows quiescence on the process-group probe", () => {
  assert.equal(typeof processTreeStillExistsForPlatform, "function");
  if (typeof processTreeStillExistsForPlatform !== "function") return;
  let groupProbeCount = 0;
  const treeStillExists = processTreeStillExistsForPlatform(444, "darwin", {
    processGroupStillExists: (pid) => {
      assert.equal(pid, 444);
      groupProbeCount += 1;
      return true;
    },
    windowsDescendantPids: () => {
      throw new Error("Windows descendant enumeration must not run on POSIX");
    }
  });

  assert.equal(treeStillExists, true);
  assert.equal(groupProbeCount, 1);
});
