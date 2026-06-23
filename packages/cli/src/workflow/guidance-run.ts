import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { loadProject, stableProtocolJson } from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  artifactPathSchema,
  formatEntityId,
  taskContractSchema,
  type ArtifactPath,
  type ProjectId,
  type UtcTimestamp
} from "@legion/protocol";

import { createdAtOption, slugFromName } from "./input.js";
import { nextAction, type NextAction } from "./render.js";
import { adapterForKind, selectExecutionAdapterKind, writeProjectTextFile, type ExecutionAdapterKind, type ExecutionResult } from "./executor/index.js";
import { prepareProjectTextFile } from "./executor/result.js";
import type { CliContext, CliResult } from "../runtime.js";
import { usageError } from "../runtime.js";

export type GuidanceWorkflow =
  | "explore"
  | "map"
  | "advise"
  | "council"
  | "retro"
  | "learn"
  | "milestone"
  | "quick"
  | "polish";

export type GuidanceRunStatus = "completed" | "planned" | "blocked" | "stale" | "accepted";

export interface GuidanceRunPaths {
  readonly workflow: GuidanceWorkflow;
  readonly runId: string;
  readonly createdAt: UtcTimestamp;
  readonly artifactRoot: ArtifactPath;
  readonly workflowRunArtifactPath: ArtifactPath;
}

export interface GuidanceRunDocument {
  readonly schemaVersion: 1;
  readonly kind: "workflow_run";
  readonly workflow: GuidanceWorkflow;
  readonly runId: string;
  readonly createdAt: UtcTimestamp;
  readonly status: GuidanceRunStatus;
  readonly input: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly nextAction: NextAction;
  readonly executor?: ExecutionAdapterKind;
  readonly diagnostics: readonly unknown[];
}

export interface GuidanceExecutorRun {
  readonly executor: ExecutionAdapterKind;
  readonly result: ExecutionResult;
  readonly promptArtifactPath: ArtifactPath;
  readonly resultArtifactPath: ArtifactPath;
  readonly rawLogArtifactPath: ArtifactPath;
  readonly redactedLogArtifactPath: ArtifactPath;
}

