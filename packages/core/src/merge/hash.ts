/**
 * P09-T01 — Deterministic hashing for merge queue outputs.
 *
 * Mirrors `dispatch/hash.ts` and `review/hash.ts`: SHA-256 over a
 * canonicalized string built from sorted keys, so two orchestrator
 * runs against the same entry set, ownership map, and rebase
 * outcomes produce identical hashes regardless of object key order.
 *
 * Used for:
 *  - `stepSha256` per queue step (audit-by-grep entry hashes)
 *  - `mergeQueueHash` (top-level audit tag, ties snapshot + decision)
 *  - `decisionSha256` on the whole-change integration decision
 */

import { createHash } from "node:crypto";

import type { ContentHash, SchemaVersion, UtcTimestamp } from "@legion/protocol";

import type {
  ConflictReport,
  MergeIntegrationDecision,
  MergeQueueEntry,
  MergeQueueEntryRefs,
  MergeQueueIssue,
  MergeQueueSnapshot,
  MergeQueueStep,
  RebaseCommandResult
} from "./contract.js";

import type {
  AcceptanceDecision,
  ReviewRecord,
  VerificationReport
} from "../review/contract.js";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
      .join(",") +
    "}"
  );
}

function hexSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function contentHash(input: string): ContentHash {
  return `sha256:${hexSha256(input)}` as unknown as ContentHash;
}

// ---------------------------------------------------------------------------
// Entry references (audit handles)
// ---------------------------------------------------------------------------

function serializeRefs(refs: MergeQueueEntryRefs): unknown {
  return {
    workerContextHash: refs.workerContextHash,
    isolationTag: refs.isolationTag,
    reviewPipelineHash: refs.reviewPipelineHash,
    verificationReportSha256: refs.verificationReportSha256,
    reviewHash: refs.reviewHash,
    decisionSha256: refs.decisionSha256,
    taskContractId: refs.taskContractId,
    contractRevision: refs.contractRevision
  };
}

// ---------------------------------------------------------------------------
// Step hash — stable per sequenced entry
// ---------------------------------------------------------------------------

function serializeConflict(conflict: ConflictReport): unknown {
  return {
    path: conflict.path,
    conflictingEntrySequenceIndices: [...conflict.conflictingEntrySequenceIndices].sort((a, b) => a - b),
    reason: conflict.reason
  };
}

function serializeRebase(rebase: RebaseCommandResult | null): unknown {
  if (rebase === null) return null;
  return {
    entrySequenceIndex: rebase.entrySequenceIndex,
    command: rebase.command,
    args: rebase.args,
    exitCode: rebase.exitCode,
    expectedExitCode: rebase.expectedExitCode,
    stdoutSha256: rebase.stdoutSha256,
    stderrSha256: rebase.stderrSha256,
    combinedSha256: rebase.combinedSha256,
    durationMs: rebase.durationMs,
    timedOut: rebase.timedOut,
    startedAt: rebase.startedAt,
    finishedAt: rebase.finishedAt,
    newHeadRef: rebase.newHeadRef,
    ...(rebase.notes === undefined ? {} : { notes: rebase.notes })
  };
}

function serializeIssues(issues: readonly MergeQueueIssue[]): unknown {
  return issues
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: [...issue.path],
      ...(issue.entrySequenceIndex === undefined
        ? {}
        : { entrySequenceIndex: issue.entrySequenceIndex })
    }))
    .sort((a, b) => {
      const seqA = (a as { entrySequenceIndex?: number }).entrySequenceIndex ?? -1;
      const seqB = (b as { entrySequenceIndex?: number }).entrySequenceIndex ?? -1;
      if (seqA !== seqB) return seqA - seqB;
      return String(a.code).localeCompare(String(b.code));
    });
}

function serializeVerification(report: VerificationReport | null): unknown {
  if (report === null) return null;
  return {
    kind: report.kind,
    schemaVersion: report.schemaVersion,
    taskContractId: report.taskContractId,
    contractRevision: report.contractRevision,
    workerContextHash: report.workerContextHash,
    passed: report.passed,
    failingIndices: [...report.failingIndices],
    reportSha256: report.reportSha256,
    createdAt: report.createdAt
  };
}

function serializeReview(review: ReviewRecord | null): unknown {
  if (review === null) return null;
  return {
    kind: review.kind,
    schemaVersion: review.schemaVersion,
    taskContractId: review.taskContractId,
    contractRevision: review.contractRevision,
    workerContextHash: review.workerContextHash,
    reviewer: review.reviewer,
    implementer: review.implementer,
    independent: review.independent,
    reviewHash: review.reviewHash,
    createdAt: review.createdAt,
    submittedAt: review.submittedAt
  };
}

