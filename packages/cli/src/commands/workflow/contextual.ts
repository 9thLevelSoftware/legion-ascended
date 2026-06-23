import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadProject, stableProtocolJson } from "@legion/artifacts";
import { artifactPathSchema } from "@legion/protocol";

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
import {
  currentCodebaseFingerprint,
  getLatestCodebaseMap,
  queryCodebaseMap,
  refreshCodebaseMap
} from "../../workflow/codebase-map.js";
import { writeProjectTextFile } from "../../workflow/executor/index.js";
import {
  createGuidanceRunPaths,
  guidanceArtifactPath,
  guidanceCreatedAt,
  guidancePrompt,
  latestGuidanceRuns,
  renderGuidanceMarkdown,
  runGuidanceExecutor,
  writeGuidanceRun,
  type GuidanceRunDocument
} from "../../workflow/guidance-run.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";
import { positionalText } from "./record.js";

const HELP = {
  explore: "legion explore <topic> [--executor codex|manual|fake]\n\nCreate a design discovery artifact before start or planning.",
  map: "legion map [--refresh] [--scope <path>] | [--check] | [--query <text>]\n\nGenerate, check, or query deterministic codebase context.",
  retro: "legion retro [--phase N|--milestone M] [--executor codex|manual|fake]\n\nAnalyze recent workflow evidence and write retrospective guidance.",
  milestone: "legion milestone --status | --define <name> --phases <range> | --complete <id> --summary <text> | --archive <id>\n\nManage milestone status, summaries, and archives.",
  council: "legion council <topic> [--executor codex|manual|fake]\n\nRun governance deliberation formerly exposed as /legion:board."
} as const;

export type ContextualWorkflowCommand = keyof typeof HELP;

interface MilestoneRecord {
  readonly id: string;
  readonly name: string;
  readonly phases: string;
  readonly status: "defined" | "completed" | "archived";
  readonly summary?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
}

interface MilestoneIndex {
  readonly schemaVersion: 1;
  readonly kind: "milestone_index";
  readonly milestones: readonly MilestoneRecord[];
}

export async function handleContextualWorkflow(
  context: CliContext,
  command: ContextualWorkflowCommand
): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(HELP[command]);
  }

  switch (command) {
    case "explore":
      return runExecutorBackedGuidance(context, {
        workflow: "explore",
        requiredText: true,
        title: "Design Discovery",
        markdownFile: "design.md",
        nextCommand: nextProjectAwareAction(context, "legion start", "legion plan 1"),
        sections: [
          "Problem Framing",
          "Constraints",
          "Open Questions",
          "Viable Approaches",
          "Recommended Next Action",
          "Start Or Plan Handoff"
        ],
        markdownSections: (topic, summary) => [
          { heading: "Problem Framing", body: `Clarify what "${topic}" should accomplish before changing implementation artifacts.` },
          { heading: "Constraints", body: ["Keep a human in the loop.", "Preserve existing project state.", "Record durable decisions before build work."] },
          { heading: "Open Questions", body: ["Which user workflow must be improved first?", "What existing artifacts should constrain the next plan?", "What evidence proves the outcome?"] },
          { heading: "Viable Approaches", body: ["Plan a narrow implementation phase.", "Refresh the codebase map first, then plan.", "Create a prototype task with legion quick and review the evidence."] },
          { heading: "Recommended Next Action", body: summary },
          { heading: "Start Or Plan Handoff", body: "Use this design artifact as context for `legion start` on a new project or `legion plan 1` on an initialized project." }
        ]
      });
    case "map":
      return handleMapWorkflow(context);
    case "retro":
      return runRetroWorkflow(context);
    case "milestone":
      return handleMilestoneWorkflow(context);
    case "council":
      return runExecutorBackedGuidance(context, {
        workflow: "council",
        requiredText: true,
        title: "Council Decision",
        markdownFile: "decision.md",
        nextCommand: nextAction("legion status", "Review the council decision before changing workflow posture."),
        sections: ["Decision Topic", "Options Considered", "Recommendation", "Risks", "Required Human Decision"],
        markdownSections: (topic, summary) => [
          { heading: "Decision Topic", body: topic },
          { heading: "Options Considered", body: ["Proceed with the smallest reversible change.", "Pause until missing evidence is collected.", "Escalate to a broader plan if risk is cross-cutting."] },
          { heading: "Recommendation", body: summary },
          { heading: "Risks", body: ["Consensus without evidence can hide implementation risk.", "Council output is advisory until a human accepts a concrete next action."] },
          { heading: "Required Human Decision", body: "Choose whether to convert this decision into a plan, quick task, or no-op." }
        ]
      });
  }
}

