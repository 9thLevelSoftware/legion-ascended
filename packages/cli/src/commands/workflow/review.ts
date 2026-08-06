import {
  LEGION_PROJECT_ROOT,
  loadChangeBundle,
  partitionTraceabilityDiagnostics,
  readApproval,
  readEvidenceIndex,
  readTaskGraph,
  repairChangeProposalPins,
  updateChangeAcceptance,
  validateChangeTraceability,
  writeApproval,
  writeEvidenceIndex,
  writeReviewDecision,
  listReviewDecisionsForChange,
  type ApprovalSuccess,
  type EvidenceIndexEntry,
  type ReviewDecisionSuccess,
  type UpdateChangeAcceptanceFailure,
  type UpdateChangeAcceptanceSuccess
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  buildIdempotencyKey,
  type AcceptanceState,
  type Actor,
  type Approval,
  type ArtifactPath,
  type EvidenceId,
  type ReviewDecision,
  type ReviewFinding,
  type ReviewId,
  type TaskContract,
  type UtcTimestamp
} from "@legion/protocol";

import { failure, hasFlag, helpResult, stringOption, success, usageError, type CliContext, type CliResult } from "../../runtime.js";
import {
  describeDecisionOwners,
  requiresHumanApproval,
  resolveApprover,
  PROJECT_MANIFEST_PATH
} from "../../workflow/approver.js";
import { buildExecutionPrompt, writeContextPack } from "../../workflow/context-pack.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { adapterForKind, selectExecutionAdapterKind, writeProjectTextFile, type ExecutionAdapterKind, type ExecutionFinding, type ExecutionResult, type ExecutionReviewVerdicts } from "../../workflow/executor/index.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import {
  absoluteArtifactPath,
  approvalIdForSubject,
  reviewIdForChange,
  reviewRunArtifactPath,
  runArtifactPath,
  runIdForTask,
  taskIdForContractId
} from "../../workflow/run-artifacts.js";
import { latestEvidenceEntries } from "../../workflow/evidence-selection.js";
import { runGuardedExecution } from "../../workflow/guarded-execution.js";
import { phaseChangeIdPrefix } from "../../workflow/phase-compat.js";
import { findLatestWorkflowChangeId, listWorkflowChanges } from "../../workflow/state.js";
import { handleBuildWorkflow } from "./build.js";

const REVIEW_HELP = `legion review [--executor codex|manual|fake] [--dry-run] [--accept] [--approver <id>] [--reject-reason <text>] [--auto] [--max-cycles <n>]

Review collected build evidence. A submitted passing review still requires explicit human acceptance.

--approver names a human decision owner recorded in .legion/project/project.json. It is
required when a task in the change derives the explicit_human_approval risk gate.

--accept also records the change's whole-change acceptance, which legion ship reads:
"accepted" with an approver and clean traceability, "ready" without an approver, and
"blocked" with the defect named when traceability reports one.

Examples:
  legion review --executor fake
  legion review --accept
  legion review --accept --approver dasbl
  legion review --auto --max-cycles 3 --executor codex`;

/**
 * The action an approval carries when it records a review acceptance.
 *
 * The same literal `ship-gates.ts` matches on. Written out in both places rather
 * than shared through a constant because the gate and the writer are two sides
 * of a contract: a shared symbol would let a rename move both at once and leave
 * every approval already on disk unreadable by the gate that reads them.
 */
const REVIEW_ACCEPT_ACTION = "workflow.review.accept";

/**
 * Who asks for the approval, as distinct from who grants it.
 *
 * `requestedBy` records what created the record; `decidedBy` records whose
 * authority the decision carries. Collapsing them onto the human would make
 * `requestedBy.kind === "human"` true of every approval Legion writes, which is
 * a second humanity signal a later gate could read by mistake — and it would be
 * false: the review gate produced the review and is asking a person to accept
 * it.
 */
const REVIEW_GATE_ACTOR = {
  kind: "tool",
  id: "legion-review",
  displayName: "Legion Review Gate"
} as const;

export async function handleReviewWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(REVIEW_HELP);
  }

  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before review readiness can be checked."
  );

  // `--phase N` selects that phase's change instead of the newest one. It was
  // advertised in `commands/review.md` and was a usage error at the boundary;
  // declaring the option without resolving it would only have moved the failure
  // from "unknown option" to "silently reviewed a different change".
  const phaseOption = stringOption(context, "phase")?.trim();
  if (context.args.options.get("phase") === true || phaseOption === "") {
    return usageError("Missing required value for --phase. Example: legion review --phase 3.");
  }
  // Whole value, not a parseInt prefix: `--phase 1.5` and `--phase 1foo` both
  // parse to 1 and would review a change the caller did not name. Checked here
  // rather than inside the resolver so it reaches the caller as a usage error —
  // routing it through `blockedReview` would report malformed CLI input as a
  // workflow prerequisite failure and suggest `legion plan 1`, so automation
  // could not tell bad input from a genuinely missing phase.
  if (phaseOption !== undefined && !/^[1-9]\d*$/.test(phaseOption)) {
    return usageError(`Invalid phase number "${phaseOption}". Use a positive integer.`);
  }
  const latestChange =
    phaseOption === undefined
      ? await findLatestWorkflowChangeId(context.repositoryRoot)
      : await resolvePhaseChange(context.repositoryRoot, phaseOption);
  if (!latestChange.ok) {
    return blockedReview(latestChange.diagnostics, planAction);
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedReview(taskgraph.diagnostics, planAction);
  }

  // Resolved before the dry run returns, and before the evidence index is read.
  // `--auto` reaches `acceptLatestReview` on a clean cycle with no operator step
  // at all, so a check that lived only on the explicit accept would leave the
  // whole fail-open intact behind a different flag — and nothing in the tree
  // runs `--auto` against an R3 change, so it would have shipped green.
  //
  // Ahead of the dry run because a dry run exists to answer "will this command
  // line work", and one that resolved nothing answered yes to
  // `--approver dasbi`, leaving the typo to surface on the accept — after a
  // build and a review had already run. The rule the accept path applies is
  // that an approver on a run that accepts nothing is refused rather than
  // ignored; a dry run is such a run, and it was the one place the rule was not
  // applied.
  const approver = await resolveReviewApprover(context, {
    tasks: taskgraph.document.tasks,
    accepting: hasFlag(context, "accept") || hasFlag(context, "auto"),
    taskgraphPath: taskgraph.artifactPath,
    phase: phaseOption
  });
  if (!approver.ok) return approver.result;

  const taskCount = taskgraph.document.tasks.length;
  if (hasFlag(context, "dry-run")) {
    const action = nextAction(
      "legion review",
      "Review gates are ready to inspect the latest task graph."
    );
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: {
          changeId: latestChange.changeId
        },
        taskgraph: {
          artifactPath: taskgraph.artifactPath,
          taskCount,
          taskIds: taskgraph.document.tasks.map((task) => task.id)
        },
        nextAction: action,
        diagnostics: []
      },
      [
        "Review ready.",
        `Dry run: review gates can inspect ${taskCount} task${taskCount === 1 ? "" : "s"} from ${latestChange.changeId}.`,
        "No review was accepted or recorded.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  const evidence = await readEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!evidence.ok) {
    return blockedReview(
      evidence.diagnostics,
      nextAction("legion build", "Review requires build evidence before it can run."),
      { changeId: latestChange.changeId }
    );
  }

  if (hasFlag(context, "accept")) {
    return acceptLatestReview(context, evidence, approver.approver);
  }

  const rejectReason = stringOption(context, "reject-reason");
  if (rejectReason !== undefined) {
    return rejectLatestReview(context, evidence, rejectReason);
  }

  const selectedExecutor = await selectExecutionAdapterKind(stringOption(context, "executor"));
  if (typeof selectedExecutor !== "string") {
    return blockedReview([selectedExecutor.diagnostic], nextAction("legion review --executor fake", "Choose a supported executor."));
  }

  if (hasFlag(context, "auto")) {
    return runAutoReview(context, {
      executor: selectedExecutor,
      taskgraph,
      evidence,
      ...(approver.approver === undefined ? {} : { approver: approver.approver }),
      ...(phaseOption === undefined ? {} : { phase: phaseOption })
    });
  }

  const submitted = await submitReview(context, {
    executor: selectedExecutor,
    taskgraph,
    evidence
  });
  if (!submitted.ok) {
    return blockedReview(submitted.diagnostics, nextAction("legion build", "Review could not be submitted until build evidence is usable."));
  }

  const clean = submitted.reviews.every((review) => isCleanReview(review.document));
  const findingCount = submitted.reviews.reduce((total, review) => total + review.document.findings.length, 0);
  const firstReview = submitted.reviews[0];
  const action = clean
    ? nextAction(
        scopedCommand("legion review --accept", phaseOption),
        "A passing review was submitted and needs human acceptance."
      )
    : nextAction("legion build", "Address review findings and collect new evidence.");
  return success(
    {
      ok: true,
      status: "submitted",
      ...(firstReview === undefined
        ? {}
        : {
            review: reviewSummary(firstReview)
          }),
      reviews: submitted.reviews.map(reviewSummary),
      evidenceIndex: evidence.artifactPath,
      nextAction: action,
      diagnostics: []
    },
    [
      "Review submitted.",
      `Reviews: ${submitted.reviews.length}.`,
      clean ? "Verdict: pass." : `Findings: ${findingCount}.`,
      renderNextAction(action)
    ].join("\n")
  );
}

