import {
  DEFAULT_RISK_POLICY,
  deriveGateSet,
  type DerivedRiskGate,
  type RiskGateId
} from "@legion/core";
import type {
  ChangeBundleDeltaEntry,
  EvidenceIndexEntry,
  ReviewDecisionSuccess
} from "@legion/artifacts";
import type {
  AcceptanceState,
  Approval,
  ArtifactReference,
  Oracle,
  Release,
  TaskContract,
  TaskRun,
  UtcTimestamp,
  VerificationSurface
} from "@legion/protocol";

import { latestEvidencePerTask } from "./evidence-selection.js";
import type { VerifyPinnedReference } from "./pinned-references.js";

/**
 * Ship readiness derived from ADR-006 risk gates.
 *
 * `legion ship` previously asked one question: does an accepted review row
 * exist? That is a row-existence check, not a readiness gate — it says nothing
 * about which gates the change's risk tier actually demands. This module
 * derives the required gate set from `DEFAULT_RISK_POLICY` and reports each
 * gate's real status.
 *
 * Three statuses, deliberately distinct:
 *  - `satisfied`   — evidence exists and is positive.
 *  - `unsatisfied` — evidence exists and is negative. Blocks.
 *  - `unevaluable` — Legion does not yet produce evidence of this kind at all.
 *                    Also blocks.
 *
 * An unevaluable gate blocks because the alternative is a self-contradicting
 * verdict: a change would report `status: "ready"` while the same payload lists
 * its security, release-observation and rollback gates as unproven. "Ready" has
 * to mean the risk tier's gates were met, not that nothing actively failed — a
 * gate with no producer is unmet, and the absence of evidence is not evidence of
 * satisfaction.
 *
 * **As of this release every R2 gate has a producer**, so an R2 change carrying
 * approved delta specs, a passing oracle result, a verified non-unit
 * verification surface and a whole-change sign-off reports `ready` end to end —
 * the first tier above R0 for which that is true. R3 still cannot: independent
 * baselines, architecture and security review, protected acceptance tests,
 * spec-and-oracle ordering, release observation and rollback evidence remain
 * producerless, and the report names exactly which. Lowering the tier through an
 * audited `risk.override` is the supported way to ship work whose gates
 * genuinely do not apply.
 */

export type ShipGateStatus = "satisfied" | "unsatisfied" | "unevaluable";

/**
 * What a gate's verdict is a statement about.
 *
 * Most gates ask about one task. Some ask about the whole change: whether its
 * delta specs were approved, whether the change was accepted, whether a release
 * plan observes all of it. Those answers are the same for every task, so
 * repeating them per task in the operator's diagnostics says the same sentence
 * N times.
 *
 * `approved_delta_spec` is the first change-scoped gate and, for now, the only
 * one: its question is "does every delta spec this change ships carry a granted
 * approval", which is a property of `bundle.deltas` and has one answer for the
 * whole change. The vocabulary landed one release ahead of it so that this diff
 * is about the gate rather than about inventing a scope model.
 */
export type ShipGateScope = "task" | "change";

export interface ShipGateResult {
  readonly gate: RiskGateId;
  readonly label: string;
  readonly status: ShipGateStatus;
  readonly reason: string;
  /**
   * The task whose risk tier derived this gate.
   *
   * Kept alongside `subjectId` rather than replaced by it. Change-scoped gates
   * are still emitted once per task so the tier arithmetic below holds, so
   * "which task's tier demanded this gate" and "what is this verdict about"
   * stay different questions with different answers.
   */
  readonly taskId: string;
  readonly scope: ShipGateScope;
  /** `taskId` when task-scoped; the change id when change-scoped. */
  readonly subjectId: string;
  /**
   * The command that repairs *this* verdict, when the gate can say it more
   * precisely than `GATE_RECOVERY` can.
   *
   * Set by two gates today. `integration_or_real_interface_checks` has four
   * unmet states with four different repairs — re-affirm a drifted pin, run a
   * build, declare a surface at intake, fix a failing command — and
   * `whole_change_acceptance_evidence` has five of its own — accept, review then
   * accept, review then accept *again* over a verdict already recorded, build
   * then review then accept, and a bundle no command repairs. A table holding one
   * command per gate id would have to name one of them and misroute the rest.
   * `shipGateRecovery` prefers this over the table, so the gate that knows which
   * state it is in is the one that answers.
   */
  readonly recovery?: ShipGateRecovery;
}

export interface ShipGateReport {
  readonly gates: readonly ShipGateResult[];
  readonly satisfied: number;
  readonly unsatisfied: number;
  readonly unevaluable: number;
  readonly ready: boolean;
}

/** One oracle of the change, with the reference a pin check needs. */
export interface ShipGateOracleFact {
  /**
   * Narrower than the artifacts service's `OracleArtifactSuccess`, which is
   * structurally assignable to it, so the caller passes read results straight
   * through. Carrying the service envelope into the evaluator would put `ok`,
   * `status` and `diagnostics` — none of which a gate reads — into every unit
   * fixture, shaping the fixture around the plumbing instead of the question.
   */
  readonly document: Oracle;
  readonly reference: ArtifactReference;
}

/**
 * What `legion ship` read about the change, for gates that ask about the change
 * rather than about one task.
 *
 * Every fact derived from a read is a required key typed `T | undefined`, never
 * an optional `?` property. Two reasons, both learned the hard way elsewhere in
 * this tree:
 *
 *  - Required, so that a fact nobody loaded is a compile error at the one
 *    production caller. A gate that certifies absence because the loader was
 *    never wired is the same fail-open as a gate that certifies absence because
 *    the evidence was never written.
 *  - `| undefined` rather than `?`, because `exactOptionalPropertyTypes` forbids
 *    passing `release: undefined` to a `release?: Release` field. The caller
 *    would have to assemble the literal out of conditional spreads, where "this
 *    plane has no reader yet" is expressed by the absence of a spread and is
 *    invisible in review. Spelled out with a comment, it is a line to read.
 *
 * The invariant every gate built on this must hold: **an absent fact yields
 * `unevaluable`, never `satisfied`.** Nothing here may be read as a positive.
 *
 * There is deliberately no `attestations` field. No attestation entity, schema,
 * id prefix or path role exists anywhere in the repository, so the only
 * available spellings are `unknown[]`, `never[]` or an invented local interface
 * — each a shape that could never exist on disk, and each unreadable by any
 * test in this release. The change that introduces the entity adds the field in
 * the same diff, which is both a smaller change than retyping a placeholder and
 * impossible to misread as "attestations were checked and none existed".
 */
export interface ShipGateChangeFacts {
  /** Identity, not a read: ship cannot reach the evaluator without it. */
  readonly changeId: string;
  /** `bundle.change.acceptance`. Undefined when the bundle did not load. */
  readonly acceptance: AcceptanceState | undefined;
  /**
   * Every approval recorded for this change, or `undefined` when the set could
   * not be established.
   *
   * Three values, three different meanings, and collapsing any two of them is a
   * fail-open:
   *
   *  - `undefined` — the directory would not read, or the listing dropped an
   *    entry. An approval file holds a decision and, once it is re-decided, the
   *    revocation that replaced it, so a dropped file drops a negative fact.
   *    Nothing may be concluded from what was kept.
   *  - `[]` — the plane was read and this change has no approvals. That is what
   *    a change accepted by an older Legion looks like, and it is `unevaluable`
   *    rather than negative.
   *  - a non-empty list — real records, whose statuses are the answer.
   *
   * All-or-nothing, on the same rule as `oracles` and `taskRuns`: a function
   * taking a list cannot tell a short list from a whole one, and the caller that
   * read the directory can.
   */
  readonly approvals: readonly Approval[] | undefined;
  /** `bundle.deltas`. Undefined when the bundle did not load. */
  readonly deltas: readonly ChangeBundleDeltaEntry[] | undefined;
  /**
   * Every oracle in the change directory, or `undefined` when the set could not
   * be established. Not a partial list: the oracle manifest fails on any
   * malformed oracle in the directory, and a list missing the unapproved one
   * would let a gate conclude that every oracle is approved.
   */
  readonly oracles: readonly ShipGateOracleFact[] | undefined;
  /**
   * Every task run of the change, unflattened — or `undefined` when the set
   * could not be established.
   *
   * Ordering gates want `min(startedAt)` — see `earliestExecutionStart` — but a
   * single change-level timestamp answers only that one question. Independence
   * asks who executed (`claimedBy`), and a per-task gate asks about that task's
   * run rather than the change's earliest. Flattening here would force a second
   * change to this interface from inside a gate change, which is the coupling
   * this seam exists to remove.
   *
   * Not a partial list, on the same rule as `oracles` above and for a sharper
   * reason. The run listing reports success while skipping runs it cannot read,
   * and every run it drops can only push `min(startedAt)` later — the direction
   * that makes an approval recorded after execution began look as though it came
   * first. The listing now reports what it skipped and the caller turns any skip
   * into absence, so a gate reading this reads either the whole set or nothing.
   */
  readonly taskRuns: readonly TaskRun[] | undefined;
  /** At most one release plan per change, so singular. No reader yet. */
  readonly release: Release | undefined;
  /**
   * The instant this report is being derived, or `undefined` when the caller
   * has no clock.
   *
   * Injected for the same reason `verifyPin` is: reading the wall clock is
   * ambient state, this module is synchronous and pure, and a report should be
   * a snapshot of one moment rather than a mix of the moments each gate
   * happened to ask. `legion ship` passes `currentUtcTimestamp()`.
   *
   * It exists because `expiresAt` exists. A granted approval that has lapsed is
   * no longer a live decision, and a gate with no clock cannot tell the two
   * apart — so without this the only honest answers were "always live", which is
   * a fail-open, or "never checkable", which permanently disables a field the
   * schema offers. `undefined` keeps the second answer available for a caller
   * that genuinely has no clock: an approval carrying an expiry is then
   * `unevaluable`, never `satisfied`.
   */
  readonly evaluatedAt: UtcTimestamp | undefined;
  /**
   * Re-verify a pinned reference against the working tree.
   *
   * Injected because hashing is I/O and this module is synchronous and pure.
   * Total and never `undefined`: the guard in `deriveShipGates` substitutes an
   * always-`unverified` verifier rather than letting a gate call a non-function.
   */
  readonly verifyPin: VerifyPinnedReference;
}

/**
 * Which gates are about the change rather than about a task.
 *
 * A total `Record<RiskGateId, ShipGateScope>` rather than a set of the
 * change-scoped ids: `RiskGateId` is a closed union, so a gate added upstream
 * stops this file compiling until someone classifies it. A set would let a new
 * gate default silently to task scope, which silently disables both the
 * diagnostic collapse below and, once gates read facts, the absence guard.
 *
 * `approved_delta_spec`, `integration_or_real_interface_checks` and
 * `whole_change_acceptance_evidence` are the `"change"` entries. Each later gate
 * flips exactly its own line, next to the gate it implements.
 *
 * `whole_change_acceptance_evidence` is change-scoped for the plainest reason of
 * the three: `change.acceptance` is one field on one bundle with exactly one
 * answer for the whole change, and the verdict quantifies over *every* task — so
 * a `subjectId` naming one task would be false about the sentence beside it, and
 * `shipGateDiagnostics` would repeat that sentence once per task.
 *
 * `integration_or_real_interface_checks` is change-scoped because ADR-006's
 * wording is "verification reaches the relevant integration or real interface
 * **for the change**", and because `legion plan` materializes one task per
 * executable criterion. Task-scoped, its "everything declared here is a unit
 * surface" branch fired per *criterion*: a change whose first criterion reaches
 * a real interface and whose second is an honest pure-arithmetic unit check was
 * blocked by the second, forever, with no answer available but to delete the
 * honest criterion or to mislabel it. A gate that punishes an accurate answer
 * teaches operators to give an inaccurate one, which costs more than the gate
 * was ever worth.
 *
 * Task scoping was available for it and is refused for a concrete reason rather
 * than a stylistic one. A task-scoped version would intersect
 * `task.requirementIds` with `bundle.deltas[].requirementId`, and that
 * intersection can be empty — at which point `every` over it is vacuously true
 * and the gate reports `satisfied` because of a scoping choice rather than
 * because of an approval. Closing that needs a non-emptiness invariant nothing
 * else in this file needs. It would also answer a weaker question: "were the
 * delta specs this task touches approved", which lets a change ship with an
 * unapproved requirement no task happens to cover.
 */
const GATE_SCOPE: Readonly<Record<RiskGateId, ShipGateScope>> = {
  current_task_contract_or_small_change_record: "task",
  deterministic_verification: "task",
  evidence_note: "task",
  task_contract: "task",
  scoped_implementer_run: "task",
  evidence_bundle_or_log: "task",
  lightweight_independent_review: "task",
  approved_delta_spec: "change",
  protected_oracle: "task",
  task_level_independent_review: "task",
  integration_or_real_interface_checks: "change",
  whole_change_acceptance_evidence: "change",
  independent_baseline: "task",
  approved_spec_and_oracle: "task",
  architecture_or_security_review: "task",
  protected_acceptance_tests: "task",
  security_or_e2e_evaluator: "task",
  explicit_human_approval: "task",
  release_observation_plan: "task",
  rollback_or_forward_fix_evidence: "task"
};

/**
 * When gated execution began, or `undefined` if that is unestablished.
 *
 * `undefined` covers three different situations — no run exists, no run
 * recorded a start, or the runs could not be listed — and all three mean the
 * same thing to a gate that compares an approval timestamp against it: the
 * ordering is unknown, so the gate is `unevaluable`. It must never be read as
 * "therefore the approval came first".
 *
 * This is a minimum, so it is only sound over a complete list: a dropped run can
 * only move it later, and later is the direction that makes a late approval look
 * early. That is why `taskRuns` is all-or-nothing at the boundary rather than
 * defended here — a function taking a list cannot tell a short list from a whole
 * one, and the caller that read the directory can.
 */
