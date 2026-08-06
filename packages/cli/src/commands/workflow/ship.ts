import {
  listApprovalsForChange,
  listReviewDecisionsForChange,
  listTaskRunsForChange,
  loadChangeBundle,
  readEvidenceIndex,
  partitionTraceabilityDiagnostics,
  readTaskGraph,
  validateChangeTraceability,
  type ApprovalListResult,
  type EvidenceIndexEntry,
  type TaskRunListResult
} from "@legion/artifacts";
import type { Approval, TaskContract, TaskRun } from "@legion/protocol";

import { failure, hasFlag, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { currentUtcTimestamp } from "../../workflow/change-input.js";
import { absentOnFailure, loadOracleFacts } from "../../workflow/change-planes.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { resolvePinnedReferences } from "../../workflow/pinned-references.js";
import { taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  APPROVE_BEFORE_BUILD_RECOVERY,
  deriveShipGates,
  derivesApprovalOrderingGate,
  shipGateDiagnostics,
  shipGatePinnedReferences,
  shipGateRecovery,
  type ShipGateChangeFacts,
  type ShipGateOracleFact
} from "../../workflow/ship-gates.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const SHIP_HELP = [
  "legion ship [--canary] [--allow-legacy-evidence]",
  "",
  "Run the ship readiness gate. This layer does not publish or release.",
  "",
  "Options:",
  "  --canary                  Report canary readiness alongside the gate.",
  "  --allow-legacy-evidence   Accept evidence written before requirement and oracle",
  "                            linking. `legion dev change archive` applies the same",
  "                            check, so pass it there too."
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
 * Five gates consume them: `explicit_human_approval` and `approved_delta_spec`
 * read `approvals`, the second also reads `deltas`,
 * `integration_or_real_interface_checks` reads `oracles` and the pin verifier,
 * `whole_change_acceptance_evidence` reads `acceptance` and the clock, and
 * `approved_spec_and_oracle` reads all of those plus `taskRuns`. Every plane
 * this function loads now has a reader, which it did not when the seam landed —
 * the point of loading them ahead of their gates was that the change adding each
 * gate would be a diff about that gate rather than about the plumbing, and this
 * release is the last one that collects on it.
 *
 * The release plane is still passed as `undefined` rather than as an empty
 * value. Its schema exists but nothing reads or writes it, so "consulted and
 * empty" would be a claim this command cannot make.
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
  const verifyPin = await resolvePinnedReferences({
    repositoryRoot: input.repositoryRoot,
    references: shipGatePinnedReferences({
      deltas: bundle?.deltas,
      oracles,
      approvals,
      tasks: input.tasks
    })
  });

  const changeRoot = `.legion/project/changes/${input.changeId}`;
  const skips: ShipGatePlaneSkip[] = [];
  if (runsResult !== undefined && runsResult.ok && runsResult.skipped.length > 0) {
    skips.push({ plane: "task run", directory: `${changeRoot}/runs`, entries: runsResult.skipped });
  }
  if (approvalsResult !== undefined && approvalsResult.ok && approvalsResult.skipped.length > 0) {
    skips.push({ plane: "approval", directory: `${changeRoot}/approvals`, entries: approvalsResult.skipped });
  }

  return {
    facts: {
      changeId: input.changeId,
      acceptance: bundle?.change.acceptance,
      approvals,
      deltas: bundle?.deltas,
      oracles,
      taskRuns,
      release: undefined,
      // Read once, here, for the same reason the pins are hashed once here: a
      // report is a snapshot of a moment. Gates that ask "is this still valid"
      // must all ask about the same instant, or a change could be reported
      // approved and expired in one payload.
      evaluatedAt: currentUtcTimestamp(),
      verifyPin
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
    entries: evidence.document.entries
  });

  const gateReport = deriveShipGates({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    entries: evidence.document.entries,
    reviews: reviews.reviews,
    change: changeFacts.facts
  });
  const planeSkips = [
    ...planeSkipDiagnostics(changeFacts.skips),
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
      nextAction(recovery.command, recovery.reason)
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
      ...(traceabilityWarnings.length === 0 && planeSkips.length === 0
        ? {}
        : {
            warnings: [
              ...traceabilityWarnings,
              ...planeSkips.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message }))
            ]
          }),
      riskGates: {
        satisfied: gateReport.satisfied,
        unsatisfied: gateReport.unsatisfied,
        unevaluable: gateReport.unevaluable,
        unevaluableGates: [...new Set(unevaluable.map((gate) => gate.gate))]
      },
      diagnostics: []
    },
    human: [
      "Ship ready.",
      // Shown, not only recorded. `writeResult` prints `human` for a terminal
      // run, so a warning that lived solely in the payload was invisible to
      // exactly the operator who opted into the allowance.
      ...traceabilityWarnings.map((warning) => `warning: ${warning.message}`),
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

function blockedShip(diagnostics: readonly unknown[], action: ReturnType<typeof nextAction>): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics,
      nextAction: action
    },
    [
      "Ship blocked.",
      diagnostics.map((diagnostic) => diagnostic && typeof diagnostic === "object" && "message" in diagnostic
        ? String((diagnostic as { readonly message: unknown }).message)
        : String(diagnostic)).join("\n"),
      renderNextAction(action)
    ].join("\n")
  );
}