/**
 * Keep `--phase N` on a suggested follow-up.
 *
 * A clean review of a non-latest phase advertised a bare `legion review
 * --accept`. Following it resolves the newest change, so the caller would accept
 * a phase other than the one just reviewed — a next action that silently acts on
 * something else is worse than none.
 *
 * Only for commands that accept `--phase`. `legion build` and `legion validate`
 * do not, so scoping their suggestions would advertise an option the verb
 * refuses at the boundary.
 */
export function scopedCommand(command: string, phase: string | undefined): string {
  if (phase === undefined) return command;
  return `${command} --phase ${phase}`;
}

interface SubmitReviewInput {
  readonly executor: ExecutionAdapterKind;
  readonly taskgraph: Awaited<ReturnType<typeof readTaskGraph>> & { readonly ok: true };
  readonly evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true };
  /** Resolved once by the caller, because `--auto` also accepts. */
  readonly approver?: Actor;
  /** The `--phase N` the caller gave, so follow-up actions keep the scope. */
  readonly phase?: string;
}

type ReviewApproverDecision =
  | { readonly ok: true; readonly approver: Actor | undefined }
  | { readonly ok: false; readonly result: CliResult };

/**
 * Turn `--approver <id>` into an actor, and refuse when one is required and
 * absent.
 *
 * Three refusals, deliberately of two different kinds:
 *
 *  - `--approver` with no value, or `--approver` on a run that accepts nothing,
 *    is a `usageError`. The argv is malformed or asks a question this invocation
 *    does not answer, and automation has to be able to tell that from a policy
 *    refusal.
 *  - `--approver` naming somebody the project does not record, or recording as
 *    something other than a human, is `blockedReview`. The argv is well formed;
 *    what failed is the project's own register.
 *  - An R3 change accepted with no `--approver` at all is `blockedReview` too,
 *    for the same reason: the same command line is correct for an R0 change, so
 *    the refusal comes from the risk tier and not from the shape of the input.
 *
 * It refuses *before* anything is written, and that ordering is the whole point
 * rather than tidiness. `acceptLatestReview` writes an accepted revision of
 * every covering review and then rewrites the evidence index, and there is no
 * way back: `cleanSubmittedReviewCoverage` selects only reviews still in
 * `submitted`, so a retry with the right approver fails with `review_not_clean`,
 * and nothing in this release can attach an approval to an already-accepted
 * change. Accepting first and refusing later would strand the change.
 *
 * The manifest is read only when it is going to be used. An R0 accept that
 * names no approver must not acquire a new failure mode from a manifest it never
 * consulted.
 */
async function resolveReviewApprover(
  context: CliContext,
  input: {
    readonly tasks: readonly TaskContract[];
    readonly accepting: boolean;
    readonly taskgraphPath: ArtifactPath;
    readonly phase: string | undefined;
  }
): Promise<ReviewApproverDecision> {
  const raw = stringOption(context, "approver")?.trim();
  if (context.args.options.get("approver") === true || raw === "") {
    return {
      ok: false,
      result: usageError("Missing required value for --approver. Example: legion review --accept --approver dasbl.")
    };
  }

  if (raw !== undefined && !input.accepting) {
    return {
      ok: false,
      result: usageError(
        "legion review reads --approver only with --accept or --auto. An approver on a run that accepts nothing records nobody, so it is refused rather than ignored."
      )
    };
  }

  const required = input.accepting && requiresHumanApproval(input.tasks);

  if (raw === undefined) {
    if (!required) return { ok: true, approver: undefined };
    return {
      ok: false,
      result: blockedReview(
        [
          {
            code: "approver_required",
            message:
              "A task in this change derives the explicit_human_approval risk gate, so accepting its review requires " +
              "--approver <id> naming a human decision owner recorded in .legion/project/project.json. " +
              "No approver is inferred from the environment, from git config, or from a project having only one owner — " +
              "an acceptance recorded against a defaulted identity is not a human approval.",
            path: input.taskgraphPath
          }
        ],
        nextAction(
          scopedCommand("legion review --accept --approver <id>", input.phase),
          "This change's risk tier requires a named human approver."
        )
      )
    };
  }

  const project = await loadWorkflowProject(context);
  if (!project.ok) {
    return {
      ok: false,
      result: blockedReview(
        project.diagnostics,
        nextAction("legion start", "The project manifest records who may approve, and it could not be read.")
      )
    };
  }

  const owners = project.loaded.project.policy.decisionOwners;
  const resolved = resolveApprover({ raw, decisionOwners: owners });
  if (!resolved.ok) {
    return {
      ok: false,
      result: blockedReview(
        resolved.diagnostics,
        nextAction(
          scopedCommand("legion review --accept --approver <id>", input.phase),
          `Name a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. Recorded owners: ${describeDecisionOwners(owners)}.`
        )
      )
    };
  }

  return { ok: true, approver: resolved.approver };
}

async function submitReview(context: CliContext, input: SubmitReviewInput): Promise<{
  readonly ok: true;
  readonly reviews: readonly ReviewDecisionSuccess[];
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  if (input.taskgraph.document.tasks.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "taskgraph_empty",
          message: "The latest taskgraph has no tasks to review.",
          path: input.taskgraph.artifactPath
        }
      ]
    };
  }

  const reviews = await listReviewDecisionsForChange({
    repositoryRoot: context.repositoryRoot,
    changeId: input.taskgraph.document.changeId
  });
  if (!reviews.ok) return { ok: false, diagnostics: reviews.diagnostics };

  const reviewTargets: Array<{
    readonly task: TaskContract;
    readonly taskId: ReturnType<typeof taskIdForContractId>;
    readonly evidenceEntries: readonly EvidenceIndexEntry[];
  }> = [];
  const missingEvidence: unknown[] = [];
  for (const task of input.taskgraph.document.tasks) {
    const taskId = taskIdForContractId(task.id);
    const evidenceEntries = collectedEvidenceEntriesForTask(input.evidence.document.entries, taskId);
    if (evidenceEntries.length === 0) {
      missingEvidence.push({
        code: "review_evidence_missing",
        message: `No collected build evidence exists for ${task.id}. Run legion build before review.`,
        path: input.evidence.artifactPath
      });
      continue;
    }
    reviewTargets.push({ task, taskId, evidenceEntries });
  }

  if (missingEvidence.length > 0) return { ok: false, diagnostics: missingEvidence };

  const submitted: ReviewDecisionSuccess[] = [];
  for (const target of reviewTargets) {
    const { task, taskId, evidenceEntries } = target;
    const reviewId = reviewIdForChange({
      changeId: input.taskgraph.document.changeId,
      sequence: reviews.reviews.length + submitted.length + 1
    });
    const contextPackArtifactPath = reviewRunArtifactPath({ changeId: input.taskgraph.document.changeId, reviewId, fileName: "context-pack.md" });
    const promptArtifactPath = reviewRunArtifactPath({ changeId: input.taskgraph.document.changeId, reviewId, fileName: "executor-prompt.md" });
    const resultArtifactPath = reviewRunArtifactPath({ changeId: input.taskgraph.document.changeId, reviewId, fileName: "executor-result.json" });
    const rawLogArtifactPath = reviewRunArtifactPath({ changeId: input.taskgraph.document.changeId, reviewId, fileName: "executor-raw.log" });
    const redactedLogArtifactPath = reviewRunArtifactPath({ changeId: input.taskgraph.document.changeId, reviewId, fileName: "executor-redacted.log" });
    const contextPackAbsolutePath = absoluteArtifactPath(context.repositoryRoot, contextPackArtifactPath);
    const promptAbsolutePath = absoluteArtifactPath(context.repositoryRoot, promptArtifactPath);
    const resultAbsolutePath = absoluteArtifactPath(context.repositoryRoot, resultArtifactPath);
    const rawLogAbsolutePath = absoluteArtifactPath(context.repositoryRoot, rawLogArtifactPath);
    const redactedLogAbsolutePath = absoluteArtifactPath(context.repositoryRoot, redactedLogArtifactPath);
    const runId = evidenceEntries.at(-1)?.evidence.runId ?? runIdForTask({ taskId, attempt: 1 });

    await writeContextPack({
      repositoryRoot: context.repositoryRoot,
      changeId: input.taskgraph.document.changeId,
      runId: reviewId,
      taskgraph: input.taskgraph,
      task,
      evidenceEntries,
      artifactPath: contextPackArtifactPath,
      absolutePath: contextPackAbsolutePath
    });
    const prompt = buildExecutionPrompt({
      mode: "review",
      contextPackArtifactPath,
      task,
      requiredOutput: reviewResultContract()
    });
    await writeProjectTextFile({
      repositoryRoot: context.repositoryRoot,
      artifactPath: promptArtifactPath,
      text: prompt
    });

    const result = await adapterForKind(input.executor).run({
      repositoryRoot: context.repositoryRoot,
      changeId: input.taskgraph.document.changeId,
      runId,
      task,
      mode: "review",
      executor: input.executor,
      readOnly: true,
      prompt,
      contextPackArtifactPath,
      contextPackAbsolutePath,
      promptArtifactPath,
      promptAbsolutePath,
      resultArtifactPath,
      resultAbsolutePath,
      rawLogArtifactPath,
      rawLogAbsolutePath,
      redactedLogArtifactPath,
      redactedLogAbsolutePath
    });

    const createdAt = currentUtcTimestamp();
    const review = reviewDecisionForExecution({
      reviewId,
      task,
      taskId,
      runId,
      result,
      evidenceEntries,
      evidenceIndexPath: input.evidence.artifactPath,
      createdAt,
      executor: input.executor,
      supersedes: latestSubmittedReviewIdForTask(reviews.reviews, taskId)
    });
    const write = await writeReviewDecision({
      repositoryRoot: context.repositoryRoot,
      document: review,
      expectedRevision: 0,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot)
    });
    if (!write.ok) return { ok: false, diagnostics: write.diagnostics };
    submitted.push(write);
  }

  return { ok: true, reviews: submitted };
}

