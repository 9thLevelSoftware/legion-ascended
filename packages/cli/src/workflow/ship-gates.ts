import {
  DEFAULT_RISK_POLICY,
  deriveGateSet,
  type DerivedRiskGate,
  type RiskGateId
} from "@legion/core";
import { artifactPathForRole } from "@legion/artifacts";
import type {
  ChangeBundleDeltaEntry,
  EvidenceIndexEntry,
  ReviewDecisionSuccess
} from "@legion/artifacts";
import type {
  AcceptanceState,
  Approval,
  ArtifactReference,
  Attestation,
  AttestationKind,
  EvidenceItem,
  Oracle,
  Release,
  ReleaseEnvironment,
  ReleaseStatus,
  ReviewDecision,
  ReviewFinding,
  TaskContract,
  TaskRun,
  UtcTimestamp,
  VerificationSurface
} from "@legion/protocol";

import { latestEvidencePerTask } from "./evidence-selection.js";
import {
  EVIDENCE_SOURCE_PRODUCERS,
  UNRECOGNISED_SOURCE_HINT,
  type ClassifyEvidenceSource,
  type EvidenceSourceShape
} from "./evidence-sources.js";
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
 * the first tier above R0 for which that is true.
 *
 * **And as of this release every R3 gate has a producer too.** The last one was
 * `release_observation_plan`, which reads a `release.json` written by
 * `legion release plan` — or an audited `release-observation` waiver for a change
 * that deploys nothing. The other nine arrived over the preceding releases:
 * `protected_oracle` and `deterministic_verification` from the evidence items,
 * `explicit_human_approval` from the approval plane, `approved_spec_and_oracle`
 * from the approval plane's ordering, `independent_baseline`,
 * `security_or_e2e_evaluator` and `rollback_or_forward_fix_evidence` from the
 * attestation plane, `architecture_or_security_review` from review domains, and
 * `protected_acceptance_tests` from the guarded harness's acceptance-path
 * observation.
 *
 * So an R3 change carrying all of that reports `ready` end to end, and
 * `tests/change-r3-ordering` drives exactly that sequence through the real CLI.
 * That file also keeps deriving the producerless set from `evaluateGate`'s own
 * `default:` reason string — the set is now empty, and the derivation stays as
 * the tripwire that reddens if any gate regresses to that arm.
 *
 * Lowering the tier through an audited `risk.override` is still the supported way
 * to ship work whose gates genuinely do not apply, and an audited waiver recorded
 * as a `not_applicable` attestation is the per-gate version of the same idea.
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
  /**
   * The audited waiver this gate was satisfied by, when it was satisfied by one.
   *
   * Machine-readable rather than left for `reason` to be matched against,
   * because ship has to echo it and nothing should have to parse prose to find
   * out that a gate passed on a human's sentence rather than on evidence. A
   * satisfied gate emits no diagnostic at all — `shipGateDiagnostics` skips them
   * — so without this the one arm with no falsifiable evidence behind it would
   * be the quietest thing in the payload.
   */
  readonly waived?: ShipGateWaiver;
  /**
   * The recorded human judgement this gate was satisfied by, when it was
   * satisfied by one. `waived`'s rule, for the other evidence-free arm.
   */
  readonly judgement?: ShipGateHumanJudgement;
}

export interface ShipGateReport {
  readonly gates: readonly ShipGateResult[];
  readonly satisfied: number;
  readonly unsatisfied: number;
  readonly unevaluable: number;
  readonly ready: boolean;
}

/**
 * What `legion ship` found on the release plane. See
 * `ShipGateChangeFacts.release` for why this is three states rather than an
 * optional document.
 */
export type ShipGateReleaseFact =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly path: string }
  | { readonly kind: "document"; readonly document: Release };

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
 * The release that introduces the `Attestation` entity adds `attestations`
 * below in the same diff, which is what the paragraph this replaces promised.
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
  /**
   * Every attestation recorded for this change, or `undefined` when the set
   * could not be established.
   *
   * The same three values and the same all-or-nothing rule as `approvals`, and
   * the reason transfers with one degree more force. `legion attest` writes one
   * document per `(change, kind)` and *replaces* it when the assertion is
   * retaken, so a `fail` or a `not_applicable` lives at exactly the path a
   * `pass` used to. A dropped file therefore drops whichever verdict was current,
   * as likely negative as positive, and a gate answering from what the listing
   * kept would answer from a record that had been withdrawn.
   */
  readonly attestations: readonly Attestation[] | undefined;
  /**
   * Every review recorded for this change, or `undefined` when the set could not
   * be established.
   *
   * The same three values and the same all-or-nothing rule as `approvals`, and a
   * *second* reviews channel beside `deriveShipGates`' top-level `reviews`
   * parameter. That deliberate duplication is the whole reason this key exists.
   *
   * The top-level parameter is the raw listing, and until this release
   * `listReviewDecisionsForChange` dropped what it could not read and said
   * nothing. Three gates read that parameter —
   * `lightweight_independent_review`, `task_level_independent_review` and
   * `explicit_human_approval` — and all three ask questions a dropped file can
   * only make *more* conservative, so a short listing was harmless there.
   *
   * `architecture_or_security_review` is the first gate with an `unsatisfied` arm
   * that reads a review: a rejected or blocking-finding domain review, made
   * unparseable, would simply vanish and the gate would answer from the accepted
   * one beside it. So this gate reads the complete set or nothing.
   *
   * The three legacy gates are deliberately left on the raw parameter. Routing
   * them through the complete set would move R1 and R2 verdicts in a diff whose
   * subject is an R3 gate, with the R2 milestone downstream; that residual is
   * named in this release's commit body rather than hidden.
   */
  readonly reviews: readonly ReviewDecisionSuccess[] | undefined;
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
   * first. The listing reports what it skipped and the caller turns any skip
   * into absence, so a gate reading this reads either the whole set or nothing.
   * `approved_spec_and_oracle` is that gate, so as of this release the rule is
   * load-bearing rather than anticipatory: the `artifact_plane_incomplete`
   * diagnostic naming a skipped run file is now something a real blocked ship
   * prints.
   */
  readonly taskRuns: readonly TaskRun[] | undefined;
  /**
   * The release plan recorded for this change, and — separately — whether
   * anybody looked.
   *
   * **Four states, and collapsing any two of them is a fail-open.** The field
   * was `Release | undefined` while it had no reader, which cannot say the
   * difference between "there is no plan" and "there is a document here that
   * will not parse". Both are `unevaluable`, so no verdict moves either way —
   * but they need different sentences, different recoveries, and only one of
   * them may conceal a negative:
   *
   *  - `undefined` — this report did not consult the plane at all. Fixtures, and
   *    the one-plane predicates below. Never a positive.
   *  - `{kind: "absent"}` — consulted; this change has no `release.json`. The
   *    state every change on disk is in, and the one `legion release plan` cures.
   *  - `{kind: "unreadable"}` — consulted; a document is there and would not
   *    read. It may be the one recording a `failed` release, so this
   *    `unevaluable` **conceals a negative** and must not be answered around by
   *    the other producer.
   *  - `{kind: "document"}` — the record.
   *
   * Singular, so unlike `approvals`, `attestations`, `reviews` and `taskRuns`
   * there is no all-or-nothing listing wrapper: a plane with one file has no
   * partial read to refuse. The `unreadable` state is what stands in for it.
   */
  readonly release: ShipGateReleaseFact | undefined;
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
  /**
   * Read the verdict out of an attestation's cited source, off the same bytes
   * `verifyPin` hashed.
   *
   * Injected for `verifyPin`'s reason — reading is I/O and this module is
   * synchronous and pure — and it exists as a *second* function rather than as a
   * widening of `PinVerdict` because the two answer different questions about
   * different populations. `verifyPin` serves delta specs, oracles, approval
   * pins and verification surfaces, which are arbitrary repository files with no
   * shape at all; this serves only the sources an attestation cites, and its
   * question is what the file says rather than whether it moved.
   *
   * It is what stops the writer being the only thing enforcing "a `pass` must be
   * over a report that is actually green". `legion attest` is not the only way a
   * JSON file reaches `.legion/project/changes/<id>/attestations/`, and a gate
   * that trusted the record's own `verdict` field would certify a pass over a
   * red report — PR 2's writer/reader divergence in mirror image.
   *
   * Total and never `undefined`, on `verifyPin`'s rule: `normalizeChangeFacts`
   * substitutes an always-`unread` classifier rather than letting a gate call a
   * non-function.
   */
  readonly classifySource: ClassifyEvidenceSource;
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
 * Eight `"change"` entries as of this release. Each later gate flips exactly its
 * own line, next to the gate it implements.
 *
 * `architecture_or_security_review` is the newest, and its entry was already
 * here — as `"task"` — before it had a producer, so nothing failed to compile
 * when it was wrong. Both of its producers answer for the change: an
 * `architecture-review` attestation is keyed by `(changeId, kind)`, and the
 * review half quantifies over *every* deriving task, so a `subjectId` naming one
 * task would be false about the sentence beside it. Left `"task"` it printed the
 * identical sentence once per criterion-task — the altitude defect
 * `integration_or_real_interface_checks` paid for once and
 * `approved_spec_and_oracle` paid for twice.
 *
 * `independent_baseline`, `security_or_e2e_evaluator` and
 * `rollback_or_forward_fix_evidence` are the three newest, and all three flipped
 * from `"task"` in the release that gave them producers. An `Attestation` is
 * keyed by `changeId`: there is at most one record per kind per change, its
 * `covers` array names which of the change's tasks it claims to speak for, and
 * `independent_baseline` additionally compares against `min(startedAt)` over the
 * change's whole run set. That is one answer for the change in all three cases.
 * Left `"task"` they would print the identical sentence once per criterion-task
 * under a `subjectId` naming a task the sentence is not about — the altitude
 * defect `integration_or_real_interface_checks` below already paid for once, and
 * that `approved_spec_and_oracle` paid for a second time by being left `"task"`
 * through four releases while it had no producer. Nothing forces these lines:
 * the record is total, so an entry that is merely *wrong* still compiles, and
 * `CHANGE_SCOPED_GATES` in `tests/ship-risk-gates.test.mjs` is a deliberate
 * hand-written duplicate that has to move with them.
 *
 * `release_observation_plan` is the newest, and its entry was here — as
 * `"task"` — through every release since the vocabulary landed, so nothing
 * failed to compile while it was wrong. It flips with its producer. Every reading
 * of the gate is change-wide: there is exactly one `release.json` per change, its
 * `taskRefs` are quantified over the whole set of tasks that derive the gate, and
 * the alternative producer is an attestation keyed by `(changeId, kind)`. Left
 * `"task"` it would print the identical sentence once per criterion-task under a
 * `subjectId` naming a task the sentence is not about — the altitude defect
 * `integration_or_real_interface_checks` paid for once and `approved_spec_and_oracle`
 * paid for twice.
 *
 * `protected_acceptance_tests` is the first entry in this
 * record that was already right when its producer arrived. It stays `"task"`, by
 * argument rather than by inertia. The gate's *subject set* is change-wide — the
 * acceptance paths every oracle of the change declares — but its *verdict* is one
 * task's run evidence, because the harness observes a dispatch and a dispatch
 * belongs to a task. Two tasks of one change therefore have two genuinely
 * different answers: one whose run edited a declared test and one whose did not,
 * and collapsing them would name a change as the subject of a sentence about a
 * run. That is the mirror image of the altitude defect below rather than a repeat
 * of it — `integration_or_real_interface_checks` was wrong at `"task"` because
 * its all-unit branch was a property of the whole *plan* fired once per criterion,
 * and this gate's per-task branch is a property of a *run*.
 *
 * `approved_spec_and_oracle` is the newest of the four, and the one whose entry
 * was already here — as `"task"` — before it had a producer. Nothing forces this
 * line: the record is total, so an entry that is merely *wrong* compiles. The
 * verdict quantifies over every delta spec the change ships and every oracle any
 * task references, and compares the last of those decisions against
 * `min(startedAt)` over the change's whole run set. That is one answer for the
 * change. Left `"task"` it would print the identical sentence once per
 * criterion-task and name, in `subjectId`, a task the sentence is not about —
 * which is the altitude defect `integration_or_real_interface_checks` above
 * already paid for once.
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
  independent_baseline: "change",
  approved_spec_and_oracle: "change",
  architecture_or_security_review: "change",
  protected_acceptance_tests: "task",
  security_or_e2e_evaluator: "change",
  explicit_human_approval: "task",
  release_observation_plan: "change",
  rollback_or_forward_fix_evidence: "change"
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
  return earliestExecutionRun(taskRuns)?.startedAt;
}

/**
 * The same minimum, carrying the run that holds it.
 *
 * `approved_spec_and_oracle` has to name the run whose start beat the approval:
 * "gated execution began at <t>" tells an operator a fact they cannot act on,
 * and "run run_… of tsk_… began at <t>" tells them which attempt to look at. The
 * `min` itself is not duplicated — `earliestExecutionStart` is expressed in terms
 * of this, so there is still exactly one implementation and its direct test still
 * covers both.
 *
 * Ties are broken by run id ascending rather than by list order, so two runs
 * stamped in the same millisecond name the same one on every derivation. A
 * sentence whose subject depends on directory read order is a sentence that
 * changes for no reason between two runs of the same command.
 */
export function earliestExecutionRun(taskRuns: readonly TaskRun[] | undefined):
  | { readonly startedAt: UtcTimestamp; readonly runId: string; readonly taskId: string }
  | undefined {
  let earliest: { startedAt: UtcTimestamp; runId: string; taskId: string } | undefined;
  for (const run of taskRuns ?? []) {
    const startedAt = run.startedAt;
    if (startedAt === undefined) continue;
    // `id` and `taskId` are required on every member of `taskRunSchema`, but the
    // unit fixtures in this tree hand `earliestExecutionStart` bare
    // `{startedAt}` literals, and a reason string reading "run undefined" is
    // worse than one that declines to name a run at all.
    const candidate = {
      startedAt,
      runId: (run.id as string | undefined) ?? "an unnamed run",
      taskId: (run.taskId as string | undefined) ?? "an unnamed task"
    };
    if (earliest === undefined) {
      earliest = candidate;
      continue;
    }
    if (startedAt < earliest.startedAt) earliest = candidate;
    else if (startedAt === earliest.startedAt && candidate.runId < earliest.runId) earliest = candidate;
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
 * One subject's approval verdict, and the decision a `satisfied` one rests on.
 *
 * `decidedAt` was added for `approved_spec_and_oracle`, which compares the *last*
 * of the decisions it read against the instant gated execution began. That
 * maximum has to be taken over exactly the grants the gate was satisfied by, and
 * over nothing else: the approvals plane is one flat directory holding every
 * action the approve tree writes, and two of them — `workflow.review.accept` and
 * `verification.surface.reaffirm` — are taken *after* a build by design. A
 * maximum over the plane would therefore exceed `min(startedAt)` on every change
 * that was ever reviewed, and the gate could never be satisfied by anything.
 *
 * Carried on the outcome rather than re-derived by the aggregator, because
 * re-finding "the newest live grant that also survived the standing-negative and
 * expiry rules" is a second implementation of the selection every function below
 * already performs. Present on `satisfied` and absent on everything else: an
 * instant attached to a verdict that is not a grant is a number with no claim
 * behind it.
 *
 * `deltaSpecApprovalStatus` returns it too, although `approved_delta_spec` never
 * reads it. At R3 that gate is not derived at all, so the requirement half of
 * `approved_spec_and_oracle` is the only reader of a `spec.delta.approve` grant
 * there — the alternative to widening this one return type was a second copy of
 * the delta-spec rule inside the new gate.
 */
interface SubjectApprovalOutcome {
  readonly status: ShipGateStatus;
  readonly reason: string;
  /** The instant of the grant a `satisfied` verdict rests on. */
  readonly decidedAt?: UtcTimestamp;
  /**
   * The cure for *this* unmet subject, when it differs from the gate's.
   *
   * Set only by `oracleApprovalStatus`, whose unmet arms genuinely split: an
   * oracle nobody approved is repaired by `legion approve oracle`, and an oracle
   * whose bytes no longer match what was approved is not repaired by any command
   * at all. The delta-spec side sets nothing, because every one of its reachable
   * unmet arms — a standing withdrawal, a lapsed grant, a machine grant, a pin
   * against bytes the change no longer ships — is repaired by the same
   * `legion approve spec`, which is why `GATE_RECOVERY.approved_delta_spec` has
   * been one table entry since PR 2.
   */
  readonly recovery?: ShipGateRecovery;
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
}): SubjectApprovalOutcome {
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
      reason: `Approval ${newestGrant.id} records ${newestGrant.decidedBy.id} approving the delta spec for ${input.delta.requirementId}.`,
      decidedAt: newestGrant.decidedAt
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
  /** Set only by the attestation gates, on their audited-waiver arm. */
  readonly waived?: ShipGateWaiver;
  /** Set only on the human-judgement arm of a kind that has no report shape. */
  readonly judgement?: ShipGateHumanJudgement;
  /**
   * **This `unevaluable` may be hiding a recorded negative, rather than standing
   * for the absence of a claim.**
   *
   * The two are the same status and they are not the same fact, and until a gate
   * combined *two producers* nothing needed to tell them apart: a single
   * producer's `unevaluable` blocks either way. `architecture_or_security_review`
   * reads the review plane OR the attestation plane, and an OR reduced by verdict
   * makes one producer's `satisfied` answer for the other producer's silence —
   * so a `.DS_Store` under `attestations/` collapses that plane to `unevaluable`
   * and a clean domain review then satisfies the gate, discarding the `fail`
   * attestation the dropped listing may have held. That is the
   * favourable-hides-unfavourable fail-open `completeReviews` and the `skipped`
   * field were added one layer down to close, reintroduced by the combination.
   *
   * Set by exactly the arms where the plane itself is in doubt — a listing that
   * came back short, and two hand-filed records of one kind — and never by an arm
   * that read the plane whole and found no claim in it. `combineDomainReviewOutcomes`
   * refuses to let a `satisfied` past one of these; a plain `unevaluable` it still
   * treats as the absence of a claim, because that is what it is.
   *
   * Internal to the combination. `deriveShipGates` drops it before the row is
   * built, so it is never a field of the payload.
   */
  readonly concealsNegative?: true;
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
      attestations: undefined,
      reviews: undefined,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: input.evaluatedAt,
      verifyPin: (reference) => (reference.sha256 === input.currentSha256 ? "match" : "drift"),
      classifySource: UNREAD_SOURCES
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

/**
 * The action an oracle approval carries.
 *
 * The same literal `legion approve oracle` writes, spelled out in both places
 * rather than shared through a constant, on `DELTA_SPEC_APPROVE_ACTION`'s rule:
 * the gate and the writer are two sides of a contract, and a shared symbol would
 * let a rename move both at once and leave every approval already on disk
 * unreadable by the gate that reads them.
 *
 * Matched by **exact equality**, never a prefix. `archiveWithdrawnDecision` mints
 * its copies under `${action}.superseded.r${revision}`, so a `startsWith` or an
 * `includes` would pull every archived withdrawal back into the live set and
 * make the recovery PR 2 built for exactly that case permanently ineffective.
 */
const ORACLE_APPROVE_ACTION = "oracle.approve";

/** The cure when an oracle of the change carries no live grant. */
const ORACLE_APPROVE_RECOVERY: ShipGateRecovery = {
  command: "legion approve oracle --approver <id>",
  reason:
    "An oracle this change's tasks are judged against carries no granted approval, and no build produces one: the gate " +
    "reads the approval plane. Approve every oracle and every delta spec **before** running legion build — this gate " +
    "compares the last of those decisions against the instant the first task run started, and nothing re-orders a " +
    "decision once it has been taken."
};

/** The cure when a delta spec of the change carries no live grant. */
const SPEC_APPROVE_RECOVERY: ShipGateRecovery = {
  command: "legion approve spec --approver <id>",
  reason:
    "This change's delta specs are not approved, and no build produces that: the gate reads the approval plane. At R3 " +
    "`approved_delta_spec` is not derived at all, so this gate is the only reader of a spec.delta.approve grant — " +
    "approve them before running legion build, then rerun legion ship."
};

/**
 * The non-cure for a drifted oracle pin, and why it names `legion ship`.
 *
 * **Nothing in the tree updates an oracle.** `createOracleArtifact` has two
 * callers, both of which create; `updateOracleArtifact` has no CLI caller at all.
 * So an oracle whose bytes no longer hash to what an approval pinned was edited
 * out of band, which is precisely the tampering this gate exists to catch.
 *
 * Re-approving is deliberately not offered, and would be wrong twice over. It
 * would launder an out-of-band edit into a governance record — which
 * `recoveryForDiscovery` already refuses to do for delta specs — and it would
 * stamp a fresh `decidedAt` after execution had started, breaking the very
 * ordering the same command would have been invoked to establish.
 *
 * `legion ship` is named on `recoveryFor`'s precedent in the ship command: when
 * the repair is an edit no verb performs, the action names the artifact to
 * correct and rerunning ship as the confirmation, because ship is the only
 * command that re-reports the defect.
 */
const ORACLE_BYTES_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "An oracle document no longer holds the bytes its approval was granted against. No command in Legion rewrites an " +
    "oracle — legion plan is create-only and nothing else writes one — so the file was edited out of band. Restore it " +
    "to the bytes the approval records, then rerun this to confirm. Re-approving the edited bytes is deliberately not " +
    "offered: it would launder the edit into a governance record and re-date the decision this gate orders."
};

/** The cure when everything is approved and nothing has run yet. */
const ORDERING_BUILD_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "Every delta spec and oracle of this change is approved and no task has run, so there is no execution for those " +
    "decisions to have preceded. This is the one unmet state of this gate a build repairs, and running it now is what " +
    "makes the ordering true."
};

/**
 * The honest answer for `decidedAt >= executionStartedAt`, and the sharpest
 * instance of this series' first lesson.
 *
 * **No command in the tree repairs this state**, and every plausible candidate
 * was checked rather than assumed. `writeTaskRun`'s only callers are the two in
 * `legion build`; nothing rewinds, deletes or supersedes a run. `legion plan` is
 * create-only and exits `artifact_already_exists` against a change that exists.
 * `legion dev change repoint` rewrites the taskgraph with `tasks` untouched.
 * And re-approving writes a *later* `decidedAt`, which makes the ordering
 * strictly worse — so naming any `legion approve` verb here would reproduce the
 * defect PR 4 found, where five verdicts named a command that exits 1 in all
 * five, in the one place where the named command would exit 0 and still leave
 * the change unshippable forever.
 *
 * So the recovery names the two things that genuinely move it: plan the
 * remaining work as a new change and approve its spec and oracles before
 * building it, or lower the tier through an audited `risk.override`.
 * `SURFACE_DECLARE_RECOVERY` names the same command and the same override for
 * the same reason.
 */
const ORDERING_REPLAN_RECOVERY: ShipGateRecovery = {
  command: "legion start --intake",
  reason:
    "A specification approved at or after the work started is not an approval the work was done under, and no command " +
    "re-orders a decision that has already been taken: nothing rewinds or deletes a task run, and re-approving only " +
    "writes a later decision instant. Plan the remaining work as a new change and approve its delta specs and oracles " +
    "before building it, or lower the risk tier through an audited risk.override if this change's ordering genuinely " +
    "does not matter."
};

