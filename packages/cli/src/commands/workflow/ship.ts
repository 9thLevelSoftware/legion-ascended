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

const SHIP_HELP = "legion ship [--canary]\n\nRun the ship readiness gate. This layer does not publish or release.";

/**
 * The command that can actually repair what failed.
 *
 * `legion build` reruns task execution and rewrites evidence, so it fixes an
 * evidence-linkage failure and nothing else — pointing there for a malformed
 * oracle or a missing requirement proof sends the operator round a loop that
 * returns the same diagnostic.
 */
function recoveryFor(diagnostics: readonly { readonly code: string }[]) {
  const evidenceOnly = diagnostics.every((diagnostic) => diagnostic.code.includes("evidence"));
  if (evidenceOnly) {
    return nextAction(
      "legion build",
      "Evidence is not linked to the requirements and oracles it proves; rebuilding the task rewrites those links."
    );
  }
  // Specification and oracle defects live in the planned artifacts, so replanning
  // the phase is what rewrites them. `legion validate` reports the state but
  // repairs nothing.
  // `legion plan` alone is a usage error: the command parses a phase number from
  // its first positional, so a recovery action without one cannot be run as
  // printed.
  return nextAction(
    "legion plan 1",
    "Requirement, oracle and task links must resolve before a change can ship; replanning the phase rewrites the artifacts that define them."
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