export function guidanceCreatedAt(context: CliContext): UtcTimestamp | CliResult {
  if (context.args.options.get("created-at") === true) {
    return usageError("Missing required value for --created-at. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z.");
  }
  try {
    return createdAtOption(context) ?? new Date().toISOString() as UtcTimestamp;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --created-at value. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z. ${message}`);
  }
}

export async function createGuidanceRunPaths(input: {
  readonly repositoryRoot: string;
  readonly workflow: GuidanceWorkflow;
  readonly slugSource: string;
  readonly createdAt: UtcTimestamp;
}): Promise<GuidanceRunPaths> {
  const workflowRoot = path.join(input.repositoryRoot, ".legion", "project", "workflow", input.workflow);
  await mkdir(workflowRoot, { recursive: true });

  const safeTimestamp = input.createdAt.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+$/g, "");
  const slug = slugFromName(input.slugSource);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const runId = `${safeTimestamp}-${slug}${suffix}`;
    const artifactRoot = artifactPathSchema.parse(`.legion/project/workflow/${input.workflow}/${runId}`);
    const absoluteRunRoot = path.join(input.repositoryRoot, ...artifactRoot.split("/"));
    try {
      await mkdir(absoluteRunRoot);
      return {
        workflow: input.workflow,
        runId,
        createdAt: input.createdAt,
        artifactRoot,
        workflowRunArtifactPath: artifactPathSchema.parse(`${artifactRoot}/workflow-run.json`)
      };
    } catch (error) {
      if (isNodeErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }

  throw new Error(`Unable to create a unique workflow run for ${input.workflow} after 1000 attempts.`);
}

export function guidanceArtifactPath(paths: GuidanceRunPaths, fileName: string): ArtifactPath {
  return artifactPathSchema.parse(`${paths.artifactRoot}/${fileName}`);
}

export async function writeGuidanceRun(input: {
  readonly repositoryRoot: string;
  readonly paths: GuidanceRunPaths;
  readonly status: GuidanceRunStatus;
  readonly runInput: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly nextAction: NextAction;
  readonly executor?: ExecutionAdapterKind;
  readonly diagnostics?: readonly unknown[];
}): Promise<GuidanceRunDocument> {
  const document: GuidanceRunDocument = {
    schemaVersion: 1,
    kind: "workflow_run",
    workflow: input.paths.workflow,
    runId: input.paths.runId,
    createdAt: input.paths.createdAt,
    status: input.status,
    input: input.runInput,
    outputs: input.outputs,
    nextAction: input.nextAction,
    ...(input.executor === undefined ? {} : { executor: input.executor }),
    diagnostics: input.diagnostics ?? []
  };
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.paths.workflowRunArtifactPath,
    text: stableProtocolJson(document)
  });
  return document;
}

export async function runGuidanceExecutor(input: {
  readonly context: CliContext;
  readonly paths: GuidanceRunPaths;
  readonly workflow: GuidanceWorkflow;
  readonly topic: string;
  readonly prompt: string;
  readonly readOnly: boolean;
  readonly explicitExecutor: string | undefined;
}): Promise<GuidanceExecutorRun | CliResult> {
  const selected = await selectExecutionAdapterKind(input.explicitExecutor);
  if (typeof selected !== "string") return usageError(selected.diagnostic.message);

  const contextPackArtifactPath = guidanceArtifactPath(input.paths, "guidance-context.md");
  const promptArtifactPath = guidanceArtifactPath(input.paths, "executor-prompt.md");
  const resultArtifactPath = guidanceArtifactPath(input.paths, "executor-result.json");
  const rawLogArtifactPath = guidanceArtifactPath(input.paths, "executor-raw.log");
  const redactedLogArtifactPath = guidanceArtifactPath(input.paths, "executor-redacted.log");

  const contextPack = [
    `# Legion ${input.workflow} Context`,
    "",
    `Workflow: ${input.workflow}`,
    `Topic: ${input.topic}`,
    `Repository: ${input.context.repositoryRoot}`,
    `Run: ${input.paths.runId}`,
    ""
  ].join("\n");
  await writeProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: contextPackArtifactPath,
    text: contextPack
  });
  await writeProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: promptArtifactPath,
    text: input.prompt
  });

  const contextPackAbsolutePath = await prepareProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: contextPackArtifactPath
  });
  const promptAbsolutePath = await prepareProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: promptArtifactPath
  });
  const resultAbsolutePath = await prepareProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: resultArtifactPath
  });
  const rawLogAbsolutePath = await prepareProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: rawLogArtifactPath
  });
  const redactedLogAbsolutePath = await prepareProjectTextFile({
    repositoryRoot: input.context.repositoryRoot,
    artifactPath: redactedLogArtifactPath
  });

  const projectId = await guidanceProjectId(input.context.repositoryRoot);
  const changeId = formatEntityId("change", `guidance-${input.workflow}`);
  const requirementId = formatEntityId("requirement", `guidance-${input.workflow}`);
  const oracleId = formatEntityId("oracle", `guidance-${input.workflow}`);
  const task = taskContractSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.paths.createdAt,
    kind: "task-contract",
    id: formatEntityId("contract", `guidance-${input.workflow}`),
    projectId,
    changeId,
    revision: 1,
    title: `Legion ${input.workflow}: ${input.topic}`,
    objective: input.prompt,
    requirementIds: [requirementId],
    wave: "A",
    agents: ["workflow-guide"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [],
      predecessorArtifacts: []
    },
    scope: {
      read: [contextPackArtifactPath],
      write: [resultArtifactPath],
      forbidden: [".git", "node_modules", ".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [{ name: "GuidanceRequest", description: "The workflow guidance request." }],
      produces: [{ name: "GuidanceResult", description: "The structured guidance result." }]
    },
    oracleRefs: [oracleId],
    verification: [
      {
        command: "legion",
        args: ["status"],
        expectedExitCode: 0,
        timeoutMs: 120_000
      }
    ],
    risk: {
      tier: "R1",
      reasons: ["Guidance commands are human-in-loop and do not publish or release."]
    },
    approvals: [],
    completion: {
      expectedArtifacts: [],
      requiredEvidence: ["guidance markdown artifact"],
      blockedConditions: ["The executor cannot produce guidance."]
    }
  });

  const result = await adapterForKind(selected).run({
    repositoryRoot: input.context.repositoryRoot,
    changeId,
    runId: formatEntityId("run", guidanceEntitySuffix(input.workflow, input.paths.runId)),
    task,
    mode: input.workflow === "retro" ? "review" : "build",
    executor: selected,
    readOnly: input.readOnly,
    prompt: input.prompt,
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

  return {
    executor: selected,
    result,
    promptArtifactPath,
    resultArtifactPath,
    rawLogArtifactPath,
    redactedLogArtifactPath
  };
}

export async function latestGuidanceRuns(input: {
  readonly repositoryRoot: string;
  readonly workflows?: readonly GuidanceWorkflow[];
  readonly limitPerWorkflow?: number;
}): Promise<readonly GuidanceRunDocument[]> {
  const workflows = input.workflows ?? ["explore", "map", "advise", "council", "retro", "learn", "milestone", "quick", "polish"];
  const limit = input.limitPerWorkflow ?? 3;
  const runs: GuidanceRunDocument[] = [];
  for (const workflow of workflows) {
    const workflowRoot = path.join(input.repositoryRoot, ".legion", "project", "workflow", workflow);
    let entries;
    try {
      entries = await readdir(workflowRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) continue;
      throw error;
    }

    const workflowRuns: GuidanceRunDocument[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(workflowRoot, entry.name, "workflow-run.json");
      try {
        const parsed = JSON.parse(await readFile(runPath, "utf8")) as GuidanceRunDocument;
        if (parsed.kind === "workflow_run" && parsed.workflow === workflow) workflowRuns.push(parsed);
      } catch {
        continue;
      }
    }
    workflowRuns.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
    runs.push(...workflowRuns.slice(0, limit));
  }
  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
  return runs;
}

export async function guidanceProjectId(repositoryRoot: string): Promise<ProjectId> {
  const project = await loadProject({ repositoryRoot });
  if (project.ok) return project.project.id;
  return formatEntityId("project", "guidance");
}

function guidanceEntitySuffix(workflow: GuidanceWorkflow, runId: string): string {
  const prefix = `guidance-${workflow}-`;
  const maxSlugLength = Math.max(2, 63 - prefix.length);
  return `${prefix}${slugFromName(runId).slice(0, maxSlugLength).replace(/-+$/g, "")}`;
}

export function guidancePrompt(input: {
  readonly workflow: GuidanceWorkflow;
  readonly topic: string;
  readonly requiredSections: readonly string[];
}): string {
  return [
    `# Legion ${input.workflow}`,
    "",
    "You are preparing human-in-loop workflow guidance. Do not publish, deploy, release, or mutate unrelated project files.",
    "",
    `Topic: ${input.topic}`,
    "",
    "Return a JSON object compatible with the Legion executor result schema:",
    '{ "status": "succeeded", "summary": "...", "filesChanged": [], "commandsRun": [], "findings": [] }',
    "",
    "The summary must cover these sections:",
    ...input.requiredSections.map((section) => `- ${section}`),
    ""
  ].join("\n");
}

export function renderGuidanceMarkdown(input: {
  readonly title: string;
  readonly topic: string;
  readonly summary: string;
  readonly sections: readonly { readonly heading: string; readonly body: string | readonly string[] }[];
}): string {
  const lines = [`# ${input.title}`, "", `Topic: ${input.topic}`, "", "## Summary", "", input.summary, ""];
  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, "");
    if (typeof section.body === "string") {
      lines.push(section.body, "");
    } else {
      lines.push(...section.body.map((entry) => `- ${entry}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
