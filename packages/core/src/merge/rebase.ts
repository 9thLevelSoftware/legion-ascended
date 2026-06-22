/**
 * P09-T01 — Rebase sequencer for ordered merge queue integration.
 *
 * The sequencer walks the queue one entry at a time and asks the
 * injected `RebaseRunner` to advance the merge head. The runner is
 * provider-neutral: the CLI adapter wraps the actual git/Eve call;
 * the sequencer only consumes the deterministic `RebaseCommandResult`
 * record shape.
 *
 * Sequencer invariants:
 *  1. A step is REBASED only when:
 *     - the entry is in `sequenceIndex` order,
 *     - the entry's `baseRef` matches the previous step's `headRef`,
 *     - the entry's `AcceptanceDecision.outcome` is `accepted`,
 *     - the conflict detector returned no conflicts for the entry,
 *     - the rebase runner returns `expectedExitCode` AND a non-empty
 *       `newHeadRef`.
 *  2. Otherwise the step is flagged with a deterministic outcome:
 *     - `conflict` if the conflict detector surfaced overlaps,
 *     - `rejected` if the per-task decision is `rejected`,
 *     - `escalated` if the per-task decision is `escalated`,
 *     - `conflict` if the rebase runner reports a non-zero exit code
 *       or empty `newHeadRef`,
 *     - `queued` if no rebase runner was supplied (the caller can
 *       decide to short-circuit or to wire one in later).
 *  3. The sequencer never advances past a `conflict`/`rejected`/
 *     `escalated` step; remaining entries inherit the previous
 *     `headRef` and inherit the blocking outcome.
 *  4. Each step carries a `stepSha256` audit hash; the snapshot
 *     carries the top-level `mergeQueueHash`.
 *
 * Why this lives in its own module:
 *  - Mirrors `review/pipeline.ts`: a thin orchestrator over
 *    specialized modules (conflict detector + rebase runner + gate).
 *  - Keeps the orchestrator focused on entry ordering; the
 *    sequencer owns the per-step state machine.
 */

import type { Actor, UtcTimestamp } from "@legion/protocol";

import type {
  ConflictReport,
  MergeQueueEntry,
  MergeQueueIssue,
  MergeQueueStep,
  MergeStepOutcome,
  RebaseCommandRequest,
  RebaseCommandResult,
  RebaseRunner
} from "./contract.js";

import { deriveStepSha256 } from "./hash.js";

import { detectPathConflicts } from "./conflict.js";

import type { PathOwnershipMap } from "./contract.js";

import { createHash } from "node:crypto";

import type { ContentHash } from "@legion/protocol";

/**
 * Compute a SHA-256 content hash with the `sha256:` prefix used
 * by the protocol package. This is a tiny inline helper so the
 * merge queue does NOT import from `../runtime/*` (the Phase 5
 * import boundary forbids non-runtime modules from depending on
 * runtime helpers).
 */
