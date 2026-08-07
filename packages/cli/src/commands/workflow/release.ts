import {
  artifactPathForRole,
  loadChangeBundle,
  readRelease,
  readTaskGraph,
  writeRelease,
  type ReleaseSuccess
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  releaseEnvironmentSchema,
  releaseRollbackStrategySchema,
  taskIdSchema,
  type ArtifactReference,
  type Release,
  type ReleaseEnvironment,
  type ReleaseRollbackStrategy,
  type TaskContract
} from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  repeatedStringOptions,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { PROJECT_MANIFEST_PATH } from "../../workflow/approver.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { mintPinnedReferences } from "../../workflow/pinned-references.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { releaseIdForChange, taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  derivesShipGate,
  isSatisfyingReleasePlan,
  releasePlanShortfall,
  releaseRecordsNegative
} from "../../workflow/ship-gates.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const RELEASE_ENVIRONMENTS = releaseEnvironmentSchema.options as readonly ReleaseEnvironment[];
const ROLLBACK_STRATEGIES = releaseRollbackStrategySchema.options as readonly ReleaseRollbackStrategy[];

/** The most a single criterion may be, from `releaseSchema`'s own bound. */
const CRITERION_MAX_LENGTH = 1_024;

const RELEASE_HELP = `legion release <subject>

Record how this change's release will be observed and taken back. This writes a
governance artifact and nothing else: it does not deploy, publish, run a canary
probe, or observe anything.

Subjects:
  plan   Record the release observation plan for the latest change.

legion release plan --environment <env> --rollback-strategy <strategy>
                    --health-criterion <text>... --rollback-criterion <text>...
                    [--covers <taskId>...] [--dry-run]

  --environment <env>        Required. ${RELEASE_ENVIRONMENTS.join(" | ")}. There is no
                             default: a plan for local and a plan for production
                             are different plans, and the gate reads the choice.
                             Only staging and production satisfy
                             release_observation_plan; nothing is released into
                             local or test, so a plan naming one is recorded and
                             warned about. A change that deploys nothing at all is
                             waived instead, through legion attest
                             release-observation --verdict not_applicable.
  --rollback-strategy <s>    Required. ${ROLLBACK_STRATEGIES.join(" | ")}.
  --health-criterion <text>  Required, repeatable. What the release is watched
                             against. Authored, never derived: a criterion Legion
                             wrote for you observes nothing anybody chose.
  --rollback-criterion <t>   Required, repeatable. What would trigger the rollback.
  --covers <taskId>          Repeatable. Which of this change's tasks the plan
                             observes. Omitted, every task of the change.
  --dry-run                  Report what would be recorded and write nothing.

A plan is checkable *before* the release, which is what makes
release_observation_plan answerable at ship time. It carries no ordering rule —
a plan authored after the build is still a plan, because it constrains the
release rather than the run.

Re-running rewrites the same release.json at the next revision, except over a
release that failed or was taken back: those are refused rather than replaced,
because a fresh plan written over one would report the gate satisfied about a
release nobody repaired. That follow-up work belongs in a new change.

This is not the post-deployment record. \`legion dev board release-observation\`
aggregates a ReleaseObservationReport produced by an out-of-band monitor into the
board's event log; that plane lives outside .legion/project and no ship gate
reads it, which is exactly why this gate reads a plan instead.

Example:
  legion release plan --environment staging --rollback-strategy revert \\
    --health-criterion "p99 quote latency stays under 400ms for 30 minutes" \\
    --rollback-criterion "quote error rate exceeds 1% over any 5 minute window"`;

