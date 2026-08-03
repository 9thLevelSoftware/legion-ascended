import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadProject, stableProtocolJson } from "@legion/artifacts";
import { LEGION_PROTOCOL_VERSION, artifactPathSchema, formatEntityId, type ArtifactPath } from "@legion/protocol";

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
import { parseResultFromText } from "../../workflow/executor/result.js";
import { explorationResultContract, parseExploration } from "../../workflow/exploration.js";
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
import { slugFromName } from "../../workflow/input.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";
import { positionalText } from "./record.js";

const HELP = {
  explore: "legion explore <topic> [--entry raw-idea|pasted-spec|existing-codebase|link] [--executor codex|manual|fake]\n\nBrainstorm freely before the structured start interview. Writes a design document plus a typed exploration recording proposals and unresolved questions. Nothing an exploration produces is authoritative. Note: legion start does not read explorations yet — that handoff is not wired up.",
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
    requiredSections: input.sections,
    // Exploration is the only guidance workflow whose output feeds a later
    // structured step, so it is the only one asked for a typed result.
    ...(input.workflow === "explore" ? { extraContract: explorationResultContract() } : {})
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

  // Persist the typed exploration alongside the prose. The design document stays
  // human-readable; this is the machine-readable form.
  //
  // `legion start --from-exploration <runId>` reads it, via
  // `workflow/intake/exploration-source.ts`. What it takes is deliberately
  // limited: proposals become suggestions the operator still has to accept, and
  // open questions become extra required intake nodes. Nothing here can answer
  // an intake question on its own, so a confident brainstorm cannot shorten the
  // interview — only a decisive human can.
  let explorationArtifactPath: ArtifactPath | undefined;
  let explorationDiagnostics: readonly string[] = [];
  if (input.workflow === "explore") {
    const parsed = parseExploration({
      raw: parseResultFromText(executed.result.rawOutput ?? ""),
      runId: formatEntityId("run", slugFromName(`explore-${paths.runId}`)),
      topic: topic ?? input.workflow,
      entry: stringOption(context, "entry") ?? "raw-idea",
      createdAt,
      schemaVersion: LEGION_PROTOCOL_VERSION,
      fallbackSummary: summary
    });
    explorationDiagnostics = parsed.diagnostics;
    if (parsed.exploration !== undefined) {
      explorationArtifactPath = guidanceArtifactPath(paths, "exploration.json");
      await writeProjectTextFile({
        repositoryRoot: context.repositoryRoot,
        artifactPath: explorationArtifactPath,
        text: stableProtocolJson(parsed.exploration)
      });
    }
  }

  const status = executed.result.ok ? "completed" : "blocked";
  const run = await writeGuidanceRun({
    repositoryRoot: context.repositoryRoot,
    paths,
    status,
    runInput: { topic: topic ?? null },
    outputs: {
      markdownArtifactPath,
      ...(explorationArtifactPath === undefined ? {} : { explorationArtifactPath }),
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
    ...(explorationArtifactPath === undefined ? {} : { explorationArtifactPath }),
    ...(explorationDiagnostics.length === 0 ? {} : { explorationDiagnostics }),
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
  // `--scope` reaches `mapCheck` and `mapRefresh` but never `mapQuery`, and the
  // mode guard above cannot catch the pair because scope is not a mode. So
  // `legion map --query x --scope packages/cli` ran unscoped and reported
  // success — an answer drawn from the whole repository, presented as one drawn
  // from the path the caller named. Refusing is the honest reading: the query
  // runs over the stored map, whose scope was fixed when it was generated.
  if (query !== undefined && scope !== undefined) {
    return usageError(
      "legion map --query does not accept --scope. The query runs over the stored map, whose scope was set when it was generated. Refresh with legion map --refresh --scope <path> to change it."
    );
  }

  if (check) return mapCheck(context, scope);
  if (query !== undefined) return mapQuery(context, query);
  if (refresh) return mapRefresh(context, scope);
  // A bare `legion map` walked the repository and overwrote the artifact set
  // with no prompt and no confirmation. The command it backs summarizes the
  // current dataset and offers a refresh, so the destructive path now requires
  // asking for it by name.
  return mapSummary(context, scope);
}

async function mapRefresh(context: CliContext, scope: string | undefined): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;

  // Detected before the run directory is claimed. Writing five artifacts over an
  // empty file set produced a map of nothing, a fingerprint over the empty
  // string, and the cheerful line "Codebase map refreshed for 0 source files." —
  // a successful-looking result that every later read would trust.
  let detected: Awaited<ReturnType<typeof currentCodebaseFingerprint>>;
  try {
    detected = await currentCodebaseFingerprint({ repositoryRoot: context.repositoryRoot, ...(scope === undefined ? {} : { scope }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Unable to refresh codebase map. ${message}`);
  }
  if (detected.sourceFileCount === 0) {
    const action = nextAction("legion map --refresh --scope <path>", "Point the map at a path that contains source files.");
    return failure(
      {
        ok: false,
        status: "absent",
        workflow: "map",
        mode: "refresh",
        scope: detected.scope,
        sourceFileCount: 0,
        nextAction: action,
        diagnostics: [{ code: "map_no_source", message: `No source files were detected under ${detected.scope}.` }]
      },
      [`No source files were detected under ${detected.scope}. Nothing was written.`, renderNextAction(action)].join("\n")
    );
  }

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

/** How long a map stays trustworthy before it should be regenerated. */
const MAP_MAX_AGE_DAYS = 30;

type MapFreshness = "fresh" | "stale" | "partial" | "absent";

interface MapState {
  readonly freshness: MapFreshness;
  readonly reason: string;
  readonly scope: string;
  readonly sourceFingerprint: string;
  readonly sourceFileCount: number;
  readonly latestSourceFingerprint: string | null;
  readonly generatedAt: string | null;
  readonly ageDays: number | null;
}

/**
 * The four states the command distinguishes and the verb collapsed into two.
 *
 * `mapCheck` computed one boolean and called everything that was not fresh
 * "stale", so a project that had never run map reported the same status as one
 * whose fingerprint had moved by a line — and a map generated against a
 * different scope reported stale without saying that the comparison was not
 * like for like.
 */
async function resolveMapState(
  repositoryRoot: string,
  scope: string | undefined,
  now: string
): Promise<MapState | CliResult> {
  const latest = await getLatestCodebaseMap(repositoryRoot);
  let current: Awaited<ReturnType<typeof currentCodebaseFingerprint>>;
  try {
    current = await currentCodebaseFingerprint({ repositoryRoot, ...(scope === undefined ? {} : { scope }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Unable to read the codebase map. ${message}`);
  }

  const base = {
    scope: current.scope,
    sourceFingerprint: current.sourceFingerprint,
    sourceFileCount: current.sourceFileCount,
    latestSourceFingerprint: latest?.sourceFingerprint ?? null,
    generatedAt: latest?.generatedAt ?? null
  };

  if (latest === undefined) {
    return { ...base, freshness: "absent", reason: "No codebase map has been generated.", ageDays: null };
  }

  const ageDays = ageInDays(latest.generatedAt, now);
  if (latest.scope !== current.scope) {
    return {
      ...base,
      freshness: "partial",
      reason: `The stored map covers ${latest.scope}, which is not the scope being checked (${current.scope}).`,
      ageDays
    };
  }
  if (latest.sourceFingerprint !== current.sourceFingerprint) {
    return { ...base, freshness: "stale", reason: "Source files have changed since the map was generated.", ageDays };
  }
  if (ageDays !== null && ageDays > MAP_MAX_AGE_DAYS) {
    // The fingerprint can match while the map is still worth regenerating: the
    // schema moves, and a map old enough to predate it describes the repository
    // in a vocabulary the current reader no longer uses.
    return {
      ...base,
      freshness: "stale",
      reason: `The map is ${Math.floor(ageDays)} days old, past the ${MAP_MAX_AGE_DAYS}-day limit.`,
      ageDays
    };
  }
  return { ...base, freshness: "fresh", reason: "The map matches the current source files.", ageDays };
}

function ageInDays(generatedAt: string, now: string): number | null {
  const from = Date.parse(generatedAt);
  const to = Date.parse(now);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86_400_000;
}

function mapStatePayload(state: MapState, mode: "check" | "summary") {
  return {
    ok: true,
    status: state.freshness,
    workflow: "map",
    mode,
    scope: state.scope,
    sourceFingerprint: state.sourceFingerprint,
    sourceFileCount: state.sourceFileCount,
    latestSourceFingerprint: state.latestSourceFingerprint,
    generatedAt: state.generatedAt,
    diagnostics: []
  };
}

function mapStateAction(state: MapState) {
  return state.freshness === "fresh"
    ? nextAction("legion plan 1", "The codebase map is fresh enough for planning.")
    : nextAction("legion map --refresh", state.reason);
}

async function mapCheck(context: CliContext, scope: string | undefined): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const state = await resolveMapState(context.repositoryRoot, scope, createdAt);
  if ("exitCode" in state) return state;

  // No guidance run. `--check` compares two fingerprints and writes nothing the
  // caller asked to change, and recording it did active harm:
  // `getLatestCodebaseMap` finds the current map by scanning only the newest 20
  // map runs, so twenty checks evicted the refresh that produced the map and the
  // CLI then reported that none existed. Reads destroyed the ability to find
  // what they read.
  const action = mapStateAction(state);
  return success(
    { ...mapStatePayload(state, "check"), nextAction: action },
    [`Codebase map: ${state.freshness}. ${state.reason}`, renderNextAction(action)].join("\n")
  );
}

/** A read-only summary, which is what a bare `legion map` now does. */
async function mapSummary(context: CliContext, scope: string | undefined): Promise<CliResult> {
  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const state = await resolveMapState(context.repositoryRoot, scope, createdAt);
  if ("exitCode" in state) return state;

  const action = mapStateAction(state);
  return success(
    { ...mapStatePayload(state, "summary"), nextAction: action },
    [
      `Codebase map: ${state.freshness}. ${state.reason}`,
      `Scope: ${state.scope}. Source files: ${state.sourceFileCount}.`,
      state.generatedAt === null ? "Never generated." : `Generated: ${state.generatedAt}.`,
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
  const matches = queryCodebaseMap(latest, query);
  const action = nextAction("legion status", "Use the query result as context for the next workflow action.");
  // A search over a stored map, writing nothing. Like `--check`, recording it
  // pushed the run that produced the map out of the twenty-run window that
  // `getLatestCodebaseMap` scans.
  return success(
    {
      ok: true,
      status: "completed",
      workflow: "map",
      mode: "query",
      query,
      matches,
      nextAction: action,
      diagnostics: []
    },
    [
      `Map query returned ${matches.length} matches.`,
      ...matches.slice(0, 5).map((match) => `- ${match.path}: ${match.summary}`),
      // The index is a lexical score over generated summaries, so acting on it
      // without opening the file is how a caller edits the wrong one.
      matches.length === 0 ? "" : "Read the matched files before acting on them; the index ranks, it does not confirm.",
      renderNextAction(action)
    ].filter((line) => line.length > 0).join("\n")
  );
}

async function runRetroWorkflow(context: CliContext): Promise<CliResult> {
  const phase = optionalStringInput(context, "phase");
  if (phase !== null && typeof phase !== "string") return phase;
  const milestone = optionalStringInput(context, "milestone");
  if (milestone !== null && typeof milestone !== "string") return milestone;
  // `--phase` and `--milestone` reach the run slug, the run record, and the
  // prompt topic, and nothing else. No evidence from the named scope is gathered:
  // the stage and recent runs read below are handed to `renderGuidanceMarkdown`
  // after the executor has already produced its findings, so the model never sees
  // them. What comes back is an unscoped retrospective wearing a scoped label.
  //
  // An earlier revision emitted a diagnostic instead of refusing, on the grounds
  // that the topic does steer the prompt and refusing removes something that
  // works. That was the wrong call, and the argument against it is the `--query
  // --scope` fix in this same change: a scoped query the CLI cannot honour must
  // not report success. Exit 0 plus a persisted retro.md labelled with the
  // requested scope is a claim, and a diagnostic nothing is obliged to read does
  // not retract it. The steering was never worth much either — it produced an
  // unscoped analysis under a scoped heading.
  //
  // P16-B003 makes the scope real by putting the selected evidence in front of
  // the executor. Until then the mode does not exist and says so.
  if (phase !== null || milestone !== null) {
    const requested = [
      phase === null ? undefined : `--phase ${phase}`,
      milestone === null ? undefined : `--milestone ${milestone}`
    ].filter((part) => part !== undefined).join(" ");
    return usageError(
      `legion retro cannot scope a retrospective yet, so ${requested} is refused rather than ignored. The scope would reach the prompt topic only and gather no evidence from it, producing an unscoped retrospective under a scoped label. Run legion retro with no scope for a retrospective over current workflow state.`
    );
  }

  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;
  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "retro",
    slugSource: "retro",
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
  const diagnostics = executed.result.findings;
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
    diagnostics
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
    diagnostics
  };
  const human = [
    `Retrospective: ${status}.`,
    `Artifact: ${markdownArtifactPath}`,
    renderNextAction(action)
  ].join("\n");
  return executed.result.ok ? success(payload, human) : failure(payload, human);
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

  // Status is the implicit default, and it used to fall through to the same
  // write path as define, complete and archive: rewriting milestones.json,
  // regenerating milestones.md, and appending a guidance run on every
  // invocation. Reading the state changed it, and every read left a run record
  // behind. That matters more than it looks: a host thinned onto this verb
  // renders status on every display, so the project's run history would fill
  // with entries recording nothing but that someone looked.
  if (statusMode) {
    const action = nextAction("legion status", "Review milestone state before changing release posture.");
    return success(
      {
        ok: true,
        status: "completed",
        workflow: "milestone",
        mode: "status",
        milestones: current.milestones,
        nextAction: action,
        diagnostics: []
      },
      [
        `Milestones: ${current.milestones.length}.`,
        renderMilestones(current).trimEnd(),
        renderNextAction(action)
      ].join("\n")
    );
  }

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