function sha256ContentHash(input: string): ContentHash {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}` as ContentHash;
}

/**
 * Deep-freeze a value before returning. Mirrors the
 * orchestrator's invariant: every output shape must be deeply frozen.
 */
function freezeStep(step: MergeQueueStep): MergeQueueStep {
  if (Object.isFrozen(step)) return step;
  for (const key of Object.keys(step)) {
    const value = (step as unknown as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
  Object.freeze(step);
  return step;
}

/**
 * The default clock used by the sequencer when no `now` is
 * injected. It matches the fixed clock used by `dispatch` and
 * `review` so cross-pipeline evidence remains comparable.
 */
function fixedClock(): UtcTimestamp {
  return "2026-06-22T03:00:00.000Z" as UtcTimestamp;
}

export interface SequencerStepInput {
  readonly entry: MergeQueueEntry;
  readonly headRefBefore: string;
  readonly expectedBaseRef: string;
  readonly conflicts: readonly ConflictReport[];
  readonly preIssues?: readonly MergeQueueIssue[];
  readonly rebaseRunner: RebaseRunner | undefined;
  readonly now: () => UtcTimestamp;
  readonly implementationActor: Actor;
  /**
   * Outcome of the previous step in the same walk. When the
   * previous step did not advance (queued / conflict / rejected /
   * escalated), the sequencer MUST NOT flag the current entry as
   * `entry_base_ref_mismatch` — the head ref has not moved, so the
   * base ref cannot drift from a forward step's perspective.
   */
  readonly previousOutcome: MergeStepOutcome | null;
}

export interface SequencerStepResult {
  readonly step: MergeQueueStep;
  readonly nextHeadRef: string;
  readonly blocked: boolean;
}

/**
 * Build a deterministic `RebaseCommandResult` for a successful
 * no-op rebase (the entry is "rebased" without a runner because the
 * caller chose to short-circuit). Useful for tests and for the
 * "queue only" path where the CLI has not yet wired a runner.
 */
export function buildIdentityRebaseResult(
  request: RebaseCommandRequest,
  now: () => UtcTimestamp
): RebaseCommandResult {
  const startedAt = now();
  const finishedAt = now();
  return {
    entrySequenceIndex: request.entrySequenceIndex,
    command: "merge-queue.identity",
    args: ["--sequence", String(request.entrySequenceIndex)],
    exitCode: 0,
    expectedExitCode: 0,
    stdoutSha256: sha256ContentHash(`identity-rebase:${request.entrySequenceIndex}:${request.headRef}`),
    stderrSha256: sha256ContentHash(""),
    combinedSha256: sha256ContentHash(`identity-rebase:${request.entrySequenceIndex}:${request.headRef}`),
    durationMs: 0,
    timedOut: false,
    startedAt,
    finishedAt,
    newHeadRef: request.targetRef
  };
}

/**
 * Advance one entry through the sequencer. The function is pure
 * (apart from the injected clock and the injected rebase runner) so
 * tests can pin every branch.
 */
export async function runSequencerStep(
  input: SequencerStepInput
): Promise<SequencerStepResult> {
  const { entry, headRefBefore, expectedBaseRef, conflicts, rebaseRunner, now } = input;

  const issues: MergeQueueIssue[] = [...(input.preIssues ?? [])];

  // Branch 1: base ref drifted. We only flag this when the previous
  // step actually advanced the head ref; otherwise the head has not
  // moved and the entry's `baseRef` cannot be out of sync with the
  // step chain.
  const previousAdvanced = input.previousOutcome === null || input.previousOutcome === "rebased";
  if (previousAdvanced && entry.baseRef !== expectedBaseRef) {
    issues.push({
      code: "entry_base_ref_mismatch",
      message: `Entry ${entry.sequenceIndex} baseRef ${entry.baseRef} does not match expected ${expectedBaseRef}.`,
      path: ["entry", "baseRef"],
      entrySequenceIndex: entry.sequenceIndex
    });
  }

  // Branch 2: per-task decision rejected.
  if (entry.decision.outcome === "rejected") {
    issues.push({
      code: "entry_decision_rejected",
      message: `Entry ${entry.sequenceIndex} per-task decision was rejected; merge queue must not integrate.`,
      path: ["entry", "decision", "outcome"],
      entrySequenceIndex: entry.sequenceIndex
    });
  }

  // Branch 3: per-task decision escalated.
  if (entry.decision.outcome === "escalated") {
    issues.push({
      code: "entry_decision_escalated",
      message: `Entry ${entry.sequenceIndex} per-task decision escalated; whole-change integration requires explicit approval.`,
      path: ["entry", "decision", "outcome"],
      entrySequenceIndex: entry.sequenceIndex
    });
  }

  // Branch 4: pre-detected conflicts.
  const hasConflicts = conflicts.length > 0;
  if (hasConflicts) {
    issues.push({
      code: "path_conflict_detected",
      message: `Entry ${entry.sequenceIndex} conflicts with ${conflicts.length} prior path claim(s).`,
      path: ["entry", "scope"],
      entrySequenceIndex: entry.sequenceIndex
    });
  }

  // Decide blocking outcome BEFORE invoking the runner so we never
  // touch git when we already know the step will fail.
  const blockedByBaseRef = issues.some((issue) => issue.code === "entry_base_ref_mismatch");
  const blockedByOrdering = issues.some(
    (issue) => issue.code === "entry_duplicate_sequence" || issue.code === "entry_out_of_order"
  );
  const blockedByDecision = entry.decision.outcome === "rejected" || entry.decision.outcome === "escalated";
  const blockedByConflict = hasConflicts;

  let outcome: MergeQueueStep["outcome"];
  let rebaseResult: RebaseCommandResult | null = null;

  if (blockedByDecision) {
    outcome = entry.decision.outcome === "escalated" ? "escalated" : "rejected";
  } else if (blockedByOrdering || blockedByConflict || blockedByBaseRef) {
    outcome = "conflict";
  } else if (rebaseRunner === undefined) {
    // No runner wired — record as `queued` so the orchestrator can
    // distinguish "not yet integrated" from "integrated". The head
    // ref does NOT advance.
    issues.push({
      code: "rebase_runner_unavailable",
      message: `No rebase runner wired for entry ${entry.sequenceIndex}; step is queued.`,
      path: ["rebaseRunner"],
      entrySequenceIndex: entry.sequenceIndex
    });
    outcome = "queued";
  } else {
    // Invoke the injected runner.
    const request: RebaseCommandRequest = {
      entrySequenceIndex: entry.sequenceIndex,
      baseRef: entry.baseRef,
      headRef: headRefBefore,
      targetRef: entry.targetRef,
      context: entry.workerContext
    };
    try {
      rebaseResult = await rebaseRunner(request);
    } catch (error) {
      issues.push({
        code: "rebase_command_failed",
        message: `Rebase runner threw for entry ${entry.sequenceIndex}: ${String((error as Error)?.message ?? error)}`,
        path: ["rebaseRunner"],
        entrySequenceIndex: entry.sequenceIndex
      });
      rebaseResult = null;
    }

    if (rebaseResult !== null) {
      if (rebaseResult.exitCode !== rebaseResult.expectedExitCode || rebaseResult.timedOut) {
        issues.push({
          code: "rebase_command_failed",
          message: `Rebase for entry ${entry.sequenceIndex} exited ${rebaseResult.exitCode} (expected ${rebaseResult.expectedExitCode}).`,
          path: ["rebaseRunner"],
          entrySequenceIndex: entry.sequenceIndex
        });
      }
      if (rebaseResult.newHeadRef === "" || rebaseResult.newHeadRef === headRefBefore) {
        issues.push({
          code: "rebase_head_drift",
          message: `Rebase for entry ${entry.sequenceIndex} did not advance the head ref.`,
          path: ["rebaseRunner", "newHeadRef"],
          entrySequenceIndex: entry.sequenceIndex
        });
      }
    }

    if (issues.some((issue) => issue.code === "rebase_command_failed" || issue.code === "rebase_head_drift")) {
      outcome = "conflict";
    } else if (rebaseResult !== null) {
      outcome = "rebased";
    } else {
      outcome = "conflict";
    }
  }

  const headRefAfter = outcome === "rebased" && rebaseResult !== null ? rebaseResult.newHeadRef : headRefBefore;
  const blocked = outcome !== "rebased" && outcome !== "queued";

  const stepOmitHash = {
    schemaVersion: "1.0.0" as MergeQueueStep["schemaVersion"],
    kind: "merge-queue-step" as const,
    sequenceIndex: entry.sequenceIndex,
    entryRef: entry.refs,
    outcome,
    headRefBefore,
    headRefAfter,
    conflicts: [...conflicts],
    rebase: rebaseResult,
    verification: entry.reviewResult.ok ? entry.reviewResult.verification : null,
    review: entry.reviewResult.ok ? entry.reviewResult.review : null,
    issues,
    createdAt: now()
  } satisfies Omit<MergeQueueStep, "stepSha256">;

  const stepSha256 = deriveStepSha256(stepOmitHash);

  const step: MergeQueueStep = freezeStep({
    ...stepOmitHash,
    stepSha256
  });

  return {
    step,
    nextHeadRef: headRefAfter,
    blocked
  };
}

/**
 * Walk the full ordered entry set, returning an immutable snapshot
 * of the merge queue after every step.
 *
 * The function:
 *  - sorts entries by `sequenceIndex`,
 *  - detects path conflicts once over the whole set,
 *  - applies each entry's conflict set to the per-step sequencer,
 *  - stops forwarding the head ref after the first blocked step,
 *  - returns the snapshot, the issue list, and the audit hash.
 */
export async function runSequencer(
  entries: readonly MergeQueueEntry[],
  ownership: PathOwnershipMap | undefined,
  rebaseRunner: RebaseRunner | undefined,
  now: () => UtcTimestamp,
  implementationActor: Actor,
  initialHeadRefOverride?: string
): Promise<{
  readonly steps: readonly MergeQueueStep[];
  readonly issues: readonly MergeQueueIssue[];
  readonly nextHeadRef: string;
  readonly initialHeadRef: string;
}> {
  // 1. Sequence ordering / dedup check.
  const orderingIssues: MergeQueueIssue[] = [];
  const indices = new Set<number>();
  let expected = 0;
  const sorted = [...entries].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (const entry of sorted) {
    if (indices.has(entry.sequenceIndex)) {
      orderingIssues.push({
        code: "entry_duplicate_sequence",
        message: `Duplicate sequence index ${entry.sequenceIndex} in merge queue input.`,
        path: ["entries", entry.sequenceIndex],
        entrySequenceIndex: entry.sequenceIndex
      });
    }
    indices.add(entry.sequenceIndex);
    if (entry.sequenceIndex !== expected) {
      orderingIssues.push({
        code: "entry_out_of_order",
        message: `Expected sequence index ${expected} but received ${entry.sequenceIndex}; ordering may be invalid.`,
        path: ["entries", entry.sequenceIndex],
        entrySequenceIndex: entry.sequenceIndex
      });
    }
    expected += 1;
  }

  // 2. Path conflict detection (single pass over the ordered entries).
  const allConflicts = detectPathConflicts(sorted, ownership);

  // 3. Walk each entry.
  const initialHeadRef = initialHeadRefOverride ?? sorted[0]?.baseRef ?? "HEAD";
  let headRef = initialHeadRef;
  const steps: MergeQueueStep[] = [];
  const allIssues: MergeQueueIssue[] = [...orderingIssues];
  let blocked = false;

  let previousOutcome: MergeStepOutcome | null = null;
  for (const entry of sorted) {
    const entryOrderingIssues = orderingIssues.filter((issue) => issue.entrySequenceIndex === entry.sequenceIndex);
    const entryConflicts = allConflicts.filter((conflict) =>
      conflict.conflictingEntrySequenceIndices.includes(entry.sequenceIndex)
    );
    const expectedBaseRef = headRef;
    const stepResult = await runSequencerStep({
      entry,
      headRefBefore: headRef,
      expectedBaseRef,
      conflicts: entryConflicts,
      preIssues: entryOrderingIssues,
      rebaseRunner: blocked || orderingIssues.length > 0 ? undefined : rebaseRunner,
      now,
      implementationActor,
      previousOutcome
    });

    for (const issue of stepResult.step.issues) {
      if (!orderingIssues.includes(issue)) allIssues.push(issue);
    }
    steps.push(stepResult.step);
    headRef = stepResult.nextHeadRef;
    previousOutcome = stepResult.step.outcome;

    if (stepResult.blocked) blocked = true;
  }

  return {
    steps,
    issues: allIssues,
    nextHeadRef: headRef,
    initialHeadRef
  };
}