/**
 * Evidence items recorded by the harness rather than reported by an executor.
 *
 * A human may accept a reviewer's judgement, but not away an observation: if
 * the declared verification commands failed, or the diff left the contract,
 * acceptance is refused regardless of what any review says.
 */
const HARNESS_OBSERVATION_ITEM_IDS = new Set(["declared-verification", "diff-reconciliation"]);

/**
 * Find failed harness observations in each task's current evidence.
 *
 * Scans regardless of bundle status, because `cleanSubmittedReviewCoverage`
 * skips non-collected bundles — so a mixed index would otherwise be accepted on
 * the strength of a passing bundle alone and the failure would vanish by
 * omission.
 *
 * But only the latest attempt per task counts. The index retains every attempt,
 * so scanning all of them would make one historical failure permanent: the
 * diagnostic tells the operator to rerun, and rerunning could never clear it.
 */
function failedObservations(
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true }
): readonly unknown[] {
  const diagnostics: unknown[] = [];
  for (const entry of latestEvidenceEntries(evidence.document.entries)) {
    for (const item of entry.evidence.items) {
      if (!HARNESS_OBSERVATION_ITEM_IDS.has(item.id)) continue;
      if (item.verdict !== "fail") continue;
      diagnostics.push({
        code: "unresolved_failed_observation",
        message: `Evidence ${entry.evidence.id} records a failed ${item.id}. Rerun build until it passes; acceptance cannot override a harness observation.`,
        path: evidence.artifactPath
      });
    }
  }
  return diagnostics;
}

async function acceptLatestReview(
  context: CliContext,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true },
  approver: Actor | undefined
): Promise<CliResult> {
  const failed = failedObservations(evidence);
  if (failed.length > 0) {
    return blockedReview(
      failed,
      nextAction("legion build", "Build evidence contains a failed harness observation and cannot be accepted.")
    );
  }

  const coverage = await cleanSubmittedReviewCoverage(context.repositoryRoot, evidence);
  if (!coverage.ok) {
    return blockedReview(coverage.diagnostics, nextAction("legion review", "Submit a passing review for every collected task evidence bundle before accepting."));
  }

  const acceptedAt = currentUtcTimestamp();
  const acceptedReviews: ReviewDecisionSuccess[] = [];
  const acceptedByTaskId = new Map<string, ReviewDecisionSuccess>();
  for (const review of coverage.reviews) {
    const submittedAt = review.document.submittedAt ?? acceptedAt;
    const accepted = await writeReviewDecision({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: review.revision.revision,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document: {
        ...review.document,
        status: "accepted",
        updatedAt: acceptedAt,
        submittedAt,
        // The accept transition's own actor, in the same revisioned write as the
        // transition, so the two cannot end up in different revisions of the
        // artifact. `reviewer` is untouched: the tool did produce this review,
        // and overwriting it with the approver would replace one true statement
        // with another and lose the first.
        //
        // Both fields or neither — the schema refuses a half-written transition,
        // because a reader of `acceptedAt` alone has to guess whether the actor
        // was never recorded or was recorded and lost, and those guesses lead to
        // opposite verdicts.
        ...(approver === undefined ? {} : { acceptedBy: approver, acceptedAt })
      }
    });
    if (!accepted.ok) {
      return blockedReview(accepted.diagnostics, nextAction("legion review", "Review acceptance could not be written."));
    }
    acceptedReviews.push(accepted);
    if (accepted.document.taskId !== undefined) acceptedByTaskId.set(accepted.document.taskId, accepted);
  }

  const evidenceWrite = await writeEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: evidence.document.changeId,
    entries: evidence.document.entries.map((entry) => {
      if (entry.evidence.status !== "collected") return entry;
      if (entry.evidence.taskId === undefined) return entry;
      const acceptedReview = acceptedByTaskId.get(entry.evidence.taskId);
      if (acceptedReview === undefined) return entry;
      return {
        ...entry,
        acceptance: {
          status: "accepted",
          reviewId: acceptedReview.document.id,
          acceptedAt
        }
      };
    }),
    artifactInputs: evidence.document.artifactManifest.inputs,
    expectedRevision: evidence.document.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!evidenceWrite.ok) {
    return blockedReview(evidenceWrite.diagnostics, nextAction("legion validate", "Evidence acceptance could not be written."));
  }

  // Written last, after the reviews and the evidence index. A crash before this
  // point leaves reviews accepted with no approval, which the human-approval
  // gate reads as `unevaluable` and ship blocks on — the partial state is always
  // less approved, never more. The reverse order would leave a granted approval
  // standing for an acceptance that never happened.
  const approvals = await recordReviewAcceptApprovals(context, {
    reviews: acceptedReviews,
    approver,
    decidedAt: acceptedAt
  });
  if (!approvals.ok) {
    return blockedReview(
      approvals.diagnostics,
      nextAction(
        "legion ship",
        "The reviews and evidence were accepted, but no approval was recorded. Nothing was rolled back: legion ship " +
          "will report explicit_human_approval unevaluable for this change until an approval exists."
      )
    );
  }

  // Last of all, after the approvals, and that placement is the same argument
  // the comment above makes. Whole-change acceptance is the strongest claim this
  // command records — stronger than a per-task approval — so a crash before it
  // leaves the change *less* accepted, never more. It also has to come after the
  // evidence-index write for a mechanical reason: `validateChangeTraceability`
  // reads disk, and `missing_accepted_evidence` fires on every R2 requirement
  // until the acceptance flip has landed. Run before it, the promotion would
  // write `blocked` on every single accept — a defect that would look exactly
  // like the gate working.
  const promotion = await promoteChangeAcceptance(context, {
    changeId: evidence.document.changeId,
    approver,
    acceptedAt
  });
  if (!promotion.ok) {
    // **Two failures, two true sentences, two different commands.** One message
    // used to cover both, and in the branch that can actually produce it — the
    // re-point failing *after* the proposal write landed — every clause of it
    // was false. It said the acceptance could not be written when the bundle on
    // disk already recorded it; it said `legion ship` would report
    // `whole_change_acceptance_evidence` unevaluable when ship never reaches gate
    // evaluation at all, because it flattens the two stale pins to
    // `change_traceability_broken` first; and it sent the operator to `legion
    // validate`, which on that exact repository exits 0 with
    // `{"status":"valid","diagnostics":[]}`. Being told the wrong fact and sent
    // to a command that confirms nothing is wrong is worse than a bare stack
    // trace, because it ends the investigation.
    return promotion.written === undefined
      ? blockedReview(
          promotion.diagnostics,
          nextAction(
            "legion dev change validate",
            "The reviews, evidence and approvals were accepted, and the change's whole-change acceptance was not " +
              "written — nothing about it reached disk. legion ship will report whole_change_acceptance_evidence " +
              "unevaluable for this change until it is."
          )
        )
      : blockedReview(
          promotion.diagnostics,
          nextAction(
            `legion dev change repoint ${evidence.document.changeId}`,
            `The whole-change acceptance WAS written: ${promotion.written.artifactPath} records ` +
              `${promotion.written.acceptance.status} at revision ${promotion.written.revision.revision}. What did not ` +
              "land is the re-point of the artifact inputs that pin it, so legion ship reports " +
              "change_traceability_broken and never reaches the gate. That command re-points them; it is idempotent " +
              "and writes nothing if they are already current."
          )
        );
  }

  const action = nextAction("legion ship", "Accepted review and evidence are ready for the ship readiness gate.");
  return success(
    {
      ok: true,
      status: "accepted",
      ...(acceptedReviews[0] === undefined ? {} : { review: reviewSummary(acceptedReviews[0]) }),
      reviews: acceptedReviews.map(reviewSummary),
      // Spread conditionally so a run that recorded no approver produces the
      // payload it produced before this release, key for key.
      ...(approvals.approvals.length === 0 ? {} : { approvals: approvals.approvals.map(approvalSummary) }),
      evidenceIndex: {
        artifactPath: evidenceWrite.artifactPath,
        acceptedEntries: evidenceWrite.document.entries.filter((entry) => entry.acceptance.status === "accepted").length
      },
      acceptance: acceptanceSummary(promotion.result),
      nextAction: action,
      diagnostics: []
    },
    [
      "Review accepted.",
      `Evidence accepted: ${evidenceWrite.artifactPath}.`,
      `Change acceptance: ${promotion.result.acceptance.status}.`,
      renderNextAction(action)
    ].join("\n")
  );
}

