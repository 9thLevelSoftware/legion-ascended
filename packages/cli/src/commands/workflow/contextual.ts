import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

const HELP = {
  explore: "legion explore\n\nCreate a design discovery artifact before start or planning.",
  map: "legion map [--check|--refresh|--query <text>]\n\nGenerate, refresh, check, or query codebase context.",
  retro: "legion retro [--phase N|--milestone M]\n\nRecord retrospective evidence for future planning.",
  milestone: "legion milestone\n\nManage milestone status, summaries, and archives.",
  council: "legion council <topic>\n\nRun governance deliberation formerly exposed as /legion:board."
} as const;

export type ContextualWorkflowCommand = keyof typeof HELP;

export async function handleContextualWorkflow(
  context: CliContext,
  command: ContextualWorkflowCommand
): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(HELP[command]);
  }

  return usageError(
    `legion ${command} requires project/runtime support covered by the workflow implementation tasks. Use --help to see the command contract.`
  );
}