/**
 * The advice every command that routes towards `legion build` owes an R3 change.
 *
 * **`legion build` is a one-way door at R3 and nothing said so.** Adversarial
 * review drove a fresh R3 intake through the real CLI following only the tool's
 * own `Next:` lines — `legion start --finalize` → `legion plan 1` → `legion build`
 * → `legion review` → `legion review --accept` → `legion ship` — and reached a
 * change on which `approved_spec_and_oracle` can never be satisfied, advised there
 * by three separate commands, none of whose payloads contained the string
 * "approve". `commands/approve.md` documents "Runs between legion plan and legion
 * build"; no CLI output pointed at it. A gate with a producer that the workflow
 * never reaches in time has no producer.
 *
 * So this constant lives beside the gate rather than in each command: `legion
 * plan`, `resolveWorkflowState` (which is what `legion status` renders) and
 * `legion ship`'s pre-build refusal all render it, and the sentence they render is
 * the gate's own.
 *
 * It names the spec verb rather than the oracle verb because the two are a chain
 * and the spec half comes first — `legion approve spec` on an R3 change routes on
 * to `legion approve oracle`, which routes on to `legion build`. Naming both here
 * would put a shell conjunction in `nextAction.command`, which hosts dispatch.
 *
 * **`independent_baseline` is named in the reason and not in the command, and the
 * asymmetry is deliberate.** That gate also compares against `min(startedAt)`, so
 * a build closes a door for it too — but unlike `approved_spec_and_oracle` it has
 * a route out afterwards, because ADR-006 permits a waived gate and a
 * `not_applicable` attestation is exempt from the ordering rule for exactly the
 * reason PR 5 recorded: a state with no route out at all is worse than an audited
 * one. So it does not need a link in the pre-build chain to have a reachable
 * producer, and adding one would send every R3 operator to a verb whose only
 * pre-build answer, against this repository's sealed eval corpus, is a waiver.
 * What it does need is for the operator to know the door exists before they walk
 * through it, which is what this sentence is.
 */
export const APPROVE_BEFORE_BUILD_RECOVERY: ShipGateRecovery = {
  command: "legion approve spec --approver <id>",
  reason:
    "This change carries R3 work, and R3 derives approved_spec_and_oracle: the gate compares the last approval of its " +
    "delta specs and oracles against the instant its first task run started. legion build is a one-way door here — " +
    "nothing re-orders a decision already taken, so a change built before it is approved can never satisfy that gate. " +
    "Approve the delta specs, then the oracles with legion approve oracle --approver <id>, and build after that. R3 " +
    "also derives independent_baseline, which compares an attestation's instant against the same run start: capture " +
    "and attest a baseline before building if this change is to satisfy that gate on evidence rather than on an " +
    "audited waiver. R3 further derives protected_acceptance_tests: if this work has to modify an acceptance test its " +
    "own oracles protect, record that with legion approve protected-paths --approver <id> before building, because " +
    "that decision has to predate the run too."
};

/** Does any task of this change derive the ordering gate? */
export function derivesApprovalOrderingGate(tasks: readonly TaskContract[]): boolean {
  return derivesShipGate(tasks, "approved_spec_and_oracle");
}

/**
 * Does any task of this change derive a named gate?
 *
 * Generalised from the function above rather than copied beside it: a second
 * approve subject with a pre-run ordering rule needs exactly the same question
 * about a different gate id, and two loops would be two chances for one of them
 * to consult a different policy. `derivesApprovalOrderingGate` is kept as a
 * one-line call so no existing call site moves.
 */
export function derivesShipGate(tasks: readonly TaskContract[], gateId: RiskGateId): boolean {
  return tasks.some((task) =>
    deriveGateSet({ tier: task.risk.tier, gatesByTier: DEFAULT_RISK_POLICY.gatesByTier }).some(
      (gate) => gate.id === gateId
    )
  );
}

/**
 * The non-cure for a change artifact that would not load.
 *
 * Named separately from the table entry rather than left to it, because
 * `GATE_RECOVERY[approved_spec_and_oracle]` is `legion approve oracle` and
 * offering that here would be advice that fails: a change whose delta plane,
 * approvals plane or oracle plane could not be read is not repaired by writing
 * one more approval into it, and the writer would refuse for the same reason the
 * gate did.
 *
 * `legion ship` on `recoveryFor`'s precedent in the ship command: when the
 * repair is an edit no verb performs, the action names the artifact to correct
 * and rerunning ship as the confirmation, because ship is the only command that
 * re-reports the defect — and, for a plane the listing merely skipped, the only
 * one that names the file.
 */
const UNREADABLE_PLANE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "A change artifact this gate reads would not load as a complete set, so nothing about what was approved is known. " +
    "No command rewrites a planned artifact — legion plan is create-only — so correct or remove the file the other " +
    "diagnostics in this payload name, then rerun this to confirm the defect is gone. Approving again would not help: " +
    "the writer reads the same planes and refuses for the same reason."
};

/** The cure when the run plane itself could not be established. */
const ORDERING_UNREADABLE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "This change's task runs could not be read as a complete set, so no ordering between an approval and the start of " +
    "execution can be established. The artifact_plane_incomplete diagnostic in this same payload names the file that " +
    "could not be read — remove or correct it, then rerun this."
};

/**
 * The cure for an approval that is about this subject but filed against a task
 * or a run.
 *
 * Separate from `UNREADABLE_PLANE_RECOVERY`, which used to answer this arm and
 * described a state that is not this one: the approvals plane loaded cleanly, so
 * no `artifact_plane_incomplete` diagnostic is emitted, so "correct or remove the
 * file the other diagnostics in this payload name" points at evidence that does
 * not exist — and the document in question is an approval, not a planned
 * artifact. The gate's own reason names the offending approval id; this names
 * what to do with it.
 */
const MISFILED_APPROVAL_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "An approval about this subject also names a task or a run, and this gate reads only change-scoped decisions, so " +
    "it is not read here. No command rewrites an approval's scope — the approve verbs write neither field — so delete " +
    "the approval this verdict names and take the decision again with the approve verb for this subject, then rerun " +
    "this to confirm."
};

/**
 * The recovery an unmet subject can honestly offer, given where execution is.
 *
 * **This is the series' first lesson applied to the one place PR 5's first draft
 * deferred it**, and the deferral's justification was measurably wrong. That draft
 * answered every unmet subject with the approve verb for that subject, whatever
 * the run plane said. Adversarial review drove the consequence end to end: on an
 * R3 change already built, `legion ship` reported this gate `unevaluable` and
 * advised `legion approve spec --approver <id>`; the operator ran it; it exited 0
 * with `status: "approved"` and no warning; and the next `legion ship` reported
 * the same gate `unsatisfied` — permanently, because nothing re-orders a decision
 * already taken. The advertised repair converted a blocked change into an
 * unrepairable one and reported success doing it.
 *
 * So the rule is on the recovery rather than on the status. The status arms keep
 * their order — the more actionable fact first, so an operator who has approved
 * nothing is never told to build — and the *advice* becomes ordering-aware:
 *
 *  - **Nothing has run.** Approving is exactly the repair, and it is still
 *    offered. This is the whole happy path of this release.
 *  - **Execution has begun and the repair is "record a decision now".** That
 *    decision would be stamped at or after `min(startedAt)`, so it cannot satisfy
 *    this gate however many times it is taken. `ORDERING_REPLAN_RECOVERY` is the
 *    honest answer and it is the same one the ordering arm itself gives.
 *  - **Execution has begun and the repair is "restore the bytes".**
 *    `ORACLE_BYTES_RECOVERY` still repairs that state: restoring an oracle to what
 *    its approval pinned re-dates nothing, so a grant taken before the build stays
 *    before the build. Preserved deliberately — collapsing every post-execution
 *    verdict to "re-plan" would throw away the one tampering case that is
 *    genuinely repairable.
 *
 *  - **Whether execution has begun is unestablished.** Also not a state in which
 *    approving can be advised, and the reachable shape of it is not benign: a
 *    change that has never run has no `runs/` directory at all, so
 *    `listTaskRunsForChange` answers `{ok: true, taskRuns: [], skipped: []}` and
 *    the plane is `[]` rather than absent. An *absent* run plane therefore means
 *    the directory exists and something in it would not read — which is a change
 *    that has almost certainly been built. Fix the plane first; only then can this
 *    gate say whether a decision taken now would count.
 *
 * The discriminator is the recovery's own command rather than a new flag on
 * `SubjectApprovalOutcome`, because the property that matters *is* "does this
 * advice write a fresh `decidedAt`", and that is what an approve verb is.
 */
function orderingAwareRecovery(
  recovery: ShipGateRecovery | undefined,
  execution: ExecutionOrdering
): ShipGateRecovery | undefined {
  if (recovery === undefined) return recovery;
  if (!recovery.command.startsWith("legion approve")) return recovery;
  if (execution.kind === "started") return ORDERING_REPLAN_RECOVERY;
  if (execution.kind === "unestablished") return ORDERING_UNREADABLE_RECOVERY;
  return recovery;
}

/** Where this change's execution stands, as far as the run plane can say. */
type ExecutionOrdering =
  | { readonly kind: "none" }
  | { readonly kind: "unestablished" }
  | {
      readonly kind: "started";
      readonly startedAt: UtcTimestamp;
      readonly runId: string;
      readonly taskId: string;
    };

function executionOrdering(taskRuns: readonly TaskRun[] | undefined): ExecutionOrdering {
  if (taskRuns === undefined) return { kind: "unestablished" };
  const earliest = earliestExecutionRun(taskRuns);
  if (earliest !== undefined) return { kind: "started", ...earliest };
  // Runs exist but none of them recorded a start: the set is there and the
  // ordering still is not.
  return taskRuns.length === 0 ? { kind: "none" } : { kind: "unestablished" };
}

/**
 * Is the grant still about the bytes of the oracle this change carries?
 *
 * `approvedDeltaSpecPin`'s shape, widening order and verdict mapping, reused
 * rather than re-argued — with one inversion worth stating, because a reader who
 * knows the delta-spec version will expect the opposite arm to be the reachable
 * one.
 *
 * For a delta spec the byte comparison is the live check and `verifyPin`'s
 * `drift` arm is unreachable, because `loadChangeBundle` refuses a bundle whose
 * delta bytes have moved before `legion ship` derives a gate. For an oracle it is
 * the other way round: `deriveOracleManifest` re-hashes the file on every read,
 * so `oracle.reference.sha256` *is* what is on disk and it is the byte comparison
 * that fires — the approval pinned one digest and the change now carries another.
 *
 * **`verifyPin` is therefore a second opinion here, and only ever a falsifier.**
 * It cannot be reached with a digest that disagrees with the oracle's, because
 * the comparison above has already returned `stale` for that case, so its only
 * reachable contributions are `drift` and `missing` — which say that the file
 * moved *between* `loadOracleFacts` hashing it and `resolvePinnedReferences`
 * hashing it, inside one ship run. That is a real window and a real check.
 *
 * **`unverified` is `current`, not `unknown`, and this is a correction.** The
 * first draft mapped it to `unknown`, which made the gate report `unevaluable`
 * for an oracle whose digest had *already* been compared against bytes hashed off
 * disk in this same report. `legion approve oracle` then answered "already
 * approved" over the same document, wrote nothing, exited 0, and `legion ship`
 * repeated the same `unevaluable` forever — the writer/reader divergence loop PR 2
 * closed for delta specs, reopened in the one arm the substitution below was
 * introduced to prevent it in. A missing second opinion is an absent corroboration,
 * not a failed check, and the check that matters was not missing.
 */
function approvedOraclePin(input: {
  readonly approval: GrantedApproval;
  readonly oracle: ShipGateOracleFact;
  readonly changeId: string;
  readonly verifyPin: VerifyPinnedReference;
}): DeltaSpecPinLink {
  const oracleId = input.oracle.document.id;
  const oraclePath = input.oracle.reference.path;
  const artifacts = input.approval.artifacts;
  if (artifacts === undefined) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins no artifact, so which bytes of oracle ${oracleId} were approved is unestablished.`
    };
  }

  const pins = artifacts.filter((reference) => reference.path === oraclePath);
  if (pins.length === 0) {
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins no reference to ${oraclePath}, so it does not say oracle ${oracleId} was approved.`
    };
  }
  if (pins.length > 1) {
    // `artifacts` carries no uniqueness constraint, so a `find` would take
    // whichever duplicate came first and a document pinning both the right
    // digest and a wrong one would sail through.
    return {
      kind: "unknown",
      reason: `Approval ${input.approval.id} pins ${pins.length} references to ${oraclePath}, so which bytes were approved is unestablished.`
    };
  }

  const pin = pins[0] as ArtifactReference;
  if (pin.sha256 !== input.oracle.reference.sha256) {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} was granted against different bytes of oracle ${oracleId} than change ${input.changeId} now carries: the oracle was edited after it was approved.`
    };
  }

  const verdict = input.verifyPin(pin);
  if (verdict === "match") return { kind: "current" };
  if (verdict === "drift") {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} pins ${oraclePath}, whose bytes have changed since it was granted.`
    };
  }
  if (verdict === "missing") {
    return {
      kind: "stale",
      reason: `Approval ${input.approval.id} pins ${oraclePath}, which is no longer present.`
    };
  }
  // `unverified`. The second opinion is absent, and the first one already
  // answered: the digest this pin was compared against was hashed off the bytes
  // on disk by the oracle service in this same report. Returning `unknown` here
  // would make the gate `unevaluable` over a comparison it had already made, and
  // the writer — which has no verifier to offer at all — would keep reporting the
  // same document as approved. See the doc comment above.
  return { kind: "current" };
}

/**
 * Is one oracle approved?
 *
 * `deltaSpecApprovalStatus`'s order, step for step — scope the plane yourself,
 * refuse a misfiled document rather than filtering it away, bucket by loop so the
 * union narrows onto the granted member, let a standing negative beat a grant
 * unless a strictly later grant supersedes it, check expiry against the injected
 * clock, require a human decider, then require the grant to still be about the
 * bytes on disk.
 *
 * **The supersession rule is load-bearing here and is not a bare status scan.**
 * A specification that said "unsatisfied when any approval is denied, revoked or
 * expired" would make this gate permanently unsatisfied on every change that ever
 * recovered from a withdrawal, because `archiveWithdrawnDecision` deliberately
 * leaves a *second* denied or revoked document, with the same targets and the
 * same `decidedAt`, in the same directory. That copy is the record the recovery
 * PR 2 built depends on; reading it as a live negative would delete the recovery.
 *
 * The scoping predicate can name its own subject, unlike the surface one:
 * `approvalTargetReferenceSchema` has had a first-class `{kind: "oracle"}` member
 * since the protocol was written, so no `{kind: "change"}` fallback is needed and
 * an approval about a different oracle of the same change matches nothing.
 */