/** What a host needs to see which whole-change decision this run recorded. */
function acceptanceSummary(promotion: UpdateChangeAcceptanceSuccess): Record<string, unknown> {
  return {
    artifactPath: promotion.artifactPath,
    status: promotion.acceptance.status,
    revision: promotion.revision.revision,
    ...(promotion.acceptance.acceptedBy === undefined ? {} : { acceptedBy: promotion.acceptance.acceptedBy }),
    ...(promotion.acceptance.acceptedAt === undefined ? {} : { acceptedAt: promotion.acceptance.acceptedAt }),
    ...(promotion.acceptance.reason === undefined ? {} : { reason: promotion.acceptance.reason }),
    ...(promotion.repointed.length === 0 ? {} : { repointed: promotion.repointed })
  };
}

/** The subset of a traceability diagnostic a recorded reason can carry. */
interface TraceabilityDefect {
  readonly code: string;
  readonly message: string;
  readonly source?: { readonly path?: string };
}

/**
 * What a `blocked` acceptance records about why.
 *
 * `acceptanceReasonSchema` is 1..2048 characters and required for `blocked`, so
 * the reason has to be built rather than borrowed. Three properties matter:
 *
 *  - **Deterministic.** Sorted, capped at three, hard-truncated. Identical runs
 *    must produce identical bytes, or re-running the same command would rewrite
 *    `change.yaml` and re-point two artifact-input lists for no reason at all.
 *  - **Named.** The code and the path, not just the message: an operator reading
 *    this in a blocked ship's gate diagnostic has no other route to which
 *    artifact is wrong.
 *  - **Bounded.** `validateChangeTraceability` also returns loader failures with
 *    no report at all, so an unbounded splice of everything it returned would
 *    put unrelated codes into a field that reads as a verdict.
 */
function blockedAcceptanceReason(diagnostics: readonly TraceabilityDefect[]): string {
  const named = [...diagnostics]
    .map((diagnostic) => `${diagnostic.code} (${diagnostic.source?.path ?? "unknown"}): ${diagnostic.message}`)
    .sort((left, right) => left.localeCompare(right));
  const shown = named.slice(0, 3);
  const remainder = named.length > shown.length ? ` (+${named.length - shown.length} more)` : "";
  const reason =
    `Change traceability reported ${named.length} blocking defect${named.length === 1 ? "" : "s"} at legion review ` +
    `--accept: ${shown.join(" | ")}${remainder}`;
  return reason.length <= 2_048 ? reason : `${reason.slice(0, 2_045)}...`;
}

/**
 * Promote `change.acceptance` from the `not_ready` that `createChangeBundle`
 * writes and nothing ever moved.
 *
 * Three outcomes, and the middle one is the point of the whole gate:
 *
 *  - Traceability reports a blocking defect ⇒ `{status: "blocked", reason}`.
 *    Written rather than skipped. By the time this runs the reviews, the
 *    evidence index and the approvals are already on disk, so "refuse the
 *    accept" is not available — only "refuse the promotion" — and refusing it
 *    silently leaves `not_ready`, which `legion ship` reports as "nobody
 *    decided" with no mention of the defect. `blocked` puts the reason where
 *    ship can print it, and the verdict is re-derived from scratch on the next
 *    accept, so repairing the defect and re-accepting replaces the record.
 *  - Clean and `--approver` resolved ⇒ `{status: "accepted", acceptedAt,
 *    acceptedBy: approver.id}`. `acceptedBy` is `approver.id`, a **string**:
 *    `acceptanceActorSchema` is `z.string().min(1).max(128)` while
 *    `reviewDecision.acceptedBy` and `approval.decidedBy` are both `Actor`
 *    objects — three same-named fields, two types, one code path.
 *  - Clean and no approver ⇒ `{status: "ready"}` and nothing else. Every task's
 *    evidence is accepted and no human signed off on the change as a whole,
 *    which is honestly short of accepted. All-or-nothing on `acceptedAt` and
 *    `acceptedBy`, on the rule the review write states: the `ready` arm *permits*
 *    both and requires neither, so a half-filled one parses cleanly and reads as
 *    an abandoned sign-off.
 *
 * `acceptedAt` is the instant computed once at the top of the accept, not a
 * fresh clock reading. It is already stamped on the reviews, on every promoted
 * evidence entry and on the approvals, so the whole-change sign-off is *equal*
 * to `max(evidence acceptedAt)` — which is why the gate compares with `>=`. A
 * second clock reading inside one logical transaction would differ by
 * milliseconds in a direction nothing controls, and could produce an `accepted`
 * the gate immediately calls stale.
 *
 * **The traceability verdict is partitioned with the legacy allowance on,
 * unconditionally.** `legion review` has no `--allow-legacy-evidence` flag, so a
 * raw `traceability.ok` would write a sticky `{status: "blocked"}` into the
 * bundle on a repository whose evidence predates requirement and oracle linking
 * — and `legion ship --allow-legacy-evidence`, the allowance the operator
 * explicitly opted into, would then read a hard `unsatisfied` no flag can undo.
 * `orphan_evidence` is the one diagnostic whose interpretation is an operator
 * judgement, and this command cannot hear it; recording a verdict on a judgement
 * nobody made is worse than leaving the decision with ship, which already owns
 * the flag.
 */
async function promoteChangeAcceptance(
  context: CliContext,
  input: {
    readonly changeId: string;
    readonly approver: Actor | undefined;
    readonly acceptedAt: UtcTimestamp;
  }
): Promise<
  | { readonly ok: true; readonly result: UpdateChangeAcceptanceSuccess }
  | {
      readonly ok: false;
      readonly diagnostics: readonly unknown[];
      readonly written?: UpdateChangeAcceptanceFailure["written"];
    }
