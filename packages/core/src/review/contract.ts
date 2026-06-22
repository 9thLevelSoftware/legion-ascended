/**
 * P08-T02 — Per-task review pipeline contract.
 *
 * Why this lives in its own module:
 *  - `dispatch/contract.ts` describes what a worker receives
 *    (WorkerContext). That surface is upstream of this module.
 *  - This module describes what the per-task review pipeline MUST
 *    produce so an acceptance gate can decide whether a fresh
 *    worker run cleared the ADR-006 risk-tier gates.
 *
 * Pipeline invariants (enforced by `PerTaskReviewPipeline`):
 *  1. Deterministic verification runs every command listed in
 *     `TaskContract.verification[]` against the supplied
 *     `WorkerContext`. The runner is injected; this module
 *     defaults to a no-op stub for unit tests.
 *  2. Independent reviewer input is REQUIRED for tier >= R1 (per
 *     ADR-006: `lightweight_independent_review`, `task_level_independent_review`,
 *     `architecture_or_security_review`). The reviewer actor MUST
 *     differ from the implementer actor. Same-actor reviews are
 *     rejected with a structured issue.
 *  3. The acceptance gate enumerates ADR-006 risk gates that must
 *     be present for the active tier and emits typed `AcceptanceGateFailure`
 *     entries when they are missing or failed.
 *  4. Every output shape is deeply frozen and carries a
 *     `reviewPipelineHash` for audit-by-grep.
 *  5. The pipeline is provider-neutral: it never imports a runtime
 *     driver, board persistence, or reads node process environment.
 *     The CLI and runtime drivers remain outside core.
 */

import type {
  Actor,
  ArtifactReference,
  ContentHash,
  RiskTier,
  SchemaVersion,
  TaskContract,
  UtcTimestamp
} from "@legion/protocol";

import type { WorkerContext } from "../dispatch/contract.js";

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const REVIEW_PIPELINE_SCHEMA_VERSION: SchemaVersion = "1.0.0" as SchemaVersion;
export const REVIEW_PIPELINE_KIND = "task-review-pipeline" as const;

// ---------------------------------------------------------------------------
// Issue codes
// ---------------------------------------------------------------------------

export type ReviewPipelineIssueCode =
  | "verification_command_failed"
  | "verification_runner_unavailable"
  | "review_required_for_tier"
  | "reviewer_is_implementer"
  | "review_verdict_inconsistent"
  | "review_evidence_missing"
  | "gate_not_satisfied"
  | "gate_evaluator_failure";

