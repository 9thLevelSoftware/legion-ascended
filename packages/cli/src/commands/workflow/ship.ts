import { listReviewDecisionsForChange, readEvidenceIndex } from "@legion/artifacts";

import { failure, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const SHIP_HELP = "legion ship [--canary]\n\nRun the ship readiness gate. This layer does not publish or release.";

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
      diagnostics: []
    },
    human: [
      "Ship ready.",
      "Accepted review and build evidence are present.",
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