> {
  // **Repair before judging.** A previous accept that tore between the proposal
  // rename and the re-point leaves the pins naming a superseded proposal, and
  // `validateChangeTraceability` reports that as `stale_revision_reference` — so
  // running the verdict first would record a `blocked` about a defect this call
  // is about to fix, and every retry would record a fresh false block while the
  // change stayed unshippable. The repair is idempotent and writes nothing on a
  // healthy change, so the common path pays two reads for it.
  const repaired = await repairChangeProposalPins({
    repositoryRoot: context.repositoryRoot,
    changeId: input.changeId,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!repaired.ok) return { ok: false, diagnostics: repaired.diagnostics };

  const bundle = await loadChangeBundle({ repositoryRoot: context.repositoryRoot, changeId: input.changeId });
  if (!bundle.ok) return { ok: false, diagnostics: bundle.diagnostics };

  const traceability = await validateChangeTraceability({
    repositoryRoot: context.repositoryRoot,
    changeId: input.changeId
  });
  const blocking = traceability.ok
    ? []
    : partitionTraceabilityDiagnostics(traceability.diagnostics, { allowLegacyEvidence: true }).blocking;

  const acceptance: AcceptanceState =
    blocking.length > 0
      ? { status: "blocked", reason: blockedAcceptanceReason(blocking) }
      : input.approver === undefined
        ? { status: "ready" }
        : { status: "accepted", acceptedAt: input.acceptedAt, acceptedBy: input.approver.id };

  const written = await updateChangeAcceptance({
    repositoryRoot: context.repositoryRoot,
    changeId: input.changeId,
    acceptance,
    expectedRevision: bundle.bundle.revision,
    updatedAt: input.acceptedAt,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!written.ok) {
    return {
      ok: false,
      diagnostics: written.diagnostics,
      ...(written.written === undefined ? {} : { written: written.written })
    };
  }
  return { ok: true, result: written };
}

/**
 * Record one granted approval per task whose review was just accepted.
 *
 * **One approval per task, not per review and not per change.** The three
 * cardinalities are not interchangeable and each rules out a specific defect:
 *
 *  - Per *review* mints a new document every cycle, so a grant from cycle 1
 *    outlives cycle 2 and a gate asking "is a review-acceptance approval granted
 *    here" answers yes from a record about work that has since been replaced.
 *  - Per *change* would need an idempotency key naming a task and a run —
 *    `idempotencyKeySchema` requires both, structurally — and a change-wide
 *    decision has neither, so the key would have to borrow one task's ids and
 *    assert a pairing that is not a fact.
 *  - Per *task* has an honest key (the task and run the accepted review already
 *    names), matches the granularity of the gate that reads it, which is derived
 *    per task, and rewrites the same document on every later accept of the same
 *    task. Re-deciding is a new revision of one artifact rather than a second
 *    artifact, so a revocation cannot be lost while its grant survives.
 *
 * The existing document is read before writing so the write is an update at the
 * revision found rather than a create at revision 0. That is not an
 * optimisation: creating over an unread existing approval is the one way to
 * silently replace a revocation with a fresh grant, so an approval that is
 * present and unreadable blocks instead.
 *
 * `artifacts` is deliberately left unset. The field exists for pinning the bytes
 * a decision was made against, and the honest candidate here — the accepted
 * review file — is rewritten by a later `--reject`, so pinning it would turn
 * legitimate supersession into pin drift. The accepted review's content hash is
 * still recorded, as the idempotency key's target hash, where it identifies the
 * operation rather than claiming an invariant.
 */
async function recordReviewAcceptApprovals(
  context: CliContext,
  input: {
    readonly reviews: readonly ReviewDecisionSuccess[];
    readonly approver: Actor | undefined;
    readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
  }
): Promise<
  | { readonly ok: true; readonly approvals: readonly ApprovalSuccess[] }
  | { readonly ok: false; readonly diagnostics: readonly unknown[] }
> {
  if (input.approver === undefined) return { ok: true, approvals: [] };

  const written: ApprovalSuccess[] = [];
  for (const review of input.reviews) {
    const taskId = review.document.taskId;
    const runId = review.document.runId;
    if (taskId === undefined || runId === undefined) {
      // Refused rather than skipped. A skip would leave the change one approval
      // short and report success, and the gate would read the shortfall as "no
      // approval names this task" — absence, when what actually happened is
      // that Legion could not name what it was approving.
      return {
        ok: false,
        diagnostics: [
          {
            code: "approval_subject_missing",
            message: `Review ${review.document.id} names no ${taskId === undefined ? "task" : "run"}, so an approval recording its acceptance cannot say what was approved.`,
            path: review.artifactPath
          }
        ]
      };
    }

    const approvalId = approvalIdForSubject({
      changeId: review.document.changeId,
      action: REVIEW_ACCEPT_ACTION,
      subject: { kind: "task", id: taskId }
    });
    const existing = await readApproval({
      repositoryRoot: context.repositoryRoot,
      changeId: review.document.changeId,
      approvalId
    });
    if (!existing.ok && existing.status !== "not_found") {
      return { ok: false, diagnostics: existing.diagnostics };
    }

    // `createdAt` and `requestedAt` are the request instant and survive every
    // re-decision, so the listing's sort order does not move when an approval is
    // re-granted. `decidedAt` is the instant of *this* decision, which is what
    // an ordering gate compares against a run's start.
    const requestedAt = existing.ok ? existing.document.requestedAt : input.decidedAt;
    const document: Approval = {
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt: existing.ok ? existing.document.createdAt : input.decidedAt,
      updatedAt: input.decidedAt,
      kind: "approval",
      id: approvalId,
      projectId: review.document.projectId,
      changeId: review.document.changeId,
      taskId,
      runId,
      requestedBy: REVIEW_GATE_ACTOR,
      requestedAt,
      scope: {
        // S1: a local idempotent write of Legion's own acceptance artifacts.
        // Not S4 — nothing here deploys, deletes or rotates anything, and
        // stamping the highest class on a review acceptance would make the
        // classification meaningless the first time something really does.
        effectClass: "S1",
        action: REVIEW_ACCEPT_ACTION,
        targets: [
          { kind: "task", id: taskId },
          { kind: "review", id: review.document.id },
          { kind: "change", id: review.document.changeId }
        ]
      },
      idempotencyKey: buildIdempotencyKey({
        projectId: review.document.projectId,
        changeId: review.document.changeId,
        taskId,
        runId,
        effectKind: REVIEW_ACCEPT_ACTION,
        // The accepted review's own content hash, so the key names the exact
        // bytes accepted: re-running the same accept is the same operation, and
        // accepting a new review cycle is a different one.
        targetHash: review.reference.sha256
      }),
      status: "granted",
      decidedBy: input.approver,
      decidedAt: input.decidedAt,
      decisionReason: `${input.approver.id} accepted review ${review.document.id} for task ${taskId} via legion review --accept.`
    };

    const write = await writeApproval({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: existing.ok ? existing.revision.revision : 0,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document
    });
    if (!write.ok) return { ok: false, diagnostics: write.diagnostics };
    written.push(write);
  }

  return { ok: true, approvals: written };
}

/** What a host needs to show that an acceptance was approved, and by whom. */
function approvalSummary(approval: ApprovalSuccess): Record<string, unknown> {
  return {
    approvalId: approval.document.id,
    artifactPath: approval.artifactPath,
    status: approval.document.status,
    action: approval.document.scope.action,
    taskId: approval.document.taskId,
    decidedBy: approval.document.decidedBy,
    decidedAt: approval.document.decidedAt
  };
}

async function rejectLatestReview(
  context: CliContext,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true },
  reason: string
): Promise<CliResult> {
  const latest = await latestSubmittedReviews(context.repositoryRoot, evidence.document.changeId);
  if (!latest.ok) {
    return blockedReview(latest.diagnostics, nextAction("legion review", "Submit a review before rejecting it."));
  }
  const rejectedAt = currentUtcTimestamp();
  const rejectedReviews: ReviewDecisionSuccess[] = [];
  const rejectedByTaskId = new Map<string, ReviewDecisionSuccess>();
  for (const review of latest.reviews) {
    const submittedAt = review.document.submittedAt ?? rejectedAt;
    const rejected = await writeReviewDecision({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: review.revision.revision,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document: {
        ...review.document,
        status: "rejected",
        updatedAt: rejectedAt,
        submittedAt,
        metadata: {
          ...(review.document.metadata ?? {}),
          annotations: {
            ...(review.document.metadata?.annotations ?? {}),
            reject_reason: reason
          }
        }
      }
    });
    if (!rejected.ok) {
      return blockedReview(rejected.diagnostics, nextAction("legion review", "Review rejection could not be written."));
    }
    rejectedReviews.push(rejected);
    if (rejected.document.taskId !== undefined) rejectedByTaskId.set(rejected.document.taskId, rejected);
  }

  const evidenceWrite = await writeEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: evidence.document.changeId,
    entries: evidence.document.entries.map((entry) => ({
      ...entry,
      acceptance: {
        status: "rejected",
        reviewId: entry.evidence.taskId === undefined
          ? rejectedReviews[0]?.document.id
          : rejectedByTaskId.get(entry.evidence.taskId)?.document.id ?? rejectedReviews[0]?.document.id,
        reason
      }
    })),
    artifactInputs: evidence.document.artifactManifest.inputs,
    expectedRevision: evidence.document.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!evidenceWrite.ok) {
    return blockedReview(evidenceWrite.diagnostics, nextAction("legion validate", "Evidence rejection could not be written."));
  }

  // A fail-open this release would otherwise open. Before whole-change
  // acceptance existed, rejecting a review rewrote every evidence entry to
  // `rejected` and touched nothing else. After it, the sequence accept → reject
  // would leave `change.acceptance.status === "accepted"` standing on disk with
  // an `acceptedAt` later than any *accepted* evidence — because a reject leaves
  // none — so the sign-off would outlive the evidence it claimed to cover. The
  // gate closes that from its own side by reading each task's latest evidence
  // acceptance, and this closes it from the artifact's side, because a gate that
  // is right about a document that lies is one refactor away from being wrong.
  //
  // `not_ready`, not `rejected`: the *review* was rejected, not the change.
  // `not_ready` with the reason recorded is the true statement, and it is what
  // the gate reports as "nobody has decided", which is also true. It blocks ship
  // exactly as an `unsatisfied` would.
  //
  // A bundle that will not load is a `blockedReview` rather than a silent skip:
  // a skip is precisely the state described above, standing on disk with the
  // command reporting success.
  const bundle = await loadChangeBundle({
    repositoryRoot: context.repositoryRoot,
    changeId: evidence.document.changeId
  });
  if (!bundle.ok) {
    return blockedReview(
      bundle.diagnostics,
      nextAction(
        "legion dev change validate",
        "The evidence was rejected, but the change bundle could not be read, so its whole-change acceptance still " +
          "stands. legion ship would report whole_change_acceptance_evidence over rejected evidence until this is repaired."
      )
    );
  }

  // **The demotion is skipped when there is nothing to demote, and that guard is
  // the whole reason a reject is not a second copy of the accept's tear.**
  // `updateChangeAcceptance` compares the whole acceptance object, deliberately —
  // see its docblock — so `{status:"not_ready"}` and
  // `{status:"not_ready", reason}` are different objects and the write always
  // fired. That made `legion review --reject-reason` rewrite the bundle and
  // re-point both pinned artifacts on **every** invocation, including on a change
  // nobody had ever accepted, which is every reject before this release. It
  // inherited the accept's tear window for no gain: rejecting a `not_ready`
  // change to `not_ready` records nothing a reader can act on, and a failed
  // re-point in the middle of it left a never-accepted change unshippable.
  //
  // Status, not the whole object, and only here. What the demotion exists to
  // prevent is an `accepted` or `ready` sign-off outliving the evidence it
  // covered; a change already recorded as undecided cannot be that. The accept's
  // idempotence check stays object-wide, because there a stale `acceptedAt` under
  // an unchanged `status` is exactly the fail-open being closed.
  const priorStatus = bundle.bundle.change.acceptance.status;
  const demoted =
    priorStatus === "not_ready"
      ? undefined
      : await updateChangeAcceptance({
          repositoryRoot: context.repositoryRoot,
          changeId: evidence.document.changeId,
          expectedRevision: bundle.bundle.revision,
          updatedAt: rejectedAt,
          baseGitSha: resolveBaseGitSha(context.repositoryRoot),
          acceptance: {
            status: "not_ready",
            reason: `Review ${rejectedReviews[0]?.document.id ?? "(unnamed)"} was rejected at ${rejectedAt}: ${reason}`
          }
        });
  if (demoted !== undefined && !demoted.ok) {
    return blockedReview(
      demoted.diagnostics,
      demoted.written === undefined
        ? nextAction(
            "legion dev change validate",
            "The evidence was rejected, and this change's whole-change acceptance could not be demoted alongside it. " +
              "Nothing about the demotion reached disk, so the earlier sign-off still stands over rejected evidence."
          )
        : nextAction(
            `legion dev change repoint ${evidence.document.changeId}`,
            `The demotion WAS written: ${demoted.written.artifactPath} records ${demoted.written.acceptance.status} at ` +
              `revision ${demoted.written.revision.revision}. What did not land is the re-point of the artifact inputs ` +
              "that pin it. That command re-points them; it is idempotent and writes nothing if they are already current."
          )
    );
  }

  const action = nextAction("legion build", "Rejected evidence needs a new build run.");
  return success(
    {
      ok: true,
      status: "rejected",
      ...(rejectedReviews[0] === undefined ? {} : { review: reviewSummary(rejectedReviews[0]) }),
      reviews: rejectedReviews.map(reviewSummary),
      // Absent when the change was already undecided and nothing was written, so
      // the payload of a reject on a never-accepted change is key-for-key what it
      // was before whole-change acceptance existed.
      ...(demoted === undefined ? {} : { acceptance: acceptanceSummary(demoted) }),
      nextAction: action,
      diagnostics: []
    },
    [
      "Review rejected.",
      renderNextAction(action)
    ].join("\n")
  );
}