async function runExecutorBackedGuidance(context: CliContext, input: {
  readonly workflow: "explore" | "advise" | "council";
  readonly requiredText: boolean;
  readonly title: string;
  readonly markdownFile: string;
  readonly nextCommand: ReturnType<typeof nextAction> | Promise<ReturnType<typeof nextAction>>;
  readonly sections: readonly string[];
  readonly markdownSections: (topic: string, summary: string) => readonly { readonly heading: string; readonly body: string | readonly string[] }[];
}): Promise<CliResult> {
  const topic = positionalText(context);
  if (input.requiredText && topic === undefined) {
    return usageError(`legion ${input.workflow} requires a topic. Example: legion ${input.workflow} "release readiness".`);
  }
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;

  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: input.workflow,
    slugSource: topic ?? input.workflow,
    createdAt
  });
  const prompt = guidancePrompt({
    workflow: input.workflow,
    topic: topic ?? input.workflow,
    requiredSections: input.sections
  });
  const executed = await runGuidanceExecutor({
    context,
    paths,
    workflow: input.workflow,
    topic: topic ?? input.workflow,
    prompt,
    readOnly: true,
    explicitExecutor: stringOption(context, "executor")
  });
  if ("exitCode" in executed) return executed;

  const action = await input.nextCommand;
  const summary = executed.result.summary;
  const markdown = renderGuidanceMarkdown({
    title: input.title,
    topic: topic ?? input.workflow,
    summary,
    sections: input.markdownSections(topic ?? input.workflow, summary)
  });
  const markdownArtifactPath = guidanceArtifactPath(paths, input.markdownFile);
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: markdownArtifactPath,
    text: markdown
  });

  const status = executed.result.ok ? "completed" : "blocked";
  const run = await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status,
    runInput: { topic: topic ?? null },
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
    workflow: input.workflow,
    runId: paths.runId,
    artifactPath: paths.workflowRunArtifactPath,
    markdownArtifactPath,
    executor: executed.executor,
    nextAction: action,
    diagnostics: executed.result.findings
  };
  const human = [
    `${input.title}: ${status}.`,
    `Artifact: ${markdownArtifactPath}`,
    renderNextAction(action)
  ].join("\n");
  return run.status === "completed" ? success(payload, human) : failure(payload, human);
}

async function handleMapWorkflow(context: CliContext): Promise<CliResult> {
  const check = hasFlag(context, "check");
  const refresh = hasFlag(context, "refresh");
  const query = stringOption(context, "query")?.trim();
  const scope = stringOption(context, "scope")?.trim();
  const modes = [check, refresh, query !== undefined].filter(Boolean).length;
  if (modes > 1) return usageError("legion map accepts one mode at a time: --refresh, --check, or --query <text>.");
  if (context.args.options.get("query") === true || query === "") return usageError("Missing required value for --query. Example: legion map --query taskgraph.");
  if (context.args.options.get("scope") === true || scope === "") return usageError("Missing required value for --scope. Example: legion map --refresh --scope packages/cli.");

  if (check) return mapCheck(context, scope);
  if (query !== undefined) return mapQuery(context, query);
  return mapRefresh(context, scope);
}