export function earliestExecutionStart(
  taskRuns: readonly TaskRun[] | undefined
): UtcTimestamp | undefined {
  let earliest: UtcTimestamp | undefined;
  for (const run of taskRuns ?? []) {
    const startedAt = run.startedAt;
    if (startedAt === undefined) continue;
    if (earliest === undefined || startedAt < earliest) earliest = startedAt;
  }
  return earliest;
}

/**
 * The verdict recorded by a task's *latest* attempt.
 *
 * Reading the first match in stored order would answer with the earliest
 * attempt, so an old passing bundle would mask a newer failure and the gate
 * would certify a task that most recently failed.
 */
function evidenceItemVerdict(
  entries: readonly EvidenceIndexEntry[],
  taskId: string,
  itemId: string
): "pass" | "fail" | undefined {
  const entry = latestEvidencePerTask(entries).get(taskId);
  if (entry === undefined) return undefined;
  for (const item of entry.evidence.items) {
    if (item.id !== itemId) continue;
    if (item.verdict === "pass") return "pass";
    if (item.verdict === "fail") return "fail";
  }
  return undefined;
}

function hasEvidence(entries: readonly EvidenceIndexEntry[], taskId: string): boolean {
  const entry = latestEvidencePerTask(entries).get(taskId);
  return entry !== undefined && entry.evidence.items.length > 0;
}

function hasAcceptedReview(reviews: readonly ReviewDecisionSuccess[], taskId: string): boolean {
  return reviews.some(
    (review) => review.document.status === "accepted" && review.document.taskId === taskId
  );
}

/**
 * The action an approval carries when it records a review acceptance.
 *
 * Matched exactly. An approval of anything else about this change — a delta
 * spec, an oracle — is a decision about a different thing, and reading it here
 * would let one approval satisfy a gate it was never granted for.
 */
const REVIEW_ACCEPT_ACTION = "workflow.review.accept";

/**
 * The action an approval carries when it records a delta-spec decision.
 *
 * Matched exactly, for the same reason as the constant above: a review
 * acceptance also carries a `{kind: "change"}` target, so a loose action match
 * would let "somebody accepted a review" answer "somebody approved this
 * requirement's specification".
 */
const DELTA_SPEC_APPROVE_ACTION = "spec.delta.approve";

/** An approval narrowed to the member whose `decidedBy` and `decidedAt` exist. */
type GrantedApproval = Extract<Approval, { readonly status: "granted" }>;

/**
 * Whether a grant is still live at the moment the report is being derived.
 *
 * Three answers, because there are three situations. `"unknown"` is the one
 * that matters: an approval that says it expires, evaluated by a caller with no
 * clock, is a decision whose current validity is unestablished — and this
 * module's invariant is that an unestablished fact never reads as `satisfied`.
 *
 * Compared as strings. Every `utcTimestampSchema` value is a fixed-width UTC
 * instant, so lexicographic order is chronological order; `earliestExecutionStart`
 * above relies on the same property. `<=` rather than `<` so an approval expiring
 * exactly now is spent: expiry bounds validity, and the boundary belongs to the
 * side that blocks.
 */
function grantExpiry(
  approval: GrantedApproval,
  evaluatedAt: UtcTimestamp | undefined
): "live" | "lapsed" | "unknown" {
  if (approval.expiresAt === undefined) return "live";
  if (evaluatedAt === undefined) return "unknown";
  return approval.expiresAt <= evaluatedAt ? "lapsed" : "live";
}

/** The `sha256:<hex>` an idempotency key ends with, or `undefined`. */
function idempotencyTargetHash(key: string): string | undefined {
  return /:(sha256:[0-9a-f]{64})$/.exec(key)?.[1];
}

type ApprovedReviewLink =
  | { readonly kind: "current" }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Is the grant still about the review that is accepted now?
 *
 * Without this, a granted approval is unfalsifiable by any later state of the
 * tree: `legion review --reject-reason` rewrites the review and leaves the
 * approval untouched, and re-reviewing writes a superseding review that the
 * approval has never seen. The gate would keep reporting that a named human
 * accepted this task's review, using a record about a review that has since been
 * rejected or replaced. An approval is a claim about an act; it is only worth
 * reading if it stays tied to the bytes the act was about.
 *
 * Three links are checked, each closing a different way for the two to drift
 * apart, and none of them is inferred:
 *
 *  - **Identity.** `legion review --accept` writes `{kind: "review", id}` into
 *    `scope.targets`, so the approval names what it approved. An approval that
 *    names no review cannot be checked at all, and is `unknown` rather than
 *    trusted — that is the shape a host or a hand-written file would take, and
 *    the honest answer to "was this approval about the current review" is that
 *    nothing says.
 *  - **Standing.** The named review must still be accepted, and nothing may have
 *    superseded it. `supersedes` is written by the review gate itself and is a
 *    recorded link rather than a timestamp comparison, so re-reviewing a task
 *    invalidates the old grant without either writer knowing about the other.
 *  - **Bytes.** The idempotency key's target hash *is* the accepted review's
 *    content hash at the instant of the decision, and the reference the artifact
 *    service returns is its content hash now. Equality is the only thing that
 *    makes "approved" survive a mutable working tree.
 *
 * Deliberately not checked here: whether the task was rebuilt after acceptance.
 * That is a fact about evidence, not about the approval, and it is the same
 * staleness the two independent-review gates carry — `whole_change_acceptance_evidence`
 * is the gate that owns it and it has no producer yet. Answering it from this
 * gate would put one plane's verdict in another plane's reader and leave the
 * real gate looking produced.
 */
function approvedReviewLink(input: {
  readonly approval: GrantedApproval;
  readonly reviews: readonly ReviewDecisionSuccess[];
  readonly taskId: string;
}): ApprovedReviewLink {
  const approvedIds = input.approval.scope.targets
    .filter((target) => target.kind === "review")
    .map((target) => target.id);
  if (approvedIds.length === 0) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} names no review, so it cannot be checked against this task's accepted review.`
    };
  }

  const taskReviews = input.reviews.filter((review) => review.document.taskId === input.taskId);
  const named = taskReviews.filter((review) => approvedIds.includes(review.document.id));
  if (named.length !== approvedIds.length) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} records accepting ${approvedIds.join(", ")}, which is not among this task's readable reviews.`
    };
  }

  for (const review of named) {
    if (review.document.status !== "accepted") {
      return {
        kind: "stale",
        reason: `Approval ${input.approval.id} records accepting review ${review.document.id}, which is now ${review.document.status}.`
      };
    }

    const superseding = taskReviews.find(
      (candidate) =>
        candidate.document.id !== review.document.id &&
        (candidate.document.supersedes ?? []).includes(review.document.id)
    );
    if (superseding !== undefined) {
      return {
        kind: "stale",
        reason: `Approval ${input.approval.id} approved review ${review.document.id}, which review ${superseding.document.id} has since superseded.`
      };
    }

    const approvedHash = idempotencyTargetHash(input.approval.idempotencyKey);
    const currentHash = review.reference?.sha256;
    if (approvedHash === undefined || currentHash === undefined) {
      return {
        kind: "unknown",
        reason: `Approval ${input.approval.id} cannot be compared against the bytes of review ${review.document.id}, so what was approved is unestablished.`
      };
    }
    if (approvedHash !== currentHash) {
      return {
        kind: "stale",
        reason: `Approval ${input.approval.id} was granted against different bytes of review ${review.document.id}, which has been rewritten since.`
      };
    }
  }

  return { kind: "current" };
}

/** Newest decision last; the id breaks ties so the order never depends on input order. */
function byDecisionInstant(
  left: { readonly decidedAt?: UtcTimestamp | undefined; readonly id: string },
  right: { readonly decidedAt?: UtcTimestamp | undefined; readonly id: string }
): number {
  const byInstant = (left.decidedAt ?? "").localeCompare(right.decidedAt ?? "");
  if (byInstant !== 0) return byInstant;
  return left.id.localeCompare(right.id);
}

/**
 * Did a human approve accepting this task's review?
 *
 * Until this release the answer came from `hasAcceptedReview`, sharing an arm
 * with the two independent-review gates. Every review Legion writes records
 * `reviewer: {kind: "tool", id: "legion-<executor>-reviewer"}`, so the gate
 * reported that a human had approved a change on which no human identity had
 * ever been recorded anywhere. It could not fail: the same accepted row that
 * satisfied "an independent review exists" satisfied "a human approved".
 *
 * The answer now comes from the approval plane, in a fixed order. Every step is
 * there because skipping it is a fail-open:
 *
 *  - A review whose *accept* transition names a non-human actor is a recorded
 *    negative about this task — the human step was performed by something that
 *    is not a human, which is a different statement from "no human step is
 *    recorded". It beats a live grant, because a grant elsewhere on the change
 *    does not unsay it. Unreachable through `legion review`, which refuses a
 *    non-human approver before writing anything; it defends against artifacts
 *    written by a host, by hand, or by a later verb.
 *  - An approval answers about *this* change and *this* task or it is not read
 *    at all. `writeApproval` cross-checks neither the top-level `taskId` against
 *    `scope.targets` nor the change against anything but the path, and the
 *    caller assembling the plane could one day list more than one directory, so
 *    the gate carries its own scoping rather than borrowing the loader's.
 *  - A negative decision beats a grant unless a *strictly later* grant
 *    supersedes it. Legion stores one document per (change, action, task) and
 *    re-decides it in place, so a grant and its revocation cannot separate — but
 *    that is a property of one writer, and this function's threat model is
 *    artifacts written by a host, by hand, or by a later verb. Given two
 *    documents, taking the first granted one it happens to see would let a
 *    revocation dated a day later be outranked by list order.
 *  - A lapsed expiry is a spent decision, and an expiry with no clock to check
 *    it against is an unestablished one. Neither may read as `satisfied`.
 *  - A live grant still has to be about the review that is accepted now; see
 *    `approvedReviewLink`.
 *  - An absent plane, or a plane with no approval naming this task, is absence:
 *    `unevaluable`. That is what every change accepted by an older Legion looks
 *    like, and reading it as a negative would report a verdict about a human
 *    who was never asked.
 *  - `requested` is a decision not yet made, which is also absence.
 */
function humanApprovalStatus(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly reviews: readonly ReviewDecisionSuccess[];
  readonly taskId: string;
}): { readonly status: ShipGateStatus; readonly reason: string } {
  for (const review of input.reviews) {
    if (review.document.status !== "accepted") continue;
    if (review.document.taskId !== input.taskId) continue;
    const acceptedBy = review.document.acceptedBy;
    if (acceptedBy === undefined || acceptedBy.kind === "human") continue;
    return {
      status: "unsatisfied",
      reason: `Review ${review.document.id} was accepted by ${acceptedBy.kind} ${acceptedBy.id}, not by a human.`
    };
  }

  const approvals = input.change?.approvals;
  if (approvals === undefined) {
    return {
      status: "unevaluable",
      reason: "The approvals recorded for this change could not be read, so no human approval is established."
    };
  }

  const relevant = approvals.filter(
    (approval) =>
      // Strict equality against a possibly-absent change id, so facts too
      // degraded to name their own change match nothing rather than matching
      // everything. Absence must never widen the set an approval can answer for.
      approval.changeId === input.change?.changeId &&
      // An approval whose two task claims disagree says two things; the gate
      // reads neither. The service will persist such a document, so refusing it
      // here is the only place it is refused.
      (approval.taskId === undefined || approval.taskId === input.taskId) &&
      approval.scope.action === REVIEW_ACCEPT_ACTION &&
      approval.scope.targets.some((target) => target.kind === "task" && target.id === input.taskId)
  );
  if (relevant.length === 0) {
    return {
      status: "unevaluable",
      reason: "No approval records anyone accepting this task's review."
    };
  }

  // Sorted into buckets by loop rather than by `filter`, so that
  // `status === "granted"` narrows the discriminated union and `decidedBy` and
  // `decidedAt` are read as the required fields they are on that member. Behind
  // a `filter`, the element type widens back and the only available spelling is
  // `decidedBy?.kind`, which renders "undefined" into an operator's diagnostic
  // on the one member where the field cannot be absent.
  const live: GrantedApproval[] = [];
  const lapsed: GrantedApproval[] = [];
  const unknownExpiry: GrantedApproval[] = [];
  const nonHumanGrants: GrantedApproval[] = [];
  for (const approval of relevant) {
    if (approval.status !== "granted") continue;
    if (approval.decidedBy.kind !== "human") {
      nonHumanGrants.push(approval);
      continue;
    }
    const expiry = grantExpiry(approval, input.change?.evaluatedAt);
    if (expiry === "live") live.push(approval);
    else if (expiry === "lapsed") lapsed.push(approval);
    else unknownExpiry.push(approval);
  }
  live.sort(byDecisionInstant);
  const newestGrant = live.at(-1);

  // A negative stands unless a live grant is strictly later than it. Equal
  // instants leave the negative standing: the two decisions cannot be ordered,
  // and an unorderable pair is not evidence that the grant came second. A
  // negative with no decision instant at all — the shape `expired` allows —
  // can never be shown to be superseded, so it always stands.
  const standing = relevant
    .filter((approval) => approval.status === "denied" || approval.status === "revoked" || approval.status === "expired")
    .filter((approval) => {
      if (newestGrant === undefined) return true;
      const decidedAt = approval.decidedAt;
      if (decidedAt === undefined) return true;
      return decidedAt >= newestGrant.decidedAt;
    })
    .sort(byDecisionInstant);
  const blocking = standing.at(-1);
  if (blocking !== undefined) {
    return {
      status: "unsatisfied",
      reason:
        newestGrant === undefined
          ? `Approval ${blocking.id} for this task's review is ${blocking.status}.`
          : `Approval ${blocking.id} for this task's review is ${blocking.status}, and no later grant supersedes it.`
    };
  }

  if (newestGrant !== undefined) {
    const link = approvedReviewLink({ approval: newestGrant, reviews: input.reviews, taskId: input.taskId });
    if (link.kind === "stale") return { status: "unsatisfied", reason: link.reason };
    if (link.kind === "unknown") return { status: "unevaluable", reason: link.reason };
    return {
      status: "satisfied",
      reason: `Approval ${newestGrant.id} records ${newestGrant.decidedBy.id} accepting this task's review.`
    };
  }

  const spent = lapsed.sort(byDecisionInstant).at(-1);
  if (spent !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${spent.id}, granted by ${spent.decidedBy.id}, expired at ${spent.expiresAt}.`
    };
  }

  const unchecked = unknownExpiry.sort(byDecisionInstant).at(-1);
  if (unchecked !== undefined) {
    return {
      status: "unevaluable",
      reason: `Approval ${unchecked.id} expires at ${unchecked.expiresAt}, and this report carries no clock to check that against.`
    };
  }

  const byMachine = nonHumanGrants.sort(byDecisionInstant).at(-1);
  if (byMachine !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${byMachine.id} was granted by ${byMachine.decidedBy.kind} ${byMachine.decidedBy.id}, not by a human.`
    };
  }

  return {
    status: "unevaluable",
    reason: "An approval for this task's review is recorded as requested and has not been decided."
  };
}