async function runAutoReview(
  context: CliContext,
  input: SubmitReviewInput
): Promise<CliResult> {
  const maxCycles = parseMaxCycles(stringOption(context, "max-cycles"));
  if (typeof maxCycles !== "number") return maxCycles;

  let currentEvidence = input.evidence;
  let latestReviews: readonly ReviewDecisionSuccess[] = [];
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const submitted = await submitReview(context, {
      ...input,
      evidence: currentEvidence
    });
    if (!submitted.ok) {
      return blockedReview(
        submitted.diagnostics,
        nextAction(scopedCommand("legion review", input.phase), "Auto review could not submit a review decision.")
      );
    }
    latestReviews = submitted.reviews;
    if (submitted.reviews.every((review) => isCleanReview(review.document))) {
      const refreshedEvidence = await readEvidenceIndex({
        repositoryRoot: context.repositoryRoot,
        changeId: currentEvidence.document.changeId
      });
      if (!refreshedEvidence.ok) {
        return blockedReview(refreshedEvidence.diagnostics, nextAction("legion validate", "Evidence index could not be reloaded for acceptance."));
      }
      // How many cycles it took, not just that it ended clean. A panel showing
      // "accepted" without this cannot distinguish a first-pass review from one
      // that needed two fix rounds, and the difference is the whole point of
      // running with --auto.
      return withCycleState(await acceptLatestReview(context, refreshedEvidence, input.approver), {
        cycle,
        maxCycles,
        outcome: "clean"
      });
    }

    if (cycle < maxCycles) {
      const tasksByTaskId = taskByTaskId(input.taskgraph.document.tasks);
      for (const review of submitted.reviews.filter((candidate) => !isCleanReview(candidate.document))) {
        if (review.document.taskId === undefined) continue;
        const task = tasksByTaskId.get(review.document.taskId);
        if (task === undefined) continue;
        await runAutoFixCycle(context, input.executor, input.taskgraph.document.changeId, task, cycle);
      }
      const refreshedEvidence = await refreshBuildEvidenceAfterAutoFix(context, input.executor, input.taskgraph.document.changeId);
      if (!refreshedEvidence.ok) {
        return blockedReview(refreshedEvidence.diagnostics, nextAction("legion build", "Auto fix completed, but build evidence could not be refreshed."));
      }
      currentEvidence = refreshedEvidence.evidence;
    }
  }

  return withCycleState(
    blockedReview(
      [
        {
          code: "auto_review_not_clean",
          message: `Auto review reached ${maxCycles} cycle${maxCycles === 1 ? "" : "s"} without a clean review.`,
          path: latestReviews.at(-1)?.artifactPath
        }
      ],
      // `legion build` is deliberately not scoped: it has no `--phase` flag, so
      // suggesting one would advertise an option the verb refuses. The follow-up
      // review is scoped instead, which is the step that would otherwise act on
      // the wrong change.
      nextAction(
        "legion build",
        input.phase === undefined
          ? "Address review findings manually and rerun review."
          : `Address review findings manually, then rerun ${scopedCommand("legion review", input.phase)}.`
      )
    ),
    { cycle: maxCycles, maxCycles, outcome: "exhausted" },
    // The findings that survived the last cycle are what a caller has to act
    // on, and the blocked payload otherwise names only the artifact path.
    latestReviews.map(reviewSummary)
  );
}