async function mapRefresh(context: CliContext, scope: string | undefined): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "map",
    slugSource: scope === undefined ? "refresh" : `refresh ${scope}`,
    createdAt
  });
  try {
    const artifacts = await refreshCodebaseMap({
      repositoryRoot: context.repositoryRoot,
      paths,
      ...(scope === undefined ? {} : { scope })
    });
    const action = nextAction("legion plan 1", "Use refreshed map context when planning the next change.");
    await writeGuidanceRun({
      repositoryRoot: context.repositoryRoot,
      paths,
      status: "completed",
      runInput: { mode: "refresh", scope: artifacts.map.scope },
      outputs: {
        codebaseArtifactPath: artifacts.codebaseArtifactPath,
        indexArtifactPath: artifacts.indexArtifactPath,
        symbolsArtifactPath: artifacts.symbolsArtifactPath,
        searchArtifactPath: artifacts.searchArtifactPath,
        mapArtifactPath: artifacts.mapArtifactPath,
        sourceFingerprint: artifacts.map.sourceFingerprint,
        sourceFileCount: artifacts.map.sourceFileCount
      },
      nextAction: action
    });
    return success(
      {
        ok: true,
        status: "completed",
        workflow: "map",
        mode: "refresh",
        runId: paths.runId,
        artifactPath: paths.workflowRunArtifactPath,
        mapArtifactPath: artifacts.mapArtifactPath,
        sourceFingerprint: artifacts.map.sourceFingerprint,
        sourceFileCount: artifacts.map.sourceFileCount,
        nextAction: action,
        diagnostics: []
      },
      [
        `Codebase map refreshed for ${artifacts.map.sourceFileCount} source files.`,
        `Artifact: ${artifacts.codebaseArtifactPath}`,
        renderNextAction(action)
      ].join("\n")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Unable to refresh codebase map. ${message}`);
  }
}

async function mapCheck(context: CliContext, scope: string | undefined): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "map",
    slugSource: "check",
    createdAt
  });
  const latest = await getLatestCodebaseMap(context.repositoryRoot);
  let current: Awaited<ReturnType<typeof currentCodebaseFingerprint>>;
  try {
    current = await currentCodebaseFingerprint({ repositoryRoot: context.repositoryRoot, ...(scope === undefined ? {} : { scope }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Unable to check codebase map. ${message}`);
  }
  const fresh = latest !== undefined &&
    latest.scope === current.scope &&
    latest.sourceFingerprint === current.sourceFingerprint;
  const action = fresh
    ? nextAction("legion plan 1", "The codebase map is fresh enough for planning.")
    : nextAction("legion map --refresh", "Refresh the codebase map before relying on mapped context.");
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status: fresh ? "completed" : "stale",
    runInput: { mode: "check", scope: current.scope },
    outputs: {
      currentSourceFingerprint: current.sourceFingerprint,
      latestSourceFingerprint: latest?.sourceFingerprint ?? null,
      sourceFileCount: current.sourceFileCount
    },
    nextAction: action
  });
  return success(
    {
      ok: true,
      status: fresh ? "fresh" : "stale",
      workflow: "map",
      mode: "check",
      runId: paths.runId,
      artifactPath: paths.workflowRunArtifactPath,
      scope: current.scope,
      sourceFingerprint: current.sourceFingerprint,
      latestSourceFingerprint: latest?.sourceFingerprint ?? null,
      nextAction: action,
      diagnostics: []
    },
    [
      fresh ? "Codebase map is fresh." : "Codebase map is stale or missing.",
      renderNextAction(action)
    ].join("\n")
  );
}

async function mapQuery(context: CliContext, query: string): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const latest = await getLatestCodebaseMap(context.repositoryRoot);
  if (latest === undefined) {
    const action = nextAction("legion map --refresh", "A query requires an existing codebase map.");
    return failure(
      {
        ok: false,
        status: "blocked",
        workflow: "map",
        mode: "query",
        diagnostics: [{ code: "map_missing", message: "No codebase map exists. Run legion map --refresh first." }],
        nextAction: action
      },
      ["Map query is blocked.", renderNextAction(action)].join("\n")
    );
  }
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "map",
    slugSource: `query ${query}`,
    createdAt
  });
  const matches = queryCodebaseMap(latest, query);
  const queryArtifactPath = guidanceArtifactPath(paths, "query-results.json");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: queryArtifactPath,
    text: stableProtocolJson({ query, matches })
  });
  const action = nextAction("legion status", "Use the query result as context for the next workflow action.");
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status: "completed",
    runInput: { mode: "query", query },
    outputs: { queryArtifactPath, matchCount: matches.length },
    nextAction: action
  });
  return success(
    {
      ok: true,
      status: "completed",
      workflow: "map",
      mode: "query",
      runId: paths.runId,
      artifactPath: paths.workflowRunArtifactPath,
      queryArtifactPath,
      matches,
      nextAction: action,
      diagnostics: []
    },
    [
      `Map query returned ${matches.length} matches.`,
      ...matches.slice(0, 5).map((match) => `- ${match.path}: ${match.summary}`),
      renderNextAction(action)
    ].join("\n")
  );
}

