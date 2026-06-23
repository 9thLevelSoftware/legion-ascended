import { failure, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

export async function handleReviewWorkflow(_context: CliContext): Promise<CliResult> {
  const action = nextAction("legion build", "No completed task run was found for review.");

  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics: [
        {
          code: "task_run_missing",
          message: "No completed task run was found. Run legion build first."
        }
      ],
      nextAction: action
    },
    [
      "Review blocked.",
      "No completed task run was found. Run legion build first.",
      renderNextAction(action)
    ].join("\n")
  );
}
