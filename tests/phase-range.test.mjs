import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePhaseRange } from "../packages/cli/dist/workflow/phase-range.js";

/**
 * `legion milestone --define MVP --phases 1-3` stored "1-3" verbatim and nothing
 * parsed it. Three recorded gaps traced back to that one absence: `--status`
 * could not render progress, `--complete` could not gate on whether the phases
 * were done, and `retro --milestone` had no set of changes to gather from.
 */

test("the advertised forms parse", () => {
  assert.deepEqual(parsePhaseRange("1-3").phases, [1, 2, 3]);
  assert.deepEqual(parsePhaseRange("4").phases, [4]);
  assert.deepEqual(parsePhaseRange("1,2,5").phases, [1, 2, 5]);
  assert.deepEqual(parsePhaseRange("1-3,7").phases, [1, 2, 3, 7]);
  assert.deepEqual(parsePhaseRange(" 1 - 3 , 7 ").phases, [1, 2, 3, 7]);
});

test("phases are sorted and deduplicated", () => {
  // So `3,1,1-2` and `1-3` describe the same milestone. A caller comparing two
  // milestones' coverage compares sets, not the strings someone typed.
  assert.deepEqual(parsePhaseRange("3,1,1-2").phases, [1, 2, 3]);
});

test("a partial parse is refused rather than silently narrowed", () => {
  // `Number.parseInt` returns 1 for every one of these, which would define a
  // milestone over a phase the caller did not name.
  for (const value of ["1.5", "1foo", "1e2", "01", "-1", "0"]) {
    assert.equal(parsePhaseRange(value).ok, false, `${value} was accepted`);
  }
});

test("malformed structure is refused with a reason", () => {
  const cases = {
    "": /cannot be empty/,
    "1,,2": /empty entry/,
    "1-2-3": /not a phase or a range/,
    "5-2": /runs backwards/,
    "1-9999": /more than 512/
  };
  for (const [value, pattern] of Object.entries(cases)) {
    const result = parsePhaseRange(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} was accepted`);
    assert.match(result.reason, pattern);
  }
});

test("every refusal names an example the caller can act on", () => {
  // A parser that only says "invalid" makes the caller guess the grammar.
  for (const value of ["", "1-2-3", "5-2", "1foo"]) {
    assert.match(parsePhaseRange(value).reason, /"1-3"/);
  }
});