function oracleApprovalStatus(input: {
  readonly approvals: readonly Approval[];
  readonly changeId: string;
  readonly oracle: ShipGateOracleFact;
  readonly evaluatedAt: UtcTimestamp | undefined;
  readonly verifyPin: VerifyPinnedReference;
}): SubjectApprovalOutcome {
  const oracleId = input.oracle.document.id;
  const relevant = input.approvals.filter(
    (approval) =>
      // Strict equality against a possibly-absent change id, so facts too
      // degraded to name their own change match nothing rather than everything.
      // An oracle id is derived from a phase slug and is not change-scoped, so
      // this is load-bearing rather than belt-and-braces.
      approval.changeId === input.changeId &&
      approval.scope.action === ORACLE_APPROVE_ACTION &&
      approval.scope.targets.some((target) => target.kind === "oracle" && target.id === oracleId)
  );
  if (relevant.length === 0) {
    return {
      status: "unevaluable",
      reason: `No approval records anyone approving oracle ${oracleId}.`,
      recovery: ORACLE_APPROVE_RECOVERY
    };
  }

  const misfiled = relevant.find((approval) => approval.taskId !== undefined || approval.runId !== undefined);
  if (misfiled !== undefined) {
    // Named rather than filtered away in silence. A silent filter would report
    // this as "nobody approved this oracle", which sends the operator to approve
    // something that already has a record.
    return {
      status: "unevaluable",
      reason: `Approval ${misfiled.id} names ${misfiled.taskId ?? misfiled.runId}, but an oracle belongs to the change rather than to one task or run, so this approval is not read here.`,
      recovery: MISFILED_APPROVAL_RECOVERY
    };
  }

  const live: GrantedApproval[] = [];
  const lapsed: GrantedApproval[] = [];
  const unknownExpiry: GrantedApproval[] = [];
  const nonHumanGrants: GrantedApproval[] = [];
  for (const approval of relevant) {
    // Positive, never `if (status === "denied")`: an unrecognized status must
    // fall out of the granted bucket rather than into it.
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
          ? `Approval ${blocking.id} for oracle ${oracleId} is ${blocking.status}.`
          : `Approval ${blocking.id} for oracle ${oracleId} is ${blocking.status}, and no later grant supersedes it.`,
      recovery: ORACLE_APPROVE_RECOVERY
    };
  }

  if (newestGrant !== undefined) {
    const link = approvedOraclePin({
      approval: newestGrant,
      oracle: input.oracle,
      changeId: input.changeId,
      verifyPin: input.verifyPin
    });
    // `stale` is `unsatisfied` and carries the byte recovery rather than the
    // approve one. This is the tampering arm: the oracle changed after it was
    // approved, and the repair is restoring it, not re-deciding it.
    if (link.kind === "stale") {
      return { status: "unsatisfied", reason: link.reason, recovery: ORACLE_BYTES_RECOVERY };
    }
    if (link.kind === "unknown") {
      return { status: "unevaluable", reason: link.reason, recovery: ORACLE_APPROVE_RECOVERY };
    }
    return {
      status: "satisfied",
      reason: `Approval ${newestGrant.id} records ${newestGrant.decidedBy.id} approving oracle ${oracleId}.`,
      decidedAt: newestGrant.decidedAt
    };
  }

  const spent = lapsed.sort(byDecisionInstant).at(-1);
  if (spent !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${spent.id} for oracle ${oracleId}, granted by ${spent.decidedBy.id}, expired at ${spent.expiresAt}.`,
      recovery: ORACLE_APPROVE_RECOVERY
    };
  }

  const unchecked = unknownExpiry.sort(byDecisionInstant).at(-1);
  if (unchecked !== undefined) {
    return {
      status: "unevaluable",
      reason: `Approval ${unchecked.id} for oracle ${oracleId} expires at ${unchecked.expiresAt}, and this report carries no clock to check that against.`
    };
  }

  const byMachine = nonHumanGrants.sort(byDecisionInstant).at(-1);
  if (byMachine !== undefined) {
    return {
      status: "unsatisfied",
      reason: `Approval ${byMachine.id} for oracle ${oracleId} was granted by ${byMachine.decidedBy.kind} ${byMachine.decidedBy.id}, not by a human.`,
      recovery: ORACLE_APPROVE_RECOVERY
    };
  }

  return {
    status: "unevaluable",
    reason: `An approval for oracle ${oracleId} is recorded as requested and has not been decided.`,
    recovery: ORACLE_APPROVE_RECOVERY
  };
}

/** Which oracles this change's work is actually judged against, resolved. */
export interface ChangeOracleDemand {
  /** One entry per distinct oracle id some task names, resolved to its facts. */
  readonly referenced: readonly {
    readonly oracleId: string;
    readonly taskIds: readonly string[];
    readonly fact: ShipGateOracleFact;
  }[];
  /** Ids named by a task that resolve to no oracle document at all. */
  readonly unresolved: readonly { readonly oracleId: string; readonly taskId: string }[];
  /** Oracle documents in the change that no task names. */
  readonly unreferenced: readonly string[];
}

/**
 * The oracles the change's tasks demand, not the oracles its directory supplies.
 *
 * **This is PR 0's deferred question, answered.** That commit left the
 * oracle-directory case open in its own words: `deriveOracleManifest` maps ENOENT
 * on `.legion/project/changes/<id>/oracle/` to `{ok: true}` with an empty
 * manifest, `loadOracleFacts` turns that into `[]` rather than `undefined`, and
 * "every oracle is approved" is vacuously true over an empty list. It offered two
 * routes: distinguish "declares none" from "directory deleted" in the oracles
 * service, or require a non-empty oracle set before this gate can report
 * satisfied.
 *
 * **Neither of those two closes the hole, and both were measured before this was
 * written.** `deriveOracleManifest` reports `{ok: true, status: "derived"}` with a
 * *short* list when one oracle file of three is deleted, and it carries no
 * `skipped` field of any kind — it is the only plane in the tree where "the
 * listing dropped something" is invisible to its caller. So an ENOENT flag would
 * still report `derived` on that repository, and a bare non-emptiness rule still
 * passes over three-minus-two survivors. Both routes defend the empty set and
 * leave the short one.
 *
 * So the quantifier runs over the **demand** side instead, and the demand side is
 * immune to every failure mode of the supply side for three structural reasons:
 *
 *  - `taskContractSchema.oracleRefs` is `.min(1)`, so no task can contribute an
 *    empty set.
 *  - `oracleRefs` lives in `taskgraph.json`, a different file from the oracle
 *    directory, so deleting, renaming or `.bak`-ing an oracle cannot shrink it.
 *  - A ref that resolves to nothing is a *positive, falsifiable* signal — this
 *    change names an oracle it cannot show you — rather than an absence, which is
 *    the difference between a gate that reports the deletion and one that is
 *    silently satisfied by it.
 *
 * It is `declaredVerificationSurfaces`' `unestablished` shape, applied to the
 * question it was already the right shape for. Exported because
 * `legion approve oracle` has to walk exactly the set this gate quantifies over,
 * on `changeVerificationSurfaces`' recorded argument: a writer walking its own
 * smaller set could approve an oracle the gate does not read, or miss one it
 * does.
 *
 * The residual, stated rather than implied: an oracle file the listing silently
 * dropped and *no task names* is still invisible to everything. This gate is
 * immune to it — an unnamed oracle was never part of the question — but
 * `protected_oracle` is not, and adding `skipped` to `OracleManifestSuccess` is a
 * change to a public result type with four consumers, which belongs in the diff
 * whose subject is the oracle plane rather than in this one.
 *
 * Ids are deduped and sorted, so "the first unmet one" is stable rather than an
 * accident of task order.
 */
export function changeOracleDemand(input: {
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly change: ShipGateChangeFacts | undefined;
}): ChangeOracleDemand {
  const namedBy = new Map<string, string[]>();
  for (const task of input.tasks) {
    const taskId = input.taskIdFor(task);
    for (const oracleId of task.oracleRefs ?? []) {
      const tasks = namedBy.get(oracleId) ?? [];
      if (!tasks.includes(taskId)) tasks.push(taskId);
      namedBy.set(oracleId, tasks);
    }
  }

  const oracles = input.change?.oracles;
  const referenced: { oracleId: string; taskIds: readonly string[]; fact: ShipGateOracleFact }[] = [];
  const unresolved: { oracleId: string; taskId: string }[] = [];
  for (const oracleId of [...namedBy.keys()].sort()) {
    const taskIds = namedBy.get(oracleId) as string[];
    const fact = oracles?.find((entry) => entry.document.id === oracleId);
    if (fact === undefined) {
      unresolved.push({ oracleId, taskId: taskIds[0] as string });
      continue;
    }
    referenced.push({ oracleId, taskIds, fact });
  }

  const unreferenced = (oracles ?? [])
    .map((entry) => entry.document.id)
    .filter((oracleId) => !namedBy.has(oracleId))
    .sort();

  return { referenced, unresolved, unreferenced };
}

/**
 * Were the spec and the oracle both approved **before** gated execution
 * proceeded?
 *
 * ADR-006's question, and the one the whole approval artifact was built for. It
 * is not "was it approved" — `approved_delta_spec` asks that, and R3 does not
 * even derive it — but "was it approved *first*". A specification decided after
 * the work started is not a specification the work was done under.
 *
 * **`executionStartedAt` is `min(startedAt)` over the change's complete run
 * set**, and each half of that is a decision:
 *
 *  - *`min`, not `max`.* `legion review --auto` calls the build inside the
 *    ordinary fix cycle, `nextAttemptMap` bumps the attempt, and `runIdForTask`
 *    puts attempt 2 in a new directory while attempt 1's record is untouched. So
 *    under `max` the sequence build → approve → rebuild satisfies this gate, and
 *    that sequence is not an exotic attack: it is the normal retry loop. `min` is
 *    also monotone in the safe direction — a run added later can only move the
 *    boundary earlier.
 *  - *Complete, not partial.* Every run the set is missing pushes `min` later, and
 *    later is the direction that makes a late approval look early.
 *
 * **What "complete" can and cannot mean here, corrected.** The first draft of this
 * comment claimed that `ship.ts` "turns any skip into absence" and that this gate
 * therefore "reads either the whole set or nothing, and says which". Adversarial
 * review falsified both, end to end: `listTaskRunsForChange` records `skipped`
 * only for directories it *saw and could not read*, so a `rm -rf` of the earliest
 * run directory — or replacing it with a plain file, which
 * `entries.filter((c) => c.isDirectory())` drops before the skip loop ever runs —
 * left no trace anywhere, `min(startedAt)` moved later, and an approval taken
 * after the build read as one taken before it. The gate flipped from
 * `unsatisfied` to `satisfied` because a directory was deleted, which is the
 * fail-open this gate exists to be.
 *
 * The run plane is the one plane this verdict rests on and the only one nothing
 * content-pins: `validateChangeTraceability` catches an edited oracle, delta spec
 * or taskgraph before gates are ever derived, and catches nothing about `runs/`.
 * So completeness is now a *positive, corroborated* claim rather than the absence
 * of a reported skip — `corroboratedTaskRuns` in `ship.ts` cross-checks the set
 * against the evidence index and against its own attempt numbering, and hands this
 * gate `undefined` when they disagree. Its doc comment states the bound, including
 * the one deletion no record in the repository can falsify.
 *
 * **The maximum on the other side is taken over the grants this gate was
 * satisfied by, never over the approvals plane.** That plane is one flat
 * directory holding every action the approve tree writes, and two of them —
 * `workflow.review.accept` and `verification.surface.reaffirm` — are taken after
 * a build by design. A maximum over it could never be less than `min(startedAt)`
 * on any change that had been reviewed, and the gate would be unsatisfiable.
 *
 * **`>=` fails.** Both stamps are millisecond wall-clock, so equal instants are
 * reachable, and three existing rules in this tree already put that boundary on
 * the blocking side: `grantExpiry` spends a grant that expires exactly now,
 * both supersession filters leave a negative standing at an equal instant
 * ("an unorderable pair is not evidence that the grant came second"), and
 * `archiveWithdrawnDecision` refuses at `>=`. The one counter-example in this
 * file — `wholeChangeAcceptanceStatus`, which *satisfies* at `>=` — does not
 * transfer, and it is worth saying why: there one command computes one instant
 * and stamps it on both sides, so with `>` no honest change would ship. Here no
 * writer produces the equal pair on any happy path, because `legion approve
 * oracle` writes no runs and `legion build` writes no approvals. Strictness costs
 * nothing honest here and would cost everything there.
 *
 * **The ordering arm runs last, after every subject is satisfied**, and that
 * order is not cosmetic. Run first, it would answer an operator who has approved
 * nothing with "run legion build" — which is not merely unhelpful but actively
 * destructive, since building is exactly what makes the ordering unrepairable.
 * It is also the module's standing aggregation rule: the more actionable fact
 * first.
 *
 * **The arm order is right and it was not sufficient**, which is the other half of
 * what review found. Ordering the *statuses* stops the gate advising a build; it
 * does nothing about advising an approval that the ordering has already made
 * pointless. So the advice on every unmet subject now passes through
 * `orderingAwareRecovery`, and the verdict says in its own sentence when approving
 * can no longer help.
 */
function approvedSpecAndOracleStatus(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  const deltas = input.change?.deltas;
  if (deltas === undefined) {
    return {
      status: "unevaluable",
      reason:
        "The delta specs recorded for this change could not be read, so whether its specification was approved before execution is unestablished.",
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }
  if (deltas.length === 0) {
    // `changeBundleSchema` marks `deltas` `.min(1)`, so this is unreachable from
    // a bundle that loaded — but that is another module's invariant, this
    // function's parameter type admits `[]`, and `[].every(...)` is `true`.
    return {
      status: "unevaluable",
      reason: "This change records no delta specs, so there is no specification to have been approved.",
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }

  const approvals = input.change?.approvals;
  if (approvals === undefined) {
    return {
      status: "unevaluable",
      reason: "The approvals recorded for this change could not be read, so no approval is established.",
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }

  if (input.change?.oracles === undefined) {
    return {
      status: "unevaluable",
      reason:
        "The oracles recorded for this change could not be read, so whether the criteria its work is judged against were approved is unestablished.",
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }

  const change = input.change as ShipGateChangeFacts;
  const demand = changeOracleDemand({ tasks: input.tasks, taskIdFor: input.taskIdFor, change });

  if (demand.referenced.length === 0 && demand.unresolved.length === 0) {
    // The vacuity guard, and PR 0's question in its narrowest form. Unreachable
    // from a parsed task contract — `oracleRefs` is `.min(1)` — and kept because
    // a gate must not inherit its central truth claim from another module's
    // invariant. Never `satisfied`: at R3 a change whose work is judged against
    // no criteria has not answered ADR-006's question, it has skipped it.
    return {
      status: "unevaluable",
      reason:
        "No task of this change references an oracle, so there is no oracle whose approval could have preceded execution.",
      recovery: ORDERING_REPLAN_RECOVERY
    };
  }

  const missing = demand.unresolved[0];
  if (missing !== undefined) {
    // This is what makes `oracles: []` and a short manifest both non-vacuous.
    return {
      status: "unevaluable",
      reason: `Task ${missing.taskId} is judged against oracle ${missing.oracleId}, which is not among the ${
        change.oracles?.length ?? 0
      } oracle document${(change.oracles?.length ?? 0) === 1 ? "" : "s"} this change carries, so whether it was approved cannot be established.`,
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }

  // A task implementing a requirement this change ships no delta spec for is a
  // requirement whose specification nothing in this change ever approved. The
  // delta loop below cannot see it — it quantifies over what the change ships,
  // and the point of this row is what it does not.
  const shipped = new Set(deltas.map((delta) => delta.requirementId));
  for (const task of input.tasks) {
    for (const requirementId of task.requirementIds ?? []) {
      if (shipped.has(requirementId)) continue;
      return {
        status: "unevaluable",
        reason: `Task ${input.taskIdFor(
          task
        )} implements requirement ${requirementId}, which this change ships no delta spec for, so whether its specification was approved cannot be established.`,
        recovery: ORDERING_REPLAN_RECOVERY
      };
    }
  }

  const outcomes: SubjectApprovalOutcome[] = [
    ...deltas.map((delta) => {
      const outcome = deltaSpecApprovalStatus({
        approvals,
        changeId: change.changeId,
        delta,
        evaluatedAt: change.evaluatedAt,
        verifyPin: change.verifyPin
      });
      // Every reachable unmet delta-spec arm is repaired by the same command,
      // which is why `approved_delta_spec` has answered with one table entry
      // since PR 2: a standing withdrawal is archived and superseded by a
      // strictly later grant, a lapsed grant is re-granted without an expiry, a
      // machine grant is re-granted by a human, and a pin against bytes the
      // change no longer ships is re-pinned against the ones it does.
      return outcome.status === "satisfied" ? outcome : { ...outcome, recovery: SPEC_APPROVE_RECOVERY };
    }),
    ...demand.referenced.map((entry) =>
      oracleApprovalStatus({
        approvals,
        changeId: change.changeId,
        oracle: entry.fact,
        evaluatedAt: change.evaluatedAt,
        verifyPin: change.verifyPin
      })
    )
  ];

  // Where execution is, resolved *before* the unmet verdicts are rendered.
  //
  // The status arms below still run in their original order. What this feeds is
  // only the advice: an unmet subject whose repair is "take the decision now" is
  // not repairable once a run exists, and telling the operator to take it anyway
  // is the defect `orderingAwareRecovery` documents in full.
  const execution = executionOrdering(change.taskRuns);

  const unmet = outcomes.filter((outcome) => outcome.status !== "satisfied");
  const negative = outcomes.find((outcome) => outcome.status === "unsatisfied");
  const chosen = negative ?? unmet[0];
  if (chosen !== undefined) {
    const remainder =
      unmet.length > 1
        ? ` ${unmet.length} of the ${outcomes.length} approvals this gate reads are unmet.`
        : "";
    const recovery = orderingAwareRecovery(chosen.recovery, execution);
    // Said in the verdict, not only in the recovery. A blocked ship's gate rows
    // carry `{code, gate, message, path}` and nothing else — the recovery reaches
    // the operator only through the payload's single aggregate `nextAction`, and
    // only when this gate happens to be the one that supplied it. So the fact
    // that approving can no longer help has to be in the sentence the row itself
    // carries, or the operator on a multi-gate block never learns it.
    const late =
      recovery === chosen.recovery
        ? ""
        : execution.kind === "started"
          ? ` Gated execution for this change already began at ${execution.startedAt} (run ${execution.runId} of ` +
            `${execution.taskId}), so a decision recorded now would be dated after the work it claims to gate: ` +
            "approving cannot satisfy this gate."
          : " Whether gated execution for this change has already begun could not be established from its run plane, " +
            "so whether a decision recorded now would count is unknown: repair the run plane before deciding.";
    return {
      ...chosen,
      reason: `${chosen.reason}${remainder}${late}`,
      ...(recovery === undefined ? {} : { recovery })
    };
  }

  // Every subject is approved. Only now is the ordering question worth asking,
  // and only now is a build the right advice.
  const taskRuns = change.taskRuns;
  if (taskRuns === undefined) {
    // Checked on the field rather than on `earliestExecutionStart`'s return,
    // which collapses "the plane could not be read", "the plane is empty" and
    // "no run recorded a start" into one `undefined`. Three worlds, three
    // sentences, and two different repairs.
    return {
      status: "unevaluable",
      reason:
        "Every delta spec and oracle of this change is approved, but its task runs could not be read as a complete set, so no ordering between those decisions and the start of execution can be established.",
      recovery: ORDERING_UNREADABLE_RECOVERY
    };
  }
  if (taskRuns.length === 0) {
    return {
      status: "unevaluable",
      reason:
        "Every delta spec and oracle of this change is approved, and no task of it has run, so there is nothing for those decisions to have preceded.",
      recovery: ORDERING_BUILD_RECOVERY
    };
  }

  const earliest = earliestExecutionRun(taskRuns);
  if (earliest === undefined) {
    return {
      status: "unevaluable",
      reason: `Every delta spec and oracle of this change is approved, and none of its ${taskRuns.length} task run${
        taskRuns.length === 1 ? "" : "s"
      } records when it started, so no ordering can be established.`,
      recovery: ORDERING_UNREADABLE_RECOVERY
    };
  }

  // The mirror of the dropped-run fail-open, in the other direction. A dropped
  // run moves `min(startedAt)` later; a grant whose instant is skipped moves
  // `max(decidedAt)` earlier. Both make a late approval look early, so neither
  // may be a `continue`. Unreachable from a parsed approval — `decidedAt` is
  // required on the granted member — and reachable from a fixture.
  let latest: UtcTimestamp | undefined;
  for (const outcome of outcomes) {
    const decidedAt = outcome.decidedAt;
    if (decidedAt === undefined) {
      return {
        status: "unevaluable",
        reason:
          "One of the approvals this gate reads records no decision instant, so the last of these decisions cannot be compared against the start of execution."
      };
    }
    if (latest === undefined || decidedAt > latest) latest = decidedAt;
  }
  const latestDecision = latest as UtcTimestamp;

  if (latestDecision >= earliest.startedAt) {
    return {
      status: "unsatisfied",
      reason:
        `The last of the ${outcomes.length} approvals this gate reads was decided at ${latestDecision}, which is ` +
        `${latestDecision === earliest.startedAt ? "the same instant as" : "not earlier than"} the ${earliest.startedAt} ` +
        `at which gated execution for this change began (run ${earliest.runId} of ${earliest.taskId}). ` +
        "A specification approved at or after the work started is not an approval the work was done under.",
      recovery: ORDERING_REPLAN_RECOVERY
    };
  }

  return {
    status: "satisfied",
    reason:
      `All ${deltas.length} delta spec${deltas.length === 1 ? "" : "s"} and ${demand.referenced.length} oracle${
        demand.referenced.length === 1 ? "" : "s"
      } of this change were approved before gated execution began: the last of those decisions was taken at ` +
      `${latestDecision} and the earliest run (${earliest.runId} of ${earliest.taskId}) started at ${earliest.startedAt}.`
  };
}

/**
 * Would this one document, alone, satisfy the oracle half of
 * `approved_spec_and_oracle` for this oracle?
 *
 * Exported for `legion approve oracle`, on `isLiveDeltaSpecGrant`'s rule: a
 * writer whose idea of "done" is weaker than the reader's idea of "satisfied"
 * reports success, writes nothing, and leaves the change permanently blocked with
 * no flag anywhere that would make it write. So this is not a second
 * implementation — it *calls* `oracleApprovalStatus` against a one-document plane
 * and asks whether the verdict is `satisfied`.
 *
 * **The verifier this passes is `unverified`, and saying why is the point.** The
 * first draft passed `(reference) => reference.sha256 === fact.reference.sha256 ?
 * "match" : "drift"` and claimed that made it stricter than
 * `isLiveDeltaSpecGrant`'s `() => "match"`. Adversarial review measured that and
 * it was false: `approvedOraclePin` compares the pin against
 * `oracle.reference.sha256` *before* it calls the verifier, so a substitute can
 * only ever be handed the matching digest and can only ever answer `match`. The
 * substitution was a no-op dressed as a check, and the test named for it passed
 * under exactly the mutation it named.
 *
 * `unverified` is the truthful value: this caller hashed nothing, and has no
 * second opinion to offer. `approvedOraclePin` reads that as corroboration-absent
 * rather than as a failed check — which is what makes the writer and the gate
 * agree in the one state where they used to disagree, and is why that mapping is
 * documented there rather than compensated for here.
 *
 * What actually makes this predicate strict is the byte comparison itself: an
 * approval pinning bytes the change no longer carries answers `stale`, so the
 * command re-decides rather than reporting "already approved".
 *
 * **The ordering clause is deliberately excluded**, and that exclusion is the
 * one place this predicate is narrower than the gate. If it carried the
 * comparison, a rerun after execution had started would report `regrant`, write a
 * fresh `decidedAt`, and make the ordering strictly *worse* — the failure
 * `plannedActionFor` has warned about by name since PR 2. `legion approve oracle`
 * closes the resulting silence a different way: it reads the run plane itself and
 * warns, at the one moment the operator could still act on it, that a decision
 * recorded now would be dated after the work it claims to gate.
 */
export function isLiveOracleGrant(input: {
  readonly approval: Approval;
  readonly changeId: string;
  readonly oracle: ShipGateOracleFact;
  readonly evaluatedAt: UtcTimestamp | undefined;
}): boolean {
  const outcome = oracleApprovalStatus({
    approvals: [input.approval],
    changeId: input.changeId,
    oracle: input.oracle,
    evaluatedAt: input.evaluatedAt,
    verifyPin: () => "unverified"
  });
  return outcome.status === "satisfied";
}

// --- the attestation gates --------------------------------------------------

/**
 * Which attestation kinds each gate reads.
 *
 * Exported because `legion attest` warns when it has just written a kind that no
 * gate reads, and the honest way to compute that warning is to ask the reader
 * rather than to keep a second list beside it.
 *
 * **This release adds `release_observation_plan`, and with it every one of
 * `attestationKindSchema`'s seven options is read by some gate.** The
 * `attestation_kind_has_no_reader` warning therefore has no reachable kind left
 * through the CLI, which is the intended end state rather than a gap: the warning
 * stays, because the set is computed from this map and a kind added upstream
 * would reach it again the moment it exists, and `tests/cli-attest` asserts the
 * unread set is empty by deriving it from this module rather than by naming a
 * kind.
 */
export const ATTESTATION_GATE_KINDS: Readonly<Partial<Record<RiskGateId, readonly AttestationKind[]>>> = {
  independent_baseline: ["independent-baseline"],
  security_or_e2e_evaluator: ["security-evaluation", "e2e-evaluation"],
  architecture_or_security_review: ["architecture-review"],
  release_observation_plan: ["release-observation"],
  rollback_or_forward_fix_evidence: ["rollback-evidence", "forward-fix-evidence"]
};

/** Every attestation kind some gate in this module reads. */
export const GATE_READ_ATTESTATION_KINDS: ReadonlySet<AttestationKind> = new Set(
  Object.values(ATTESTATION_GATE_KINDS).flatMap((kinds) => kinds ?? [])
);

/**
 * What can carry a `pass` for each attestation kind. **Three states, and the
 * third is new in this release.**
 *
 *  - `shapes` — a pass must cite a report of one of these shapes, read and green.
 *    The strongest arm and the only machine-checkable one. A per-kind list rather
 *    than one global "any clean report will do", because without it `legion
 *    attest rollback-evidence --source threat-model.json` would satisfy the
 *    rollback gate off a security report.
 *  - `none` — nothing in this repository can evidence a pass, and nothing is
 *    expected to until somebody writes a producer. `pass` is refused at the
 *    writer and `unsatisfied` at the reader, positively, never a default.
 *  - `human-judgement` — the question has no report shape and never will, because
 *    what it asks for is a competent person's opinion rather than a program's
 *    output.
 *
 * A total record of a three-arm union rather than a list whose emptiness means
 * two different things. Under the previous encoding `architecture-review` was
 * spelled `[]`, and both ends read `admissible.length === 0` as a positive
 * refusal — so `legion attest architecture-review --verdict pass` exited 1 while
 * `--verdict not_applicable --waiver-reason <text>` **satisfied the same gate**.
 * An operator who genuinely held an architecture review was told to record that
 * no architecture review applied. That is the defect `GATE_SCOPE`'s comment names
 * one file over: a gate that punishes an accurate answer teaches operators to
 * give an inaccurate one.
 *
 * **What `human-judgement` gives up is stated rather than implied.** Nothing
 * machine-checkable is read, so it is the *second* `satisfied` verdict in this
 * module with no falsifiable evidence behind it — and it carries the audited
 * waiver's machinery for exactly that reason: a human attester is re-checked
 * positively, an authored `--statement` is required at the writer, the pins are
 * re-hashed, no cited source may be a report that is red by its own rule, and
 * ship echoes it as `risk_gate_human_judgement` on the same surfaces the waiver
 * uses. It is strictly *stronger* than the waiver it sits beside: same named
 * human, same recorded instant, same pinned bytes, plus a positive claim instead
 * of a disclaimer.
 *
 * The rest of the table is unchanged and still honest about this repository:
 *
 *  - `e2e-evaluation` — no end-to-end report shape exists here. `apps/cli-e2e`
 *    runs against the change's own built code and writes a log, and recognising
 *    that log is a real bridge a later release can build; a threat model over a
 *    sealed corpus scenario is not that, and pretending otherwise would be the
 *    naming-convention inference this entity exists to replace.
 *  - `forward-fix-evidence` — nothing in the tree produces one.
 *  - `release-observation` — `none`, and this release is where that was decided
 *    rather than deferred. The gate that reads this kind now exists, and its
 *    evidence route is `release.json`: a checkable document with health criteria,
 *    a rollback strategy with criteria, and coverage of every deriving task.
 *    Widening this entry to `human-judgement` would give that gate a second route
 *    that is strictly weaker than the first and bypasses the artifact entirely —
 *    the operator who authors a real observation plan and the operator who writes
 *    a sentence would become indistinguishable. So `legion attest
 *    release-observation --verdict pass` stays refused by `sourceRefusal`'s
 *    `kind_has_no_evidence_shape` arm, and the attestation route into this gate is
 *    **waiver-only**: `not_applicable`, a human attester and a recorded reason,
 *    which is ADR-006's own escape for a change that deploys nothing.
 *
 * `security_or_e2e_evaluator` is therefore satisfiable by evidence only through
 * `security-evaluation`, and `rollback_or_forward_fix_evidence` only through
 * `rollback-evidence`. Both remain satisfiable through the audited waiver, which
 * is ADR-006's own escape and is echoed on every payload that uses it.
 *
 * **And `rollback-evidence` needs a report produced *here*, which today means
 * producing one rather than citing one.** A rollback verdict records the
 * filesystem tree it audited, and `classifyEvidenceSource` compares that to the
 * repository being shipped — so the committed
 * `docs/next/evidence/P13-T03/rollback-policy.json`, taken in a macOS temp
 * directory, is `blocking` here. That artefact was what made this gate look
 * satisfiable off the shelf, and it never was: it is green about a tree that has
 * no `.legion` directory in it. Until somebody runs `legion dev release
 * rollback-verify` against this repository and commits the result,
 * `rollback_or_forward_fix_evidence` is a waiver-or-nothing gate, and saying so
 * is the point — a gate satisfied by another checkout's audit is worse than one
 * nobody can satisfy.
 */
export type AttestationEvidenceRule =
  | { readonly kind: "shapes"; readonly shapes: readonly EvidenceSourceShape[] }
  | { readonly kind: "none" }
  | { readonly kind: "human-judgement" };

const ATTESTATION_EVIDENCE_RULES: Readonly<Record<AttestationKind, AttestationEvidenceRule>> = {
  "independent-baseline": { kind: "shapes", shapes: ["ab-comparison"] },
  "security-evaluation": { kind: "shapes", shapes: ["threat-model"] },
  "e2e-evaluation": { kind: "none" },
  "architecture-review": { kind: "human-judgement" },
  "rollback-evidence": { kind: "shapes", shapes: ["rollback-policy"] },
  "forward-fix-evidence": { kind: "none" },
  "release-observation": { kind: "none" }
};

export function attestationEvidenceRule(attests: AttestationKind): AttestationEvidenceRule {
  return ATTESTATION_EVIDENCE_RULES[attests];
}

/** The verb that records the first attestation of a kind for a change. */
function attestCommand(kinds: readonly AttestationKind[]): string {
  return `legion attest ${kinds[0] as string} --attested-by <id> --source <path>`;
}

/** The cure when nothing at all attests this question for the change. */
function attestRecovery(gate: RiskGateId, kinds: readonly AttestationKind[]): ShipGateRecovery {
  const alternatives =
    kinds.length === 1 ? "" : ` (or ${kinds.slice(1).join(", ")}, which this gate reads too)`;
  return {
    command: attestCommand(kinds),
    reason:
      `Nothing in this change asserts ${gate}, and no build produces one: the gate reads the attestation plane. ` +
      `Record a ${kinds[0]} attestation${alternatives} citing the report it rests on — legion attest re-reads that ` +
      "report and refuses a pass over one that is red, and legion ship re-hashes it. If the check genuinely does not " +
      "apply to this change, record that instead with --verdict not_applicable --waiver-reason <text>, which ADR-006 " +
      "permits as an audited waiver and which this command echoes as a warning on every payload that carries one."
  };
}

/**
 * The cure when a cited source's bytes have moved or gone.
 *
 * `ORACLE_BYTES_RECOVERY`'s argument, applied to a different plane and for the
 * same reason: re-attesting over the edited bytes would launder an out-of-band
 * edit into a governance record. The repair is restoring the file, and ship is
 * what re-reports whether it worked.
 */
const ATTESTATION_BYTES_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "An attestation cites a file that no longer holds the bytes it was recorded against. Restore the file to the " +
    "bytes the attestation pins, then rerun this to confirm. Re-attesting the edited bytes is deliberately not " +
    "offered: an attestation's whole content is 'these exact bytes are this change's evidence', so re-pinning " +
    "whatever is there now would launder the edit into the record that was supposed to catch it."
};

/**
 * The cure when the cited report is red.
 *
 * Named separately from the absence cure, because attesting again cannot help:
 * `legion attest` reads the same file and refuses the same pass. What moves this
 * is producing a green report.
 */
const ATTESTATION_EVIDENCE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "An attestation records a pass over a report whose own verdict is negative, and legion ship re-reads that report " +
    "rather than trusting the record. Attesting again cannot move this — the writer applies the same check and " +
    "refuses the same pass. Re-run the check named in this verdict until it passes, re-attest against the report it " +
    "produces, then rerun this."
};

/**
 * The honest answer for a baseline attested after the run it is supposed to be
 * independent of.
 *
 * `ORDERING_REPLAN_RECOVERY`'s situation exactly, one plane over, and it names
 * the same command deliberately: nothing re-dates an attestation, and attesting
 * again writes a *later* `attestedAt` and makes this strictly worse — the PR 5
 * defect reproduced for a new verb if the absence cure were offered here.
 *
 * The waiver is named in the reason rather than in the command. Both are real
 * routes out and only one is a good outcome, so the field hosts dispatch carries
 * the one that leaves the change honest, and the sentence carries the one ADR-006
 * permits when no baseline applies.
 */
const BASELINE_AFTER_EXECUTION_RECOVERY: ShipGateRecovery = {
  command: "legion start --intake",
  reason:
    "A baseline captured after the run it is supposed to be independent of is not one, and no command re-dates an " +
    "attestation: attesting now writes a later attestedAt and makes this gate strictly worse rather than better. " +
    "Plan the remaining work as a new change and attest its baseline before building it — or, if no independent " +
    "baseline applies to this change at all, record that as an audited waiver with legion attest " +
    "independent-baseline --verdict not_applicable --waiver-reason <text> --attested-by <id>, which ADR-006 permits " +
    "and which legion ship echoes as a warning on every payload that carries one."
};

/** The cure when the run plane cannot say whether the baseline came first. */
const BASELINE_ORDERING_UNREADABLE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "This change's task runs could not be read as a complete set, so whether its baseline was captured before " +
    "execution began cannot be established. The artifact_plane_incomplete or task_run_plane_contradicted diagnostic " +
    "in this same payload names what is missing — restore or correct it, then rerun this."
};

/** A waiver a gate accepted, carried so that ship can echo it without matching prose. */
export interface ShipGateWaiver {
  readonly gate: RiskGateId;
  readonly attests: AttestationKind;
  readonly attestedBy: string;
  readonly attestedAt: string;
  readonly reason: string;
}

/**
 * A human judgement a gate accepted in place of a machine-checkable report.
 *
 * `ShipGateWaiver`'s machinery for `ShipGateWaiver`'s reason: a satisfied gate
 * emits no diagnostic at all, so without a machine-readable field this arm —
 * the second `satisfied` verdict in this module with nothing falsifiable behind
 * it — would be the quietest thing in the payload.
 *
 * A separate type rather than a reuse of `ShipGateWaiver`, because
 * `risk_gate_waived`'s sentence says "was satisfied by an audited waiver rather
 * than by evidence", and a recorded judgement is a different and stronger claim:
 * a named human says the check applied and passed. One sentence answering two
 * different facts is how a payload stops being readable.
 */
export interface ShipGateHumanJudgement {
  readonly gate: RiskGateId;
  readonly attests: AttestationKind;
  readonly attestedBy: string;
  readonly attestedAt: string;
  readonly statement: string;
  readonly sources: readonly string[];
}

/**
 * The tasks whose risk tier actually derived this gate.
 *
 * The denominator `covers` is checked against. `deriveShipGates` emits one row
 * per (task, gate), so a change-scoped gate is evaluated once per deriving task
 * and has to answer the same thing every time — which it can only do from the
 * whole task list rather than from the one it happens to be holding.
 */
function tasksDeriving(gate: RiskGateId, tasks: readonly TaskContract[]): readonly TaskContract[] {
  return tasks.filter((task) =>
    deriveGateSet({ tier: task.risk.tier, gatesByTier: DEFAULT_RISK_POLICY.gatesByTier }).some(
      (derived) => derived.id === gate
    )
  );
}

/**
 * Is a named human equal to a human executor this change records?
 *
 * **The only surviving half of the "distinct from the executor" rule, and the
 * half that was measured rather than assumed.** The specification asked
 * `independent_baseline` for a distinctness check between the attester and the
 * executor recorded in the task runs, and asked
 * `architecture_or_security_review` for the same between the reviewer and the
 * implementer. Both were measured and both reduce to this.
 * `legion build` writes the hard-coded literal `{kind: "tool", id: "legion-cli",
 * displayName: "Legion CLI"}` as `claimedBy` on every run of every change —
 * `--executor fake` lands in `manifest.model.id`, not there — and
 * `taskRunSchema.claimedBy` is optional besides. So a check that any human
 * attester differs from every recorded executor is true on every honest change
 * *and* vacuously true when no run records an executor at all: a positive check
 * with no reachable negative, wearing the name of an independence guarantee.
 * Shipping it as specified would have been lesson 4 and lesson 5 in one place.
 *
 * The review side is worse rather than better. `review.reviewer` is
 * `legion-${executor}-reviewer` — a deterministic function of a flag, naming a
 * model family and not a person — so `reviewer.id !== claimedBy.id` is
 * `"legion-fake-reviewer" !== "legion-cli"` on every honest change by
 * construction. The only human identity anywhere in the flow is `--approver`,
 * which lands in `review.acceptedBy`, `approval.decidedBy` and
 * `change.acceptance.acceptedBy`, and one person supplies all of them.
 *
 * What is kept is the falsifier alone, and its bound is stated the way
 * `approvedOraclePin` states `verifyPin`'s. It can only ever *refuse*, never
 * satisfy, so its vacuity is harmless. It is unreachable through the CLI today
 * and reachable through a hand-written or host-written run, which is the same
 * threat model `humanApprovalStatus` already states.
 *
 * One implementation taking an actor id, called by both gates, rather than two
 * copies differing in a parameter name: the second copy is the one that gets the
 * `kind` check wrong.
 *
 * For `independent_baseline`, independence is carried by the ordering comparison
 * and the gate says so in its own verdict; the residual is that a baseline
 * attested by the same person who later ran the build is indistinguishable from
 * an independent one. For `architecture_or_security_review` there is no ordering
 * comparison and **independence is not established at all** — what that gate
 * carries is the recorded *domain*: not who looked, but with what competence.
 * Closing either needs an implementer identity the CLI does not record.
 */
function humanExecutorMatching(
  taskRuns: readonly TaskRun[] | undefined,
  actorId: string
): TaskRun | undefined {
  for (const run of taskRuns ?? []) {
    const claimedBy = run.claimedBy;
    if (claimedBy === undefined) continue;
    if (claimedBy.kind !== "human") continue;
    if (claimedBy.id === actorId) return run;
  }
  return undefined;
}

/**
 * The shared shape of `independent_baseline`, `security_or_e2e_evaluator`,
 * `rollback_or_forward_fix_evidence` and — as one half of its verdict —
 * `architecture_or_security_review`.
 *
 * All of them ask the same question of the same plane — is there a record of the
 * right kind for this change, does it say yes, and is what it cites still there
 * and still green — so they share one implementation and differ only in which
 * kinds they accept and in whether they carry an ordering rule. Three copies
 * would be three chances to get the empty-set guards wrong.
 *
 * Every quantifier below is checked against its empty case, because this series
 * has now paid five times for one that was not:
 *
 *  - **No attestation of an accepted kind** — `unevaluable`, never `satisfied`.
 *    That is the absence arm and it is what every change written before this
 *    release is in.
 *  - **`sources` empty** — `unevaluable`. Unreachable from a parsed document
 *    (`.min(1)`), and kept because this function's parameter type admits it and
 *    `[].every(clean)` is `true`. A gate must not inherit its central truth
 *    claim from another module's invariant.
 *  - **`covers` empty, or no task derives the gate** — `unevaluable`. "This
 *    attestation covers every deriving task" over an empty denominator is the
 *    same vacuous truth in the other direction.
 *  - **The kind's evidence rule is `none`** — `unsatisfied`, positively: the
 *    record claims a pass that no report in this repository can evidence. A kind
 *    whose rule is `human-judgement` takes the arm named there instead, which is
 *    a third state rather than an overload of this one.
 *
 * **Two of these gates accept two kinds, and two records is the normal state
 * rather than a corruption.** `attestationIdForKind` derives an id from
 * `(changeId, attests)`, so `legion attest` writes one document *per kind* and a
 * change can legitimately carry both a `security-evaluation` and an
 * `e2e-evaluation`. The one-per-kind rule is therefore checked per kind, and the
 * several records are evaluated separately and combined by
 * `combineAttestationOutcomes`. Treating them as hand-filed siblings — which is
 * what this function did before — collapsed a satisfied gate to `unevaluable`
 * the moment a second legitimate kind was recorded, and turned a recorded `fail`
 * into "unestablished": the precise inversion the one-per-kind rule exists to
 * prevent, performed by the rule itself.
 */
function attestationGateStatus(input: {
  readonly gate: RiskGateId;
  readonly kinds: readonly AttestationKind[];
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  /** Only `independent_baseline` passes this. */
  readonly requireBeforeExecution?: boolean;
  /**
   * The unmet cure, when the gate has a better route out than "attest this".
   *
   * Only `architecture_or_security_review` passes it, and it is a parameter
   * rather than a widening of `attestRecovery` because it is the only gate here
   * whose evidence a *command in the workflow* can produce. `attestRecovery`'s
   * sentence says "no build produces one: the gate reads the attestation plane",
   * which is true of the other three and false of that one — a review recorded
   * with `--domain architecture` satisfies it without anybody attesting anything.
   */
  readonly absenceRecovery?: ShipGateRecovery;
}): GateOutcome {
  const change = input.change;
  const attestations = change?.attestations;
  const absence = input.absenceRecovery ?? attestRecovery(input.gate, input.kinds);
  const named = input.kinds.join(" or ");

  if (change === undefined || attestations === undefined) {
    return {
      status: "unevaluable",
      reason:
        `The attestations recorded for this change could not be read as a complete set, so whether anyone asserted ` +
        `${named} for it is unestablished.`,
      recovery: UNREADABLE_PLANE_RECOVERY,
      // The dropped file may be a `fail`. See `GateOutcome.concealsNegative`:
      // this is not the absence of a claim, and the one gate that reads this
      // plane beside another must not answer from the other one.
      concealsNegative: true
    };
  }

  // **The cure, computed once and used by every unmet arm below.**
  //
  // It was previously computed once for the absence arm and then the raw
  // `absence` was returned by seven others, which is this series' first lesson
  // reproduced in its sharpest form: on a change whose runs have started,
  // `legion attest independent-baseline` is advice that exits 0, writes a
  // *later* `attestedAt`, and moves the gate from `unevaluable` to permanently
  // `unsatisfied`. Ship promotes the first R3 gate's recovery to
  // `nextAction.command`, and `independent_baseline` is first — so that advice
  // was what hosts dispatched on for every blocked R3 ship. There is one cure
  // for this gate's unmet arms because there is one state they are all in.
  const cure =
    input.requireBeforeExecution === true
      ? orderingAwareBaselineRecovery(absence, executionOrdering(change.taskRuns))
      : absence;

  const accepted = new Set<string>(input.kinds);
  const relevant = attestations.filter(
    // Strict equality against a possibly-absent change id, on the approvals
    // plane's rule: a record too degraded to name its own change matches nothing
    // rather than everything. It matters here because an attestation's cited
    // sources are ordinary repository files shared across changes, so a record
    // that matched loosely could answer for a change it was never about.
    (attestation) => attestation.changeId === change.changeId && accepted.has(attestation.attests)
  );

  if (relevant.length === 0) {
    return {
      status: "unevaluable",
      reason: `No attestation records anyone asserting ${named} for change ${change.changeId}.`,
      recovery: cure
    };
  }

  // The duplication guard, **per kind**. `attestationIdForKind` derives an id
  // from `(changeId, attests)`, so Legion writes exactly one document per kind
  // and two of one kind can only be siblings somebody filed by hand. Answering
  // from either would let a favourable record hide an unfavourable one, which is
  // the fail-open one-per-kind exists to remove — so the duplication is named
  // rather than resolved, and it dominates the combination below: a gate cannot
  // be satisfied by one kind while another kind's record is ambiguous.
  for (const kind of input.kinds) {
    const ofKind = relevant.filter((attestation) => attestation.attests === kind);
    if (ofKind.length > 1) {
      const ids = ofKind.map((attestation) => attestation.id).sort();
      return {
        status: "unevaluable",
        reason:
          `Change ${change.changeId} carries ${ofKind.length} attestations of kind ${kind} (${ids.join(", ")}). ` +
          "Legion writes exactly one per change per kind, so these were filed by hand, and answering from either " +
          "would let a favourable record hide an unfavourable one. Remove the ones that are not the record.",
        recovery: MISFILED_ATTESTATION_RECOVERY,
        // And it dominates the *other producer* too, not only the other kinds.
        // One of these documents may be the `fail`, so a domain review beside it
        // would answer the question this arm exists to refuse to answer. See
        // `GateOutcome.concealsNegative`.
        concealsNegative: true
      };
    }
  }

  const outcomes = input.kinds
    .map((kind) => relevant.find((attestation) => attestation.attests === kind))
    .filter((attestation): attestation is Attestation => attestation !== undefined)
    .map((record) =>
      attestationRecordStatus({
        gate: input.gate,
        change,
        record,
        cure,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor,
        ...(input.requireBeforeExecution === true ? { requireBeforeExecution: true } : {})
      })
    );
  return combineAttestationOutcomes(outcomes);
}

/**
 * Reduce one record's verdict per accepted kind to the gate's verdict.
 *
 * **`unsatisfied` beats `satisfied`, and that ordering is the whole content of
 * this function.** These gates read an OR of kinds — a security evaluation *or*
 * an end-to-end one — and the naive reduction is "any satisfied satisfies". That
 * reduction lets a `pass` on one kind bury a recorded `fail` on the other, which
 * is the same favourable-hides-unfavourable fail-open the per-kind duplication
 * guard above refuses; an OR over evidence must not become an OR over verdicts a
 * human recorded. `unevaluable` is last because it is the absence of a claim
 * rather than a claim, so a real verdict of either polarity outranks it.
 *
 * The unfavourable verdict keeps its own recovery, because it is the one that
 * has to be repaired.
 */
function combineAttestationOutcomes(outcomes: readonly GateOutcome[]): GateOutcome {
  const first = outcomes[0] as GateOutcome;
  if (outcomes.length <= 1) return first;

  const unsatisfied = outcomes.find((outcome) => outcome.status === "unsatisfied");
  if (unsatisfied !== undefined) {
    const others = outcomes.filter((outcome) => outcome !== unsatisfied && outcome.status === "satisfied");
    if (others.length === 0) return unsatisfied;
    return {
      ...unsatisfied,
      reason:
        `${unsatisfied.reason} This change also carries ${others.length} favourable attestation${
          others.length === 1 ? "" : "s"
        } of another kind this gate reads, and ${others.length === 1 ? "it does" : "they do"} not override the one ` +
        "above: an attestation recorded against this change is a statement somebody made about it, and a later " +
        "record of a different kind does not unmake it."
    };
  }

  const satisfied = outcomes.find((outcome) => outcome.status === "satisfied");
  return satisfied ?? first;
}

/** One attestation's verdict, for the gate that reads its kind. */
function attestationRecordStatus(input: {
  readonly gate: RiskGateId;
  readonly change: ShipGateChangeFacts;
  readonly record: Attestation;
  readonly cure: ShipGateRecovery;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly requireBeforeExecution?: boolean;
}): GateOutcome {
  const change = input.change;
  const record = input.record;
  const cure = input.cure;
  const describe = `Attestation ${record.id} records ${record.attestedBy.id} asserting ${record.attests} for change ${change.changeId}`;

  if (record.verdict === "fail") {
    return {
      status: "unsatisfied",
      reason: `${describe} as failed: "${record.statement}"`,
      recovery: ATTESTATION_EVIDENCE_RECOVERY
    };
  }
  if (record.verdict === "unknown") {
    return {
      status: "unevaluable",
      reason: `${describe} with verdict "unknown": a record exists for this question and asserts nothing about it.`,
      recovery: cure
    };
  }

  if (record.sources.length === 0) {
    return {
      status: "unevaluable",
      reason: `${describe}, and cites no source, so there is nothing this report can check the assertion against.`,
      recovery: cure
    };
  }

  // Pins first, for both verdicts. A record whose cited bytes have moved is not
  // a record about the bytes anyone looked at, and that is as true of a waiver
  // citing an ADR as of a pass citing a report.
  for (const source of record.sources) {
    const verdict = change.verifyPin(source);
    if (verdict === "drift") {
      return {
        status: "unsatisfied",
        reason: `${describe}, and cites ${source.path}, whose bytes have changed since the attestation was recorded.`,
        recovery: ATTESTATION_BYTES_RECOVERY
      };
    }
    if (verdict === "missing") {
      return {
        status: "unsatisfied",
        reason: `${describe}, and cites ${source.path}, which is no longer present.`,
        recovery: ATTESTATION_BYTES_RECOVERY
      };
    }
    if (verdict !== "match") {
      // `unverified`: nobody hashed it. Never `satisfied` — and never `missing`
      // either, which would blame the artifact for the reader's problem.
      return {
        status: "unevaluable",
        reason: `${describe}, and cites ${source.path}, which this report did not re-hash, so whether the attestation is still about the bytes on disk is unestablished.`,
        recovery: UNREADABLE_PLANE_RECOVERY
      };
    }
  }

  // A red report contradicts the record whatever the record says, so this runs
  // before the two verdicts split. A waiver over a failing report of the very
  // check being waived converts a negative result into a satisfied gate with no
  // evidence in between, which is the one thing an audited waiver must not be
  // able to do.
  for (const source of record.sources) {
    const classified = change.classifySource(source);
    if (classified.kind === "blocking") {
      return {
        status: "unsatisfied",
        reason:
          `${describe}, and cites ${source.path}, which is a ${classified.shape} report that is negative by its own ` +
          `rule: ${classified.reason}. Producing a green one is ${EVIDENCE_SOURCE_PRODUCERS[classified.shape]}; the ` +
          "coupling is named here because nothing in this repository validates these reports against a schema, so a " +
          "producer that changed its output shape would degrade this check silently.",
        recovery: ATTESTATION_EVIDENCE_RECOVERY
      };
    }
  }

  const deriving = tasksDeriving(input.gate, input.tasks);
  if (deriving.length === 0) {
    return {
      status: "unevaluable",
      reason: `${describe}, and no task of this change derives ${input.gate}, so there is nothing for the attestation to cover.`,
      recovery: cure
    };
  }
  const covered = new Set(record.covers.filter((entry) => entry.kind === "task").map((entry) => entry.id as string));
  const uncovered = deriving.map(input.taskIdFor).filter((taskId) => !covered.has(taskId));
  if (uncovered.length > 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe}, and its covers list names ${covered.size} task${covered.size === 1 ? "" : "s"}, leaving ` +
        `${uncovered.join(", ")} uncovered. This gate is derived by ${deriving.length} task${
          deriving.length === 1 ? "" : "s"
        } of this change and is satisfied only when the attestation claims to speak for all of them.`,
      recovery: cure
    };
  }

  if (record.verdict === "not_applicable") {
    const waiverReason = record.waiverReason;
    // Positive on both conditions rather than trusting the schema, on
    // `oracleApprovalStatus`'s rule: this arm is the one `satisfied` verdict in
    // these three gates with no falsifiable evidence behind it, so an
    // unrecognised shape must fall *out* of it rather than into it.
    if (record.attestedBy.kind !== "human" || waiverReason === undefined) {
      return {
        status: "unsatisfied",
        reason:
          `${describe} as not applicable, but a waiver requires a human attester and a recorded reason and this one ` +
          `has ${record.attestedBy.kind === "human" ? "no reason" : `a ${record.attestedBy.kind} attester`}. ` +
          "ADR-006 permits a waived gate only as an audited waiver.",
        recovery: cure
      };
    }
    return {
      status: "satisfied",
      reason:
        `${input.gate} is waived for change ${change.changeId} by ${record.attestedBy.id} (human) at ` +
        `${record.attestedAt} as not applicable: "${waiverReason}". No evidence was checked for this gate.`,
      waived: {
        gate: input.gate,
        attests: record.attests,
        attestedBy: record.attestedBy.id,
        attestedAt: record.attestedAt,
        reason: waiverReason
      }
    };
  }

  // `pass`. Positive from here down: the record has to point at something this
  // report can read a green verdict out of, and a shape nobody recognises is not
  // a shape that passed.
  const rule = ATTESTATION_EVIDENCE_RULES[record.attests];
  if (rule.kind === "none") {
    return {
      status: "unsatisfied",
      reason:
        `${describe} as passed, and no report shape in this repository can evidence a ${record.attests} pass. ` +
        `${UNRECOGNISED_SOURCE_HINT} Record what is actually established with --verdict unknown, or, if the check ` +
        "does not apply to this change, as an audited waiver with --verdict not_applicable.",
      recovery: cure
    };
  }
  if (rule.kind === "human-judgement") {
    // Positive on the attester, exactly as the waiver arm above is positive on
    // both of its conditions and for the identical reason: this is the one
    // `satisfied` verdict on this path with nothing falsifiable behind it, so a
    // record that is not what it claims must fall *out* of the arm rather than
    // into it. The schema is not trusted to have done it — a gate must not
    // inherit its central truth claim from another module's invariant.
    if (record.attestedBy.kind !== "human") {
      return {
        status: "unsatisfied",
        reason:
          `${describe} as passed, and ${record.attests} is a human judgement no report in this repository states — ` +
          `so a pass for it is somebody's opinion or it is nothing, and this one was recorded by ` +
          `${record.attestedBy.kind} ${record.attestedBy.id}.`,
        recovery: cure
      };
    }
    return {
      status: "satisfied",
      reason:
        `${describe} as passed at ${record.attestedAt}, against ${record.sources.length} hash-clean source` +
        `${record.sources.length === 1 ? "" : "s"} (${record.sources.map((source) => source.path).join(", ")}): ` +
        `"${record.statement}". No report shape in this repository states a ${record.attests} verdict, so nothing ` +
        "machine-checkable was read. What was checked is that the cited bytes are still the bytes the attester " +
        "looked at, and that none of them is a report that is red by its own rule.",
      judgement: {
        gate: input.gate,
        attests: record.attests,
        attestedBy: record.attestedBy.id,
        attestedAt: record.attestedAt,
        statement: record.statement,
        sources: record.sources.map((source) => source.path)
      }
    };
  }

  const admissible = rule.shapes;
  const admitted = new Set<string>(admissible);
  const evidencing = record.sources.filter((source) => {
    const classified = change.classifySource(source);
    return classified.kind === "clean" && admitted.has(classified.shape);
  });
  if (evidencing.length === 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} as passed, and none of the ${record.sources.length} file${
          record.sources.length === 1 ? "" : "s"
        } it cites is a ${admissible.join(" or ")} report this report can read a verdict out of. A pass attestation ` +
        `is a claim about a machine-checkable verdict; this one is a sentence. ${UNRECOGNISED_SOURCE_HINT}`,
      recovery: cure
    };
  }

  if (input.requireBeforeExecution !== true) {
    return {
      status: "satisfied",
      reason:
        `${describe} as passed, against ${evidencing.length} hash-clean ${admissible.join("/")} report${
          evidencing.length === 1 ? "" : "s"
        } (${evidencing.map((source) => source.path).join(", ")}) whose own verdicts are green.`
    };
  }

  // The ordering half, `independent_baseline` only. A baseline captured after
  // the run it is supposed to be independent of is not one — which is
  // `unsatisfied`, a positive negative, and not the absence the plane would
  // otherwise read as.
  const execution = executionOrdering(change.taskRuns);
  if (execution.kind === "unestablished") {
    return {
      status: "unevaluable",
      reason: `${describe} as passed at ${record.attestedAt}, and this change's task runs could not be read as a complete set, so whether the baseline preceded execution cannot be established.`,
      recovery: BASELINE_ORDERING_UNREADABLE_RECOVERY
    };
  }
  if (execution.kind === "none") {
    // "Attested before nothing" is the vacuous truth this series has paid for
    // four times. A change with no runs has not yet had the execution the
    // baseline is supposed to precede, so nothing has been established.
    return {
      status: "unevaluable",
      reason: `${describe} as passed at ${record.attestedAt}, and no task of this change has run, so there is nothing yet for the baseline to have preceded.`,
      recovery: ORDERING_BUILD_RECOVERY
    };
  }
  if (record.attestedAt >= execution.startedAt) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} as passed at ${record.attestedAt}, which is ${
          record.attestedAt === execution.startedAt ? "the same instant as" : "not earlier than"
        } the ${execution.startedAt} at which gated execution for this change began (run ${execution.runId} of ` +
        `${execution.taskId}). A baseline captured after the run it is supposed to be independent of is not one.`,
      recovery: BASELINE_AFTER_EXECUTION_RECOVERY
    };
  }

  const collision = humanExecutorMatching(change.taskRuns, record.attestedBy.id);
  if (collision !== undefined) {
    return {
      status: "unsatisfied",
      reason: `${describe} as passed, and run ${collision.id as string} of this change records ${record.attestedBy.id} as the executor who claimed it. A baseline captured by the person who then ran the work is not independent of it.`,
      recovery: BASELINE_AFTER_EXECUTION_RECOVERY
    };
  }

  return {
    status: "satisfied",
    reason:
      `${describe} as passed at ${record.attestedAt}, before gated execution began at ${execution.startedAt} ` +
      `(run ${execution.runId} of ${execution.taskId}), against ${evidencing.length} hash-clean ` +
      `${admissible.join("/")} report${evidencing.length === 1 ? "" : "s"} ` +
      `(${evidencing.map((source) => source.path).join(", ")}) whose own verdicts are green. Independence here is ` +
      "temporal: Legion records no executor identity that varies, so ordering is what carries the claim."
  };
}

/**
 * The unmet cure, adjusted for where execution stands — `independent_baseline`
 * only.
 *
 * Applied to **every** unmet arm of that gate rather than only to the absence
 * one. The arms differ in what they say and agree completely on what to do: once
 * a run exists, no route through `legion attest` can produce a baseline dated
 * before it, so advice naming that verb is advice that exits 0 and deepens the
 * state whether the record is missing, `unknown`, sourceless, uncovered or
 * citing the wrong shape.
 *
 * `orderingAwareRecovery` above is deliberately **not** reused, and the reason is
 * not stylistic. That helper keys on the recovery's own command starting with
 * `legion approve`, and widening it to match `legion attest` would rewrite
 * `security_or_e2e_evaluator`'s and `rollback_or_forward_fix_evidence`'s
 * perfectly good advice into "re-plan the change" on every change that has been
 * built — and neither of those gates has an ordering rule, so attesting after
 * the build is exactly right for them. The ordering-aware advice belongs on the
 * one gate whose rule it is.
 */
function orderingAwareBaselineRecovery(
  recovery: ShipGateRecovery,
  execution: ExecutionOrdering
): ShipGateRecovery {
  if (execution.kind === "started") return BASELINE_AFTER_EXECUTION_RECOVERY;
  if (execution.kind === "unestablished") return BASELINE_ORDERING_UNREADABLE_RECOVERY;
  return recovery;
}

/** The cure for two hand-filed attestations of one kind. */
const MISFILED_ATTESTATION_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "A change carries more than one attestation of one kind. legion attest derives an attestation's id from the " +
    "change and the kind alone, so it can never write a second — these were filed by hand. Delete the ones that are " +
    "not the record and re-attest if the survivor is not what you meant, then rerun this to confirm."
};

/**
 * Would this one document, alone, satisfy the gate that reads its kind?
 *
 * Exported for `legion attest`, on `isLiveOracleGrant`'s rule: a writer whose
 * idea of "done" is weaker than the reader's idea of "satisfied" reports
 * success, writes nothing, and leaves the change permanently blocked with no
 * flag anywhere that would make it write. So this is not a second implementation
 * — it calls `attestationGateStatus` against a one-document plane and asks
 * whether the verdict is `satisfied`.
 *
 * **The ordering clause is deliberately excluded**, exactly as `isLiveOracleGrant`
 * excludes its own. Carrying it would make a harmless rerun on an already-built
 * change report "re-attest", write a fresh `attestedAt`, and make
 * `independent_baseline` strictly worse — the command invoked to repair the
 * state would be the one that deepened it. `legion attest` closes the resulting
 * silence by warning instead, at the one moment the operator could still act.
 */
export function isSatisfyingAttestation(input: {
  readonly attestation: Attestation;
  readonly gate: RiskGateId;
  readonly kinds: readonly AttestationKind[];
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
  readonly verifyPin: VerifyPinnedReference;
  readonly classifySource: ClassifyEvidenceSource;
}): boolean {
  const outcome = attestationGateStatus({
    gate: input.gate,
    kinds: input.kinds,
    tasks: input.tasks,
    taskIdFor: input.taskIdFor,
    change: {
      changeId: input.changeId,
      acceptance: undefined,
      approvals: undefined,
      attestations: [input.attestation],
      reviews: undefined,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: undefined,
      verifyPin: input.verifyPin,
      classifySource: input.classifySource
    }
  });
  return outcome.status === "satisfied";
}

/** Every waiver the gates in this report accepted, for ship to echo. */
export function shipGateWaivers(gates: readonly ShipGateResult[]): readonly ShipGateWaiver[] {
  const seen = new Set<string>();
  const waivers: ShipGateWaiver[] = [];
  for (const gate of gates) {
    const waived = gate.waived;
    if (waived === undefined) continue;
    if (seen.has(waived.gate)) continue;
    seen.add(waived.gate);
    waivers.push(waived);
  }
  return waivers;
}

/**
 * Every recorded human judgement the gates in this report were satisfied by.
 *
 * `shipGateWaivers`' shape, deduplicated by gate id for its reason: a
 * change-scoped gate is still emitted once per deriving task, so the same
 * judgement appears once per criterion and the operator should read it once.
 */
export function shipGateHumanJudgements(
  gates: readonly ShipGateResult[]
): readonly ShipGateHumanJudgement[] {
  const seen = new Set<string>();
  const judgements: ShipGateHumanJudgement[] = [];
  for (const gate of gates) {
    const judgement = gate.judgement;
    if (judgement === undefined) continue;
    if (seen.has(judgement.gate)) continue;
    seen.add(judgement.gate);
    judgements.push(judgement);
  }
  return judgements;
}

// --- architecture and security review ---------------------------------------

/**
 * The domains that answer ADR-006's architecture-and-security question.
 *
 * Exported so `legion review`'s warning names them from the reader rather than
 * restating them, and so a test asserting "an `implementation` review does not
 * satisfy this gate" is asserting against the list the gate actually reads.
 */
export const DOMAIN_REVIEW_GATE_DOMAINS: readonly string[] = ["architecture", "security"];

/**
 * The cure when no review of this change says which domain it examined.
 *
 * The state every change written before this release is in, and the only one a
 * caller holding just a gate id can be answered for — so it is also
 * `GATE_RECOVERY`'s entry. It names the *submit* as the command and the accept in
 * the sentence, because the domain is recorded at submit and the gate reads an
 * accepted review: naming only the accept would advise a command that cannot
 * record a domain, and naming only the submit would leave the operator with a
 * submitted review the gate still does not read.
 */
const DOMAIN_REVIEW_RECOVERY: ShipGateRecovery = {
  command: "legion review --domain architecture",
  reason:
    "No review of this change records the domain it was performed in, and no build produces that: this gate reads " +
    "the review plane. An accepted review says something other than the implementer looked at the work; this gate " +
    "asks whether an architecture or security competence did, and a review that does not say cannot answer it. Run a " +
    "review that declares its domain — --domain architecture, --domain security, or both — and then legion review " +
    "--accept --approver <id>, which is the step that turns a submitted review into the accepted one this gate reads. " +
    "The domain is declared when the review is performed: legion review --accept refuses --domain, because a label " +
    "applied afterwards records a signature rather than a competence. If no architecture or security question applies " +
    "to this change, record that as an audited waiver with legion attest architecture-review --verdict " +
    "not_applicable --waiver-reason <text> --attested-by <id> --source <path>, which ADR-006 permits and which legion " +
    "ship echoes as a warning on every payload that carries one."
};

/**
 * The cure when a domain review recorded a defect.
 *
 * Deliberately **not** `legion review --domain`. That command writes a fresh
 * review over the same evidence, exits 0, and records the same finding — the
 * exits-0-and-still-blocked loop this series exists to close, and the shape PR 6
 * had to correct across seven arms. What moves this is fixing what the finding
 * names and rebuilding so the evidence is about the fixed code.
 */
const DOMAIN_REVIEW_REWORK_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "An architecture or security review of this change recorded a defect, and re-running the review is deliberately " +
    "not offered: legion review --domain writes a fresh review over the same evidence, exits 0, and records the same " +
    "finding. Fix what the verdict above names, rebuild so the evidence is about the fixed code, then review with the " +
    "domain again and accept. Attesting cannot move this either — an architecture-review attestation is combined with " +
    "this verdict rather than replacing it, and a recorded negative is not unmade by a later record of another kind."
};

/**
 * The cure when the person who ran the work is the person who signed off on it.
 *
 * Neither `DOMAIN_REVIEW_REWORK_RECOVERY` nor `DOMAIN_REVIEW_RECOVERY` describes
 * this state — the first says "fix what the verdict names and rebuild", and there
 * is nothing wrong with the code; the second says "no review records a domain",
 * and one does. Lesson 1: the recovery has to repair *this* state, and what
 * repairs it is a different signature, not a different build and not another
 * record under the same name.
 *
 * Named once and used by both routes, because both refuse for the same reason and
 * an operator refused at one of them must not read advice that points at the
 * other as a way through.
 */
const SELF_REVIEWED_DOMAIN_RECOVERY: ShipGateRecovery = {
  command: "legion review --domain architecture",
  reason:
    "This change's architecture or security sign-off carries the name its run plane records as the executor of the " +
    "work, and no rebuild and no second record under that name moves it: a review of the work by whoever ran it is " +
    "not a review of it by anybody else. Have somebody who did not claim a run of this change perform the review — " +
    "legion review --domain architecture or --domain security — and accept it with legion review --accept --approver " +
    "<their id>. Attesting instead cannot substitute: legion attest architecture-review reads the same run plane and " +
    "this gate refuses that record for the same reason."
};

/** The cure when a domain review exists and nobody has accepted it. */
const DOMAIN_REVIEW_ACCEPT_RECOVERY: ShipGateRecovery = {
  command: "legion review --accept --approver <id>",
  reason:
    "A review of this change was performed in an architecture or security domain and nobody has accepted it. This " +
    "gate reads accepted reviews, because an unaccepted one is a verdict nobody has stood behind. Accepting it names " +
    "a human decision owner from the project manifest and records the domain review as the change's own."
};

/** `findings`, read as the possibly-absent array a hand-written document can carry. */
function reviewFindingsOf(document: ReviewDecision): readonly ReviewFinding[] {
  return (document.findings as readonly ReviewFinding[] | undefined) ?? [];
}

/** `domains`, read as the possibly-absent array every review on disk today carries. */
function reviewDomainsOf(document: ReviewDecision): readonly string[] {
  return (document.domains as readonly string[] | undefined) ?? [];
}

/** `verdicts`, read as the possibly-absent record a hand-written document can carry. */
function reviewVerdictsOf(document: ReviewDecision): Record<string, string | undefined> {
  return (document.verdicts as Record<string, string | undefined> | undefined) ?? {};
}

function hasBlockingReviewFinding(document: ReviewDecision): boolean {
  return reviewFindingsOf(document).some((finding) => finding.severity === "blocking");
}

/** The verdict axis this review recorded as `fail`, if any. */
function failingVerdictAxis(document: ReviewDecision): string | undefined {
  const verdicts = reviewVerdictsOf(document);
  return ["specification", "integration", "evidence"].find((axis) => verdicts[axis] === "fail");
}

/**
 * Every axis this review did **not** record as `pass`, with what it did record.
 *
 * The positive form, and the reason it is written this way rather than as "no
 * axis is fail" is lesson 4 in the one place it would have been easiest to get
 * wrong. `reviewVerdictSchema` admits `unknown`, `not_verified` and
 * `not_applicable` besides `pass` and `fail`, so a satisfied arm phrased as "no
 * axis failed" is satisfied by a review that verified nothing at all.
 */
function nonPassingVerdictAxes(document: ReviewDecision): readonly { readonly axis: string; readonly verdict: string }[] {
  const verdicts = reviewVerdictsOf(document);
  return ["specification", "integration", "evidence"]
    .map((axis) => ({ axis, verdict: verdicts[axis] ?? "unrecorded" }))
    .filter((entry) => entry.verdict !== "pass");
}

/** Reviews in a stable order, so a sentence's subject never depends on read order. */
function byReviewId(
  left: ReviewDecisionSuccess,
  right: ReviewDecisionSuccess
): number {
  return (left.document.id as string).localeCompare(right.document.id as string);
}

function describeDomains(document: ReviewDecision): string {
  return reviewDomainsOf(document).join(", ");
}

/**
 * Did an architecture or security competence look at this change?
 *
 * ADR-006 asks a question `reviewDecisionBaseSchema` could not answer until this
 * release: it records three fixed verdict axes and which tool produced the
 * review, and nothing at all about domain. So "an accepted review exists" was the
 * only available reading — which every change has, and which is the exact
 * fail-open `explicit_human_approval` closed one gate over. `domains` is the
 * field that makes the question answerable, and its absence is `unevaluable`.
 *
 * **Every quantifier here is checked against its empty case**, because this
 * series has paid for one that was not six times:
 *
 *  - **The reviews plane could not be read as a complete set** — `unevaluable`,
 *    before anything else, and carrying `concealsNegative` so that the attestation
 *    producer beside it cannot answer the question instead. This gate has real
 *    `unsatisfied` arms that read a review, so a listing that dropped a file may
 *    have dropped the rejection, and a `pass` attestation is not an answer to
 *    "what was in the file I could not read".
 *  - **No task derives the gate** — `unevaluable`. The coverage quantifier below
 *    is vacuously true over an empty denominator, and unreachable from
 *    `deriveShipGates` is not the same as unreachable.
 *  - **No review carries `domains` at all** — `unevaluable`, never `satisfied`.
 *    That is the arm every review written before this release lands in, and it is
 *    what makes a plain accepted review *not* satisfy this gate.
 *  - **`domains` present but naming no architecture or security competence** —
 *    `unevaluable`, in its own sentence. `[].some(...)` is `false`, so the domain
 *    filter fails closed by construction, and the schema's `.min(1)` keeps a
 *    present-but-empty array from reaching it at all.
 *  - **A satisfying review for some deriving tasks and not others** —
 *    `unevaluable`, naming the uncovered tasks. Deliberately *not* `unsatisfied`,
 *    which is where `attestationRecordStatus`' `covers` arm puts the same shape:
 *    there an attester made a positive claim that provably fails to reach every
 *    deriving task, and here nobody claimed anything about the uncovered task.
 *    Both block; only one of them is a claim.
 *
 * **The negatives are scanned before the positives and over the whole in-domain
 * set**, so one clean architecture review of task c1 cannot bury a blocking one
 * of task c2. And the `satisfied` arm is positive on all four of its conditions:
 * accepted, all three verdict axes literally `"pass"`, no blocking finding, and a
 * `domains` array naming architecture or security.
 */
function domainReviewOutcome(input: {
  readonly gate: RiskGateId;
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  const change = input.change;
  const reviews = change?.reviews;
  if (change === undefined || reviews === undefined) {
    return {
      status: "unevaluable",
      reason:
        "The reviews recorded for this change could not be read as a complete set, so whether an architecture or " +
        "security review exists for it is unestablished.",
      recovery: UNREADABLE_PLANE_RECOVERY,
      // The dropped file may be the rejection. See `GateOutcome.concealsNegative`
      // — this arm is the reason that field exists, and an attestation beside it
      // must not answer for it.
      concealsNegative: true
    };
  }

  const deriving = tasksDeriving(input.gate, input.tasks);
  if (deriving.length === 0) {
    return {
      status: "unevaluable",
      reason: `No task of this change derives ${input.gate}, so there is nothing for a domain review to be about.`,
      recovery: DOMAIN_REVIEW_RECOVERY
    };
  }
  const derivingIds = deriving.map(input.taskIdFor);

  // Strict equality against a possibly-absent change id, on the approvals
  // plane's rule: a record too degraded to name its own change matches nothing
  // rather than everything.
  const scoped = reviews
    .filter((review) => review.document.changeId === change.changeId)
    .slice()
    .sort(byReviewId);

  // A review superseded by a later one is not this change's current verdict.
  // `supersedes` is a recorded link written by the review gate itself, not a
  // timestamp comparison — the same mechanism `approvedReviewLink` reads. Without
  // it, an architecture review accepted at attempt 1 keeps satisfying this gate
  // after the work was re-reviewed by a review that examined no domain.
  //
  // **The link is honoured only between reviews of the same task**, because that
  // is the only link `legion review` can write: `latestSubmittedReviewIdForTask`
  // resolves the superseded id within one task. Read loosely, a single
  // cross-task `supersedes` entry erases a rejected architecture review of
  // another task and flips this gate from `unsatisfied` to `satisfied` with no
  // mention of the rejection — a hand-written or host-written document deleting a
  // recorded negative, which is the same threat model the blocking-finding arm
  // below refuses an *accepted* review for.
  const scopedById = new Map(scoped.map((review) => [review.document.id as string, review]));
  const supersededIds = new Set(
    scoped.flatMap((review) =>
      ((review.document.supersedes as readonly string[] | undefined) ?? []).filter((id) => {
        if (id === (review.document.id as string)) return false;
        const superseded = scopedById.get(id);
        // Not a review of this change at all. Nothing filters against the id
        // either way — `current` only asks about ids in `scoped` — and it is
        // dropped so the set means exactly what it is named: reviews of this
        // change that a later review of the same task replaced.
        if (superseded === undefined) return false;
        return superseded.document.taskId === review.document.taskId;
      })
    )
  );
  const current = scoped.filter((review) => !supersededIds.has(review.document.id as string));

  // A review of a task no longer deriving this gate is dropped rather than
  // counted: a finding about a task the change no longer carries cannot block it,
  // and counting one would make a re-plan permanently unshippable with no repair.
  // A review naming *no* task stays in — it names this change, so it can refuse;
  // it names no task, so it can never satisfy the coverage quantifier below.
  const relevant = current.filter((review) => {
    const taskId = review.document.taskId as string | undefined;
    return taskId === undefined || derivingIds.includes(taskId);
  });
  const inDomain = relevant.filter((review) =>
    reviewDomainsOf(review.document).some((domain) => DOMAIN_REVIEW_GATE_DOMAINS.includes(domain))
  );

  const rejected = inDomain.find((review) => review.document.status === "rejected");
  if (rejected !== undefined) {
    return {
      status: "unsatisfied",
      reason:
        `Review ${rejected.document.id} of change ${change.changeId} was performed in ` +
        `${describeDomains(rejected.document)} and was rejected.`,
      recovery: DOMAIN_REVIEW_REWORK_RECOVERY
    };
  }

  // A blocking finding refuses even on an *accepted* review, which is the one
  // shape nothing else in this tree checks: `legion review --accept` refuses a
  // review that is not clean, but a host or a hand can write one, and an accepted
  // review carrying a blocking finding is a recorded defect either way.
  const blocking = inDomain.find((review) => hasBlockingReviewFinding(review.document));
  if (blocking !== undefined) {
    const finding = reviewFindingsOf(blocking.document).find((entry) => entry.severity === "blocking");
    return {
      status: "unsatisfied",
      reason:
        `Review ${blocking.document.id} of change ${change.changeId} was performed in ` +
        `${describeDomains(blocking.document)} and records a blocking finding: ${finding?.id} — "${finding?.title}".`,
      recovery: DOMAIN_REVIEW_REWORK_RECOVERY
    };
  }

  const failing = inDomain.find((review) => failingVerdictAxis(review.document) !== undefined);
  if (failing !== undefined) {
    return {
      status: "unsatisfied",
      reason:
        `Review ${failing.document.id} of change ${change.changeId} was performed in ` +
        `${describeDomains(failing.document)} and records its ${failingVerdictAxis(failing.document)} verdict as fail.`,
      recovery: DOMAIN_REVIEW_REWORK_RECOVERY
    };
  }

  const satisfying = inDomain.filter((review) => {
    const document = review.document;
    if (document.status !== "accepted") return false;
    const taskId = document.taskId as string | undefined;
    if (taskId === undefined || !derivingIds.includes(taskId)) return false;
    if (nonPassingVerdictAxes(document).length > 0) return false;
    return !hasBlockingReviewFinding(document);
  });

  if (satisfying.length === 0) {
    if (inDomain.length === 0) {
      const supersededDomainReview = scoped.find(
        (review) =>
          supersededIds.has(review.document.id as string) &&
          reviewDomainsOf(review.document).some((domain) => DOMAIN_REVIEW_GATE_DOMAINS.includes(domain))
      );
      if (supersededDomainReview !== undefined) {
        const superseder = scoped.find((candidate) =>
          ((candidate.document.supersedes as readonly string[] | undefined) ?? []).includes(
            supersededDomainReview.document.id as string
          )
        );
        return {
          status: "unevaluable",
          reason:
            `Review ${supersededDomainReview.document.id} of change ${change.changeId} was performed in ` +
            `${describeDomains(supersededDomainReview.document)}, and review ${superseder?.document.id} has since ` +
            "superseded it without recording a domain of its own. The change's current review says nothing about " +
            "which competence looked at it.",
          recovery: DOMAIN_REVIEW_RECOVERY
        };
      }
      // A current architecture or security review the *task* filter dropped, not
      // the domain filter. Its own sentence, because the two absence sentences
      // below are both false about this change: a review does record the domain,
      // and it does name architecture or security. Reached after a re-plan, where
      // the review is about a task id the change no longer carries — and the
      // sentence has to say that, or the operator is told to record a domain they
      // already recorded.
      const strandedInDomain = current.find(
        (review) =>
          !relevant.includes(review) &&
          reviewDomainsOf(review.document).some((domain) => DOMAIN_REVIEW_GATE_DOMAINS.includes(domain))
      );
      if (strandedInDomain !== undefined) {
        return {
          status: "unevaluable",
          reason:
            `Review ${strandedInDomain.document.id} of change ${change.changeId} was performed in ` +
            `${describeDomains(strandedInDomain.document)}, and is about task ` +
            `${strandedInDomain.document.taskId as string}, which is not one of the ${deriving.length} task` +
            `${deriving.length === 1 ? "" : "s"} deriving ${input.gate} for this change — a re-plan replaced it, or ` +
            `its tier does not derive this gate. The task${deriving.length === 1 ? "" : "s"} being shipped carry no ` +
            "domain review of their own.",
          recovery: DOMAIN_REVIEW_RECOVERY
        };
      }
      // Computed over `current` rather than `relevant`: this sentence is a claim
      // about the *change*, and made from the post-task-filter set it states as
      // fact that no review records a domain while one of them does.
      const declaring = current.filter((review) => reviewDomainsOf(review.document).length > 0);
      if (declaring.length === 0) {
        return {
          status: "unevaluable",
          reason:
            `No review of change ${change.changeId} records the domain it was performed in. An accepted review says ` +
            "that something other than the implementer looked at the work; this gate asks whether an architecture or " +
            "security competence did, and a review that does not say cannot answer it. Legion recorded no domain on " +
            "any review written before this release.",
          recovery: DOMAIN_REVIEW_RECOVERY
        };
      }
      const declared = [...new Set(declaring.flatMap((review) => reviewDomainsOf(review.document)))].sort();
      return {
        status: "unevaluable",
        reason:
          `${declaring.length} review${declaring.length === 1 ? "" : "s"} of change ${change.changeId} record the ` +
          `domain they were performed in (${declared.join(", ")}), and none of them is architecture or security.`,
        recovery: DOMAIN_REVIEW_RECOVERY
      };
    }

    const unaccepted = inDomain.find((review) => review.document.status !== "accepted");
    if (unaccepted !== undefined) {
      return {
        status: "unevaluable",
        reason:
          `Review ${unaccepted.document.id} of change ${change.changeId} was performed in ` +
          `${describeDomains(unaccepted.document)} and is still ${unaccepted.document.status}: nobody has accepted it.`,
        recovery: DOMAIN_REVIEW_ACCEPT_RECOVERY
      };
    }

    const unverified = inDomain.find((review) => nonPassingVerdictAxes(review.document).length > 0);
    if (unverified !== undefined) {
      const axes = nonPassingVerdictAxes(unverified.document)
        .map((entry) => `${entry.axis} is "${entry.verdict}"`)
        .join(", ");
      return {
        status: "unevaluable",
        reason:
          `Review ${unverified.document.id} of change ${change.changeId} was performed in ` +
          `${describeDomains(unverified.document)} and was accepted, and ${axes}. This gate is satisfied by a review ` +
          'that says every axis passed; "unknown", "not_verified" and "not_applicable" are not that, and are not ' +
          "failures either.",
        recovery: DOMAIN_REVIEW_RECOVERY
      };
    }

    return {
      status: "unevaluable",
      reason:
        `Change ${change.changeId} carries ${inDomain.length} architecture or security review` +
        `${inDomain.length === 1 ? "" : "s"}, and none of them names a task this gate is derived by, so none speaks ` +
        "for any of the work being shipped.",
      recovery: DOMAIN_REVIEW_RECOVERY
    };
  }

  const covered = new Set(satisfying.map((review) => review.document.taskId as string));
  const uncovered = derivingIds.filter((taskId) => !covered.has(taskId));
  if (uncovered.length > 0) {
    return {
      status: "unevaluable",
      reason:
        `${deriving.length} task${deriving.length === 1 ? "" : "s"} of change ${change.changeId} derive ` +
        `${input.gate} and ${covered.size} carr${covered.size === 1 ? "ies" : "y"} an accepted architecture or ` +
        `security review, leaving ${uncovered.join(", ")} with none.`,
      recovery: DOMAIN_REVIEW_RECOVERY
    };
  }

  // The falsifier, and the whole of what this gate can say about independence.
  // See `humanExecutorMatching`: nothing in this repository records an
  // implementer identity that varies, so reviewer-versus-implementer
  // independence cannot be established here and is not claimed. This clause can
  // only ever refuse, never satisfy, so its vacuity is harmless.
  for (const review of satisfying) {
    const acceptedBy = review.document.acceptedBy;
    if (acceptedBy === undefined || acceptedBy.kind !== "human") continue;
    const collision = humanExecutorMatching(change.taskRuns, acceptedBy.id);
    if (collision === undefined) continue;
    return {
      status: "unsatisfied",
      reason:
        `Review ${review.document.id} of change ${change.changeId} was accepted by ${acceptedBy.id}, and run ` +
        `${collision.id as string} of this change records the same person as the executor who claimed it. A domain ` +
        "review signed off by whoever ran the work is not a review of it by anybody else.",
      recovery: SELF_REVIEWED_DOMAIN_RECOVERY
    };
  }

  const domains = [...new Set(satisfying.flatMap((review) => reviewDomainsOf(review.document)))].sort();
  return {
    status: "satisfied",
    reason:
      `Every one of the ${deriving.length} task${deriving.length === 1 ? "" : "s"} of change ${change.changeId} ` +
      `deriving ${input.gate} carries an accepted review performed in ${domains.join(", ")}, with all three verdict ` +
      `axes pass and no blocking finding (${satisfying.map((review) => review.document.id).join(", ")}). What is ` +
      "established is the competence recorded, not the reviewer's independence of the implementer: Legion records no " +
      "implementer identity that varies."
  };
}

/**
 * Two producers of one gate, reduced.
 *
 * **Generic over the pair, and that generality is this release's edit.** It was
 * `combineDomainReviewOutcomes`, hard-coded to the review/attestation pair,
 * because there was one two-producer gate. `release_observation_plan` is the
 * second — a release plan *or* an audited `release-observation` waiver — and a
 * second copy of this ordering would be a second chance to get it wrong, on a
 * rule whose first version cost a blocking review round. The two sentence
 * templates are preserved byte for byte; only the phrases naming the producers
 * are parameters now.
 *
 * `combineAttestationOutcomes`' rule — `unsatisfied` beats `satisfied` beats
 * `unevaluable` — written out here rather than reused, because that function's
 * overridden-record sentence says "an attestation of another kind this gate
 * reads", which would be false of a review. The ordering is the substance in both
 * places: an OR over two *producers* must not become an OR over verdicts, or a
 * `pass` attestation buries a rejected architecture review.
 *
 * **And `unevaluable` is two facts, which is the correction this function needed
 * before it was right.** Reduced by verdict alone — `unsatisfied`, then
 * `satisfied`, then whatever is left — one producer's `satisfied` answers for the
 * other producer's *silence*, and the silence of a plane that came back short is
 * not the absence of a claim. A single `.DS_Store` under `attestations/` collapses
 * that plane, a clean `--domain architecture` review then satisfies the gate, and
 * the recorded `fail` the dropped listing may have held is gone — while the same
 * payload prints "Every gate that reads the attestation plane reports unevaluable
 * while this is true, because a listing that dropped a file may have dropped a
 * withdrawal". The gate would be contradicting its own diagnostic, and the
 * fail-open would be exactly the one `completeReviews` and `skipped` were added
 * one layer down to close, put back by the OR above them.
 *
 * So the order is: `unsatisfied`, then a `concealsNegative` `unevaluable`, then
 * `satisfied`, then a plain `unevaluable`. A recorded negative still outranks
 * everything — an unreadable plane *may* hold one, and a verdict somebody wrote
 * down does hold one. Below that, a plane in doubt outranks the other producer's
 * yes, because answering yes from the half that could be read is answering around
 * the half that could not.
 *
 * A `concealsNegative` outcome also wins the tie against a plain `unevaluable`,
 * for lesson 1 rather than for soundness: `shipGateRecovery` promotes the reason
 * attached to the verdict, and the plain arm's cure is `legion review --domain
 * architecture` — advice that exits 0, satisfies the review producer, and leaves
 * this gate blocked by the plane nobody was told to repair. The doubtful plane's
 * cure names the file.
 *
 * On a tie between two outcomes of the same kind the **review** outcome wins.
 * Both are true sentences and only one of them names a route an operator can take
 * without leaving Legion.
 */
function combineProducerOutcomes(input: {
  readonly primary: GateOutcome;
  readonly secondary: GateOutcome;
  /** How the *primary* is named when the secondary's verdict is the one reported. */
  readonly describePrimary: string;
  /** How the *secondary* is named when the primary's verdict is the one reported. */
  readonly describeSecondary: string;
}): GateOutcome {
  const { primary, secondary, describePrimary, describeSecondary } = input;
  const overridden = (reported: GateOutcome, other: GateOutcome, describeOther: string): GateOutcome =>
    other.status === "satisfied"
      ? {
          ...reported,
          reason:
            `${reported.reason} This change also carries a favourable ${describeOther}, and it does not override the ` +
            "verdict above: a record made about this change is a statement somebody made about it, and a record of " +
            "another kind does not unmake it."
        }
      : reported;

  const doubted = (reported: GateOutcome, other: GateOutcome, describeOther: string): GateOutcome =>
    other.status === "satisfied"
      ? {
          ...reported,
          reason:
            `${reported.reason} This change also carries a favourable ${describeOther}, and it does not settle the ` +
            "question above: the records this report could not read may be the ones that refuse, and a gate answered " +
            "from the half it could read is a gate answered around the half it could not."
        }
      : reported;

  if (primary.status === "unsatisfied") return overridden(primary, secondary, describeSecondary);
  if (secondary.status === "unsatisfied") return overridden(secondary, primary, describePrimary);
  if (primary.concealsNegative === true) return doubted(primary, secondary, describeSecondary);
  if (secondary.concealsNegative === true) return doubted(secondary, primary, describePrimary);
  if (primary.status === "satisfied") return primary;
  if (secondary.status === "satisfied") return secondary;
  return primary;
}

/** The domain-review pair, named. The ordering above is the substance. */
function combineDomainReviewOutcomes(review: GateOutcome, attested: GateOutcome): GateOutcome {
  return combineProducerOutcomes({
    primary: review,
    secondary: attested,
    describePrimary: "architecture or security review",
    describeSecondary: "architecture-review attestation"
  });
}

/**
 * The executor falsifier, applied to the attestation route as well as the review
 * one.
 *
 * `domainReviewOutcome` refuses a domain review accepted by a human the run plane
 * also records as an executor of this change. The attestation route reaches
 * `satisfied` through `attestationRecordStatus`' human-judgement arm, which does
 * not run that check: the collision test there sits behind `requireBeforeExecution`,
 * which only `independent_baseline` passes. So the *weakest* route through this
 * gate — a pass with nothing machine-checkable behind it, where the attester's
 * word is the whole of the evidence — was the one route that skipped it, and an
 * operator refused at the review route could satisfy the same gate by asserting
 * the same thing under their own name. A refusal one producer enforces and the
 * other does not is not a refusal.
 *
 * **The judgement arm only.** A waiver — `--verdict not_applicable` — claims that
 * no architecture or security question applies to this change at all, which is a
 * scope decision ADR-006 lets a named human make about their own work and which
 * `legion ship` echoes on every payload that carries one. This arm claims that a
 * review *happened*, and that is the claim whoever ran the work cannot make about
 * themselves.
 */
function refuseSelfJudgedDomainAttestation(
  outcome: GateOutcome,
  change: ShipGateChangeFacts | undefined
): GateOutcome {
  const judgement = outcome.judgement;
  if (outcome.status !== "satisfied" || judgement === undefined || change === undefined) return outcome;
  const collision = humanExecutorMatching(change.taskRuns, judgement.attestedBy);
  if (collision === undefined) return outcome;
  return {
    status: "unsatisfied",
    reason:
      `Attestation of ${judgement.attests} for change ${change.changeId} records ${judgement.attestedBy} asserting ` +
      `it passed, and run ${collision.id as string} of this change records the same person as the executor who ` +
      "claimed it. An architecture review asserted by whoever ran the work is not a review of it by anybody else — " +
      "and this is the arm with nothing machine-checkable behind it, so the attester's word is the whole of what " +
      "would be established.",
    recovery: SELF_REVIEWED_DOMAIN_RECOVERY
  };
}

function domainReviewGateStatus(input: {
  readonly gate: RiskGateId;
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  return combineDomainReviewOutcomes(
    domainReviewOutcome(input),
    refuseSelfJudgedDomainAttestation(
      attestationGateStatus({
        gate: input.gate,
        kinds: ATTESTATION_GATE_KINDS[input.gate] as readonly AttestationKind[],
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor,
        absenceRecovery: DOMAIN_REVIEW_RECOVERY
      }),
      input.change
    )
  );
}

/**
 * Would these reviews, alone, satisfy `architecture_or_security_review`?
 *
 * Exported for `legion review`, on `isLiveOracleGrant`'s and
 * `isSatisfyingAttestation`'s rule: a writer whose idea of "done" is weaker than
 * the reader's idea of "satisfied" reports success, writes nothing, and leaves
 * the change permanently blocked with no flag anywhere that would make it write.
 * So this is not a second implementation — it calls `domainReviewOutcome` against
 * a one-plane fact set and asks whether the verdict is `satisfied`.
 *
 * **Two deliberate narrowings, both of which can only make it more generous**, so
 * the warning built on it can only ever under-warn:
 *
 *  - `attestations` is not consulted. This answers about the review route alone;
 *    an unfavourable attestation elsewhere is ship's to report.
 *  - `taskRuns` is `undefined`, so the executor falsifier is vacuous here. It can
 *    only refuse at the gate, never satisfy, so leaving it out cannot make this
 *    predicate say yes where the gate says no.
 */
export function isDomainReviewSatisfying(input: {
  readonly reviews: readonly ReviewDecisionSuccess[];
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): boolean {
  const outcome = domainReviewOutcome({
    gate: "architecture_or_security_review",
    tasks: input.tasks,
    taskIdFor: input.taskIdFor,
    change: {
      changeId: input.changeId,
      acceptance: undefined,
      approvals: undefined,
      attestations: undefined,
      reviews: input.reviews,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: undefined,
      verifyPin: UNRESOLVED_PINS,
      classifySource: UNREAD_SOURCES
    }
  });
  return outcome.status === "satisfied";
}

// --- release observation plan -----------------------------------------------

/**
 * What a recorded release `status` says about whether a *current* plan exists.
 *
 * A total `Record<ReleaseStatus, ...>` rather than a filter, on `GATE_SCOPE`'s
 * rule and for lesson 4's reason. `releaseStatusSchema` has nine members and the
 * specification named two of them as blocking; written as
 * `status !== "failed" && status !== "rollback_required"`, the other three —
 * `rolled_back`, `forward_fix_required` and `superseded` — would fall into the
 * satisfied arm, which is a `default:` that ships an unknown state. Written as a
 * total record, a tenth status added upstream stops this file compiling until
 * somebody classifies it.
 *
 *  - `current` — the plan stands. Only this reaches `satisfied`.
 *  - `failed` — the release failed or has to be rolled back. The gate is
 *    `unsatisfied`: this is a recorded negative about the very thing being asked.
 *  - `closed` — the release was taken back or needs a forward fix. Also
 *    `unsatisfied`, and for the same reason: whatever plan this document held has
 *    been overtaken by what happened, so it is not a plan for the release being
 *    shipped now.
 *  - `replaced` — the document says it is superseded, and it is the only
 *    `release.json` this change has, so there is no current plan at all. That is
 *    an absence rather than a negative, so `unevaluable`.
 *
 * The deferred `legion release observe` moves a plan along
 * `requested → deployed → healthy` (all `current`, so a satisfied gate stays
 * satisfied) or to `failed` (so it flips to `unsatisfied`). Both land in arms
 * that are already correct.
 *
 * **What that verb needed here, and a review of this release found missing, is
 * the other half: nothing may launder a `failed` or `closed` record back to
 * `current`.** `legion release plan` writes `status: "requested"`, so the cure
 * this gate printed for those two families used to be a command that overwrote
 * the negative it was printed about — one run and a rolled-back release read as
 * a fresh green plan. `releaseRecordsNegative` is the predicate that closed it,
 * the writer refuses on it, and those arms now carry a recovery that does not
 * name the writer at all.
 */
type ReleaseStanding = "current" | "failed" | "closed" | "replaced";

const RELEASE_STANDING: Readonly<Record<ReleaseStatus, ReleaseStanding>> = {
  requested: "current",
  staging: "current",
  deployed: "current",
  healthy: "current",
  failed: "failed",
  rollback_required: "failed",
  rolled_back: "closed",
  forward_fix_required: "closed",
  superseded: "replaced"
};

/**
 * Does this document record a release that failed or was taken back?
 *
 * Exported for `legion release plan`, which refuses to overwrite one — and
 * exported as *the gate's own classification* rather than as a status list beside
 * the writer, because a list there is one enum member away from a verb that
 * quietly replaces a rolled-back release with a fresh `requested` plan while the
 * gate still calls that state a recorded negative.
 *
 * `replaced` is deliberately not included. A `superseded` document says of itself
 * that it is not the current plan, the gate answers `unevaluable` for it, and
 * writing the current plan over it is the repair rather than a laundering.
 */
export function releaseRecordsNegative(release: Release): boolean {
  const standing = RELEASE_STANDING[release.status];
  return standing === "failed" || standing === "closed";
}

/**
 * Is this an environment a release *happens* in?
 *
 * **A total `Record<ReleaseEnvironment, ...>`, for exactly the reason
 * `RELEASE_STANDING` is one, and added because a review of this release measured
 * the asymmetry between them.** `environment` was read only to be quoted in the
 * satisfied sentence: a plan naming `local` — "someone will probably notice" as
 * its health criterion, "we change our minds" as its rollback trigger — reported
 * R3 `ready` with ten satisfied gates, no waiver, no named human and no warning.
 * That is a strictly weaker route into this gate than the audited
 * `not_applicable` waiver the design made the only other way in, and it existed
 * because the field was rendered rather than classified.
 *
 *  - `released` — `staging` and `production`. ADR-006 asks for a canary or
 *    observation plan, and these are the two places a canary is watched.
 *  - `prerelease` — `local` and `test`. A developer machine and the environment
 *    the build's own checks run in. A plan naming one of these observes the work
 *    rather than the release of it, so it answers a different question from the
 *    one this gate asks.
 *
 * **This narrows the approved specification, which listed the satisfied
 * conditions without mentioning the environment at all.** The narrowing is the
 * honest reading of the two claims the code already made: `legion release plan`
 * refuses to default `--environment` on the stated grounds that "a plan for local
 * and a plan for production observe different things and are different plans",
 * and the gate's own sentence tells the operator which environment it checked.
 * Either the choice decides something or neither of those sentences is true.
 */
type ReleaseExposure = "released" | "prerelease";

const RELEASE_EXPOSURE: Readonly<Record<ReleaseEnvironment, ReleaseExposure>> = {
  local: "prerelease",
  test: "prerelease",
  staging: "released",
  production: "released"
};

/**
 * The cure when nothing in this change plans the release at all.
 *
 * The state every change on disk is in, so it is also `GATE_RECOVERY`'s entry.
 * It names the waiver in the sentence rather than in the command, on
 * `BASELINE_AFTER_EXECUTION_RECOVERY`'s rule: both are real routes out and only
 * one leaves the change carrying a checkable document.
 */
const RELEASE_PLAN_RECOVERY: ShipGateRecovery = {
  command: "legion release plan --environment <env>",
  reason:
    "Nothing in this change records how its release will be observed or taken back, and no build produces that: the " +
    "gate reads the release plane. Record a plan naming the environment, at least one health criterion, and a " +
    "rollback strategy with at least one criterion. A plan is checkable before the release, which is what makes this " +
    "gate answerable at ship time, and it carries no ordering rule — a plan authored after the build is still a plan, " +
    "because it constrains the release rather than the run. If this change deploys nothing at all, record that " +
    "instead with legion attest release-observation --verdict not_applicable --waiver-reason <text> --attested-by " +
    "<id>, which ADR-006 permits as an audited waiver and which legion ship echoes as a warning on every payload " +
    "that carries one."
};

/**
 * The cure when a plan exists and does not answer the question.
 *
 * Separate from the absence cure because the sentence differs, and separate from
 * `legion ship` because a plan that observes half the change, or that carries no
 * health criterion, is repaired by writing a better plan — which is exactly what
 * the verb does. `legion release plan` rewrites the same document at the next
 * revision, so this is advice that terminates.
 */
const RELEASE_REPLAN_RECOVERY: ShipGateRecovery = {
  command: "legion release plan --environment <env> --health-criterion <text>",
  reason:
    "This change carries a release plan and it does not answer the question this gate asks. Re-plan it: legion " +
    "release plan rewrites the same release.json at the next revision, and it applies the gate's own predicate before " +
    "reporting that there is nothing to write, so a plan it accepts is a plan this gate accepts. It refuses to " +
    "overwrite a release whose status records a failure or a rollback, so this route cannot turn one of those green — " +
    "those arms of this gate print a different recovery for that reason."
};

/**
 * The non-cure for a release this change already recorded as failed or taken back.
 *
 * **Its own recovery, and the defect it was written for was measured on the real
 * CLI.** These four statuses used to print `RELEASE_REPLAN_RECOVERY`, which
 * `shipGateRecovery` promotes to `nextAction.command` — and running exactly that
 * command overwrote the negative with a fresh `status: "requested"` document,
 * dropped the `rollbackEvidenceRefs` the schema had required for it, and turned
 * the gate green with no warning, no waiver entry and nothing in the ship payload
 * recording that a taken-back release had been replaced. A cure that erases the
 * fact it was printed about is worse than no cure: lesson 1 asks that a recovery
 * repair the state it is offered for, and this state is not repaired by anything
 * that ships this change.
 *
 * So the command is `legion ship` — the confirmation step, on
 * `UNREADABLE_RELEASE_RECOVERY`'s precedent — and the sentence names the two real
 * routes: the follow-up work is a new change, or, if the record is wrong, the file
 * is corrected by hand. `legion release plan` refuses this state, so the operator
 * who tries the writer anyway is told the same thing rather than silently
 * succeeding.
 */
const RELEASE_NEGATIVE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "This change's release plane records a release that failed or was taken back, and nothing that ships this change " +
    "repairs that. legion release plan refuses to overwrite a release at one of those statuses — writing a fresh " +
    "requested plan over a recorded failure is how a negative gets laundered — so the follow-up work belongs in a new " +
    "change. If the record itself is wrong, correct or remove the release.json under this change by hand and rerun " +
    "this to confirm."
};

/**
 * The cure for a plan that names an environment nothing is released into.
 *
 * Separate from `RELEASE_REPLAN_RECOVERY` because re-planning with the same
 * `--environment` would exit 0 and leave the gate exactly where it was, which is
 * the advice loop this series exists to close. The command names the two
 * environments that satisfy, and the sentence names the waiver, because an
 * operator whose change genuinely reaches no released environment has an audited
 * route out and re-planning is not it.
 */
const RELEASE_ENVIRONMENT_RECOVERY: ShipGateRecovery = {
  command: "legion release plan --environment <staging|production>",
  reason:
    "This change carries a release plan for an environment nothing is released into, so it plans the work rather than " +
    "the release of it. Re-plan it against the environment this change is actually released to. If this change " +
    "deploys nothing at all, that is the waiver rather than a local plan: legion attest release-observation --verdict " +
    "not_applicable --waiver-reason <text> --attested-by <id>, which legion ship echoes as a warning on every payload " +
    "that carries one."
};

/** The non-cure for a `release.json` that will not read. */
const UNREADABLE_RELEASE_RECOVERY: ShipGateRecovery = {
  command: "legion ship",
  reason:
    "A release plan is present for this change and could not be read, so whether it records a failed release is " +
    "unknown and this gate reports unevaluable rather than absence. legion release plan deliberately refuses to " +
    "overwrite an unread record — writing over one is the one way to silently replace a failed release with a fresh " +
    "plan — so correct or remove the file by hand, then rerun this to confirm."
};

/**
 * The reference a release plan is authored against, or `undefined` when the
 * change id is too degraded to derive one.
 *
 * `artifactPathForRole` parses the change id and throws on a malformed one, and
 * `deriveShipGates` must not throw at the change that is already broken — so the
 * check it feeds is skipped rather than failed in that case, and the other arms
 * of this gate say what is wrong.
 */
function taskgraphPathFor(changeId: string): string | undefined {
  try {
    return artifactPathForRole({ role: "taskgraph", changeId }) as string;
  } catch {
    return undefined;
  }
}

/**
 * The release plan half of `release_observation_plan`.
 *
 * **Every quantifier is checked against its empty case**, because
 * `releaseSchema` bounds neither of the two arrays this gate quantifies over —
 * `taskRefs` and `healthCriteria` are plain `z.array(...)` with no `.min(1)`, so
 * `[].every(...)` is `true` in both directions and a plan that observes nothing
 * would parse and satisfy:
 *
 *  - **No plan** — `unevaluable`. The absence arm, and the state every change on
 *    disk is in.
 *  - **`healthCriteria` empty** — `unsatisfied`, positively. A plan with no
 *    health criterion is a plan that observes nothing, which is a recorded
 *    failure to answer rather than the absence of a record.
 *  - **`rollbackPlan.criteria` empty** — `unsatisfied`. Unreachable from a parsed
 *    document (`.min(1)`), and kept because this function's parameter type admits
 *    it: a gate must not inherit its central truth claim from another module's
 *    invariant.
 *  - **No task derives the gate** — `unevaluable`. "The plan covers every
 *    deriving task" over an empty denominator is vacuously true.
 *  - **`taskRefs` empty** — `unsatisfied`. The specification's "a plan that
 *    observes only part of the change", at its limit.
 *  - **A pre-release `environment`** — `unsatisfied`. See `RELEASE_EXPOSURE`:
 *    every other field on this document was classified and this one was only
 *    rendered, which made `--environment local` a route to a green R3 gate that
 *    needed no human, no waiver reason and no `waivedGates` entry.
 *
 * The denominator is `tasksDeriving`, not every task in the taskgraph, and that
 * is a deliberate narrowing of the specification's wording — the same denominator
 * `attestationRecordStatus` and `domainReviewOutcome` already use. Quantifying
 * over non-deriving tasks would block a mixed-tier change over a task whose tier
 * never asked for a release plan. `legion release plan`'s `--covers` default is
 * still *every* task, which is a superset of the denominator, so the default can
 * only satisfy and never over-refuse.
 */
function releasePlanOutcome(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  const change = input.change;
  const fact = change?.release;

  if (change === undefined || fact === undefined) {
    return {
      status: "unevaluable",
      reason:
        "The release plan recorded for this change was not read, so whether anything plans how its release will be " +
        "observed is unestablished.",
      recovery: UNREADABLE_PLANE_RECOVERY,
      // The plane was not read whole, and what is in it may be a `failed`
      // release. See `GateOutcome.concealsNegative`.
      concealsNegative: true
    };
  }

  if (fact.kind === "unreadable") {
    return {
      status: "unevaluable",
      reason:
        `${fact.path} is present for change ${change.changeId} and could not be read as a release plan, so whether ` +
        "this change carries one — and whether the one it carries records a failed release — is unestablished.",
      recovery: UNREADABLE_RELEASE_RECOVERY,
      concealsNegative: true
    };
  }

  if (fact.kind === "absent") {
    return {
      status: "unevaluable",
      reason:
        `No release plan is recorded for change ${change.changeId}, so nothing says how its release would be ` +
        "observed or taken back.",
      recovery: RELEASE_PLAN_RECOVERY
    };
  }

  const plan = fact.document;
  const describe = `Release plan ${plan.id as string} for change ${change.changeId}`;

  // Strict equality against a possibly-absent change id, on the approvals
  // plane's rule: a record too degraded to name its own change answers for
  // nothing rather than for everything. `readRelease` refuses this too; the
  // parameter type admits it, so it is refused here as well.
  if ((plan.changeId as string) !== change.changeId) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names change ${plan.changeId as string} rather than ${change.changeId}, so it is a plan about ` +
        "another change sitting at this change's path.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }

  const standing = RELEASE_STANDING[plan.status];
  if (standing === "failed") {
    return {
      status: "unsatisfied",
      reason:
        `${describe} records status "${plan.status}", which is a recorded negative about the release this gate asks ` +
        "about: the plan exists and what happened under it is that the release failed or has to be taken back.",
      recovery: RELEASE_NEGATIVE_RECOVERY
    };
  }
  if (standing === "closed") {
    return {
      status: "unsatisfied",
      reason:
        `${describe} records status "${plan.status}", so the release it planned has already been taken back or needs ` +
        "a forward fix. That is a record of what happened rather than a plan for what will, and this change carries " +
        "no other release plan.",
      recovery: RELEASE_NEGATIVE_RECOVERY
    };
  }
  if (standing === "replaced") {
    return {
      status: "unevaluable",
      reason:
        `${describe} records status "superseded", and it is the only release plan this change has — so it says of ` +
        "itself that it is not the current plan, and there is no current plan to read.",
      recovery: RELEASE_PLAN_RECOVERY
    };
  }

  if (RELEASE_EXPOSURE[plan.environment] === "prerelease") {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names ${plan.environment} as the environment it observes, and nothing is released into ` +
        `${plan.environment}: it is where the work runs rather than where this change reaches anything. This gate ` +
        "asks how the release is observed and taken back, so a plan for a pre-release environment is a recorded " +
        "failure to answer it rather than an answer. A change that deploys nothing at all is waived through legion " +
        "attest release-observation --verdict not_applicable, which is audited, names a human and is echoed on every " +
        "ship payload that carries one.",
      recovery: RELEASE_ENVIRONMENT_RECOVERY
    };
  }

  if (plan.healthCriteria.length === 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names no health criterion, so it plans a release nothing would be observed against. ` +
        "releaseSchema does not bound this array, so an empty one parses; this gate refuses it positively rather " +
        "than quantifying over it and finding the quantifier vacuously true.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }
  if (plan.rollbackPlan.criteria.length === 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} declares a ${plan.rollbackPlan.strategy} rollback strategy and no criterion that would trigger ` +
        "it, so nothing says when the release would be taken back.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }

  // The one reader `releaseIntent` has, and it is a *path* comparison rather
  // than a byte pin. See `shipGatePinnedReferences` for why this plane
  // deliberately gets no pinned-reference family: `legion review --accept`
  // rewrites `taskgraph.json` through `repointChangeProposalInputs`, so a digest
  // recorded before the accept drifts during it and the gate would report
  // `unsatisfied` for a governance write that changed no task. What the plan has
  // to be self-consistent about is *which document its taskRefs were drawn from*,
  // and that is a path.
  const taskgraphPath = taskgraphPathFor(change.changeId);
  if (taskgraphPath !== undefined && (plan.releaseIntent.path as string) !== taskgraphPath) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names ${plan.releaseIntent.path as string} as the release intent it was planned against, and a ` +
        `plan's task coverage is drawn from this change's task graph at ${taskgraphPath}. A plan authored against ` +
        "something else records coverage of a set this report cannot check it over.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }

  const deriving = tasksDeriving("release_observation_plan", input.tasks);
  if (deriving.length === 0) {
    return {
      status: "unevaluable",
      reason:
        `${describe} exists, and no task of this change derives release_observation_plan, so there is nothing for a ` +
        "plan to observe.",
      recovery: RELEASE_PLAN_RECOVERY
    };
  }

  const covered = new Set(plan.taskRefs.map((taskId) => taskId as string));
  if (covered.size === 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names no task at all, so it is a plan that observes none of this change. This gate is derived ` +
        `by ${deriving.length} task${deriving.length === 1 ? "" : "s"} and is satisfied only when the plan speaks ` +
        "for all of them.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }
  const uncovered = deriving.map(input.taskIdFor).filter((taskId) => !covered.has(taskId));
  if (uncovered.length > 0) {
    return {
      status: "unsatisfied",
      reason:
        `${describe} names ${covered.size} task${covered.size === 1 ? "" : "s"}, leaving ${uncovered.join(", ")} ` +
        `uncovered. This gate is derived by ${deriving.length} task${deriving.length === 1 ? "" : "s"} of this ` +
        "change and is satisfied only when the plan observes all of them.",
      recovery: RELEASE_REPLAN_RECOVERY
    };
  }

  return {
    status: "satisfied",
    reason:
      `${describe} observes it in ${plan.environment}, an environment this change is released into: ` +
      `${plan.healthCriteria.length} health criteri` +
      `${plan.healthCriteria.length === 1 ? "on" : "a"}, a ${plan.rollbackPlan.strategy} rollback plan with ` +
      `${plan.rollbackPlan.criteria.length} criteri${plan.rollbackPlan.criteria.length === 1 ? "on" : "a"}, and ` +
      `coverage of all ${deriving.length} task${deriving.length === 1 ? "" : "s"} that derive ` +
      "release_observation_plan. This is a plan and not an observation: nothing here records that the release " +
      "happened or that the criteria held. legion dev board release-observation is where a post-deployment report " +
      "lands, and it is a different plane that no ship gate reads."
  };
}

/**
 * `release_observation_plan`, over its two producers.
 *
 * The release plan is the primary, and it wins the tie against an equally-ranked
 * attestation outcome for `combineProducerOutcomes`' stated reason: both are true
 * sentences and only one of them names a route that leaves the change carrying a
 * checkable document. `absenceRecovery` is passed because `attestRecovery`'s
 * sentence — "no build produces one: the gate reads the attestation plane" — is
 * true of the attestation half and misleading about the gate, which `legion
 * release plan` satisfies without anybody attesting anything.
 */
function releaseObservationPlanStatus(input: {
  readonly change: ShipGateChangeFacts | undefined;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): GateOutcome {
  return combineProducerOutcomes({
    primary: releasePlanOutcome(input),
    secondary: attestationGateStatus({
      gate: "release_observation_plan",
      kinds: ATTESTATION_GATE_KINDS.release_observation_plan as readonly AttestationKind[],
      change: input.change,
      tasks: input.tasks,
      taskIdFor: input.taskIdFor,
      absenceRecovery: RELEASE_PLAN_RECOVERY
    }),
    describePrimary: "release observation plan",
    describeSecondary: "release-observation attestation"
  });
}

/**
 * Would this one document, alone, satisfy `release_observation_plan`?
 *
 * Exported for `legion release plan`, on `isLiveOracleGrant`'s,
 * `isSatisfyingAttestation`'s and `isDomainReviewSatisfying`'s rule — this
 * series' third lesson, which it has now paid for four times: a writer whose
 * idea of "done" is weaker than the reader's idea of "satisfied" reports success,
 * writes nothing, and leaves the change permanently blocked with no flag anywhere
 * that would make it write. So this is not a second implementation. It calls
 * `releasePlanOutcome` against a one-plane fact set and asks whether the verdict
 * is `satisfied`.
 *
 * **One deliberate narrowing, and it can only make the predicate less generous
 * about reporting "nothing to do".** The attestation plane is not consulted: an
 * existing `not_applicable` waiver must never make this command report "already
 * planned" and refuse to write the plan the operator asked for. It answers about
 * the artifact route alone, which is the route this verb writes.
 */
export function isSatisfyingReleasePlan(input: {
  readonly release: Release;
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): boolean {
  return releasePlanShortfall(input) === undefined;
}

/**
 * The gate's own sentence about why this one document would not satisfy it, or
 * `undefined` when it would.
 *
 * The same call `isSatisfyingReleasePlan` makes, returning the reason rather than
 * only the bit — so `legion release plan` can warn in **the reader's words**
 * instead of paraphrasing the reader. A paraphrase is what went wrong in the
 * warning this replaces: `release_plan_partial_coverage` told the operator "ship
 * will report it unsatisfied" over a set the gate does not quantify over, so the
 * one sentence written to make the gate's verdict predictable could be wrong
 * about it.
 */
export function releasePlanShortfall(input: {
  readonly release: Release;
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  readonly taskIdFor: (task: TaskContract) => string;
}): string | undefined {
  const outcome = releasePlanOutcome({
    tasks: input.tasks,
    taskIdFor: input.taskIdFor,
    change: {
      changeId: input.changeId,
      acceptance: undefined,
      approvals: undefined,
      attestations: undefined,
      reviews: undefined,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: { kind: "document", document: input.release },
      evaluatedAt: undefined,
      verifyPin: UNRESOLVED_PINS,
      classifySource: UNREAD_SOURCES
    }
  });
  return outcome.status === "satisfied" ? undefined : outcome.reason;
}

/** The evidence item `legion build` writes about declared acceptance paths. */
const PROTECTED_ACCEPTANCE_ITEM = "protected-acceptance-paths";

/**
 * The action an approval carries when it blesses a modification to a protected
 * acceptance path.
 *
 * The same literal `legion approve protected-paths` writes, spelled out in both
 * places rather than shared through a constant, on `DELTA_SPEC_APPROVE_ACTION`'s
 * rule: the gate and the writer are two sides of a contract, and a shared symbol
 * would let a rename move both at once and leave every approval already on disk
 * unreadable by the gate that reads them.
 */
const PROTECTED_PATHS_MODIFY_ACTION = "oracle.protected-paths.modify";

const ACCEPTANCE_PATHS_DECLARE_RECOVERY: ShipGateRecovery = {
  command: "legion start --intake",
  reason:
    "No oracle in this change names a test the work must not weaken, so there is nothing for the harness to watch and " +
    "nothing this gate can be satisfied by. Declare the acceptance tests on an executable acceptance criterion at " +
    "intake and re-plan, or lower the risk tier through an audited risk.override if this change genuinely has no " +
    "acceptance test to protect."
};

const ACCEPTANCE_PATHS_BUILD_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "This change declares protected acceptance paths and this task's latest evidence does not record what its run did " +
    "to them. The observation is taken across a dispatch, so only a run can produce it: build, then rerun legion ship."
};

/**
 * The cure for a run that could not compare a declared path on both sides.
 *
 * Its own recovery rather than `ACCEPTANCE_PATHS_BUILD_RECOVERY`, because that
 * one's sentence — "this task's latest evidence does not record what its run did"
 * — is false here: the run did record, and what it recorded is that it could not
 * tell. And because `legion build` alone is a cure for only one of the two ways
 * to reach this arm. The other is a pre-run state this change already recorded
 * that can no longer be read back, and rebuilding re-reads the same missing
 * report and answers `unknown` again. Lesson 1 is that a recovery has to repair
 * the state it is offered for, so both routes are named and the cited report says
 * which one applies.
 */
const ACCEPTANCE_PATHS_UNKNOWN_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "A declared acceptance path could not be compared on both sides of the run. The cited " +
    "runs/<runId>/protected-paths.json names which and why. If a declaration points at a file that is not there, " +
    "correct the path on the criterion and re-plan — a rebuild will report the same thing. If the report of an " +
    "earlier run of this change is missing or no longer matches the digest its evidence cites, restore it from " +
    "version control first: what this change's first run saw is what a later run is judged against, and a build " +
    "cannot reconstruct a record that was deleted."
};

/**
 * The cure for a run that changed a protected acceptance path without a decision
 * behind it — and the one post-execution cure in this file that genuinely repairs
 * the state it is offered for.
 *
 * **Deliberately not `legion approve protected-paths`.** That approval must
 * predate the run, and this arm is reachable only after one; approving now writes
 * a strictly later `decidedAt`, exits 0, and leaves the gate blocked forever —
 * `BASELINE_AFTER_EXECUTION_RECOVERY`'s rule, and the defect `orderingAwareRecovery`
 * exists to stop this file reproducing for a third verb.
 *
 * Restoring the bytes re-dates nothing, which is exactly why `ORACLE_BYTES_RECOVERY`
 * is preserved through `orderingAwareRecovery` rather than collapsed into
 * "re-plan": the tampering case is the one post-execution state that is genuinely
 * repairable, and the run artifact this gate cites records what each path was
 * before the run so the operator has something to restore *to*.
 */
const ACCEPTANCE_PATHS_RESTORE_RECOVERY: ShipGateRecovery = {
  command: "legion build",
  reason:
    "A run changed an acceptance test this change's oracles say it must not weaken, and no human decided that before " +
    "the run started. Restore the path to the pre-run state recorded in this task's runs/<runId>/protected-paths.json " +
    "and build again; the next run's observation then records pass. Building again *without* restoring records the same " +
    "fail, because a run is compared against the state this change's first run saw rather than against whatever the " +
    "last attempt left. Approving now cannot help — this gate requires the decision to predate the run, and legion " +
    "approve protected-paths writes a later instant, which makes this strictly worse. If the modification was intended, " +
    "plan the remaining work as a new change and approve it before building."
};

/**
 * The `protected-acceptance-paths` item recorded by this task's latest attempt.
 *
 * **Latest attempt, and the soundness of that lives in the harness rather than
 * here.** Four reviewers drove the same sequence against the compiled build:
 * attempt 1 guts the test and records `fail`, the operator runs the recovery this
 * gate names without restoring anything, and attempt 2 — whose pre-dispatch
 * snapshot hashed the already-gutted file — records `pass`. Reading the latest
 * attempt then reported `satisfied` over bytes nobody put back.
 *
 * The fix is not "fold every attempt and let a `fail` stand forever". That would
 * close this hole by opening `evidence-selection.ts`'s: the operator restores the
 * file, rebuilds, and stays blocked on a record no command can clear, so the
 * recovery named below would repair nothing — lesson 1, inverted. It is instead
 * that a run's `before` is anchored to the earliest state *this change* recorded
 * for the path, so attempt 2 without a restore records `fail` again and attempt 3
 * after one records `pass`. See guarantee 7 of `guarded-execution.ts` and
 * `acceptance-baseline.ts`. Latest-attempt-only is correct here for the same
 * reason it is correct everywhere else — once the thing being reported is a fact
 * about the change rather than about the attempt.
 *
 * `surfaceCheckVerdict`'s sibling and deliberately not `evidenceItemVerdict`,
 * which collapses everything that is not `pass`/`fail` to `undefined`. This gate
 * has three verdicts and the third — `unknown`, "a declared path neither side of
 * the run could resolve" — must reach the gate spelled differently from "no such
 * item was written", because one means a build is needed and the other means a
 * declaration names something that is not there.
 *
 * The whole item is returned rather than the verdict alone: the trace references
 * are what say which declarations the run that wrote it actually snapshotted.
 */
function protectedAcceptanceItem(
  entries: readonly EvidenceIndexEntry[],
  taskId: string
): EvidenceItem | undefined {
  const entry = latestEvidencePerTask(entries).get(taskId);
  if (entry === undefined) return undefined;
  return entry.evidence.items.find((item) => item.id === PROTECTED_ACCEPTANCE_ITEM);
}

/** One oracle's declared protected acceptance paths. */
export interface DeclaredAcceptancePaths {
  readonly oracleId: string;
  readonly oracle: ShipGateOracleFact;
  readonly paths: readonly string[];
}

/**
 * Every protected acceptance path this change's oracles declare.
 *
 * Change-wide rather than per task, matching what `legion build` hands the
 * harness. `legion plan` materialises one task per executable criterion, so a
 * per-task declaration set would let task B's run weaken a test task A's oracle
 * protects and be invisible to both — B never snapshotted it, and A's item
 * predates it. The gate is still evaluated per task, because the *run* whose
 * evidence answers is that task's own.
 *
 * Exported so `legion approve protected-paths` walks the gate's own subject set,
 * on `changeVerificationSurfaces`' recorded argument: a writer walking its own
 * smaller set could bless an oracle the gate does not read, or miss one it does.
 *
 * `unestablished` is not "no declarations". The oracle plane is all-or-nothing at
 * the boundary, and concluding that nothing is protected from a plane that failed
 * to load is the fail-open every all-or-nothing fact in `ShipGateChangeFacts`
 * exists to prevent: "every declared path is unchanged" is trivially true of a
 * list that lost the oracle protecting the touched one.
 */
export function changeAcceptancePathDeclarations(input: {
  readonly change: ShipGateChangeFacts | undefined;
}): {
  readonly declarations: readonly DeclaredAcceptancePaths[];
  readonly unestablished: boolean;
} {
  const oracles = input.change?.oracles;
  if (oracles === undefined) return { declarations: [], unestablished: true };
  const declarations: DeclaredAcceptancePaths[] = [];
  for (const oracle of oracles) {
    // Positive check on the declaration being present, before any quantifier
    // touches it. `acceptancePaths` is `.optional()` precisely so that "nobody
    // declared one" is a state rather than an empty array every `every` passes.
    const paths = oracle.document.acceptancePaths;
    if (paths === undefined || paths.length === 0) continue;
    declarations.push({ oracleId: oracle.document.id, oracle, paths: [...paths] });
  }
  return {
    declarations: declarations.slice().sort((left, right) => left.oracleId.localeCompare(right.oracleId)),
    unestablished: false
  };
}

/**
 * Has a named human blessed modifying the acceptance paths this oracle declares?
 *
 * `surfacePinReaffirmation`'s rules, reused verbatim rather than re-argued: scope
 * the plane to this change and this action, require a `granted` document with a
 * human decider, judge expiry against the injected clock, and let a standing
 * negative beat the grant unless a *strictly later* grant supersedes it.
 *
 * The one addition is the pin, and it is what stops the grant becoming a blanket
 * exemption. The approval pins the oracle document the approver read, so
 * re-planning that oracle to protect *different* paths invalidates the decision
 * rather than silently extending it to a set nobody looked at.
 *
 * **The ordering rule is deliberately not here.** `isLiveOracleGrant` records
 * why: a writer that included it would report "already decided" as false for a
 * harmless rerun, write a fresh `decidedAt`, and turn a valid ordering into an
 * invalid one. The gate applies ordering on top of this.
 */
function protectedPathsModifyGrant(input: {
  readonly oracle: ShipGateOracleFact;
  readonly change: ShipGateChangeFacts;
}): { readonly by: string; readonly at: UtcTimestamp } | undefined {
  const approvals = input.change.approvals;
  if (approvals === undefined) return undefined;
  const oracleId = input.oracle.document.id;

  const relevant = approvals.filter(
    (approval) =>
      approval.changeId === input.change.changeId &&
      approval.scope.action === PROTECTED_PATHS_MODIFY_ACTION &&
      approval.scope.targets.some((target) => target.kind === "oracle" && target.id === oracleId)
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

  const standing = relevant.some(
    (approval) =>
      (approval.status === "denied" || approval.status === "revoked" || approval.status === "expired") &&
      (approval.decidedAt === undefined || approval.decidedAt >= newestGrant.decidedAt)
  );
  if (standing) return undefined;

  const oraclePath = input.oracle.reference.path;
  const pins = (newestGrant.artifacts ?? []).filter((reference) => reference.path === oraclePath);
  // Exactly one, on `approvedOraclePin`'s rule: `artifacts` carries no uniqueness
  // constraint, so a `find` would take whichever duplicate came first and a
  // document pinning both the right digest and a wrong one would sail through.
  if (pins.length !== 1) return undefined;
  const pin = pins[0] as ArtifactReference;
  if (pin.sha256 !== input.oracle.reference.sha256) return undefined;

  return { by: newestGrant.decidedBy.id, at: newestGrant.decidedAt };
}

/**
 * Would this one document, alone, let the gate accept a modification to the paths
 * this oracle declares?
 *
 * Exported for `legion approve protected-paths`, which has to answer "is there
 * anything left to decide here" and must not answer it with its own weaker rule.
 * PR 2 recorded what that costs: a writer whose idea of "done" is weaker than the
 * reader's idea of "satisfied" reports success, writes nothing, and leaves the
 * change permanently blocked. So this is not a second implementation — it *calls*
 * `protectedPathsModifyGrant` against a one-document plane.
 */
export function isLiveProtectedPathsModifyGrant(input: {
  readonly approval: Approval;
  readonly changeId: string;
  readonly oracle: ShipGateOracleFact;
  readonly evaluatedAt: UtcTimestamp | undefined;
}): boolean {
  const granted = protectedPathsModifyGrant({
    oracle: input.oracle,
    change: {
      changeId: input.changeId,
      acceptance: undefined,
      approvals: [input.approval],
      attestations: undefined,
      reviews: undefined,
      deltas: undefined,
      oracles: undefined,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: input.evaluatedAt,
      verifyPin: UNRESOLVED_PINS,
      classifySource: UNREAD_SOURCES
    }
  });
  return granted !== undefined;
}

/**
 * Can the implementer's run weaken the tests it is judged by?
 *
 * The subject set is the change's oracles' declared acceptance paths; the verdict
 * is this task's own run evidence, because a run is what the harness observed.
 *
 * **The arms run declarations → coverage → negatives → positives, and that order
 * is the gate's defence against a stale pass.** The evidence item is written at
 * build time and stays `pass` forever, while the oracles can be replanned and an
 * approval revoked afterwards; a verdict read first would let the build's own
 * answer mask both. `nonUnitSurfaceOutcome` orders pins before verdict for the
 * same reason and this gate needs it more sharply, because the *declaration set
 * itself* can grow after the run.
 *
 * Every quantifier is checked against the empty case, positively:
 *
 *  - The oracle plane unread is `unestablished`, never "nothing is protected".
 *  - No oracle declaring a path is `unevaluable` with its own sentence, decided
 *    from the declarations rather than from a verdict. **This is the branch every
 *    change on disk today is in, and saying so is the honest answer.** It is not
 *    computed as "the non-control-plane subset of `protectedPaths` is empty",
 *    which would be `[].every(...)` and therefore true everywhere;
 *    `acceptancePaths` is a separate `.optional()` field precisely so absence is
 *    a state rather than a vacuum.
 *  - A declaration the run never snapshotted is `unevaluable`, not folded into
 *    the pass beside it.
 *
 * There is no arm that returns `satisfied` by falling through.
 */
function protectedAcceptancePathsStatus(input: {
  readonly taskId: string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly change: ShipGateChangeFacts | undefined;
}): GateOutcome {
  const { declarations, unestablished } = changeAcceptancePathDeclarations({ change: input.change });
  if (unestablished) {
    return {
      status: "unevaluable",
      reason:
        "The oracles recorded for this change could not be read as a complete set, so which acceptance tests its runs must not weaken is unestablished.",
      recovery: UNREADABLE_PLANE_RECOVERY
    };
  }
  if (declarations.length === 0) {
    return {
      status: "unevaluable",
      reason:
        "No oracle in this change declares a protected acceptance path, so nothing says which tests its runs must not weaken. Nobody said, so nothing is known.",
      recovery: ACCEPTANCE_PATHS_DECLARE_RECOVERY
    };
  }

  const declaredPaths = declarations.flatMap((declaration) => declaration.paths);
  const item = protectedAcceptanceItem(input.entries, input.taskId);
  if (item === undefined) {
    return {
      status: "unevaluable",
      reason: `${input.taskId}'s latest evidence records no ${PROTECTED_ACCEPTANCE_ITEM} item, so nothing says whether its run changed the ${declaredPaths.length} acceptance path(s) this change's oracles declare (${declaredPaths.join(", ")}).`,
      recovery: ACCEPTANCE_PATHS_BUILD_RECOVERY
    };
  }

  // Which declarations the run that wrote this item actually snapshotted. A
  // declaration added by a replan afterwards is covered by no pre-run snapshot,
  // and folding it into the item's own verdict would certify a path nothing ever
  // hashed.
  const covered = new Set(
    (item.traceRefs ?? [])
      .filter((reference) => reference.entity?.kind === "oracle")
      .map((reference) => `${reference.entity?.id ?? ""}\n${reference.path}`)
  );
  for (const declaration of declarations) {
    for (const declaredPath of declaration.paths) {
      if (covered.has(`${declaration.oracleId}\n${declaredPath}`)) continue;
      return {
        status: "unevaluable",
        reason: `${declaredPath}, declared by oracle ${declaration.oracleId}, is covered by no pre-run snapshot in ${input.taskId}'s latest evidence: it was declared after the run that produced it.`,
        recovery: ACCEPTANCE_PATHS_BUILD_RECOVERY
      };
    }
  }

  const artifactPath = item.artifact?.path;
  const cites = artifactPath === undefined ? "" : ` ${artifactPath} records what each path was before and after.`;

  if (item.verdict === "unknown") {
    return {
      status: "unevaluable",
      reason: `${input.taskId}'s run could not compare every protected acceptance path this change's oracles declare on both sides of the dispatch, so whether one was weakened is unestablished.${cites}`,
      recovery: ACCEPTANCE_PATHS_UNKNOWN_RECOVERY
    };
  }

  if (item.verdict === "fail") {
    const change = input.change;
    if (change === undefined || change.approvals === undefined) {
      return {
        status: "unevaluable",
        reason: `${input.taskId}'s run changed a protected acceptance path, and the approvals recorded for this change could not be read, so whether a human decided that beforehand is unestablished.`,
        recovery: UNREADABLE_PLANE_RECOVERY
      };
    }
    const execution = executionOrdering(change.taskRuns);
    if (execution.kind !== "started") {
      return {
        status: "unevaluable",
        reason: `${input.taskId}'s run changed a protected acceptance path, and this change's task runs do not establish when execution began, so whether any decision predates it is unknown.`,
        recovery: ORDERING_UNREADABLE_RECOVERY
      };
    }

    // Blanket authorisation, and the coarseness is deliberate. `evidenceItemSchema`
    // has no field in which the *touched* path set could reach a gate, so a check
    // of the form "some grant names some oracle" would bless the weakening of a
    // path nobody approved. Every declaring oracle must therefore carry a live
    // pre-run grant; the sentence names each one that does not, and the cited
    // report says which path actually moved.
    const unapproved: string[] = [];
    const late: string[] = [];
    const granted: { readonly by: string; readonly at: UtcTimestamp }[] = [];
    for (const declaration of declarations) {
      const grant = protectedPathsModifyGrant({ oracle: declaration.oracle, change });
      if (grant === undefined) {
        unapproved.push(`${declaration.oracleId} (${declaration.paths.join(", ")})`);
        continue;
      }
      // Strict, on `approvedSpecAndOracleStatus`' rule: both stamps are
      // millisecond wall-clock, no honest writer produces the equal pair, and an
      // unorderable pair is not evidence that the decision came first.
      if (grant.at >= execution.startedAt) {
        late.push(`${declaration.oracleId} (decided ${grant.at} by ${grant.by})`);
        continue;
      }
      granted.push(grant);
    }

    if (unapproved.length > 0) {
      return {
        status: "unsatisfied",
        reason: `${input.taskId}'s run changed at least one of the ${declaredPaths.length} protected acceptance path(s) this change's oracles declare, and no granted ${PROTECTED_PATHS_MODIFY_ACTION} approval decided before run ${execution.runId} started at ${execution.startedAt} permits it for ${unapproved.join("; ")}.${cites}`,
        recovery: ACCEPTANCE_PATHS_RESTORE_RECOVERY
      };
    }
    if (late.length > 0) {
      return {
        status: "unsatisfied",
        reason: `${input.taskId}'s run changed a protected acceptance path, and the decision permitting it was taken at or after run ${execution.runId} of ${execution.taskId} started at ${execution.startedAt}: ${late.join("; ")}. A decision taken after the work is not a decision the work was done under, and nothing re-orders one already taken.${cites}`,
        recovery: ACCEPTANCE_PATHS_RESTORE_RECOVERY
      };
    }
    const first = granted[0] as { readonly by: string; readonly at: UtcTimestamp };
    return {
      status: "satisfied",
      reason: `${input.taskId}'s run changed a protected acceptance path, and ${first.by} approved modifying the paths every declaring oracle protects at ${first.at}, before run ${execution.runId} started at ${execution.startedAt}, against the oracle bytes this change still carries.${cites}`
    };
  }

  if (item.verdict === "pass") {
    return {
      status: "satisfied",
      reason: `Every protected acceptance path this change's oracles declare (${declaredPaths.join(", ")}) still matches the state this change's first run recorded for it, as of ${input.taskId}'s latest run: nothing that run did, and nothing done between this change's runs, weakened them.`
    };
  }

  // Any other verdict is a shape this gate does not recognise, and an
  // unrecognised state is unestablished rather than acceptable.
  return {
    status: "unevaluable",
    reason: `${input.taskId}'s ${PROTECTED_ACCEPTANCE_ITEM} item records the verdict "${String(item.verdict)}", which this gate cannot read as an answer about whether a protected acceptance path was weakened.`,
    recovery: ACCEPTANCE_PATHS_BUILD_RECOVERY
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
   * Nine arms read it now — `explicit_human_approval` the approvals plane,
   * `approved_delta_spec` the deltas, `integration_or_real_interface_checks` the
   * oracles and the pin verifier, `whole_change_acceptance_evidence` the
   * acceptance and the clock, `approved_spec_and_oracle` all of those plus the
   * run plane, the three attestation gates the attestation plane, and
   * `architecture_or_security_review` the reviews plane beside it, and
   * `protected_acceptance_tests` the oracles for its declaration set plus the
   * approvals and the run plane for the decision that may permit a change, and
   * `release_observation_plan` the release plane beside the attestation one — so
   * the signature is doing the job it was landed for: each gate's diff touches
   * its own `case` rather than this one.
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
   * not just the one whose tier derived the gate. `approved_spec_and_oracle`
   * needs them for a sharper reason still: the set of oracles that have to have
   * been approved is the set the *tasks name*, which is the only reading of that
   * set a deleted oracle file cannot shrink.
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

    case "approved_spec_and_oracle":
      // No `taskId`, no `reviews`, no `entries`, on `approved_delta_spec`'s
      // rule: a change-scoped gate must not be able to answer per task even by
      // accident, so it is not handed anything per task to answer with. `tasks`
      // and `taskIdFor` are the *denominator* — the set whose `oracleRefs` and
      // `requirementIds` say what has to have been approved — rather than a
      // per-task input.
      return approvedSpecAndOracleStatus({
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor
      });

    case "independent_baseline":
    case "security_or_e2e_evaluator":
    case "rollback_or_forward_fix_evidence": {
      // No `taskId`, no `reviews`, no `entries`, on `approved_delta_spec`'s
      // rule: a change-scoped gate must not be able to answer per task even by
      // accident, so it is not handed anything per task to answer with. `tasks`
      // and `taskIdFor` are the *denominator* — the set `covers` is checked
      // against — rather than a per-task input.
      const kinds = ATTESTATION_GATE_KINDS[gate.id] as readonly AttestationKind[];
      return attestationGateStatus({
        gate: gate.id,
        kinds,
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor,
        // Only this one. `security_or_e2e_evaluator` evaluates the implemented
        // change, which necessarily comes after it, and rollback evidence is
        // about the repository as it stands — an ordering rule on either would
        // make an honest attestation permanently unsatisfiable.
        ...(gate.id === "independent_baseline" ? { requireBeforeExecution: true } : {})
      });
    }

    case "architecture_or_security_review":
      // No `taskId`, no `reviews`, no `entries`, on `approved_delta_spec`'s
      // rule: a change-scoped gate must not be able to answer per task even by
      // accident, so it is not handed anything per task to answer with. It reads
      // the reviews off `change` rather than off the top-level `reviews`
      // parameter, and that is not a stylistic preference: this is the first gate
      // with an `unsatisfied` arm that reads a review, and the top-level
      // parameter is a listing that silently drops what it cannot parse. `tasks`
      // and `taskIdFor` are the *denominator* the coverage quantifier runs over.
      return domainReviewGateStatus({
        gate: gate.id,
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor
      });

    case "protected_acceptance_tests":
      // No `reviews`, on `approved_delta_spec`'s rule. `taskId` and `entries` are
      // kept, and that is the deliberate half: the *subject set* is change-wide —
      // the acceptance paths every oracle of the change declares, which is what
      // `legion build` hands the harness — while the *verdict* is this task's own
      // run, because a run is the thing the harness observed. A task whose run
      // weakened a test another task's oracle protects is caught under its own
      // task id, which is where the operator can act on it.
      return protectedAcceptancePathsStatus({ taskId, entries, change: input.change });

    case "release_observation_plan":
      // No `taskId`, no `reviews`, no `entries`, on `approved_delta_spec`'s
      // rule: a change-scoped gate must not be able to answer per task even by
      // accident, so it is not handed anything per task to answer with. `tasks`
      // and `taskIdFor` are the *denominator* the release plan's `taskRefs` are
      // checked against.
      return releaseObservationPlanStatus({
        change: input.change,
        tasks: input.tasks,
        taskIdFor: input.taskIdFor
      });

    default:
      // **Every `RiskGateId` now has a `case`, so this arm answers for none of
      // them.** It is kept rather than deleted, and the reason is that
      // `tests/change-r3-ordering` derives its producerless set by matching this
      // exact reason string: with the arm gone that derivation returns `[]` by
      // construction and becomes a tautology that can never redden again, which
      // is precisely what that file's own comment warns against. With the arm
      // here it is a permanent tripwire instead — let one of the twenty gates
      // regress to this reason and it reddens there without anybody having
      // touched this file. `RiskGateId` is a closed union, so a gate added
      // upstream lands here too, which is the runtime net `GATE_SCOPE` and
      // `GATE_RECOVERY` make the same argument for being total records.
      return {
        status: "unevaluable",
        reason: "Legion does not yet produce evidence for this gate."
      };
  }
}

