import { initProject } from "@legion/artifacts";

import {
  failure,
  hasFlag,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import {
  createdAtOption,
  ownerActor,
  repositoryReference,
  slugFromName
} from "../../workflow/input.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";

const START_EXAMPLE = `Example: legion start --name "My Project" --summary "..." --owner dasbl`;

export async function handleStartCommand(context: CliContext): Promise<CliResult> {
  const name = stringOption(context, "name")?.trim();
  if (name === undefined || name.length === 0) {
    return usageError(`Missing required option --name. ${START_EXAMPLE}`);
  }

  let createdAt: ReturnType<typeof createdAtOption>;
  try {
    createdAt = createdAtOption(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --created-at value. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z. ${message}`);
  }

  const owner = stringOption(context, "owner") ?? "operator";
  const summary = stringOption(context, "summary")?.trim();
  const result = await initProject({
    repositoryRoot: context.repositoryRoot,
    slug: slugFromName(name),
    name,
    ...(summary === undefined || summary.length === 0 ? {} : { description: summary }),
    repository: repositoryReference(context.repositoryRoot),
    decisionOwners: [ownerActor(owner)],
    ...(createdAt === undefined ? {} : { createdAt }),
    dryRun: hasFlag(context, "dry-run")
  });

  if (!result.ok) {
    return failure(
      {
        ...result,
        nextAction: nextAction("legion validate", "Project state must be repaired before initialization can continue.")
      },
      startFailureHuman(result.diagnostics)
    );
  }

  const action = result.status === "dry_run"
    ? nextAction("legion start", "Dry run completed; rerun without --dry-run to write .legion/project/project.json.")
    : nextAction("legion plan 1", "Project is initialized and ready for the first planned change.");

  return success(
    {
      ...result,
      nextAction: action
    },
    `${result.project.id}: ${result.status}.\n${renderNextAction(action)}`
  );
}

function startFailureHuman(diagnostics: readonly unknown[]): string {
  const rendered = renderDiagnostics(diagnostics);
  return rendered.length > 0 ? `Project initialization failed.\n${rendered}` : "Project initialization failed.";
}
