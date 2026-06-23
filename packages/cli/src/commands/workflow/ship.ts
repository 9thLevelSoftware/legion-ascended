import { failure, helpResult, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

const SHIP_HELP = "legion ship [--canary]\n\nRun release readiness, promotion, and observation gates.";

export async function handleShipWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(SHIP_HELP);
  }

  const action = nextAction("legion review", "Shipping requires accepted review evidence.");
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics: [
        {
          code: "review_evidence_missing",
          message: "No accepted review evidence was found. Run legion review first."
        }
      ],
      nextAction: action
    },
    [
      "Ship blocked.",
      "No accepted review evidence was found. Run legion review first.",
      renderNextAction(action)
    ].join("\n")
  );
}
