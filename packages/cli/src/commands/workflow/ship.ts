import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

const SHIP_HELP = "legion ship [--canary]\n\nRun release readiness, promotion, and observation gates.";

export async function handleShipWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(SHIP_HELP);
  }

  return usageError("legion ship requires a reviewed change. Run legion review first.");
}
