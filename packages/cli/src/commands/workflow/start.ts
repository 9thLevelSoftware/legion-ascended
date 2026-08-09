import {
  DEFAULT_PROJECT_CONSTITUTION,
  PROJECT_ARTIFACT_PATHS,
  artifactPathForRole,
  artifactRevisionForContent,
  initProject
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  formatEntityId,
  projectSchema,
  utcTimestampSchema,
  type Actor
} from "@legion/protocol";

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
  handleAcceptDraft,
  handleAnswer,
  handleBack,
  handleBatchIntake,
  handleDiscardDraft,
  handleFinalize,
  handleNextQuestion,
  handleSessionStatus,
  handleStageDraft,
  handleSkip
} from "../../workflow/intake/driver.js";
import { recoverIntakeLifecycleArtifacts } from "../../workflow/intake/lifecycle.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";

const START_EXAMPLE = `Example: legion start --name "My Project" --summary "..." --owner dasbl`;
const START_HELP = `legion start [preparation option] [--json]

Prepare and review an intake contract, then run only the remaining interview.
The CLI owns validation, state, and transitions; a host renders the returned
review or question and relays the human's explicit decision.

Preparation and review:
  legion start                         Run or resume the CLI-owned preparation state
  legion start --goal <text>           Set or revise the preparation initiative
  legion start --without-exploration   Explicitly opt out of exploration selection
  legion start --stage-draft <file>    Validate and stage a replacement draft for review
  legion start --accept-draft          Accept the active displayed draft after human approval
  legion start --discard-draft         Durably close the active draft without a session

Interview compatibility:
  legion start --next --json           Request the current interview question explicitly
  legion start --answer "<node>=<v>"   Record one answer and advance
  legion start --accept-proposal       Take the exploration's suggestion for this question
  legion start --skip                  Decline an optional question
  legion start --back                  Undo the most recent answer
  legion start --session-status        Report progress without changing anything
  legion start --abort                 Close the session without finalizing
  legion start --intake <file>         Answer everything at once, same validators
  legion start --finalize              Write requirements, constitution and ROADMAP.md
  legion start --from-exploration <id> Select an exploration (legacy compatibility form)
  legion start --map-failed <reason>    Continue with explicitly degraded direct review

Every staged draft returns a complete grouped review with inspectable evidence.
Ask the human to accept, revise, or discard it. Its typed human_decision next
action is a pause, not an executable command. An
accept/discard is bound to the exact displayed draft digest; a supplied ID remains
compatible but cannot select stale or undisplayed bytes.

Options: --session <id> selects a session explicitly, --slug overrides the derived
project slug, --force-roadmap replaces a ROADMAP.md this command did not write.
Preparation selectors are accepted only during bare preparation or alongside
--stage-draft; enter the interview with a later --next. Accept/discard are
terminal decisions and cannot be combined with selectors, session modes, or --next.

Direct initialization, which asks nothing and creates no requirements:
  legion start --name <name> [--summary <text>] [--owner <name>] [--dry-run]`;

const START_COMMON_OPTIONS = ["created-at", "help", "json", "no-color", "repo", "repository-root"] as const;
const START_PREPARATION_SELECTORS = ["goal", "map-failed", "from-exploration", "without-exploration"] as const;

function allowedStartOptions(mode: string): ReadonlySet<string> {
  const modeOptions: Readonly<Record<string, readonly string[]>> = {
    preparation: START_PREPARATION_SELECTORS,
    stage: ["draft", "stage-draft", ...START_PREPARATION_SELECTORS],
    accept: ["accept-draft"],
    discard: ["discard-draft"],
    "session-status": ["session-status", "session"],
    abort: ["abort", "session"],
    back: ["back", "session"],
    finalize: ["finalize", "session", "force-roadmap"],
    "accept-proposal": ["accept-proposal", "session", "node"],
    skip: ["skip", "session", "node"],
    answer: ["answer", "session"],
    intake: ["intake", "session"],
    "direct-initialization": ["name", "summary", "owner", "slug", "dry-run"],
    next: ["next", "session"]
  };
  return new Set([...START_COMMON_OPTIONS, ...(modeOptions[mode] ?? [])]);
}

