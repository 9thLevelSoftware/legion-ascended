import {
  helpResult,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { currentCodebaseFingerprint, getLatestCodebaseMap } from "../../workflow/codebase-map.js";
import { latestGuidanceRuns } from "../../workflow/guidance-run.js";
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
  const [guidanceRuns, mapStatus] = await Promise.all([
    latestGuidanceRuns({ repositoryRoot: context.repositoryRoot, limitPerWorkflow: 1 }),
    resolveMapStatus(context)
  ]);
  return success(
    {
      ok: true,
      status: "workflow_status",
      workflowState,
      guidance: {
        latestRuns: guidanceRuns.map((run) => ({
          workflow: run.workflow,
          runId: run.runId,
          status: run.status,
          nextAction: run.nextAction
        }))
      },
      map: mapStatus,
      nextAction: workflowState.nextAction,
      diagnostics: workflowState.diagnostics
    },
    [
      `Stage: ${workflowState.stage}`,
      `Project: ${workflowState.projectId ?? "not initialized"}`,
      `Current specs: ${workflowState.currentSpecCount}`,
      `Map: ${mapStatus.status}`,
      `Guidance runs: ${guidanceRuns.length}`,
      renderNextAction(workflowState.nextAction)
    ].join("\n")
  );
}

async function resolveMapStatus(context: CliContext): Promise<{
  readonly status: "missing" | "fresh" | "stale" | "unknown";
  readonly sourceFileCount?: number;
  readonly scope?: string;
  readonly sourceFingerprint?: string;
}> {
  const latest = await getLatestCodebaseMap(context.repositoryRoot);
  if (latest === undefined) return { status: "missing" };
  try {
    const current = await currentCodebaseFingerprint({ repositoryRoot: context.repositoryRoot, scope: latest.scope });
    return {
      status: current.sourceFingerprint === latest.sourceFingerprint ? "fresh" : "stale",
      sourceFileCount: current.sourceFileCount,
      scope: latest.scope,
      sourceFingerprint: latest.sourceFingerprint
    };
  } catch {
    return {
      status: "unknown",
      scope: latest.scope,
      sourceFingerprint: latest.sourceFingerprint
    };
  }
}
