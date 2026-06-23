import { readTaskGraph } from "@legion/artifacts";
import { RuntimeLocalDriver } from "@legion/core";

import { failure, hasFlag, success, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

export async function handleBuildWorkflow(context: CliContext): Promise<CliResult> {
  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before build can run."
  );

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    return blockedBuild(latestChange.diagnostics, planAction);
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedBuild(taskgraph.diagnostics, planAction);
  }

  const driver = new RuntimeLocalDriver();
  const driverId = driver.driverId;
  if (hasFlag(context, "dry-run")) {
    const action = nextAction(
      "legion build",
      "The latest task graph is ready for runtime-local execution."
    );
    const taskCount = taskgraph.document.tasks.length;
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
        driver: driverId,
        nextAction: action,
        diagnostics: []
      },
      [
        "Build ready.",
        `Dry run: ${driverId.driver} can start ${taskCount} task${taskCount === 1 ? "" : "s"} from ${latestChange.changeId}.`,
        "No implementation was run.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  const action = nextAction(
    "legion build --dry-run",
    "Only build readiness checks are wired in this CLI layer right now."
  );
  return blockedBuild(
    [
      {
        code: "runtime_start_not_implemented",
        message: "Runtime execution is not wired yet. Run legion build --dry-run to verify readiness without claiming implementation success.",
        path: taskgraph.artifactPath
      }
    ],
    action,
    {
      changeId: latestChange.changeId,
      taskgraphPath: taskgraph.artifactPath,
      driver: driverId
    }
  );
}

function blockedBuild(
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
      "Build blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}
