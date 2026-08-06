import {
  deriveOracleManifest,
  listApprovalsForChange,
  listReviewDecisionsForChange,
  listTaskRunsForChange,
  loadChangeBundle,
  readEvidenceIndex,
  readOracleArtifact,
  partitionTraceabilityDiagnostics,
  readTaskGraph,
  validateChangeTraceability,
  type ApprovalListResult,
  type TaskRunListResult
} from "@legion/artifacts";
import type { Approval, ArtifactReference, TaskRun } from "@legion/protocol";

import { failure, hasFlag, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { currentUtcTimestamp } from "../../workflow/change-input.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { resolvePinnedReferences } from "../../workflow/pinned-references.js";
import { taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  deriveShipGates,
  shipGateDiagnostics,
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
 * A read whose failure makes a fact absent, never a ship blocked.
 *
 * Every early return above this point is a gate the operator can act on, and
 * each one is pinned by name. The change-scoped facts are different: they feed
 * gates whose contract is that an absent fact yields `unevaluable`, so a read
 * that fails has to arrive as absence and not as a new blocking branch. The
 * oracle manifest in particular fails on any malformed oracle in the change
 * directory, and a change with one already fails earlier, for its own reason,
 * with its own recovery command — turning it into a second failure here would
 * change which defect the operator is told about.
 *
 * This does not itself distinguish "nothing there" from "something there I could
 * not read", which the traceability checker in this package does. The
 * distinction is made one level up instead: a listing that reports `skipped`
 * entries produces a `ShipGatePlaneSkip`, which reaches the payload by name. A
 * thrown read still arrives as bare absence, which is the weaker answer and the
 * one worth improving next; what it is not is the common case, which is a file
 * the listing declined to parse.
 */
async function absentOnFailure<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Every oracle of the change, or `undefined` if the set could not be
 * established.
 *
 * All-or-nothing on purpose. A partial list is worse than no list for the gates
 * this feeds: "every oracle is approved" is trivially true of a list that lost
 * the unapproved one. The manifest is derived first because it is the only
 * public route to the change's oracle ids, then each is read for its document
 * and reference — the gates that will consume these need `protectedPaths` from
 * the one and the content hash from the other.
 */
async function loadOracleFacts(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<readonly ShipGateOracleFact[] | undefined> {
  const manifest = await absentOnFailure(() =>
    deriveOracleManifest({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  if (manifest === undefined || !manifest.ok) return undefined;

  const oracles: ShipGateOracleFact[] = [];
  for (const revision of manifest.manifest.oracles) {
    const fileName = revision.artifact.path.split("/").at(-1);
    if (fileName === undefined || !fileName.endsWith(".yaml")) return undefined;
    const oracle = await absentOnFailure(() =>
      readOracleArtifact({
        repositoryRoot: input.repositoryRoot,
        changeId: input.changeId,
        oracleId: fileName.slice(0, -".yaml".length)
      })
    );
    if (oracle === undefined || !oracle.ok) return undefined;
    oracles.push({ document: oracle.document, reference: oracle.reference });
  }

  return oracles;
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
 * Exported and pure because it is otherwise untestable: nothing reads
 * `taskRuns` in this release, so a change collapsing this back to
 * `runs.taskRuns.map(...)` would leave every suite green. The one thing that can
 * falsify it is a direct test, so there is one.
 */
export function completeTaskRuns(listing: TaskRunListResult | undefined): readonly TaskRun[] | undefined {
  if (listing === undefined || !listing.ok) return undefined;
  if (listing.skipped.length > 0) return undefined;
  return listing.taskRuns.map((run) => run.document);
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
 * The change-scoped planes `legion ship` can read, and what it could not read.
 *
 * Two gates consume them: `explicit_human_approval` and `approved_delta_spec`
 * read `approvals`, and the second also reads `deltas`. Everything else here is
 * still loaded ahead of its reader, so that the change adding each gate is a
 * diff about that gate rather than about the plumbing.
 *
 * The release plane is still passed as `undefined` rather than as an empty
 * value. Its schema exists but nothing reads or writes it, so "consulted and
 * empty" would be a claim this command cannot make.
 */
async function loadShipGateChangeFacts(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<{ readonly facts: ShipGateChangeFacts; readonly skips: readonly ShipGatePlaneSkip[] }> {
  const bundleResult = await absentOnFailure(() =>
    loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const bundle = bundleResult !== undefined && bundleResult.ok ? bundleResult.bundle : undefined;

  const oracles = await loadOracleFacts(input);

  const runsResult = await absentOnFailure(() =>
    listTaskRunsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const taskRuns = completeTaskRuns(runsResult);

  const approvalsResult = await absentOnFailure(() =>
    listApprovalsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  const approvals = completeApprovals(approvalsResult);

  // The pins a gate can ask about are hashed here, once, because the evaluator
  // is synchronous. A reference nobody collects answers `unverified`, which
  // reads as "not checked" rather than as "clean" — so a gate whose collector
  // is missing reports unevaluable instead of passing on an unchecked pin.
  const pinned: ArtifactReference[] = [
    ...(bundle?.deltas.map((delta) => delta.delta) ?? []),
    ...(oracles?.map((oracle) => oracle.reference) ?? [])
  ];
  const verifyPin = await resolvePinnedReferences({
    repositoryRoot: input.repositoryRoot,
    references: pinned
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
    skips
  };
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
    return blockedShip(evidence.diagnostics, nextAction("legion build", "Shipping requires accepted build evidence."));
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
      nextAction("legion review --accept", "Shipping requires accepted review evidence.")
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
    changeId: latestChange.changeId
  });

  const gateReport = deriveShipGates({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    entries: evidence.document.entries,
    reviews: reviews.reviews,
    change: changeFacts.facts
  });
  const planeSkips = planeSkipDiagnostics(changeFacts.skips);

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
