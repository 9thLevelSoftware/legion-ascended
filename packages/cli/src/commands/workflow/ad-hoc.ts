import { readFile } from "node:fs/promises";
import path from "node:path";

import { stableProtocolJson } from "@legion/artifacts";
import { artifactPathSchema, taskContractScopePathSchema } from "@legion/protocol";

import {
  failure,
  helpResult,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { createAdHocTaskgraph } from "../../workflow/ad-hoc-taskgraph.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import { writeProjectTextFile } from "../../workflow/executor/index.js";
import {
  createGuidanceRunPaths,
  guidanceArtifactPath,
  guidanceCreatedAt,
  guidancePrompt,
  renderGuidanceMarkdown,
  runGuidanceExecutor,
  writeGuidanceRun
} from "../../workflow/guidance-run.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { positionalText } from "./record.js";

const HELP = {
  quick: "legion quick <task>\n\nCreate a typed ad-hoc taskgraph and route it through legion build.",
  advise: "legion advise <topic> [--executor codex|manual|fake]\n\nRun read-only advisory analysis and write guidance artifacts.",
  polish: "legion polish [target]\n\nCreate a typed polish taskgraph scoped to the target or current worktree.",
  learn: "legion learn <lesson>\n\nRecord project-specific operational learning and update the knowledge index."
} as const;

export type AdHocWorkflowCommand = keyof typeof HELP;

interface LessonIndex {
  readonly schemaVersion: 1;
  readonly kind: "lesson_index";
  readonly lessons: readonly {
    readonly id: string;
    readonly lesson: string;
    readonly createdAt: string;
    readonly artifactPath: string;
  }[];
}

export async function handleAdHocWorkflow(
  context: CliContext,
  command: AdHocWorkflowCommand
): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(HELP[command]);
  }

  switch (command) {
    case "quick":
      return createTypedAdHocWorkflow(context, "quick");
    case "polish":
      return createTypedAdHocWorkflow(context, "polish");
    case "advise":
      return runAdviceWorkflow(context);
    case "learn":
      return runLearnWorkflow(context);
  }
}

async function createTypedAdHocWorkflow(context: CliContext, kind: "quick" | "polish"): Promise<CliResult> {
  const text = positionalText(context);
  if (kind === "quick" && text === undefined) return usageError('legion quick requires a task. Example: legion quick "fix the failing tests".');
  const loadedProject = await loadWorkflowProject(context);
  if (!loadedProject.ok) {
    const action = nextAction("legion start", "Ad-hoc work requires initialized project state.");
    return failure(
      {
        ok: false,
        status: "blocked",
        diagnostics: loadedProject.diagnostics,
        nextAction: action
      },
      ["Ad-hoc task creation is blocked.", renderDiagnostics(loadedProject.diagnostics), renderNextAction(action)].join("\n")
    );
  }

  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const target = text ?? "current changed files";
  const title = kind === "quick" ? `Quick task: ${target}` : `Polish: ${target}`;
  const objective = kind === "quick"
    ? `Complete this ad-hoc task with minimal, verified changes: ${target}`
    : `Polish ${target} for clarity, simplicity, naming, comments, and consistency without changing intended behavior.`;
  const targetPath = kind === "polish" && text !== undefined ? text.trim() : undefined;
  if (targetPath !== undefined && !taskContractScopePathSchema.safeParse(targetPath).success) {
    return usageError(`Invalid polish target path: ${targetPath}`);
  }
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: kind,
    slugSource: target,
    createdAt
  });
  const requestArtifactPath = guidanceArtifactPath(paths, "request.md");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: requestArtifactPath,
    text: [
      `# ${title}`,
      "",
      "## Objective",
      "",
      objective,
      "",
      "## Human Boundary",
      "",
      "This command prepares typed work. Execution still happens through `legion build`, and acceptance still requires `legion review --accept`.",
      ""
    ].join("\n")
  });

  const planned = await createAdHocTaskgraph({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    kind,
    title,
    objective,
    sourceArtifactPath: requestArtifactPath,
    idSlug: paths.runId,
    createdAt,
    readScope: targetPath === undefined ? [requestArtifactPath] : [targetPath, requestArtifactPath],
    ...(targetPath === undefined ? {} : { writeScope: [targetPath] }),
    verificationCommand: ["legion", "validate"]
  });
  if (!planned.ok) {
    const action = nextAction("legion validate", "Ad-hoc task artifacts must be repaired before build.");
    return failure(
      {
        ...planned,
        nextAction: action
      },
      ["Ad-hoc taskgraph creation failed.", renderDiagnostics(planned.diagnostics), renderNextAction(action)].join("\n")
    );
  }

  const action = nextAction("legion build", "The ad-hoc taskgraph is ready for guided execution.");
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status: "planned",
    runInput: { text: text ?? null, kind },
    outputs: {
      requestArtifactPath,
      changeId: planned.change.bundle.change.id,
      changeArtifactPath: planned.change.artifactPath,
      oracleArtifactPath: planned.oracle.artifactPath,
      taskgraphArtifactPath: planned.taskgraph.artifactPath,
      taskIds: planned.taskgraph.document.tasks.map((task) => task.id)
    },
    nextAction: action
  });

  return success(
    {
      ok: true,
      status: "planned",
      workflow: kind,
      runId: paths.runId,
      artifactPath: paths.workflowRunArtifactPath,
      requestArtifactPath,
      change: {
        changeId: planned.change.bundle.change.id,
        artifactPath: planned.change.artifactPath
      },
      taskgraph: {
        artifactPath: planned.taskgraph.artifactPath,
        taskIds: planned.taskgraph.document.tasks.map((task) => task.id)
      },
      nextAction: action,
      diagnostics: []
    },
    [
      `${kind === "quick" ? "Quick task" : "Polish task"} planned.`,
      `Taskgraph: ${planned.taskgraph.artifactPath}`,
      renderNextAction(action)
    ].join("\n")
  );
}