export interface ReviewPipelineIssue {
  readonly code: ReviewPipelineIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

// ---------------------------------------------------------------------------
// Deterministic verification surface
// ---------------------------------------------------------------------------

export interface VerificationCommandResult {
  readonly index: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly expectedExitCode: number;
  readonly stdoutSha256: ContentHash;
  readonly stderrSha256: ContentHash;
  readonly combinedSha256: ContentHash;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly notes?: string;
}

export type VerificationRunner = (
  command: VerificationCommandRequest
) => Promise<VerificationCommandResult> | VerificationCommandResult;

export interface VerificationCommandRequest {
  readonly index: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly timeoutMs?: number;
  readonly context: WorkerContext;
}

/**
 * Aggregated verification record. The reviewer and the acceptance
 * gate both consume this; we never mutate the contract's
 * `verification[]` array — we attach results alongside.
 */
export interface VerificationReport {
  readonly kind: "verification-report";
  readonly schemaVersion: SchemaVersion;
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly commands: readonly VerificationCommandResult[];
  readonly passed: boolean;
  readonly failingIndices: readonly number[];
  readonly reportSha256: ContentHash;
  readonly createdAt: UtcTimestamp;
}

// ---------------------------------------------------------------------------
// Independent reviewer surface
// ---------------------------------------------------------------------------

/**
 * Severity-ranked reviewer verdicts for the three legs of an
 * independent review (spec, integration, evidence). This mirrors the
 * protocol-level `ReviewVerdict` enum (`pass`, `fail`, `unknown`,
 * `not_verified`, `not_applicable`) but keeps the pipeline surface
 * independent of the protocol package so the dispatch surface and the
 * review surface remain decoupled.
 */
export type ReviewerVerdict = "pass" | "fail" | "not_verified" | "not_applicable";

export interface ReviewerVerdicts {
  readonly specification: ReviewerVerdict;
  readonly integration: ReviewerVerdict;
  readonly evidence: ReviewerVerdict;
}

export interface ReviewerFinding {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "minor" | "major" | "blocking";
  readonly evidenceRefs?: readonly string[];
}

export type ReviewerInput = {
  readonly reviewer: Actor;
  readonly verdicts: ReviewerVerdicts;
  readonly findings: readonly ReviewerFinding[];
  readonly confidence: "low" | "medium" | "high";
  readonly submittedAt: UtcTimestamp;
  readonly summary?: string;
  readonly note?: string;
};

/**
 * Frozen, normalized review record returned by the pipeline. The
 * record carries the deterministic `reviewHash` plus the source
 * reviewer input so audit consumers can compare canonical snapshots
 * without re-running the pipeline.
 */
export interface ReviewRecord {
  readonly kind: "review-record";
  readonly schemaVersion: SchemaVersion;
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly reviewer: Actor;
  readonly implementer: Actor;
  readonly verdicts: ReviewerVerdicts;
  readonly findings: readonly ReviewerFinding[];
  readonly confidence: "low" | "medium" | "high";
  readonly summary: string;
  readonly independent: boolean;
  readonly reviewHash: ContentHash;
  readonly createdAt: UtcTimestamp;
  readonly submittedAt: UtcTimestamp;
}

// ---------------------------------------------------------------------------
// Acceptance gate evaluator
// ---------------------------------------------------------------------------

/**
 * The subset of ADR-006 risk gates the per-task review pipeline is
 * responsible for. Tier-mandated gates that are out of scope for the
 * per-task loop (e.g. `approved_delta_spec`, `independent_baseline`)
 * are still listed so the evaluator can record them as MISSING and
 * the orchestrator can route them upstream, but they don't block the
 * pipeline itself.
 */
export type ReviewGateId =
  | "deterministic_verification"
  | "task_level_independent_review"
  | "lightweight_independent_review"
  | "evidence_bundle_or_log"
  | "task_contract";

export type GateState = "satisfied" | "missing" | "failed" | "not_evaluable";

export interface GateEvaluation {
  readonly gate: ReviewGateId;
  readonly state: GateState;
  readonly reason: string;
  readonly source: "tier" | "policy" | "evaluator";
  readonly tier?: RiskTier;
}

export interface AcceptanceDecision {
  readonly kind: "acceptance-decision";
  readonly schemaVersion: SchemaVersion;
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly tier: RiskTier;
  readonly outcome: "accepted" | "rejected" | "escalated";
  readonly gates: readonly GateEvaluation[];
  readonly failingGates: readonly ReviewGateId[];
  readonly decisionSha256: ContentHash;
  readonly createdAt: UtcTimestamp;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Pipeline input / output
// ---------------------------------------------------------------------------

export interface PerTaskReviewPipelineInput {
  readonly taskContract: TaskContract;
  readonly workerContext: WorkerContext;
  readonly implementer: Actor;
  readonly policy?: PerTaskReviewPolicy;
  readonly runner?: VerificationRunner;
  readonly review?: ReviewerInput;
  readonly expectedArtifacts?: readonly ArtifactReference[];
  readonly now?: () => UtcTimestamp;
}

/**
 * The active gate policy for the pipeline. Defaults to the
 * per-task-review surface; callers can override individual gates
 * when a project ADR mandates a stricter set.
 */
export interface PerTaskReviewPolicy {
  readonly gatesByTier: Readonly<Record<RiskTier, readonly ReviewGateId[]>>;
  readonly requireIndependentReview: Readonly<Record<RiskTier, boolean>>;
}

export interface PerTaskReviewPipelineSuccess {
  readonly ok: true;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof REVIEW_PIPELINE_KIND;
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly isolationTag: string;
  readonly verification: VerificationReport;
  readonly review: ReviewRecord | null;
  readonly decision: AcceptanceDecision;
  readonly reviewPipelineHash: ContentHash;
  readonly createdAt: UtcTimestamp;
}

export interface PerTaskReviewPipelineFailure {
  readonly ok: false;
  readonly schemaVersion: SchemaVersion;
  readonly kind: typeof REVIEW_PIPELINE_KIND;
  readonly taskContractId: string;
  readonly contractRevision: number;
  readonly workerContextHash: ContentHash;
  readonly isolationTag: string;
  readonly issues: readonly ReviewPipelineIssue[];
  readonly verification: VerificationReport | null;
  readonly review: ReviewRecord | null;
  readonly decision: AcceptanceDecision;
  readonly reviewPipelineHash: ContentHash;
  readonly createdAt: UtcTimestamp;
}

export type PerTaskReviewPipelineResult =
  | PerTaskReviewPipelineSuccess
  | PerTaskReviewPipelineFailure;

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export const REVIEW_PIPELINE_KEYS = [
  "ok",
  "schemaVersion",
  "kind",
  "taskContractId",
  "contractRevision",
  "workerContextHash",
  "isolationTag",
  "verification",
  "review",
  "decision",
  "reviewPipelineHash",
  "createdAt",
  "issues"
] as const;

export type ReviewPipelineKey = (typeof REVIEW_PIPELINE_KEYS)[number];