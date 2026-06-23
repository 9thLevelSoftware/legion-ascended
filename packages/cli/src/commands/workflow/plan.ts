import {
  failure,
  hasFlag,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { resolvePhaseSource } from "../../workflow/phase-compat.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";

const PLAN_USAGE = "Use: legion plan 1";
const PLAN_FROM_ROADMAP_USAGE = "Use: legion plan 1 --from-roadmap ROADMAP.md";

export async function handlePlanWorkflow(context: CliContext): Promise<CliResult> {
  const phaseNumberResult = parsePhaseNumber(context.args.positionals[0]);
  if (typeof phaseNumberResult !== "number") return phaseNumberResult;

  const fromRoadmapResult = validateFromRoadmapOption(context);
  if (fromRoadmapResult !== undefined) return fromRoadmapResult;

  const workflowState = await resolveWorkflowState(context);
  if (workflowState.stage === "uninitialized") {
    return blockedPlan(workflowState.diagnostics, workflowState.nextAction);
  }
  if (workflowState.stage === "blocked") {
    return blockedPlan(workflowState.diagnostics, workflowState.nextAction);
  }

  const resolved = await resolvePhaseSource(context, phaseNumberResult);
  if (!resolved.ok) {
    const diagnostics = [resolved.diagnostic];
    const action = nextAction(
      "legion explore",
      "A phase source is required before planning can produce a task graph."
    );
    return failure(
      {
        ok: false,
        status: "blocked",
        diagnostics,
        nextAction: action
      },
      [
        "Planning is blocked.",
        renderDiagnostics(diagnostics),
        renderNextAction(action)
      ].join("\n")
    );
  }

  const action = nextAction(
    "legion build",
    "The phase source is resolved; build is the next workflow step after task artifacts exist."
  );
  const dryRun = hasFlag(context, "dry-run");
  return success(
    {
      ok: true,
      status: "planned",
      dryRun,
      phase: resolved.phase,
      autoRefine: hasFlag(context, "auto-refine"),
      nextAction: action,
      diagnostics: []
    },
    planningSuccessHuman(resolved.phase.number, resolved.phase.name, dryRun, action)
  );
}

function parsePhaseNumber(value: string | undefined): number | CliResult {
  if (value === undefined) {
    return usageError(`Missing phase number. ${PLAN_USAGE}`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return usageError(`Invalid phase number "${value}". Use a positive integer. ${PLAN_USAGE}`);
  }
  return Number.parseInt(value, 10);
}

function validateFromRoadmapOption(context: CliContext): CliResult | undefined {
  if (!context.args.options.has("from-roadmap")) return undefined;

  const value = context.args.options.get("from-roadmap");
  if (typeof value === "string" && value.trim().length > 0) return undefined;

  return usageError(`Missing required option --from-roadmap. ${PLAN_FROM_ROADMAP_USAGE}`);
}

function blockedPlan(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics,
      nextAction: action
    },
    [
      "Planning is blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}

function planningSuccessHuman(
  phaseNumber: number,
  phaseName: string,
  dryRun: boolean,
  action: ReturnType<typeof nextAction>
): string {
  const summary = `Planning preview for phase ${phaseNumber}: ${phaseName}.`;
  const mode = dryRun
    ? "Dry run: no task graph was written."
    : "Compatibility preview: task graph writing is not wired until Task 9, so no artifacts were written.";
  return [summary, mode, renderNextAction(action)].join("\n");
}