async function runAdviceWorkflow(context: CliContext): Promise<CliResult> {
  const topic = positionalText(context);
  if (topic === undefined) return usageError('legion advise requires a topic. Example: legion advise "release risk".');
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "advise",
    slugSource: topic,
    createdAt
  });
  const prompt = guidancePrompt({
    workflow: "advise",
    topic,
    requiredSections: ["Context", "Recommendation", "Risks", "Next Actions"]
  });
  const executed = await runGuidanceExecutor({
    context,
    paths,
    workflow: "advise",
    topic,
    prompt,
    readOnly: true,
    explicitExecutor: stringOption(context, "executor")
  });
  if ("exitCode" in executed) return executed;

  const markdownArtifactPath = guidanceArtifactPath(paths, "advice.md");
  const markdown = renderGuidanceMarkdown({
    title: "Advisory Analysis",
    topic,
    summary: executed.result.summary,
    sections: [
      { heading: "Recommendation", body: executed.result.summary },
      { heading: "Risks", body: executed.result.findings.length === 0 ? ["No blocking findings were reported by the executor."] : executed.result.findings.map((finding) => finding.body) },
      { heading: "Next Actions", body: ["Convert the advice into `legion plan`, `legion quick`, or no action after human review."] }
    ]
  });
  await writeProjectTextFile({ repositoryRoot: context.repositoryRoot, artifactPath: markdownArtifactPath, text: markdown });
  const action = nextAction("legion status", "Review the advisory artifact before changing workflow state.");
  const status = executed.result.ok ? "completed" : "blocked";
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status,
    runInput: { topic },
    outputs: {
      markdownArtifactPath,
      promptArtifactPath: executed.promptArtifactPath,
      resultArtifactPath: executed.resultArtifactPath,
      rawLogArtifactPath: executed.rawLogArtifactPath,
      redactedLogArtifactPath: executed.redactedLogArtifactPath
    },
    nextAction: action,
    executor: executed.executor,
    diagnostics: executed.result.findings
  });
  const payload = {
    ok: executed.result.ok,
    status,
    workflow: "advise",
    runId: paths.runId,
    artifactPath: paths.workflowRunArtifactPath,
    markdownArtifactPath,
    executor: executed.executor,
    nextAction: action,
    diagnostics: executed.result.findings
  };
  const human = [`Advice: ${status}.`, `Artifact: ${markdownArtifactPath}`, renderNextAction(action)].join("\n");
  return executed.result.ok ? success(payload, human) : failure(payload, human);
}

async function runLearnWorkflow(context: CliContext): Promise<CliResult> {
  const lesson = positionalText(context);
  if (lesson === undefined) return usageError('legion learn requires a lesson. Example: legion learn "prefer artifact-backed plans".');
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "learn",
    slugSource: lesson,
    createdAt
  });
  const lessonArtifactPath = guidanceArtifactPath(paths, "lesson.md");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: lessonArtifactPath,
    text: [`# Lesson`, "", lesson, ""].join("\n")
  });
  const index = await readLessonIndex(context.repositoryRoot);
  const nextIndex: LessonIndex = {
    ...index,
    lessons: [
      ...index.lessons,
      {
        id: paths.runId,
        lesson,
        createdAt,
        artifactPath: lessonArtifactPath
      }
    ]
  };
  const indexArtifactPath = artifactPathSchema.parse(".legion/project/workflow/learn/knowledge-index.json");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: indexArtifactPath,
    text: stableProtocolJson(nextIndex)
  });
  const action = nextAction("legion status", "The lesson is available to future context packs.");
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status: "completed",
    runInput: { lesson },
    outputs: {
      lessonArtifactPath,
      indexArtifactPath,
      lessonCount: nextIndex.lessons.length
    },
    nextAction: action
  });
  return success(
    {
      ok: true,
      status: "completed",
      workflow: "learn",
      runId: paths.runId,
      artifactPath: paths.workflowRunArtifactPath,
      lessonArtifactPath,
      indexArtifactPath,
      lessonCount: nextIndex.lessons.length,
      nextAction: action,
      diagnostics: []
    },
    [
      "Lesson recorded.",
      `Artifact: ${lessonArtifactPath}`,
      renderNextAction(action)
    ].join("\n")
  );
}

async function readLessonIndex(repositoryRoot: string): Promise<LessonIndex> {
  const indexPath = path.join(repositoryRoot, ".legion", "project", "workflow", "learn", "knowledge-index.json");
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as LessonIndex;
    if (parsed.kind === "lesson_index" && Array.isArray(parsed.lessons)) return parsed;
  } catch {
    // Missing or malformed lesson state is treated as empty; validate can report broader project corruption.
  }
  return {
    schemaVersion: 1,
    kind: "lesson_index",
    lessons: []
  };
}
