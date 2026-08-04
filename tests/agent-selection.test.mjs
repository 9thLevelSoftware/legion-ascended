import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKER_BUNDLE_IDS, selectAgents } from "../packages/cli/dist/workflow/agent-selection.js";

/**
 * Which bundle a task is dispatched to, derived rather than assumed.
 *
 * Every planned task named `["implementer"]` and every guidance run named
 * `["explorer"]`, hardcoded — so "agents used" was a constant dressed as a
 * measurement.
 *
 * The replacement is narrow by necessity. `selectWorkerBundleForTask` resolves
 * `agents[0]` and nothing else, so a list is a claim about work nobody does.
 */

test("exactly one agent is selected, because only the first is dispatched", () => {
  // A first version returned ["implementer", "oracle-author"] on the reasoning
  // that specialists are added rather than substituted. Every entry after the
  // first was inert: never dispatched, and counted by anything reporting
  // "agents used" as though it had worked on the task.
  for (const input of [
    { writeScope: [], hasExecutableProof: false },
    { writeScope: ["."], hasExecutableProof: true },
    { writeScope: ["src/"], hasExecutableProof: true, adHocKind: "polish" }
  ]) {
    assert.equal(selectAgents(input).length, 1, `${JSON.stringify(input)} selected more than one agent`);
  }
});

test("a task that writes nothing is an investigation", () => {
  assert.deepEqual(selectAgents({ writeScope: [], hasExecutableProof: false }), ["explorer"]);
});

test("a task that writes gets the implementer, because something has to make the change", () => {
  // Putting a specialist first would mean the code never gets written.
  assert.deepEqual(selectAgents({ writeScope: ["."], hasExecutableProof: true }), ["implementer"]);
  assert.deepEqual(selectAgents({ writeScope: ["src/"], hasExecutableProof: true, adHocKind: "polish" }), ["implementer"]);
});

test("the selection still distinguishes something", () => {
  // The distinction that survives is real and was previously absent.
  const investigating = selectAgents({ writeScope: [], hasExecutableProof: false }).join(",");
  const implementing = selectAgents({ writeScope: ["."], hasExecutableProof: false }).join(",");
  assert.notEqual(investigating, implementing);
});

test("every selected bundle exists", () => {
  // An agent with no worker bundle cannot be dispatched, and that fails at run
  // time rather than here.
  for (const input of [
    { writeScope: [], hasExecutableProof: false },
    { writeScope: ["."], hasExecutableProof: false },
    { writeScope: ["."], hasExecutableProof: true },
    { writeScope: ["src/"], hasExecutableProof: true, adHocKind: "polish" }
  ]) {
    for (const agent of selectAgents(input)) {
      assert.ok(WORKER_BUNDLE_IDS.includes(agent), `${agent} is not a real bundle`);
    }
  }
});