interface ReviewCycleState {
  readonly cycle: number;
  readonly maxCycles: number;
  readonly outcome: "clean" | "exhausted";
}

/**
 * Attach the auto-review cycle state to a result payload.
 *
 * `--auto --max-cycles n` ran a fix loop whose progress reached the caller only
 * as prose in a diagnostic message. A host driving the loop could not tell
 * which cycle produced the verdict, or how much budget was left.
 */
function withCycleState(
  result: CliResult,
  cycles: ReviewCycleState,
  reviews?: readonly Record<string, unknown>[]
): CliResult {
  return {
    ...result,
    payload: {
      ...result.payload,
      cycles,
      ...(reviews === undefined ? {} : { reviews })
    }
  };
}

async function runAutoFixCycle(
  context: CliContext,
  executor: ExecutionAdapterKind,
  changeId: TaskContract["changeId"],
  task: TaskContract,
  cycle: number
): Promise<void> {
  const taskId = taskIdForContractId(task.id);
  const runId = runIdForTask({ taskId, attempt: 100 + cycle });
  const contextPackArtifactPath = runArtifactPath({ changeId, runId, fileName: "context-pack.md" });
  const promptArtifactPath = runArtifactPath({ changeId, runId, fileName: "executor-prompt.md" });
  const resultArtifactPath = runArtifactPath({ changeId, runId, fileName: "executor-result.json" });
  const rawLogArtifactPath = runArtifactPath({ changeId, runId, fileName: "executor-raw.log" });
  const redactedLogArtifactPath = runArtifactPath({ changeId, runId, fileName: "executor-redacted.log" });
  const prompt = buildExecutionPrompt({
    mode: "fix",
    contextPackArtifactPath,
    task,
    requiredOutput: reviewResultContract()
  });
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: contextPackArtifactPath,
    text: [
      `# Auto Fix Context ${cycle}`,
      "",
      `Change: ${changeId}`,
      `Task: ${task.id}`,
      "",
      "The previous review reported findings. Apply the smallest scoped fix and report JSON."
    ].join("\n")
  });
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: promptArtifactPath,
    text: prompt
  });
  // The fix executor writes, so it is subject to the same reconciliation the
  // build path applies. Without this the auto-review loop is an unguarded door
  // into the repository: the fix run could rewrite
  // .legion/project/changes/<id>/taskgraph.json, and the refresh build that
  // follows snapshots the tree *before* its own dispatch — so the tampering is
  // already present, gets attributed to no one, and review and ship then load
  // the altered contract.
  const guarded = await runGuardedExecution({
    repositoryRoot: context.repositoryRoot,
    task,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot),
    harnessPaths: [`.legion/project/changes/${changeId}/runs/${runId}`],
    run: () =>
      adapterForKind(executor).run({
        repositoryRoot: context.repositoryRoot,
        changeId,
        runId,
        task,
        mode: "fix",
        executor,
        readOnly: false,
        prompt,
        contextPackArtifactPath,
        contextPackAbsolutePath: absoluteArtifactPath(context.repositoryRoot, contextPackArtifactPath),
        promptArtifactPath,
        promptAbsolutePath: absoluteArtifactPath(context.repositoryRoot, promptArtifactPath),
        resultArtifactPath,
        resultAbsolutePath: absoluteArtifactPath(context.repositoryRoot, resultArtifactPath),
        rawLogArtifactPath,
        rawLogAbsolutePath: absoluteArtifactPath(context.repositoryRoot, rawLogArtifactPath),
        redactedLogArtifactPath,
        redactedLogAbsolutePath: absoluteArtifactPath(context.repositoryRoot, redactedLogArtifactPath)
      })
  });

  if (!guarded.inContract) {
    throw new AutoFixScopeError(
      guarded.blockedReason ?? "The auto-fix run left the task contract."
    );
  }
}

/** Raised when an auto-fix run writes outside the contract it was fixing. */
export class AutoFixScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoFixScopeError";
  }
}

export function reviewDecisionForExecution(input: {
  readonly reviewId: ReviewId;
  readonly task: TaskContract;
  readonly taskId: ReturnType<typeof taskIdForContractId>;
  readonly runId: ReturnType<typeof runIdForTask>;
  readonly result: ExecutionResult;
  readonly evidenceEntries: readonly EvidenceIndexEntry[];
  readonly evidenceIndexPath: ArtifactPath;
  readonly createdAt: ReturnType<typeof currentUtcTimestamp>;
  readonly executor: ExecutionAdapterKind;
  readonly supersedes: readonly ReviewId[];
}): ReviewDecision {
  const evidenceRefs = input.evidenceEntries.map((entry) => entry.evidence.id);
  const findings = input.result.findings.map((finding, index) => reviewFindingForExecution(finding, evidenceRefs, index));
  const fallbackVerdict = input.result.ok && !hasBlockingFinding(findings) ? "pass" : "fail";
  const verdicts: ExecutionReviewVerdicts = input.result.ok && input.result.reviewVerdicts !== undefined ? input.result.reviewVerdicts : {
    specification: fallbackVerdict,
    integration: fallbackVerdict,
    evidence: fallbackVerdict
  };
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.createdAt,
    kind: "review",
    id: input.reviewId,
    projectId: input.task.projectId,
    changeId: input.task.changeId,
    taskId: input.taskId,
    runId: input.runId,
    reviewer: {
      kind: "tool",
      id: `legion-${input.executor}-reviewer`,
      displayName: "Legion Review Gate"
    },
    verdicts,
    confidence: input.executor === "fake" ? "high" : "medium",
    findings,
    supersedes: [...input.supersedes],
    evidenceRefs: [...evidenceRefs],
    traceRefs: [
      {
        path: input.evidenceIndexPath,
        relation: "records",
        entity: { kind: "change", id: input.task.changeId }
      }
    ],
    status: "submitted",
    submittedAt: input.createdAt
  };
}

function reviewFindingForExecution(finding: ExecutionFinding, evidenceRefs: readonly EvidenceId[], index: number): ReviewFinding {
  const id = /^[a-z][a-z0-9._-]{1,127}$/u.test(finding.id) ? finding.id : `finding-${index + 1}`;
  if (finding.severity === "blocking") {
    return {
      id,
      title: finding.title,
      body: finding.body,
      severity: "blocking",
      evidenceRefs: evidenceRefs.length > 0 ? [...evidenceRefs] : [fallbackEvidenceId()]
    };
  }
  const optionalRefs = evidenceRefs.length === 0 ? {} : { evidenceRefs: [...evidenceRefs] };
  if (finding.severity === "minor") {
    return {
      id,
      title: finding.title,
      body: finding.body,
      severity: "minor",
      ...optionalRefs
    };
  }
  return {
    id,
    title: finding.title,
    body: finding.body,
    severity: "major",
    ...optionalRefs
  };
}

function fallbackEvidenceId(): EvidenceId {
  const evidence = "evd_missing-review-evidence";
  return evidence as EvidenceId;
}

function collectedEvidenceEntriesForTask(
  entries: readonly EvidenceIndexEntry[],
  taskId: ReturnType<typeof taskIdForContractId>
): readonly EvidenceIndexEntry[] {
  return entries.filter((entry) => entry.evidence.status === "collected" && entry.evidence.taskId === taskId);
}

async function cleanSubmittedReviewCoverage(
  repositoryRoot: string,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true }
): Promise<{
  readonly ok: true;
  readonly reviews: readonly ReviewDecisionSuccess[];
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  const reviews = await listReviewDecisionsForChange({ repositoryRoot, changeId: evidence.document.changeId });
  if (!reviews.ok) return { ok: false, diagnostics: reviews.diagnostics };

  const entriesByTaskId = new Map<string, EvidenceIndexEntry[]>();
  const diagnostics: unknown[] = [];
  for (const entry of evidence.document.entries) {
    if (entry.evidence.status !== "collected") continue;
    if (entry.evidence.taskId === undefined) {
      diagnostics.push({
        code: "evidence_task_missing",
        message: `Collected evidence ${entry.evidence.id} is missing a task id.`,
        path: evidence.artifactPath
      });
      continue;
    }
    const current = entriesByTaskId.get(entry.evidence.taskId) ?? [];
    current.push(entry);
    entriesByTaskId.set(entry.evidence.taskId, current);
  }

  if (diagnostics.length > 0 && entriesByTaskId.size === 0) return { ok: false, diagnostics };
  if (entriesByTaskId.size === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "evidence_missing",
          message: "No collected build evidence exists for the latest change.",
          path: evidence.artifactPath
        }
      ]
    };
  }

  const selected = new Map<string, ReviewDecisionSuccess>();
  for (const [taskId, entries] of entriesByTaskId) {
    const evidenceIds = entries.map((entry) => entry.evidence.id);
    const latest = reviews.reviews
      .filter((review) =>
        review.document.status === "submitted" &&
        review.document.taskId === taskId &&
        isCleanReview(review.document) &&
        evidenceIds.every((evidenceId) => (review.document.evidenceRefs ?? []).includes(evidenceId))
      )
      .at(-1);
    if (latest === undefined) {
      diagnostics.push({
        code: "review_not_clean",
        message: `No clean submitted review covers collected evidence for ${taskId}.`,
        path: evidence.artifactPath
      });
      continue;
    }
    selected.set(latest.document.id, latest);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, reviews: [...selected.values()] };
}

