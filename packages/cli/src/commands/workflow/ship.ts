import {
  listApprovalsForChange,
  listAttestationsForChange,
  listReviewDecisionsForChange,
  listTaskRunsForChange,
  loadChangeBundle,
  readEvidenceIndex,
  partitionTraceabilityDiagnostics,
  readTaskGraph,
  validateChangeTraceability,
  type ApprovalListResult,
  type AttestationListResult,
  type EvidenceIndexEntry,
  type ReviewDecisionListResult,
  type ReviewDecisionSuccess,
  type TaskRunListResult
} from "@legion/artifacts";
import type { Approval, Attestation, TaskContract, TaskRun } from "@legion/protocol";

import { failure, hasFlag, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { currentUtcTimestamp } from "../../workflow/change-input.js";
import { absentOnFailure, loadOracleFacts, loadReleaseFact } from "../../workflow/change-planes.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { classifyEvidenceSource } from "../../workflow/evidence-sources.js";
import { resolvePinnedReferenceReader } from "../../workflow/pinned-references.js";
import { taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  APPROVE_BEFORE_BUILD_RECOVERY,
  deriveShipGates,
  derivesApprovalOrderingGate,
  shipGateDiagnostics,
  shipGatePinnedReferences,
  shipGateRecovery,
  shipGateHumanJudgements,
  shipGateSourcePaths,
  shipGateWaivers,
  type ShipGateChangeFacts,
  type ShipGateOracleFact,
  type ShipGateReleaseFact
} from "../../workflow/ship-gates.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

// `--canary` is gone from this text, and the flag is *not* being declared to
// replace it. It was advertised here and absent from `declared-options.ts`, so
// `undeclaredOptionError` refused it — help that promised a flag the option
// boundary rejects. Declaring it would be the worse repair: nothing in this
// command reads it, and a flag nobody reads returns a confident answer to a
// question that was not asked, which is the whole class `declared-options.ts`
// exists to close. Observation planning is `legion release plan`; this command
// reads that plan and writes none.
//
// `--dry-run` and `--review-accepted` are added, because help that omits a
// declared flag is the mirror of help that advertises an undeclared one. **Both
// lines say plainly that this command does not read them**, which a first draft
// did not: "Reserved for callers that have already accepted" invites the belief
// that `--review-accepted` short-circuits the accepted-review requirement, and an
// operator who passes it gets identical behaviour with no signal that the flag
// was inert. That is the same help-versus-behaviour gap the `--canary` removal
// was made to close, in the milder direction. The only flag `hasFlag` reads in
// this file is `allow-legacy-evidence`; `review-accepted` is read by
// `commands/migrate/index.ts` alone.
const SHIP_HELP = [
  "legion ship [--allow-legacy-evidence] [--dry-run] [--review-accepted]",
  "",
  "Run the ship readiness gate. This layer does not publish or release.",
  "",
  "Options:",
  "  --allow-legacy-evidence   Accept evidence written before requirement and oracle",
  "                            linking. `legion dev change archive` applies the same",
  "                            check, so pass it there too.",
  "  --dry-run                 Accepted and not read: this command writes nothing",
  "                            either way, so there is nothing to rehearse.",
  "  --review-accepted         Accepted and not read here. Whether a review was",
  "                            accepted is derived from the artifacts; no flag can",
  "                            assert it.",
  "",
  "Release observation is planned with `legion release plan`, which writes the",
  "release.json this command's release_observation_plan gate reads. This command",
  "does not run canary probes or health checks; `legion dev board",
  "release-observation` is where a post-deployment report lands."
].join("\n");

/** The shape `recoveryFor` needs: a code to classify by, and where the defect is. */
type TraceabilityFailure = {
  readonly code: string;
  readonly source?: { readonly path?: string };
};

/**
 * The command that can actually repair what failed.
 *
 * Three groups, split by what actually rewrites the artifact — not by whether
 * the word "evidence" appears in the code, which is how this got it wrong.
 *
 * `legion build` produces evidence that does not exist yet, so it repairs a
 * missing index and a task with no accepted evidence. It does not repair a
 * *stale* entry: build seeds `producedEntries` from the existing index and only
 * replaces an entry with the same evidence ID, while each attempt is issued a
 * new one. The obsolete entry survives every rebuild, `validateChangeTraceability`
 * scans the whole index, and the operator loops on the same diagnostic forever.
 *
 * `orphan_evidence` is the one stale case with a real answer: it is what
 * evidence written before requirement and oracle linking looks like, and the
 * allowance exists for exactly that. Naming it here does not wave anything
 * through — the operator still has to type it, which is the point of the flag.
 *
 * Everything else is a defect in a committed artifact, and correcting a
 * committed artifact is an edit; no command rewrites it. `legion plan <phase>`
 * and `legion dev change create` are create-only, so the change's own existence
 * makes them fail with `artifact_already_exists`, and neither can delete a
 * stray oracle. `legion dev change validate` runs but reports "Change is
 * valid." on a bundle containing one, because it checks the bundle's schema
 * rather than the traceability this gate checks. So the action names the
 * artifact to correct and rerunning ship as the confirmation, since ship is the
 * only command that re-reports the defect.
 */
const REBUILDABLE = new Set(["missing_evidence_index", "missing_accepted_evidence"]);

function recoveryFor(diagnostics: readonly TraceabilityFailure[]) {
  if (diagnostics.every((diagnostic) => REBUILDABLE.has(diagnostic.code))) {
    return nextAction(
      "legion build",
      "The task has no accepted evidence yet; building produces it with the requirement and oracle links this gate checks."
    );
  }

  if (diagnostics.every((diagnostic) => diagnostic.code === "orphan_evidence")) {
    return nextAction(
      "legion ship --allow-legacy-evidence",
      "This evidence carries no requirement or oracle link. Rebuilding cannot repair it — a rebuild adds a new entry " +
        "and leaves the old one in the index. If it predates linking, this accepts it; if it is current evidence that " +
        "lost its links, the index is corrupt and has to be corrected rather than allowed."
    );
  }

  const paths = [...new Set(diagnostics.map((diagnostic) => diagnostic.source?.path).filter(isPath))];
  const where = paths.length === 0 ? "the planned artifacts" : paths.join(", ");
  return nextAction(
    "legion ship",
    `Requirement, oracle and task links must resolve before a change can ship. No command rewrites them: ` +
      `correct ${where} by hand, then rerun this to confirm the defect is gone.`
  );
}

function isPath(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/**
 * Every task run of the change, or `undefined` when the listing dropped any.
 *
 * All-or-nothing, exactly as the oracle set is, and for a sharper reason.
 * `listTaskRunsForChange` reports `ok: true` while skipping any directory whose
 * `task-run.json` will not read, so a corrupt run yields a shorter list rather
 * than a failure. Handing that subset to the ordering gates gives them a
 * `min(startedAt)` that can only be later than the truth — the direction that
 * makes an approval recorded *after* gated execution began look as though it
 * came first, which is a fail-open in the one gate whose entire purpose is that
 * ordering. `skipped` is how the listing says it dropped something; absence here
 * is how ship refuses to answer from what it kept.
 *
 * Exported and pure because it was otherwise untestable: when this landed
 * nothing read `taskRuns` at all, so a change collapsing it back to
 * `runs.taskRuns.map(...)` would have left every suite green. The one thing that
 * could falsify it was a direct test, so there is one.
 *
 * `approved_spec_and_oracle` is now that reader, and it is the gate this
 * function was written for by name. Collapsing this today would not make a gate
 * *fail* — it would make one silently answer from a `min(startedAt)` later than
 * the truth, which is the fail-open direction. The direct test still stands, and
 * it is still the only thing that distinguishes the two.
 */
export function completeTaskRuns(listing: TaskRunListResult | undefined): readonly TaskRun[] | undefined {
  if (listing === undefined || !listing.ok) return undefined;
  if (listing.skipped.length > 0) return undefined;
  return listing.taskRuns.map((run) => run.document);
}

/**
 * Ways the run set can be shown to be short by something other than itself.
 *
 * **`completeTaskRuns` is necessary and it is not sufficient, and this exists
 * because the difference was measured rather than argued.** That function refuses
 * a listing the *listing* said it shortened. `listTaskRunsForChange` records
 * `skipped` only for directories it saw and could not read: it filters
 * `entries.filter((c) => c.isDirectory())` before the skip loop, so a run
 * directory replaced by a plain file leaves no trace, and a directory that was
 * deleted outright leaves no entry to skip in the first place. Both produce a
 * clean short listing, `min(startedAt)` moves later, and `approved_spec_and_oracle`
 * flips from `unsatisfied` to `satisfied` — a governance verdict reversed by an
 * `rm -rf`, with no diagnostic anywhere and `legion validate` still exiting 0.
 *
 * The run plane is the only plane a gate's verdict rests on that nothing
 * content-pins. `taskgraph.json` pins every oracle and delta spec through
 * `artifactInputs`, and `validateChangeTraceability` blocks ship on any of those
 * moving before a gate is derived; nothing pins `runs/`. So completeness has to be
 * corroborated from the outside, and the corroborating records were already in the
 * payload and unread.
 *
 * Three independent falsifiers, none of which can be satisfied by a shorter set:
 *
 *  - **The evidence index names a run that is not there.** Every entry carries
 *    `evidence.runId`, and evidence ids are derived per attempt, so a deleted
 *    attempt-1 directory leaves attempt-1's entry behind naming it.
 *  - **A task's attempts are not contiguous from 1.** `nextAttemptMap` counts up
 *    from the runs on disk and `runIdForTask` puts each attempt in its own
 *    directory, so `{2}` or `{1,3}` for one task is a set with a hole in it. This
 *    is the falsifier that survives the evidence index also being edited, because
 *    it is internal to the run set.
 *  - **Evidence predates the earliest run start.** `executeTask` stamps one
 *    `createdAt` on both the run's `startedAt` and its evidence bundle, so
 *    `min(evidence.createdAt) >= min(run.startedAt)` holds over a whole set, with
 *    equality on the earliest run's own evidence. A strictly earlier evidence
 *    bundle is direct proof that execution began before the run plane admits — it
 *    bounds the exact quantity the gate compares against.
 *
 * **The bound, stated rather than implied.** Deleting the *entire* `runs/`
 * directory and rebuilding is not detectable by any of these, and is not
 * detectable by anything else in the repository either: attempts reset to 1,
 * `runIdForTask` is deterministic, `evidenceIdForRun` is derived from the run id,
 * so the rebuild replaces the same evidence entry and every surviving record is
 * byte-consistent with an honest change that was planned, approved, built and
 * reviewed in that order. Closing it needs a record outside the change directory —
 * a signed run log or the git history of `runs/` — which is a different artifact
 * from this one. What this closes is every deletion that leaves any other record
 * behind, which is every deletion short of removing the plane wholesale.
 *
 * Returns sentences rather than booleans: the operator's next act is to look at a
 * named run, and "the run plane is incomplete" without the name is the
 * unactionable diagnostic `ShipGatePlaneSkip` was written to stop being.
 */
export function taskRunPlaneContradictions(input: {
  readonly taskRuns: readonly TaskRun[];
  readonly entries: readonly EvidenceIndexEntry[];
}): readonly string[] {
  const contradictions: string[] = [];
  const present = new Set(input.taskRuns.map((run) => run.id as string));

  const named = [
    ...new Set(
      input.entries
        .map((entry) => entry.evidence.runId as string | undefined)
        .filter((runId): runId is string => runId !== undefined)
    )
  ].sort();
  for (const runId of named) {
    if (present.has(runId)) continue;
    contradictions.push(
      `The evidence index records a bundle produced by run ${runId}, and no such run is in this change's run directory.`
    );
  }

  const attemptsByTask = new Map<string, Set<number>>();
  for (const run of input.taskRuns) {
    const taskId = run.taskId as string | undefined;
    const attempt = run.attempt as number | undefined;
    if (taskId === undefined || attempt === undefined) continue;
    const attempts = attemptsByTask.get(taskId) ?? new Set<number>();
    attempts.add(attempt);
    attemptsByTask.set(taskId, attempts);
  }
  for (const taskId of [...attemptsByTask.keys()].sort()) {
    const attempts = attemptsByTask.get(taskId) as Set<number>;
    const highest = Math.max(...attempts);
    const holes = [];
    for (let attempt = 1; attempt <= highest; attempt += 1) {
      if (!attempts.has(attempt)) holes.push(attempt);
    }
    if (holes.length === 0) continue;
    contradictions.push(
      `${taskId} records attempt ${highest} but not attempt${holes.length === 1 ? "" : "s"} ${holes.join(", ")}, ` +
        "so its earlier runs are not in this change's run directory."
    );
  }

  const earliestStart = input.taskRuns
    .map((run) => run.startedAt as string | undefined)
    .filter((startedAt): startedAt is string => startedAt !== undefined)
    .sort()[0];
  const earliestEvidence = input.entries
    .map((entry) => entry.evidence.createdAt as string | undefined)
    .filter((createdAt): createdAt is string => createdAt !== undefined)
    .sort()[0];
  if (earliestStart !== undefined && earliestEvidence !== undefined && earliestEvidence < earliestStart) {
    contradictions.push(
      `The evidence index holds a bundle created at ${earliestEvidence}, which is earlier than the ${earliestStart} at ` +
        "which the earliest run this change records started, so execution began before its run directory admits."
    );
  }

  return contradictions;
}

/**
 * Every approval recorded for this change, or `undefined` when the listing
 * dropped any of them.
 *
 * The same all-or-nothing rule as `completeTaskRuns`, for the sharpest reason
 * of the three planes it applies to. An approval file carries the current state
 * of one decision, so once a grant has been revoked the revocation *is* that
 * file. Dropping it does not shorten a list of positives — it deletes a
 * negative, and `explicit_human_approval` would read the remaining records and
 * report satisfied on a decision that had been withdrawn.
 *
 * `[]` is deliberately not absence. A change with no approvals at all is one
 * accepted by a Legion that had no approval plane, which the gate reports as
 * `unevaluable` for its own reason and in its own words. A read that failed is
 * a different thing and must not be spelled the same way.
 *
 * Returning absence is only half of it. The caller also carries the skipped
 * filenames into the payload — see `ShipGatePlaneSkip` — because "the approvals
 * for this change could not be read" is unactionable without the name of the
 * file that could not be read, and the operator has no other way to learn it.
 */
export function completeApprovals(listing: ApprovalListResult | undefined): readonly Approval[] | undefined {
  if (listing === undefined || !listing.ok) return undefined;
  if (listing.skipped.length > 0) return undefined;
  return listing.approvals.map((approval) => approval.document);
}

/**
 * Every attestation recorded for this change, or `undefined` when the listing
 * dropped any of them.
 *
 * `completeApprovals`' rule, and the reason is sharper by one degree. An
 * approval file can be re-decided in place, so a dropped one drops whatever
 * decision stood. An attestation file is *only ever* the current verdict for its
 * kind — `legion attest` derives the id from the change and the kind, so
 * retaking an assertion overwrites rather than accumulates — which means a
 * dropped file is exactly as likely to be a `fail` or a `not_applicable` as a
 * `pass`. Three gates read this plane, and each of them is satisfiable, so
 * answering from what the listing kept is a fail-open in all three.
 *
 * Exported and pure so a direct test can falsify it: collapsing this to
 * `listing.attestations.map(...)` would leave every end-to-end assertion green,
 * because a healthy change has nothing to skip.
 */
export function completeAttestations(
  listing: AttestationListResult | undefined
): readonly Attestation[] | undefined {
  if (listing === undefined || !listing.ok) return undefined;
  if (listing.skipped.length > 0) return undefined;
  return listing.attestations.map((attestation) => attestation.document);
}

/**
 * Every review recorded for this change, or `undefined` when the listing dropped
 * any of them.
 *
 * `completeApprovals`' rule, applied to the last plane a ship gate reads that did
 * not have it. A review file holds a *verdict* — accepted, rejected, a blocking
 * finding — and `architecture_or_security_review` reads both polarities off this
 * plane, so a dropped file is as likely to be the negative as the positive. A
 * gate answering from what the listing kept would certify a domain review while
 * the rejection that supersedes it sat unparsed beside it.
 *
 * The top-level `reviews` argument to `deriveShipGates` deliberately stays the
 * raw listing: the three gates reading it ask whether an accepted review exists,
 * which a dropped file can only make *more* conservative, and routing them
 * through this would move R1 and R2 verdicts from a diff whose subject is an R3
 * gate.
 *
 * Exported and pure so a direct test can falsify it: collapsing this to
 * `listing.reviews` leaves every end-to-end assertion green, because a healthy
 * change has nothing to skip.
 */
export function completeReviews(
  listing: ReviewDecisionListResult | undefined
): readonly ReviewDecisionSuccess[] | undefined {
  if (listing === undefined || !listing.ok) return undefined;
  if (listing.skipped.length > 0) return undefined;
  return listing.reviews;
}

/**
 * A directory entry that made a whole plane absent, and where it is.
 *
 * `completeApprovals` and `completeTaskRuns` refuse to answer from a partial
 * listing, which is right — a dropped approval file is as likely to hold a
 * revocation as a grant. What was wrong was doing it silently. Any file under
 * `approvals/` that is not a parseable `.json` — a `.DS_Store`, a `Thumbs.db`,
 * an editor swap file, a `.gitkeep` — collapsed the plane, pinned
 * `approved_delta_spec` to `unevaluable` for good, and told the operator to run
 * `legion approve spec`, which then reported the change fully approved and wrote
 * nothing. Both commands were individually honest and the pair was a loop with
 * no exit and no clue in it, because the one fact that explains the state — the
 * filename — was read and discarded.
 *
 * So the skip is carried to the payload. It is a diagnostic on a blocked ship
 * and a warning on a ready one: on a ready ship the collapsed plane fed no gate
 * that ran, but a repository accumulating junk in an artifact directory is still
 * something the operator has to know before it blocks something.
 */
interface ShipGatePlaneSkip {
  readonly plane: string;
  readonly directory: string;
  readonly entries: readonly string[];
}

function planeSkipDiagnostics(skips: readonly ShipGatePlaneSkip[]) {
  return skips.map((skip) => ({
    code: "artifact_plane_incomplete",
    message:
      `${skip.entries.length} file${skip.entries.length === 1 ? "" : "s"} under ${skip.directory} could not be read as ` +
      `${skip.plane} and ${skip.entries.length === 1 ? "was" : "were"} skipped: ${skip.entries.join(", ")}. ` +
      `Every gate that reads the ${skip.plane} plane reports unevaluable while this is true, because a listing that ` +
      "dropped a file may have dropped a withdrawal. Remove or correct the named file, then rerun this.",
    path: skip.directory
  }));
}

/**
 * The diagnostic for a singular artifact that is present and will not read.
 *
 * A distinct code from `artifact_plane_incomplete`, on that code's own rule
 * rather than by reusing its machinery. That sentence is "N files under this
 * directory could not be read and were skipped", which is false about a plane
 * holding exactly one document: there is no listing, no `skipped` array, and no
 * other file to name. The fact and the repair are also different — the operator
 * has to correct or remove one named file, and `legion release plan` deliberately
 * refuses to overwrite it.
 *
 * Emitted as a diagnostic on a blocked ship and a warning on a ready one, which
 * is `ShipGatePlaneSkip`'s rule: an R2 change does not derive
 * `release_observation_plan`, so a broken `release.json` blocks nothing there and
 * the operator still has to learn the file is unreadable before it blocks
 * something.
 */
function unreadableDocumentDiagnostics(release: ShipGateReleaseFact) {
  if (release.kind !== "unreadable") return [];
  return [
    {
      code: "artifact_document_unreadable",
      message:
        `${release.path} is present and could not be read as a release plan. release_observation_plan reports ` +
        "unevaluable while this is true, because a plan that will not parse may be the one recording a failed " +
        "release. legion release plan refuses to write over an unread record, so correct or remove the file, then " +
        "rerun this.",
      path: release.path
    }
  ];
}

/**
 * The diagnostic for a run plane the listing kept whole and the records deny.
 *
 * A separate code from `artifact_plane_incomplete`, because it is a different
 * fact and a different repair. That one says "a file under this directory would
 * not parse"; this one says "this directory is missing a run that another
 * artifact of this change still names", and there is no file to correct — the
 * repair is restoring the run record or accepting that the change's ordering can
 * no longer be established.
 *
 * Emitted even on a ship that is otherwise ready, as a warning, on the same rule
 * `ShipGatePlaneSkip` states: the run plane feeds one gate that only R3 derives,
 * so an R2 change with a shortened run plane ships green today and the operator
 * still has to know its execution record has a hole in it.
 */
function runPlaneContradictionDiagnostics(input: {
  readonly contradictions: readonly string[];
  readonly directory: string;
}) {
  if (input.contradictions.length === 0) return [];
  return [
    {
      code: "task_run_plane_contradicted",
      message:
        `${input.directory} does not hold every run this change's own records name: ${input.contradictions.join(" ")} ` +
        "A run set that is short reports a later first execution than the truth, which is the direction that makes an " +
        "approval taken after the work look as though it came first, so approved_spec_and_oracle reports unevaluable " +
        "rather than answering from what is left. Restore the missing run records, then rerun this.",
      path: input.directory
    }
  ];
}

/**
 * The change-scoped planes `legion ship` can read, and what it could not read.
 *
 * Eleven gates consume them: `explicit_human_approval` and `approved_delta_spec`
 * read `approvals`, the second also reads `deltas`,
 * `integration_or_real_interface_checks` reads `oracles` and the pin verifier,
 * `whole_change_acceptance_evidence` reads `acceptance` and the clock,
 * `approved_spec_and_oracle` reads all of those plus `taskRuns`,
 * `independent_baseline`, `security_or_e2e_evaluator` and
 * `rollback_or_forward_fix_evidence` read `attestations`, the pin verifier and
 * the source classifier — the first also `taskRuns` — and
 * `architecture_or_security_review` reads `reviews` beside `attestations`, plus
 * `taskRuns` for its executor falsifier, and `protected_acceptance_tests` reads
 * `oracles` for the declaration set it quantifies over, then `approvals` and
 * `taskRuns` for the decision that may permit a change and the instant it has to
 * predate, and `release_observation_plan` reads `release` beside `attestations`.
 *
 * **The release plane gains its reader here, and with it the last plane this
 * function loaded blind.** Every previous version of this paragraph had to say
 * that `release` was passed as `undefined` because "consulted and empty" was a
 * claim this command could not make. It can now: `loadReleaseFact` always
 * consults the plane and returns which of the three states it found, so
 * `undefined` in `ShipGateChangeFacts.release` means "nobody looked" and nothing
 * else — which is what makes an unreadable `release.json` distinguishable from
 * an absent one, in the payload and in the gate's recovery.
 *
 * The run artifact recording which acceptance path moved is still deliberately
 * *not* a plane this command loads — the gate reads the evidence item's verdict
 * and its trace references, and citing the artifact rather than parsing it is the
 * same choice `diff-reconciliation` made for the same reason.
 *
 * `tasks` is a parameter rather than a read. The taskgraph has already been
 * loaded by the caller and a verification surface's pins live on it, so
 * re-reading here would give the report two epochs — the property every comment
 * in this function defends by hashing and clocking exactly once.
 */
async function loadShipGateChangeFacts(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  /**
   * The evidence index the caller already read, for `taskRunPlaneContradictions`.
   *
   * Passed rather than re-read for the reason every other input to this function
   * is: a report is a snapshot of one moment, and an index read twice could
   * corroborate the run plane against a state that never coexisted with it.
   */
  readonly entries: readonly EvidenceIndexEntry[];
  /**
   * The reviews listing the caller already read, for `completeReviews`.
   *
   * Passed rather than re-read, on the same one-epoch rule as `entries`: the
   * command has already read this plane to find the accepted review it refuses
   * without, and a second read could give the report two states of one directory.
   */
  readonly reviews: ReviewDecisionListResult;
}): Promise<{
  readonly facts: ShipGateChangeFacts;
  readonly skips: readonly ShipGatePlaneSkip[];
  readonly runPlaneContradictions: readonly string[];
}> {
  const bundleResult = await absentOnFailure(() =>
    loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const bundle = bundleResult !== undefined && bundleResult.ok ? bundleResult.bundle : undefined;

  const oracles = await loadOracleFacts(input);

  const runsResult = await absentOnFailure(() =>
    listTaskRunsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const listedRuns = completeTaskRuns(runsResult);
  // Two questions, asked in order, and the second is the one the listing cannot
  // answer about itself: did it report dropping anything, and do this change's
  // other records agree that what it kept is all there was?
  const runPlaneContradictions =
    listedRuns === undefined
      ? []
      : taskRunPlaneContradictions({ taskRuns: listedRuns, entries: input.entries });
  const taskRuns = runPlaneContradictions.length === 0 ? listedRuns : undefined;

  const approvalsResult = await absentOnFailure(() =>
    listApprovalsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const approvals = completeApprovals(approvalsResult);

  const attestationsResult = await absentOnFailure(() =>
    listAttestationsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const attestations = completeAttestations(attestationsResult);

  const reviews = completeReviews(input.reviews);

  // Always consulted, never conditionally. There is exactly one release document
  // per change, so there is no listing to come back short and no `skipped` array
  // — the "a file is there and would not read" case is a state of this fact
  // rather than a plane skip, and it gets its own diagnostic below because a
  // plane-skip sentence ("N files under <directory> could not be read") would be
  // false about a single document.
  const release = await loadReleaseFact({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });

  // The pins a gate can ask about are hashed here, once, because the evaluator
  // is synchronous. A reference nobody collects answers `unverified`, which
  // reads as "not checked" rather than as "clean" — so a gate whose collector
  // is missing reports unevaluable instead of passing on an unchecked pin.
  //
  // Which families those are is `shipGatePinnedReferences`' to say, and it lives
  // beside the gates that ask rather than here. The reason it moved is recorded
  // there: the comment that used to sit on this line claimed an end-to-end drift
  // test could falsify a dropped family, and mutation testing showed it could
  // not — either verification-surface collector alone resolved every path the
  // other would have, so deleting one reddened nothing anywhere in the tree.
  //
  // The attestation gates need one thing more than a hash: they ask what the
  // cited report *says*, and the answer has to come off the same bytes the
  // digest was taken from. `retainContentFor` is how that happens in one read
  // rather than two — a second pass could hash one state of a file and classify
  // another, and the whole point of doing the I/O here is that the report is a
  // snapshot of one moment.
  const pinned = await resolvePinnedReferenceReader({
    repositoryRoot: input.repositoryRoot,
    references: shipGatePinnedReferences({
      deltas: bundle?.deltas,
      oracles,
      approvals,
      attestations,
      tasks: input.tasks
    }),
    retainContentFor: shipGateSourcePaths(attestations)
  });

  const changeRoot = `.legion/project/changes/${input.changeId}`;
  const skips: ShipGatePlaneSkip[] = [];
  if (runsResult !== undefined && runsResult.ok && runsResult.skipped.length > 0) {
    skips.push({ plane: "task run", directory: `${changeRoot}/runs`, entries: runsResult.skipped });
  }
  if (approvalsResult !== undefined && approvalsResult.ok && approvalsResult.skipped.length > 0) {
    skips.push({ plane: "approval", directory: `${changeRoot}/approvals`, entries: approvalsResult.skipped });
  }
  if (attestationsResult !== undefined && attestationsResult.ok && attestationsResult.skipped.length > 0) {
    skips.push({
      plane: "attestation",
      directory: `${changeRoot}/attestations`,
      entries: attestationsResult.skipped
    });
  }
  if (input.reviews.ok && input.reviews.skipped.length > 0) {
    skips.push({ plane: "review", directory: `${changeRoot}/reviews`, entries: input.reviews.skipped });
  }

  return {
    facts: {
      changeId: input.changeId,
      acceptance: bundle?.change.acceptance,
      approvals,
      attestations,
      reviews,
      deltas: bundle?.deltas,
      oracles,
      taskRuns,
      release,
      // Read once, here, for the same reason the pins are hashed once here: a
      // report is a snapshot of a moment. Gates that ask "is this still valid"
      // must all ask about the same instant, or a change could be reported
      // approved and expired in one payload.
      evaluatedAt: currentUtcTimestamp(),
      verifyPin: pinned.verifyPin,
      classifySource: (reference) =>
        classifyEvidenceSource(pinned.contentOf(reference), { repositoryRoot: input.repositoryRoot })
    },
    skips,
    runPlaneContradictions
  };
}

/**
 * "Build first" — unless building first is the thing that cannot be undone.
 *
 * Ship's two pre-build refusals return before a gate is ever evaluated, so this
 * command cannot report `approved_spec_and_oracle` until *after* the point of no
 * return. Review found that measurable: `legion ship` on a planned, unbuilt R3
 * change answered `{command: "legion build", reason: "Shipping requires accepted
 * build evidence."}`, the operator built, and the first mention of approval
 * arrived when it was already too late to matter.
 *
 * The task graph is read here rather than earlier so that nothing about which
 * defect a broken change reports first moves: this runs only on a path that has
 * already decided to block, and only to choose the sentence. A task graph that
 * will not read falls back to the caller's advice, because a change whose
 * contracts cannot be parsed has no tier to route on.
 */
async function preBuildAction(
  context: CliContext,
  changeId: string,
  fallback: { readonly command: string; readonly reason: string }
) {
  const taskgraph = await readTaskGraph({ repositoryRoot: context.repositoryRoot, changeId });
  if (!taskgraph.ok || !derivesApprovalOrderingGate(taskgraph.document.tasks)) {
    return nextAction(fallback.command, fallback.reason);
  }
  return nextAction(
    APPROVE_BEFORE_BUILD_RECOVERY.command,
    `${fallback.reason} ${APPROVE_BEFORE_BUILD_RECOVERY.reason}`
  );
}

export async function handleShipWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(SHIP_HELP);
  }

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    const action = nextAction("legion plan 1", "Shipping requires a planned change.");
    return blockedShip(latestChange.diagnostics, action);
  }

  const evidence = await readEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!evidence.ok) {
    return blockedShip(
      evidence.diagnostics,
      await preBuildAction(context, latestChange.changeId, {
        command: "legion build",
        reason: "Shipping requires accepted build evidence."
      })
    );
  }

  const reviews = await listReviewDecisionsForChange({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!reviews.ok) {
    return blockedShip(reviews.diagnostics, nextAction("legion review", "Shipping requires an accepted review."));
  }

  const acceptedReview = reviews.reviews.find((review) => review.document.status === "accepted");
  const acceptedEvidence = evidence.document.entries.length > 0 &&
    evidence.document.entries.every((entry) => entry.acceptance.status === "accepted");
  if (acceptedReview === undefined || !acceptedEvidence) {
    return blockedShip(
      [
        {
          code: "review_evidence_missing",
          message: "No accepted review and accepted evidence pair was found. Run legion review --accept first."
        }
      ],
      // Nothing has run yet on an evidence index with no entries, so this is the
      // other pre-build refusal and it takes the same fork.
      evidence.document.entries.length === 0
        ? await preBuildAction(context, latestChange.changeId, {
            command: "legion review --accept",
            reason: "Shipping requires accepted review evidence."
          })
        : nextAction("legion review --accept", "Shipping requires accepted review evidence.")
    );
  }

  // Readiness is derived from the ADR-006 gate set for each task's risk tier,
  // not from the existence of an accepted review row.
  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedShip(taskgraph.diagnostics, nextAction("legion plan 1", "Ship readiness requires a readable task graph."));
  }

  // The artifacts traceability service is the authority on whether a change's
  // requirements, oracles, tasks and evidence actually link up, and it had no
  // production caller.
  //
  // Ship is where it belongs. It requires accepted evidence with review
  // provenance, so it cannot run in `legion validate` — that is the default task
  // verification command, and demanding accepted evidence there deadlocks the
  // loop: build runs validate, validate wants accepted evidence, evidence is
  // accepted at review, review needs a passing build. By the time ship runs, an
  // accepted review already exists, and this is the last gate before archive
  // applies the same rules.
  let traceabilityWarnings: readonly { readonly code: string; readonly message: string }[] = [];
  const traceability = await validateChangeTraceability({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!traceability.ok) {
    // `orphan_evidence` is reported but not blocking.
    //
    // Evidence written before this release carried only a change reference,
    // because nothing wrote requirement or oracle links. A repository upgrading
    // with an already-accepted, ship-ready change would otherwise be told to run
    // `legion validate` — which cannot add those links — and would need a full
    // rebuild and a second review to ship work that was already approved.
    //
    // Every other traceability rule still blocks. New evidence carries the links
    // from the moment it is written, so this tolerance retires itself as changes
    // are rebuilt rather than needing a migration nobody would run.
    const { blocking, allowed } = partitionTraceabilityDiagnostics(traceability.diagnostics, {
      allowLegacyEvidence: hasFlag(context, "allow-legacy-evidence")
    });
    const legacyEvidence = allowed;

    if (blocking.length > 0) {
      return blockedShip(
        blocking.map((diagnostic) => ({
          code: "change_traceability_broken",
          message: diagnostic.message,
          path: diagnostic.source?.path ?? taskgraph.artifactPath
        })),
        recoveryFor(blocking)
      );
    }

    traceabilityWarnings = legacyEvidence.map((diagnostic) => ({
      code: "legacy_evidence_unlinked",
      message: `${diagnostic.message} This evidence predates requirement and oracle linking; rebuilding the task will add it.`
    }));
  }

  // Loaded here, after every blocking check has had its chance, and never
  // before: the facts are for the gate evaluator, and a read placed earlier
  // could only change which defect an already-broken change reports first.
  const changeFacts = await loadShipGateChangeFacts({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId,
    tasks: taskgraph.document.tasks,
    entries: evidence.document.entries,
    reviews
  });

  // The waivers, hoisted before the readiness fork because both arms owe the
  // operator the same sentence.
  //
  // **Five surfaces, and fewer would reproduce a defect this file already
  // records.** A waived gate is `satisfied`, so `shipGateDiagnostics` skips it
  // and the payload would otherwise be silent about the one arm in these three
  // gates with no falsifiable evidence behind it. `payload.warnings` alone is not
  // enough either: `human` renders only `traceabilityWarnings`, so a warning that
  // lived solely in the payload would be invisible to exactly the operator who
  // relied on it - which is the defect the comment beside that render already
  // names. So a waiver reaches the operator through the gate's own `reason`, a
  // machine-readable `waived` field on the result, a `risk_gate_waived` warning
  // code distinct from every other, the `human` render on both the ready and the
  // blocked path, and `riskGates.waivedGates` on the ready payload. The
  // human-judgement arm this release adds — an `architecture-review` attestation
  // whose kind has no report shape and never will — rides all five, under its own
  // code, for exactly the same argument.
  const gateReport = deriveShipGates({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    entries: evidence.document.entries,
    reviews: reviews.reviews,
    change: changeFacts.facts
  });
  const waiverWarnings = [
    ...shipGateWaivers(gateReport.gates).map((waiver) => ({
      code: "risk_gate_waived",
      message:
        `${waiver.gate} was satisfied by an audited waiver rather than by evidence: ${waiver.attestedBy} recorded it ` +
        `as not applicable at ${waiver.attestedAt} (attests: ${waiver.attests}), because "${waiver.reason}". ` +
        "Nothing was checked for this gate. ADR-006 permits this and requires it to be visible."
    })),
    // The other evidence-free `satisfied` arm, on all five of the waiver's
    // surfaces and for the identical reason: a satisfied gate emits no diagnostic
    // at all, so a gate passed on a person's sentence would otherwise be the
    // quietest thing in the payload. A distinct code, because "somebody says this
    // does not apply" and "somebody competent says it applied and passed" are
    // different claims and one message answering both is one nobody can read.
    ...shipGateHumanJudgements(gateReport.gates).map((judgement) => ({
      code: "risk_gate_human_judgement",
      message:
        `${judgement.gate} was satisfied by a recorded human judgement rather than by a machine-checkable report: ` +
        `${judgement.attestedBy} attested ${judgement.attests} as passed at ${judgement.attestedAt}, citing ` +
        `${judgement.sources.join(", ")}, because "${judgement.statement}". No report shape in this repository ` +
        "states a verdict for this question, so what legion ship checked is that those bytes have not moved and that " +
        "none of them is a report that is red by its own rule. ADR-006 permits this and requires it to be visible."
    }))
  ];
  const planeSkips = [
    ...planeSkipDiagnostics(changeFacts.skips),
    ...unreadableDocumentDiagnostics(changeFacts.facts.release ?? { kind: "absent" }),
    ...runPlaneContradictionDiagnostics({
      contradictions: changeFacts.runPlaneContradictions,
      directory: `.legion/project/changes/${latestChange.changeId}/runs`
    })
  ];

  if (!gateReport.ready) {
    // Both blocking statuses are named. Reporting only `unsatisfied` would make
    // a change blocked purely by unevaluable gates fail with no explanation of
    // what is missing, which is the least useful way to be correct.
    //
    // The counts in the ready payload below still come from the report, never
    // from these diagnostics: the report stays one row per (task, gate) so the
    // tier arithmetic holds, while the diagnostics are what the operator reads.
    // The recovery is derived from the gates rather than fixed at `legion build`.
    // Now that one gate reads the approval plane, a build can never produce its
    // evidence, and advising one would send the operator round a loop with no
    // end — the failure family this whole series exists to close.
    const recovery = shipGateRecovery({
      gates: gateReport.gates,
      fallback: {
        command: "legion build",
        reason: `Required risk gates are not satisfied for this change (${gateReport.unsatisfied} failed, ${gateReport.unevaluable} unprovable).`
      }
    });
    // The skips come first. They are the *cause* of some of the gate rows below
    // — an unreadable approvals plane is why `approved_delta_spec` is
    // unevaluable — and a reader who acts on the gate diagnostic without seeing
    // them runs the recovery command, is told the change is fully approved, and
    // is back where they started.
    return blockedShip(
      [...planeSkips, ...shipGateDiagnostics({ gates: gateReport.gates, path: evidence.artifactPath })],
      nextAction(recovery.command, recovery.reason),
      waiverWarnings
    );
  }

  const unevaluable = gateReport.gates.filter((gate) => gate.status === "unevaluable");
  return {
    exitCode: 0,
    payload: {
      ok: true,
      status: "ready",
      change: {
        changeId: latestChange.changeId
      },
      review: {
        reviewId: acceptedReview.document.id,
        artifactPath: acceptedReview.artifactPath
      },
      evidenceIndex: {
        artifactPath: evidence.artifactPath,
        acceptedEntries: evidence.document.entries.length
      },
      ...(traceabilityWarnings.length === 0 && planeSkips.length === 0 && waiverWarnings.length === 0
        ? {}
        : {
            warnings: [
              ...traceabilityWarnings,
              ...planeSkips.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
              ...waiverWarnings
            ]
          }),
      riskGates: {
        satisfied: gateReport.satisfied,
        unsatisfied: gateReport.unsatisfied,
        unevaluable: gateReport.unevaluable,
        unevaluableGates: [...new Set(unevaluable.map((gate) => gate.gate))],
        // Beside `unevaluableGates` rather than folded into it: a waived gate was
        // answered, and answered `satisfied`. What makes it different from every
        // other satisfied gate is that nothing was checked, and a ready payload
        // that did not say which gates those were would be a ready payload
        // claiming more than it established.
        waivedGates: shipGateWaivers(gateReport.gates).map((waiver) => waiver.gate),
        // Beside `waivedGates` rather than folded into it, on that field's own
        // rule: both were answered `satisfied` with nothing machine-checkable
        // behind them, and they are two different claims. A ready payload that
        // collapsed them would say a gate had been waived when a named human had
        // in fact said it applied and passed.
        humanJudgementGates: shipGateHumanJudgements(gateReport.gates).map((judgement) => judgement.gate)
      },
      diagnostics: []
    },
    human: [
      "Ship ready.",
      // Shown, not only recorded. `writeResult` prints `human` for a terminal
      // run, so a warning that lived solely in the payload was invisible to
      // exactly the operator who opted into the allowance.
      ...traceabilityWarnings.map((warning) => `warning: ${warning.message}`),
      ...waiverWarnings.map((warning) => `warning: ${warning.message}`),
      `Risk gates: ${gateReport.satisfied} satisfied, ${gateReport.unevaluable} unevaluable.`,
      ...(unevaluable.length === 0
        ? []
        : [
            `Legion cannot yet produce evidence for: ${[...new Set(unevaluable.map((gate) => gate.gate))].join(", ")}.`,
            "These gates are required by the change's risk tier but are not proven."
          ]),
      "No publish or release action was performed."
    ].join("\n")
  };
}

function blockedShip(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>,
  warnings: readonly { readonly code: string; readonly message: string }[] = []
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      ...(warnings.length === 0 ? {} : { warnings }),
      diagnostics,
      nextAction: action
    },
    [
      "Ship blocked.",
      // Rendered on the blocked path too. A change can be blocked by one gate
      // while another was waived, and an operator reading only the blockers would
      // never learn that a gate they believe was checked was not.
      ...warnings.map((warning) => `warning: ${warning.message}`),
      diagnostics.map((diagnostic) => diagnostic && typeof diagnostic === "object" && "message" in diagnostic
        ? String((diagnostic as { readonly message: unknown }).message)
        : String(diagnostic)).join("\n"),
      renderNextAction(action)
    ].join("\n")
  );
}
