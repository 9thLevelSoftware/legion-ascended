/**
 * P08-T02 — Deterministic verification runner.
 *
 * Responsibilities:
 *  1. Walk `TaskContract.verification[]` in order.
 *  2. For each command, delegate to the injected `VerificationRunner`
 *     and capture a `VerificationCommandResult`.
 *  3. Aggregate the results into a `VerificationReport` whose
 *     `passed` flag is true iff every command exited with its
 *     declared `expectedExitCode` AND none timed out.
 *  4. Compute a deterministic `reportSha256` so downstream reviewers
 *     and the acceptance gate can prove "same context + same runner
 *     ⇒ same report" without re-running.
 *
 * Why the runner is injected:
 *  - The pipeline is provider-neutral (ADR-004 / ADR-005). The
 *    actual command execution is a concern of the CLI adapter or the
 *    runtime driver. Core only owns the deterministic record shape.
 *  - Tests inject a stub runner that returns canned results.
 */

import type { ContentHash, Oracle, TaskContract, UtcTimestamp } from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import { deriveVerificationReportSha256 } from "./hash.js";
import type {
  ReviewPipelineIssue,
  VerificationCommandRequest,
  VerificationCommandResult,
  VerificationReport,
  VerificationRunner
} from "./contract.js";
import { REVIEW_PIPELINE_SCHEMA_VERSION } from "./contract.js";

const DEFAULT_TIMEOUT_MS = 5_000;

const fixedClock = (): UtcTimestamp => "2026-06-22T02:00:00.000Z" as UtcTimestamp;

export interface DeterministicVerificationOptions {
  readonly runner?: VerificationRunner;
  readonly now?: () => UtcTimestamp;
  readonly defaultTimeoutMs?: number;
  /**
   * Override the per-command timeout handler. Defaults to the
   * `runner` promise race; tests inject deterministic completion.
   */
  readonly timeout?: (ms: number) => Promise<never>;
  /**
   * Oracles to execute alongside the contract's own verification.
   *
   * An executable oracle carries the command that decides an acceptance
   * criterion. Until this existed, that command ran only by coincidence — the
   * planner puts the same string into `task.verification`, so it executed as a
   * verification command and nothing tied the result back to the `orc_…` that
   * declared it. An oracle that was never planned into `verification`, or whose
   * command drifted from it, was simply never run while the task reported
   * verified.
   *
   * They join the same report deliberately: `evaluateAcceptanceGate` already
   * fails a task whose `VerificationReport` did not pass, so an oracle failure
   * blocks acceptance without a second gate to keep in step.
   */
  readonly oracles?: readonly Oracle[];
}

/** Which oracle a result at a given command index came from. */
export interface OracleAttribution {
  readonly index: number;
  readonly oracleId: string;
  readonly title: string;
}

interface RunnerOutcome {
  readonly result?: VerificationCommandResult;
  readonly error?: unknown;
}

class VerificationCommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    const suffix = cause instanceof Error && cause.message.length > 0 ? ` (${cause.message})` : "";
    super(`verification command timed out after ${timeoutMs}ms${suffix}`);
    this.name = "VerificationCommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wrap a runner call so a thrown error or a non-promise return is
 * normalized into a structured failure. The pipeline emits a typed
 * `verification_runner_unavailable` issue when the runner is
 * missing, and a `verification_command_failed` issue when a runner
 * call itself throws.
 */