async function latestSubmittedReviews(repositoryRoot: string, changeId: string): Promise<{
  readonly ok: true;
  readonly reviews: readonly ReviewDecisionSuccess[];
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  const reviews = await listReviewDecisionsForChange({ repositoryRoot, changeId });
  if (!reviews.ok) return { ok: false, diagnostics: reviews.diagnostics };

  const latestByTaskId = new Map<string, ReviewDecisionSuccess>();
  for (const review of reviews.reviews) {
    if (review.document.status === "submitted" && review.document.taskId !== undefined) {
      latestByTaskId.set(review.document.taskId, review);
    }
  }
  const latest = [...latestByTaskId.values()];
  if (latest.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "review_missing",
          message: "No submitted review decision exists for the latest change."
        }
      ]
    };
  }
  return { ok: true, reviews: latest };
}

function latestSubmittedReviewIdForTask(reviews: readonly ReviewDecisionSuccess[], taskId: ReturnType<typeof taskIdForContractId>): readonly ReviewId[] {
  const latest = reviews
    .filter((review) =>
      review.document.taskId === taskId &&
      (review.document.status === "submitted" || review.document.status === "accepted")
    )
    .at(-1);
  return latest === undefined ? [] : [latest.document.id];
}

/**
 * The review panel's payload.
 *
 * `findings` was a count. A host rendering a review panel from it could say
 * "3 findings" and nothing else — not what they were, not how bad, not what
 * evidence backed them — so the panel either showed a number or the host went
 * and read the artifact itself, which is the coupling the payload exists to
 * avoid.
 */
export function reviewSummary(review: ReviewDecisionSuccess): Record<string, unknown> {
  return {
    reviewId: review.document.id,
    taskId: review.document.taskId,
    artifactPath: review.artifactPath,
    status: review.document.status,
    verdicts: review.document.verdicts,
    confidence: review.document.confidence,
    // Who reviewed, so a panel can distinguish a human verdict from an
    // executor's without opening the artifact.
    reviewer: review.document.reviewer,
    // Who accepted it, which is a different act by a different actor. Spread
    // conditionally so a review with no recorded acceptor produces the payload
    // it produced before this release; without that, every R0 caller's payload
    // would gain two keys holding nothing.
    ...(review.document.acceptedBy === undefined
      ? {}
      : { acceptedBy: review.document.acceptedBy, acceptedAt: review.document.acceptedAt }),
    // The revision chain. A review that supersedes nothing is a first attempt,
    // which is what the first-pass rate in `legion retro` counts.
    supersedes: review.document.supersedes,
    findingCount: review.document.findings.length,
    findings: review.document.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      body: finding.body,
      severity: finding.severity,
      // Blocking findings are required to carry evidence; minor and major ones
      // may not. Reported as an empty list rather than omitted so a caller does
      // not have to distinguish absent from empty.
      evidenceRefs: finding.evidenceRefs ?? []
    }))
  };
}

function taskByTaskId(tasks: readonly TaskContract[]): Map<string, TaskContract> {
  const map = new Map<string, TaskContract>();
  for (const task of tasks) {
    map.set(taskIdForContractId(task.id), task);
  }
  return map;
}

async function refreshBuildEvidenceAfterAutoFix(
  context: CliContext,
  executor: ExecutionAdapterKind,
  changeId: string
): Promise<{
  readonly ok: true;
  readonly evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true };
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  const build = await handleBuildWorkflow({
    ...context,
    args: {
      positionals: ["build"],
      options: new Map<string, string | true>([
        ["executor", executor],
        ["allow-dirty", true]
      ]),
      // Constructed rather than parsed, so nothing here can be malformed.
      invalidOptions: []
    }
  },
  // The change under review, not the newest. Without it, `--phase N --auto`
  // fixed the selected phase and then executed an unrelated task graph,
  // modifying its files, before re-reading the selected phase's stale evidence.
  changeId);
  if (build.exitCode !== 0) {
    return {
      ok: false,
      diagnostics: diagnosticsFromPayload(build.payload, "Auto fix completed, but build evidence refresh failed.")
    };
  }

  const evidence = await readEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId
  });
  if (!evidence.ok) return { ok: false, diagnostics: evidence.diagnostics };
  return { ok: true, evidence };
}

function diagnosticsFromPayload(payload: Record<string, unknown>, fallbackMessage: string): readonly unknown[] {
  const diagnostics = payload["diagnostics"];
  if (Array.isArray(diagnostics)) return diagnostics;
  return [
    {
      code: "auto_build_refresh_failed",
      message: fallbackMessage
    }
  ];
}

function isCleanReview(review: ReviewDecision): boolean {
  return review.status === "submitted" &&
    review.verdicts.specification === "pass" &&
    review.verdicts.integration === "pass" &&
    review.verdicts.evidence === "pass" &&
    !hasBlockingFinding(review.findings);
}

function hasBlockingFinding(findings: readonly ReviewFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}

function reviewResultContract(): string {
  return [
    "Return only JSON with this shape:",
    "```json",
    "{",
    '  "status": "succeeded | failed | blocked",',
    '  "summary": "short factual review summary",',
    '  "reviewVerdicts": {"specification": "pass", "integration": "pass", "evidence": "pass"},',
    '  "findings": [{"id": "finding-id", "title": "Finding title", "body": "Evidence and impact", "severity": "minor | major | blocking"}],',
    '  "filesChanged": [],',
    '  "commandsRun": []',
    "}",
    "```"
  ].join("\n");
}

function parseMaxCycles(value: string | undefined): number | CliResult {
  if (value === undefined) return 3;
  if (!/^[1-9]\d*$/u.test(value)) {
    return failure(
      {
        ok: false,
        status: "usage_error",
        diagnostics: [
          {
            code: "usage_error",
            message: "--max-cycles must be a positive integer."
          }
        ]
      },
      "--max-cycles must be a positive integer."
    );
  }
  return Number.parseInt(value, 10);
}

function blockedReview(
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
    [
      "Review blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}

/**
 * The change `--phase N` names.
 *
 * The phase-to-change link is the derived `chg_phase-<N>-` ID, the same one
 * `legion retro --phase` uses, because no phase field is recorded on a change.
 * Only called when a phase was given; the unscoped path calls
 * `findLatestWorkflowChangeId` directly.
 */
async function resolvePhaseChange(
  repositoryRoot: string,
  phase: string
): Promise<
  | { readonly ok: true; readonly changeId: string; readonly diagnostics: readonly never[] }
  | { readonly ok: false; readonly diagnostics: readonly { readonly code: string; readonly message: string }[] }
> {
  const phaseNumber = Number.parseInt(phase, 10);
  const listed = await listWorkflowChanges(repositoryRoot);
  // `change_missing` means nothing has been planned, which genuinely makes the
  // phase absent. Any other failure is a repository fault — an unreadable
  // changes directory, or directories holding no valid bundle — and reporting
  // it as "run legion plan N" sends the caller to write another plan instead of
  // repairing the artifacts.
  if (!listed.ok && !listed.diagnostics.every((entry) => entry.code === "change_missing")) {
    return { ok: false, diagnostics: listed.diagnostics };
  }
  const prefix = phaseChangeIdPrefix(phaseNumber);
  const matched = (listed.ok ? listed.changes : []).filter((entry) => entry.changeId.startsWith(prefix)).at(-1);
  if (matched === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "phase_change_not_found",
          message: `No change exists for phase ${phaseNumber}. Phase changes are named ${prefix}<slug>; run legion plan ${phaseNumber} first.`
        }
      ]
    };
  }
  return { ok: true, changeId: matched.changeId, diagnostics: [] };
}
