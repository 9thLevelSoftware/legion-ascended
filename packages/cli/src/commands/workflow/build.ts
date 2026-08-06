import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  LEGION_PROJECT_ROOT,
  artifactReferenceForContent,
  hashContent,
  listApprovalsForChange,
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
  type OracleAttribution,
  type VerificationReport,
  type WorkerContext
} from "@legion/core";
import {
  LEGION_PROTOCOL_VERSION,
  buildIdempotencyKey,
  taskRunSchema,
  type Approval,
  type ArtifactPath,
  type ArtifactReference,
  type EvidenceBundle,
  type EvidenceCommandResult,
  type EvidenceItem,
  type ModelManifest,
  type Oracle,
  type TaskContract,
  type TaskRun,
  type UtcTimestamp,
  type VerificationSurface
} from "@legion/protocol";

import { failure, hasFlag, helpResult, stringOption, success, type CliContext, type CliResult } from "../../runtime.js";
import { buildExecutionPrompt, writeContextPack } from "../../workflow/context-pack.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import type { ReconciliationResult } from "../../workflow/diff-reconciliation.js";
import { adapterForKind, selectExecutionAdapterKind, writeProjectTextFile, type ExecutionAdapterKind, type ExecutionResult } from "../../workflow/executor/index.js";
import { createVerificationRunner } from "../../workflow/executor/verification-runner.js";
import { createWorkerBundleRegistry } from "../../workflow/executor/worker-bundles.js";
import { runGuardedExecution } from "../../workflow/guarded-execution.js";
import { mintPinnedReferences, type MintPinnedReference } from "../../workflow/pinned-references.js";
import { isLiveSurfaceReaffirmation } from "../../workflow/ship-gates.js";
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

  // No cast and no synthetic `diagnostics`: the success arm carries only the
  // change ID, which is all the code below reads. A cast here would be the same
  // smell that was just removed from review's phase resolver.
  const latestChange =
    changeId === undefined ? await findLatestWorkflowChangeId(context.repositoryRoot) : { ok: true as const, changeId };
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

  // Read once for the whole build, before any task runs. A `legion approve
  // surface` decision taken between two tasks of one build would otherwise apply
  // to the second and not the first, and a report should be a snapshot of one
  // moment.
  const reaffirmedPin = await loadReaffirmedPins({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });

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
      priorEntries: producedEntries,
      reaffirmedPin
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
  /**
   * Has a named human re-affirmed these bytes for this pinned path?
   *
   * Resolved once for the whole build, from the approvals plane, and threaded in
   * rather than re-read per task: two reads at two instants could answer
   * differently for the same file within one build.
   */
  readonly reaffirmedPin: ReaffirmedPin;
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

  // The verification report, persisted. It existed only in memory, so the
  // `oracle-verification` evidence item had nothing to point at but
  // `executor-result.json` — which is written before the harness runs anything,
  // holds no command results, failing indices or attribution, and can report
  // success while an oracle failed. An auditor following that reference could
  // not substantiate the verdict it was cited for.
  // Derived once, here, and handed to both consumers: the persisted report, so
  // an auditor following the `integration-surface-check` reference can see which
  // surface passed rather than only that one did, and the evidence item, whose
  // verdict is computed from it.
  //
  // The pins are hashed *here*, and the instant is the point. Until this they
  // were hashed at declaration time and again at ship time, never while the
  // command ran — so a satisfied gate established "the declared bytes are on
  // disk now" and "a command passed at some point", and never that the command
  // passed against the declared bytes. Editing the compose file to name an
  // in-memory fake, building, then reverting the edit defeated the exact
  // substitution the declaration exists to make visible.
  const observePin = await mintPinnedReferences({
    repositoryRoot: input.context.repositoryRoot,
    paths: declaredSurfacePinPaths({ task: input.task, verification })
  });
  const surfaceChecks = verificationSurfaceChecks({
    task: input.task,
    verification,
    observePin,
    reaffirmedPin: input.reaffirmedPin
  });

  let verificationArtifactPath: ArtifactPath | undefined;
  if (verification.report !== undefined) {
    verificationArtifactPath = runArtifactPath({
      changeId: input.task.changeId,
      runId,
      fileName: "verification-report.json"
    });
    await writeProjectTextFile({
      repositoryRoot: input.context.repositoryRoot,
      artifactPath: verificationArtifactPath,
      text: stableProtocolJson({
        kind: "verification_report",
        // 2 adds `surfaceChecks`. Additive, so a reader of version 1 still finds
        // everything it knew about.
        schemaVersion: 2,
        runId,
        taskId,
        report: verification.report,
        oracleAttribution: verification.oracleAttribution ?? [],
        // Oracles the task referenced that produced no executable command:
        // inspection oracles, and any whose execution mode is not `command`.
        // Named so the report says what it did not cover.
        unevaluatedOracleRefs: verification.unevaluatedOracleRefs ?? [],
        // Which declared verification surface each command carried, and whether
        // this run reached it. Without this the item cites a file that cannot
        // substantiate the verdict it was cited for.
        surfaceChecks
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
    ...(verificationArtifactPath === undefined ? {} : { verificationArtifactPath }),
    verification,
    surfaceChecks,
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
  readonly verificationArtifactPath?: ArtifactPath;
  /**
   * Derived once by the caller and shared with the persisted verification
   * report, so the item's verdict and the file it cites are the same derivation
   * rather than two that could disagree.
   */
  readonly surfaceChecks: readonly SurfaceCheck[];
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

  // Oracles as their own evidence item, not folded into declared-verification.
  // The two answer different questions: declared verification is "did the
  // contract's own commands pass", oracle satisfaction is "did the criteria the
  // phase was specified against hold". Reporting one verdict for both left the
  // `approved_spec_and_oracle` and `protected_oracle` ship gates with no
  // producer, so any R2+ change was structurally unshippable.
  const attribution = input.verification.oracleAttribution ?? [];
  const unevaluated = input.verification.unevaluatedOracleRefs ?? [];
  if (input.verification.report !== undefined && (attribution.length > 0 || unevaluated.length > 0)) {
    const report = input.verification.report;
    const oracleIndices = new Set(attribution.map((entry) => entry.index));
    const failing = report.failingIndices.filter((index) => oracleIndices.has(index));
    items.push({
      id: "oracle-verification",
      classification: "test-report",
      verdict:
        failing.length > 0
          ? "fail"
          : // Every referenced oracle must have been evaluated. A requirement
            // mixing executable and manual criteria emits both command and
            // inspection oracles; passing the commands says nothing about
            // whether the manual criteria were inspected, and recording that as
            // a pass would satisfy the oracle gate on criteria nobody checked.
            unevaluated.length > 0
            ? "unknown"
            : "pass",
      artifact:
        input.verificationArtifactPath === undefined
          ? resultReference
          : await referenceForFile(input.repositoryRoot, input.verificationArtifactPath),
      traceRefs
    });
  }

  // Whether verification reached the integration or real interface the plan said
  // it would. Its own item, for the reason `oracle-verification` is its own item:
  // "did the contract's commands pass" and "did the ones that cross a boundary
  // pass" are different questions, and the R2 gate that asks the second had no
  // producer at all.
  //
  // Emitted only when at least one declared surface is *not* `unit`, and that is
  // the load-bearing line. The other two states this item could be asked about —
  // nothing declared a surface, and everything declared is `unit` — are decided
  // by the ship gate from the declarations on the contract and the oracles, at
  // ship time, because they are properties of the plan rather than of the run.
  // Deciding "everything is unit" here would have to spell it as a non-pass
  // verdict, and `evidenceItemVerdict` collapses every verdict that is not
  // `pass` or `fail` to absence — so an explicit "nothing here crosses a
  // boundary" would arrive at the gate indistinguishable from silence, which is
  // the exact negative-becomes-absent fail-open this gate exists to close. It
  // would also go stale: the item is written at build time and the declarations
  // can be replanned after it.
  //
  // A failing `unit` surface is deliberately not folded in either. That is
  // already `declared-verification: fail`, and repeating it here would make this
  // gate a second copy of that one.
  const surfaceVerdict =
    input.verification.report === undefined ? undefined : integrationSurfaceVerdict(input.surfaceChecks);
  if (surfaceVerdict !== undefined) {
    items.push({
      id: "integration-surface-check",
      classification: "test-report",
      verdict: surfaceVerdict,
      artifact:
        input.verificationArtifactPath === undefined
          ? resultReference
          : await referenceForFile(input.repositoryRoot, input.verificationArtifactPath),
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
  /** Which executed commands came from which oracle, in command order. */
  readonly oracleAttribution?: readonly OracleAttribution[];
  /**
   * Oracles the task referenced that produced no executable command.
   *
   * A requirement mixing executable and manual criteria emits both command and
   * inspection oracles, and only command-mode ones are attributed. Without this
   * the passing commands alone would record a passing oracle verdict while the
   * manual criteria were never inspected.
   */
  readonly unevaluatedOracleRefs?: readonly string[];
  /**
   * The verification surfaces the task's oracles declare, joined by oracle id.
   *
   * Carried here rather than added to core's `OracleAttribution` for the reason
   * core already gives for keeping attribution off `VerificationCommandResult`:
   * that shape feeds `deriveVerificationReportSha256`, and widening it would move
   * every recorded report hash for a fact the caller can hold instead. It is also
   * threaded out of the one `oraclesForTask` load rather than re-read here — a
   * second read of the same files at a different instant could describe an oracle
   * other than the one that ran.
   */
  readonly oracleSurfaces?: readonly { readonly oracleId: string; readonly surface: VerificationSurface }[];
}

/**
 * What happened to one declared verification surface during this run.
 *
 * `unrun` is a third outcome and not a rounding of `failed`, because the two
 * lead somewhere different: a failed integration command is a negative answer an
 * operator fixes by fixing the code, while a surface whose command never
 * executed is an unanswered question. Collapsing them would report a boundary
 * check as broken when nothing tried it.
 *
 * `mismatched` is the fourth, and it is the one that closes the epoch gap. The
 * pins were hashed when the declaration was authored and are hashed again at
 * ship time — but until this they were never hashed *while the command ran*, so
 * a `pass` established "the declared bytes are on disk now" and "a command
 * passed at some point" without ever establishing that the command passed
 * against the declared bytes. Swap the compose file for one naming an in-memory
 * fake, build, revert, ship: every check answered yes and the run provably
 * executed against the fake. It is `mismatched` rather than `failed` because the
 * code may be perfectly correct — what is unknown is what it was checked
 * against.
 */
type SurfaceOutcome = "passed" | "failed" | "unrun" | "mismatched";

/**
 * Whether a named human has re-affirmed one pinned file at one digest.
 *
 * A function rather than a map, because the rule behind it is the ship gate's own
 * `isLiveSurfaceReaffirmation` — supersession, expiry, a human decider — and this
 * module must not restate it.
 */
type ReaffirmedPin = (path: string, sha256: string) => boolean;

/** One pinned file of a declared surface, as it stood while the run happened. */
interface SurfacePinObservation {
  readonly path: string;
  readonly declared: string;
  /** Absent when no readable file was there when the run finished. */
  readonly observed?: string;
}

interface SurfaceCheck {
  /** Where the declaration came from, in the operator's terms. */
  readonly origin: string;
  readonly kind: string;
  readonly interface: string;
  /** The command index this surface's declaration was attached to, if resolved. */
  readonly index?: number;
  readonly outcome: SurfaceOutcome;
  readonly note?: string;
  /**
   * What the surface's pinned files hashed to at the instant of this run.
   *
   * Recorded only for non-unit surfaces, because those are the only ones the
   * ship gate re-checks. Persisted into the verification report so an auditor
   * following the `integration-surface-check` reference can see *what* the
   * command was checked against, not merely that it passed.
   */
  readonly pins?: readonly SurfacePinObservation[];
}

/**
 * Which declared surfaces this run actually exercised.
 *
 * The index map is core's: the contract's own verification entries occupy
 * indices `0..verification.length-1` in declaration order, then each attributed
 * oracle command follows at the index its `OracleAttribution` records. The
 * contract half of that is a positional covenant spanning two packages, so it is
 * *checked* rather than assumed — the executed command and its arguments must
 * match the entry the surface was declared on, and a mismatch resolves to
 * `unrun`. A wrong answer here would attribute one command's pass to another
 * command's declaration, which is the only way this item can lie.
 *
 * A surface whose index carries no result at all is `unrun`, and that branch is
 * the sharpest one: `synthesizeReport` records `failingIndices: []` for a run
 * that produced no results, so a rule that only intersected failing indices
 * would call a run that executed nothing a pass.
 *
 * Exported for direct testing. The empty-results shape is the one branch a real
 * build cannot produce on demand — a runner that returns nothing is a defect,
 * not a fixture — and it is the branch whose failure mode is a false `pass`, so
 * it is driven from outside rather than left to be reasoned about.
 */
export function verificationSurfaceChecks(input: {
  readonly task: TaskContract;
  readonly verification: ContractVerification;
  /**
   * What each pinned path hashes to *now* — which, at the one call site that
   * matters, is the instant the commands finished.
   *
   * Required rather than optional, and that is the whole point of the parameter.
   * An optional observer would let a caller omit it and get `passed` for a
   * declared surface whose bytes nobody checked, which is the exact fail-open the
   * run-time hash exists to close, reintroduced as a default.
   */
  readonly observePin: MintPinnedReference;
  /**
   * Has a named human re-affirmed these exact bytes for this path?
   *
   * Without this the cure would be self-defeating. A legitimately edited pinned
   * file is re-affirmed at its *new* digest, but the declaration on the task
   * contract still records the old one — so the next build would observe bytes
   * that match no declared digest, record `mismatched` forever, and leave the
   * change blocked by the command that exists to unblock it. The question this
   * asks is the one ship asks: were the bytes the command ran against ones a
   * human declared or re-affirmed?
   */
  readonly reaffirmedPin: ReaffirmedPin;
}): readonly SurfaceCheck[] {
  const report = input.verification.report;
  if (report === undefined) return [];

  const checks: SurfaceCheck[] = [];
  const outcomeAt = (index: number): { readonly outcome: SurfaceOutcome; readonly note?: string } => {
    const result = report.commands.find((command) => command.index === index);
    if (result === undefined) {
      return { outcome: "unrun", note: `No command result was recorded at index ${index}.` };
    }
    if (report.failingIndices.includes(index)) return { outcome: "failed" };
    return { outcome: "passed" };
  };

  /**
   * Did this surface's pinned files hold the declared bytes while the run
   * happened?
   *
   * Asked only of non-unit surfaces: a unit surface's pins are never re-checked
   * by the ship gate, so hashing them here would record a fact nothing reads and
   * would let an unrelated edit downgrade an item the gate does not consult.
   *
   * A mismatch never *upgrades* an outcome, and only ever downgrades `passed`.
   * A command that failed stays `failed` — the operator's first problem is the
   * failure — and `passed` is the only outcome for which "checked against the
   * declared bytes" is load-bearing.
   */
  const observe = (
    surface: VerificationSurface,
    resolved: { readonly outcome: SurfaceOutcome; readonly note?: string }
  ): { readonly outcome: SurfaceOutcome; readonly note?: string; readonly pins?: readonly SurfacePinObservation[] } => {
    if (surface.kind === "unit") return resolved;

    const pins: SurfacePinObservation[] = surface.pinned.map((pin) => {
      const observed = input.observePin(pin.path);
      return {
        path: pin.path,
        declared: pin.sha256,
        ...(observed === undefined ? {} : { observed: observed.sha256 })
      };
    });
    const drifted = pins.filter(
      (pin) =>
        pin.observed !== pin.declared &&
        !(pin.observed !== undefined && input.reaffirmedPin(pin.path, pin.observed))
    );
    if (drifted.length === 0 || resolved.outcome !== "passed") return { ...resolved, pins };

    return {
      outcome: "mismatched",
      note:
        `The command passed, but ${drifted.map((pin) => pin.path).join(", ")} did not hold the declared bytes while it ` +
        "ran, so what it was checked against is not what the declaration describes.",
      pins
    };
  };

  for (const [position, entry] of input.task.verification.entries()) {
    const surface = entry.surface;
    if (surface === undefined) continue;
    const origin = `verification entry ${position + 1}`;
    const result = report.commands.find((command) => command.index === position);
    if (
      result !== undefined &&
      (result.command !== entry.command ||
        result.args.length !== entry.args.length ||
        result.args.some((argument, offset) => argument !== entry.args[offset]))
    ) {
      checks.push({
        origin,
        kind: surface.kind,
        interface: surface.interface,
        index: position,
        ...observe(surface, {
          outcome: "unrun",
          note: `The command recorded at index ${position} is not the one this surface was declared on.`
        })
      });
      continue;
    }
    checks.push({
      origin,
      kind: surface.kind,
      interface: surface.interface,
      index: position,
      ...observe(surface, outcomeAt(position))
    });
  }

  const attribution = input.verification.oracleAttribution ?? [];
  for (const declared of input.verification.oracleSurfaces ?? []) {
    const origin = `oracle ${declared.oracleId}`;
    const attributed = attribution.find((entry) => entry.oracleId === declared.oracleId);
    if (attributed === undefined) {
      checks.push({
        origin,
        kind: declared.surface.kind,
        interface: declared.surface.interface,
        ...observe(declared.surface, {
          outcome: "unrun",
          note: `Oracle ${declared.oracleId} produced no executable command, so its declared surface was never reached.`
        })
      });
      continue;
    }
    checks.push({
      origin,
      kind: declared.surface.kind,
      interface: declared.surface.interface,
      index: attributed.index,
      ...observe(declared.surface, outcomeAt(attributed.index))
    });
  }

  return checks;
}

/**
 * The re-affirmation predicate, resolved from this change's approvals plane.
 *
 * A plane that will not read answers `false` for everything, which is the
 * conservative direction: an unreadable approvals directory becomes "nobody
 * re-affirmed anything", so a drifted pin stays `mismatched` and the item stays
 * `unknown`. The opposite default would let an unreadable directory wave through
 * bytes nobody vouched for.
 */
async function loadReaffirmedPins(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<ReaffirmedPin> {
  let approvals: readonly Approval[] = [];
  try {
    const listed = await listApprovalsForChange(input);
    if (listed.ok && listed.skipped.length === 0) approvals = listed.approvals.map((entry) => entry.document);
  } catch {
    approvals = [];
  }
  if (approvals.length === 0) return () => false;

  const evaluatedAt = currentUtcTimestamp();
  return (path, sha256) =>
    approvals.some((approval) =>
      isLiveSurfaceReaffirmation({
        approval,
        changeId: input.changeId,
        path,
        currentSha256: sha256,
        evaluatedAt
      })
    );
}

/**
 * Every path a non-unit declared surface of this task pins.
 *
 * Read from the same two places `ship-gates.ts` reads declarations from, and
 * from the oracle documents this run actually loaded rather than from a second
 * read — a second read at a different instant could describe an oracle other
 * than the one that ran.
 */
/**
 * The `integration-surface-check` verdict these checks add up to, or `undefined`
 * when no such item should be written at all.
 *
 * **Extracted and exported because it is the join, and the join was the one thing
 * no test could see.** `verificationSurfaceChecks` is covered on one side and the
 * ship gate on the other, but nothing exercised the step that turns an `unrun`
 * check into an `unknown` verdict — and mutation testing proved it: replacing the
 * `unrun` arm with `false`, so that a declared real-interface surface nobody
 * executed is recorded `pass`, left all 812 tests in the tree green. That is the
 * fail-open this function's comments exist to prevent, reintroducible in one
 * token with no alarm anywhere.
 *
 * `undefined` means "write no item", and it is returned when nothing non-unit was
 * declared. That is the load-bearing line. The other two states this item could
 * be asked about — nothing declared a surface, and everything declared is `unit`
 * — are decided by the ship gate from the declarations, at ship time, because
 * they are properties of the plan rather than of the run. Deciding "everything is
 * unit" here would have to spell it as a non-pass verdict, and `evidenceItemVerdict`
 * collapses every verdict that is not `pass` or `fail` to absence — so an explicit
 * "nothing here crosses a boundary" would arrive at the gate spelled exactly like
 * silence, which is the negative-becomes-absent fail-open this gate exists to
 * close. It would also go stale: the item is written at build time and the
 * declarations can be replanned after it.
 *
 * A failing `unit` surface is deliberately not folded in either. That is already
 * `declared-verification: fail`, and repeating it here would make this item a
 * second copy of that one.
 */
export function integrationSurfaceVerdict(
  checks: readonly { readonly kind: string; readonly outcome: SurfaceOutcome }[]
): "pass" | "fail" | "unknown" | undefined {
  const nonUnit = checks.filter((check) => check.kind !== "unit");
  if (nonUnit.length === 0) return undefined;

  if (nonUnit.some((check) => check.outcome === "failed")) return "fail";

  // `unknown`, not `pass`, for two different shapes of not-knowing.
  //
  // `unrun` — a declared surface whose command never executed says nothing about
  // whether the boundary was reached, and `synthesizeReport` records no failing
  // indices for a run that produced no results, so treating "not among the
  // failures" as success would certify a run that ran nothing.
  //
  // `mismatched` — the command passed, but a pinned file did not hold the
  // declared bytes while it ran. What the check exercised is not what the
  // declaration describes, and reverting the file afterwards makes every *later*
  // hash agree while leaving that fact true.
  if (nonUnit.some((check) => check.outcome === "unrun" || check.outcome === "mismatched")) return "unknown";

  return "pass";
}

export function declaredSurfacePinPaths(input: {
  readonly task: TaskContract;
  readonly verification: ContractVerification;
}): readonly string[] {
  const paths = new Set<string>();
  const collect = (surface: VerificationSurface | undefined) => {
    if (surface === undefined || surface.kind === "unit") return;
    for (const pin of surface.pinned) paths.add(pin.path);
  };
  for (const entry of input.task.verification) collect(entry.surface);
  for (const declared of input.verification.oracleSurfaces ?? []) collect(declared.surface);
  return [...paths];
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

  // Every referenced oracle that produced no executable command. Inspection
  // oracles are the common case; so is an executable oracle whose execution mode
  // is not `command`. Naming them is what keeps the verdict honest: the report
  // says which criteria it did not cover, instead of a passing command set
  // standing in for criteria nobody inspected.
  const attributed = new Set(oracleAttribution.map((entry) => entry.oracleId));
  const unevaluatedOracleRefs = oracles.loaded
    .filter((oracle) => !attributed.has(oracle.id))
    .map((oracle) => oracle.id);

  // Taken from the documents that were loaded for this run, not re-read. This is
  // the only place that holds them: `oraclesForTask` returns full `Oracle`s and
  // everything downstream sees ids and titles.
  const oracleSurfaces = oracles.loaded.flatMap((oracle) =>
    oracle.surface === undefined ? [] : [{ oracleId: oracle.id, surface: oracle.surface }]
  );

  return {
    report,
    passed: report.passed,
    oracleAttribution,
    unevaluatedOracleRefs,
    oracleSurfaces,
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