type DeltaSpecPinLink =
  | { readonly kind: "current" }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Is the grant still about the bytes this change ships?
 *
 * The delta-spec analogue of `approvedReviewLink`, and the reason
 * `approvalBaseSchema.artifacts` exists. Without it, "approved" is a claim about
 * an act with no link to any text: the approval names a requirement id, and a
 * requirement id survives every possible edit of the document that specifies it.
 *
 * Three checks, in widening order — does the approval say which bytes, do those
 * bytes agree with the ones the change carries, and are those bytes still on
 * disk:
 *
 *  - **Identity.** An approval with no `artifacts`, or with none naming this
 *    delta spec's path, does not say what was approved. That is the shape every
 *    approval written before this release has, and the shape a host or a
 *    hand-written file takes; the honest answer is that nothing says, which is
 *    `unknown` and never a pass. More than one pin at the same path is also
 *    `unknown`: `artifacts` carries no uniqueness constraint, so a `find` would
 *    take whichever duplicate came first and a document pinning both the right
 *    hash and a wrong one would sail through.
 *  - **Agreement.** The pinned hash must equal the hash the change bundle
 *    records for that delta spec. This is the check that fires in practice: it
 *    is pure, in-memory, and independent of the working tree, and a stale
 *    approval — one granted against text the change no longer ships — is the
 *    only form of this staleness that is actually reachable, because
 *    `loadChangeBundle` refuses a bundle whose delta bytes have moved before
 *    `legion ship` ever derives a gate.
 *  - **Working tree.** `verifyPin` on the *approval's* reference, not the
 *    bundle's, so a pin whose hash has drifted answers `drift` rather than
 *    matching the bundle's own clean reference. `drift` and `missing` are
 *    unreachable through `legion ship` today for the reason just given; they are
 *    kept because a gate must not inherit its central truth claim from another
 *    module's invariant, and they are driven directly by unit test.
 *
 * Deliberately not checked: the idempotency key's target hash against the pin.
 * Both are written by one statement of one writer, so requiring them to agree
 * checks the writer rather than the world, and it would add an `unevaluable`
 * path with no threat behind it. `approvedReviewLink` reads the key only because
 * `artifacts` is deliberately unset there.
 */
