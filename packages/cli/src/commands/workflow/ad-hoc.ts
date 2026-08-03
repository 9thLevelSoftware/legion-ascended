import { readFile } from "node:fs/promises";
import path from "node:path";

import { LEGION_PROJECT_ROOT, readRequirementSet, stableProtocolJson } from "@legion/artifacts";
import { artifactPathSchema, taskContractScopePathSchema } from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { createAdHocTaskgraph } from "../../workflow/ad-hoc-taskgraph.js";
import { pathIsCoveredBy } from "../../workflow/diff-reconciliation.js";
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

/**
 * What a lesson is, rather than what it says.
 *
 * `commands/learn.md` classifies every lesson as one of these and groups by them
 * in `--list`. The CLI recorded `{id, lesson, createdAt, artifactPath}` and
 * nothing else, so the taxonomy did not exist in the data model and the two
 * modes built on it could not be implemented over it.
 */
export const LESSON_KINDS = ["pattern", "pitfall", "preference"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

interface LessonRecord {
  readonly id: string;
  readonly lesson: string;
  readonly createdAt: string;
  readonly artifactPath: string;
  readonly kind?: LessonKind;
  /** Recall scores a tag match 3 and a summary match 2, so both must persist. */
  readonly tags?: readonly string[];
  readonly summary?: string;
}

interface LessonIndex {
  readonly schemaVersion: 1;
  readonly kind: "lesson_index";
  readonly lessons: readonly LessonRecord[];
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
  // Control artifacts are forbidden to implementation work, so a target inside
  // them would plan successfully and then fail every edit as
  // `forbidden_path_touched`. The schema's overlap check compares scope entries
  // for exact equality and cannot see that a target is nested under a forbidden
  // prefix, so reject it here rather than emit a contract nothing can satisfy.
  if (targetPath !== undefined && pathIsCoveredBy(targetPath, LEGION_PROJECT_ROOT)) {
    return usageError(
      `Cannot polish ${targetPath}: ${LEGION_PROJECT_ROOT} holds Legion control artifacts, which implementation tasks may not write. Edit it directly, or use the workflow command that owns it.`
    );
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

  // The project's recorded blast-radius limit, so ad-hoc work cannot be granted
  // more room than a planned phase just because it arrived through a different
  // command. Absent for projects that held no interview, which keep the derived
  // budget.
  const requirementSet = await readRequirementSet(context.repositoryRoot);
  const enforcementBudget = requirementSet.ok ? requirementSet.set.enforcement?.budget : undefined;

  const planned = await createAdHocTaskgraph({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    kind,
    title,
    objective,
    sourceArtifactPath: requestArtifactPath,
    idSlug: paths.runId,
    createdAt,
    readScope: targetPath === undefined ? [".", requestArtifactPath] : [targetPath, requestArtifactPath],
    ...(targetPath === undefined ? {} : { writeScope: [targetPath] }),
    verificationCommand: ["legion", "validate"],
    ...(enforcementBudget === undefined ? {} : { enforcementBudget })
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
  const recall = stringOption(context, "recall")?.trim();
  if (context.args.options.get("recall") === true || recall === "") {
    return usageError('Missing required value for --recall. Example: legion learn --recall "taskgraph".');
  }
  if (recall !== undefined) return runLearnRecall(context, recall);
  if (hasFlag(context, "list")) return runLearnList(context);

  const lesson = positionalText(context);
  if (lesson === undefined) return usageError('legion learn requires a lesson. Example: legion learn "prefer artifact-backed plans".');

  const kindOption = stringOption(context, "type")?.trim();
  if (context.args.options.get("type") === true || kindOption === "") {
    return usageError(`Missing required value for --type. One of ${LESSON_KINDS.join(", ")}.`);
  }
  if (kindOption !== undefined && !LESSON_KINDS.includes(kindOption as LessonKind)) {
    return usageError(`Unknown lesson type: ${kindOption}. One of ${LESSON_KINDS.join(", ")}.`);
  }
  const kind = kindOption as LessonKind | undefined;

  const tagOption = stringOption(context, "tags")?.trim();
  if (context.args.options.get("tags") === true || tagOption === "") {
    return usageError('Missing required value for --tags. Example: legion learn "..." --tags planning,evidence.');
  }
  const tags = tagOption === undefined
    ? []
    : [...new Set(tagOption.split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];

  const summaryOption = stringOption(context, "summary")?.trim();
  if (context.args.options.get("summary") === true || summaryOption === "") {
    return usageError('Missing required value for --summary. Example: legion learn "..." --summary "one line".');
  }
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
        artifactPath: lessonArtifactPath,
        ...(kind === undefined ? {} : { kind }),
        ...(tags.length === 0 ? {} : { tags }),
        ...(summaryOption === undefined ? {} : { summary: summaryOption })
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
      ...(kind === undefined ? {} : { kind }),
      ...(tags.length === 0 ? {} : { tags }),
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

/**
 * Scored search over recorded learning.
 *
 * The scoring rule is the command's: a tag match counts 3, a summary match 2,
 * and a body match 1. It is deterministic and the corpus is CLI-owned, so it
 * belongs here rather than in a host reading knowledge-index.json directly.
 */
function scoreLesson(record: LessonRecord, terms: readonly string[]): number {
  const tags = (record.tags ?? []).map((tag) => tag.toLowerCase());
  const summary = (record.summary ?? "").toLowerCase();
  const body = record.lesson.toLowerCase();
  return terms.reduce((total, term) => {
    let score = total;
    if (tags.includes(term)) score += 3;
    if (summary.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
    return score;
  }, 0);
}

function recallTerms(topic: string): readonly string[] {
  const normalized = topic.toLowerCase().trim();
  // Split on whitespace and punctuation that never carries meaning, and keep
  // everything else. An ASCII-only split erased `C++`, `C#`, `R`, and every
  // non-Latin word, so recall reported zero matches for a topic present
  // verbatim in a lesson. The whole normalized topic is always a term, so a
  // single-character or wholly-symbolic query still searches for itself.
  const parts = normalized
    .split(/[\s,;:!?()[\]{}"'`]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set([normalized, ...parts])].filter((term) => term.length > 0);
}

async function runLearnRecall(context: CliContext, topic: string): Promise<CliResult> {
  const index = await readLessonIndex(context.repositoryRoot);
  const terms = recallTerms(topic);
  const matches = index.lessons
    .map((record) => ({ record, score: scoreLesson(record, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.record.createdAt.localeCompare(right.record.createdAt))
    .map((entry) => ({
      id: entry.record.id,
      score: entry.score,
      kind: entry.record.kind ?? null,
      summary: entry.record.summary ?? entry.record.lesson,
      artifactPath: entry.record.artifactPath
    }));

  const action = nextAction("legion status", "Apply the recalled learning to the next workflow action.");
  return success(
    {
      ok: true,
      status: "completed",
      workflow: "learn",
      mode: "recall",
      topic,
      matches,
      // Recorded lessons only. The command also searched retrospective findings,
      // which in v9 live in run-scoped retro.md artifacts that nothing reads;
      // P16-B003 owns wiring those in, and saying so here is better than a
      // silently narrower corpus that looks complete.
      corpus: ["lessons"],
      nextAction: action,
      diagnostics: []
    },
    [
      `Recall "${topic}": ${matches.length} match${matches.length === 1 ? "" : "es"}.`,
      ...matches.slice(0, 10).map((match) => `- [${match.score}] ${match.kind ?? "unclassified"}: ${match.summary}`),
      renderNextAction(action)
    ].join("\n")
  );
}

async function runLearnList(context: CliContext): Promise<CliResult> {
  const index = await readLessonIndex(context.repositoryRoot);
  const grouped = LESSON_KINDS.map((kind) => ({
    kind,
    lessons: index.lessons.filter((record) => record.kind === kind)
  }));
  const unclassified = index.lessons.filter((record) => record.kind === undefined);

  const action = nextAction("legion status", "Recorded learning is available to future context packs.");
  return success(
    {
      ok: true,
      status: "completed",
      workflow: "learn",
      mode: "list",
      total: index.lessons.length,
      byKind: Object.fromEntries(grouped.map((group) => [group.kind, group.lessons.length])),
      unclassified: unclassified.length,
      lessons: index.lessons.map((record) => ({
        id: record.id,
        kind: record.kind ?? null,
        summary: record.summary ?? record.lesson,
        tags: record.tags ?? [],
        createdAt: record.createdAt
      })),
      nextAction: action,
      diagnostics: []
    },
    [
      `Lessons: ${index.lessons.length}.`,
      // The counts alone made --list a tally of a thing it would not show. The
      // mode exists to display the recorded learning, so it displays it.
      ...grouped.flatMap((group) => group.lessons.length === 0
        ? []
        : ["", `${group.kind} (${group.lessons.length}):`, ...group.lessons.map(renderLessonLine)]),
      ...(unclassified.length === 0
        ? []
        : ["", `unclassified (${unclassified.length}):`, ...unclassified.map(renderLessonLine)]),
      "",
      renderNextAction(action)
    ].join("\n")
  );
}

function renderLessonLine(record: LessonRecord): string {
  const tags = (record.tags ?? []).length === 0 ? "" : ` [${(record.tags ?? []).join(", ")}]`;
  return `  ${record.id}  ${record.createdAt.slice(0, 10)}  ${record.summary ?? record.lesson}${tags}`;
}
