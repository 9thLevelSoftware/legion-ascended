import { WORKFLOW_COMMANDS } from "../registry.js";
import {
  helpResult,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const WORKFLOW_HELP = `legion <workflow>

Workflow commands:
${WORKFLOW_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}`;

export async function handleWorkflowCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (command === undefined || command === "help" || context.args.options.has("help")) {
    return helpResult(WORKFLOW_HELP);
  }
  return usageError(`Workflow command is unavailable in this router slice: legion ${command}. Run legion --help for supported workflow commands.`);
}