function approvedDeltaSpecPin(input: {
  readonly approval: GrantedApproval;
  readonly delta: ChangeBundleDeltaEntry;
  readonly changeId: string;
  readonly verifyPin: VerifyPinnedReference;
}): DeltaSpecPinLink {
  const artifacts = input.approval.artifacts;
  if (artifacts === undefined) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins no artifact, so which bytes of ${input.delta.requirementId}'s delta spec were approved is unestablished.`
    };
  }

  const pins = artifacts.filter((reference) => reference.path === input.delta.path);
  if (pins.length === 0) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins no reference to ${input.delta.path}, so it does not say this delta spec was approved.`
    };
  }
  if (pins.length > 1) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins ${pins.length} references to ${input.delta.path}, so which bytes were approved is unestablished.`
    };
  }

  const pin = pins[0] as ArtifactReference;
  if (pin.sha256 !== input.delta.delta.sha256) {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} was granted against different bytes of ${input.delta.path} than change ${input.changeId} ships.`
    };
  }

  const verdict = input.verifyPin(pin);
  if (verdict === "match") return { kind: "current" };
  if (verdict === "drift") {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} pins ${input.delta.path}, whose bytes have changed since it was granted.`
    };
  }
  if (verdict === "missing") {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} pins ${input.delta.path}, which is no longer present.`
    };
  }
  return {
    kind: "unknown",
    reason: `Approval ${input.approval.id} pins ${input.delta.path}, which this report did not hash, so what was approved cannot be compared against what is on disk.`
  };
}

/**
 * Is one delta spec approved?
 *
 * The order is `humanApprovalStatus`'s, step for step, because every step of it
 * closes a fail-open that is not specific to reviews: scope the plane yourself,
 * bucket by loop so the union narrows, let a standing negative beat a grant
 * unless a strictly later grant supersedes it, check expiry against an injected
 * clock, then check that the grant is still about the bytes being shipped.
 *
 * The one addition is the third step. An approval that also claims a task or a
 * run is not read, and says so rather than being filtered away in silence. A
 * delta spec is a property of the change and this verb writes neither field, so
 * a document carrying one was written by something else with something else in
 * mind; a silent filter would report that as "nobody approved this", which sends
 * the operator to approve something that already has a record.
 */
function deltaSpecApprovalStatus(input: {
  readonly approvals: readonly Approval[];
  readonly changeId: string;
  readonly delta: ChangeBundleDeltaEntry;
  readonly evaluatedAt: UtcTimestamp | undefined;
  readonly verifyPin: VerifyPinnedReference;
}): { readonly status: ShipGateStatus; readonly reason: string } {
  const relevant = input.approvals.filter(
    (approval) =>
      // Strict equality, so facts too degraded to name their own change match
      // nothing rather than everything. A requirement id is not change-scoped —
      // the same id can appear in two changes — so this is load-bearing, not
      // belt-and-braces.
      approval.changeId === input.changeId &&
      approval.scope.action === DELTA_SPEC_APPROVE_ACTION &&
      approval.scope.targets.some(
        (target) => target.kind === "requirement" && target.id === input.delta.requirementId
      )
  );
  if (relevant.length === 0) {
    return {
      status: "unevaluable",
      reason: `No approval records anyone approving the delta spec for ${input.delta.requirementId}.`
    };
  }

  const misfiled = relevant.find((approval) => approval.taskId !== undefined || approval.runId !== undefined);
  if (misfiled !== undefined) {
    return {
      status: "unevaluable",
      reason: `Approval ${misfiled.id} names ${misfiled.taskId ?? misfiled.runId}, but a delta spec belongs to the change rather than to one task or run, so this approval is not read here.`
    };
  }

  const live: GrantedApproval[] = [];
  const lapsed: GrantedApproval[] = [];
  const unknownExpiry: GrantedApproval[] = [];
  const nonHumanGrants: GrantedApproval[] = [];
  for (const approval of relevant) {
    if (approval.status !== "granted") continue;
    if (approval.decidedBy.kind !== "human") {
      nonHumanGrants.push(approval);
      continue;
    }
    const expiry = grantExpiry(approval, input.evaluatedAt);
    if (expiry === "live") live.push(approval);
    else if (expiry === "lapsed") lapsed.push(approval);
    else unknownExpiry.push(approval);
  }
  live.sort(byDecisionInstant);
  const newestGrant = live.at(-1);

  const standing = relevant
    .filter((approval) => approval.status === "denied" || approval.status === "revoked" || approval.status === "expired")
    .filter((approval) => {
      if (newestGrant === undefined) return true;
      const decidedAt = approval.decidedAt;
      if (decidedAt === undefined) return true;
      return decidedAt >= newestGrant.decidedAt;
    })
    .sort(byDecisionInstant);
  const blocking = standing.at(-1);
  if (blocking !== undefined) {
    return {
      status: "unsatisfied",
      reason:
        newestGrant === undefined
          ? `Approval ${blocking.id} for the delta spec of ${input.delta.requirementId} is ${blocking.status}.`
          : `Approval ${blocking.id} for the delta spec of ${input.delta.requirementId} is ${blocking.status}, and no later grant supersedes it.`
    };
  }

  if (newestGrant !== undefined) {
    const link = approvedDeltaSpecPin({
      approval: newestGrant,
      delta: input.delta,
      changeId: input.changeId,
      verifyPin: input.verifyPin
    });
    if (link.kind === "stale") return { status: "unsatisfied", reason: link.reason };
    if (link.kind === "unknown") return { status: "unevaluable", reason: link.reason };
    return {
      status: "satisfied",
      reason: `Approval ${newestGrant.id} records ${newestGrant.decidedBy.id} approving the delta spec for ${input.delta.requirementId}.`
    };
  }

  const spent = lapsed.sort(byDecisionInstant).at(-1);
  if (spent !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${spent.id} for ${input.delta.requirementId}, granted by ${spent.decidedBy.id}, expired at ${spent.expiresAt}.`
    };
  }

  const unchecked = unknownExpiry.sort(byDecisionInstant).at(-1);
  if (unchecked !== undefined) {
    return {
      status: "unevaluable",
      reason: `Approval ${unchecked.id} for ${input.delta.requirementId} expires at ${unchecked.expiresAt}, and this report carries no clock to check that against.`
    };
  }

  const byMachine = nonHumanGrants.sort(byDecisionInstant).at(-1);
  if (byMachine !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${byMachine.id} for ${input.delta.requirementId} was granted by ${byMachine.decidedBy.kind} ${byMachine.decidedBy.id}, not by a human.`
    };
  }

  return {
    status: "unevaluable",
    reason: `An approval for the delta spec of ${input.delta.requirementId} is recorded as requested and has not been decided.`
  };
}

/**
 * Would this one document, alone, satisfy `approved_delta_spec` for this delta?
 *
 * Exported for `legion approve spec`, which has to answer "is there anything
 * left to decide here" and must not answer it with its own weaker rule. It did:
 * an earlier draft checked `status === "granted"`, a human decider, no expiry
 * and *some* pin at the delta's path, which four document shapes satisfy while
 * the gate rejects them — two pins at that path, a `taskId`, a `scope.action`
 * that is not `spec.delta.approve`, and a requirement target naming something
 * else. In each of those the command reported "already approved", wrote nothing,
 * and `legion ship` stayed blocked on this gate forever, with no flag anywhere
 * that could make it write. A writer whose idea of "done" is weaker than the
 * reader's idea of "satisfied" is a no-route-out loop by construction.
 *
 * So this is not a second implementation of the rule — it *calls* the gate's own
 * predicate against a one-document plane and asks whether the verdict is
 * `satisfied`. The two cannot drift because there is only one of them.
 *
 * The one substitution is `verifyPin`, which answers `match`. Hashing is I/O and
 * this function is synchronous, and the caller has already established the same
 * fact by a stronger route: `loadChangeBundle` re-reads every delta spec and
 * refuses the bundle unless the bytes on disk hash to `delta.delta.sha256`, and
 * the predicate below requires the approval's pin to equal that same hash. A pin
 * that gets past this function therefore matches disk, checked once rather than
 * twice. A caller that has *not* loaded a bundle must not use this function.
 *
 * It deliberately says nothing about *who* granted the approval. The gate does
 * not care, so neither does this; a caller that cares — and `legion approve
 * spec` does, because a rerun by the same approver is a no-op while a decision
 * by a different one is a decision — checks that itself, on top.
 */
export function isLiveDeltaSpecGrant(input: {
  readonly approval: Approval;
  readonly changeId: string;
  readonly delta: ChangeBundleDeltaEntry;
  readonly evaluatedAt: UtcTimestamp | undefined;
}): boolean {
  const outcome = deltaSpecApprovalStatus({
    approvals: [input.approval],
    changeId: input.changeId,
    delta: input.delta,
    evaluatedAt: input.evaluatedAt,
    verifyPin: () => "match"
  });
  return outcome.status === "satisfied";
}

/**
 * Are every one of this change's delta specs approved?
 *
 * **The loop runs over `change.deltas`, never over `change.approvals`.** That is
 * the single most important line in this gate and the easiest to get backwards,
 * because both spellings read as "check the approvals". Iterating approvals asks
 * "is every approval clean", which is trivially true when zero of five
 * requirements are approved — and it also silently exempts a requirement added
 * to the change after the others were approved. Iterating deltas demands one
 * decision per thing being shipped, which is what the gate's name says.
 *
 * Four absent-fact branches come first, and none of them may be reordered below
 * the loop:
 *
 *  - No facts at all, or a bundle that would not load, means the change's delta
 *    specs are unknown. This must produce the same sentence in both cases,
 *    because "an absent plane is worth no more than no facts at all" is an
 *    invariant a test holds from outside.
 *  - An empty `deltas` list is `unevaluable` rather than vacuously satisfied.
 *    `changeBundleSchema` marks it `.min(1)`, so this is unreachable from a
 *    bundle that loaded — but that is another module's invariant, this
 *    function's parameter type admits `[]`, and `[].every(...)` is `true`.
 *  - An approvals plane that could not be established says nothing about
 *    whether anything was approved. A dropped approval file is as likely to hold
 *    a revocation as a grant.
 *
 * Aggregation is: any `unsatisfied` wins, then any `unevaluable`, then
 * `satisfied`. A revoked approval on one requirement must not be masked by an
 * absent one on another — the negative is the more actionable fact and the one
 * an operator has to answer.
 */
function deltaSpecApprovalGateStatus(input: {
  readonly change: ShipGateChangeFacts | undefined;
}): { readonly status: ShipGateStatus; readonly reason: string } {
  const deltas = input.change?.deltas;
  if (deltas === undefined) {
    return {
      status: "unevaluable",
      reason: "The delta specs recorded for this change could not be read, so no delta-spec approval is established."
    };
  }
  if (deltas.length === 0) {
    return {
      status: "unevaluable",
      reason: "This change records no delta specs, so there is nothing to have been approved."
    };
  }

  const approvals = input.change?.approvals;
  if (approvals === undefined) {
    return {
      status: "unevaluable",
      reason: "The approvals recorded for this change could not be read, so no delta-spec approval is established."
    };
  }

  const change = input.change as ShipGateChangeFacts;
  const outcomes = deltas.map((delta) =>
    deltaSpecApprovalStatus({
      approvals,
      changeId: change.changeId,
      delta,
      evaluatedAt: change.evaluatedAt,
      verifyPin: change.verifyPin
    })
  );

  // `bundle.deltas` arrives sorted by requirement id, so "the first failing one"
  // is stable rather than an accident of read order.
  const unmet = outcomes.filter((outcome) => outcome.status !== "satisfied");
  const negative = outcomes.find((outcome) => outcome.status === "unsatisfied");
  const chosen = negative ?? unmet[0];
  if (chosen !== undefined) {
    // The count is appended when more than one is unmet, so an operator who
    // fixes the named one is not surprised that the gate still blocks.
    const remainder =
      unmet.length > 1 ? ` ${unmet.length} of ${deltas.length} delta specs in this change are unmet.` : "";
    return { status: chosen.status, reason: `${chosen.reason}${remainder}` };
  }

  const first = outcomes[0] as { readonly reason: string };
  return {
    status: "satisfied",
    reason:
      deltas.length === 1
        ? first.reason
        : `All ${deltas.length} delta specs in this change are approved. ${first.reason}`
  };
}

/** The evidence item `legion build` writes about declared verification surfaces. */
const INTEGRATION_SURFACE_ITEM = "integration-surface-check";

/**
 * The three cures this gate can name, and why it names them itself.
 *
 * `GATE_RECOVERY` holds one command per gate id, which is right for every gate
 * whose unmet states share a repair. This one's do not: a pin that drifted needs
 * a human to re-affirm the declaration, a declaration nothing exercised needs a
 * build, and a change that declared nothing needs an interview and a re-plan.
 * Naming one of the three in the table would send two thirds of blocked
 * operators to a command that cannot help them — which is the no-route-out loop
 * this whole series exists to close, in a new costume. So the verdict carries
 * the cure, and `GATE_RECOVERY` keeps the re-affirmation as this gate's table
 * entry for a caller that has only a status.
 */
const SURFACE_REAFFIRM_RECOVERY: ShipGateRecovery = {
  command: "legion approve surface --approver <id>",
  reason:
    "A file a verification surface pins has been edited since the declaration was made, so the declaration no longer " +
    "describes what is on disk. If the edit was intended, re-affirm the declaration against the current bytes: that " +
    "records a named human saying it still describes what they meant, and re-mints the pin. No command re-mints it " +
    "silently, because that would launder an out-of-band edit into a declaration."
};

const SURFACE_BUILD_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "This change declares a verification surface beyond unit, and no evidence records it being exercised. " +
    "Run the build that executes it, then rerun legion ship."
};

const SURFACE_DECLARE_RECOVERY: ShipGateRecovery = {
  command: "legion start --intake",
  reason:
    "Nothing in this change declares a verification surface that reaches an integration or real interface. " +
    "Declare one on an executable acceptance criterion and re-plan, or lower the risk tier through an audited " +
    "risk.override if this change genuinely crosses no boundary."
};

/**
 * A gate's verdict, and — when the gate knows better than `GATE_RECOVERY` can —
 * the command that repairs *this particular* verdict.
 *
 * `recovery` is optional and unset by every gate but one. A gate whose unmet
 * states share a cure declares it once in the table; a gate whose unmet states
 * have different cures answers on the verdict, because that is the only place
 * the distinction exists.
 */
interface GateOutcome {
  readonly status: ShipGateStatus;
  readonly reason: string;
  readonly recovery?: ShipGateRecovery;
}

/**
 * The `integration-surface-check` verdict recorded by this task's latest attempt.
 *
 * Deliberately not `evidenceItemVerdict`, which collapses everything that is not
 * `pass` or `fail` to `undefined` and therefore makes `unknown` — "the run did
 * not reach every declared surface" — indistinguishable from "no such item was
 * written". Those are different facts with different sentences, and this gate is
 * the first that needs to tell them apart.
 *
 * Still read through `latestEvidencePerTask`, for that helper's own reason: a
 * passing item from attempt 1 must not survive an attempt 2 that emitted none.
 */
function surfaceCheckVerdict(
  entries: readonly EvidenceIndexEntry[],
  taskId: string
): string | undefined {
  const entry = latestEvidencePerTask(entries).get(taskId);
  if (entry === undefined) return undefined;
  return entry.evidence.items.find((item) => item.id === INTEGRATION_SURFACE_ITEM)?.verdict;
}

/**
 * The action a verification-surface re-affirmation carries.
 *
 * The same literal `legion approve surface` writes, spelled out in both places
 * rather than shared through a constant, on `DELTA_SPEC_APPROVE_ACTION`'s rule:
 * the gate and the writer are two sides of a contract, and a shared symbol would
 * let a rename move both at once and leave every approval already on disk
 * unreadable by the gate that reads them.
 */
const SURFACE_REAFFIRM_ACTION = "verification.surface.reaffirm";

/** One declared verification surface, where it was declared, and by which task. */
export interface DeclaredSurface {
  /**
   * Every place this one declaration was found, in the operator's terms.
   *
   * A list rather than a string because `legion plan` copies one authored
   * criterion onto both the task contract's verification entry and the oracle
   * that criterion produces, so the overwhelmingly common case is one fact read
   * twice — see `dedupeSurfaces`.
   */
  readonly origins: readonly string[];
  /** Whose evidence answers for it. */
  readonly taskId: string;
  readonly surface: VerificationSurface;
}

/**
 * Two readings of the same authored declaration, or two different declarations?
 *
 * Identity is `kind`, `interface` and the pinned `{path, sha256}` set, sorted —
 * every field an operator authored — and deliberately excludes where the copy
 * was found. `legion plan` writes one criterion's surface onto the task
 * contract's verification entry *and* onto the oracle that criterion produces,
 * so reading both planes finds the same fact twice. Unioning them without this
 * counted one declaration as two: the drift diagnostic read "2 of this task's
 * declared surfaces are unmet" over one file, the satisfied reason read
 * "reached 2 declared surfaces (POST /v1/quote, POST /v1/quote)", and every
 * pinned file was hashed and compared twice.
 *
 * Sorted, because the two copies are `deepStrictEqual` today and a future writer
 * that emits the same pins in a different order would otherwise reintroduce the
 * doubling silently.
 */
function surfaceIdentity(surface: VerificationSurface): string {
  const pins = surface.pinned
    .map((pin) => `${pin.path}@${pin.sha256}`)
    .slice()
    .sort();
  return JSON.stringify([surface.kind, surface.interface, pins]);
}

/**
 * Collapse the copies of one authored surface, keeping every place it was found.
 *
 * Scoped to one task by the caller, and that scope is the whole point. Two
 * *tasks* declaring an identical surface are two criteria that happen to describe
 * the same boundary, and each has its own evidence entry answering for it — so
 * merging across tasks would drop one task's verdict and answer for it with
 * another's. Within a task, the contract copy and the oracle copy are the same
 * authored fact by construction.
 */
function dedupeSurfaces(surfaces: readonly DeclaredSurface[]): readonly DeclaredSurface[] {
  const byIdentity = new Map<string, { origins: string[]; declared: DeclaredSurface }>();
  for (const declared of surfaces) {
    const key = surfaceIdentity(declared.surface);
    const existing = byIdentity.get(key);
    if (existing === undefined) {
      byIdentity.set(key, { origins: [...declared.origins], declared });
      continue;
    }
    existing.origins.push(...declared.origins);
  }
  return [...byIdentity.values()].map((entry) => ({ ...entry.declared, origins: entry.origins }));
}

/**
 * Every verification surface one task declares, across both places one can live.
 *
 * The declaration set spans the task contract's verification entries and the
 * oracles that contract names, because `legion plan` copies one authored
 * criterion into both. Reading only the contract would miss a surface on an
 * oracle whose command the contract never duplicated; reading only the oracles
 * would miss the project's own declared commands. What comes back is deduped by
 * authored identity, so reading both planes reports one declaration once.
 *
 * `unestablished` is not the same as "no surfaces". A task naming an oracle this
 * report could not read has an unknown declaration set, and concluding "nothing
 * declares a surface" from a plane that failed to load is the fail-open every
 * all-or-nothing plane in `ShipGateChangeFacts` exists to prevent — one
 * unreadable oracle would otherwise turn a declared boundary check into silence.
 *
 * `?? []` on both contract fields is load-bearing rather than defensive: the unit
 * fixtures in three suites build a task as `{id, risk}`, and a bare
 * `task.verification.some(...)` would throw a `TypeError` out of
 * `deriveShipGates` — from the reporting command, on the degraded input it exists
 * to describe.
 *
 * The oracle plane is consulted only when the task actually names an oracle. That
 * ordering is deliberate and asserted from outside: it keeps a task with no
 * oracle refs from touching `change.oracles` at all, so the change-fact tripwire
 * in tests/ship-risk-gates keeps its boundary claim over the planes nothing
 * reads yet.
 */
function declaredVerificationSurfaces(input: {
  readonly task: TaskContract;
  readonly taskId: string;
  /**
   * Whole, rather than `change.oracles` pre-read by the caller. Reading the
   * plane at the call site would touch it for every task, including the ones
   * that name no oracle — and "this gate consults the oracle plane only when the
   * contract names an oracle" is a claim the change-fact tripwire holds by
   * throwing on the access itself.
   */
  readonly change: ShipGateChangeFacts | undefined;
}): { readonly surfaces: readonly DeclaredSurface[]; readonly unestablished: string | undefined } {
  const surfaces: DeclaredSurface[] = [];

  for (const [index, entry] of (input.task.verification ?? []).entries()) {
    if (entry?.surface === undefined) continue;
    surfaces.push({
      origins: [`verification entry ${index + 1} of ${input.taskId}`],
      taskId: input.taskId,
      surface: entry.surface
    });
  }

  const oracleRefs = input.task.oracleRefs ?? [];
  let unestablished: string | undefined;
  if (oracleRefs.length > 0) {
    const oracles = input.change?.oracles;
    for (const oracleId of oracleRefs) {
      const fact = oracles?.find((entry) => entry.document.id === oracleId);
      if (fact === undefined) {
        unestablished ??= oracleId;
        continue;
      }
      if (fact.document.surface === undefined) continue;
      surfaces.push({ origins: [`oracle ${oracleId}`], taskId: input.taskId, surface: fact.document.surface });
    }
  }

  return { surfaces: dedupeSurfaces(surfaces), unestablished };
}

/**
 * Has a named human re-affirmed the bytes now at this path?
 *
 * A verification-surface pin is minted once, at `legion start --finalize`, and
 * the whole point of it is that editing the pinned file stops the declaration
 * being believed. Without a way back, though, that made the *honest* operator
 * action unrecoverable: editing the compose file that stands the real service up
 * is exactly the maintenance a live integration check needs, and the first byte
 * of it permanently unsatisfied this gate for every change tracing that
 * requirement, with no command anywhere able to re-mint the pin. A gate with no
 * route out is the defect #77 was written about.
 *
 * Re-affirming a declaration after a legitimate edit is the same *kind* of act
 * as approving a delta spec — a named human saying "yes, this still describes
 * what I meant" — so it is the same artifact and the same rules, read here the
 * way `deltaSpecApprovalStatus` reads its own: scope the plane, let a standing
 * negative beat a grant unless a strictly later grant supersedes it, check
 * expiry against the injected clock, require a human decider, and then require
 * the grant's own pin to still match disk.
 *
 * That last step is what stops this from being a laundering mechanism. The
 * approval pins the bytes the approver looked at; ship re-hashes them; so a
 * re-affirmation covers exactly one revision of the file and the next edit
 * drifts again. It cannot be performed silently either — `legion approve
 * surface` demands `--approver` and resolves it against the project's decision
 * owners, which is what PR 2 refused to skip for delta specs.
 *
 * Keyed by path rather than by surface. The approval re-affirms *bytes*, and two
 * surfaces pinning the same file are asking about the same bytes, so one
 * decision honestly answers for both.
 */
function surfacePinReaffirmation(input: {
  readonly path: string;
  readonly change: ShipGateChangeFacts;
}): { readonly by: string; readonly at: UtcTimestamp } | undefined {
  const approvals = input.change.approvals;
  if (approvals === undefined) return undefined;

  const relevant = approvals.filter(
    (approval) =>
      approval.changeId === input.change.changeId &&
      approval.scope.action === SURFACE_REAFFIRM_ACTION &&
      (approval.artifacts ?? []).some((reference) => reference.path === input.path)
  );
  if (relevant.length === 0) return undefined;

  const live: GrantedApproval[] = [];
  for (const approval of relevant) {
    if (approval.status !== "granted") continue;
    if (approval.decidedBy.kind !== "human") continue;
    if (grantExpiry(approval, input.change.evaluatedAt) !== "live") continue;
    live.push(approval);
  }
  live.sort(byDecisionInstant);
  const newestGrant = live.at(-1);
  if (newestGrant === undefined) return undefined;

  // A standing negative beats the grant unless the grant is strictly later, and
  // a negative with no decision instant can never be shown to be superseded.
  // PR 1's rule, applied unchanged: a revocation of a re-affirmation has to be
  // able to put the drift back.
  const standing = relevant.some(
    (approval) =>
      (approval.status === "denied" || approval.status === "revoked" || approval.status === "expired") &&
      (approval.decidedAt === undefined || approval.decidedAt >= newestGrant.decidedAt)
  );
  if (standing) return undefined;

  const reaffirmed = (newestGrant.artifacts ?? []).find((reference) => reference.path === input.path);
  if (reaffirmed === undefined) return undefined;
  if (input.change.verifyPin(reaffirmed) !== "match") return undefined;

  return { by: newestGrant.decidedBy.id, at: newestGrant.decidedAt };
}

/**
 * Would this one document, alone, make the gate accept a drifted pin at this
 * path against these exact bytes?
 *
 * Exported for `legion approve surface`, which has to answer "is there anything
 * left to decide here" and must not answer it with its own weaker rule. PR 2
 * recorded what that costs: a writer whose idea of "done" is weaker than the
 * reader's idea of "satisfied" reports success, writes nothing, and leaves the
 * change permanently blocked with no flag anywhere that would make it write. So
 * this is not a second implementation — it *calls* `surfacePinReaffirmation`
 * against a one-document plane and asks whether it answers.
 *
 * The one substitution is `verifyPin`, which answers `match` for exactly
 * `currentSha256` and `drift` for anything else. That is not a weakening: it is
 * the same question the ship-time verifier asks, with the digest the caller has
 * just hashed off disk standing in for the hash ship will take later.
 */
export function isLiveSurfaceReaffirmation(input: {
  readonly approval: Approval;
  readonly changeId: string;
  readonly path: string;
  readonly currentSha256: string;
  readonly evaluatedAt: UtcTimestamp | undefined;
}): boolean {
  const reaffirmed = surfacePinReaffirmation({
    path: input.path,
    change: {
      changeId: input.changeId,
      acceptance: undefined,
      approvals: [input.approval],
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: input.evaluatedAt,
      verifyPin: (reference) => (reference.sha256 === input.currentSha256 ? "match" : "drift")
    }
  });
  return reaffirmed !== undefined;
}

/**
 * Is every pinned reference of one declared surface still what it was declared
 * against — or, failing that, what a human has since re-affirmed?
 *
 * The mapping is `approvedDeltaSpecPin`'s and is not re-argued here: `drift` and
 * `missing` are evidence that exists and is negative, so `unsatisfied`;
 * `unverified` means nobody hashed it, so `unevaluable`. The one thing worth
 * repeating is why the check runs at ship time at all — the evidence item was
 * written when the pins were clean and stays `pass` forever, so a gate reading
 * only the verdict is a fail-open against every edit made after the build.
 *
 * `drift` is the one verdict a re-affirmation can answer, and `missing` is
 * deliberately not: `legion approve surface` mints its pin by hashing the file,
 * so there is no document it could ever produce for a path that is not there.
 * Offering the cure for a state it cannot reach would be advice that fails.
 */
function surfacePinStatus(input: {
  readonly declared: DeclaredSurface;
  readonly change: ShipGateChangeFacts | undefined;
}): GateOutcome | undefined {
  const { origins, surface } = input.declared;
  const describe = `The ${surface.kind} surface declared by ${origins.join(" and ")} for ${surface.interface}`;

  if (surface.pinned.length === 0) {
    // Unreachable from a parsed document — `verificationSurfaceSchema` marks
    // `pinned` `.min(1)` — but this function's parameter type admits it, and an
    // empty list passes every pin check vacuously.
    return { status: "unevaluable", reason: `${describe} pins no reference, so there is nothing to check it against.` };
  }

  const change = input.change;
  const verifyPin = change?.verifyPin;
  if (change === undefined || verifyPin === undefined) {
    return {
      status: "unevaluable",
      reason: `${describe} pins ${surface.pinned[0]?.path}, and this report carries no way to re-hash it, so what was declared cannot be compared against what is on disk.`
    };
  }

  for (const pin of surface.pinned) {
    const verdict = verifyPin(pin);
    if (verdict === "match") continue;
    if (verdict === "drift") {
      const reaffirmed = surfacePinReaffirmation({ path: pin.path, change });
      if (reaffirmed !== undefined) continue;
      return {
        status: "unsatisfied",
        reason:
          `${describe} pins ${pin.path}, whose bytes have changed since the declaration was made. ` +
          "If that edit was intended, re-affirm the declaration against the current bytes with legion approve surface --approver <id>.",
        recovery: SURFACE_REAFFIRM_RECOVERY
      };
    }
    if (verdict === "missing") {
      return { status: "unsatisfied", reason: `${describe} pins ${pin.path}, which is no longer present.` };
    }
    return {
      status: "unevaluable",
      reason: `${describe} pins ${pin.path}, which this report did not hash, so what was declared cannot be compared against what is on disk.`
    };
  }

  return undefined;
}

/**
 * Every verification surface the whole change declares, and which oracles this
 * report could not read.
 *
 * Exported because `legion approve surface` has to walk the same set the gate
 * quantifies over. If it walked its own, the command that exists to unblock this
 * gate could re-affirm a pin the gate does not read, or miss one it does — which
 * is the writer/reader drift PR 2 closed by making the writer call the reader.
 * Here the shared thing is the *subject* rather than the predicate, so it is
 * shared as a function rather than restated.
 */
export function changeVerificationSurfaces(input: {
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly change: ShipGateChangeFacts | undefined;
}): { readonly surfaces: readonly DeclaredSurface[]; readonly unreadableOracles: readonly string[] } {
  const surfaces: DeclaredSurface[] = [];
  const unreadableOracles: string[] = [];
  for (const task of input.tasks) {
    const taskId = input.taskIdFor(task);
    const declared = declaredVerificationSurfaces({ task, taskId, change: input.change });
    surfaces.push(...declared.surfaces);
    if (declared.unestablished !== undefined) unreadableOracles.push(declared.unestablished);
  }
  return { surfaces, unreadableOracles };
}

/** What one declared non-unit surface's own evidence and pins say about it. */
function nonUnitSurfaceOutcome(input: {
  readonly declared: DeclaredSurface;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly change: ShipGateChangeFacts | undefined;
}): GateOutcome {
  const { origins, surface } = input.declared;
  const describe = `The ${surface.kind} surface declared by ${origins.join(" and ")} for ${surface.interface}`;

  // Pins first, and this ordering is the gate's whole defence against a stale
  // pass: the evidence item was written when the pins were clean and stays
  // `pass` forever, so a verdict read that ran first would let an edit made
  // after the build be masked by the build's own answer.
  const pin = surfacePinStatus({ declared: input.declared, change: input.change });
  if (pin !== undefined) return pin;

  const verdict = surfaceCheckVerdict(input.entries, input.declared.taskId);
  if (verdict === "pass") {
    return { status: "satisfied", reason: `${describe} was exercised, and every pinned reference still matches.` };
  }
  if (verdict === "fail") {
    return {
      status: "unsatisfied",
      reason: `${describe} is covered by a failed integration-surface-check: a declared non-unit verification command did not pass.`
    };
  }
  if (verdict === "unknown") {
    return {
      status: "unevaluable",
      reason: `${describe} is covered by an integration-surface-check that did not reach every declared non-unit surface, so it may never have been exercised.`
    };
  }
  return {
    status: "unevaluable",
    reason: `${describe} has no integration-surface-check in ${input.declared.taskId}'s latest evidence, so nothing says it was exercised.`,
    recovery: SURFACE_BUILD_RECOVERY
  };
}

