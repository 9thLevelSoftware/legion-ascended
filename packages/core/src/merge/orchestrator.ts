/**
 * P09-T01 — Merge queue orchestrator.
 *
 * The orchestrator is the public surface that ties together:
 *  1. Entry ordering + dedup check,
 *  2. Path conflict detection (deterministic, path-based),
 *  3. Rebase sequencer (per-step state machine with injected runner),
 *  4. Whole-change integration gate (fail-closed aggregation),
 *  5. Board blocker projection (provider-neutral rendering),
 *  6. Deterministic audit hashing (snapshot + decision + per-step).
 *
 * Provider neutrality:
 *  - No imports of git, runtime drivers, or board persistence.
 *  - The rebase runner is injected; CLI adapters wrap git/Eve.
 *  - The path ownership map is injected; CLI adapters can back it
 *    with filesystem scans.
 *
 * Output shape:
 *  - `{ ok: true, snapshot, decision, blockers, issues,
 *     mergeQueueHash }` when the queue integrates (possibly with
 *     informational issues).
 *  - `{ ok: false, snapshot, decision, blockers, issues,
 *     mergeQueueHash }` when the whole-change integration is
 *     rejected, escalated, or blocked. The snapshot and decision are
 *     still populated so audit consumers can render a full report.
 */

import type { Actor, ContentHash, SchemaVersion, UtcTimestamp } from "@legion/protocol";

import type {
  MergeIntegrationDecision,
  MergeQueueBoardBlocker,
  MergeQueueEntry,
  MergeQueueEntryRefs,
  MergeQueueIssue,
  MergeQueueOrchestratorFailure,
  MergeQueueOrchestratorInput,
  MergeQueueOrchestratorResult,
  MergeQueueOrchestratorSuccess,
  MergeQueueSnapshot,
  MergeQueueStep
} from "./contract.js";

import { deriveMergeQueueSnapshotHash, deriveStepSha256 } from "./hash.js";

import { runSequencer } from "./rebase.js";

import { evaluateMergeIntegration } from "./gate.js";

const DEFAULT_REPORTER = "merge-queue-orchestrator";
const fixedClock = (): UtcTimestamp => "2026-06-22T03:00:00.000Z" as UtcTimestamp;

/**
 * Build the `MergeQueueEntryRefs` handle from a frozen entry. This
 * is exposed separately so the CLI can build refs while staging
 * entries, before invoking the orchestrator.
 */
export function buildEntryRefs(entry: MergeQueueEntry): MergeQueueEntryRefs {
  const verification = entry.reviewResult.ok ? entry.reviewResult.verification : null;
  const review = entry.reviewResult.ok ? entry.reviewResult.review : null;
  return {
    workerContextHash: entry.refs.workerContextHash,
    isolationTag: entry.refs.isolationTag,
    reviewPipelineHash: entry.reviewResult.ok
      ? entry.reviewResult.reviewPipelineHash
      : entry.refs.reviewPipelineHash,
    verificationReportSha256: verification?.reportSha256 ?? entry.refs.verificationReportSha256,
    reviewHash: review?.reviewHash ?? entry.refs.reviewHash,
    decisionSha256: entry.decision.decisionSha256,
    taskContractId: entry.refs.taskContractId,
    contractRevision: entry.refs.contractRevision
  };
}

/**
 * Render a structured merge queue issue into a board blocker shape.
 * Mirrors `dispatch/blocker.ts` formatting conventions.
 */
export function renderMergeQueueIssueReason(issue: MergeQueueIssue): string {
  const seqText = issue.entrySequenceIndex === undefined
    ? ""
    : ` entry=${issue.entrySequenceIndex}`;
  const pathText = issue.path.length === 0 ? "<root>" : issue.path.join(".");
  return `code=${issue.code}${seqText} path=${pathText} :: ${issue.message}`;
}

export function mapMergeQueueIssueToBoardBlocker(
  issue: MergeQueueIssue,
  options: { readonly reporter?: string; readonly now?: () => UtcTimestamp } = {}
): MergeQueueBoardBlocker {
  return {
    reason: renderMergeQueueIssueReason(issue),
    reportedBy: options.reporter ?? DEFAULT_REPORTER,
    reportedAt: (options.now ?? fixedClock)(),
    code: issue.code,
    path: issue.path,
    ...(issue.entrySequenceIndex === undefined ? {} : { entrySequenceIndex: issue.entrySequenceIndex })
  };
}

export function mapMergeQueueIssuesToBoardBlockers(
  issues: readonly MergeQueueIssue[],
  options: { readonly reporter?: string; readonly now?: () => UtcTimestamp } = {}
): readonly MergeQueueBoardBlocker[] {
  const now = options.now ?? fixedClock;
  const reporter = options.reporter ?? DEFAULT_REPORTER;
  return issues.map((issue) => ({
    reason: renderMergeQueueIssueReason(issue),
    reportedBy: reporter,
    reportedAt: now(),
    code: issue.code,
    path: issue.path,
    ...(issue.entrySequenceIndex === undefined ? {} : { entrySequenceIndex: issue.entrySequenceIndex })
  }));
}

