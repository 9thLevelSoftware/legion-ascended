import {
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";

export async function handleStatusCommand(context: CliContext): Promise<CliResult> {
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