/**
 * Did verification reach the relevant integration or real interface **for the
 * change**?
 *
 * ADR-006's wording is "for the change", and getting the altitude wrong here was
 * a specification defect rather than a coding slip. `legion plan` materializes
 * one task per executable criterion, so a task-scoped version of this gate fired
 * the all-unit branch per *criterion*: a change with one criterion reaching a
 * real interface and one honest `unit` criterion was blocked by the honest one.
 * That punishes truthfulness, and an operator who learns that `unit` blocks the
 * ship learns to write `integration` instead — turning the one question this
 * gate asks into a question nobody answers honestly. So the determination is
 * made once, over every task in the change.
 *
 * Three answers:
 *
 *  - **Nothing in the change declares a surface** — `unevaluable`. Every task
 *    contract written before this release is that shape, as is every project
 *    planned without an interview. Nobody said, so nothing is known.
 *  - **Every surface the change declares is `unit`** — `unsatisfied`. A whole
 *    change stating that nothing in it crosses a boundary has *answered* R2's
 *    question, and the answer is no. Reporting that as `unevaluable` would tell
 *    the operator nobody said, which is false and invites the repair of saying it
 *    again.
 *  - **Something crosses a boundary** — at least one declared non-unit surface
 *    must have run, passed, and still pin bytes that match the working tree.
 *
 * The first two are decided from the declarations rather than from the evidence
 * item, and that is not a stylistic choice. `evidenceItemVerdict` maps every
 * verdict that is not `pass`/`fail` to absence, so an all-unit answer expressed
 * as a verdict would arrive here spelled exactly like silence; and the item is
 * written at build time while a replan can change the declarations afterwards.
 *
 * **Aggregation is `some`, not `every`, and that is the deliberate half of the
 * altitude change.** One surface reaching the real interface answers the
 * question the gate asks about the change. A *second* surface that failed is not
 * waved through by that — a failing declared command is already
 * `declared-verification: fail` and `oracle-verification: fail`, both of which
 * block, so folding it in here would make this gate a second copy of those. What
 * this gate uniquely holds is the pin re-check, and a change with no clean
 * passing surface still falls to the negative-then-unknown ordering below.
 */
function integrationSurfaceGateStatus(input: {
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly change: ShipGateChangeFacts | undefined;
}): GateOutcome {
  const { surfaces, unreadableOracles } = changeVerificationSurfaces(input);

  const unreadableOracle =
    unreadableOracles.length === 0
      ? undefined
      : `This change names oracle ${unreadableOracles[0]}, which this report could not read, so whether it declares a verification surface is unestablished.`;

  if (surfaces.length === 0) {
    if (unreadableOracle !== undefined) return { status: "unevaluable", reason: unreadableOracle };
    return {
      status: "unevaluable",
      reason:
        "No task contract or oracle in this change declares a verification surface, so whether verification reached an integration or real interface is unestablished. Declare it on an acceptance criterion at intake and re-plan.",
      recovery: SURFACE_DECLARE_RECOVERY
    };
  }

  const nonUnit = surfaces.filter((declared) => declared.surface.kind !== "unit");
  if (nonUnit.length === 0 && unreadableOracle === undefined) {
    // Only sound over a complete declaration set: with an oracle unread, "all of
    // them are unit" is not established, and that case falls through to the
    // aggregation below where the unreadable oracle is one unevaluable outcome.
    return {
      status: "unsatisfied",
      reason: `Every verification surface this change declares is a unit surface (${surfaces
        .map((declared) => declared.origins.join(" and "))
        .join(", ")}), so nothing in this change reaches an integration or real interface. That is a recorded answer, not a missing one.`,
      recovery: SURFACE_DECLARE_RECOVERY
    };
  }

  const outcomes: GateOutcome[] = nonUnit.map((declared) =>
    nonUnitSurfaceOutcome({ declared, entries: input.entries, change: input.change })
  );
  if (unreadableOracle !== undefined) outcomes.push({ status: "unevaluable", reason: unreadableOracle });

  const met = outcomes.find((outcome) => outcome.status === "satisfied");
  if (met !== undefined) {
    // The unmet ones are *named*, not summarised away and not credited to another
    // gate. A failing declared command is indeed `declared-verification: fail`
    // elsewhere, but a drifted pin on a second surface is this gate's fact and
    // nothing else reports it — so a sentence claiming another gate has it
    // covered would be false in the one case an operator most needs to see.
    const unmet = outcomes.filter((outcome) => outcome.status !== "satisfied");
    const remainder =
      unmet.length === 0
        ? ""
        : ` ${unmet.length} other declared surface${unmet.length === 1 ? " is" : "s are"} unmet, and this gate is satisfied by the one above rather than by them: ${unmet
            .map((outcome) => outcome.reason)
            .join(" ")}`;
    return { status: "satisfied", reason: `${met.reason}${remainder}` };
  }

  // Nothing reached a boundary cleanly. Any `unsatisfied` wins over any
  // `unevaluable`: the negative is the more actionable fact and the one an
  // operator has to answer.
  const negative = outcomes.find((outcome) => outcome.status === "unsatisfied");
  const chosen = negative ?? (outcomes[0] as GateOutcome);
  const remainder =
    outcomes.length > 1 ? ` ${outcomes.length} of this change's declared surfaces are unmet.` : "";
  return { ...chosen, reason: `${chosen.reason}${remainder}` };
}

