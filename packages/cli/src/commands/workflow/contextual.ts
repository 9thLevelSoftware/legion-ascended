import { helpResult, isCliResult, success, usageError, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { positionalText, recordStandaloneWorkflow } from "./record.js";

const HELP = {
  explore: "legion explore <topic>\n\nCreate a design discovery artifact before start or planning.",
  map: "legion map [--check|--refresh]\n\nGenerate, refresh, or check codebase context.",
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

  const text = positionalText(context);
  switch (command) {
    case "explore":
      if (text === undefined) return usageError("legion explore requires a topic. Example: legion explore \"asset metadata editor\".");
      return recordStandaloneWorkflow(context, {
        workflow: "explore",
        input: { text },
        nextAction: nextAction("legion start", "Use the exploration record to initialize the project workflow."),
        slugSource: text
      });
    case "map":
      return handleMapWorkflow(context);
    case "retro": {
      const phase = optionalStringInput(context, "phase");
      if (phase !== null && typeof phase === "object" && isCliResult(phase)) return phase;
      const milestone = optionalStringInput(context, "milestone");
      if (milestone !== null && typeof milestone === "object" && isCliResult(milestone)) return milestone;
      return recordStandaloneWorkflow(context, {
        workflow: "retro",
        input: {
          phase,
          milestone
        },
        nextAction: nextAction("legion plan 1", "Use the retrospective record when planning the next phase."),
        slugSource: phase ?? milestone ?? "retro"
      });
    }
    case "milestone":
      return recordStandaloneWorkflow(context, {
        workflow: "milestone",
        input: { target: text ?? null },
        nextAction: nextAction("legion status", "The milestone request is recorded; check workflow state before changing release posture."),
        slugSource: text ?? "milestone"
      });
    case "council":
      if (text === undefined) return usageError("legion council requires a topic. Example: legion council \"release readiness\".");
      return recordStandaloneWorkflow(context, {
        workflow: "council",
        input: { text },
        nextAction: nextAction("legion status", "The council request is recorded; check workflow state before acting on it."),
        slugSource: text
      });
  }
}

function handleMapWorkflow(context: CliContext): Promise<CliResult> | CliResult {
  const check = context.args.options.get("check");
  const refresh = context.args.options.get("refresh");
  if (check !== undefined && refresh !== undefined) {
    return usageError("legion map accepts only one mode at a time. Use either --check or --refresh.");
  }
  if (check !== undefined && check !== true) {
    return usageError("legion map --check does not accept a value.");
  }
  if (refresh !== undefined && refresh !== true) {
    return usageError("legion map --refresh does not accept a value.");
  }

  if (check === true) {
    const action = nextAction("legion map --refresh", "Refresh the context map if the check shows stale project context.");
    return success(
      {
        ok: true,
        status: "ready",
        workflow: "map",
        mode: "check",
        artifactRoot: ".legion/project/workflow/map",
        nextAction: action,
        diagnostics: []
      },
      [
        "Map check ready.",
        "No workflow record was written.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  if (refresh === true) {
    return recordStandaloneWorkflow(context, {
      workflow: "map",
      input: { mode: "refresh" },
      nextAction: nextAction("legion plan 1", "Use refreshed context when planning the next change."),
      slugSource: "refresh"
    });
  }

  return usageError("legion map requires --check or --refresh.");
}

function optionalStringInput(context: CliContext, key: string): string | null | CliResult {
  if (!context.args.options.has(key)) return null;
  const value = context.args.options.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    return usageError(`Missing required value for --${key}. Example: legion retro --${key} <value>.`);
  }
  return value.trim();
}
