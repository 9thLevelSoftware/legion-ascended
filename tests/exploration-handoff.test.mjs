import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExploration, slugToNodeId } from "../packages/cli/dist/workflow/exploration.js";

const BASE = {
  runId: "run_explore-demo",
  topic: "Asset Mapper",
  entry: "raw-idea",
  createdAt: "2026-07-29T02:00:00.000Z",
  schemaVersion: "0.2.0",
  fallbackSummary: "A brainstorm with no structured output."
};

const parse = (raw) => parseExploration({ ...BASE, raw });

const PROPOSAL = {
  slot: "project.name",
  value: "Asset Mapper",
  rationale: "Used throughout the brainstorm.",
  anchor: "problem-framing",
  confidence: "researched"
};

test("a well-formed brainstorm result becomes a typed exploration", () => {
  const { exploration, diagnostics } = parse({
    summary: "Deterministic asset resolution.",
    proposals: [PROPOSAL],
    openQuestions: [{ slot: "project.stack", question: "Which stack?", why: "Undecided." }],
    notes: [{ heading: "Problem Framing", body: "Teams cannot resolve assets." }]
  });

  assert.equal(exploration.status, "exploratory");
  assert.equal(exploration.proposals.length, 1);
  assert.equal(exploration.openQuestions[0].nodeId, "which-stack");
  assert.deepEqual(diagnostics, []);
});

test("an incomplete proposal is dropped so the slot gets asked instead", () => {
  const { exploration, diagnostics } = parse({
    summary: "s",
    proposals: [PROPOSAL, { slot: "project.stack" }],
    openQuestions: []
  });

  // Degrading toward more questions is the safe direction.
  assert.equal(exploration.proposals.length, 1);
  assert.equal(exploration.proposals[0].slot, "project.name");
  assert.ok(diagnostics.some((entry) => /incomplete and was dropped/.test(entry)));
});

test("a malformed open question is repaired, never dropped", () => {
  const { exploration, diagnostics } = parse({
    summary: "s",
    proposals: [],
    openQuestions: ["we never settled the auth model", { question: "Which region?", slot: "project.region", why: "w" }]
  });

  // Dropping one would silently un-ask a question the brainstorm raised —
  // exactly the v8 bug where open questions evaporated at initialization.
  assert.equal(exploration.openQuestions.length, 2);
  assert.ok(diagnostics.some((entry) => /repaired rather than dropped/.test(entry)));
});

test("a slot that is both proposed and open resolves in favour of asking", () => {
  const { exploration, diagnostics } = parse({
    summary: "s",
    proposals: [{ ...PROPOSAL, slot: "project.stack", confidence: "assumed" }],
    openQuestions: [{ slot: "project.stack", question: "Which stack?", why: "Undecided." }]
  });

  assert.equal(exploration.proposals.length, 0);
  assert.equal(exploration.openQuestions.length, 1);
  assert.ok(diagnostics.some((entry) => /discarded in favour of asking/.test(entry)));
});

test("an unstated confidence is recorded as an assumption", () => {
  const { exploration } = parse({
    summary: "s",
    proposals: [{ slot: "project.name", value: "A", rationale: "r", anchor: "a" }],
    openQuestions: []
  });

  assert.equal(exploration.proposals[0].confidence, "assumed");
});

test("a brainstorm that returned no JSON still yields a valid exploration", () => {
  const { exploration, diagnostics } = parse(undefined);

  // The run happened; losing the whole artifact because the model returned
  // prose would discard the brainstorm entirely.
  assert.equal(exploration.status, "exploratory");
  assert.equal(exploration.summary, BASE.fallbackSummary);
  assert.equal(exploration.proposals.length, 0);
  assert.ok(diagnostics.some((entry) => /no structured result/.test(entry)));
});

test("duplicate open questions get distinct node ids", () => {
  const question = { slot: "project.stack", question: "Which stack?", why: "w" };
  const { exploration } = parse({ summary: "s", proposals: [], openQuestions: [question, question] });

  const ids = exploration.openQuestions.map((entry) => entry.nodeId);
  assert.equal(new Set(ids).size, 2);
});

test("node ids are slugged and fall back when unusable", () => {
  assert.equal(slugToNodeId("Which stack?", 0), "which-stack");
  assert.equal(slugToNodeId("???", 3), "open-question-4");
  // Must start with a letter to satisfy the intake node id pattern.
  assert.equal(slugToNodeId("2026 targets", 0), "open-question-1");
});
