import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  listCurrentSpecs,
  loadChangeBundle,
  loadProject,
  stableProtocolJson,
  type TaskGraphSuccess
} from "@legion/artifacts";
import type { ArtifactPath, ChangeId, RunId, TaskContract } from "@legion/protocol";

import { writeTextFile } from "./executor/result.js";

export interface ContextPackInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
  readonly runId: RunId | string;
  readonly taskgraph: TaskGraphSuccess;
  readonly task: TaskContract;
  readonly artifactPath: ArtifactPath;
  readonly absolutePath: string;
}

export async function writeContextPack(input: ContextPackInput): Promise<string> {
  const content = await renderContextPack(input);
  await writeTextFile(input.absolutePath, content);
  return content;
}

export function buildExecutionPrompt(input: {
  readonly mode: "build" | "review" | "fix";
  readonly contextPackArtifactPath: ArtifactPath;
  readonly task: TaskContract;
  readonly requiredOutput: string;
}): string {
  return [
    `# Legion ${input.mode} task`,
    "",
    "You are executing a Legion guided workflow step with a human in the loop.",
    "Use the supplied context pack as the authoritative task context.",
    "",
    `Context pack: ${input.contextPackArtifactPath}`,
    "",
    "## Objective",
    "",
    input.task.objective,
    "",
    "## Scope",
    "",
    "Read scope:",
    ...input.task.scope.read.map((entry) => `- ${entry}`),
    "",
    "Write scope:",
    ...input.task.scope.write.map((entry) => `- ${entry}`),
    "",
    "Forbidden scope:",
    ...input.task.scope.forbidden.map((entry) => `- ${entry}`),
    "",
    "## Harness Rules",
    "",
    "- Read before write.",
    "- Evidence before action.",
    "- Keep the diff minimal and scoped to the task contract.",
    "- Verify before report.",
    "- Do not publish, release, or perform unrelated cleanup.",
    "",
    "## Required JSON Result",
    "",
    input.requiredOutput,
    ""
  ].join("\n");
}

async function renderContextPack(input: ContextPackInput): Promise<string> {
  const [project, change, specs, workflowRecords] = await Promise.all([
    loadProject({ repositoryRoot: input.repositoryRoot }),
    loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId: input.changeId }),
    listCurrentSpecs({ repositoryRoot: input.repositoryRoot }),
    readRecentWorkflowRecords(input.repositoryRoot)
  ]);

  return [
    `# Legion Context Pack: ${input.runId}`,
    "",
    "## Project",
    "",
    project.ok ? fencedJson(project.project) : renderDiagnostics(project.diagnostics),
    "",
    "## Change",
    "",
    change.ok ? fencedJson(change.bundle.change) : renderDiagnostics(change.diagnostics),
    "",
    "## Task",
    "",
    fencedJson(input.task),
    "",
    "## Taskgraph",
    "",
    fencedJson({
      artifactPath: input.taskgraph.artifactPath,
      revision: input.taskgraph.revision,
      taskCount: input.taskgraph.document.tasks.length
    }),
    "",
    "## Current Specs",
    "",
    specs.ok
      ? fencedJson(specs.index.entries.map((entry) => ({
          artifactPath: entry.path,
          primaryRequirementId: entry.primaryRequirementId,
          capability: entry.capability
        })))
      : renderDiagnostics(specs.diagnostics),
    "",
    "## Recent Workflow Records",
    "",
    workflowRecords.length === 0 ? "No recent workflow records found." : workflowRecords.join("\n\n"),
    "",
    "## Verification Commands",
    "",
    ...input.task.verification.map((entry) => `- ${[entry.command, ...entry.args].join(" ")} (expected ${entry.expectedExitCode})`),
    ""
  ].join("\n");
}

function fencedJson(value: unknown): string {
  return ["```json", stableProtocolJson(value).trimEnd(), "```"].join("\n");
}

function renderDiagnostics(diagnostics: readonly unknown[]): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  return diagnostics.map((diagnostic) => `- ${diagnosticMessage(diagnostic)}`).join("\n");
}

function diagnosticMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) return String((value as { readonly message: unknown }).message);
  return String(value);
}

async function readRecentWorkflowRecords(repositoryRoot: string): Promise<readonly string[]> {
  const workflows = ["learn", "map", "explore", "advise"] as const;
  const records: string[] = [];
  for (const workflow of workflows) {
    const workflowRoot = path.join(repositoryRoot, ".legion", "project", "workflow", workflow);
    let entries;
    try {
      entries = await readdir(workflowRoot, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((candidate) => candidate.isFile()).sort((left, right) => right.name.localeCompare(left.name)).slice(0, 3)) {
      const absolutePath = path.join(workflowRoot, entry.name);
      let text = "";
      try {
        text = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      records.push([
        `### ${workflow}/${entry.name}`,
        "",
        "```json",
        truncate(text.trim(), 4_000),
        "```"
      ].join("\n"));
    }
  }
  return records;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... [truncated]`;
}
