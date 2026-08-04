import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKER_BUNDLE_IDS, selectAgents } from "../packages/cli/dist/workflow/agent-selection.js";

/**
 * Which bundle a task is dispatched to, derived rather than assumed.
 *
 * Every planned task named `["implementer"]` and every guidance run named
 * `["explorer"]`, hardcoded — so "agents used" was a constant dressed as a
 * measurement, and a retrospective reporting it would have been reporting the
 * literal in the planner.
 */

test("a task that writes nothing is an investigation", () => {
  assert.deepEqual(selectAgents({ writeScope: [], hasExecutableProof: false }), ["explorer"]);
});

test("a task that writes always includes the implementer", () => {
  // Specialists are added, not substituted: something still has to make the change.
  assert.ok(selectAgents({ writeScope: ["."], hasExecutableProof: false }).includes("implementer"));
  assert.ok(selectAgents({ writeScope: ["src/"], hasExecutableProof: true }).includes("implementer"));
});

test("an executable criterion brings the oracle author", () => {
  // A runner decides acceptance, so the fixture it executes is part of the work.
  const withProof = selectAgents({ writeScope: ["."], hasExecutableProof: true });
  const without = selectAgents({ writeScope: ["."], hasExecutableProof: false });
  assert.ok(withProof.includes("oracle-author"));
  assert.equal(without.includes("oracle-author"), false);
});

test("polish brings a reviewer, because preserving behaviour is a review property", () => {
  const polish = selectAgents({ writeScope: ["src/"], hasExecutableProof: true, adHocKind: "polish" });
  const quick = selectAgents({ writeScope: ["src/"], hasExecutableProof: true, adHocKind: "quick" });
  assert.ok(polish.includes("task-reviewer"));
  assert.equal(quick.includes("task-reviewer"), false);
});

test("every selected bundle exists", () => {
  // An agent with no worker bundle cannot be dispatched, so a selection naming
  // one that is not in bundles/index.json would fail at run time rather than here.
  const cases = [
    { writeScope: [], hasExecutableProof: false },
    { writeScope: ["."], hasExecutableProof: false },
    { writeScope: ["."], hasExecutableProof: true },
    { writeScope: ["src/"], hasExecutableProof: true, adHocKind: "polish" },
    { writeScope: ["src/"], hasExecutableProof: true, adHocKind: "quick" }
  ];
  for (const input of cases) {
    for (const agent of selectAgents(input)) {
      assert.ok(WORKER_BUNDLE_IDS.includes(agent), `${agent} is not a real bundle`);
    }
  }
});

test("selection is not a constant", () => {
  // The defect this replaces: one literal for every task regardless of shape.
  const shapes = new Set([
    selectAgents({ writeScope: [], hasExecutableProof: false }).join(","),
    selectAgents({ writeScope: ["."], hasExecutableProof: false }).join(","),
    selectAgents({ writeScope: ["."], hasExecutableProof: true }).join(","),
    selectAgents({ writeScope: ["."], hasExecutableProof: true, adHocKind: "polish" }).join(",")
  ]);
  assert.ok(shapes.size >= 4, `expected distinct selections, got ${[...shapes].join(" | ")}`);
});