/**
 * The five cures whole-change acceptance can name, and why it names them itself.
 *
 * Same argument as `SURFACE_REAFFIRM_RECOVERY`'s: `GATE_RECOVERY` holds one
 * command per gate id, and this gate has unmet states with genuinely different
 * repairs. A change nobody signed off needs an accept; a change that *has* been
 * accepted needs a review before a second accept; a change whose latest evidence
 * was never accepted needs a review first too; a change with no evidence for a
 * task needs a build; and a bundle that would not read is not repaired by any of
 * the four.
 *
 * **The accept/re-accept split is the correction of a defect this gate shipped
 * with, and it is the defect PR 3's lesson names by title.** One constant used
 * to answer every unmet state with `legion review --accept --approver <id>`,
 * whose reason claimed the verdict "is re-derived from scratch on every accept —
 * so a recorded block or a sign-off that has gone stale is replaced rather than
 * argued with". That sentence is true of the *promotion*, and false of the
 * command, and the difference is the whole recovery. Every state it was offered
 * for — `ready`, `blocked`, `superseded`, a stale sign-off, a future-dated one —
 * is reachable only *after* an accept has run, and an accept flips every covering
 * review from `submitted` to `accepted`. `cleanSubmittedReviewCoverage` selects
 * only `submitted` reviews, so the second accept exits 1 with `review_not_clean`
 * before it reaches any promotion at all. Measured on the highest-frequency
 * mistake this release introduces: an operator who runs `legion review --accept`
 * and forgets `--approver` records `ready`, and was then handed a command that
 * could not move it.
 */
const ACCEPT_RECOVERY: ShipGateRecovery = {
  command: "legion review --accept --approver <id>",
  reason:
    "No whole-change sign-off has been recorded for this change, and a clean submitted review already covers its " +
    "evidence. Accepting it records one, naming a human decision owner from the project manifest."
};

/**
 * The route out of every state a *previous* accept put the change in.
 *
 * Two commands, in this order, and the first is the one the gate used to omit.
 * `command` names only `legion review` because that is the step that is missing;
 * naming the accept alone is what made five verdicts unreachable, and naming a
 * shell conjunction would put something no runner can dispatch into a field
 * hosts execute.
 */
const RE_ACCEPT_RECOVERY: ShipGateRecovery = {
  command: "legion review",
  reason:
    "A whole-change verdict is already recorded, and `legion review --accept` will not replace it directly: the accept " +
    "that recorded it flipped every covering review from submitted to accepted, and an accept refuses evidence no " +
    "clean *submitted* review covers. Submit a fresh review first, then rerun `legion review --accept --approver <id>` " +
    "— the promotion re-derives the verdict from scratch, so a recorded block or a sign-off that has gone stale is " +
    "replaced rather than argued with."
};

const REBUILD_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "The whole-change sign-off does not cover every task being shipped, because some task has no evidence in this " +
    "change's index. Build it, review it, then accept: a sign-off cannot cover evidence that does not exist."
};

const REVIEW_RECOVERY: ShipGateRecovery = {
  command: "legion review",
  reason:
    "This change was re-run after it was signed off, and the newest evidence has not been accepted. Submit a review " +
    "over it first — legion review --accept refuses to accept evidence no clean submitted review covers — and then " +
    "accept, which re-dates the whole-change sign-off over what is there now."
};

const BUNDLE_RECOVERY: ShipGateRecovery = {
  command: "legion dev change validate <changeId>",
  reason:
    "This change's bundle could not be read, so nothing is known about whether it was accepted. That command reports " +
    "what is wrong with it; it does not repair it — a drifted design, decision log or delta spec is corrected by hand."
};

/**
 * The newest instant at which any of this change's evidence was accepted.
 *
 * Deliberately a maximum over **every** accepted entry in the index, not over
 * the latest entry per task. In an honest history the two are equal — a
 * superseded attempt was always accepted earlier than the attempt that replaced
 * it — and where they differ, the wider one is strictly higher, which is the
 * direction a bar this gate compares a sign-off against should err.
 *
 * Compared as strings everywhere, never through `Date`. `utcTimestampSchema` is
 * a fixed-width `YYYY-MM-DDTHH:mm:ss.SSSZ` with a `toISOString()` round-trip
 * refinement, so byte order is chronological order — the property `grantExpiry`
 * and `earliestExecutionStart` already rely on. `new Date(x).getTime()` on a
 * malformed literal yields `NaN`, and a `NaN` in a comparison is `false` in both
 * directions: safe in one and fail-open in the other, both by accident.
 */
function newestEvidenceAcceptance(entries: readonly EvidenceIndexEntry[]): UtcTimestamp | undefined {
  let newest: UtcTimestamp | undefined;
  for (const entry of entries) {
    if (entry.acceptance.status !== "accepted") continue;
    const acceptedAt = entry.acceptance.acceptedAt as UtcTimestamp | undefined;
    if (acceptedAt === undefined) continue;
    if (newest === undefined || acceptedAt > newest) newest = acceptedAt;
  }
  return newest;
}

/**
 * Is there a record on disk that the actor named in `acceptance.acceptedBy` was
 * a **human** when the sign-off was taken — or is the name the only evidence?
 *
 * Returns the verdict that must replace `satisfied`, or `undefined` when the
 * acceptor is corroborated and the gate may go on to its coverage checks.
 *
 * **The hole this closes.** `acceptanceActorSchema` is a bare
 * `z.string().min(1)` — no `kind`, no link to anything. So `accepted` versus
 * `ready`, the distinction this gate reports and the only thing separating "a
 * named human signed off" from "every task's evidence was accepted", rested on a
 * string that nothing in the facts could check. A future writer, a host, a
 * migration or a hand edit that put `accepted` into a bundle would be read as a
 * human sign-off by a gate holding no evidence of one. `legion ship`'s contract
 * is that it re-reads every plane rather than trusting a recorded conclusion, and
 * this was the one conclusion it took on trust.
 *
 * **The corroborating record already exists and is already in the facts.** The
 * same `legion review --accept --approver` that writes `accepted` writes a
 * granted `workflow.review.accept` approval per task, carrying
 * `decidedBy: {id, kind: "human"}` — a typed actor, in a revisioned artifact,
 * which `ship.ts` loads into `change.approvals` for `explicit_human_approval`.
 * Reading it here to confirm the recorded id is a human actor is **not** the same
 * as requiring `explicit_human_approval`: that gate asks whether a live,
 * unexpired, unrevoked grant covers the review being shipped, and it is an R3
 * gate. This asks only whether anything on disk says the acceptor was a person.
 * Expiry and revocation are deliberately not read — a decision that has since
 * lapsed was still taken by a human, and re-deriving the R3 verdict inside an R2
 * gate is how two gates become one.
 *
 * **What this deliberately does not do**, so the next reader does not add it: it
 * does not re-resolve `acceptedBy` against `.legion/project/project.json`'s
 * decision owners. `legion review --accept` resolves the approver there at write
 * time and refuses a non-human; re-resolving at ship time would mean that
 * removing someone from the manifest — the ordinary act of a person leaving a
 * team — retroactively unmakes every sign-off they ever gave and makes every
 * change they accepted unshippable until re-accepted. A decision taken under the
 * policy in force at the time is not unmade by a later policy edit. What ship
 * owes the operator is the record of the decision, and that is what it now reads.
 */
