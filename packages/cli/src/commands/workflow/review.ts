import { readTaskGraph } from "@legion/artifacts";

import { failure, hasFlag, success, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

export async function handleReviewWorkflow(context: CliContext): Promise<CliResult> {
  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before review readiness can be checked."
  );

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    return blockedReview(latestChange.diagnostics, planAction);
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedReview(taskgraph.diagnostics, planAction);
  }

  const taskCount = taskgraph.document.tasks.length;
  if (hasFlag(context, "dry-run")) {
    const action = nextAction(
      "legion review",
      "Review gates are ready to inspect the latest task graph."
    );
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: {
          changeId: latestChange.changeId
        },
        taskgraph: {
          artifactPath: taskgraph.artifactPath,
          taskCount,
          taskIds: taskgraph.document.tasks.map((task) => task.id)
        },
        nextAction: action,
        diagnostics: []
      },
      [
        "Review ready.",
        `Dry run: review gates can inspect ${taskCount} task${taskCount === 1 ? "" : "s"} from ${latestChange.changeId}.`,
        "No review was accepted or recorded.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  const action = nextAction(
    "legion review --dry-run",
    "Only review readiness checks are wired in this CLI layer right now."
  );
  return blockedReview(
    [
      {
        code: "review_evidence_pipeline_not_implemented",
        message: "Review evidence collection is not wired yet. Run legion review --dry-run to verify readiness without claiming review acceptance.",
        path: taskgraph.artifactPath
      }
    ],
    action,
    {
      changeId: latestChange.changeId,
      taskgraphPath: taskgraph.artifactPath
    }
  );
}

function blockedReview(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>,
  extras: Record<string, unknown> = {}
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      ...extras,
      diagnostics,
      nextAction: action
    },
    [
      "Review blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}
