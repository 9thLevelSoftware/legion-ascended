import {
  helpResult,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";

const STATUS_HELP = `legion status

Show the current Legion workflow state and the next recommended command.

Examples:
  legion status
  legion status --json`;

export async function handleStatusCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(STATUS_HELP);
  }

  const workflowState = await resolveWorkflowState(context);
  return success(
    {
      ok: true,
      status: "workflow_status",
      workflowState,
      nextAction: workflowState.nextAction,
      diagnostics: workflowState.diagnostics
    },
    [
      `Stage: ${workflowState.stage}`,
      `Project: ${workflowState.projectId ?? "not initialized"}`,
      `Current specs: ${workflowState.currentSpecCount}`,
      renderNextAction(workflowState.nextAction)
    ].join("\n")
  );
}