/** The verifier substituted when a caller supplied none. Answers nothing. */
const UNRESOLVED_PINS: VerifyPinnedReference = () => "unverified";

/**
 * The classifier substituted when a caller supplied none.
 *
 * `unread` rather than `unrecognised`, because the two are different facts with
 * different sentences: "nobody collected these bytes" is the reader's problem,
 * and "these bytes are in no shape I know" is the artifact's. Both refuse a
 * pass, so the substitution cannot fail open either way.
 */
const UNREAD_SOURCES: ClassifyEvidenceSource = () => ({
  kind: "unread",
  reason: "this report carries no way to read a cited source"
});

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
  readonly attestations: readonly Attestation[] | undefined;
  readonly tasks: readonly TaskContract[];
}): readonly ArtifactReference[] {
  return [
    // The delta spec bytes `approved_delta_spec` compares an approval against.
    ...(input.deltas?.map((delta) => delta.delta) ?? []),
    // The oracle documents themselves, which `approved_spec_and_oracle` compares
    // an oracle approval's pin against.
    ...(input.oracles?.map((oracle) => oracle.reference) ?? []),
    // The files an oracle's declared verification surface pins.
    ...(input.oracles?.flatMap((oracle) => oracle.document.surface?.pinned ?? []) ?? []),
    // The files a task contract's declared verification surface pins. Ordinary
    // repository files rather than project artifacts, which is the case
    // `pinned-references.ts` resolves paths for itself.
    ...input.tasks.flatMap((task) => (task.verification ?? []).flatMap((entry) => entry.surface?.pinned ?? [])),
    // The bytes any approval was decided against.
    ...(input.approvals?.flatMap((approval) => approval.artifacts ?? []) ?? []),
    // The reports any attestation cites. The sixth family, and the first whose
    // paths are guaranteed to be *outside* `.legion/project` — an attestation
    // pins `docs/next/evidence/...`, which is exactly the case
    // `pinned-references.ts` resolves paths itself for. It is also the family
    // whose omission would be least visible: an attestation whose sources
    // answered `unverified` would pin its gate at `unevaluable` forever, which
    // is indistinguishable at the readiness arithmetic from nobody having
    // attested anything.
    ...(input.attestations?.flatMap((attestation) => attestation.sources) ?? [])
    // **No family for protected acceptance paths, deliberately.** The
    // `oracle.protected-paths.modify` approval pins the *oracle document* the
    // approver read, and that reference is already collected twice over — as an
    // oracle reference and as an approval artifact. The acceptance test files
    // themselves are not pinned by anything and must not be: this gate certifies
    // what a run did across one dispatch, and the digests that answer that live in
    // the run artifact rather than in a declaration. Stated rather than omitted,
    // because a dropped family fails silently and in the direction of looking
    // correct, and the next reader would otherwise have to guess whether the
    // omission was a decision.
    //
    // **And no family for `releaseIntent`, deliberately, on a measurement rather
    // than a preference.** `releaseBaseSchema.releaseIntent` is a required
    // `artifactReferenceSchema`, so a seventh family is the obvious reading — and
    // it would break the gate it was added for. `legion review --accept` calls
    // `updateChangeAcceptance`, which writes `change.yaml` and then re-points
    // `taskgraph.json` and `evidence-index.json` through
    // `repointChangeProposalInputs`: every candidate referent of `releaseIntent`
    // moves bytes during the accept. A digest recorded before it would answer
    // `drift`, and `release_observation_plan` would report `unsatisfied` for a
    // governance write that changed no task and no criterion. What replaces the
    // pin is strictly stronger rather than weaker: the gate compares
    // `releaseIntent.path` against the change's own task graph path and
    // re-derives the coverage claim against the *live* taskgraph on every ship,
    // which is a check a digest could not make at all.
    //
    // `shipGateSourcePaths` does not move either: a release plan cites no report,
    // so there are no bytes for `classifyEvidenceSource` to read.
  ];
}

