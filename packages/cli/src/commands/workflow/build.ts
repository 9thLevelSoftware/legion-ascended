import { failure, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

export async function handleBuildWorkflow(_context: CliContext): Promise<CliResult> {
  const action = nextAction(
    "legion plan 1",
    "No executable task graph was found for the current workflow state."
  );

  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics: [
        {
          code: "taskgraph_missing",
          message: "No executable task graph was found. Run legion plan 1 first."
        }
      ],
      nextAction: action
    },
    [
      "Build blocked.",
      "No executable task graph was found. Run legion plan 1 first.",
      renderNextAction(action)
    ].join("\n")
  );
}