async function runRetroWorkflow(context: CliContext): Promise<CliResult> {
  const phase = optionalStringInput(context, "phase");
  if (phase !== null && typeof phase !== "string") return phase;
  const milestone = optionalStringInput(context, "milestone");
  if (milestone !== null && typeof milestone !== "string") return milestone;
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "retro",
    slugSource: phase ?? milestone ?? "retro",
    createdAt
  });
  const state = await resolveWorkflowState(context);
  const recentRuns = await latestGuidanceRuns({ repositoryRoot: context.repositoryRoot, limitPerWorkflow: 2 });
  const topic = phase === null && milestone === null ? `workflow stage ${state.stage}` : `phase ${phase ?? ""} milestone ${milestone ?? ""}`.trim();
  const prompt = guidancePrompt({
    workflow: "retro",
    topic,
    requiredSections: ["What Worked", "What Did Not", "Reusable Lessons", "Follow-Up Actions"]
  });
  const executed = await runGuidanceExecutor({
    context,
    paths,
    workflow: "retro",
    topic,
    prompt,
    readOnly: true,
    explicitExecutor: stringOption(context, "executor")
  });
  if ("exitCode" in executed) return executed;
  const markdown = renderGuidanceMarkdown({
    title: "Workflow Retrospective",
    topic,
    summary: executed.result.summary,
    sections: [
      { heading: "Workflow State", body: `Current stage: ${state.stage}` },
      { heading: "Recent Guidance Runs", body: recentRuns.length === 0 ? "No recent guidance runs were found." : recentRuns.map((run) => `${run.workflow}/${run.runId}: ${run.status}`) },
      { heading: "Lessons", body: executed.result.findings.length === 0 ? ["Preserve evidence before changing workflow posture."] : executed.result.findings.map((finding) => finding.body) },
      { heading: "Follow-Up Actions", body: [state.nextAction.command] }
    ]
  });
  const markdownArtifactPath = guidanceArtifactPath(paths, "retro.md");
  await writeProjectTextFile({ repositoryRoot: context.repositoryRoot, artifactPath: markdownArtifactPath, text: markdown });
  const action = nextAction("legion plan 1", "Use retrospective lessons when planning the next phase.");
  const status = executed.result.ok ? "completed" : "blocked";
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status,
    runInput: { phase, milestone },
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
    workflow: "retro",
    runId: paths.runId,
    artifactPath: paths.workflowRunArtifactPath,
    markdownArtifactPath,
    executor: executed.executor,
    nextAction: action,
    diagnostics: executed.result.findings
  };
  return executed.result.ok
    ? success(payload, [`Retrospective: ${status}.`, `Artifact: ${markdownArtifactPath}`, renderNextAction(action)].join("\n"))
    : failure(payload, [`Retrospective: ${status}.`, `Artifact: ${markdownArtifactPath}`, renderNextAction(action)].join("\n"));
}

