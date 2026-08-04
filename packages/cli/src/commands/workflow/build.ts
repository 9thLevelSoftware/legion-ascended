import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  LEGION_PROJECT_ROOT,
  artifactReferenceForContent,
  hashContent,
  readEvidenceIndex,
  readOracleArtifact,
  readTaskGraph,
  stableProtocolJson,
  listTaskRunsForChange,
  writeEvidenceIndex,
  writeTaskRun,
  type EvidenceIndexEntry,
  type TaskRunSuccess
} from "@legion/artifacts";
import {
  FreshContextDispatcher,
  RuntimeLocalDriver,
  runDeterministicVerification,
  type VerificationReport,
  type WorkerContext
} from "@legion/core";
import {
  LEGION_PROTOCOL_VERSION,
  buildIdempotencyKey,
  taskRunSchema,
  type ArtifactPath,
  type ArtifactReference,
  type EvidenceBundle,
  type EvidenceCommandResult,
  type EvidenceItem,
  type ModelManifest,
  type Oracle,
  type TaskContract,
  type TaskRun,
  type UtcTimestamp
} from "@legion/protocol";

import { failure, hasFlag, helpResult, stringOption, success, type CliContext, type CliResult } from "../../runtime.js";
import { buildExecutionPrompt, writeContextPack } from "../../workflow/context-pack.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import type { ReconciliationResult } from "../../workflow/diff-reconciliation.js";
import { adapterForKind, selectExecutionAdapterKind, writeProjectTextFile, type ExecutionAdapterKind, type ExecutionResult } from "../../workflow/executor/index.js";
import { createVerificationRunner } from "../../workflow/executor/verification-runner.js";
import { createWorkerBundleRegistry } from "../../workflow/executor/worker-bundles.js";
import { runGuardedExecution } from "../../workflow/guarded-execution.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import {
  absoluteArtifactPath,
  evidenceIdForRun,
  runArtifactPath,
  runIdForTask,
  taskIdForContractId
} from "../../workflow/run-artifacts.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const BUILD_HELP = `legion build [--executor codex|manual|fake] [--allow-dirty] [--dry-run]

Execute the latest typed taskgraph through a workflow executor and collect pending build evidence.