/** The paths whose bytes a gate reads rather than only hashes. */
export function shipGateSourcePaths(
  attestations: readonly Attestation[] | undefined
): readonly string[] {
  return (attestations ?? []).flatMap((attestation) => attestation.sources.map((source) => source.path));
}

export function normalizeChangeFacts(change: unknown): ShipGateChangeFacts | undefined {
  if (change === null || typeof change !== "object") return undefined;
  const facts = change as ShipGateChangeFacts;
  if (typeof facts.verifyPin === "function" && typeof facts.classifySource === "function") return facts;
  return {
    ...facts,
    ...(typeof facts.verifyPin === "function" ? {} : { verifyPin: UNRESOLVED_PINS }),
    ...(typeof facts.classifySource === "function" ? {} : { classifySource: UNREAD_SOURCES })
  };
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
      // `concealsNegative` is how one producer's doubt outranks another's yes
      // inside `combineDomainReviewOutcomes`; it is not a fact about the gate an
      // operator or a host reads. Dropped here, at the one place a `GateOutcome`
      // becomes a `ShipGate`, so that the payload's shape stays the declared
      // interface rather than whatever the last combination happened to set.
      const { concealsNegative: _combinationOnly, ...outcome } = evaluateGate({
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
  // Six unmet states with five cures — no record, a `fail`, a drifted or absent
  // source, a cited report that is red, a `covers` list that leaves a deriving
  // task out, and a baseline dated after the run it claims to precede — so the
  // verdict carries its own and `shipGateRecovery` prefers that. What stays here
  // is the state a caller holding only a gate id can be answered for, and the one
  // every change written before this release is in: nothing attests a baseline,
  // because nothing could.
  //
  // Deliberately **not** the post-execution cure. That one is reachable only
  // after a build, and a table entry assuming it would tell an operator who has
  // attested nothing that their only route out is to re-plan.
  independent_baseline: attestRecovery("independent_baseline", ["independent-baseline"]),
  // Six unmet states with four different cures, so the verdict carries its own
  // and `shipGateRecovery` prefers that. What stays here is the state a caller
  // holding only a gate id can be answered for, and the one every R3 change
  // written before this release is in: no oracle approval exists at all, because
  // nothing could write one. It is deliberately *not* the ordering cure — that
  // one is reachable only after a build, and a table entry that assumed it would
  // tell an operator who has approved nothing to re-plan.
  approved_spec_and_oracle: ORACLE_APPROVE_RECOVERY,
  // Seven unmet states with four cures — no domain recorded anywhere, a domain
  // that is not architecture or security, a domain review nobody accepted, one
  // whose axes reached no verdict, a superseded one, a rejected or
  // blocking-finding or failing one, and a coverage gap — so the verdict carries
  // its own and `shipGateRecovery` prefers that. What stays here is the state a
  // caller holding only a gate id can be answered for, and the one every change
  // written before this release is in: no review says which domain it examined,
  // because nothing could record it.
  //
  // Deliberately **not** the rework cure. That one is reachable only after a
  // domain review has recorded a defect, and a table entry assuming it would tell
  // an operator who has reviewed nothing to go and build.
  architecture_or_security_review: DOMAIN_REVIEW_RECOVERY,
  // Eight unmet states with four cures — an unreadable oracle plane, no
  // declaration anywhere, no item in this task's evidence, a declaration made
  // after the run, an `unknown` observation, an unreadable approvals plane, an
  // unestablished ordering, and a change with no decision behind it — so the
  // verdict carries its own and `shipGateRecovery` prefers that. What stays here
  // is the state a caller holding only a gate id can be answered for, and the one
  // every change on disk today is in: no oracle declares a protected acceptance
  // path, because until this release nothing could.
  //
  // Deliberately **not** `legion approve protected-paths`. That decision must
  // predate the run, so a table entry naming it would tell an operator who has
  // already built to run a command that exits 0, writes a later instant, and
  // converts a repairable `unevaluable` into a permanent `unsatisfied` — the
  // exact one-way door `orderingAwareRecovery` exists to keep this file out of.
  protected_acceptance_tests: ACCEPTANCE_PATHS_DECLARE_RECOVERY,
  // Five unmet states with four cures, so the verdict carries its own. The table
  // holds the absence, which is where every change written before this release
  // is. There is no ordering rule on this gate: evaluating the implemented
  // change necessarily comes after implementing it.
  security_or_e2e_evaluator: attestRecovery("security_or_e2e_evaluator", [
    "security-evaluation",
    "e2e-evaluation"
  ]),
  explicit_human_approval: undefined,
  // Six unmet states with three cures — no plan, a plan whose status records a
  // failed or taken-back release, a plan with no health criterion, one whose
  // rollback plan has no criterion, one that covers only part of the change, and
  // a `release.json` that will not read — so the verdict carries its own and
  // `shipGateRecovery` prefers that. What stays here is the state a caller
  // holding only a gate id can be answered for, and the one every change on disk
  // is in: nothing plans the release, because until this release nothing could.
  //
  // Leaving this `undefined` was measurable, not theoretical. On an R3 change
  // already built, reviewed and accepted, this was the *only* unmet gate — so
  // `shipGateRecovery` found no recovery among the unmet set, fell back to ship's
  // own `{command: "legion build"}`, and advised a build on a change that had
  // already been built. That is the exits-0-and-still-blocked loop this series
  // exists to close, emitted by the aggregator.
  release_observation_plan: RELEASE_PLAN_RECOVERY,
  rollback_or_forward_fix_evidence: attestRecovery("rollback_or_forward_fix_evidence", [
    "rollback-evidence",
    "forward-fix-evidence"
  ])
};

export interface ShipGateRecovery {
  readonly command: string;
  readonly reason: string;
}

/**
 * The command a blocked ship should advise.
 *
 * **One rule, and it replaces three arms that had a hole in the middle:** advise
 * a command that some unmet gate says repairs it, and fall back to the caller's
 * only when no unmet gate names one at all.
 *
 * The arm this replaces kept `fallback.command` — `legion build`, from
 * `ship.ts` — whenever *any* unmet gate had no recovery, and appended the
 * commands that did to the reason. Its stated justification was that naming one
 * repair when several are needed overclaims. That is true of the *reason* and it
 * was never true of the command, and adversarial review measured what the
 * difference costs at R3, where six of ten gates are producerless and the arm was
 * therefore unconditional:
 *
 *     nextAction: { command: "legion build",
 *                   reason: "… (1 failed, 6 unprovable). Of those, one has a
 *                            command that can produce the missing evidence:
 *                            legion start --intake." }
 *
 * — on a change whose only failing gate is `approved_spec_and_oracle`, whose own
 * verdict says in as many words that no command re-orders a decision already
 * taken and that a build is the act which made it unrepairable. `command` and
 * `reason` contradicted each other inside one object, and `command` is the field
 * hosts dispatch. Running it exits 0, writes another attempt, moves nothing, and
 * ship repeats the identical verdict forever: the exits-0-and-still-blocked loop
 * this series exists to close, emitted by the aggregator rather than by a gate.
 *
 * So:
 *
 *  - **Exactly one distinct repair among the unmet gates: advise it**, whether or
 *    not the other unmet gates have one. A gate with no recovery has no repair to
 *    withhold in favour of; withholding the one known repair helps nobody, and the
 *    reason still says how many gates are unmet.
 *  - **Several distinct repairs: advise the first in gate order** and list them
 *    all in the reason. Gate order is the risk policy's own tier ordering, so this
 *    is deterministic and is the order ADR-006 states the gates in, not an
 *    accident of iteration. The reason continues to say plainly that no single
 *    command unblocks the ship.
 *  - **No unmet gate names a repair: the caller's fallback, unchanged, byte for
 *    byte.** This is the only arm in which a command nothing claimed can repair is
 *    advised, and by then there is nothing else to say.
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

  const unmetIds = [...new Set(unmet.map((gate) => gate.gate))];
  const recoveries = unmetIds
    .map((id) => unmet.find((gate) => gate.gate === id)?.recovery ?? GATE_RECOVERY[id])
    .filter((entry): entry is ShipGateRecovery => entry !== undefined);
  if (recoveries.length === 0) return input.fallback;

  const distinct = [...new Set(recoveries.map((entry) => entry.command))];
  const only = recoveries[0] as ShipGateRecovery;
  if (distinct.length === 1) {
    // The unrepairable remainder is named rather than implied. `only.reason` was
    // written by a gate about its own state and cannot know that five other gates
    // are also unmet, and an operator who runs one command and stays blocked has
    // to have been told why.
    const unnamed = unmetIds.length - recoveries.length;
    return unnamed === 0
      ? only
      : {
          command: only.command,
          reason: `${only.reason} ${unnamed} other unmet gate${unnamed === 1 ? " has" : "s have"} no command that ` +
            "produces its evidence, so this repairs what can be repaired rather than unblocking the ship."
        };
  }

  return {
    command: only.command,
    reason:
      `${input.fallback.reason} Of those, ${distinct.length} have a command that can produce the missing evidence: ` +
      `${distinct.join(", ")}. No single command unblocks this ship; ${only.command} is the first of them in gate order.`
  };
}
