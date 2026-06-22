/**
 * P08-T02 review-pipeline fixture helpers.
 *
 * Builds a minimal, fully-typed review-pipeline input from the same
 * TaskContract / WorkerBundle fixtures used by the P08-T01 dispatch
 * tests, so the review tests exercise the same contract shape as
 * the upstream dispatcher.
 */

import {
  FreshContextDispatcher,
  buildLocalWorkerBundle,
  createStaticWorkerBundleRegistry,
  sha256ContentHash
} from "../dist/index.js";

import { makeFixtureContract, makeFixtureReadyContext, makeFixtureWorkerBundle } from "./dispatch-fixture.mjs";

export function makeImplementer(overrides = {}) {
  return {
    kind: "worker",
    id: "legion-worker",
    displayName: "Legion Worker",
    ...overrides
  };
}

export function makeReviewer(overrides = {}) {
  return {
    kind: "human",
    id: "reviewer.dasbl",
    displayName: "Independent Reviewer",
    ...overrides
  };
}

export function makeReviewerInput(overrides = {}) {
  return {
    reviewer: overrides.reviewer ?? makeReviewer(),
    verdicts: overrides.verdicts ?? {
      specification: "pass",
      integration: "pass",
      evidence: "pass"
    },
    findings: overrides.findings ?? [],
    confidence: overrides.confidence ?? "high",
    submittedAt: overrides.submittedAt ?? "2026-06-22T02:30:00.000Z",
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.note === undefined ? {} : { note: overrides.note })
  };
}

/**
 * Build a fully-dispatched `WorkerContext` for tests that exercise
 * the review pipeline without re-running the dispatcher's
 * preflight path. Mirrors the makeFixtureReadyContext helper.
 */
export async function makeFixtureWorkerContext(overrides = {}) {
  const contract = overrides.contract ?? makeFixtureContract();
  const bundle = overrides.bundle ?? makeFixtureWorkerBundle();
  const dispatcher = overrides.dispatcher ?? new FreshContextDispatcher({
    now: () => "2026-06-22T02:00:00.000Z"
  });
  const ready = overrides.ready ?? makeFixtureReadyContext(contract);
  const result = dispatcher.dispatch({
    taskContract: contract,
    bundleRegistry: createStaticWorkerBundleRegistry([bundle]),
    protocolVersion: "0.1.0",
    ...ready
  });
  if (!result.ok) {
    throw new Error("dispatch fixture failed to produce a worker context: " + JSON.stringify(result));
  }
  return result.workerContext;
}

/**
 * Stub verification runner: returns a passing result for every
 * requested command. Pass `perCommand` to inject per-command
 * overrides (e.g. exit codes, stdout hashes).
 */
export function makePassingRunner(overrides = {}) {
  return async (request) => {
    const commandOverride = overrides.perCommand?.[request.index];
    if (commandOverride !== undefined) {
      return buildResultFromOverride(request, commandOverride);
    }
    if (overrides.allExitCode !== undefined) {
      return buildResult(request, overrides.allExitCode, false);
    }
    return buildResult(request, 0, false);
  };
}

/**
 * Stub verification runner: returns failing results (exit code 1)
 * for every requested command.
 */
export function makeFailingRunner() {
  return async (request) => buildResult(request, 1, false);
}

/**
 * Stub verification runner: throws on every command.
 */
export function makeThrowingRunner() {
  return async () => {
    throw new Error("verification runner injected failure");
  };
}

function buildResult(request, exitCode, timedOut) {
  const stdout = `stdout-for-${request.index}`;
  const stderr = `stderr-for-${request.index}`;
  return {
    index: request.index,
    command: request.command,
    args: [...request.args],
    exitCode,
    expectedExitCode: request.expectedExitCode,
    stdoutSha256: sha256ContentHash(stdout),
    stderrSha256: sha256ContentHash(stderr),
    combinedSha256: sha256ContentHash(stdout + stderr),
    durationMs: 12,
    timedOut,
    startedAt: "2026-06-22T02:00:00.000Z",
    finishedAt: "2026-06-22T02:00:01.000Z"
  };
}

function buildResultFromOverride(request, override) {
  const base = buildResult(request, override.exitCode ?? 0, override.timedOut ?? false);
  return { ...base, ...override };
}

// Re-export helpers used by the review tests.
export { makeFixtureContract, makeFixtureReadyContext, makeFixtureWorkerBundle, buildLocalWorkerBundle };