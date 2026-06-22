/**
 * P08-T02 — Deterministic hashing for per-task review pipeline outputs.
 *
 * Mirrors `dispatch/hash.ts` style: SHA-256 over a canonicalized
 * string built from sorted keys, so two pipelines run against the
 * same inputs produce identical hashes regardless of object key
 * order. Used for:
 *   - `verificationReportSha256`
 *   - `reviewHash`
 *   - `decisionSha256`
 *   - `reviewPipelineHash` (the top-level audit tag)
 */

import { createHash } from "node:crypto";

import type { ContentHash, SchemaVersion } from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import type {
  AcceptanceDecision,
  GateEvaluation,
  ReviewerFinding,
  ReviewerInput,
  ReviewerVerdicts,
  ReviewRecord,
  VerificationCommandResult,
  VerificationReport
} from "./contract.js";

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

export function contentHash(input: string): ContentHash {
  return `sha256:${hexSha256(input)}` as unknown as ContentHash;
}

// ---------------------------------------------------------------------------
// Verification report hash
// ---------------------------------------------------------------------------

export function deriveVerificationReportSha256(
  report: Pick<
    VerificationReport,
    "taskContractId" | "contractRevision" | "workerContextHash" | "commands"
  >
): ContentHash {
  return contentHash(
    canonical({
      kind: "verification-report",
      taskContractId: report.taskContractId,
      contractRevision: report.contractRevision,
      workerContextHash: report.workerContextHash,
      commands: report.commands.map((command) => ({
        index: command.index,
        command: command.command,
        args: command.args,
        exitCode: command.exitCode,
        expectedExitCode: command.expectedExitCode,
        stdoutSha256: command.stdoutSha256,
        stderrSha256: command.stderrSha256,
        combinedSha256: command.combinedSha256,
        durationMs: command.durationMs,
        timedOut: command.timedOut,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
        ...(command.notes === undefined ? {} : { notes: command.notes })
      }))
    })
  );
}

// ---------------------------------------------------------------------------
// Review hash
// ---------------------------------------------------------------------------

export function deriveReviewRecordHash(
  record: Pick<
    ReviewRecord,
    | "taskContractId"
    | "contractRevision"
    | "workerContextHash"
    | "reviewer"
    | "implementer"
    | "verdicts"
    | "confidence"
    | "summary"
    | "submittedAt"
  > & { readonly findings: readonly ReviewerFinding[] }
): ContentHash {
  return contentHash(
    canonical({
      kind: "review-record",
      taskContractId: record.taskContractId,
      contractRevision: record.contractRevision,
      workerContextHash: record.workerContextHash,
      reviewer: record.reviewer,
      implementer: record.implementer,
      verdicts: canonicalizeVerdicts(record.verdicts),
      confidence: record.confidence,
      summary: record.summary,
      findings: record.findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        body: finding.body,
        severity: finding.severity,
        ...(finding.evidenceRefs === undefined
          ? {}
          : { evidenceRefs: [...finding.evidenceRefs].sort() })
      })),
      submittedAt: record.submittedAt
    })
  );
}

function canonicalizeVerdicts(verdicts: ReviewerVerdicts): ReviewerVerdicts {
  return {
    specification: verdicts.specification,
    integration: verdicts.integration,
    evidence: verdicts.evidence
  };
}

// ---------------------------------------------------------------------------
// Decision hash
// ---------------------------------------------------------------------------

export function deriveAcceptanceDecisionSha256(
  decision: Pick<
    AcceptanceDecision,
    "taskContractId" | "contractRevision" | "workerContextHash" | "tier" | "outcome" | "rationale"
  > & { readonly gates: readonly GateEvaluation[] }
): ContentHash {
  return contentHash(
    canonical({
      kind: "acceptance-decision",
      taskContractId: decision.taskContractId,
      contractRevision: decision.contractRevision,
      workerContextHash: decision.workerContextHash,
      tier: decision.tier,
      outcome: decision.outcome,
      rationale: decision.rationale,
      gates: decision.gates.map((gate) => ({
        gate: gate.gate,
        state: gate.state,
        reason: gate.reason,
        source: gate.source,
        ...(gate.tier === undefined ? {} : { tier: gate.tier })
      }))
    })
  );
}

// ---------------------------------------------------------------------------
// Pipeline-level hash
// ---------------------------------------------------------------------------

export interface ReviewPipelineHashInput {
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContext: WorkerContext;
  readonly verificationSha256: ContentHash;
  readonly reviewSha256: ContentHash | null;
  readonly decisionSha256: ContentHash;
  readonly schemaVersion: SchemaVersion;
}

export function deriveReviewPipelineHash(input: ReviewPipelineHashInput): ContentHash {
  return contentHash(
    canonical({
      kind: "task-review-pipeline",
      schemaVersion: input.schemaVersion,
      taskContractId: input.taskContractId,
      contractRevision: input.contractRevision,
      workerContextHash: input.workerContext.workerContextHash,
      isolationTag: input.workerContext.isolationTag,
      verificationSha256: input.verificationSha256,
      reviewSha256: input.reviewSha256,
      decisionSha256: input.decisionSha256
    })
  );
}

// ---------------------------------------------------------------------------
// Verification command result hash
// ---------------------------------------------------------------------------

export function deriveVerificationCommandSha256(
  result: Pick<
    VerificationCommandResult,
    | "command"
    | "args"
    | "exitCode"
    | "expectedExitCode"
    | "stdoutSha256"
    | "stderrSha256"
    | "combinedSha256"
    | "durationMs"
    | "timedOut"
  >
): ContentHash {
  return contentHash(
    canonical({
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      expectedExitCode: result.expectedExitCode,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      combinedSha256: result.combinedSha256,
      durationMs: result.durationMs,
      timedOut: result.timedOut
    })
  );
}

// ---------------------------------------------------------------------------
// Reviewer input canonicalization (used by tests and CLI rendering)
// ---------------------------------------------------------------------------

export function canonicalizeReviewerInput(input: ReviewerInput): ReviewerInput {
  return {
    reviewer: input.reviewer,
    verdicts: canonicalizeVerdicts(input.verdicts),
    findings: input.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      body: finding.body,
      severity: finding.severity,
      ...(finding.evidenceRefs === undefined
        ? {}
        : { evidenceRefs: [...finding.evidenceRefs].sort() })
    })),
    confidence: input.confidence,
    submittedAt: input.submittedAt,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.note === undefined ? {} : { note: input.note })
  };
}