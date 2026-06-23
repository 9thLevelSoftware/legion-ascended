import {
  readEvidenceIndex,
  readTaskGraph,
  writeEvidenceIndex,
  writeReviewDecision,
  listReviewDecisionsForChange,
  listTaskRunsForChange,
  type EvidenceIndexEntry,
  type ReviewDecisionSuccess
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  type ArtifactPath,
  type EvidenceId,
  type ReviewDecision,
  type ReviewFinding,
  type ReviewId,
  type TaskContract
} from "@legion/protocol";

import { failure, hasFlag, stringOption, success, type CliContext, type CliResult } from "../../runtime.js";
import { buildExecutionPrompt, writeContextPack } from "../../workflow/context-pack.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { adapterForKind, selectExecutionAdapterKind, writeTextFile, type ExecutionAdapterKind, type ExecutionFinding, type ExecutionResult } from "../../workflow/executor/index.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import {
  absoluteArtifactPath,
  reviewIdForChange,
  reviewRunArtifactPath,
  runIdForTask,
  taskIdForContractId
} from "../../workflow/run-artifacts.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

export async function handleReviewWorkflow(context: CliContext): Promise<CliResult> {
  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before review readiness can be checked."
  );

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
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
    return acceptLatestReview(context, evidence);
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
      evidence
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

  const clean = isCleanReview(submitted.review.document);
  const action = clean
    ? nextAction("legion review --accept", "A passing review was submitted and needs human acceptance.")
    : nextAction("legion build", "Address review findings and collect new evidence.");
  return success(
    {
      ok: true,
      status: "submitted",
      review: {
        reviewId: submitted.review.document.id,
        artifactPath: submitted.review.artifactPath,
        verdicts: submitted.review.document.verdicts,
        findings: submitted.review.document.findings.length
      },
      evidenceIndex: evidence.artifactPath,
      nextAction: action,
      diagnostics: []
    },
    [
      "Review submitted.",
      `Review: ${submitted.review.artifactPath}.`,
      clean ? "Verdict: pass." : `Findings: ${submitted.review.document.findings.length}.`,
      renderNextAction(action)
    ].join("\n")
  );
}

interface SubmitReviewInput {
  readonly executor: ExecutionAdapterKind;
  readonly taskgraph: Awaited<ReturnType<typeof readTaskGraph>> & { readonly ok: true };
  readonly evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true };
}