function acceptorCorroboration(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly acceptedBy: string;
}): GateOutcome | undefined {
  const approvals = input.change?.approvals;
  if (approvals === undefined) {
    return {
      status: "unevaluable",
      reason: `This change records an acceptance by ${input.acceptedBy}, but the approvals recorded for it could not be read, so nothing establishes that the acceptor was a human.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  // A loop rather than a `filter`, on this module's standing rule: behind a
  // predicate the element type widens back off the `granted` member and
  // `decidedBy` reads as possibly-absent, whose only spelling is `decidedBy?.kind`
  // — which renders "undefined" into an operator's diagnostic on the one member
  // where the field cannot be absent.
  const named: GrantedApproval[] = [];
  for (const approval of approvals) {
    // Same strict equality as `humanApprovalStatus`: facts too degraded to name
    // their own change match nothing rather than everything.
    if (approval.changeId !== input.change?.changeId) continue;
    if (approval.scope.action !== REVIEW_ACCEPT_ACTION) continue;
    if (approval.status !== "granted") continue;
    if (approval.decidedBy.id !== input.acceptedBy) continue;
    named.push(approval);
  }
  if (named.length === 0) {
    return {
      status: "unevaluable",
      reason: `This change records an acceptance by ${input.acceptedBy}, but no granted ${REVIEW_ACCEPT_ACTION} approval for this change names that actor, so nothing establishes that the sign-off was taken by a human.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }
  if (!named.some((approval) => approval.decidedBy.kind === "human")) {
    // A positive statement, so a negative verdict. Every approval naming this
    // acceptor records a non-human decider, which is a fact about the sign-off
    // rather than the absence of one.
    const kinds = [...new Set(named.map((approval) => approval.decidedBy.kind))].sort().join(", ");
    return {
      status: "unsatisfied",
      reason: `This change records an acceptance by ${input.acceptedBy}, and every granted ${REVIEW_ACCEPT_ACTION} approval naming that actor records it as ${kinds}, not as a human.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  return undefined;
}

/**
 * Does a whole-change sign-off exist, and does it cover the evidence being
 * shipped?
 *
 * ADR-006 asks whether acceptance evidence covers the *complete change* rather
 * than only an isolated task, and this is the gate that owns the staleness
 * `approvedReviewLink` deliberately declines: whether the work was rebuilt after
 * it was signed off.
 *
 * **Two quantifiers, and each closes a different hole.**
 *
 *  - *Coverage* runs over `tasks` — what is being shipped — resolved through
 *    `latestEvidencePerTask`. Quantifying over entries instead would make a task
 *    added to the graph after the sign-off invisible: it contributes no entry, so
 *    no timestamp comparison can reach it.
 *  - *The bar* runs over every accepted entry; see `newestEvidenceAcceptance`.
 *
 * A timestamp comparison alone is not enough and that is worth stating, because
 * the comparison is what the gate's name suggests. A task rebuilt after sign-off
 * whose new evidence is still `pending` carries **no `acceptedAt` at all**, so
 * nothing about instants can see it, and `[].every()` over an empty coverage set
 * is `true`. Both are vacuous-quantifier fail-opens, and both are closed by the
 * coverage rows below rather than by defaulting a missing bar to `""`.
 *
 * Deliberately out of scope, so the next reader does not add a second copy:
 * whether the evidence *passed* (`deterministic_verification`, `protected_oracle`
 * and `integration_or_real_interface_checks` own those verdicts), whether the
 * review was independent (`task_level_independent_review`), and whether a live,
 * unexpired, unrevoked grant covers the review being shipped
 * (`explicit_human_approval`, which R2 does not derive).
 *
 * What *is* in scope, and was not until review found it missing, is whether the
 * acceptor was a human at all. `acceptedBy` is a bare `z.string().min(1)` with no
 * `kind`, so the `accepted`-versus-`ready` distinction this gate reports rested
 * on a name nothing could check. `acceptorCorroboration` reads the durable record
 * the same accept writes; its docblock states exactly how far that goes and where
 * it stops.
 */
function wholeChangeAcceptanceStatus(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly entries: readonly EvidenceIndexEntry[];
}): GateOutcome {
  const acceptance = input.change?.acceptance;
  // `== null`, not `=== undefined`, and the two characters are the difference
  // between degrading and dying. `changeSchema.acceptance` is required and
  // non-nullable, so `null` cannot reach here from `ship.ts` — but both unit
  // suites call the *compiled* module with hand-built literals, and `legion ship`
  // is the one command that must not throw at an artifact that is already broken.
  // Every other defensive arm in this function is justified on exactly that
  // ground, and `null` was the one literal shape that took the whole report down
  // with a TypeError instead of reporting a gate it could not evaluate.
  if (acceptance == null) {
    // One sentence for both "no facts at all" and "the bundle would not load",
    // on `deltaSpecApprovalGateStatus`'s rule that an absent plane is worth no
    // more than no facts. It must not say "nobody decided": `changeSchema.acceptance`
    // is required, so a bundle that parses always carries one, and `undefined`
    // here means only that nothing could be read.
    return {
      status: "unevaluable",
      reason:
        "The change bundle for this change could not be read, so whether the change as a whole was accepted is unestablished.",
      recovery: BUNDLE_RECOVERY
    };
  }

  if (acceptance.status === "not_ready") {
    return {
      status: "unevaluable",
      reason: `This change's acceptance is recorded as not_ready${
        acceptance.reason === undefined ? "" : ` (${acceptance.reason})`
      }: no accept decision has been made about the change as a whole.`,
      recovery: ACCEPT_RECOVERY
    };
  }
  if (acceptance.status === "ready") {
    return {
      status: "unevaluable",
      reason:
        "This change's acceptance is recorded as ready: every task's evidence was accepted, and no named approver " +
        "signed off on the change as a whole.",
      recovery: RE_ACCEPT_RECOVERY
    };
  }
  if (acceptance.status === "rejected") {
    return {
      status: "unsatisfied",
      reason: `This change's acceptance is recorded as rejected: ${acceptance.reason}`,
      recovery: REBUILD_RECOVERY
    };
  }
  if (acceptance.status === "blocked") {
    return {
      status: "unsatisfied",
      reason: `This change's acceptance is recorded as blocked: ${acceptance.reason}`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }
  if (acceptance.status === "superseded") {
    return {
      status: "unsatisfied",
      reason:
        "This change's acceptance is recorded as superseded, so the recorded sign-off is no longer the current decision.",
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  // **Positive, not residual, and that inversion is the point.** The five arms
  // above return for the five non-`accepted` members of `acceptanceStateSchema`,
  // so falling through used to *mean* `accepted` — which made `satisfied` this
  // gate's default answer for any status it did not recognize, the exact inverse
  // of the invariant the series is built on. `acceptanceStateSchema` is a
  // lifecycle union that PR 10 versions to protocol 0.3.0, and every one of its
  // five non-accepted members permits `acceptedAt`/`acceptedBy` — so a member
  // added later (`withdrawn`, `expired`, `revoked`) would compile cleanly here
  // and ship as satisfied. `humanApprovalStatus` forty lines up is written the
  // right way round (`if (approval.status !== "granted") continue`); this now
  // matches it, and an unrecognized status falls out to `unevaluable`.
  if (acceptance.status !== "accepted") {
    return {
      status: "unevaluable",
      reason: `This change's acceptance is recorded as ${String(
        (acceptance as { readonly status?: unknown }).status
      )}, which this Legion does not recognize as a whole-change verdict; it was written by a newer protocol or by hand.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  // `acceptanceStateSchema` makes both required on the `accepted` member, so
  // TypeScript narrows them non-optional. Read through possibly-absent locals
  // anyway, for the reason the `== null` guard at the top of this function
  // states.
  const acceptedAt = acceptance.acceptedAt as UtcTimestamp | undefined;
  const acceptedBy = acceptance.acceptedBy as string | undefined;
  // **Absent acceptor and absent instant answer the same way, and they did not
  // used to.** `acceptedBy` was read through a `?? "an unnamed actor"` display
  // fallback with no guard behind it, so an `accepted` naming nobody reported
  // `satisfied` with a reason that said so out loud. A gate whose entire verdict
  // is "who signed this off" must not report satisfied when the answer is
  // nobody; the same defensive reasoning that justifies the `acceptedAt` arm
  // below justifies this one, in the same direction.
  if (acceptedBy === undefined || acceptedBy.length === 0) {
    return {
      status: "unevaluable",
      reason:
        "This change records an acceptance with no acceptor, so who signed off on the change as a whole is unestablished.",
      recovery: RE_ACCEPT_RECOVERY
    };
  }
  if (acceptedAt === undefined) {
    return {
      status: "unevaluable",
      reason: `This change records an acceptance by ${acceptedBy} with no instant, so it cannot be compared against the evidence it claims to cover.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  const evaluatedAt = input.change?.evaluatedAt;
  if (evaluatedAt !== undefined && acceptedAt > evaluatedAt) {
    // Strict, so an acceptance stamped in the same millisecond this report was
    // derived — which is what a ship run immediately after an accept looks like
    // on a fast clock — passes. A sign-off dated after the moment it is read
    // cannot be a record of something that happened.
    return {
      status: "unsatisfied",
      reason: `This change records an acceptance by ${acceptedBy} at ${acceptedAt}, later than the instant this report was derived (${evaluatedAt}); a sign-off cannot be dated after the moment it is read.`,
      recovery: RE_ACCEPT_RECOVERY
    };
  }

  // After the future-dated check and before the coverage quantifier. Order
  // matters in one direction only: a sign-off dated after the moment it is read
  // is a positive negative, and a positive negative outranks the absence this can
  // report, so the clock check must not be reachable only through a corroborated
  // acceptor.
  const corroborated = acceptorCorroboration({ change: input.change, acceptedBy });
  if (corroborated !== undefined) return corroborated;

  if (input.tasks.length === 0) {
    return {
      status: "unevaluable",
      reason: "This change records no tasks, so there is no evidence for a whole-change sign-off to cover.",
      recovery: REBUILD_RECOVERY
    };
  }

  const latest = latestEvidencePerTask(input.entries);
  for (const task of input.tasks) {
    const taskId = input.taskIdFor(task);
    const entry = latest.get(taskId);
    if (entry === undefined) {
      return {
        status: "unsatisfied",
        reason: `${acceptedBy} accepted this change at ${acceptedAt}, but ${taskId} has no evidence in this change's index, so the sign-off does not cover it.`,
        recovery: REBUILD_RECOVERY
      };
    }
    if (entry.acceptance.status === "rejected") {
      return {
        status: "unsatisfied",
        reason: `${acceptedBy} accepted this change at ${acceptedAt}, but ${taskId}'s latest evidence ${entry.evidence.id} has since been rejected.`,
        recovery: REBUILD_RECOVERY
      };
    }
    if (entry.acceptance.status !== "accepted") {
      return {
        status: "unsatisfied",
        reason: `${acceptedBy} accepted this change at ${acceptedAt}, but ${taskId}'s latest evidence ${entry.evidence.id} is not accepted, so this change was re-run after the sign-off and the sign-off does not cover what is there now.`,
        recovery: REVIEW_RECOVERY
      };
    }
    if ((entry.acceptance.acceptedAt as UtcTimestamp | undefined) === undefined) {
      return {
        status: "unevaluable",
        reason: `${taskId}'s latest evidence ${entry.evidence.id} is accepted with no acceptedAt, so the instant the whole-change sign-off must cover is unestablished.`,
        recovery: RE_ACCEPT_RECOVERY
      };
    }
  }

  // `>=`, not `>`, and that is not a tolerance being granted. `legion review
  // --accept` computes ONE `acceptedAt` and stamps it on the reviews, on every
  // promoted evidence entry, on the approvals and on this acceptance, so on the
  // happy path the two instants are byte-identical. With `>` no honest R2 change
  // would ever ship.
  const newest = newestEvidenceAcceptance(input.entries) as UtcTimestamp;
  if (acceptedAt >= newest) {
    return {
      status: "satisfied",
      reason: `${acceptedBy} accepted this change at ${acceptedAt}, covering all ${input.tasks.length} task${
        input.tasks.length === 1 ? "" : "s"
      } and every accepted evidence bundle in it (newest accepted at ${newest}).`
    };
  }

  return {
    status: "unsatisfied",
    reason: `${acceptedBy} accepted this change at ${acceptedAt}, which is older than the ${newest} at which this change's task evidence was last accepted: the change was rebuilt and re-accepted per task after the whole-change sign-off, so the sign-off is about work that has since been replaced.`,
    recovery: RE_ACCEPT_RECOVERY
  };
}

function fromVerdict(
  verdict: "pass" | "fail" | undefined,
  itemId: string
): { readonly status: ShipGateStatus; readonly reason: string } {
  if (verdict === "pass") return { status: "satisfied", reason: `Evidence records a passing ${itemId}.` };
  if (verdict === "fail") return { status: "unsatisfied", reason: `Evidence records a failed ${itemId}.` };
  return { status: "unevaluable", reason: `No ${itemId} evidence was recorded for this task.` };
}

function evaluateGate(input: {
  readonly gate: DerivedRiskGate;
  readonly task: TaskContract;
  readonly taskId: string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly reviews: readonly ReviewDecisionSuccess[];
  /**
   * Typed possibly-absent even though `deriveShipGates` requires it, so that
   * every gate arm has to narrow before touching a field. The requirement is a
   * compile-time forcing function on the one production caller; it is not a
   * runtime guarantee, because this module's unit suites call the compiled
   * function with plain literals and no facts at all. Making absence a type
   * makes the guard structural instead of a thing to remember once per gate.
   *
   * Four arms read it now — `explicit_human_approval` the approvals plane,
   * `approved_delta_spec` the deltas, `integration_or_real_interface_checks` the
   * oracles and the pin verifier, and `whole_change_acceptance_evidence` the
   * acceptance and the clock — so the signature is doing the job it was landed
   * for: each gate's diff touches its own `case` rather than this one.
   */
  readonly change: ShipGateChangeFacts | undefined;
  /**
   * Every task of the change, for the one gate whose question is about the
   * change rather than about the task it was derived from.
   *
   * `approved_delta_spec` needed no such thing: `bundle.deltas` is already a
   * whole-change fact. `integration_or_real_interface_checks` asks about the
   * verification surfaces the change declares, and those live on the task
   * contracts — so the change-scoped question genuinely needs every contract,
   * not just the one whose tier derived the gate.
   */
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  const { gate, taskId, entries, reviews } = input;

  switch (gate.id) {
    case "task_contract":
    case "current_task_contract_or_small_change_record":
      return { status: "satisfied", reason: "A typed task contract defines this work." };

    case "deterministic_verification":
      return fromVerdict(evidenceItemVerdict(entries, taskId, "declared-verification"), "declared-verification");

    case "scoped_implementer_run":
      return fromVerdict(evidenceItemVerdict(entries, taskId, "diff-reconciliation"), "diff-reconciliation");

    case "evidence_note":
    case "evidence_bundle_or_log":
      return hasEvidence(entries, taskId)
        ? { status: "satisfied", reason: "A reviewable evidence bundle was recorded." }
        : { status: "unsatisfied", reason: "No evidence bundle exists for this task." };

    case "lightweight_independent_review":
    case "task_level_independent_review":
      // These two keep reading the accepted review, and that is not an
      // oversight left over from the arm `explicit_human_approval` was split
      // out of. They ask whether something other than the implementer looked at
      // the work; a review produced by the review gate and accepted by the
      // workflow answers that. Humanity is a different question, and it now has
      // a different reader.
      return hasAcceptedReview(reviews, taskId)
        ? { status: "satisfied", reason: "An accepted review decision exists for this task." }
        : { status: "unsatisfied", reason: "No accepted review decision exists for this task." };

    case "explicit_human_approval":
      return humanApprovalStatus({ change: input.change, reviews, taskId });

    case "approved_delta_spec":
      // No `taskId`, no `reviews`, no `entries`. That signature is the
      // executable form of this gate being change-scoped: it cannot answer
      // per-task even by accident, because it is not given anything per-task to
      // answer with.
      return deltaSpecApprovalGateStatus({ change: input.change });

    case "protected_oracle":
      // Oracle satisfaction is its own evidence item. It was folded into
      // `declared-verification`, whose verdict answers a different question —
      // "did the contract's own commands pass", not "did the criteria the phase
      // was specified against hold" — so this gate had no producer and any R2+
      // change was structurally unshippable.
      //
      // The oracle artifact is content-hash pinned through `artifactInputs`, so
      // a passing run is a run against the recorded oracle, which is what
      // "protected" asks. `unevaluable` remains the answer for a task that names
      // no oracle, and for one whose referenced oracles were not all evaluated:
      // criteria that were never expressed, or never inspected, are not criteria
      // that held.
      return fromVerdict(evidenceItemVerdict(entries, taskId, "oracle-verification"), "oracle-verification");

    case "integration_or_real_interface_checks":
      // The first arm to read a task contract at all, and the first to read
      // *every* task contract. The declaration this gate is about lives on the
      // contracts' verification entries and on the oracles those contracts name;
      // the question ADR-006 asks is about the change; so the answer is derived
      // once over the whole task list rather than once per task from one of them.
      return integrationSurfaceGateStatus({
        tasks: input.tasks,
        taskIdFor: input.taskIdFor,
        entries,
        change: input.change
      });

    case "whole_change_acceptance_evidence":
      // No `taskId` and no `reviews`, on `approved_delta_spec`'s rule: a
      // change-scoped gate must not be able to answer per task even by accident,
      // so it is not handed anything per task to answer with. `tasks` and
      // `taskIdFor` are the *denominator* — the set the coverage quantifier runs
      // over — rather than a per-task input, and passing one task would make the
      // gate certify a sign-off over the only task it happened to be derived
      // from.
      return wholeChangeAcceptanceStatus({
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor,
        entries
      });

    default:
      // `approved_spec_and_oracle` asks whether the spec and oracle were
      // approved *before* gated execution. A passing post-execution verdict does
      // not answer that: there is no approval record, approver, or ordering
      // timestamp to check, so satisfying it from the oracle result would claim
      // a governance gate was met when no such approval exists.
      //
      // Independent baselines, security/e2e evaluation, release observation and
      // rollback evidence have no producer in the workflow yet.
      return {
        status: "unevaluable",
        reason: "Legion does not yet produce evidence for this gate."
      };
  }
}

/** The verifier substituted when a caller supplied none. Answers nothing. */
const UNRESOLVED_PINS: VerifyPinnedReference = () => "unverified";

/**
 * The runtime guard, applied once, to the whole facts object.
 *
 * `change` is required in TypeScript so the production caller cannot omit it,
 * but TypeScript is not the runtime contract here: both unit suites import the
 * compiled module and call `deriveShipGates` with four keys and no `change`,
 * and `legion ship` degrades to absent facts whenever a change artifact cannot
 * be read. A command whose entire job is honest reporting must not throw at the
 * artifact that is already broken.
 *
 * The `verifyPin` repair looks unreachable to a reader of the types and is not:
 * a hand-written fixture can supply facts without a verifier, and a gate would
 * then throw `TypeError: change.verifyPin is not a function` out of the report.
 * Repairing it once here beats one chance to remember it per gate.
 *
 * Exported because it is otherwise unobservable, and machinery that no test can
 * see is machinery the next change deletes as dead. Two gates now read a change
 * fact, and that still does not give this guard an indirect witness: the tests
 * that supply degraded facts supply them without a `verifyPin`, and every gate
 * answers an absent plane and returns before it would call one. So removing this
 * guard — replacing the call with `input.change` — leaves every gate assertion in
 * the tree green, and the only things that fail are the direct tests at the end
 * of `tests/ship-risk-gates.test.mjs`, which call this function itself. The
 * shape that would actually throw without it is a caller supplying real deltas
 * and a granted, pin-clean approval but no verifier, which nothing in the tree
 * produces; a direct test stands in for it rather than a gate happening to.
 */
/**
 * Every reference a gate in this module can ask `verifyPin` about.
 *
 * Extracted from `legion ship` and exported for one reason: **forgetting a
 * family here fails silently, permanently, and in the direction of looking
 * correct.** A reference nobody collects answers `unverified`, every gate reports
 * `unverified` as `unevaluable`, and `unevaluable` is indistinguishable at the
 * readiness arithmetic from "nothing declared this" — so a ship that re-checks no
 * pin at all looks exactly like a conservative one.
 *
 * It lived inline in `ship.ts` behind a comment claiming an end-to-end drift test
 * would catch a dropped family. Mutation testing disproved that, and the reason
 * is worth recording because it will recur: `oracle-input.ts` copies the
 * criterion's surface — the identical `pinned` array — onto the oracle the
 * criterion produces, and `resolvePinnedReferences` dedupes by path, so *either*
 * of the two verification-surface collectors alone resolved every path the other
 * would have. Deleting one reddened nothing. Only deleting both reddened
 * anything. The claimed tripwire could not trip, and a comment that tells the
 * next reader an edit is covered when it is not is worse than no comment.
 *
 * So the families are separated here and asserted one at a time, against a
 * fixture where contract and oracle deliberately pin *different* paths — the
 * shape parity does not produce today and any of PR 8's oracle work could.
 *
 * `approvals` is the fourth family and the newest. A re-affirmation approval
 * pins the bytes a human looked at when they said the declaration still held;
 * without re-hashing them, `surfacePinReaffirmation` could never confirm one, and
 * the cure this release adds would be a command that writes a record nothing
 * reads.
 */
export function shipGatePinnedReferences(input: {
  readonly deltas: readonly ChangeBundleDeltaEntry[] | undefined;
  readonly oracles: readonly ShipGateOracleFact[] | undefined;
  readonly approvals: readonly Approval[] | undefined;
  readonly tasks: readonly TaskContract[];
}): readonly ArtifactReference[] {
  return [
    // The delta spec bytes `approved_delta_spec` compares an approval against.
    ...(input.deltas?.map((delta) => delta.delta) ?? []),
    // The oracle documents themselves, for PR 5's ordering gate.
    ...(input.oracles?.map((oracle) => oracle.reference) ?? []),
    // The files an oracle's declared verification surface pins.
    ...(input.oracles?.flatMap((oracle) => oracle.document.surface?.pinned ?? []) ?? []),
    // The files a task contract's declared verification surface pins. Ordinary
    // repository files rather than project artifacts, which is the case
    // `pinned-references.ts` resolves paths for itself.
    ...input.tasks.flatMap((task) => (task.verification ?? []).flatMap((entry) => entry.surface?.pinned ?? [])),
    // The bytes any approval was decided against.
    ...(input.approvals?.flatMap((approval) => approval.artifacts ?? []) ?? [])
  ];
}

export function normalizeChangeFacts(change: unknown): ShipGateChangeFacts | undefined {
  if (change === null || typeof change !== "object") return undefined;
  const facts = change as ShipGateChangeFacts;
  if (typeof facts.verifyPin === "function") return facts;
  return { ...facts, verifyPin: UNRESOLVED_PINS };
}

export function deriveShipGates(input: {
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly reviews: readonly ReviewDecisionSuccess[];
  readonly change: ShipGateChangeFacts;
}): ShipGateReport {
  const change = normalizeChangeFacts(input.change);
  const gates: ShipGateResult[] = [];

  for (const task of input.tasks) {
    const taskId = input.taskIdFor(task);
    // A tier override is already audited at the protocol level (from/to,
    // reason, approver, timestamp), so deriving from the effective tier honours
    // an approved waiver without inventing a second waiver mechanism.
    const derived = deriveGateSet({
      tier: task.risk.tier,
      gatesByTier: DEFAULT_RISK_POLICY.gatesByTier
    });

    for (const gate of derived) {
      const outcome = evaluateGate({
        gate,
        task,
        taskId,
        entries: input.entries,
        reviews: input.reviews,
        change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor
      });
      const scope = GATE_SCOPE[gate.id];
      // `...outcome` spreads FIRST, where it used to spread last. Every gate
      // added from here on edits this statement; with the spread last, the day
      // one of them widens `evaluateGate`'s return type to carry a scope or a
      // subject, it would silently override the literal and no diagnostic would
      // appear anywhere. `evaluateGate` owns the verdict; this site owns
      // identity.
      //
      // A change-scoped gate evaluated with no facts falls back to the task id
      // rather than inventing a change id. It is `unevaluable` in that case
      // anyway, and naming a task that exists beats naming a change that does
      // not.
      gates.push({
        ...outcome,
        gate: gate.id,
        label: gate.label,
        taskId,
        scope,
        subjectId: scope === "change" && change !== undefined ? change.changeId : taskId
      });
    }
  }

  const satisfied = gates.filter((entry) => entry.status === "satisfied").length;
  const unsatisfied = gates.filter((entry) => entry.status === "unsatisfied").length;
  const unevaluable = gates.filter((entry) => entry.status === "unevaluable").length;

  // Both unsatisfied and unevaluable block: a required gate that cannot be
  // evaluated has not been met.
  return { gates, satisfied, unsatisfied, unevaluable, ready: unsatisfied === 0 && unevaluable === 0 };
}

export interface ShipGateDiagnostic {
  readonly code: "risk_gate_unsatisfied" | "risk_gate_unevaluable";
  /**
   * Which gate is unmet, machine-readable.
   *
   * The blocked payload is the only ship output an operator on a failing change
   * ever sees, and until now it carried no gate id at all — while the *ready*
   * payload has exposed `riskGates.unevaluableGates` all along. Anything wanting
   * to name a gate had to match the human label inside `message`, which couples
   * an assertion to prose in `@legion/core` that no reader would recognise as a
   * contract. Additive, so nothing that reads `code`, `message` or `path` moves.
   */
  readonly gate: RiskGateId;
  readonly message: string;
  readonly path: string;
}

/**
 * One diagnostic per unmet gate — except that a change-scoped gate is reported
 * once for the change rather than once per task that derived it.
 *
 * Two things about this function are deliberate and both would be defects if
 * done the obvious way.
 *
 * **The collapse is scoped before it is applied.** Deduplicating the whole list
 * by gate id would drop one diagnostic per task on any multi-task change, and
 * nothing in the tree would notice: every assertion on this list checks that it
 * is non-empty or that it contains a particular code, never how many entries it
 * has. A silent behaviour change is exactly what this release must not ship, so
 * the `seen` set is written only for change-scoped gates.
 *
 * `approved_delta_spec` is the first gate to reach that branch in production.
 * Every change `legion plan` can build has exactly one task, so the collapse is
 * not *witnessed* end to end — asserting that a blocked ship names it once
 * passes with or without the collapse — and the witness stays the direct tests
 * below, against a hand-built two-task list.
 *
 * **It lives here rather than inline in the ship command.** Inline, the
 * collapse would be reachable only through the full CLI, and there is no
 * multi-task end-to-end ship fixture anywhere in the tree — so it would land
 * with no coverage and stay uncovered until the first change-scoped gate
 * accidentally exercised it. Exported and pure, it is asserted directly against
 * a hand-built list. Unreachable in production is acceptable only when it is
 * reachable by test.
 *
 * The message interpolates `subjectId`, not `taskId`, and as of this release the
 * two differ: `approved_delta_spec` is change-scoped, so a blocked R2 ship reads
 * "Approved Delta Spec is not satisfied for chg_…" where every other gate still
 * names a `tsk_…`. That is the point of the field and it is a visible change to
 * the blocked payload's prose — anything keyed on the task id appearing in every
 * diagnostic message has one gate that no longer carries it. `CHANGE_SCOPED_GATES`
 * in `tests/ship-risk-gates.test.mjs` is what pins which gates those are.
 */
export function shipGateDiagnostics(input: {
  readonly gates: readonly ShipGateResult[];
  readonly path: string;
}): readonly ShipGateDiagnostic[] {
  const reported = new Set<RiskGateId>();
  const diagnostics: ShipGateDiagnostic[] = [];

  for (const gate of input.gates) {
    if (gate.status === "satisfied") continue;
    if (gate.scope === "change") {
      if (reported.has(gate.gate)) continue;
      reported.add(gate.gate);
    }
    diagnostics.push({
      code: gate.status === "unsatisfied" ? "risk_gate_unsatisfied" : "risk_gate_unevaluable",
      gate: gate.gate,
      message: `${gate.label} is not satisfied for ${gate.subjectId}: ${gate.reason}`,
      path: input.path
    });
  }

  return diagnostics;
}

/**
 * Which command can produce the evidence a gate is missing.
 *
 * A total `Record<RiskGateId, ...>` for `GATE_SCOPE`'s reason: a gate added
 * upstream must not default silently to "no route out", and each of the gates
 * still to gain a producer answers this question on its own line, in its own
 * diff, next to the producer it adds.
 *
 * Until this release the question could not be asked. `legion ship` blocked on
 * ten producerless gates and always advised `legion build`, which was true
 * enough while nothing could satisfy any of them. `approved_delta_spec` is the
 * first gate whose evidence a build can never produce — it reads the approval
 * plane — so continuing to advise a build would send an operator round a loop
 * that cannot end.
 */
const GATE_RECOVERY: Readonly<
  Record<RiskGateId, { readonly command: string; readonly reason: string } | undefined>
> = {
  current_task_contract_or_small_change_record: undefined,
  deterministic_verification: undefined,
  evidence_note: undefined,
  task_contract: undefined,
  scoped_implementer_run: undefined,
  evidence_bundle_or_log: undefined,
  lightweight_independent_review: undefined,
  approved_delta_spec: {
    command: "legion approve spec --approver <id>",
    reason:
      "This change's delta specs are not approved, and no build produces that: the gate reads the approval plane. " +
      "Approve them, then rerun legion ship."
  },
  protected_oracle: undefined,
  task_level_independent_review: undefined,
  // This gate has four unmet states with four different cures, so its verdict
  // carries its own `recovery` and `shipGateRecovery` prefers that over this
  // entry. What stays here is the state a table *can* answer for and the one an
  // operator is most likely to be in: a pinned file legitimately edited after the
  // declaration was made. Leaving it `undefined` would mean a caller holding only
  // a gate id — a payload renderer, a future summary — had no route out of the
  // one state where a route out is the whole point of this release's fix.
  integration_or_real_interface_checks: SURFACE_REAFFIRM_RECOVERY,
  // Four unmet states with four repairs here too, so the verdict carries its own
  // and `shipGateRecovery` prefers that. What stays in the table is the state a
  // caller holding only a gate id can be answered for, and the one every change
  // bundle written before this release is in: `acceptance: {status: "not_ready"}`,
  // which nothing had ever moved.
  whole_change_acceptance_evidence: ACCEPT_RECOVERY,
  independent_baseline: undefined,
  approved_spec_and_oracle: undefined,
  architecture_or_security_review: undefined,
  protected_acceptance_tests: undefined,
  security_or_e2e_evaluator: undefined,
  explicit_human_approval: undefined,
  release_observation_plan: undefined,
  rollback_or_forward_fix_evidence: undefined
};

export interface ShipGateRecovery {
  readonly command: string;
  readonly reason: string;
}

/**
 * The command a blocked ship should advise.
 *
 * Three arms, and the middle one is the one that matters:
 *
 *  - Every unmet gate has the *same* recovery: advise it. Naming one repair when
 *    several are needed is the failure `recoveryFor` in the ship command already
 *    guards against with its own `.every()`.
 *  - Some unmet gates have a recovery and some do not: keep the caller's
 *    fallback command and append the ones that do. This is the honest answer
 *    while nine gates are still producerless — it does not claim one command
 *    unblocks the ship, and it still hands the operator the thread. It is also
 *    the arm every R2 change reaches today.
 *  - Nothing has a recovery: the fallback, unchanged, byte for byte.
 *
 * A gate's own `result.recovery` beats the table. The table is keyed by gate id
 * and therefore cannot distinguish two unmet states of the same gate, which is
 * exactly what `integration_or_real_interface_checks` needs: a drifted pin, an
 * unexercised declaration and an undeclared change each have a different repair.
 * The first unmet result for an id decides, which is precise for a change-scoped
 * gate — one verdict, repeated once per task — and for a task-scoped gate is the
 * same choice the table made before, taken from a result instead of a constant.
 */
export function shipGateRecovery(input: {
  readonly gates: readonly ShipGateResult[];
  readonly fallback: ShipGateRecovery;
}): ShipGateRecovery {
  const unmet = input.gates.filter((gate) => gate.status !== "satisfied");
  if (unmet.length === 0) return input.fallback;

  const recoveries = [...new Set(unmet.map((gate) => gate.gate))]
    .map((id) => unmet.find((gate) => gate.gate === id)?.recovery ?? GATE_RECOVERY[id])
    .filter((entry): entry is ShipGateRecovery => entry !== undefined);
  if (recoveries.length === 0) return input.fallback;

  const distinct = [...new Set(recoveries.map((entry) => entry.command))];
  const only = recoveries[0] as ShipGateRecovery;
  if (distinct.length === 1 && recoveries.length === new Set(unmet.map((gate) => gate.gate)).size) {
    return only;
  }

  return {
    command: input.fallback.command,
    reason: `${input.fallback.reason} Of those, ${distinct.length === 1 ? "one has" : `${distinct.length} have`} a command that can produce the missing evidence: ${distinct.join(", ")}.`
  };
}
