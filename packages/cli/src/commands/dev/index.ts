import { handleBoardCommand } from "../board/index.js";
import { handleChangeCommand } from "../change/index.js";
import { handleEvalsCommand } from "../evals/index.js";
import { handleMigrateCommand } from "../migrate/index.js";
import { handleProjectCommand } from "../project/index.js";
import { handleReleaseCommand } from "../release/index.js";
import { DEV_COMMANDS } from "../registry.js";
import {
  helpResult,
  stripCommand,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const DEV_HELP = `legion dev <command>

Advanced engine commands:
${DEV_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

export async function handleDevCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (command === undefined || command === "help") {
    return helpResult(DEV_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "project":
      return handleProjectCommand(commandContext);
    case "change":
      return handleChangeCommand(commandContext);
    case "board":
      return handleBoardCommand(commandContext);
    case "migrate":
      return handleMigrateCommand(commandContext);
    case "evals":
      return handleEvalsCommand(commandContext);
    case "release":
      return handleReleaseCommand(commandContext);
    case "worker":
      return usageError("Worker bundle dev commands are available through the source-tree gate: pnpm run check:worker-bundles.");
    default:
      return usageError(`Unknown legion dev command: ${command}.`);
  }
}
