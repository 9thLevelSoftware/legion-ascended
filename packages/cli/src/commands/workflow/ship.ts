import {
  listReviewDecisionsForChange,
  readEvidenceIndex,
  partitionTraceabilityDiagnostics,
  readTaskGraph,
  validateChangeTraceability
} from "@legion/artifacts";

import { failure, hasFlag, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { taskIdForContractId } from "../../workflow/run-artifacts.js";
import { deriveShipGates } from "../../workflow/ship-gates.js";
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

  const gateReport = deriveShipGates({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    entries: evidence.document.entries,
    reviews: reviews.reviews
  });

  if (!gateReport.ready) {
    // Both blocking statuses are named. Reporting only `unsatisfied` would make
    // a change blocked purely by unevaluable gates fail with no explanation of
    // what is missing, which is the least useful way to be correct.
    return blockedShip(
      gateReport.gates
        .filter((gate) => gate.status !== "satisfied")
        .map((gate) => ({
          code:
            gate.status === "unsatisfied" ? "risk_gate_unsatisfied" : "risk_gate_unevaluable",
          message: `${gate.label} is not satisfied for ${gate.taskId}: ${gate.reason}`,
          path: evidence.artifactPath
        })),
      nextAction(
        "legion build",
        `Required risk gates are not satisfied for this change (${gateReport.unsatisfied} failed, ${gateReport.unevaluable} unprovable).`
      )
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
      ...(traceabilityWarnings.length === 0 ? {} : { warnings: traceabilityWarnings }),
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
