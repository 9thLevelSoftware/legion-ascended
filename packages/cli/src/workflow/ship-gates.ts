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
  UtcTimestamp
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
 * verdict: an R2 or R3 change would report `status: "ready"` while the same
 * payload lists its security, acceptance, release-observation and rollback
 * gates as unproven. "Ready" has to mean the risk tier's gates were met, not
 * that nothing actively failed — a gate with no producer is unmet, and the
 * absence of evidence is not evidence of satisfaction.
 *
 * The consequence is that high-tier changes cannot be called ship-ready until
 * Phase D produces oracles, specs and integration checks. That is the honest
 * state of the product, and the report names exactly which gates are missing.
 * Lowering the tier through an audited `risk.override` is the supported way to
 * ship work whose gates genuinely do not apply.
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
 * No gate is change-scoped yet — `GATE_SCOPE` below maps all twenty ids to
 * `"task"`, which is an accurate statement of what this release produces. The
 * vocabulary lands ahead of its first user so that the change that adds a
 * change-scoped gate is a diff about that gate, rather than a diff that also
 * invents a scope model and a rendering rule.
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
 * Every entry is `"task"` in this release. That is not a placeholder — it is
 * what this release produces — and each later gate flips exactly its own line,
 * next to the gate it implements.
 */
const GATE_SCOPE: Readonly<Record<RiskGateId, ShipGateScope>> = {
  current_task_contract_or_small_change_record: "task",
  deterministic_verification: "task",
  evidence_note: "task",
  task_contract: "task",
  scoped_implementer_run: "task",
  evidence_bundle_or_log: "task",
  lightweight_independent_review: "task",
  approved_delta_spec: "task",
  protected_oracle: "task",
  task_level_independent_review: "task",
  integration_or_real_interface_checks: "task",
  whole_change_acceptance_evidence: "task",
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
   * No arm reads it in this release. That is the point of landing it here: the
   * change that adds the first change-scoped gate touches its own `case`, not
   * this signature.
   */
  readonly change: ShipGateChangeFacts | undefined;
}): { readonly status: ShipGateStatus; readonly reason: string } {
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

    default:
      // `approved_spec_and_oracle` asks whether the spec and oracle were
      // approved *before* gated execution. A passing post-execution verdict does
      // not answer that: there is no approval record, approver, or ordering
      // timestamp to check, so satisfying it from the oracle result would claim
      // a governance gate was met when no such approval exists.
      //
      // Delta specs, integration checks, whole-change acceptance, independent
      // baselines, security/e2e evaluation, release observation and rollback
      // evidence have no producer in the workflow yet.
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
 * see is machinery the next change deletes as dead. Nothing in this release
 * reads a change fact, so removing this guard entirely — replacing the call with
 * `input.change` — leaves every gate assertion in the tree green; the tests that
 * hold it are the direct ones in `tests/ship-risk-gates.test.mjs`, which call
 * this function itself rather than hoping a gate happens to route through it.
 * When the first change-scoped gate lands, those tests stay honest and gain a
 * second, indirect witness.
 */
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
        change
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
 * the `seen` set is written only for change-scoped gates — and since nothing is
 * change-scoped yet, in production it is never written at all.
 *
 * **It lives here rather than inline in the ship command.** Inline, the
 * collapse would be reachable only through the full CLI, and there is no
 * multi-task end-to-end ship fixture anywhere in the tree — so it would land
 * with no coverage and stay uncovered until the first change-scoped gate
 * accidentally exercised it. Exported and pure, it is asserted directly against
 * a hand-built list. Unreachable in production is acceptable only when it is
 * reachable by test.
 *
 * The message interpolates `subjectId`, not `taskId`. That is byte-identical
 * today because every gate this release emits is task-scoped with
 * `subjectId === taskId`, which a unit test pins rather than assumes. Written
 * the other way, the first change-scoped gate would report a verdict about the
 * change under the name of one arbitrary task.
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
      message: `${gate.label} is not satisfied for ${gate.subjectId}: ${gate.reason}`,
      path: input.path
    });
  }

  return diagnostics;
}