async function submitReview(context: CliContext, input: SubmitReviewInput): Promise<{
  readonly ok: true;
  readonly review: ReviewDecisionSuccess;
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  const task = input.taskgraph.document.tasks[0];
  if (task === undefined) {
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

  const reviewId = reviewIdForChange({
    changeId: input.taskgraph.document.changeId,
    sequence: reviews.reviews.length + 1
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
  const latestRun = await latestTaskRun(context.repositoryRoot, input.taskgraph.document.changeId);
  const taskId = taskIdForContractId(task.id);
  const runId = latestRun?.document.id ?? runIdForTask({ taskId, attempt: 1 });

  await writeContextPack({
    repositoryRoot: context.repositoryRoot,
    changeId: input.taskgraph.document.changeId,
    runId: reviewId,
    taskgraph: input.taskgraph,
    task,
    artifactPath: contextPackArtifactPath,
    absolutePath: contextPackAbsolutePath
  });
  const prompt = buildExecutionPrompt({
    mode: "review",
    contextPackArtifactPath,
    task,
    requiredOutput: reviewResultContract()
  });
  await writeTextFile(promptAbsolutePath, prompt);

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
    evidenceEntries: input.evidence.document.entries,
    evidenceIndexPath: input.evidence.artifactPath,
    createdAt,
    executor: input.executor,
    supersedes: latestSubmittedReviewId(reviews.reviews)
  });
  const write = await writeReviewDecision({
    repositoryRoot: context.repositoryRoot,
    document: review,
    expectedRevision: 0,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!write.ok) return { ok: false, diagnostics: write.diagnostics };
  return { ok: true, review: write };
}

async function acceptLatestReview(
  context: CliContext,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true }
): Promise<CliResult> {
  const latest = await latestSubmittedReview(context.repositoryRoot, evidence.document.changeId);
  if (!latest.ok) {
    return blockedReview(latest.diagnostics, nextAction("legion review", "Submit a passing review before accepting."));
  }
  if (!isCleanReview(latest.review.document)) {
    return blockedReview(
      [
        {
          code: "review_not_clean",
          message: "Only a submitted review with all pass verdicts and no blocking findings can be accepted.",
          path: latest.review.artifactPath
        }
      ],
      nextAction("legion build", "Address findings and rerun review.")
    );
  }

  const acceptedAt = currentUtcTimestamp();
  const submittedAt = latest.review.document.submittedAt ?? acceptedAt;
  const accepted = await writeReviewDecision({
    repositoryRoot: context.repositoryRoot,
    expectedRevision: latest.review.revision.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot),
    document: {
      ...latest.review.document,
      status: "accepted",
      updatedAt: acceptedAt,
      submittedAt
    }
  });
  if (!accepted.ok) {
    return blockedReview(accepted.diagnostics, nextAction("legion review", "Review acceptance could not be written."));
  }

  const evidenceWrite = await writeEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: evidence.document.changeId,
    entries: evidence.document.entries.map((entry) =>
      entry.evidence.status === "collected"
        ? {
            ...entry,
            acceptance: {
              status: "accepted",
              reviewId: accepted.document.id,
              acceptedAt
            }
          }
        : entry
    ),
    artifactInputs: evidence.document.artifactManifest.inputs,
    expectedRevision: evidence.document.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!evidenceWrite.ok) {
    return blockedReview(evidenceWrite.diagnostics, nextAction("legion validate", "Evidence acceptance could not be written."));
  }

  const action = nextAction("legion ship", "Accepted review and evidence are ready for the ship readiness gate.");
  return success(
    {
      ok: true,
      status: "accepted",
      review: {
        reviewId: accepted.document.id,
        artifactPath: accepted.artifactPath
      },
      evidenceIndex: {
        artifactPath: evidenceWrite.artifactPath,
        acceptedEntries: evidenceWrite.document.entries.filter((entry) => entry.acceptance.status === "accepted").length
      },
      nextAction: action,
      diagnostics: []
    },
    [
      "Review accepted.",
      `Evidence accepted: ${evidenceWrite.artifactPath}.`,
      renderNextAction(action)
    ].join("\n")
  );
}

