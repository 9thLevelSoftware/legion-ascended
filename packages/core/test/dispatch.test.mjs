/**
 * P08-T01 Fresh-context dispatcher tests.
 *
 * These tests pin the Phase 8 cut line: the dispatcher MUST produce
 * a fully isolated, content-addressed WorkerContext for any
 * preflighted TaskContract and MUST surface structured issues +
 * board blockers when the contract is not ready.
 *
 * Coverage:
 *  1. Happy path — a fully ready contract dispatches to a frozen
 *     context with a stable hash and an isolation tag.
 *  2. Preflight failure — a contract with missing agent resources
 *     returns a typed `resource_unavailable` issue and a board
 *     blocker whose reason carries the code/path.
 *  3. Preflight dependency failure — a contract with an unknown
 *     dependency surfaces `dependency_unsatisfied`.
 *  4. Preflight incompleteness — a contract with an empty context
 *     and no expected artifacts surfaces `contract_incomplete`.
 *  5. Worker bundle ambiguity — two bundles for the same agent
 *     short-circuits to a `resource_unavailable` dispatcher issue.
 *  6. Worker bundle missing — agent not registered short-circuits
 *     to a `resource_unavailable` dispatcher issue.
 *  7. Context reference leak — spec/design refs not in the ready
 *     artifact set produce `context_reference_out_of_scope` issues.
 *  8. Isolation invariants — `assertIsolatedWorkerContext` accepts
 *     a real context and rejects:
 *       a. a context with an extra key (`scratch`)
 *       b. a context with `parentRunIds`
 *       c. a context that is not deeply frozen
 *  9. Determinism — dispatching the same contract twice produces
 *     contexts with identical `workerContextHash` even when
 *     `createdAt` differs (clock injection).
 * 10. Provider neutrality — the dispatcher NEVER references any
 *     runtime driver, Eve, board-store, or process environment.
 * 11. Worker context shape — only keys in `WORKER_CONTEXT_KEYS`
 *     appear on the returned context.
 * 12. Render helpers — `renderDispatchResult` and
 *     `collectBlockers` produce stable strings/arrays.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FreshContextDispatcher,
  FreshContextIsolationError,
  WORKER_CONTEXT_KEYS,
  assertIsolatedWorkerContext,
  collectBlockers,
  createStaticWorkerBundleRegistry,
  deriveIsolationTag,
  deriveWorkerContextHash,
  mapDispatchIssueToBoardBlocker,
  mapDispatchIssuesToBoardBlockers,
  renderDispatchFailureReason,
  renderDispatchResult,
  renderIssueReason,
  selectWorkerBundleForTask
} from "../dist/index.js";

import {
  makeFixtureContract,
  makeFixtureReadyContext,
  makeFixtureWorkerBundle
} from "./dispatch-fixture.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatcher(options = {}) {
  return new FreshContextDispatcher({
    now: () => "2026-06-22T01:30:00.000Z",
    ...options
  });
}

function happyInput(overrides = {}) {
  const contract = makeFixtureContract(overrides.contract);
  const bundle = makeFixtureWorkerBundle(overrides.bundle);
  const registry = overrides.registry ?? createStaticWorkerBundleRegistry([bundle]);
  const ready = overrides.ready ?? makeFixtureReadyContext(contract);
  return {
    taskContract: contract,
    bundleRegistry: registry,
    protocolVersion: "0.1.0",
    ...ready,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test("P08-T01 dispatcher returns a frozen, isolated WorkerContext on a ready contract", () => {
  const d = dispatcher();
  const result = d.dispatch(happyInput());

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable: success path");

  assert.equal(result.matchedAgentId, "legion-worker");
  assert.equal(result.preflightIssueCount, 0);

  const ctx = result.workerContext;
  assert.equal(ctx.kind, "worker-context");
  assert.equal(ctx.schemaVersion, "1.0.0");
  assert.equal(ctx.protocolVersion, "0.1.0");
  assert.equal(ctx.taskContract.id, "ctr_p08-t01-fresh-context");
  assert.equal(ctx.taskContract.revision, 1);
  assert.equal(ctx.workerBundle.id, "legion.core-worker");
  assert.equal(ctx.model.provider, "minimax");
  assert.equal(ctx.model.id, "MiniMax-M3");
  assert.match(ctx.workerContextHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(ctx.isolationTag, /^fresh-context:v1:[0-9a-f]{12}$/);

  // Context references are surfaced in all three buckets AND merged.
  assert.equal(ctx.contextRefs.specRefs.length, 1);
  assert.equal(ctx.contextRefs.designRefs.length, 1);
  assert.equal(ctx.contextRefs.predecessorArtifacts.length, 1);
  assert.equal(ctx.contextRefs.all.length, 3);

  // Deeply frozen — even nested objects cannot be mutated.
  assert.equal(Object.isFrozen(ctx), true);
  assert.equal(Object.isFrozen(ctx.contextRefs), true);
  assert.equal(Object.isFrozen(ctx.contextRefs.all), true);
  assert.equal(Object.isFrozen(ctx.scope), true);
  assert.equal(Object.isFrozen(ctx.taskContract), true);
  assert.equal(Object.isFrozen(ctx.taskContract.context), true);

  // `assertIsolatedWorkerContext` is a no-op when invariants hold.
  assertIsolatedWorkerContext(ctx);
});

// ---------------------------------------------------------------------------
// 2-4. Preflight failure paths
// ---------------------------------------------------------------------------

test("P08-T01 dispatcher surfaces 'resource_unavailable' when the agent is not in the ready set", () => {
  const d = dispatcher();
  const input = happyInput();
  const result = d.dispatch({
    ...input,
    availableAgents: [] // mismatch
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable: blocked path");

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "resource_unavailable");
  assert.equal(result.issues[0].source, "preflight");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].code, "resource_unavailable");
  assert.equal(result.blockers[0].reportedBy, "fresh-context-dispatcher");
  assert.match(result.blockers[0].reason, /^code=resource_unavailable/);
  assert.match(result.blockers[0].reason, /agents\[0\]/);
});

test("P08-T01 dispatcher surfaces 'dependency_unsatisfied' when a dependency revision is missing", () => {
  const d = dispatcher();
  const contract = makeFixtureContract({
    dependencies: [{ contractId: "ctr_p07-t02-preflight", revision: 1 }]
  });
  const bundle = makeFixtureWorkerBundle();
  const input = happyInput({ contract, registry: undefined });
  // Strip the dependency from the ready set so preflight fails it.
  const result = d.dispatch({
    ...input,
    taskContract: contract,
    bundleRegistry: createStaticWorkerBundleRegistry([bundle]),
    availableContracts: [{ contractId: contract.id, revision: contract.revision }] // missing ctr_p07-t02-preflight
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.ok(result.issues.some((issue) => issue.code === "dependency_unsatisfied"));
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "dependency_unsatisfied" && blocker.path.includes("dependencies")
    )
  );
});

test("P08-T01 dispatcher surfaces 'contract_incomplete' when context refs and expected artifacts are empty", () => {
  const d = dispatcher();
  const emptyContract = makeFixtureContract({
    context: { specRefs: [], designRefs: [], predecessorArtifacts: [] },
    completion: {
      expectedArtifacts: [],
      requiredEvidence: ["noop"],
      blockedConditions: ["Acceptance oracle cannot be executed"]
    }
  });
  const input = happyInput({ contract: emptyContract });
  const result = d.dispatch(input);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.ok(result.issues.some((issue) => issue.code === "contract_incomplete"));
  // Two contract_incomplete issues — one for empty context, one for empty completion.
  const incompleteCount = result.issues.filter((issue) => issue.code === "contract_incomplete").length;
  assert.ok(incompleteCount >= 2);
});

// ---------------------------------------------------------------------------
// 5-6. Worker bundle selection failure paths
// ---------------------------------------------------------------------------

test("P08-T01 dispatcher surfaces 'resource_unavailable' when the agent has zero registered bundles", () => {
  const d = dispatcher();
  const registry = createStaticWorkerBundleRegistry([]); // no agents
  const input = happyInput({ registry });
  const result = d.dispatch(input);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "resource_unavailable");
  assert.equal(result.issues[0].source, "dispatcher");
  assert.match(result.issues[0].message, /No worker bundle registered for agent legion-worker/);
});

test("P08-T01 dispatcher surfaces 'resource_unavailable' when the agent has multiple bundles", () => {
  const d = dispatcher();
  const registry = createStaticWorkerBundleRegistry([
    makeFixtureWorkerBundle(),
    { ...makeFixtureWorkerBundle(), bundle: { ...makeFixtureWorkerBundle().bundle, version: "1.1.0" } }
  ]);
  const input = happyInput({ registry });
  const result = d.dispatch(input);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.equal(result.issues[0].code, "resource_unavailable");
  assert.match(result.issues[0].message, /Multiple worker bundles registered/);
});

// ---------------------------------------------------------------------------
// 7. Context reference leak
// ---------------------------------------------------------------------------

test("P08-T01 dispatcher surfaces 'context_reference_out_of_scope' when specRefs are not in the ready artifact set", () => {
  const d = dispatcher();
  const contract = makeFixtureContract();
  const input = {
    taskContract: contract,
    bundleRegistry: createStaticWorkerBundleRegistry([makeFixtureWorkerBundle()]),
    protocolVersion: "0.1.0",
    availableContracts: [{ contractId: contract.id, revision: contract.revision }],
    availableAgents: contract.agents,
    // Intentionally omit spec/design refs from the ready artifact set.
    availableArtifacts: [...contract.context.predecessorArtifacts]
  };
  const result = d.dispatch(input);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  const issue = result.issues.find((entry) => entry.code === "context_reference_out_of_scope");
  assert.ok(issue, "expected context_reference_out_of_scope issue");
  assert.equal(issue.source, "dispatcher");
  assert.match(issue.message, /is not in the ready artifact set/);
});

// ---------------------------------------------------------------------------
// 8. Isolation invariants
// ---------------------------------------------------------------------------

test("P08-T01 assertIsolatedWorkerContext accepts a real WorkerContext", () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  assert.doesNotThrow(() => assertIsolatedWorkerContext(ctx));
});

test("P08-T01 assertIsolatedWorkerContext rejects contexts with extra keys", async () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  // Build a copy with a `scratch` field using a fresh prototype-free
  // object — we cannot mutate the frozen context directly.
  const fake = JSON.parse(JSON.stringify(ctx));
  fake.scratch = { priorRuns: ["run_a", "run_b"] };
  await assert.rejects(
    async () => assertIsolatedWorkerContext(fake),
    (error) =>
      error instanceof FreshContextIsolationError &&
      error.violations.some((v) => v.includes("scratch"))
  );
});

test("P08-T01 assertIsolatedWorkerContext rejects contexts with parentRunIds", async () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  const fake = JSON.parse(JSON.stringify(ctx));
  fake.parentRunIds = ["run_p07-t01", "run_p07-t02"];
  await assert.rejects(
    async () => assertIsolatedWorkerContext(fake),
    (error) =>
      error instanceof FreshContextIsolationError &&
      error.violations.some((v) => v.includes("parentRunIds"))
  );
});

test("P08-T01 assertIsolatedWorkerContext rejects unfrozen contexts", async () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  const fake = JSON.parse(JSON.stringify(ctx)); // JSON.parse yields a non-frozen object
  await assert.rejects(
    async () => assertIsolatedWorkerContext(fake),
    (error) =>
      error instanceof FreshContextIsolationError &&
      error.violations.some((v) => v.includes("not deeply frozen"))
  );
});

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------

test("P08-T01 workerContextHash is deterministic across clock injections", () => {
  const contract = makeFixtureContract();
  const bundle = makeFixtureWorkerBundle();
  const input = {
    taskContract: contract,
    bundleRegistry: createStaticWorkerBundleRegistry([bundle]),
    protocolVersion: "0.1.0",
    availableContracts: [{ contractId: contract.id, revision: contract.revision }],
    availableAgents: contract.agents,
    availableArtifacts: [
      ...contract.context.specRefs,
      ...contract.context.designRefs,
      ...contract.context.predecessorArtifacts
    ]
  };

  const d1 = new FreshContextDispatcher({ now: () => "2026-06-22T01:00:00.000Z" });
  const d2 = new FreshContextDispatcher({ now: () => "2026-06-22T05:00:00.000Z" });

  const ctx1 = d1.dispatch(input).workerContext;
  const ctx2 = d2.dispatch(input).workerContext;

  assert.equal(ctx1.workerContextHash, ctx2.workerContextHash);
  assert.equal(ctx1.isolationTag, ctx2.isolationTag);
  assert.notEqual(ctx1.createdAt, ctx2.createdAt);
});

test("P08-T01 workerContextHash changes when the bundle version changes", () => {
  const contract = makeFixtureContract();
  const baseInput = {
    taskContract: contract,
    bundleRegistry: createStaticWorkerBundleRegistry([makeFixtureWorkerBundle()]),
    protocolVersion: "0.1.0",
    availableContracts: [{ contractId: contract.id, revision: contract.revision }],
    availableAgents: contract.agents,
    availableArtifacts: [
      ...contract.context.specRefs,
      ...contract.context.designRefs,
      ...contract.context.predecessorArtifacts
    ]
  };

  const ctxV1 = dispatcher().dispatch(baseInput).workerContext;
  const ctxV2 = dispatcher().dispatch({
    ...baseInput,
    bundleRegistry: createStaticWorkerBundleRegistry([
      { ...makeFixtureWorkerBundle(), bundle: { ...makeFixtureWorkerBundle().bundle, version: "1.1.0" } }
    ])
  }).workerContext;

  assert.notEqual(ctxV1.workerContextHash, ctxV2.workerContextHash);
});

// ---------------------------------------------------------------------------
// 10. Provider neutrality
// ---------------------------------------------------------------------------

test("P08-T01 dispatcher source never imports runtime drivers, the board persistence layer, or process environment", async () => {
  // The dispatcher module's imports come from @legion/protocol and
  // its own siblings. We assert this against the rendered source via
  // a static import-boundary check, mirroring the spirit of the
  // scripts/scan-runtime-import-boundaries.mjs guard. The check
  // strips JSDoc comment blocks first so prose mentions of
  // `process.env`, `board persistence`, and similar terms do not
  // cause false positives.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const raw = await readFile(
    fileURLToPath(new URL("../src/dispatch/dispatcher.ts", import.meta.url)),
    "utf8"
  );
  const codeOnly = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(codeOnly, /runtime-local|runtime-eve|runtime-legacy/);
  assert.doesNotMatch(codeOnly, /board-store/);
  assert.doesNotMatch(codeOnly, /process\.env/);
  assert.match(codeOnly, /from "@legion\/protocol"/);
});

// ---------------------------------------------------------------------------
// 11. Worker context shape
// ---------------------------------------------------------------------------

test("P08-T01 WorkerContext exposes only keys in WORKER_CONTEXT_KEYS", () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  const expected = new Set(WORKER_CONTEXT_KEYS);
  for (const key of Object.keys(ctx)) {
    assert.ok(expected.has(key), `unexpected WorkerContext key "${key}"`);
  }
  // Sanity: every documented key is present.
  for (const key of WORKER_CONTEXT_KEYS) {
    assert.ok(key in ctx, `missing WorkerContext key "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// 12. Render helpers
// ---------------------------------------------------------------------------

test("P08-T01 renderDispatchResult prints success line with hash and isolation tag", () => {
  const ctx = dispatcher().dispatch(happyInput()).workerContext;
  const text = renderDispatchResult({ ok: true, workerContext: ctx, matchedAgentId: "legion-worker", preflightIssueCount: 0 });
  assert.match(text, /^fresh-context dispatch ok:/);
  assert.ok(text.includes(ctx.workerContextHash));
  assert.ok(text.includes(ctx.isolationTag));
});

test("P08-T01 renderDispatchResult prints failure line with issues and reason", () => {
  const input = happyInput();
  input.availableAgents = [];
  const result = dispatcher().dispatch(input);
  assert.equal(result.ok, false);
  const text = renderDispatchResult(result);
  assert.match(text, /^fresh-context dispatch blocked:/);
  assert.ok(text.includes("issues=1"));
  assert.match(text, /code=resource_unavailable/);
});

test("P08-T01 collectBlockers flattens blockers across multiple dispatch results", () => {
  const ok = dispatcher().dispatch(happyInput());
  const blockedInput = happyInput();
  blockedInput.availableAgents = [];
  const blocked = dispatcher().dispatch(blockedInput);

  const blockers = collectBlockers([ok, blocked]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "resource_unavailable");
});

test("P08-T01 renderIssueReason encodes code + path + message", () => {
  const issue = {
    code: "resource_unavailable",
    message: "Agent resource legion-worker is not available for execution.",
    path: ["agents", 0],
    source: "preflight"
  };
  const text = renderIssueReason(issue);
  assert.equal(text, "code=resource_unavailable path=agents[0] :: Agent resource legion-worker is not available for execution.");
});

test("P08-T01 mapDispatchIssueToBoardBlocker produces a board-shaped blocker", () => {
  const issue = {
    code: "dependency_unsatisfied",
    message: "Dependency ctr_x is not available.",
    path: ["dependencies", 0],
    source: "preflight"
  };
  const blocker = mapDispatchIssueToBoardBlocker(issue, {
    now: () => "2026-06-22T02:00:00.000Z",
    reporter: "test-reporter"
  });
  assert.equal(blocker.code, "dependency_unsatisfied");
  assert.equal(blocker.reportedBy, "test-reporter");
  assert.equal(blocker.reportedAt, "2026-06-22T02:00:00.000Z");
  assert.match(blocker.reason, /code=dependency_unsatisfied/);
});

test("P08-T01 mapDispatchIssuesToBoardBlockers preserves order", () => {
  const issues = [
    { code: "dependency_unsatisfied", message: "x", path: ["dependencies", 0], source: "preflight" },
    { code: "contract_incomplete", message: "y", path: ["context"], source: "preflight" }
  ];
  const blockers = mapDispatchIssuesToBoardBlockers(issues);
  assert.equal(blockers.length, 2);
  assert.equal(blockers[0].code, "dependency_unsatisfied");
  assert.equal(blockers[1].code, "contract_incomplete");
});

test("P08-T01 renderDispatchFailureReason joins issues with ' | '", () => {
  const issues = [
    { code: "a", message: "x", path: ["p", 0], source: "preflight" },
    { code: "b", message: "y", path: ["q"], source: "preflight" }
  ];
  const text = renderDispatchFailureReason(issues);
  assert.ok(text.includes("code=a"));
  assert.ok(text.includes("code=b"));
  assert.ok(text.includes(" | "));
});

// ---------------------------------------------------------------------------
// Selector direct coverage (extra safety)
// ---------------------------------------------------------------------------

test("P08-T01 selectWorkerBundleForTask returns the lone registered bundle", () => {
  const contract = makeFixtureContract();
  const bundle = makeFixtureWorkerBundle();
  const result = selectWorkerBundleForTask(
    contract,
    createStaticWorkerBundleRegistry([bundle])
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.agentId, "legion-worker");
  assert.equal(result.bundle.id, bundle.bundle.id);
});

test("P08-T01 deriveIsolationTag is content-addressed and stable", () => {
  const contract = makeFixtureContract();
  const bundle = makeFixtureWorkerBundle();
  const refs = [
    ...contract.context.specRefs,
    ...contract.context.designRefs,
    ...contract.context.predecessorArtifacts
  ];
  const hash1 = deriveWorkerContextHash({
    taskContract: contract,
    contextRefs: refs,
    workerBundle: bundle.bundle,
    model: bundle.model,
    protocolVersion: "0.1.0"
  });
  const hash2 = deriveWorkerContextHash({
    taskContract: contract,
    contextRefs: [...refs].reverse(), // different order — must still hash the same
    workerBundle: bundle.bundle,
    model: bundle.model,
    protocolVersion: "0.1.0"
  });
  assert.equal(hash1, hash2);
  assert.equal(deriveIsolationTag(hash1), deriveIsolationTag(hash2));
});

// ---------------------------------------------------------------------------
// Idempotency: two dispatches with identical inputs produce identical hashes
// ---------------------------------------------------------------------------

test("P08-T01 two consecutive dispatches produce identical workerContextHash", () => {
  const input = happyInput();
  const d = dispatcher();
  const a = d.dispatch(input);
  const b = d.dispatch({ ...input });
  assert.equal(a.workerContext.workerContextHash, b.workerContext.workerContextHash);
  assert.equal(a.workerContext.isolationTag, b.workerContext.isolationTag);
});
