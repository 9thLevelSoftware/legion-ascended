import { initProject } from "@legion/artifacts";
import { projectSchema, type Actor } from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  stringOption,
  success,
  usageError,
  withWarning,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import {
  createdAtOption,
  ownerActor,
  repositoryReference,
  slugFromName
} from "../../workflow/input.js";
import {
  handleAbort,
  handleAcceptProposal,
  handleAnswer,
  handleBack,
  handleBatchIntake,
  handleFinalize,
  handleNextQuestion,
  handleSessionStatus,
  handleSkip
} from "../../workflow/intake/driver.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";

const START_EXAMPLE = `Example: legion start --name "My Project" --summary "..." --owner dasbl`;
const START_HELP = `legion start [--next] [--json]

Run the intake interview. The CLI owns the question graph; a host renders each
question and relays the answer. State lives in .legion/project/intake, so an
interrupted interview resumes exactly where it stopped.

  legion start                         Begin or resume; print the next question
  legion start --next --json           The same question, machine-readable
  legion start --answer "<node>=<v>"   Record one answer and advance
  legion start --accept-proposal       Take the exploration's suggestion for this question
  legion start --skip                  Decline an optional question
  legion start --back                  Undo the most recent answer
  legion start --session-status        Report progress without changing anything
  legion start --abort                 Close the session without finalizing
  legion start --intake <file>         Answer everything at once, same validators
  legion start --finalize              Write requirements, constitution and ROADMAP.md
  legion start --from-exploration <id> Seed a new session from a legion explore run

Options: --session <id> selects a session explicitly, --slug overrides the derived
project slug, --force-roadmap replaces a ROADMAP.md this command did not write.

Direct initialization, which asks nothing and creates no requirements:
  legion start --name <name> [--summary <text>] [--owner <name>] [--dry-run]`;

export async function handleStartCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(START_HELP);
  }

  // `--name` predates the interview and stays as the direct-initialization
  // path: it is what the dogfood script, the e2e suite and any non-interactive
  // caller use. It is not a shorter interview — it produces no requirements at
  // all — so it warns rather than passing silently.
  if (context.args.options.has("name")) {
    return directInitialization(context);
  }

  if (hasFlag(context, "session-status")) return handleSessionStatus(context);
  if (hasFlag(context, "abort")) return handleAbort(context);
  if (hasFlag(context, "back")) return handleBack(context);
  if (hasFlag(context, "finalize")) return handleFinalize(context);
  if (hasFlag(context, "accept-proposal")) return handleAcceptProposal(context);
  if (hasFlag(context, "skip")) return handleSkip(context);
  if (context.args.options.has("answer")) return handleAnswer(context);
  if (context.args.options.has("intake")) return handleBatchIntake(context);

  return handleNextQuestion(context);
}

async function directInitialization(context: CliContext): Promise<CliResult> {
  const nameValueless = valuelessStartOption(
    context,
    "name",
    `Missing required option --name. ${START_EXAMPLE}`
  );
  if (nameValueless !== undefined) return nameValueless;
  const name = stringOption(context, "name")?.trim();
  if (name === undefined || name.length === 0) {
    return usageError(`Missing required option --name. ${START_EXAMPLE}`);
  }

  const createdAtValueless = valuelessStartOption(
    context,
    "created-at",
    "Missing required value for --created-at. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z."
  );
  if (createdAtValueless !== undefined) return createdAtValueless;
  let createdAt: ReturnType<typeof createdAtOption>;
  try {
    createdAt = createdAtOption(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --created-at value. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z. ${message}`);
  }

  const ownerValueless = valuelessStartOption(
    context,
    "owner",
    "Missing required value for --owner. Use a human-readable owner up to 128 characters."
  );
  if (ownerValueless !== undefined) return ownerValueless;
  const explicitOwner = stringOption(context, "owner");
  if (explicitOwner !== undefined && explicitOwner.trim().length === 0) {
    return usageError("Invalid --owner value. Use a human-readable owner up to 128 characters.");
  }
  const owner = explicitOwner ?? "operator";
  let decisionOwner: Actor;
  try {
    decisionOwner = ownerActor(owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --owner value. Use a human-readable owner up to 128 characters. ${message}`);
  }

  const slugValueless = valuelessStartOption(
    context,
    "slug",
    "Missing required value for --slug. Use lowercase letters, numbers, and hyphens, 3-64 characters, starting and ending with a letter or number."
  );
  if (slugValueless !== undefined) return slugValueless;
  const slugValue = stringOption(context, "slug")?.trim() ?? slugFromName(name);
  let slug: string;
  try {
    slug = projectSchema.shape.slug.parse(slugValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --slug value. Use lowercase letters, numbers, and hyphens, 3-64 characters, starting and ending with a letter or number. ${message}`);
  }

  const summary = stringOption(context, "summary")?.trim();
  const result = await initProject({
    repositoryRoot: context.repositoryRoot,
    slug,
    name,
    ...(summary === undefined || summary.length === 0 ? {} : { description: summary }),
    repository: repositoryReference(context.repositoryRoot),
    decisionOwners: [decisionOwner],
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

  return withWarning(
    success(
      {
        ...result,
        intake: { status: "skipped", reason: "direct_initialization" },
        nextAction: action
      },
      `${result.project.id}: ${result.status}.\n${renderNextAction(action)}`
    ),
    {
      code: "intake_skipped",
      // Countable rather than forbidden, for the same reason a `manual`
      // acceptance criterion is: the shortcut is legitimate, and a project with
      // no requirement set should be visible as such rather than looking like
      // one whose interview happened to produce nothing.
      message:
        "--name initializes the project without an interview, so it has no requirements and nothing to trace changes to. Run legion start with no arguments to record them."
    }
  );
}

function valuelessStartOption(context: CliContext, key: string, valuelessMessage: string): CliResult | undefined {
  const value = context.args.options.get(key);
  return value === true ? usageError(valuelessMessage) : undefined;
}

function startFailureHuman(diagnostics: readonly unknown[]): string {
  const rendered = renderDiagnostics(diagnostics);
  return rendered.length > 0 ? `Project initialization failed.\n${rendered}` : "Project initialization failed.";
}
