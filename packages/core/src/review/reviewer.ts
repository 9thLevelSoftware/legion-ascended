/**
 * P08-T02 — Independent task-review surface.
 *
 * Goal (per ADR-006):
 *  - Reviewer independence: the reviewer actor MUST differ from the
 *    implementer actor. Same-actor reviews are rejected.
 *  - Tier-required review: R1 requires `lightweight_independent_review`,
 *    R2 requires `task_level_independent_review`. The pipeline emits
 *    `review_required_for_tier` when the caller's policy expects a
 *    review but the input omits one.
 *  - Verdict consistency: a passing review with blocking findings is
 *    rejected with `review_verdict_inconsistent`; a failing review
 *    with no blocking findings is permitted (the reviewer may fail
 *    for integration/evidence reasons alone).
 *  - Evidence anchoring: blocking findings MUST reference at least
 *    one evidence id; missing-anchor findings are rejected with
 *    `review_evidence_missing`.
 *
 * Output: a deeply-frozen `ReviewRecord` whose `independent` flag is
 * always `true` for accepted records (a same-actor record never
 * reaches this shape).
 */

import type { Actor, ContentHash, UtcTimestamp } from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

import { deriveReviewRecordHash } from "./hash.js";
import type {
  ReviewPipelineIssue,
  ReviewRecord,
  ReviewerFinding,
  ReviewerInput,
  ReviewerVerdicts
} from "./contract.js";
import { REVIEW_PIPELINE_SCHEMA_VERSION } from "./contract.js";

const REVIEWER_ID_BLOCKLIST = new Set<string>([
  // Future-proofing: when the v9 review system defines reserved
  // reviewer roles they go here. Today this is empty — the only
  // gate is implementer-vs-reviewer identity.
]);

const fixedClock = (): UtcTimestamp => "2026-06-22T02:00:00.000Z" as UtcTimestamp;

export interface BuildReviewRecordOptions {
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContext: WorkerContext;
  readonly implementer: Actor;
  readonly reviewerInput: ReviewerInput;
  readonly now?: () => UtcTimestamp;
}

/**
 * Build a normalized, frozen `ReviewRecord` from raw reviewer
 * input. Returns `{ record, issues }` — even a successfully built
 * record may surface `minor` issues (e.g. informational warnings)
 * but the orchestrator only routes blocking issues into the
 * pipeline failure shape.
 */
export function buildReviewRecord(
  input: BuildReviewRecordOptions
): { readonly record: ReviewRecord; readonly issues: readonly ReviewPipelineIssue[] } {
  const now = input.now ?? fixedClock;
  const issues: ReviewPipelineIssue[] = [];
  const review = input.reviewerInput;

  if (!isValidActor(review.reviewer)) {
    issues.push({
      code: "reviewer_is_implementer",
      message: "Review record received a malformed reviewer actor.",
      path: ["review", "reviewer"]
    });
  }

  if (sameActor(review.reviewer, input.implementer)) {
    issues.push({
      code: "reviewer_is_implementer",
      message: `Reviewer ${review.reviewer.id} is the same actor as the implementer; independent review cannot proceed.`,
      path: ["review", "reviewer"]
    });
  }

  if (REVIEWER_ID_BLOCKLIST.has(review.reviewer.id)) {
    issues.push({
      code: "reviewer_is_implementer",
      message: `Reviewer ${review.reviewer.id} is reserved and cannot author independent reviews.`,
      path: ["review", "reviewer"]
    });
  }

  const verdicts = review.verdicts;
  const findingIssues = validateFindings(review.findings);
  for (const issue of findingIssues) {
    issues.push(issue);
  }

  const verdictIssues = validateVerdictConsistency(verdicts, review.findings);
  for (const issue of verdictIssues) {
    issues.push(issue);
  }

  const summary = review.summary ?? deriveSummaryFromFindings(review.findings);

  const hash = deriveReviewRecordHash({
    taskContractId: input.taskContractId,
    contractRevision: input.contractRevision,
    workerContextHash: input.workerContext.workerContextHash,
    reviewer: review.reviewer,
    implementer: input.implementer,
    verdicts,
    confidence: review.confidence,
    summary,
    findings: review.findings,
    submittedAt: review.submittedAt
  });

  // The record is `independent: false` whenever the reviewer is the
  // implementer, the reviewer actor is malformed, or the reviewer
  // id is on the reserved blocklist. The hash covers `independent`
  // implicitly via the reviewer/implementer pair; the explicit flag
  // is a downstream-friendly audit signal.
  const independent = !sameActor(review.reviewer, input.implementer) && isValidActor(review.reviewer) && !REVIEWER_ID_BLOCKLIST.has(review.reviewer.id);

  const record: ReviewRecord = {
    kind: "review-record",
    schemaVersion: REVIEW_PIPELINE_SCHEMA_VERSION,
    taskContractId: input.taskContractId,
    contractRevision: input.contractRevision,
    workerContextHash: input.workerContext.workerContextHash,
    reviewer: review.reviewer,
    implementer: input.implementer,
    verdicts,
    findings: review.findings.map(cloneFinding),
    confidence: review.confidence,
    summary,
    independent,
    reviewHash: hash,
    createdAt: now(),
    submittedAt: review.submittedAt
  };

  return { record: deepFreeze(record), issues };
}