export function deriveStepSha256(step: Omit<MergeQueueStep, "stepSha256">): ContentHash {
  return contentHash(
    canonical({
      kind: "merge-queue-step",
      schemaVersion: step.schemaVersion,
      sequenceIndex: step.sequenceIndex,
      entryRef: serializeRefs(step.entryRef),
      outcome: step.outcome,
      headRefBefore: step.headRefBefore,
      headRefAfter: step.headRefAfter,
      conflicts: step.conflicts.map(serializeConflict),
      rebase: serializeRebase(step.rebase),
      verification: serializeVerification(step.verification),
      review: serializeReview(step.review),
      issues: serializeIssues(step.issues)
    })
  );
}

// ---------------------------------------------------------------------------
// Snapshot hash — top-level audit tag
// ---------------------------------------------------------------------------

export function deriveMergeQueueSnapshotHash(
  snapshot: Omit<MergeQueueSnapshot, "mergeQueueHash">
): ContentHash {
  return contentHash(
    canonical({
      kind: "merge-queue-snapshot",
      schemaVersion: snapshot.schemaVersion,
      sequenceLength: snapshot.sequenceLength,
      orderedSequenceIndices: [...snapshot.orderedSequenceIndices],
      steps: snapshot.steps.map((step) => ({
        sequenceIndex: step.sequenceIndex,
        outcome: step.outcome,
        stepSha256: step.stepSha256,
        headRefAfter: step.headRefAfter
      }))
    })
  );
}

// ---------------------------------------------------------------------------
// Whole-change integration decision hash
// ---------------------------------------------------------------------------

function serializeAcceptanceDecision(decision: AcceptanceDecision): unknown {
  return {
    kind: decision.kind,
    schemaVersion: decision.schemaVersion,
    taskContractId: decision.taskContractId,
    contractRevision: decision.contractRevision,
    workerContextHash: decision.workerContextHash,
    tier: decision.tier,
    outcome: decision.outcome,
    decisionSha256: decision.decisionSha256,
    createdAt: decision.createdAt,
    rationale: decision.rationale
  };
}

export function deriveMergeIntegrationDecisionSha256(
  decision: Omit<MergeIntegrationDecision, "decisionSha256">
): ContentHash {
  return contentHash(
    canonical({
      kind: "merge-integration-decision",
      schemaVersion: decision.schemaVersion,
      mergeQueueHash: decision.mergeQueueHash,
      finalHeadRef: decision.finalHeadRef,
      outcome: decision.outcome,
      acceptedEntries: [...decision.acceptedEntries].sort((a, b) => a - b),
      rejectedEntries: [...decision.rejectedEntries].sort((a, b) => a - b),
      escalatedEntries: [...decision.escalatedEntries].sort((a, b) => a - b),
      conflictEntries: [...decision.conflictEntries].sort((a, b) => a - b),
      rationale: decision.rationale
    })
  );
}

// ---------------------------------------------------------------------------
// Entry ordering hash — proves the queue is sorted + deduped
// ---------------------------------------------------------------------------

export function deriveEntryOrderingHash(entries: readonly MergeQueueEntry[]): ContentHash {
  return contentHash(
    canonical({
      kind: "merge-queue-entry-ordering",
      sequenceLength: entries.length,
      indices: entries.map((entry) => ({
        sequenceIndex: entry.sequenceIndex,
        taskContractId: entry.refs.taskContractId,
        contractRevision: entry.refs.contractRevision,
        decision: serializeAcceptanceDecision(entry.decision),
        baseRef: entry.baseRef,
        headRef: entry.headRef,
        targetRef: entry.targetRef,
        workerContextHash: entry.refs.workerContextHash,
        decisionSha256: entry.refs.decisionSha256
      }))
    })
  );
}

// ---------------------------------------------------------------------------
// Public utility — content hash from any frozen value (used by tests)
// ---------------------------------------------------------------------------

export function sha256OfCanonical(value: unknown): ContentHash {
  return contentHash(canonical(value));
}

// ---------------------------------------------------------------------------
// Versioning — explicitly exported so consumers can audit the
// canonical-string contract without scraping the file.
// ---------------------------------------------------------------------------

export const MERGE_QUEUE_HASH_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;

// ---------------------------------------------------------------------------
// Schema-doc style tag for evidence dumps.
// ---------------------------------------------------------------------------

export interface MergeQueueHashReceipt {
  readonly mergeQueueHash: ContentHash;
  readonly snapshotHash: ContentHash;
  readonly stepHashes: readonly { readonly sequenceIndex: number; readonly stepSha256: ContentHash }[];
  readonly decisionSha256: ContentHash;
  readonly generatedAt: UtcTimestamp;
}

export function buildHashReceipt(
  snapshot: MergeQueueSnapshot,
  decision: MergeIntegrationDecision,
  now: () => UtcTimestamp
): MergeQueueHashReceipt {
  return {
    mergeQueueHash: snapshot.mergeQueueHash,
    snapshotHash: snapshot.mergeQueueHash,
    stepHashes: snapshot.steps.map((step) => ({
      sequenceIndex: step.sequenceIndex,
      stepSha256: step.stepSha256
    })),
    decisionSha256: decision.decisionSha256,
    generatedAt: now()
  };
}
