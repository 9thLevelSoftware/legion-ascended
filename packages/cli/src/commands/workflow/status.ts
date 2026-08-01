import {
  helpResult,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { currentCodebaseFingerprint, getLatestCodebaseMap } from "../../workflow/codebase-map.js";
import { latestGuidanceRuns } from "../../workflow/guidance-run.js";
import { nextAction, renderNextAction, type NextAction } from "../../workflow/render.js";
import {
  renderIntakeLine,
  renderRequirementsLine,
  renderTraceabilityLine,
  resolveIntakeStatus,
  resolveRequirementsStatus,
  resolveTraceabilityStatus,
  type IntakeStatus,
  type RequirementsStatus
} from "../../workflow/status-detail.js";
import { resolveWorkflowState, type WorkflowState } from "../../workflow/state.js";

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
  const [guidanceRuns, mapStatus, intake, requirements] = await Promise.all([
    latestGuidanceRuns({ repositoryRoot: context.repositoryRoot, limitPerWorkflow: 1 }),
    resolveMapStatus(context),
    resolveIntakeStatus(context.repositoryRoot),
    resolveRequirementsStatus(context.repositoryRoot)
  ]);
  // Sequenced after `requirements` because a project with no requirement set has
  // nothing to trace, and reporting a clean graph over an empty set would read
  // as traceability satisfied.
  const traceability = await resolveTraceabilityStatus(context.repositoryRoot, requirements);
  const resolvedNextAction = refineNextAction({ workflowState, intake, requirements });

  return success(
    {
      ok: true,
      status: "workflow_status",
      workflowState,
      intake,
      requirements,
      traceability,
      guidance: {
        latestRuns: guidanceRuns.map((run) => ({
          workflow: run.workflow,
          runId: run.runId,
          status: run.status,
          nextAction: run.nextAction
        }))
      },
      map: mapStatus,
      nextAction: resolvedNextAction,
      diagnostics: workflowState.diagnostics
    },
    [
      `Stage: ${workflowState.stage}`,
      `Project: ${workflowState.projectId ?? "not initialized"}`,
      renderIntakeLine(intake),
      renderRequirementsLine(requirements),
      renderTraceabilityLine(traceability),
      `Current specs: ${workflowState.currentSpecCount}`,
      `Map: ${mapStatus.status}`,
      `Guidance runs: ${guidanceRuns.length}`,
      renderNextAction(resolvedNextAction)
    ].join("\n")
  );
}

/**
 * Let the v9 artifacts correct the stage machine's routing where they know better.
 *
 * Two cases the stage machine cannot see, because it reads `project.json` and
 * `.legion/project/changes` and neither records an interview or a requirement hash:
 *
 * - An interview is open. The verb is unchanged — `legion start` resumes — but
 *   "no project.json exists" is the wrong reason to give someone who is twelve
 *   questions into one, and it invites starting over.
 * - The requirement set no longer hashes to what was recorded. That is the
 *   frozen-artifact check failing, and planning off a drifted set is exactly
 *   what the hash exists to prevent, so it routes to `legion validate`.
 *
 * Drift is checked last so it wins: a drifted set is a repair, and repair
 * outranks resuming an interview.
 */
export function refineNextAction(input: {
  readonly workflowState: WorkflowState;
  readonly intake: IntakeStatus;
  readonly requirements: RequirementsStatus;
}): NextAction {
  const { workflowState, intake, requirements } = input;
  let resolved = workflowState.nextAction;

  if (intake.status === "active" && workflowState.stage === "uninitialized") {
    resolved = intake.pendingNodeId === undefined
      ? nextAction(
          "legion start --finalize",
          `Interview ${intake.sessionId} has answered every question the graph asks and is ready to finalize.`
        )
      : nextAction(
          "legion start",
          `Interview ${intake.sessionId} is in progress — ${intake.answered ?? 0} answered, next question ${intake.pendingNodeId}.`
        );
  }

  if (intake.status === "unreadable") {
    resolved = nextAction("legion start --session-status", intake.reason ?? "An intake session could not be read.");
  }

  if (requirements.status === "drifted" || requirements.status === "invalid") {
    resolved = nextAction(
      "legion validate",
      requirements.status === "drifted"
        ? `The requirement set no longer matches its recorded hash (${requirements.drift?.length ?? 0} drift finding(s)). Planning off a drifted set is what the hash exists to prevent.`
        : `The requirement set could not be read: ${requirements.reason ?? "unknown reason"}`
    );
  }

  return resolved;
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