/**
 * `legion release <subject>`, a top-level workflow verb rather than a subcommand
 * of `legion dev release`.
 *
 * Four reasons, in the order they decide it, and the first was measured rather
 * than argued. **`legion dev release plan --json` today returns
 * `{"ok": true, "status": "help"}` with exit 0**, because `handleReleaseCommand`'s
 * switch ends `default: return helpResult(RELEASE_HELP)` — so putting `plan`
 * under that verb means a host that mis-splits its argv reads a help screen as a
 * completed plan. That is the exact failure `handleApproveWorkflow` and
 * `handleAttestWorkflow` were written against, and it is why bare
 * `legion release` below is a usage error and not a help screen.
 *
 * Second, `legion dev release` is a GA-repository adapter: both of its
 * subcommands `execFile` a script inside the packaged CLI's own source root
 * rather than the operator's `--repository-root`, and neither has any concept of
 * a change. Third, this verb writes a change-scoped governance artifact under
 * `.legion/project/changes/<id>/`, which is what `legion approve` and
 * `legion attest` are and where they live. Fourth, ADR-009 reserves the `dev`
 * namespace for engine operations.
 *
 * The subject is a positional rather than a flat verb because `observe` is a
 * deliberate second subject a later release adds: as a positional the set is a
 * closed switch whose `default:` enumerates what exists, and as booleans they
 * would be mutually exclusive flags needing runtime cross-validation. With one
 * subject there is nothing for `legion approve`'s `SUBJECT_OPTIONS` cross-refusal
 * to own, so that machinery is deliberately not shipped empty — `legion attest`
 * takes the same position for the same reason, and the second subject is where
 * the boundary arrives.
 *
 * **No `--approver` and no actor field.** `releaseSchema` records no decider and
 * this release does not invent one: a plan is a checkable document rather than a
 * decision, so it needs no named human to be worth anything — every claim in it
 * is falsifiable by reading it. The identity discipline lives where it earns its
 * keep, on the waiver route, which already has it:
 * `legion attest release-observation --verdict not_applicable --attested-by <id>`.
 * Stated rather than omitted, because silence here would read as an oversight.
 */
export async function handleReleaseWorkflow(context: CliContext): Promise<CliResult> {
  const subject = context.args.positionals[0];
  if (hasFlag(context, "help") || subject === "help") {
    return helpResult(RELEASE_HELP);
  }
  const supported = RELEASE_SUBJECTS.join(", ");
  if (subject === undefined) {
    return usageError(
      `legion release requires a subject. Supported subjects: ${supported}. ` +
        "Example: legion release plan --environment staging --rollback-strategy revert " +
        "--health-criterion <text> --rollback-criterion <text>."
    );
  }
  if (!RELEASE_SUBJECTS.includes(subject as ReleaseSubject)) {
    return usageError(`Unknown release subject: legion release ${subject}. Supported subjects: ${supported}.`);
  }
  return planRelease(context);
}

const RELEASE_SUBJECTS = ["plan"] as const;
type ReleaseSubject = (typeof RELEASE_SUBJECTS)[number];

/**
 * A repeatable authored list, refused rather than defaulted when it is empty.
 *
 * `attest.ts`'s human-judgement floor, applied to the two lists this gate
 * quantifies over. Deriving health criteria from the taskgraph would be the
 * rubber stamp this series refuses: a criterion Legion wrote is not a thing
 * anybody chose to watch, and `release_observation_plan` would then be satisfied
 * by the act of running a command.
 */
function authoredList(context: CliContext, option: string): readonly string[] | "missing_value" {
  if (context.args.options.get(option) === true) return "missing_value";
  return [...new Set(repeatedStringOptions(context, option).map((value) => value.trim()))].filter(
    (value) => value.length > 0
  );
}