Examples:
  legion build --dry-run --json
  legion build --executor fake --allow-dirty
  legion build --executor codex --allow-dirty`;

/**
 * @param changeId When given, build this change instead of the newest one.
 *
 * `legion review --phase N --auto` fixes the selected phase and then rebuilds.
 * Without this the rebuild resolved the newest change, so the fix cycle would
 * execute an unrelated task graph and modify its files, then re-read the
 * selected phase's now-stale evidence. There is no `build --phase` flag yet;
 * this is the internal seam review needs to keep its own scope.
 */
export async function handleBuildWorkflow(context: CliContext, changeId?: string): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(BUILD_HELP);
  }

  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before build can run."
  );

  const latestChange =
    changeId === undefined
      ? await findLatestWorkflowChangeId(context.repositoryRoot)
      : ({ ok: true as const, changeId, diagnostics: [] } as Awaited<
          ReturnType<typeof findLatestWorkflowChangeId>
        >);
  if (!latestChange.ok) {
    return blockedBuild(latestChange.diagnostics, planAction);
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedBuild(taskgraph.diagnostics, planAction);
  }

  const driver = new RuntimeLocalDriver();
  const driverId = driver.driverId;
  if (hasFlag(context, "dry-run")) {
    const action = nextAction(
      "legion build",
      "The latest task graph is ready for guided execution."
    );
    const taskCount = taskgraph.document.tasks.length;
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
        driver: driverId,
        nextAction: action,
        diagnostics: []
      },
      [
        "Build ready.",
        `Dry run: ${taskCount} task${taskCount === 1 ? "" : "s"} can run from ${latestChange.changeId}.`,
        "No implementation was run.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  if (!hasFlag(context, "allow-dirty")) {
    const dirty = dirtyWorktreeDiagnostic(context.repositoryRoot);
    if (dirty !== undefined) {
      return blockedBuild(
        [dirty],
        nextAction("legion build --allow-dirty", "Build execution requires an explicit dirty-worktree override.")
      );
    }
  }

  const selectedExecutor = await selectExecutionAdapterKind(stringOption(context, "executor"));
  if (typeof selectedExecutor !== "string") {
    return blockedBuild([selectedExecutor.diagnostic], nextAction("legion build --executor fake", "Choose a supported executor."));
  }

  const entries = await existingEvidenceEntries(context.repositoryRoot, latestChange.changeId);
  if ("diagnostics" in entries) {
    return blockedBuild(entries.diagnostics, nextAction("legion validate", "Evidence index must be repaired before build can continue."));
  }

  const producedEntries: EvidenceIndexEntry[] = [...entries.entries];
  const existingTaskRuns = await listTaskRunsForChange({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!existingTaskRuns.ok) {
    return blockedBuild(existingTaskRuns.diagnostics, nextAction("legion validate", "Task-run artifacts must be readable before build can continue."));
  }

  const nextAttempts = nextAttemptMap(existingTaskRuns.taskRuns);
  const taskRuns: unknown[] = [];
  for (const task of taskgraph.document.tasks) {
    const taskId = taskIdForContractId(task.id);
    const attempt = nextAttempts.get(taskId) ?? 1;
    nextAttempts.set(taskId, attempt + 1);
    const run = await executeTask({
      context,
      executor: selectedExecutor,
      task,
      attempt,
      taskgraph,
      priorEntries: producedEntries
    });
    if (!run.ok) {
      if (run.taskRun !== undefined) taskRuns.push(run.taskRun);
      const blockedEntries = run.evidenceEntry === undefined
        ? producedEntries
        : replaceEvidenceEntry(producedEntries, run.evidenceEntry);
      const evidenceWrite = await writeEvidenceIndex({
        repositoryRoot: context.repositoryRoot,
        changeId: latestChange.changeId,
        entries: blockedEntries,
        artifactInputs: [taskgraph.revision, ...taskgraph.document.artifactInputs],
        expectedRevision: entries.revision,
        baseGitSha: resolveBaseGitSha(context.repositoryRoot)
      });
      const diagnostics = evidenceWrite.ok ? run.diagnostics : [...run.diagnostics, ...evidenceWrite.diagnostics];
      return blockedBuild(diagnostics, nextAction(`legion build --executor ${selectedExecutor}`, "Resolve the blocked task and rerun build."), {
        changeId: latestChange.changeId,
        executor: selectedExecutor,
        taskRuns,
        ...(evidenceWrite.ok
          ? {
              evidenceIndex: {
                artifactPath: evidenceWrite.artifactPath,
                status: evidenceWrite.status,
                entries: evidenceWrite.document.entries.length
              }
            }
          : {})
      });
    }
    producedEntries.splice(0, producedEntries.length, ...replaceEvidenceEntry(producedEntries, run.evidenceEntry));
    taskRuns.push(run.taskRun);
  }

  const evidenceWrite = await writeEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId,
    entries: producedEntries,
    artifactInputs: [taskgraph.revision, ...taskgraph.document.artifactInputs],
    expectedRevision: entries.revision,
    baseGitSha: resolveBaseGitSha(context.repositoryRoot)
  });
  if (!evidenceWrite.ok) {
    return blockedBuild(evidenceWrite.diagnostics, nextAction("legion validate", "Evidence index write failed and must be repaired."));
  }

  const action = nextAction("legion review", "Build evidence was collected and is pending review.");
  return success(
    {
      ok: true,
      status: "executed",
      change: {
        changeId: latestChange.changeId
      },
      executor: selectedExecutor,
      taskRuns,
      evidenceIndex: {
        artifactPath: evidenceWrite.artifactPath,
        status: evidenceWrite.status,
        entries: evidenceWrite.document.entries.length
      },
      nextAction: action,
      diagnostics: []
    },
    [
      "Build executed.",
      `Executor: ${selectedExecutor}.`,
      `Evidence: ${evidenceWrite.artifactPath} (${evidenceWrite.document.entries.length} pending bundle${evidenceWrite.document.entries.length === 1 ? "" : "s"}).`,
      renderNextAction(action)
    ].join("\n")
  );
}

interface ExecuteTaskInput {
  readonly context: CliContext;
  readonly executor: ExecutionAdapterKind;
  readonly task: TaskContract;
  readonly attempt: number;
  readonly taskgraph: Awaited<ReturnType<typeof readTaskGraph>> & { readonly ok: true };
  readonly priorEntries: readonly EvidenceIndexEntry[];
}

interface ExecuteTaskSuccess {
  readonly ok: true;
  readonly evidenceEntry: EvidenceIndexEntry;
  readonly taskRun: Record<string, unknown>;
}

interface ExecuteTaskFailure {
  readonly ok: false;
  readonly diagnostics: readonly unknown[];
  readonly evidenceEntry?: EvidenceIndexEntry;
  readonly taskRun?: Record<string, unknown>;
}

async function executeTask(input: ExecuteTaskInput): Promise<ExecuteTaskSuccess | ExecuteTaskFailure> {
  const taskId = taskIdForContractId(input.task.id);
  const runId = runIdForTask({ taskId, attempt: input.attempt });
  const evidenceId = evidenceIdForRun(runId);
  const createdAt = currentUtcTimestamp();
  const baseGitSha = resolveBaseGitSha(input.context.repositoryRoot);
  const contextPackArtifactPath = runArtifactPath({ changeId: input.task.changeId, runId, fileName: "context-pack.md" });
  const promptArtifactPath = runArtifactPath({ changeId: input.task.changeId, runId, fileName: "executor-prompt.md" });
  const resultArtifactPath = runArtifactPath({ changeId: input.task.changeId, runId, fileName: "executor-result.json" });
  const rawLogArtifactPath = runArtifactPath({ changeId: input.task.changeId, runId, fileName: "executor-raw.log" });
  const redactedLogArtifactPath = runArtifactPath({ changeId: input.task.changeId, runId, fileName: "executor-redacted.log" });
  const contextPackAbsolutePath = absoluteArtifactPath(input.context.repositoryRoot, contextPackArtifactPath);
  const promptAbsolutePath = absoluteArtifactPath(input.context.repositoryRoot, promptArtifactPath);
  const resultAbsolutePath = absoluteArtifactPath(input.context.repositoryRoot, resultArtifactPath);
  const rawLogAbsolutePath = absoluteArtifactPath(input.context.repositoryRoot, rawLogArtifactPath);
  const redactedLogAbsolutePath = absoluteArtifactPath(input.context.repositoryRoot, redactedLogArtifactPath);

  const contextPack = await writeContextPack({
    repositoryRoot: input.context.repositoryRoot,
    changeId: input.task.changeId,
    runId,
    taskgraph: input.taskgraph,
    task: input.task,
    artifactPath: contextPackArtifactPath,
    absolutePath: contextPackAbsolutePath
  });
  const prompt = buildExecutionPrompt({
    mode: "build",
    contextPackArtifactPath,
    task: input.task,
    requiredOutput: buildResultContract()
  });
  await writeProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: promptArtifactPath,
    text: prompt
  });


  // Resolve the worker context BEFORE the executor runs. The worker-bundle
  // prompt-hash gate only means "refuse to dispatch" if it is consulted while
  // refusing is still possible; checking it after the adapter has already
  // modified the repository would make it a completion gate wearing a dispatch
  // gate's name.
  const workerContext = prepareWorkerContext({ task: input.task, executor: input.executor });
  if (workerContext.blockedReason !== undefined || workerContext.workerContext === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "worker_context_unavailable",
          message: workerContext.blockedReason ?? "No worker context was produced.",
          path: input.taskgraph.artifactPath
        }
      ]
    };
  }

  // Narrowed once here so the manifest and the completion record share one
  // non-optional bundle rather than re-checking at each write.
  const dispatchedBundle = workerContext.workerContext.workerBundle;

  const started = await writeTaskRun({
    repositoryRoot: input.context.repositoryRoot,
    expectedRevision: 0,
    baseGitSha,
    document: taskRunDocument({
      status: "started",
      task: input.task,
      taskId,
      runId,
      attempt: input.attempt,
      executor: input.executor,
      workerBundle: dispatchedBundle,
      createdAt,
      startedAt: createdAt,
      baseGitSha,
      contextPack
    })
  });
  if (!started.ok) return { ok: false, diagnostics: started.diagnostics };


  // Every writable dispatch goes through the same guarded path, so the
  // guarantees it makes — one base SHA, pre-run snapshot, post-run
  // reconciliation, harness-level control-artifact ban, containment on
  // violation — cannot differ between build and auto-fix.
  let verification: ContractVerification = { passed: true };
  const adapter = adapterForKind(input.executor);
  const guarded = await runGuardedExecution({
    repositoryRoot: input.context.repositoryRoot,
    task: input.task,
    // The same SHA the task-run manifest records, so evidence, snapshot and
    // reconciliation all describe one revision.
    baseGitSha,
    harnessPaths: [`.legion/project/changes/${input.task.changeId}/runs/${runId}`],
    run: () =>
      adapter.run({
        repositoryRoot: input.context.repositoryRoot,
        changeId: input.task.changeId,
        runId,
        task: input.task,
        mode: "build",
        executor: input.executor,
        readOnly: false,
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
      }),
    // Verification runs inside the guarded window so its own writes — snapshot
    // updates, generated files, formatters — are reconciled rather than
    // escaping the post-run snapshot.
    afterRun: async () => {
      verification = await runContractVerification({
        repositoryRoot: input.context.repositoryRoot,
        task: input.task,
        workerContext: workerContext.workerContext
      });
    }
  });

  const result = guarded.result;
  const finishedAt = currentUtcTimestamp();
  const reconciliation = guarded.reconciliation;
  const inContract = guarded.inContract;

  // Persisted so "files modified" can be reported from what was observed. The
  // observation was computed on every run and then discarded, leaving the
  // executor's self-reported file list as the only one on disk — a claim the
  // CLI records a `claim-observation-mismatch` against when it disagrees, and
  // which was nonetheless the only thing a later reader could count.
  let observationArtifactPath: ArtifactPath | undefined;
  if (reconciliation?.observation !== undefined) {
    observationArtifactPath = runArtifactPath({
      changeId: input.task.changeId,
      runId,
      fileName: "diff-observation.json"
    });
    await writeProjectTextFile({
      repositoryRoot: input.context.repositoryRoot,
      artifactPath: observationArtifactPath,
      text: stableProtocolJson({
        kind: "diff_observation",
        schemaVersion: 1,
        runId,
        taskId,
        status: reconciliation.status,
        ...reconciliation.observation
      })
    });
  }

  const evidenceEntry = await evidenceEntryForExecution({
    repositoryRoot: input.context.repositoryRoot,
    task: input.task,
    taskId,
    runId,
    evidenceId,
    createdAt,
    startedAt: createdAt,
    finishedAt,
    result,
    resultArtifactPath,
    redactedLogArtifactPath,
    taskgraphPath: input.taskgraph.artifactPath,
    verification,
    inContract,
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(observationArtifactPath === undefined ? {} : { observationArtifactPath })
  });
  const completed = await writeTaskRun({
    repositoryRoot: input.context.repositoryRoot,
    expectedRevision: started.revision.revision,
    baseGitSha,
    document: taskRunDocument({
      // A run that left its contract is blocked regardless of what the
      // executor reported about itself.
      status: !inContract || !verification.passed
        ? "blocked"
        : result.status === "blocked"
          ? "blocked"
          : result.ok
            ? "succeeded"
            : "failed",
      task: input.task,
      taskId,
      runId,
      attempt: input.attempt,
      executor: input.executor,
      workerBundle: dispatchedBundle,
      createdAt,
      startedAt: createdAt,
      finishedAt,
      baseGitSha,
      contextPack,
      evidenceRefs: [evidenceId],
      error: !inContract
        ? {
            code: "diff_reconciliation_failed",
            message: guarded.blockedReason ?? reconciliationSummary(reconciliation),
            retryable: false
          }
        : !verification.passed
          ? {
              code: "verification_failed",
              message: verification.blockedReason ?? "Declared verification commands did not pass.",
              retryable: true
            }
        : result.ok
          ? undefined
          : {
              code: result.status === "blocked" ? "executor_blocked" : "executor_failed",
              message: result.summary,
              retryable: true
            }
    })
  });
  if (!completed.ok) {
    return {
      ok: false,
      evidenceEntry,
      taskRun: {
        runId,
        taskId,
        artifactPath: started.artifactPath,
        status: result.status === "blocked" ? "blocked" : result.ok ? "succeeded" : "failed",
        evidenceId
      },
      diagnostics: completed.diagnostics
    };
  }

  if (!result.ok || !inContract || !verification.passed) {
    return {
      ok: false,
      evidenceEntry,
      taskRun: {
        runId,
        taskId,
        artifactPath: completed.artifactPath,
        status: completed.document.status,
        evidenceId
      },
      diagnostics: [
        ...(inContract
          ? []
          : [
              {
                code: "diff_reconciliation_failed",
                message: guarded.blockedReason ?? reconciliationSummary(reconciliation),
                path: input.taskgraph.artifactPath
              }
            ]),
        ...(verification.passed
          ? []
          : [
              {
                code: "verification_failed",
                message: verification.blockedReason ?? "Declared verification commands did not pass.",
                path: input.taskgraph.artifactPath
              }
            ]),
        ...(result.ok
          ? []
          : [
              {
                code: result.status === "blocked" ? "executor_blocked" : "executor_failed",
                message: result.summary,
                path: resultArtifactPath
              }
            ])
      ]
    };
  }

  return {
    ok: true,
    evidenceEntry,
    taskRun: {
      runId,
      taskId,
      artifactPath: completed.artifactPath,
      status: completed.document.status,
      evidenceId
    }
  };
}

function taskRunDocument(input: {
  readonly status: "started" | "succeeded" | "failed" | "blocked";
  readonly task: TaskContract;
  readonly taskId: ReturnType<typeof taskIdForContractId>;
  readonly runId: ReturnType<typeof runIdForTask>;
  readonly attempt: number;
  readonly executor: ExecutionAdapterKind;
  readonly createdAt: UtcTimestamp;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt?: UtcTimestamp;
  readonly baseGitSha: ReturnType<typeof resolveBaseGitSha>;
  readonly contextPack: string;
  readonly workerBundle: WorkerContext["workerBundle"];
  readonly evidenceRefs?: readonly ReturnType<typeof evidenceIdForRun>[];
  readonly error?: TaskRun["error"];
}): TaskRun {
  const targetHash = hashContent(stableProtocolJson({
    task: input.task.id,
    attempt: input.attempt,
    executor: input.executor
  }));
  const manifest = {
    runtime: {
      driver: "legion.executor",
      version: LEGION_PROTOCOL_VERSION
    },
    // The bundle that was actually dispatched, taken from the worker context.
    //
    // This was a synthetic `workflow-executor` / `implementer` / `codebase`
    // object for every run. Replacing only its id and role made it worse rather
    // than better: the manifest then named a real bundle while still carrying
    // the wrong version, domain, capabilities and prompt hash, so it described a
    // bundle that does not exist and could not be integrity-verified — and it
    // looked right, which the fully synthetic version at least did not.
    workerBundle: input.workerBundle,
    model: {
      provider: input.executor === "codex" ? "openai" : "legion",
      id: input.executor === "codex" ? "codex-cli" : input.executor,
      policyVersion: LEGION_PROTOCOL_VERSION
    },
    inputs: {
      contractHash: hashContent(stableProtocolJson(input.task)),
      currentSpecsHash: hashContent(stableProtocolJson(input.task.context.specRefs)),
      deltaSpecsHash: hashContent(stableProtocolJson(input.task.context.predecessorArtifacts)),
      oracleHash: hashContent(stableProtocolJson(input.task.oracleRefs))
    },
    repository: {
      baseCommit: input.baseGitSha
    },
    workspace: {
      sandboxDriver: input.executor,
      worktreePath: ".legion/project" as ArtifactPath
    },
    policy: {
      version: LEGION_PROTOCOL_VERSION,
      riskTier: input.task.risk.tier
    },
    idempotencyKey: buildIdempotencyKey({
      projectId: input.task.projectId,
      changeId: input.task.changeId,
      taskId: input.taskId,
      runId: input.runId,
      effectKind: "workflow-execute",
      targetHash
    }),
    frozenAt: input.startedAt
  };

  return taskRunSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.createdAt,
    ...(input.finishedAt === undefined ? {} : { updatedAt: input.finishedAt }),
    kind: "task-run",
    id: input.runId,
    projectId: input.task.projectId,
    changeId: input.task.changeId,
    taskId: input.taskId,
    contractId: input.task.id,
    contractRevision: input.task.revision,
    attempt: input.attempt,
    claimedBy: {
      kind: "tool",
      id: "legion-cli",
      displayName: "Legion CLI"
    },
    ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
    ...(input.error === undefined ? {} : { error: input.error }),
    status: input.status,
    startedAt: input.startedAt,
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    manifest
  });
}

async function evidenceEntryForExecution(input: {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
  readonly taskId: ReturnType<typeof taskIdForContractId>;
  readonly runId: ReturnType<typeof runIdForTask>;
  readonly evidenceId: ReturnType<typeof evidenceIdForRun>;
  readonly createdAt: UtcTimestamp;
  readonly startedAt: UtcTimestamp;
  readonly finishedAt: UtcTimestamp;
  readonly result: ExecutionResult;
  readonly resultArtifactPath: ArtifactPath;
  readonly redactedLogArtifactPath: ArtifactPath;
  readonly taskgraphPath: ArtifactPath;
  readonly verification: ContractVerification;
  readonly inContract: boolean;
  readonly reconciliation?: ReconciliationResult;
  readonly observationArtifactPath?: ArtifactPath;
}): Promise<EvidenceIndexEntry> {
  const resultReference = await referenceForFile(input.repositoryRoot, input.resultArtifactPath);
  const logReference = await referenceForFile(input.repositoryRoot, input.redactedLogArtifactPath);
  const logBytes = await readFile(absoluteArtifactPath(input.repositoryRoot, input.redactedLogArtifactPath));
  const command = commandForEvidence(input.result, logBytes, input.startedAt, input.finishedAt);
  // Evidence traces to what it is evidence *for*, not only to the change it
  // happened inside. The traceability service requires at least one reference to
  // a requirement or an oracle and reports the rest as `orphan_evidence`; every
  // run Legion produced named only its change, so its own output could not
  // satisfy its own service. The task contract already carries both lists, so
  // the link was available and simply never written.
  const traceRefs = [
    {
      path: input.taskgraphPath,
      relation: "records" as const,
      entity: { kind: "change" as const, id: input.task.changeId }
    },
    ...input.task.requirementIds.map((requirementId) => ({
      path: input.taskgraphPath,
      anchor: input.task.id,
      relation: "verifies" as const,
      entity: { kind: "requirement" as const, id: requirementId }
    })),
    ...input.task.oracleRefs.map((oracleId) => ({
      path: input.taskgraphPath,
      anchor: input.task.id,
      relation: "verifies" as const,
      entity: { kind: "oracle" as const, id: oracleId }
    }))
  ];
  const reconciliation = input.reconciliation;
  // Supplied by the guarded execution rather than recomputed. Two places
  // deciding the same thing is how these paths drift apart.
  const inContract = input.inContract;

  const items: EvidenceItem[] = [
    {
      // The executor's own account of the run. Recorded as a claim, never as
      // proof — this is the value that used to decide the verdict on its own.
      id: "executor-result",
      classification: "runtime-log",
      verdict: input.result.ok ? "pass" : "fail",
      artifact: resultReference,
      command,
      traceRefs
    },
    {
      id: "executor-redacted-log",
      classification: "runtime-log",
      verdict: input.result.ok ? "pass" : "fail",
      artifact: logReference,
      traceRefs
    }
  ];

  if (input.verification.report !== undefined) {
    const report = input.verification.report;
    items.push({
      // Exit codes observed by the harness running the contract's own declared
      // commands — not the counts the executor reported about itself.
      id: "declared-verification",
      classification: "test-report",
      verdict: report.passed ? "pass" : "fail",
      artifact: resultReference,
      traceRefs
    });
  }

  if (reconciliation !== undefined) {
    // Points at the observation, not at the executor's result file. Only a
    // verdict was persisted before, so the sole file list on disk was the
    // executor's self-reported `filesChanged` — the very claim this item exists
    // to check. "Files modified" could then only ever be reported from the
    // claim, which the CLI itself treats as unreliable.
    const observationReference = input.observationArtifactPath === undefined
      ? resultReference
      : await referenceForFile(input.repositoryRoot, input.observationArtifactPath);
    items.push({
      // What the working tree shows. This is the item that decides whether the
      // run stayed inside its contract.
      id: "diff-reconciliation",
      classification: "runtime-log",
      verdict:
        reconciliation.status === "clean"
          ? "pass"
          : reconciliation.status === "not_applicable"
            ? "not_applicable"
            : "fail",
      artifact: observationReference,
      traceRefs
    });

    const mismatch = claimObservationMismatch(input.result, reconciliation);
    if (mismatch !== undefined) {
      items.push({
        // The executor's file list disagreed with the working tree. Neither
        // side is assumed correct, so the verdict is `unknown` rather than
        // `fail` — the disagreement is a measurement, not a contract breach.
        // Recording it is what makes executor drift visible over time.
        id: "claim-observation-mismatch",
        classification: "runtime-log",
        verdict: "unknown",
        artifact: resultReference,
        traceRefs
      });
    }
  }

  const evidence: EvidenceBundle = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.createdAt,
    kind: "evidence",
    id: input.evidenceId,
    projectId: input.task.projectId,
    changeId: input.task.changeId,
    taskId: input.taskId,
    runId: input.runId,
    sensitivity: "secret-redacted",
    retention: { class: "project" },
    traceRefs,
    status: input.result.ok && inContract && input.verification.passed ? "collected" : "failed",
    items
  };
  return {
    evidence,
    acceptance: {
      status: "pending"
    }
  };
}

function commandForEvidence(
  result: ExecutionResult,
  logBytes: Uint8Array,
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp
): EvidenceCommandResult {
  const first = result.commandsRun[0];
  return {
    command: first?.command ?? "legion-executor",
    args: first === undefined ? [] : [...first.args],
    exitCode: clampExitCode(first?.exitCode ?? (result.ok ? 0 : 1)),
    outputHash: hashContent(logBytes),
    startedAt,
    endedAt
  };
}

async function referenceForFile(repositoryRoot: string, artifactPath: ArtifactPath): Promise<ArtifactReference> {
  const bytes = await readFile(absoluteArtifactPath(repositoryRoot, artifactPath));
  return artifactReferenceForContent({
    path: artifactPath,
    content: bytes
  });
}

function replaceEvidenceEntry(entries: readonly EvidenceIndexEntry[], next: EvidenceIndexEntry): readonly EvidenceIndexEntry[] {
  return [
    ...entries.filter((entry) => entry.evidence.id !== next.evidence.id),
    next
  ];
}

async function existingEvidenceEntries(repositoryRoot: string, changeId: string): Promise<{
  readonly entries: readonly EvidenceIndexEntry[];
  readonly revision: number;
} | { readonly diagnostics: readonly unknown[] }> {
  const current = await readEvidenceIndex({ repositoryRoot, changeId });
  if (!current.ok) {
    if (current.status === "not_found") return { entries: [], revision: 0 };
    return { diagnostics: current.diagnostics };
  }
  return {
    entries: current.document.entries,
    revision: current.document.revision
  };
}

function nextAttemptMap(taskRuns: readonly TaskRunSuccess[]): Map<string, number> {
  const attempts = new Map<string, number>();
  for (const run of taskRuns) {
    const nextAttempt = run.document.attempt + 1;
    const current = attempts.get(run.document.taskId) ?? 1;
    if (nextAttempt > current) attempts.set(run.document.taskId, nextAttempt);
  }
  return attempts;
}

interface ContractVerification {
  readonly report?: VerificationReport;
  /** True when every declared command hit its expected exit code. */
  readonly passed: boolean;
  /** Set when verification could not be attempted at all. */
  readonly blockedReason?: string;
}

/**
 * Run `TaskContract.verification[]` through core's deterministic runner.
 *
 * The aggregation semantics (`passed` iff every command matched its declared
 * exit code and none timed out, plus the deterministic `reportSha256`) belong
 * to `@legion/core`; this function only supplies the two things core is
 * deliberately ignorant of — a worker context and a way to execute a process.
 */
interface PreparedWorkerContext {
  readonly workerContext?: WorkerContext;
  /** Set when a fresh worker context could not be produced; dispatch must not proceed. */
  readonly blockedReason?: string;
}

/**
 * Resolve a fresh, isolated worker context for a task.
 *
 * Split out from verification so it can be called before the executor runs.
 * Loading the bundle registry is what enforces the prompt content-hash gate, and
 * a gate that only fires after the untrusted process has already written to the
 * repository is not a dispatch gate.
 */
function prepareWorkerContext(input: {
  readonly task: TaskContract;
  readonly executor: ExecutionAdapterKind;
}): PreparedWorkerContext {
  let registry;
  try {
    registry = createWorkerBundleRegistry({ model: modelManifestForExecutor(input.executor) });
  } catch (error) {
    // A bundle whose prompt has drifted from its declared hash must not be
    // dispatched. Failing loudly here is the point of content addressing.
    return { blockedReason: error instanceof Error ? error.message : String(error) };
  }

  const dispatch = new FreshContextDispatcher().dispatch({
    taskContract: input.task,
    bundleRegistry: registry,
    protocolVersion: LEGION_PROTOCOL_VERSION,
    availableAgents: [...input.task.agents],
    availableContracts: input.task.dependencies.map((dependency) => ({
      contractId: dependency.contractId,
      ...(dependency.revision === undefined ? {} : { revision: dependency.revision })
    })),
    availableArtifacts: [
      ...input.task.context.specRefs,
      ...input.task.context.designRefs,
      ...input.task.context.predecessorArtifacts
    ]
  });

  if (!dispatch.ok) {
    return {
      blockedReason: `A fresh worker context could not be dispatched: ${dispatch.issues
        .map((issue) => issue.message)
        .join(" ")}`
    };
  }

  return { workerContext: dispatch.workerContext };
}

/**
 * Run `TaskContract.verification[]` through core's deterministic runner.
 *
 * The aggregation semantics (`passed` iff every command matched its declared
 * exit code and none timed out, plus the deterministic `reportSha256`) belong
 * to `@legion/core`; this function only supplies the two things core is
 * deliberately ignorant of — a worker context and a way to execute a process.
 */
async function runContractVerification(input: {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
  readonly workerContext: WorkerContext | undefined;
}): Promise<ContractVerification> {
  if (input.workerContext === undefined) {
    return { passed: false, blockedReason: "No worker context was available for verification." };
  }

  // The task's oracles, loaded so their commands actually run. Until this, an
  // oracle's command executed only when the planner happened to copy the same
  // string into `task.verification` — so an oracle whose command drifted, or
  // that was never planned in, was never run while the task reported verified.
  const oracles = await oraclesForTask({ repositoryRoot: input.repositoryRoot, task: input.task });

  // An oracle the task names and the CLI cannot read is a criterion that will
  // not be evaluated, so the task cannot pass. Loading a shortened list instead
  // would let the remaining commands succeed and record a verified task whose
  // acceptance criterion nothing checked.
  if (oracles.unreadable.length > 0) {
    return {
      passed: false,
      blockedReason: `The task names ${oracles.unreadable.length} oracle(s) that could not be read, so their criteria were not evaluated: ${oracles.unreadable
        .map((entry) => `${entry.oracleId} (${entry.reason})`)
        .join("; ")}`
    };
  }

  const { report, issues, oracleAttribution } = await runDeterministicVerification({
    taskContract: input.task,
    workerContext: input.workerContext,
    options: {
      runner: createVerificationRunner({ repositoryRoot: input.repositoryRoot }),
      now: currentUtcTimestamp,
      ...(oracles.loaded.length === 0 ? {} : { oracles: oracles.loaded })
    }
  });

  return {
    report,
    passed: report.passed,
    ...(report.passed
      ? {}
      : {
          blockedReason: `Verification failed for ${report.failingIndices.length} of ${report.commands.length} declared command(s).${describeFailingOracles(report.failingIndices, oracleAttribution)} ${issues
            .map((issue) => issue.message)
            .join(" ")}`.trim()
        })
  };
}

/**
 * The oracles a task names, in `oracleRefs` order, and the ones that would not load.
 *
 * An unreadable oracle is returned rather than dropped. An earlier revision of
 * this function carried that sentence as a docblock and then wrote
 * `if (read.ok) loaded.push(...)`, silently shortening the list — which is the
 * failure the whole oracle-execution change exists to prevent, committed inside
 * the change that prevents it. A missing or malformed oracle must reach the
 * caller as a refusal, because a criterion nobody evaluated is not a criterion
 * that held.
 */
async function oraclesForTask(input: {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
}): Promise<{
  readonly loaded: readonly Oracle[];
  readonly unreadable: readonly { readonly oracleId: string; readonly reason: string }[];
}> {
  const loaded: Oracle[] = [];
  const unreadable: { readonly oracleId: string; readonly reason: string }[] = [];
  for (const oracleId of input.task.oracleRefs ?? []) {
    const read = await readOracleArtifact({
      repositoryRoot: input.repositoryRoot,
      changeId: input.task.changeId,
      oracleId
    });
    if (read.ok) {
      loaded.push(read.document);
      continue;
    }
    unreadable.push({
      oracleId,
      reason: read.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "unreadable"
    });
  }
  return { loaded, unreadable };
}

/** Name the oracles behind failing command indices, when any are. */
function describeFailingOracles(
  failingIndices: readonly number[],
  attribution: readonly { readonly index: number; readonly oracleId: string }[]
): string {
  const named = attribution
    .filter((entry) => failingIndices.includes(entry.index))
    .map((entry) => entry.oracleId);
  return named.length === 0 ? "" : ` Failing oracle(s): ${named.join(", ")}.`;
}

function modelManifestForExecutor(executor: ExecutionAdapterKind): ModelManifest {
  return {
    provider: executor === "codex" ? "openai" : "legion",
    id: executor === "codex" ? "codex-cli" : executor,
    policyVersion: LEGION_PROTOCOL_VERSION
  };
}

function reconciliationSummary(reconciliation: ReconciliationResult | undefined): string {
  if (reconciliation === undefined) return "Diff reconciliation did not run.";
  if (reconciliation.status === "unavailable") {
    return `The run could not be reconciled against its task contract, so it is not proven in-contract. ${reconciliation.unavailableReason ?? ""}`.trim();
  }
  return reconciliation.violations.map((violation) => violation.message).join(" ");
}

/**
 * Compare the executor's self-reported `filesChanged` against what the working
 * tree actually shows.
 *
 * This is not used to decide pass/fail — the observation already does that. It
 * exists because a systematic gap between claim and observation is the clearest
 * available measurement of executor drift, and it is only visible if both are
 * recorded side by side.
 */
function claimObservationMismatch(
  result: ExecutionResult,
  reconciliation: ReconciliationResult
): { readonly claimedOnly: readonly string[]; readonly observedOnly: readonly string[] } | undefined {
  const observation = reconciliation.observation;
  if (observation === undefined) return undefined;

  const claimed = new Set((result.filesChanged ?? []).map((entry) => entry.replace(/\\/g, "/")));
  const observed = new Set(observation.changedFiles);
  const claimedOnly = [...claimed].filter((entry) => !observed.has(entry)).sort();
  const observedOnly = [...observed].filter((entry) => !claimed.has(entry)).sort();

  if (claimedOnly.length === 0 && observedOnly.length === 0) return undefined;
  return { claimedOnly, observedOnly };
}

function buildResultContract(): string {
  return [
    "Return only JSON with this shape:",
    "```json",
    "{",
    '  "status": "succeeded | failed | blocked",',
    '  "summary": "short factual summary",',
    '  "filesChanged": ["path"],',
    '  "commandsRun": [{"command": "pnpm", "args": ["test"], "exitCode": 0}],',
    '  "findings": []',
    "}",
    "```"
  ].join("\n");
}

function dirtyWorktreeDiagnostic(repositoryRoot: string): { readonly code: string; readonly message: string; readonly path: string } | undefined {
  try {
    execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }

  let status = "";
  try {
    status = execFileSync("git", ["-C", repositoryRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
  if (status.length === 0) return undefined;
  const firstLines = status.split(/\r?\n/u).slice(0, 8).join("; ");
  return {
    code: "dirty_worktree",
    message: `Worktree has uncommitted changes. Commit/stash them or rerun with --allow-dirty. Changes: ${firstLines}`,
    path: repositoryRoot
  };
}

function clampExitCode(value: number): number {
  if (!Number.isInteger(value)) return 1;
  if (value < 0) return 1;
  if (value > 255) return 255;
  return value;
}

function blockedBuild(
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
      "Build blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}