async function rejectLatestReview(
  context: CliContext,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true },
  reason: string
): Promise<CliResult> {
  const latest = await latestSubmittedReview(context.repositoryRoot, evidence.document.changeId);
  if (!latest.ok) {
    return blockedReview(latest.diagnostics, nextAction("legion review", "Submit a review before rejecting it."));
  }
  const rejectedAt = currentUtcTimestamp();
  const submittedAt = latest.review.document.submittedAt ?? rejectedAt;
  const rejected = await writeReviewDecision({
    repositoryRoot: context.repositoryRoot,
    expectedRevision: latest.review.revision.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot),
    document: {
      ...latest.review.document,
      status: "rejected",
      updatedAt: rejectedAt,
      submittedAt,
      metadata: {
        ...(latest.review.document.metadata ?? {}),
        annotations: {
          ...(latest.review.document.metadata?.annotations ?? {}),
          reject_reason: reason
        }
      }
    }
  });
  if (!rejected.ok) {
    return blockedReview(rejected.diagnostics, nextAction("legion review", "Review rejection could not be written."));
  }

  const evidenceWrite = await writeEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: evidence.document.changeId,
    entries: evidence.document.entries.map((entry) => ({
      ...entry,
      acceptance: {
        status: "rejected",
        reviewId: rejected.document.id,
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

  const action = nextAction("legion build", "Rejected evidence needs a new build run.");
  return success(
    {
      ok: true,
      status: "rejected",
      review: {
        reviewId: rejected.document.id,
        artifactPath: rejected.artifactPath
      },
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

  let latestReview: ReviewDecisionSuccess | undefined;
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const submitted = await submitReview(context, input);
    if (!submitted.ok) {
      return blockedReview(submitted.diagnostics, nextAction("legion review", "Auto review could not submit a review decision."));
    }
    latestReview = submitted.review;
    if (isCleanReview(submitted.review.document)) {
      const refreshedEvidence = await readEvidenceIndex({
        repositoryRoot: context.repositoryRoot,
        changeId: input.evidence.document.changeId
      });
      if (!refreshedEvidence.ok) {
        return blockedReview(refreshedEvidence.diagnostics, nextAction("legion validate", "Evidence index could not be reloaded for acceptance."));
      }
      return acceptLatestReview(context, refreshedEvidence);
    }

    if (cycle < maxCycles) {
      const task = input.taskgraph.document.tasks[0];
      if (task !== undefined) {
        await runAutoFixCycle(context, input.executor, input.taskgraph.document.changeId, task, cycle);
      }
    }
  }

  return blockedReview(
    [
      {
        code: "auto_review_not_clean",
        message: `Auto review reached ${maxCycles} cycle${maxCycles === 1 ? "" : "s"} without a clean review.`,
        path: latestReview?.artifactPath
      }
    ],
    nextAction("legion build", "Address review findings manually and rerun review.")
  );
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
  const reviewId = reviewIdForChange({ changeId, sequence: 100 + cycle });
  const contextPackArtifactPath = reviewRunArtifactPath({ changeId, reviewId, fileName: "context-pack.md" });
  const promptArtifactPath = reviewRunArtifactPath({ changeId, reviewId, fileName: "executor-prompt.md" });
  const resultArtifactPath = reviewRunArtifactPath({ changeId, reviewId, fileName: "executor-result.json" });
  const rawLogArtifactPath = reviewRunArtifactPath({ changeId, reviewId, fileName: "executor-raw.log" });
  const redactedLogArtifactPath = reviewRunArtifactPath({ changeId, reviewId, fileName: "executor-redacted.log" });
  const prompt = buildExecutionPrompt({
    mode: "fix",
    contextPackArtifactPath,
    task,
    requiredOutput: reviewResultContract()
  });
  await writeTextFile(
    absoluteArtifactPath(context.repositoryRoot, contextPackArtifactPath),
    [
      `# Auto Fix Context ${cycle}`,
      "",
      `Change: ${changeId}`,
      `Task: ${task.id}`,
      "",
      "The previous review reported findings. Apply the smallest scoped fix and report JSON."
    ].join("\n")
  );
  await writeTextFile(absoluteArtifactPath(context.repositoryRoot, promptArtifactPath), prompt);
  await adapterForKind(executor).run({
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
  });
}

function reviewDecisionForExecution(input: {
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
  const verdicts = input.result.reviewVerdicts ?? {
    specification: input.result.ok && !hasBlockingFinding(findings) ? "pass" : "fail",
    integration: input.result.ok && !hasBlockingFinding(findings) ? "pass" : "fail",
    evidence: input.result.ok && !hasBlockingFinding(findings) ? "pass" : "fail"
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

async function latestTaskRun(repositoryRoot: string, changeId: string) {
  const runs = await listTaskRunsForChange({ repositoryRoot, changeId });
  if (!runs.ok) return undefined;
  return runs.taskRuns.at(-1);
}

async function latestSubmittedReview(repositoryRoot: string, changeId: string): Promise<{
  readonly ok: true;
  readonly review: ReviewDecisionSuccess;
} | { readonly ok: false; readonly diagnostics: readonly unknown[] }> {
  const reviews = await listReviewDecisionsForChange({ repositoryRoot, changeId });
  if (!reviews.ok) return { ok: false, diagnostics: reviews.diagnostics };
  const latest = reviews.reviews.filter((review) => review.document.status === "submitted").at(-1);
  if (latest === undefined) {
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
  return { ok: true, review: latest };
}

function latestSubmittedReviewId(reviews: readonly ReviewDecisionSuccess[]): readonly ReviewId[] {
  const latest = reviews.filter((review) => review.document.status === "submitted" || review.document.status === "accepted").at(-1);
  return latest === undefined ? [] : [latest.document.id];
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