async function handleMilestoneWorkflow(context: CliContext): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const define = stringOption(context, "define")?.trim();
  const phases = stringOption(context, "phases")?.trim();
  const complete = stringOption(context, "complete")?.trim();
  const summary = stringOption(context, "summary")?.trim();
  const archive = stringOption(context, "archive")?.trim();
  const statusMode = hasFlag(context, "status") || (define === undefined && complete === undefined && archive === undefined);
  const modeCount = [define !== undefined, complete !== undefined, archive !== undefined, statusMode].filter(Boolean).length;
  if (modeCount !== 1) return usageError("legion milestone accepts one mode: --status, --define, --complete, or --archive.");
  if (context.args.options.get("define") === true || define === "") return usageError("Missing required value for --define. Example: legion milestone --define MVP --phases 1-3.");
  if (context.args.options.get("phases") === true || phases === "") return usageError("Missing required value for --phases. Example: legion milestone --define MVP --phases 1-3.");
  if (context.args.options.get("complete") === true || complete === "") return usageError("Missing required value for --complete. Example: legion milestone --complete milestone-mvp --summary \"Done\".");
  if (context.args.options.get("archive") === true || archive === "") return usageError("Missing required value for --archive. Example: legion milestone --archive milestone-mvp.");
  if (context.args.options.get("summary") === true || summary === "") return usageError("Missing required value for --summary. Example: legion milestone --complete milestone-mvp --summary \"Done\".");
  if (define !== undefined && phases === undefined) return usageError("legion milestone --define requires --phases <range>.");
  if (complete !== undefined && summary === undefined) return usageError("legion milestone --complete requires --summary <text>.");

  const current = await readMilestoneIndex(context.repositoryRoot);
  let next = current;
  let status: "completed" | "accepted" = "completed";
  let slugSource = "status";
  if (define !== undefined && phases !== undefined) {
    const id = milestoneId(define);
    if (current.milestones.some((entry) => entry.id === id)) return usageError(`Milestone already exists: ${id}`);
    next = {
      ...current,
      milestones: [
        ...current.milestones,
        { id, name: define, phases, status: "defined", createdAt }
      ]
    };
    slugSource = id;
  } else if (complete !== undefined && summary !== undefined) {
    if (!current.milestones.some((milestone) => milestone.id === complete)) {
      return usageError(`Milestone not found: ${complete}`);
    }
    next = updateMilestone(current, complete, (milestone) => ({
      ...milestone,
      status: "completed",
      summary,
      completedAt: createdAt
    }));
    status = "accepted";
    slugSource = complete;
  } else if (archive !== undefined) {
    if (!current.milestones.some((milestone) => milestone.id === archive)) {
      return usageError(`Milestone not found: ${archive}`);
    }
    next = updateMilestone(current, archive, (milestone) => ({
      ...milestone,
      status: "archived",
      archivedAt: createdAt
    }));
    slugSource = archive;
  }

  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "milestone",
    slugSource,
    createdAt
  });
  const indexArtifactPath = artifactPathSchema.parse(".legion/project/workflow/milestone/milestones.json");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: indexArtifactPath,
    text: stableProtocolJson(next)
  });
  const markdownArtifactPath = guidanceArtifactPath(paths, "milestones.md");
  await writeProjectTextFile({
    repositoryRoot: context.repositoryRoot,
    artifactPath: markdownArtifactPath,
    text: renderMilestones(next)
  });
  const action = nextAction("legion status", "Review milestone state before changing release posture.");
  await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status,
    runInput: { define: define ?? null, phases: phases ?? null, complete: complete ?? null, archive: archive ?? null },
    outputs: { indexArtifactPath, markdownArtifactPath, milestoneCount: next.milestones.length },
    nextAction: action
  });
  return success(
    {
      ok: true,
      status,
      workflow: "milestone",
      runId: paths.runId,
      artifactPath: paths.workflowRunArtifactPath,
      indexArtifactPath,
      markdownArtifactPath,
      milestones: next.milestones,
      nextAction: action,
      diagnostics: []
    },
    [
      `Milestones: ${next.milestones.length}.`,
      `Artifact: ${markdownArtifactPath}`,
      renderNextAction(action)
    ].join("\n")
  );
}

async function nextProjectAwareAction(context: CliContext, uninitializedCommand: string, initializedCommand: string) {
  const project = await loadProject({ repositoryRoot: context.repositoryRoot });
  return !project.ok
    ? nextAction(uninitializedCommand, "Use the exploration artifact to initialize the project workflow.")
    : nextAction(initializedCommand, "Use the exploration artifact when planning the next change.");
}

function optionalStringInput(context: CliContext, key: string): string | null | CliResult {
  if (!context.args.options.has(key)) return null;
  const value = context.args.options.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    return usageError(`Missing required value for --${key}. Example: legion retro --${key} <value>.`);
  }
  return value.trim();
}

async function readMilestoneIndex(repositoryRoot: string): Promise<MilestoneIndex> {
  const indexPath = path.join(repositoryRoot, ".legion", "project", "workflow", "milestone", "milestones.json");
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as MilestoneIndex;
    if (parsed.kind === "milestone_index" && Array.isArray(parsed.milestones)) return parsed;
  } catch {
    // Missing or malformed milestone state is treated as empty; validate can report broader project corruption.
  }
  return {
    schemaVersion: 1,
    kind: "milestone_index",
    milestones: []
  };
}

function updateMilestone(index: MilestoneIndex, id: string, update: (milestone: MilestoneRecord) => MilestoneRecord): MilestoneIndex {
  let found = false;
  const milestones = index.milestones.map((milestone) => {
    if (milestone.id !== id) return milestone;
    found = true;
    return update(milestone);
  });
  if (!found) {
    throw new Error(`Milestone not found: ${id}`);
  }
  return { ...index, milestones };
}

function milestoneId(name: string): string {
  return `milestone-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed"}`;
}

function renderMilestones(index: MilestoneIndex): string {
  return [
    "# Milestones",
    "",
    index.milestones.length === 0 ? "No milestones defined." : index.milestones.map((milestone) => [
      `## ${milestone.name}`,
      "",
      `ID: ${milestone.id}`,
      `Phases: ${milestone.phases}`,
      `Status: ${milestone.status}`,
      milestone.summary === undefined ? "" : `Summary: ${milestone.summary}`
    ].filter((line) => line.length > 0).join("\n")).join("\n\n"),
    ""
  ].join("\n");
}
