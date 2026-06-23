import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction } from "../../workflow/render.js";
import { positionalText, recordStandaloneWorkflow } from "./record.js";

const HELP = {
  quick: "legion quick <task>\n\nRun one ad-hoc task with a task record and risk classification.",
  advise: "legion advise <topic>\n\nRun read-only advisory analysis.",
  polish: "legion polish [target]\n\nRun scoped cleanup as an ad-hoc workflow.",
  learn: "legion learn <lesson>\n\nRecord project-specific operational learning."
} as const;

export type AdHocWorkflowCommand = keyof typeof HELP;

export async function handleAdHocWorkflow(
  context: CliContext,
  command: AdHocWorkflowCommand
): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(HELP[command]);
  }

  const text = positionalText(context);
  switch (command) {
    case "quick":
      if (text === undefined) return usageError("legion quick requires a task. Example: legion quick \"fix the failing tests\".");
      return recordStandaloneWorkflow(context, {
        workflow: "quick",
        input: { text },
        nextAction: nextAction("legion build", "The task request is recorded and ready for implementation."),
        slugSource: text
      });
    case "advise":
      if (text === undefined) return usageError("legion advise requires a topic. Example: legion advise \"release risk\".");
      return recordStandaloneWorkflow(context, {
        workflow: "advise",
        input: { text },
        nextAction: nextAction("legion status", "The advisory request is recorded; check workflow state before acting on it."),
        slugSource: text
      });
    case "polish":
      return recordStandaloneWorkflow(context, {
        workflow: "polish",
        input: { target: text ?? null },
        nextAction: nextAction("legion review", "The cleanup request is recorded and should be reviewed before shipping."),
        slugSource: text ?? "polish"
      });
    case "learn":
      if (text === undefined) return usageError("legion learn requires a lesson. Example: legion learn \"prefer artifact-backed plans\".");
      return recordStandaloneWorkflow(context, {
        workflow: "learn",
        input: { text },
        nextAction: nextAction("legion status", "The lesson is recorded; review workflow state for the next durable action."),
        slugSource: text
      });
  }
}