async function planRelease(context: CliContext): Promise<CliResult> {
  const environmentRaw = stringOption(context, "environment")?.trim();
  if (context.args.options.get("environment") === true || environmentRaw === "") {
    return usageError(
      `Missing required value for --environment. Supported environments: ${RELEASE_ENVIRONMENTS.join(", ")}.`
    );
  }
  if (environmentRaw === undefined) {
    return blockedRelease(
      [
        {
          code: "environment_required",
          message:
            `legion release plan requires --environment. Supported environments: ${RELEASE_ENVIRONMENTS.join(", ")}. ` +
            "There is no default: a plan for local and a plan for production observe different things and are " +
            "different plans, so one Legion chose would be a plan nobody wrote.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction("legion release plan --environment <env>", "Name the environment this release will be observed in.")
    );
  }
  const parsedEnvironment = releaseEnvironmentSchema.safeParse(environmentRaw);
  if (!parsedEnvironment.success) {
    return usageError(
      `Unknown release environment: --environment ${environmentRaw}. Supported environments: ${RELEASE_ENVIRONMENTS.join(", ")}.`
    );
  }
  const environment = parsedEnvironment.data;

  const strategyRaw = stringOption(context, "rollback-strategy")?.trim();
  if (context.args.options.get("rollback-strategy") === true || strategyRaw === "") {
    return usageError(
      `Missing required value for --rollback-strategy. Supported strategies: ${ROLLBACK_STRATEGIES.join(", ")}.`
    );
  }
  if (strategyRaw === undefined) {
    return blockedRelease(
      [
        {
          code: "rollback_strategy_required",
          message:
            "legion release plan requires --rollback-strategy. Supported strategies: " +
            `${ROLLBACK_STRATEGIES.join(", ")}. ADR-006 asks for a canary or observation plan, and a plan that says ` +
            "how a release is watched without saying how it is taken back is half of one.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction(
        `legion release plan --rollback-strategy <${ROLLBACK_STRATEGIES.join("|")}>`,
        "Say how this release would be taken back."
      )
    );
  }
  const parsedStrategy = releaseRollbackStrategySchema.safeParse(strategyRaw);
  if (!parsedStrategy.success) {
    return usageError(
      `Unknown rollback strategy: --rollback-strategy ${strategyRaw}. Supported strategies: ${ROLLBACK_STRATEGIES.join(", ")}.`
    );
  }
  const rollbackStrategy = parsedStrategy.data;

  const healthCriteria = authoredList(context, "health-criterion");
  if (healthCriteria === "missing_value") {
    return usageError('Missing required value for --health-criterion. Example: --health-criterion "error rate < 1%".');
  }
  const rollbackCriteria = authoredList(context, "rollback-criterion");
  if (rollbackCriteria === "missing_value") {
    return usageError(
      'Missing required value for --rollback-criterion. Example: --rollback-criterion "error rate > 1% for 5 minutes".'
    );
  }

  // Refused positively, both of them, and each empty case is checked rather than
  // quantified over. `releaseSchema` does not bound `healthCriteria`, so an empty
  // one parses — and `release_observation_plan` refuses it, so a command that
  // wrote one would exit 0 and leave ship blocked forever. This is the writer
  // holding the reader's floor rather than a weaker one.
  if (healthCriteria.length === 0) {
    return blockedRelease(
      [
        {
          code: "health_criteria_required",
          message:
            "legion release plan requires at least one --health-criterion <text>. A plan with no health criterion " +
            "plans a release nothing would be observed against, and release_observation_plan reads that as " +
            "unsatisfied rather than as absent — so writing one would exit 0 and leave ship blocked. The criteria are " +
            "authored, never derived from the task graph: a criterion Legion wrote for you is not something anybody " +
            "chose to watch.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction(
        'legion release plan --health-criterion "<text>"',
        "Say what this release will be watched against, in terms somebody could check."
      )
    );
  }
  if (rollbackCriteria.length === 0) {
    return blockedRelease(
      [
        {
          code: "rollback_criteria_required",
          message:
            "legion release plan requires at least one --rollback-criterion <text>. releaseRollbackPlanSchema " +
            "requires a non-empty criteria list, so a plan without one cannot even be written — and a rollback " +
            "strategy with no trigger says how the release would be taken back without saying when.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction(
        'legion release plan --rollback-criterion "<text>"',
        "Say what would make this release be taken back."
      )
    );
  }
  const overlong = [...healthCriteria, ...rollbackCriteria].find((value) => value.length > CRITERION_MAX_LENGTH);
  if (overlong !== undefined) {
    return usageError(
      `A release criterion may be at most ${CRITERION_MAX_LENGTH} characters, and one of the criteria given is ` +
        `${overlong.length}. releaseSchema bounds them, so a longer one would be refused at the write with a message ` +
        "naming a field rather than the text you typed."
    );
  }

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    return blockedRelease(latestChange.diagnostics, nextAction("legion plan 1", "Planning a release requires a planned change."));
  }

  const bundle = await loadChangeBundle({ repositoryRoot: context.repositoryRoot, changeId: latestChange.changeId });
  if (!bundle.ok) {
    return blockedRelease(
      bundle.diagnostics,
      nextAction("legion ship", "The change this plan would be about could not be read; legion ship names why."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const taskgraph = await readTaskGraph({ repositoryRoot: context.repositoryRoot, changeId: latestChange.changeId });
  if (!taskgraph.ok) {
    return blockedRelease(
      taskgraph.diagnostics,
      nextAction("legion plan 1", "A release plan names the tasks it observes, and the task graph could not be read."),
      { change: { changeId: latestChange.changeId } }
    );
  }
  const taskIds = taskgraph.document.tasks.map((task) => taskIdForContractId(task.id) as string);

  const coversRaw = [...new Set(repeatedStringOptions(context, "covers").map((value) => value.trim()))].filter(
    (value) => value.length > 0
  );
  if (context.args.options.get("covers") === true) {
    return usageError("Missing required value for --covers. Example: --covers tsk_phase-1-c1.");
  }
  const unknownTask = coversRaw.find((value) => !taskIds.includes(value));
  if (unknownTask !== undefined) {
    return blockedRelease(
      [
        {
          // The same code `legion attest` raises for the same fact, deliberately
          // rather than a synonym: one vocabulary across the verbs that name a
          // change's tasks means one thing for a host to route on.
          code: "task_not_in_change",
          message:
            `--covers ${unknownTask} is not a task of ${latestChange.changeId}. Its tasks are: ${taskIds.join(", ")}. ` +
            "Claiming to observe a task Legion cannot show you observes nothing.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction("legion release plan --covers <taskId>", "Name a task this change actually carries."),
      { change: { changeId: latestChange.changeId } }
    );
  }
  // Every task by default, on `legion attest --covers`' rule: the gate quantifies
  // over every task of the change that derives it, and a narrower default would
  // make the successful-looking path the one that leaves ship blocked over a task
  // the operator never heard of. The default is a superset of the gate's
  // denominator, which is the tasks that actually derive the gate — so it can
  // only satisfy, never over-refuse.
  const covers = coversRaw.length > 0 ? coversRaw : taskIds;
  if (covers.length === 0) {
    return blockedRelease(
      [
        {
          code: "change_has_no_tasks",
          message:
            `${latestChange.changeId} carries no task contracts, so there is nothing for a release plan to observe. ` +
            "Plan the change first; a plan that covers nothing satisfies no gate.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction("legion plan 1", "A release plan names the tasks it observes, and this change has none."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // The release intent is the change's own task graph, pinned through the
  // resolver rather than assembled by hand — `mintPinnedReferences`' comment
  // records why any other route mints a pin nothing will ever answer for.
  //
  // The gate reads its **path** and not its digest, and that is stated at both
  // ends: `legion review --accept` re-points `taskgraph.json`, so a digest
  // recorded now legitimately drifts during an accept that changed no task. What
  // the pin records here is provenance — which document's task set this plan's
  // taskRefs were drawn from — and the coverage claim itself is re-derived
  // against the live task graph on every `legion ship`.
  const taskgraphPath = artifactPathForRole({ role: "taskgraph", changeId: bundle.bundle.change.id }) as string;
  const mint = await mintPinnedReferences({ repositoryRoot: context.repositoryRoot, paths: [taskgraphPath] });
  const releaseIntent = mint(taskgraphPath);
  if (releaseIntent === undefined) {
    return blockedRelease(
      [
        {
          code: "release_intent_unpinnable",
          message:
            `${taskgraphPath} could not be pinned, so nothing was written. A release plan records which document its ` +
            "task coverage was drawn from, and this change's task graph is that document.",
          path: taskgraphPath
        }
      ],
      nextAction("legion plan 1", "The change's task graph could not be pinned."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const releaseId = releaseIdForChange({ changeId: bundle.bundle.change.id });
  const existing = await readRelease({ repositoryRoot: context.repositoryRoot, changeId: bundle.bundle.change.id });
  if (!existing.ok && existing.status !== "not_found") {
    return blockedRelease(
      existing.diagnostics,
      nextAction(
        "legion release plan",
        "A release plan already exists for this change and could not be read. Writing over an unread record is the " +
          "one way to silently replace a failed release with a fresh plan, so nothing was written. Correct it by " +
          "hand, then run this again."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // **The one state this verb refuses to write over, and the review that found it
  // measured the whole route.** `release_observation_plan` reported
  // `nextAction.command = "legion release plan ..."` for a `rolled_back` release;
  // running exactly that produced a fresh `status: "requested"` document, dropped
  // the `rollbackEvidenceRefs` the schema had required for that status, and turned
  // the gate green with `waivedGates: []` and no warning anywhere in the ship
  // payload. The cure the gate printed laundered the negative it was printed
  // about. The refusal is here rather than in the recovery text alone because a
  // sentence is not a mechanism, and it asks the gate's own classification —
  // `releaseRecordsNegative` — so a status list beside this verb cannot drift from
  // the one the reader uses.
  if (existing.ok && releaseRecordsNegative(existing.document)) {
    return blockedRelease(
      [
        {
          code: "release_records_negative",
          message:
            `${existing.artifactPath as string} records status "${existing.document.status}": a release of ` +
            `${latestChange.changeId} that failed or was taken back. Re-planning would replace that record with a ` +
            'fresh plan at status "requested" and report release_observation_plan satisfied, which is how a recorded ' +
            "negative gets laundered — so nothing was written. The follow-up work belongs in a new change. If the " +
            "record itself is wrong, correct or remove the file by hand and run this again.",
          path: existing.artifactPath as string
        }
      ],
      nextAction(
        "legion start --intake",
        `${latestChange.changeId} records a release that failed or was taken back. Record the follow-up work as a new ` +
          "change; this one is not re-planned green."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const plannedAt = currentUtcTimestamp();
  const document = releaseDocument({
    releaseId,
    projectId: bundle.bundle.change.projectId,
    changeId: bundle.bundle.change.id,
    environment,
    releaseIntent,
    plannedAt,
    covers,
    healthCriteria,
    rollbackStrategy,
    rollbackCriteria,
    ...(existing.ok ? { existing } : {})
  });

  // **The writer's "nothing to do" question is the gate's own predicate, called
  // rather than paraphrased.** This series' third lesson, and the fourth verb to
  // pay it: a writer whose idea of done is weaker than the reader's idea of
  // satisfied reports success, writes nothing, and leaves the change blocked
  // forever with no flag that would make it write. `existing.ok` alone would say
  // "already planned" over a plan with no health criterion, over one covering
  // half the change, and over one whose status records a failed release.
  //
  // The authored content is compared as well, because a rerun that changes a
  // criterion has something to record even when the old plan satisfied the gate.
  const alreadySatisfying =
    existing.ok &&
    sameAuthoredPlan(existing.document, document) &&
    isSatisfyingReleasePlan({
      release: existing.document,
      changeId: bundle.bundle.change.id,
      tasks: taskgraph.document.tasks,
      taskIdFor: (task) => taskIdForContractId(task.id)
    });
  const action: "record" | "re-record" | "unchanged" = existing.ok
    ? alreadySatisfying
      ? "unchanged"
      : "re-record"
    : "record";

  const warnings = releaseWarnings({
    changeId: latestChange.changeId,
    tasks: taskgraph.document.tasks,
    covers,
    taskIds,
    taskgraphPath: taskgraph.artifactPath as string,
    document,
    action,
    ...(existing.ok ? { previous: existing } : {})
  });

  if (hasFlag(context, "dry-run")) {
    const dryRunAction = nextAction(
      action === "unchanged" ? "legion ship" : "legion release plan --environment <env>",
      action === "unchanged"
        ? "This change already carries a release plan with these criteria that satisfies the gate reading it; this dry run found nothing to record."
        : "This was a dry run and no release plan was written. release_observation_plan stays unmet until this command is run without --dry-run."
    );
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        ...(warnings.length === 0 ? {} : { warnings }),
        release: {
          releaseId,
          environment,
          action,
          covers,
          healthCriteria,
          rollbackPlan: { strategy: rollbackStrategy, criteria: rollbackCriteria },
          releaseIntent
        },
        nextAction: dryRunAction,
        diagnostics: []
      },
      [
        "Release plan ready.",
        `Dry run: ${action} a ${environment} release plan for ${latestChange.changeId}.`,
        ...healthCriteria.map((value) => `  health    ${value}`),
        `  rollback  ${rollbackStrategy}`,
        ...rollbackCriteria.map((value) => `  trigger   ${value}`),
        ...warnings.map((warning) => `Warning: ${warning.message}`),
        "No release plan was written.",
        renderNextAction(dryRunAction)
      ].join("\n")
    );
  }

  let written: ReleaseSuccess | undefined;
  if (action !== "unchanged") {
    const write = await writeRelease({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: existing.ok ? existing.revision.revision : 0,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document
    });
    if (!write.ok) {
      return blockedRelease(
        write.diagnostics,
        nextAction("legion release plan", "The release plan could not be written. Correct the reported problem, then run this again."),
        { change: { changeId: latestChange.changeId } }
      );
    }
    written = write;
  }

  const record = written ?? (existing.ok ? existing : undefined);
  const resultAction = nextAction(
    "legion ship",
    `The release plan for ${latestChange.changeId} is recorded. legion ship reads it back and reports whether ` +
      "release_observation_plan is satisfied."
  );
  return success(
    {
      ok: true,
      status: action === "unchanged" ? "unchanged" : "planned",
      change: { changeId: latestChange.changeId },
      ...(warnings.length === 0 ? {} : { warnings }),
      release: {
        releaseId,
        environment,
        action,
        covers,
        healthCriteria,
        rollbackPlan: { strategy: rollbackStrategy, criteria: rollbackCriteria },
        releaseIntent,
        artifactPath: record?.artifactPath,
        status: record?.document.status
      },
      nextAction: resultAction,
      diagnostics: []
    },
    [
      action === "unchanged"
        ? `Already planned: a ${environment} release for ${latestChange.changeId}.`
        : `Planned a ${environment} release for ${latestChange.changeId}.`,
      ...healthCriteria.map((value) => `  health    ${value}`),
      `  rollback  ${rollbackStrategy}`,
      ...rollbackCriteria.map((value) => `  trigger   ${value}`),
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      renderNextAction(resultAction)
    ].join("\n")
  );
}

/**
 * Did the operator author the same plan that is already on disk?
 *
 * Every field this command lets a person write, and nothing derived. The
 * instants, the revision metadata and the release status are deliberately
 * excluded: a rerun that changes none of the authored content must not rewrite
 * the document just because the clock moved, and the status is not this verb's to
 * compare — a plan whose status has left `requested` is caught by
 * `isSatisfyingReleasePlan` calling the gate.
 */
function sameAuthoredPlan(existing: Release, next: Release): boolean {
  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  return (
    existing.environment === next.environment &&
    existing.releaseIntent.path === next.releaseIntent.path &&
    existing.rollbackPlan.strategy === next.rollbackPlan.strategy &&
    sameList(existing.healthCriteria, next.healthCriteria) &&
    sameList(existing.rollbackPlan.criteria, next.rollbackPlan.criteria) &&
    sameList(
      existing.taskRefs.map((taskId) => taskId as string),
      next.taskRefs.map((taskId) => taskId as string)
    )
  );
}

/**
 * Everything the operator has to learn at the moment they could still act.
 *
 * The derivation warning is computed from the reader's own policy through
 * `derivesShipGate` rather than from a tier literal here —
 * `attestation_kind_has_no_reader`'s idiom, so it cannot go stale when the policy
 * moves. **The verdict warning is the reader's own sentence, obtained by handing
 * the document about to be written to `releasePlanShortfall`.** Its first draft
 * was a paraphrase attached to partial coverage, and the paraphrase was wrong:
 * it computed uncovered tasks over every task of the change while the gate
 * quantifies over the tasks that *derive* it, so on a mixed-tier task graph the
 * command promised a verdict the gate would not give. A warning that mispredicts
 * the gate teaches operators to ignore warnings.
 */
function releaseWarnings(input: {
  readonly changeId: string;
  readonly tasks: readonly TaskContract[];
  readonly covers: readonly string[];
  readonly taskIds: readonly string[];
  readonly taskgraphPath: string;
  /** The document this run would write, asked of the reader before it is written. */
  readonly document: Release;
  /** What this run does to the record, so no warning claims a write that is not happening. */
  readonly action: "record" | "re-record" | "unchanged";
  readonly previous?: ReleaseSuccess;
}): readonly { readonly code: string; readonly message: string; readonly path?: string }[] {
  const warnings: { code: string; message: string; path?: string }[] = [];
  const derives = derivesShipGate(input.tasks, "release_observation_plan");

  if (derives) {
    // **Lesson 3, in the direction a warning rather than a refusal answers.** The
    // command still records the plan — a partial cover and a `local` rollout are
    // both true governance facts, and refusing would make them unrecordable — but
    // an exit 0 that leaves ship blocked has to say so, in the gate's words, at
    // the moment the operator could still change the flags they typed.
    const shortfall = releasePlanShortfall({
      release: input.document,
      changeId: input.changeId,
      tasks: input.tasks,
      taskIdFor: (task) => taskIdForContractId(task.id)
    });
    if (shortfall !== undefined) {
      warnings.push({
        code: "release_plan_gate_unmet",
        message:
          `This plan is recorded and release_observation_plan will not be satisfied by it. legion ship reports: ` +
          `${shortfall}`,
        path: input.taskgraphPath
      });
    }
  } else {
    // Accepted and written, never refused, on `attestation_kind_has_no_reader`'s
    // rule: the plan is a true governance fact whatever tier the change is, and
    // refusing would make it unrecordable. Succeeding in silence would be worse —
    // the operator would believe a gate had moved.
    warnings.push({
      code: "release_plan_gate_not_derived",
      message:
        `No task of ${input.changeId} derives release_observation_plan, so this plan does not move any ship gate. ` +
        "It is a true governance fact and is preserved; the gate is derived by R3 work, and this change carries none.",
      path: input.taskgraphPath
    });
  }

  const uncovered = input.taskIds.filter((taskId) => !input.covers.includes(taskId));
  if (uncovered.length > 0) {
    warnings.push({
      code: "release_plan_partial_coverage",
      message:
        `This plan observes ${input.covers.length} of ${input.taskIds.length} tasks and leaves ` +
        `${uncovered.join(", ")} uncovered. release_observation_plan quantifies over the tasks of this change that ` +
        "derive it, which may be fewer than these; whether that leaves the gate unsatisfied is reported by " +
        "release_plan_gate_unmet beside this, which is the gate's own answer about this exact plan rather than a " +
        "prediction made here.",
      path: input.taskgraphPath
    });
  }

  // The statuses that can still reach this are the ones a release moved *through*
  // — `staging`, `deployed`, `healthy` — and `superseded`. The four that record a
  // failure or a rollback never get here: `releaseRecordsNegative` refuses the run
  // outright, so this warning is the record of a live plan being replaced and no
  // longer the only notice that a negative was erased.
  const previous = input.previous;
  if (previous !== undefined && previous.document.status !== "requested" && input.action !== "unchanged") {
    warnings.push({
      code: "release_plan_status_replaced",
      message:
        `The release plan already on disk records status "${previous.document.status}". Recording this one replaces ` +
        'it with a fresh plan at status "requested": Legion keeps one release plan per change, so what that document ' +
        "recorded about the release already under way is superseded rather than kept beside it; its bytes remain in " +
        "the artifact's revision chain. A release that failed or was taken back is refused here rather than warned " +
        "about.",
      path: previous.artifactPath as string
    });
  }

  return warnings;
}

function releaseDocument(input: {
  readonly releaseId: ReturnType<typeof releaseIdForChange>;
  readonly projectId: Release["projectId"];
  readonly changeId: Release["changeId"];
  readonly environment: ReleaseEnvironment;
  readonly releaseIntent: ArtifactReference;
  readonly plannedAt: ReturnType<typeof currentUtcTimestamp>;
  readonly covers: readonly string[];
  readonly healthCriteria: readonly string[];
  readonly rollbackStrategy: ReleaseRollbackStrategy;
  readonly rollbackCriteria: readonly string[];
  readonly existing?: ReleaseSuccess;
}): Release {
  const existing = input.existing;
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    // `createdAt` is the instant the plan first existed and survives every
    // re-plan, so nothing downstream reorders when a plan is rewritten.
    createdAt: existing === undefined ? input.plannedAt : existing.document.createdAt,
    updatedAt: input.plannedAt,
    kind: "release",
    id: input.releaseId,
    projectId: input.projectId,
    changeId: input.changeId,
    // `requested`, always. This verb plans; it does not deploy, and a status
    // saying otherwise would be a claim about a release nobody performed. The
    // deferred `legion release observe` is what moves it.
    status: "requested",
    environment: input.environment,
    releaseIntent: input.releaseIntent,
    // Re-parsed rather than cast: `taskIdForContractId` returns a branded id but
    // `--covers` values come from argv, and a cast would put an unvalidated
    // string where the gate's set comparison is the only thing that stops one
    // plan answering for a task it never named.
    taskRefs: input.covers.map((taskId) => taskIdSchema.parse(taskId)),
    // Empty, deliberately, and read by nothing. These are the fields a
    // post-deployment record populates: `approvalRefs` and `evidenceRefs` name
    // what was decided and produced *during* the release, and
    // `rollbackPlan.evidenceRefs` names what a rollback actually produced. A plan
    // has none of that yet, and inventing values would put a claim in a
    // governance artifact that nothing performed.
    approvalRefs: [],
    evidenceRefs: [],
    healthCriteria: [...input.healthCriteria],
    rollbackPlan: {
      strategy: input.rollbackStrategy,
      criteria: [...input.rollbackCriteria],
      evidenceRefs: []
    }
  };
}

function blockedRelease(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>,
  extras: Record<string, unknown> = {}
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      ...extras,
      diagnostics,
      nextAction: action
    },
    ["Release plan blocked.", renderDiagnostics(diagnostics), renderNextAction(action)].join("\n")
  );
}
