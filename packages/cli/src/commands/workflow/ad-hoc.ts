import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

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

  return usageError(
    `legion ${command} requires project/runtime support covered by the workflow implementation tasks. Use --help to see the command contract.`
  );
}