async function safeInvoke(
  runner: VerificationRunner | undefined,
  request: VerificationCommandRequest,
  timeoutMs: number,
  timeout?: (ms: number) => Promise<never>
): Promise<RunnerOutcome> {
  if (runner === undefined) {
    return {
      error: new Error("verification runner is not configured for this pipeline run")
    };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const runnerPromise = Promise.resolve().then(() => runner(request));
    const timeoutPromise =
      timeout === undefined
        ? new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new VerificationCommandTimeoutError(timeoutMs));
            }, timeoutMs);
          })
        : timeout(timeoutMs).catch((error: unknown) => {
            throw error instanceof VerificationCommandTimeoutError
              ? error
              : new VerificationCommandTimeoutError(timeoutMs, error);
          });
    const outcome = await Promise.race([runnerPromise, timeoutPromise]);
    return { result: outcome };
  } catch (error) {
    return { error };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function emptyResultFor(
  request: VerificationCommandRequest,
  startedAt: UtcTimestamp,
  finishedAt: UtcTimestamp,
  errorMessage: string,
  timedOut = false
): VerificationCommandResult {
  const noContentHash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as unknown as ContentHash;
  return {
    index: request.index,
    command: request.command,
    args: [...request.args],
    exitCode: 1,
    expectedExitCode: request.expectedExitCode,
    stdoutSha256: noContentHash,
    stderrSha256: noContentHash,
    combinedSha256: noContentHash,
    durationMs: 0,
    timedOut,
    startedAt,
    finishedAt,
    notes: errorMessage
  };
}

function recordFailingIndices(
  results: readonly VerificationCommandResult[]
): readonly number[] {
  const indices: number[] = [];
  for (const result of results) {
    if (result.timedOut || result.exitCode !== result.expectedExitCode) {
      indices.push(result.index);
    }
  }
  return indices;
}

/**
 * Run all verification commands for a fresh worker context and
 * return a frozen `VerificationReport`. Caller controls the runner
 * injection point so unit tests can stub deterministic outcomes.
 */
export async function runDeterministicVerification(input: {
  readonly taskContract: TaskContract;
  readonly workerContext: WorkerContext;
  readonly options?: DeterministicVerificationOptions;
}): Promise<{
  readonly report: VerificationReport;
  readonly issues: readonly ReviewPipelineIssue[];
  /**
   * Index → oracle, for the commands this run took from an oracle.
   *
   * Carried beside the report rather than on `VerificationCommandResult`,
   * because that shape feeds `deriveVerificationReportSha256` and adding a field
   * would change every recorded hash for a fact the caller can hold instead.
   */
  readonly oracleAttribution: readonly OracleAttribution[];
}> {
  const now = input.options?.now ?? fixedClock;
  const runner = input.options?.runner;
  const defaultTimeout = input.options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contract = input.taskContract;

  if (runner === undefined) {
    const report = await synthesizeReport({
      taskContract: contract,
      workerContext: input.workerContext,
      results: [],
      now,
      passedOverride: false
    });
    return {
      report,
      oracleAttribution: [],
      issues: [
        {
          code: "verification_runner_unavailable",
          message:
            "Per-task review pipeline received no verification runner; deterministic verification could not execute.",
          path: ["verification", "runner"]
        }
      ]
    };
  }

  const results: VerificationCommandResult[] = [];
  const issues: ReviewPipelineIssue[] = [];

  // The contract's own commands first, then the oracles', so an existing
  // report's indices keep meaning what they meant.
  const oracleAttribution: OracleAttribution[] = [];
  const commands: { readonly command: string; readonly args: readonly string[]; readonly expectedExitCode: number; readonly timeoutMs?: number; readonly label: string }[] = [
    ...contract.verification.map((entry) => ({
      command: entry.command,
      args: entry.args,
      expectedExitCode: entry.expectedExitCode,
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
      label: entry.command
    }))
  ];

  for (const oracle of input.options?.oracles ?? []) {
    // Narrowed on execution mode, not on `type`. A `hybrid` oracle may carry a
    // command, and gating on `type === "executable"` skipped every one of them —
    // producing neither a result nor an issue, which is the silent pass this
    // whole function exists to make impossible.
    if (oracle.type === "inspectable") continue;
    if (oracle.execution.mode !== "command") {
      // `runtime-driver` has no emitter and no executor. Saying so is the point:
      // silently skipping it would let an oracle that decides a criterion count
      // as satisfied because nothing tried to run it.
      issues.push({
        code: "oracle_not_evaluable",
        message: `Oracle ${oracle.id} declares execution mode "${oracle.execution.mode}", which no runner can execute. It was not evaluated.`,
        path: ["oracles", oracle.id]
      });
      continue;
    }
    oracleAttribution.push({ index: commands.length, oracleId: oracle.id, title: oracle.title });
    commands.push({
      command: oracle.execution.command,
      args: oracle.execution.args,
      expectedExitCode: oracle.execution.expectedExitCode,
      timeoutMs: oracle.execution.timeoutMs,
      label: `oracle ${oracle.id}`
    });
  }

  for (const [index, verification] of commands.entries()) {
    const request: VerificationCommandRequest = {
      index,
      command: verification.command,
      args: [...verification.args],
      expectedExitCode: verification.expectedExitCode,
      ...(verification.timeoutMs === undefined ? {} : { timeoutMs: verification.timeoutMs }),
      context: input.workerContext
    };
    const startedAt = now();
    const timeoutMs = verification.timeoutMs ?? defaultTimeout;
    const outcome = await safeInvoke(runner, request, timeoutMs, input.options?.timeout);
    const finishedAt = now();

    if (outcome.error !== undefined) {
      const timedOut = outcome.error instanceof VerificationCommandTimeoutError;
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      issues.push({
        code: "verification_command_failed",
        message: timedOut
          ? `Verification command ${index} (${verification.label}) timed out after ${timeoutMs}ms.`
          : `Verification command ${index} (${verification.label}) threw: ${message}`,
        path: ["verification", index]
      });
      results.push(emptyResultFor(request, startedAt, finishedAt, message, timedOut));
      continue;
    }

    const result = outcome.result;
    if (result === undefined) {
      issues.push({
        code: "verification_command_failed",
        message: `Verification command ${index} (${verification.label}) returned no result.`,
        path: ["verification", index]
      });
      results.push(emptyResultFor(request, startedAt, finishedAt, "runner returned no result"));
      continue;
    }

    if (result.timedOut || result.exitCode !== result.expectedExitCode) {
      issues.push({
        code: "verification_command_failed",
        message: `Verification command ${index} (${verification.label}) exited ${result.exitCode}, expected ${result.expectedExitCode}.`,
        path: ["verification", index]
      });
    }

    // Defensive: confirm the index returned matches the requested
    // index — runners could accidentally drop a command.
    if (result.index !== index) {
      issues.push({
        code: "verification_command_failed",
        message: `Verification command returned index ${result.index}, expected ${index}.`,
        path: ["verification", index, "index"]
      });
    }

    results.push(result);
  }

  const report = await synthesizeReport({
    taskContract: contract,
    workerContext: input.workerContext,
    results,
    now
  });

  return { report, issues, oracleAttribution };
}

async function synthesizeReport(input: {
  readonly taskContract: TaskContract;
  readonly workerContext: WorkerContext;
  readonly results: readonly VerificationCommandResult[];
  readonly now: () => UtcTimestamp;
  readonly passedOverride?: boolean;
}): Promise<VerificationReport> {
  const failing = recordFailingIndices(input.results);
  const passed = input.passedOverride ?? (failing.length === 0);
  const sha = deriveVerificationReportSha256({
    taskContractId: input.taskContract.id,
    contractRevision: input.taskContract.revision,
    workerContextHash: input.workerContext.workerContextHash,
    commands: input.results
  });

  const report: VerificationReport = {
    kind: "verification-report",
    schemaVersion: REVIEW_PIPELINE_SCHEMA_VERSION,
    taskContractId: input.taskContract.id,
    contractRevision: input.taskContract.revision,
    workerContextHash: input.workerContext.workerContextHash,
    commands: [...input.results],
    passed,
    failingIndices: failing,
    reportSha256: sha,
    createdAt: input.now()
  };
  return deepFreeze(report);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  const frozen = Object.freeze(value) as T;
  for (const key of Object.keys(value as object)) {
    const child = (value as unknown as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return frozen;
}
