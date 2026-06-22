/**
 * P08-T02 — Per-task review pipeline orchestrator.
 *
 * Wires three stages:
 *   1. `runDeterministicVerification` (review/verification.ts)
 *   2. `buildReviewRecord` (review/reviewer.ts)
 *   3. `evaluateAcceptanceGate` (review/gate.ts)
 *
 * Plus the top-level pipeline hash that ties them together and the
 * deterministic `createdAt` clock.
 *
 * Invariants (enforced here, in addition to per-stage invariants):
 *  - The pipeline never mutates the worker context — it consumes
 *    the frozen `WorkerContext` from P08-T01 unchanged.
 *  - The pipeline never imports a runtime driver, board persistence
 *    package, or reads node process environment. It is pure-function over the
 *    supplied inputs; the CLI and runtime driver wrap it.
 *  - The returned pipeline result is deeply frozen and carries the
 *    `reviewPipelineHash` plus `isolationTag` from the upstream
 *    `WorkerContext` so audit consumers can correlate the pipeline
 *    output with the worker context that produced it.
 *  - When ANY stage surfaces a blocking issue, the pipeline returns
 *    `{ ok: false }` with the partial results so callers can render
 *    or retry.
 */

import type { Actor, ContentHash, SchemaVersion, TaskContract, UtcTimestamp } from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import { evaluateAcceptanceGate } from "./gate.js";
import { deriveReviewPipelineHash } from "./hash.js";
import { buildReviewRecord } from "./reviewer.js";
import { runDeterministicVerification } from "./verification.js";
import {
  REVIEW_PIPELINE_KIND,
  REVIEW_PIPELINE_SCHEMA_VERSION,
  type AcceptanceDecision,
  type PerTaskReviewPipelineFailure,
  type PerTaskReviewPipelineInput,
  type PerTaskReviewPipelineResult,
  type PerTaskReviewPipelineSuccess,
  type ReviewPipelineIssue,
  type ReviewRecord,
  type VerificationReport
} from "./contract.js";
import type { PerTaskReviewPolicy } from "./contract.js";

const fixedClock = (): UtcTimestamp => "2026-06-22T02:00:00.000Z" as UtcTimestamp;

export class PerTaskReviewPipeline {
  private readonly now: () => UtcTimestamp;
  private readonly defaultPolicy: PerTaskReviewPolicy;

  constructor(options: {
    readonly now?: () => UtcTimestamp;
    readonly defaultPolicy?: PerTaskReviewPolicy;
  } = {}) {
    this.now = options.now ?? fixedClock;
    this.defaultPolicy = options.defaultPolicy ?? {
      gatesByTier: {
        R0: [],
        R1: ["deterministic_verification", "lightweight_independent_review", "evidence_bundle_or_log"],
        R2: ["deterministic_verification", "task_level_independent_review", "evidence_bundle_or_log", "task_contract"],
        R3: [
          "deterministic_verification",
          "task_level_independent_review",
          "evidence_bundle_or_log",
          "task_contract"
        ]
      },
      requireIndependentReview: { R0: false, R1: true, R2: true, R3: true }
    };
  }

