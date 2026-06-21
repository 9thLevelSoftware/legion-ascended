import {
  initProject,
  listCurrentSpecs,
  loadProject,
  validateProject,
  type InitProjectInput
} from "@legion/artifacts";

import {
  fromServiceResult,
  hasFlag,
  helpResult,
  isCliResult,
  readJsonInput,
  requiredStringOption,
  stripCommand,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const PROJECT_HELP = `legion next project <command>

Commands:
  init --input <file>       Initialize .legion/project from a JSON input object.
  validate                  Validate the project manifest and constitution.
  status                    Read project status and current-spec count.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.`;

export async function handleProjectCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (hasFlag(context, "help") || command === undefined || command === "help") return helpResult(PROJECT_HELP);

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "init":
      return init(commandContext);
    case "validate":
      return validate(commandContext);
    case "status":
      return status(commandContext);
    default:
      return helpResult(PROJECT_HELP);
  }
}

async function init(context: CliContext): Promise<CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;

  const input = await readJsonInput(inputPath);
  if (isCliResult(input)) return input;

  const result = await initProject({
    ...input,
    repositoryRoot: context.repositoryRoot
  } as InitProjectInput);

  return fromServiceResult(result as unknown as Record<string, unknown>, projectHuman(result));
}

async function validate(context: CliContext): Promise<CliResult> {
  const result = await validateProject({ repositoryRoot: context.repositoryRoot });
  return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Project is valid." : "Project validation failed.");
}

async function status(context: CliContext): Promise<CliResult> {
  const loaded = await loadProject({ repositoryRoot: context.repositoryRoot });
  if (!loaded.ok) {
    return fromServiceResult(loaded as unknown as Record<string, unknown>, "Project status unavailable.");
  }

  const specs = await listCurrentSpecs({ repositoryRoot: context.repositoryRoot });
  if (!specs.ok) {
    return fromServiceResult(specs as unknown as Record<string, unknown>, "Current spec status unavailable.");
  }

  return success(
    {
      ok: true,
      status: "loaded",
      project: loaded.project,
      manifest: loaded.manifest,
      currentSpecCount: specs.documents.length,
      currentSpecIndexHash: specs.indexHash,
      diagnostics: []
    },
    `${loaded.project.id}: ${specs.documents.length} current specs.`
  );
}

function projectHuman(result: Awaited<ReturnType<typeof initProject>>): string {
  return result.ok ? `${result.project.id}: ${result.status}.` : "Project initialization failed.";
}
