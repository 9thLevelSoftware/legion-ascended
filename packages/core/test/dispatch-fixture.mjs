/**
 * P08-T01 dispatch fixture helpers.
 *
 * Minimal, fully-typed TaskContract and WorkerBundle builders for the
 * dispatch tests. Keeps the test file readable and ensures every
 * dispatched contract has the minimum fields the protocol requires
 * (wave, agents, scope, completion, etc.).
 */

import {
  sha256ContentHash,
  buildLocalWorkerBundle
} from "../dist/index.js";

/**
 * Build a SHA-256 content hash from any string. Test convenience —
 * mirrors the helper in runtime/local-driver.ts so the test fixture
 * stays self-contained.
 */
function hash(input) {
  return sha256ContentHash(input);
}

function ref(path, payload) {
  return {
    path,
    sha256: hash(payload),
    mediaType: "text/markdown"
  };
}

/**
 * Build a valid TaskContract for a fresh-context dispatch test.
 *
 * Pass overrides only for fields the test needs to vary. Defaults
 * give a contract that:
 *  - references one spec, one design, one predecessor artifact,
 *  - is ready (preflight passes) when all three refs are in the
 *    ready artifact set,
 *  - has an empty dependencies list,
 *  - assigns the `legion-worker` agent,
 *  - belongs to wave `A` at revision 1.
 */
export function makeFixtureContract(overrides = {}) {
  const specRef = ref(".legion/project/specs/workflow-orchestration.md", "spec-1");
  const designRef = ref(".legion/project/changes/chg_phase-08/design.md", "design-1");
  const predecessorRef = ref("packages/protocol/src/entities/task-contract.ts", "predecessor-1");

  const base = {
    schemaVersion: "1.0.0",
    createdAt: "2026-06-22T01:00:00.000Z",
    kind: "task-contract",
    id: "ctr_p08-t01-fresh-context",
    projectId: "prj_legion-next",
    changeId: "chg_phase-08-fresh-context",
    revision: 1,
    title: "P08-T01: Fresh context execution",
    objective: "Spawn each worker with a fresh context derived from the TaskContract.",
    requirementIds: ["req_fresh-context-dispatcher"],
    wave: "A",
    agents: ["legion-worker"],
    dependencies: [],
    context: {
      specRefs: [specRef],
      designRefs: [designRef],
      predecessorArtifacts: [predecessorRef]
    },
    scope: {
      read: [
        "packages/protocol/src/entities/task-contract.ts",
        "packages/core/src/dispatch/dispatcher.ts"
      ],
      write: [
        "packages/core/src/dispatch/dispatcher.ts",
        "packages/core/test/dispatch.test.mjs"
      ],
      forbidden: ["packages/core/src/runtime/local-driver.ts"],
      sequentialFiles: ["packages/core/src/index.ts"]
    },
    interfaces: {
      consumes: [
        {
          name: "preflightTaskContract",
          description: "P07-T02 pre-execution validator."
        }
      ],
      produces: [
        {
          name: "FreshContextDispatcher",
          description: "P08-T01 dispatcher that returns isolated worker contexts."
        }
      ]
    },
    oracleRefs: ["orc_fresh-context-isolation"],
    verification: [
      {
        command: "pnpm",
        args: ["--filter", "@legion/core", "test"],
        expectedExitCode: 0
      }
    ],
    risk: {
      tier: "R2",
      reasons: ["fresh-context-isolation", "cross-task-memory-bleed-risk"]
    },
    approvals: ["contract-approved"],
    completion: {
      expectedArtifacts: [
        ref("packages/core/src/dispatch/dispatcher.ts", "dispatcher-source"),
        ref("packages/core/test/dispatch.test.mjs", "dispatcher-test")
      ],
      requiredEvidence: ["isolation-test-report", "dispatcher-coverage"],
      blockedConditions: [
        "Acceptance oracle cannot be executed",
        "Required write falls outside allowlist"
      ]
    }
  };

  return { ...base, ...overrides };
}

/**
 * Build a WorkerBundle for the `legion-worker` agent with the model
 * manifest wired in. Tests register this through the static
 * `createStaticWorkerBundleRegistry` helper.
 */
export function makeFixtureWorkerBundle(overrides = {}) {
  const bundle = buildLocalWorkerBundle();
  return {
    agentId: "legion-worker",
    bundle: {
      ...bundle,
      role: "implementer",
      domain: "core",
      id: "legion.core-worker",
      version: "1.0.0",
      capabilities: ["schema-definition", "schema-validation", "task-execution"]
    },
    model: {
      provider: "minimax",
      id: "MiniMax-M3",
      policyVersion: "1.0.0"
    },
    ...overrides
  };
}

/**
 * Build the ready context that satisfies the contract's
 * dependencies, agents, and predecessor artifacts. Pass
 * `omitArtifacts: true` to drop `availableArtifacts` from the
 * returned object (used to exercise the missing-reference path).
 */
export function makeFixtureReadyContext(contract, options = {}) {
  return {
    availableContracts: [{ contractId: contract.id, revision: contract.revision }],
    availableAgents: contract.agents,
    availableArtifacts: options.omitArtifacts === true
      ? []
      : [
          ...contract.context.specRefs,
          ...contract.context.designRefs,
          ...contract.context.predecessorArtifacts
        ]
  };
}
