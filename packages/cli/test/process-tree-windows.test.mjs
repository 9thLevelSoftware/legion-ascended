import assert from "node:assert/strict";
import test from "node:test";

import * as adapterModule from "../dist/workflow/executor/adapters.js";

const { processTreeStillExistsForPlatform } = adapterModule;

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
