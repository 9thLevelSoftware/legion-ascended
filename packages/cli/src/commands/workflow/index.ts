import { WORKFLOW_COMMANDS } from "../registry.js";
import {
  hasFlag,
  helpResult,
  stripCommand,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { handleStartCommand } from "./start.js";
import { handleStatusCommand } from "./status.js";
import { handlePlanWorkflow } from "./plan.js";
import { handleBuildWorkflow } from "./build.js";
import { handleReviewWorkflow } from "./review.js";
import { handleDoctorCommand, handleValidateCommand } from "./validate.js";

const WORKFLOW_HELP = `legion <workflow>

Workflow commands:
${WORKFLOW_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}`;

export async function handleWorkflowCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (command === undefined || command === "help" || hasFlag(context, "help")) {
    return helpResult(WORKFLOW_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "start":
      return handleStartCommand(commandContext);
    case "status":
      return handleStatusCommand(commandContext);
    case "plan":
      return handlePlanWorkflow(commandContext);
    case "build":
      return handleBuildWorkflow(commandContext);
    case "review":
      return handleReviewWorkflow(commandContext);
    case "validate":
      return handleValidateCommand(commandContext);
    case "doctor":
      return handleDoctorCommand(commandContext);
    default:
      return usageError(`Unknown workflow command: legion ${command}. Run legion --help for supported workflow commands.`);
  }
}
