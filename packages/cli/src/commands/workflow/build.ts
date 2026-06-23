import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  artifactReferenceForContent,
  hashContent,
  readEvidenceIndex,
  readTaskGraph,
  stableProtocolJson,
  listTaskRunsForChange,
  writeEvidenceIndex,
  writeTaskRun,
  type EvidenceIndexEntry,
  type TaskRunSuccess
} from "@legion/artifacts";
import { RuntimeLocalDriver } from "@legion/core";
import {
  LEGION_PROTOCOL_VERSION,
  buildIdempotencyKey,
  taskRunSchema,
  type ArtifactPath,
  type ArtifactReference,
  type EvidenceBundle,
  type EvidenceCommandResult,
  type EvidenceItem,
  type TaskContract,
  type TaskRun,
  type UtcTimestamp
} from "@legion/protocol";

import { failure, hasFlag, stringOption, success, type CliContext, type CliResult } from "../../runtime.js";
import { buildExecutionPrompt, writeContextPack } from "../../workflow/context-pack.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { adapterForKind, selectExecutionAdapterKind, writeProjectTextFile, type ExecutionAdapterKind, type ExecutionResult } from "../../workflow/executor/index.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import {
  absoluteArtifactPath,
  evidenceIdForRun,
  runArtifactPath,
  runIdForTask,
  taskIdForContractId
} from "../../workflow/run-artifacts.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

export async function handleBuildWorkflow(context: CliContext): Promise<CliResult> {
  const planAction = nextAction(
    "legion plan 1",
    "A typed task graph is required before build can run."
  );

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
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
      createdAt,
      startedAt: createdAt,
      baseGitSha,
      contextPack
    })
  });
  if (!started.ok) return { ok: false, diagnostics: started.diagnostics };

  const adapter = adapterForKind(input.executor);
  const result = await adapter.run({
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
  });

  const finishedAt = currentUtcTimestamp();
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
    taskgraphPath: input.taskgraph.artifactPath
  });
  const completed = await writeTaskRun({
    repositoryRoot: input.context.repositoryRoot,
    expectedRevision: started.revision.revision,
    baseGitSha,
    document: taskRunDocument({
      status: result.status === "blocked" ? "blocked" : result.ok ? "succeeded" : "failed",
      task: input.task,
      taskId,
      runId,
      attempt: input.attempt,
      executor: input.executor,
      createdAt,
      startedAt: createdAt,
      finishedAt,
      baseGitSha,
      contextPack,
      evidenceRefs: [evidenceId],
      error: result.ok
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

  if (!result.ok) {
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
        {
          code: result.status === "blocked" ? "executor_blocked" : "executor_failed",
          message: result.summary,
          path: resultArtifactPath
        }
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
    workerBundle: {
      id: "workflow-executor",
      version: LEGION_PROTOCOL_VERSION,
      role: "implementer",
      domain: "codebase",
      capabilities: ["build"],
      promptContentContract: {
        instructionsHash: hashContent(input.contextPack),
        requiredSections: ["objective", "scope", "harness-rules"],
        forbiddenSections: ["biography", "tone", "personality"]
      }
    },
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
}): Promise<EvidenceIndexEntry> {
  const resultReference = await referenceForFile(input.repositoryRoot, input.resultArtifactPath);
  const logReference = await referenceForFile(input.repositoryRoot, input.redactedLogArtifactPath);
  const logBytes = await readFile(absoluteArtifactPath(input.repositoryRoot, input.redactedLogArtifactPath));
  const command = commandForEvidence(input.result, logBytes, input.startedAt, input.finishedAt);
  const traceRefs = [
    {
      path: input.taskgraphPath,
      relation: "records" as const,
      entity: { kind: "change" as const, id: input.task.changeId }
    }
  ];
  const items: EvidenceItem[] = [
    {
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
    status: input.result.ok ? "collected" : "failed",
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
