import assert from "node:assert/strict";
import { test } from "node:test";

import { formatEntityId, intakeSessionSchema } from "../dist/index.js";

const FIXED_TIME = "2026-07-29T02:00:00.000Z";

function session(overrides = {}) {
  return {
    schemaVersion: "0.2.0",
    createdAt: FIXED_TIME,
    kind: "intake-session",
    id: "itk_asset-mapper",
    graphVersion: "1.0.0",
    status: "active",
    cursor: "requirements-loop",
    answers: [
      {
        nodeId: "project-name",
        slot: "project.name",
        value: "Asset Mapper",
        answeredAt: FIXED_TIME,
        source: "human"
      }
    ],
    injectedNodes: [],
    diagnostics: [],
    ...overrides
  };
}

test("intake session IDs use the itk_ prefix", () => {
  assert.equal(formatEntityId("intake", "asset-mapper"), "itk_asset-mapper");
});

test("an active session with a human answer parses", () => {
  const parsed = intakeSessionSchema.parse(session());
  assert.equal(parsed.status, "active");
  assert.equal(parsed.answers[0].source, "human");
});

test("an accepted proposal must cite the exploration it came from", () => {
  const withoutCitation = session({
    answers: [
      {
        nodeId: "project-name",
        slot: "project.name",
        value: "Asset Mapper",
        answeredAt: FIXED_TIME,
        source: "proposed-accepted"
      }
    ]
  });
  assert.throws(() => intakeSessionSchema.parse(withoutCitation), /exploration it came from/);

  const withCitation = session({
    answers: [
      {
        nodeId: "project-name",
        slot: "project.name",
        value: "Asset Mapper",
        answeredAt: FIXED_TIME,
        source: "proposed-accepted",
        proposedFrom: { runId: "run_explore-asset-mapper", anchor: "product-definition" }
      }
    ]
  });
  const parsed = intakeSessionSchema.parse(withCitation);
  assert.equal(parsed.answers[0].proposedFrom.anchor, "product-definition");
});

test("a finalized session cannot still have an open cursor", () => {
  const stillOpen = session({
    status: "finalized",
    projectId: "prj_asset-mapper",
    cursor: "requirements-loop"
  });
  assert.throws(() => intakeSessionSchema.parse(stillOpen), /cannot still have an open cursor/);
});

test("a finalized session must record the project it created", () => {
  const orphaned = session({ status: "finalized", cursor: undefined });
  assert.throws(() => intakeSessionSchema.parse(orphaned), /must record the project/);

  const complete = session({
    status: "finalized",
    cursor: undefined,
    projectId: "prj_asset-mapper"
  });
  assert.equal(intakeSessionSchema.parse(complete).projectId, "prj_asset-mapper");
});

test("a node may not be answered twice in the same session", () => {
  const duplicated = session({
    answers: [
      { nodeId: "project-name", slot: "project.name", value: "A", answeredAt: FIXED_TIME, source: "human" },
      { nodeId: "project-name", slot: "project.name", value: "B", answeredAt: FIXED_TIME, source: "human" }
    ]
  });
  assert.throws(() => intakeSessionSchema.parse(duplicated), /answered at most once/);
});

test("injected open questions are recorded with their origin and must be unique", () => {
  const origin = { runId: "run_explore-asset-mapper", anchor: "open-questions-1" };
  const injected = session({
    injectedNodes: [
      {
        nodeId: "open-auth-model",
        slot: "open.auth-model",
        prompt: "Exploration left the auth model unresolved. Which model does v1 use?",
        origin
      }
    ]
  });
  assert.equal(intakeSessionSchema.parse(injected).injectedNodes.length, 1);

  const duplicated = session({
    injectedNodes: [
      { nodeId: "open-auth-model", slot: "open.auth-model", prompt: "First", origin },
      { nodeId: "open-auth-model", slot: "open.auth-model", prompt: "Second", origin }
    ]
  });
  assert.throws(() => intakeSessionSchema.parse(duplicated), /must be unique/);
});