function isValidActor(actor: Actor): boolean {
  return (
    typeof actor.id === "string" &&
    actor.id.length > 0 &&
    (actor.kind === "human" || actor.kind === "worker" || actor.kind === "system")
  );
}

function sameActor(left: Actor, right: Actor): boolean {
  return left.id === right.id && left.kind === right.kind;
}

function validateFindings(findings: readonly ReviewerFinding[]): readonly ReviewPipelineIssue[] {
  const issues: ReviewPipelineIssue[] = [];
  for (const [index, finding] of findings.entries()) {
    if (finding.severity === "blocking" && (finding.evidenceRefs === undefined || finding.evidenceRefs.length === 0)) {
      issues.push({
        code: "review_evidence_missing",
        message: `Blocking finding "${finding.id}" must reference at least one evidence id.`,
        path: ["review", "findings", index, "evidenceRefs"]
      });
    }
  }
  return issues;
}

function validateVerdictConsistency(
  verdicts: ReviewerVerdicts,
  findings: readonly ReviewerFinding[]
): readonly ReviewPipelineIssue[] {
  if (verdicts.specification === "pass" && verdicts.integration === "pass" && verdicts.evidence === "pass") {
    const hasBlocking = findings.some((finding) => finding.severity === "blocking");
    if (hasBlocking) {
      return [
        {
          code: "review_verdict_inconsistent",
          message: "Reviewer returned pass on all three legs but included blocking findings.",
          path: ["review", "verdicts"]
        }
      ];
    }
  }
  return [];
}

function deriveSummaryFromFindings(findings: readonly ReviewerFinding[]): string {
  if (findings.length === 0) return "Independent review completed with no findings.";
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  const major = findings.filter((finding) => finding.severity === "major").length;
  const minor = findings.filter((finding) => finding.severity === "minor").length;
  return `Independent review: ${blocking} blocking, ${major} major, ${minor} minor finding(s).`;
}

function cloneFinding(finding: ReviewerFinding): ReviewerFinding {
  return {
    id: finding.id,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    ...(finding.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: [...finding.evidenceRefs] })
  };
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

/**
 * Render a `ReviewRecord` as a single human-readable line. Used by
 * the CLI's `next review` subcommand and the evidence indexer.
 * Pure function — no I/O.
 */
export function renderReviewRecord(record: ReviewRecord): string {
  const verdictSummary = `${record.verdicts.specification}/${record.verdicts.integration}/${record.verdicts.evidence}`;
  return (
    `review record: ` +
    `contract=${record.taskContractId}@${record.contractRevision} ` +
    `reviewer=${record.reviewer.id} ` +
    `verdicts=${verdictSummary} ` +
    `confidence=${record.confidence} ` +
    `findings=${record.findings.length} ` +
    `independent=${record.independent} ` +
    `hash=${record.reviewHash}`
  );
}

/**
 * Sanity helper: build a hash preview without freezing the
 * record. Useful for tests that want to compare two raw review
 * inputs without allocating a full record.
 */
export function previewReviewHash(input: {
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly reviewer: Actor;
  readonly implementer: Actor;
  readonly review: ReviewerInput;
}): ContentHash {
  return deriveReviewRecordHash({
    taskContractId: input.taskContractId,
    contractRevision: input.contractRevision,
    workerContextHash: input.workerContextHash,
    reviewer: input.reviewer,
    implementer: input.implementer,
    verdicts: input.review.verdicts,
    confidence: input.review.confidence,
    summary: input.review.summary ?? "",
    findings: input.review.findings,
    submittedAt: input.review.submittedAt
  });
}