/**
 * Recursively deep-freeze a value. Used for snapshot/decision
 * outputs to enforce immutability (matching P08 invariants).
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const property of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[property]);
  }
  return value;
}

/**
 * Build the frozen snapshot from a list of steps.
 */
export function buildSnapshot(
  steps: readonly MergeQueueStep[],
  now: () => UtcTimestamp
): MergeQueueSnapshot {
  const orderedIndices = [...steps].map((step) => step.sequenceIndex).sort((a, b) => a - b);
  const snapshotOmitHash = {
    schemaVersion: "1.0.0" as SchemaVersion,
    kind: "merge-queue" as const,
    sequenceLength: steps.length,
    steps: [...steps],
    orderedSequenceIndices: orderedIndices,
    createdAt: now()
  } satisfies Omit<MergeQueueSnapshot, "mergeQueueHash">;

  const mergeQueueHash = deriveMergeQueueSnapshotHash(snapshotOmitHash);
  return deepFreeze({
    ...snapshotOmitHash,
    mergeQueueHash
  });
}

/**
 * The `MergeQueueOrchestrator` class. Pure: holds only an injected
 * clock + the call-supplied inputs.
 */
export class MergeQueueOrchestrator {
  private readonly now: () => UtcTimestamp;
  private readonly implementationActor: Actor;

  constructor(options: { readonly now?: () => UtcTimestamp; readonly implementationActor?: Actor } = {}) {
    this.now = options.now ?? fixedClock;
    this.implementationActor = options.implementationActor ?? {
      kind: "worker",
      id: "merge-queue-orchestrator",
      displayName: "Merge Queue Orchestrator"
    };
  }

  async run(input: MergeQueueOrchestratorInput): Promise<MergeQueueOrchestratorResult> {
    const reporter = input.reporter ?? DEFAULT_REPORTER;

    // 1. Sort entries by sequenceIndex for the sequencer. The
    // sequencer itself re-checks ordering and dedupes duplicates.
    const sortedEntries = [...input.entries].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    // 2. Sequencer → ordered steps + per-step outcomes + issues.
    const sequencerOutcome = await runSequencer(
      sortedEntries,
      input.ownership,
      input.rebaseRunner,
      input.now ?? this.now,
      this.implementationActor
    );

    // 3. Snapshot.
    const snapshot = buildSnapshot(sequencerOutcome.steps, input.now ?? this.now);

    // 4. Whole-change integration decision.
    const gateResult = evaluateMergeIntegration({
      snapshot,
      mergeQueueHash: snapshot.mergeQueueHash,
      now: input.now ?? this.now
    });

    // 5. Combine issues: sequencer + gate.
    const issues: readonly MergeQueueIssue[] = [...sequencerOutcome.issues, ...gateResult.issues];

    // 6. Render board blockers.
    const blockers = mapMergeQueueIssuesToBoardBlockers(issues, {
      reporter,
      now: input.now ?? this.now
    });

    // 7. Branch on whole-change outcome. We still return a frozen
    // snapshot + decision on the failure path so audit consumers
    // can render a complete report.
    if (gateResult.decision.outcome === "integrated") {
      const success: MergeQueueOrchestratorSuccess = deepFreeze({
        ok: true,
        schemaVersion: "1.0.0" as SchemaVersion,
        kind: "merge-queue" as const,
        snapshot,
        decision: gateResult.decision,
        blockers,
        issues,
        mergeQueueHash: snapshot.mergeQueueHash,
        createdAt: input.now ? input.now() : this.now()
      });
      return success;
    }

    const failure: MergeQueueOrchestratorFailure = deepFreeze({
      ok: false,
      schemaVersion: "1.0.0" as SchemaVersion,
      kind: "merge-queue" as const,
      snapshot,
      decision: gateResult.decision,
      blockers,
      issues,
      mergeQueueHash: snapshot.mergeQueueHash,
      createdAt: input.now ? input.now() : this.now()
    });
    return failure;
  }
}

/**
 * Helper for the CLI / dashboard: summarize an orchestrator result
 * into a one-line overview. Mirrors `summarizeReviewPipelineResults`
 * from `review/pipeline.ts`.
 */
export function summarizeMergeQueueResult(
  result: MergeQueueOrchestratorResult
): string {
  const outcome = result.decision?.outcome ?? "unknown";
  const length = result.snapshot?.sequenceLength ?? 0;
  const hash = result.mergeQueueHash ?? "no-hash";
  return `merge-queue ${result.ok ? "ok" : "fail"} outcome=${outcome} entries=${length} hash=${hash}`;
}

// Re-export the step hash helper so the CLI can compute hashes
// without importing the internal hash module twice.
export { deriveStepSha256 };