export async function handleStartCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(START_HELP);
  }

  const startActions = [
    context.args.options.has("draft") || context.args.options.has("stage-draft") ? "stage" : undefined,
    context.args.options.has("accept-draft") ? "accept" : undefined,
    context.args.options.has("discard-draft") ? "discard" : undefined,
    context.args.options.has("session-status") ? "session-status" : undefined,
    context.args.options.has("abort") ? "abort" : undefined,
    context.args.options.has("back") ? "back" : undefined,
    context.args.options.has("finalize") ? "finalize" : undefined,
    context.args.options.has("accept-proposal") ? "accept-proposal" : undefined,
    context.args.options.has("skip") ? "skip" : undefined,
    context.args.options.has("answer") ? "answer" : undefined,
    context.args.options.has("intake") ? "intake" : undefined,
    context.args.options.has("name") ? "direct-initialization" : undefined
  ].filter((action): action is string => action !== undefined);
  const action = startActions[0];
  const mode = action ?? (context.args.options.has("next") || context.args.options.has("session") ? "next" : "preparation");
  const allowed = allowedStartOptions(mode);
  const unexpected = [...context.args.options.keys()].filter((option) => !allowed.has(option)).sort();
  const mutuallyExclusiveSelection = context.args.options.has("from-exploration") && context.args.options.has("without-exploration");
  const duplicateStageSelector = context.args.options.has("draft") && context.args.options.has("stage-draft");
  if (startActions.length > 1 || unexpected.length > 0 || mutuallyExclusiveSelection || duplicateStageSelector) {
    const detail = unexpected.length === 0
      ? ""
      : ` Invalid for ${mode}: ${unexpected.map((option) => `--${option}`).join(", ")}.`;
    return usageError(`Choose one compatible start mode; terminal draft decisions cannot be combined with preparation selectors, interview selection, or another action.${detail}`);
  }

  if (hasFlag(context, "dry-run") && !context.args.options.has("name")) {
    return usageError("legion start --dry-run is supported only with direct --name initialization.");
  }

  // `--name` predates the interview and stays as the direct-initialization
  // path: it is what the dogfood script, the e2e suite and any non-interactive
  // caller use. It is not a shorter interview — it produces no requirements at
  // all — so it warns rather than passing silently.
  if (context.args.options.has("name")) {
    return directInitialization(context);
  }

  if (context.args.options.has("draft") || context.args.options.has("stage-draft")) return handleStageDraft(context);
  if (context.args.options.has("accept-draft")) return handleAcceptDraft(context);
  if (context.args.options.has("discard-draft")) return handleDiscardDraft(context);

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

  const summaryValueless = valuelessStartOption(
    context,
    "summary",
    "Missing required value for --summary. Use a description up to 2048 characters."
  );
  if (summaryValueless !== undefined) return summaryValueless;
  const summary = stringOption(context, "summary")?.trim();
  const dryRun = hasFlag(context, "dry-run");
  const initializedAt = createdAt ?? utcTimestampSchema.parse(new Date().toISOString());
  const repository = repositoryReference(context.repositoryRoot);
  const plannedRepository = {
    provider: repository.provider ?? "git",
    defaultBranch: repository.defaultBranch ?? "main",
    ...(repository.remoteUrl === undefined ? {} : { remoteUrl: repository.remoteUrl })
  };
  try {
    const constitutionPath = artifactPathForRole({ role: "constitution" });
    const constitution = artifactRevisionForContent({
      role: "constitution",
      path: constitutionPath,
      content: DEFAULT_PROJECT_CONSTITUTION,
      revision: 1,
      mediaType: "text/markdown"
    });
    projectSchema.parse({
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt: initializedAt,
      kind: "project",
      id: formatEntityId("project", slug),
      slug,
      name,
      ...(summary === undefined || summary.length === 0 ? {} : { description: summary }),
      repository: plannedRepository,
      policy: {
        constitution: constitution.artifact,
        currentSpecRoot: PROJECT_ARTIFACT_PATHS.currentSpecs,
        changeRoot: PROJECT_ARTIFACT_PATHS.changes,
        adrRoot: PROJECT_ARTIFACT_PATHS.adr,
        riskPolicyRefs: [],
        oraclePolicyRefs: [],
        decisionOwners: [decisionOwner]
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid direct project initialization. ${message}`);
  }
  if (!dryRun) await recoverIntakeLifecycleArtifacts(context.repositoryRoot);
  const result = await initProject({
    repositoryRoot: context.repositoryRoot,
    slug,
    name,
    ...(summary === undefined || summary.length === 0 ? {} : { description: summary }),
    repository: plannedRepository,
    decisionOwners: [decisionOwner],
    createdAt: initializedAt,
    dryRun
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
