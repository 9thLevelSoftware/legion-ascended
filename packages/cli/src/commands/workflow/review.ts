import {
  readEvidenceIndex,
  readTaskGraph,
  writeEvidenceIndex,
  writeReviewDecision,
  listReviewDecisionsForChange,
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
  runArtifactPath,
  runIdForTask,
  taskIdForContractId
} from "../../workflow/run-artifacts.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";
import { handleBuildWorkflow } from "./build.js";

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

  const clean = submitted.reviews.every((review) => isCleanReview(review.document));
  const findingCount = submitted.reviews.reduce((total, review) => total + review.document.findings.length, 0);
  const firstReview = submitted.reviews[0];
  const action = clean
    ? nextAction("legion review --accept", "A passing review was submitted and needs human acceptance.")
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

interface SubmitReviewInput {
  readonly executor: ExecutionAdapterKind;
  readonly taskgraph: Awaited<ReturnType<typeof readTaskGraph>> & { readonly ok: true };
  readonly evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true };
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

async function acceptLatestReview(
  context: CliContext,
  evidence: Awaited<ReturnType<typeof readEvidenceIndex>> & { readonly ok: true }
): Promise<CliResult> {
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
        submittedAt
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

  const action = nextAction("legion ship", "Accepted review and evidence are ready for the ship readiness gate.");
  return success(
    {
      ok: true,
      status: "accepted",
      ...(acceptedReviews[0] === undefined ? {} : { review: reviewSummary(acceptedReviews[0]) }),
      reviews: acceptedReviews.map(reviewSummary),
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

  const action = nextAction("legion build", "Rejected evidence needs a new build run.");
  return success(
    {
      ok: true,
      status: "rejected",
      ...(rejectedReviews[0] === undefined ? {} : { review: reviewSummary(rejectedReviews[0]) }),
      reviews: rejectedReviews.map(reviewSummary),
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
      return blockedReview(submitted.diagnostics, nextAction("legion review", "Auto review could not submit a review decision."));
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
      return acceptLatestReview(context, refreshedEvidence);
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

  return blockedReview(
    [
      {
        code: "auto_review_not_clean",
        message: `Auto review reached ${maxCycles} cycle${maxCycles === 1 ? "" : "s"} without a clean review.`,
        path: latestReviews.at(-1)?.artifactPath
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

function reviewSummary(review: ReviewDecisionSuccess): Record<string, unknown> {
  return {
    reviewId: review.document.id,
    taskId: review.document.taskId,
    artifactPath: review.artifactPath,
    verdicts: review.document.verdicts,
    findings: review.document.findings.length
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
      ])
    }
  });
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
