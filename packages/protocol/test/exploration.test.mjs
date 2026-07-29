import assert from "node:assert/strict";
import { test } from "node:test";

import { explorationSchema } from "../dist/index.js";

const FIXED_TIME = "2026-07-29T02:00:00.000Z";

function exploration(overrides = {}) {
  return {
    schemaVersion: "0.2.0",
    createdAt: FIXED_TIME,
    kind: "exploration",
    runId: "run_explore-asset-mapper",
    status: "exploratory",
    entry: "raw-idea",
    topic: "Asset Mapper",
    summary: "A tool for deterministic asset resolution across large media libraries.",
    proposals: [
      {
        slot: "project.name",
        value: "Asset Mapper",
        rationale: "The operator used this name throughout the brainstorm.",
        anchor: "problem-framing",
        confidence: "researched"
      }
    ],
    openQuestions: [],
    notes: [{ heading: "Problem Framing", body: "Media teams cannot resolve assets deterministically." }],
    ...overrides
  };
}

test("a well-formed exploration parses", () => {
  const parsed = explorationSchema.parse(exploration());
  assert.equal(parsed.status, "exploratory");
  assert.equal(parsed.proposals[0].confidence, "researched");
});

test("an exploration cannot be marked authoritative", () => {
  // `status` is a literal, so there is no value that promotes an exploration
  // into something downstream may treat as a requirement.
  for (const status of ["accepted", "active", "approved", "final"]) {
    assert.throws(() => explorationSchema.parse(exploration({ status })));
  }
});

test("a slot may be proposed at most once", () => {
  const duplicated = exploration({
    proposals: [
      { slot: "project.name", value: "A", rationale: "first", anchor: "a", confidence: "inferred" },
      { slot: "project.name", value: "B", rationale: "second", anchor: "b", confidence: "inferred" }
    ]
  });
  assert.throws(() => explorationSchema.parse(duplicated), /at most one value per intake slot/);
});

test("open questions carry a node id and must be unique", () => {
  const question = {
    nodeId: "open-auth-model",
    slot: "open.auth-model",
    question: "Which auth model does v1 use?",
    why: "The brainstorm assumed SSO without confirming it."
  };

  const single = explorationSchema.parse(exploration({ openQuestions: [question] }));
  assert.equal(single.openQuestions[0].nodeId, "open-auth-model");

  assert.throws(
    () => explorationSchema.parse(exploration({ openQuestions: [question, question] })),
    /must be unique/
  );
});

test("a slot cannot be both proposed and left open", () => {
  // Otherwise accepting the proposal would silently skip the very question the
  // exploration said it could not settle.
  const conflicted = exploration({
    proposals: [
      { slot: "project.stack", value: "Next.js", rationale: "guess", anchor: "a", confidence: "assumed" }
    ],
    openQuestions: [
      {
        nodeId: "open-stack",
        slot: "project.stack",
        question: "Which stack?",
        why: "Unresolved during exploration."
      }
    ]
  });

  assert.throws(() => explorationSchema.parse(conflicted), /resolve one or the other/);
});

test("confidence is required so unfounded suggestions are visible", () => {
  const noConfidence = exploration({
    proposals: [{ slot: "project.name", value: "A", rationale: "r", anchor: "a" }]
  });
  assert.throws(() => explorationSchema.parse(noConfidence));

  const assumed = explorationSchema.parse(
    exploration({
      proposals: [
        { slot: "project.name", value: "A", rationale: "r", anchor: "a", confidence: "assumed" }
      ]
    })
  );
  assert.equal(assumed.proposals[0].confidence, "assumed");
});

test("an exploration with nothing settled is still valid", () => {
  // The honest outcome of a brainstorm can be "we learned what we do not know".
  const parsed = explorationSchema.parse(
    exploration({
      proposals: [],
      openQuestions: [
        {
          nodeId: "open-target-users",
          slot: "project.target-users",
          question: "Who is this actually for?",
          why: "Three incompatible audiences were discussed."
        }
      ]
    })
  );
  assert.equal(parsed.proposals.length, 0);
  assert.equal(parsed.openQuestions.length, 1);
});