  /**
   * Run the per-task review pipeline.
   *
   * Stages run sequentially:
   *  1. Verification — uses the injected runner. If absent, the
   *     pipeline returns `{ ok: false }` with a
   *     `verification_runner_unavailable` issue and a partial
   *     verification report (empty commands).
   *  2. Review — uses the injected `ReviewerInput`. If the input is
   *     missing, the gate evaluator records it as missing per tier
   *     policy; the pipeline still completes so the caller has a
   *     full decision.
   *  3. Acceptance gate — runs unconditionally so the decision is
   *     always present.
   *
   * The pipeline never throws; every failure is surfaced as a
   * typed `ReviewPipelineIssue` plus a non-ok `PerTaskReviewPipelineResult`.
   */
  async run(
    input: PerTaskReviewPipelineInput
  ): Promise<PerTaskReviewPipelineResult> {
    const policy = input.policy ?? this.defaultPolicy;
    const startedAt = this.now();

    // Stage 1: deterministic verification.
    const verificationOutcome = await runDeterministicVerification({
      taskContract: input.taskContract,
      workerContext: input.workerContext,
      options: {
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        now: this.now
      }
    });
    const verificationReport: VerificationReport | null = verificationOutcome.report;

    // Stage 2: independent review (optional, gated by tier).
    let reviewRecord: ReviewRecord | null = null;
    const reviewIssuesMutable: ReviewPipelineIssue[] = [];
    if (input.review !== undefined) {
      const built = buildReviewRecord({
        taskContractId: input.taskContract.id,
        contractRevision: input.taskContract.revision,
        workerContext: input.workerContext,
        implementer: input.implementer,
        reviewerInput: input.review
      });
      // Same-actor reviews are dropped to null (do not satisfy gate),
      // other validation issues propagate.
      const blockingCodes = new Set<string>([
        "reviewer_is_implementer",
        "review_evidence_missing",
        "review_verdict_inconsistent"
      ]);
      const blocking = built.issues.filter((issue) => blockingCodes.has(issue.code));
      if (blocking.length === 0) {
        reviewRecord = built.record;
      } else {
        for (const issue of blocking) {
          reviewIssuesMutable.push(issue);
        }
        // Surface the record anyway so audit consumers can see the
        // attempted-but-rejected review, but the record carries
        // `independent: false` is rejected by gate.ts.
        reviewRecord = built.record;
      }
    }
    const reviewIssues: readonly ReviewPipelineIssue[] = reviewIssuesMutable;

    // Stage 3: acceptance gate evaluator.
    const { decision, issues: gateIssues } = evaluateAcceptanceGate({
      taskContract: input.taskContract,
      workerContext: input.workerContext,
      verification: verificationReport,
      review: reviewRecord,
      policy,
      now: this.now
    });

    const reviewPipelineHash = deriveReviewPipelineHash({
      taskContractId: input.taskContract.id,
      contractRevision: input.taskContract.revision,
      workerContext: input.workerContext,
      verificationSha256: verificationReport?.reportSha256 ?? noContentHash(),
      reviewSha256: reviewRecord?.reviewHash ?? null,
      decisionSha256: decision.decisionSha256,
      schemaVersion: REVIEW_PIPELINE_SCHEMA_VERSION
    });

    const blockingIssues: readonly ReviewPipelineIssue[] = [
      ...verificationOutcome.issues,
      ...reviewIssues,
      ...gateIssues,
      ...collectGateIssues(decision, input.taskContract)
    ];

    const createdAt = startedAt;
    const base: Omit<PerTaskReviewPipelineSuccess, "ok"> = {
      schemaVersion: REVIEW_PIPELINE_SCHEMA_VERSION,
      kind: REVIEW_PIPELINE_KIND,
      taskContractId: input.taskContract.id,
      contractRevision: input.taskContract.revision,
      workerContextHash: input.workerContext.workerContextHash,
      isolationTag: input.workerContext.isolationTag,
      verification: verificationReport,
      review: reviewRecord,
      decision,
      reviewPipelineHash,
      createdAt
    };

    if (blockingIssues.length === 0) {
      return deepFreeze({ ...base, ok: true });
    }
    return deepFreeze({
      ...base,
      ok: false,
      issues: blockingIssues
    } satisfies PerTaskReviewPipelineFailure);
  }

  /**
   * Render a pipeline result as a single human-readable line. Used
   * by the CLI's `next review` subcommand.
   */
  render(result: PerTaskReviewPipelineResult): string {
    return (
      `per-task review pipeline: ` +
      `contract=${result.taskContractId}@${result.contractRevision} ` +
      `isolation=${result.isolationTag} ` +
      `outcome=${result.decision.outcome} ` +
      `tier=${result.decision.tier} ` +
      `pipelineHash=${result.reviewPipelineHash}`
    );
  }
}

function collectGateIssues(
  decision: AcceptanceDecision,
  taskContract: TaskContract
): readonly ReviewPipelineIssue[] {
  const issues: ReviewPipelineIssue[] = [];
  if (decision.outcome === "rejected") {
    for (const failing of decision.failingGates) {
      issues.push({
        code: "gate_not_satisfied",
        message: `Acceptance gate ${failing} is not satisfied for contract ${taskContract.id}@${taskContract.revision}.`,
        path: ["decision", "gates", failing]
      });
    }
  } else if (decision.outcome === "escalated") {
    issues.push({
      code: "gate_not_satisfied",
      message: `Acceptance gate escalated for contract ${taskContract.id}@${taskContract.revision}; tier ${decision.tier} requires external approval.`,
      path: ["decision", "escalation"]
    });
  }
  return issues;
}

function noContentHash(): ContentHash {
  return "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as unknown as ContentHash;
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

// ---------------------------------------------------------------------------
// Public renderers (used by CLI and evidence indexer)
// ---------------------------------------------------------------------------

export function renderReviewPipelineResult(result: PerTaskReviewPipelineResult): string {
  if (result.ok) {
    return `pipeline ok: contract=${result.taskContractId} outcome=${result.decision.outcome}`;
  }
  return (
    `pipeline blocked: contract=${result.taskContractId} ` +
    `issues=${result.issues.length} ` +
    `outcome=${result.decision.outcome}`
  );
}

export function summarizeReviewPipelineResults(
  results: readonly PerTaskReviewPipelineResult[]
): {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly escalated: number;
  readonly failed: number;
} {
  let accepted = 0;
  let rejected = 0;
  let escalated = 0;
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    if (result.decision.outcome === "accepted") accepted += 1;
    if (result.decision.outcome === "rejected") rejected += 1;
    if (result.decision.outcome === "escalated") escalated += 1;
  }
  return { total: results.length, accepted, rejected, escalated, failed };
}

// Sanity exports: touch types so verbatimModuleSyntax is happy.
export type { Actor, SchemaVersion };