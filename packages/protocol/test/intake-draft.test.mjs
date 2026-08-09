import assert from "node:assert/strict";
import { test } from "node:test";

import { intakeDraftSchema } from "../dist/index.js";

const FIXED_TIME = "2026-08-08T15:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const FINGERPRINT = "b".repeat(64);

function intakeDraft(overrides = {}) {
  return {
    schemaVersion: "0.3.0",
    createdAt: FIXED_TIME,
    kind: "intake-draft",
    id: "itd_asset-mapper",
    status: "draft",
    graphVersion: "2.0.0",
    projectMode: "brownfield",
    initiative: "Add deterministic asset resolution to the existing media workspace.",
    explorationRefs: [
      {
        kind: "exploration",
        runId: "run_explore-asset-mapper",
        artifact: {
          path: ".legion/project/guidance/explore/run_explore-asset-mapper/exploration.json",
          sha256: HASH,
          mediaType: "application/json"
        },
        anchor: "asset-resolution"
      }
    ],
    codebaseMapRef: {
      kind: "codebase-map",
      artifact: {
        path: ".legion/project/guidance/map/run_map-asset-mapper/map.json",
        sha256: HASH,
        mediaType: "application/json"
      },
      sourceFingerprint: FINGERPRINT
    },
    proposedAnswers: [
      {
        nodeId: "project-name",
        slot: "project.name",
        value: "Asset Mapper",
        confidence: "researched",
        rationale: "The exploration and repository manifest use this project name.",
        answerAnchor: "project-name",
        evidenceRefs: [
          {
            kind: "repository-file",
            artifact: { path: "package.json", sha256: HASH, mediaType: "application/json" },
            anchor: "name"
          }
        ]
      }
    ],
    injectedQuestions: [
      {
        nodeId: "open-auth-model",
        slot: "open.auth-model",
        prompt: "Which auth model does v1 use?",
        origin: { runId: "run_explore-asset-mapper", anchor: "auth-model" }
      }
    ],
    unresolvedNodes: [
      {
        nodeId: "open-auth-model",
        slot: "open.auth-model",
        question: "Which auth model does v1 use?",
        rationale: "The repository has no existing authentication boundary.",
        evidenceRefs: [
          {
            kind: "codebase-map",
            artifact: {
              path: ".legion/project/guidance/map/run_map-asset-mapper/map.json",
              sha256: HASH,
              mediaType: "application/json"
            },
            sourceFingerprint: FINGERPRINT
          }
        ]
      }
    ],
    diagnostics: ["The draft needs a human decision for authentication."],
    ...overrides
  };
}

test("an intake draft round-trips its selected evidence and proposed answers", () => {
  const draft = intakeDraft();
  assert.deepEqual(intakeDraftSchema.parse(draft), draft);
});

test("a draft refuses a node that is both proposed and unresolved", () => {
  const conflicting = intakeDraft({
    unresolvedNodes: [
      {
        nodeId: "project-name",
        slot: "project.name",
        question: "What should the project be named?",
        rationale: "The selection has not been confirmed.",
        evidenceRefs: []
      }
    ]
  });

  assert.throws(() => intakeDraftSchema.parse(conflicting), /cannot be proposed and unresolved/);
});
