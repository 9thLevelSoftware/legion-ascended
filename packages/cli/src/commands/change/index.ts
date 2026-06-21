import {
  archiveAcceptedChange,
  createChangeBundle,
  diffChangeBundle,
  loadChangeBundle,
  planAcceptedChangeArchive,
  validateChangeBundle,
  type ArchiveAcceptedChangeInput,
  type CreateChangeBundleInput
} from "@legion/artifacts";

import {
  fromServiceResult,
  hasFlag,
  helpResult,
  isCliResult,
  readJsonInput,
  requiredStringOption,
  stringOption,
  stripCommand,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const CHANGE_HELP = `legion next change <command>

Commands:
  create --input <file>     Create a change bundle from a JSON input object.
  validate <changeId>       Validate a persisted change bundle.
  diff <changeId>           Summarize proposed requirement changes.
  archive <changeId>        Archive an accepted change into current truth.

Archive options:
  --dry-run                 Plan archive without writing current truth.
  --archived-by <id>        Actor ID used for archive records.
  --archived-at <timestamp> UTC timestamp used for archive records.
  --output-branch <branch>  Branch metadata for archive records.`;

export async function handleChangeCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (hasFlag(context, "help") || command === undefined || command === "help") return helpResult(CHANGE_HELP);

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "create":
      return create(commandContext);
    case "validate":
      return validate(commandContext);
    case "diff":
      return diff(commandContext);
    case "archive":
      return archive(commandContext);
    default:
      return helpResult(CHANGE_HELP);
  }
}

async function create(context: CliContext): Promise<CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;

  const input = await readJsonInput(inputPath);
  if (isCliResult(input)) return input;

  const result = await createChangeBundle({
    ...input,
    repositoryRoot: context.repositoryRoot
  } as CreateChangeBundleInput);

  if (!result.ok) return fromServiceResult(result as unknown as Record<string, unknown>, "Change creation failed.");

  return success(
    {
      ok: true,
      status: result.status,
      change: result.bundle.change,
      bundle: result.bundle,
      deltaSpecs: result.deltaSpecs,
      design: result.design,
      decisions: result.decisions,
      artifactPath: result.artifactPath,
      reference: result.reference,
      revision: result.revision,
      diagnostics: result.diagnostics
    },
    `${result.bundle.change.id}: ${result.status}.`
  );
}

async function validate(context: CliContext): Promise<CliResult> {
  const changeId = context.args.positionals[0];
  if (changeId === undefined) return helpResult(CHANGE_HELP);

  const result = await validateChangeBundle({ repositoryRoot: context.repositoryRoot, changeId });
  return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Change is valid." : "Change validation failed.");
}

async function diff(context: CliContext): Promise<CliResult> {
  const changeId = context.args.positionals[0];
  if (changeId === undefined) return helpResult(CHANGE_HELP);

  const loaded = await loadChangeBundle({ repositoryRoot: context.repositoryRoot, changeId });
  if (!loaded.ok) return fromServiceResult(loaded as unknown as Record<string, unknown>, "Change diff unavailable.");

  const changeDiff = diffChangeBundle(loaded.bundle);
  return success(
    {
      ok: true,
      status: "diffed",
      change: loaded.bundle.change,
      diff: changeDiff,
      diagnostics: []
    },
    `${loaded.bundle.change.id}: ${changeDiff.added.length} added, ${changeDiff.modified.length} modified, ${changeDiff.removed.length} removed.`
  );
}

async function archive(context: CliContext): Promise<CliResult> {
  const changeId = context.args.positionals[0];
  if (changeId === undefined) return helpResult(CHANGE_HELP);

  const outputBranch = stringOption(context, "output-branch");
  if (hasFlag(context, "dry-run")) {
    const result = await planAcceptedChangeArchive({
      repositoryRoot: context.repositoryRoot,
      changeId,
      ...(outputBranch === undefined ? {} : { outputBranch })
    });
    return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Archive plan created." : "Archive plan failed.");
  }

  const archivedBy = requiredStringOption(context, "archived-by");
  if (typeof archivedBy !== "string") return archivedBy;
  const archivedAt = requiredStringOption(context, "archived-at");
  if (typeof archivedAt !== "string") return archivedAt;

  const input: ArchiveAcceptedChangeInput = {
    repositoryRoot: context.repositoryRoot,
    changeId,
    archivedBy,
    archivedAt,
    ...(outputBranch === undefined ? {} : { outputBranch })
  };
  const result = await archiveAcceptedChange(input);
  return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Change archived." : "Change archive failed.");
}
