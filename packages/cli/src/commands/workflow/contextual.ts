import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { listReviewDecisionsForChange, loadProject, readTaskGraph, stableProtocolJson } from "@legion/artifacts";
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
  collectMapSource,
  queryTerms,
  refreshCodebaseMap,
  resolveMapState,
  type MapState
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
import { isChangeComplete, listWorkflowChanges, resolveWorkflowState } from "../../workflow/state.js";
import { currentUtcTimestamp } from "../../workflow/change-input.js";
import { phaseChangeIdPrefix } from "../../workflow/phase-compat.js";
import { appendRetroEntry, readRetroIndex, retroIndexArtifactPath } from "../../workflow/retro-index.js";
import { collectEscalations } from "../../workflow/escalations.js";
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
      // The structured reply when the adapter produced one; rawOutput is
      // process stdout and stderr, and parsing typed fields out of that read log
      // noise rather than the JSON the contract asked for.
      raw: parseResultFromText(executed.result.structuredOutput ?? executed.result.rawOutput ?? ""),
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

  // Collected before the run directory is claimed, so a refusal leaves nothing
  // behind, and collected once, so the decision and the artifacts describe the
  // same snapshot.
  let source: Awaited<ReturnType<typeof collectMapSource>>;
  try {
    source = await collectMapSource({ repositoryRoot: context.repositoryRoot, ...(scope === undefined ? {} : { scope }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Unable to refresh codebase map. ${message}`);
  }
  if (source.files.length === 0) {
    const emptyAction = nextAction("legion map --refresh --scope <path>", "Point the map at a path that contains source files.");
    return failure(
      {
        ok: false,
        status: "absent",
        workflow: "map",
        mode: "refresh",
        scope: source.scope,
        sourceFileCount: 0,
        nextAction: emptyAction,
        diagnostics: [{ code: "map_no_source", message: `No source files were detected under ${source.scope}.` }]
      },
      [`No source files were detected under ${source.scope}. Nothing was written.`, renderNextAction(emptyAction)].join("\n")
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
      scope: source.scope,
      files: source.files
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
  if ("error" in state) return usageError(state.error);

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
  if ("error" in state) return usageError(state.error);

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
  // An empty query is refused, and a query whose every token the tokenizer
  // discards is the same input in a different costume: `legion map --query "!!"`
  // reported a successful search with zero results, which reads as "nothing in
  // this repository matches" rather than "nothing was searched for".
  if (queryTerms(query).length === 0) {
    return usageError(
      `legion map --query ${JSON.stringify(query)} has no searchable terms. Terms are at least two characters of letters, digits, underscore, hyphen or slash.`
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
  // Scope is resolved to a change, not pasted into a prompt. `--phase N` maps to
  // the change `legion plan N` produced — the only phase-to-change link there is
  // is the derived `chg_phase-<N>-` ID, because no phase field exists on a
  // change. Milestone scoping stays refused: a milestone's `--phases` is free
  // text nothing parses, so there is no milestone-to-phase path to follow yet.
  if (milestone !== null) {
    return usageError(
      "legion retro cannot scope a retrospective to a milestone: a milestone's phases are recorded as free text that nothing parses, so there is no set of changes to gather evidence from. Use --phase <N>, or run without a scope."
    );
  }

  let scopedChangeId: string | undefined;
  if (phase !== null) {
    // The whole value, not a parseInt prefix. `--phase 1.5` and `--phase 1foo`
    // both parse to 1, which would resolve phase 1's change while the prompt and
    // the saved run kept the caller's invalid label — a retrospective labelled
    // for a scope it did not resolve. `legion plan` validates the same way.
    if (!/^[1-9]\d*$/.test(phase)) {
      return usageError(`Invalid phase number "${phase}". Use a positive integer.`);
    }
    const phaseNumber = Number.parseInt(phase, 10);
    const listed = await listWorkflowChanges(context.repositoryRoot);
    const prefix = phaseChangeIdPrefix(phaseNumber);
    // A repository with no changes at all and one with no change for this phase
    // are the same answer to the caller: there is nothing to reflect on.
    const matches = listed.ok
      ? listed.changes.filter((entry) => entry.changeId.startsWith(prefix))
      : [];
    if (matches.length === 0) {
      return usageError(
        `legion retro --phase ${phaseNumber} found no change for that phase. Phase changes are named ${prefix}<slug>; run legion plan ${phaseNumber} first.`
      );
    }
    // Newest wins when a phase was re-planned under a renamed heading, which
    // produces a second change with the same prefix and a different slug.
    scopedChangeId = matches.at(-1)?.changeId;

    // A retrospective runs on completed work. Without this the command would
    // happily reflect on a phase still being built, which is the case its own
    // documentation refuses.
    const completeness = await isChangeComplete({
      repositoryRoot: context.repositoryRoot,
      changeId: scopedChangeId ?? ""
    });
    if (!completeness.complete) {
      return usageError(
        `Phase ${phaseNumber} is not complete, and retrospectives run on completed work. ${completeness.reason} Run legion review to finish the cycle, or retro without a scope.`
      );
    }
  }

  const createdAt = guidanceCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;

  const dryRun = hasFlag(context, "dry-run");
  const state = await resolveWorkflowState(context);
  const recentRuns = await latestGuidanceRuns({ repositoryRoot: context.repositoryRoot, limitPerWorkflow: 2 });
  const evidence = await gatherRetroEvidence(context.repositoryRoot, state, recentRuns, scopedChangeId);


  const paths = await createGuidanceRunPaths({
    repositoryRoot: context.repositoryRoot,
    workflow: "retro",
    slugSource: "retro",
    createdAt
  });
  const topic = phase === null && milestone === null ? `workflow stage ${state.stage}` : `phase ${phase ?? ""} milestone ${milestone ?? ""}`.trim();
  // The evidence goes into the prompt, not only into the rendered markdown.
  // resolveWorkflowState and latestGuidanceRuns were read before the run and
  // then handed to renderGuidanceMarkdown afterwards, so the model producing the
  // findings had seen none of it: the retrospective was an unevidenced essay
  // wearing an evidence section.
  const prompt = guidancePrompt({
    workflow: "retro",
    topic,
    requiredSections: ["What Worked", "What Did Not", "Reusable Lessons", "Follow-Up Actions"],
    extraContract: renderRetroEvidence(evidence)
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

  // A dry run displays the analysis and suppresses persistence, which means it
  // has to run the analysis. An earlier revision returned before the executor,
  // making the mode a metadata preview of counts rather than the retrospective
  // it claims to preview. Only the verb can do this properly: both writes fire
  // before this handler returns, so a host-side flag could suppress rendering
  // but not persistence.
  if (dryRun) {
    // The executor needs somewhere to write its prompt and logs, so the run
    // directory exists by the time the analysis has run. Removing it is what
    // makes "suppresses persistence" true rather than nearly true: a dry run
    // that left a run directory behind would still be findable by every reader
    // that scans them.
    await rm(path.join(context.repositoryRoot, ...paths.workflowRunArtifactPath.split("/").slice(0, -1)), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50
    });
    const previewAction = nextAction("legion retro", "Run without --dry-run to record this retrospective.");
    return success(
      {
        ok: executed.result.ok,
        status: "ready",
        dryRun: true,
        workflow: "retro",
        evidence,
        summary: executed.result.summary,
        findings: executed.result.findings,
        executor: executed.executor,
        nextAction: previewAction,
        diagnostics: executed.result.findings
      },
      [
        "Retrospective (dry run) — nothing was written.",
        `Evidence: ${evidence.summary}`,
        "",
        executed.result.summary,
        renderNextAction(previewAction)
      ].join("\n")
    );
  }


  const markdown = renderGuidanceMarkdown({
    title: "Workflow Retrospective",
    topic,
    summary: executed.result.summary,
    // The same exclusion as the prompt. An artifact that names the project's
    // current stage under a phase heading is a scoped retrospective reporting
    // unscoped facts, which is what a reader would take it for.
    sections: [
      scopedChangeId === undefined
        ? { heading: "Workflow State", body: `Current stage: ${state.stage}` }
        : { heading: "Scope", body: `Change ${scopedChangeId}. Project-wide stage and recent runs are excluded.` },
      ...(scopedChangeId !== undefined
        ? []
        : [
            {
              heading: "Recent Guidance Runs",
              body:
                recentRuns.length === 0
                  ? "No recent guidance runs were found."
                  : recentRuns.map((run) => `${run.workflow}/${run.runId}: ${run.status}`)
            }
          ]),
      { heading: "Lessons", body: executed.result.findings.length === 0 ? ["Preserve evidence before changing workflow posture."] : executed.result.findings.map((finding) => finding.body) },
      { heading: "Follow-Up Actions", body: [state.nextAction.command] }
    ]
  });
  const markdownArtifactPath = guidanceArtifactPath(paths, "retro.md");
  await writeProjectTextFile({ repositoryRoot: context.repositoryRoot, artifactPath: markdownArtifactPath, text: markdown });

  // Append only what a completed retrospective produced. A blocked run's
  // findings are the adapter's, not the retrospective's: the manual adapter
  // emits `manual-execution-required` and a timed-out executor emits its own
  // failure. Indexing those would have every later `plan` report an adapter
  // failure as planning guidance, and `learn --recall` return it as
  // institutional knowledge.
  const retroIndexPath = retroIndexArtifactPath();
  const indexed = executed.result.ok;
  const nextIndex = !indexed
    ? await readRetroIndex(context.repositoryRoot)
    : appendRetroEntry(await readRetroIndex(context.repositoryRoot), {
    id: paths.runId,
    createdAt: currentUtcTimestamp(),
    ...(scopedChangeId === undefined ? {} : { scopedChangeId }),
    artifactPath: markdownArtifactPath,
    summary: executed.result.summary,
    actions: executed.result.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      body: finding.body,
      severity: finding.severity
    }))
  });
  if (indexed) {
    await writeProjectTextFile({
      repositoryRoot: context.repositoryRoot,
      artifactPath: retroIndexPath,
      text: stableProtocolJson(nextIndex)
    });
  }
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
      ...(indexed ? { retroIndexArtifactPath: retroIndexPath } : {}),
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
    // Absent when the run was blocked, so a caller can tell "nothing was
    // indexed" from "indexed and the count happens to be unchanged".
    ...(indexed ? { retroIndexArtifactPath: retroIndexPath, retrospectiveCount: nextIndex.retrospectives.length } : {}),
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
    const target = current.milestones.find((milestone) => milestone.id === complete);
    if (target === undefined) {
      return usageError(`Milestone not found: ${complete}`);
    }
    // The command's stated invariant is no partial completions, and the verb's
    // only check was that the id existed — so a milestone could be marked
    // complete while its phases were not, and nothing downstream could tell the
    // difference between finished and declared finished.
    if (target.status === "completed" || target.status === "archived") {
      return usageError(`Milestone ${complete} is already ${target.status}. Completing it again would overwrite its recorded summary.`);
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

export interface RetroEvidence {
  /** Absent under a scope: the project's stage is not the phase's. */
  readonly stage?: string;
  readonly scopedChangeId?: string;
  readonly changeCount: number;
  readonly taskCount: number;
  readonly acceptedReviews: number;
  readonly escalations: number;
  readonly escalationReasons: readonly string[];
  readonly changesComplete: number;
  /** Tasks whose first review attempt passed, over tasks reviewed at all. */
  readonly firstPassReviews: { readonly passed: number; readonly reviewed: number };
  readonly recentRuns: readonly string[];
  readonly summary: string;
}

/**
 * The evidence a retrospective is drawn from.
 *
 * Counts over typed artifacts rather than impressions: what makes a finding
 * falsifiable is that the numbers behind it came from the same files the reader
 * can open. `latestGuidanceRuns` returns run metadata, not build or review
 * evidence, so the change and review counts are read directly.
 */
export async function gatherRetroEvidence(
  repositoryRoot: string,
  state: Awaited<ReturnType<typeof resolveWorkflowState>>,
  recentRuns: readonly GuidanceRunDocument[],
  /** When set, evidence covers only this change rather than the whole project. */
  scopedChangeId?: string
): Promise<RetroEvidence> {
  let changeCount = 0;
  let taskCount = 0;
  let acceptedReviews = 0;
  let escalations = 0;
  let changesComplete = 0;
  let firstPassPassed = 0;
  let tasksReviewed = 0;
  const escalationReasons = new Set<string>();
  // Valid bundles, not directories. Counting directories counts a docs folder
  // with no change.yaml as a change.
  const listed = await listWorkflowChanges(repositoryRoot);
  {
    const all = listed.ok ? listed.changes.map((entry) => entry.changeId) : [];
    // Scoping narrows what is gathered, which is the difference between a
    // scoped retrospective and an unscoped one wearing a scoped label.
    const changeIds = scopedChangeId === undefined ? all : all.filter((entry) => entry === scopedChangeId);
    changeCount = changeIds.length;
    for (const changeId of changeIds) {
      const escalated = await collectEscalations({ repositoryRoot, changeId });
      escalations += escalated.total;
      for (const entry of escalated.escalations) escalationReasons.add(entry.reason);
      const taskgraph = await readTaskGraph({ repositoryRoot, changeId });
      if (taskgraph.ok) taskCount += taskgraph.document.tasks.length;
      const complete = await isChangeComplete({ repositoryRoot, changeId });
      if (complete.complete) changesComplete += 1;
      const reviews = await listReviewDecisionsForChange({ repositoryRoot, changeId });
      if (reviews.ok) {
        acceptedReviews += reviews.reviews.filter((review) => review.document.status === "accepted").length;
        // First pass means the first review of a task carried the verdict, so
        // the revision that superseded nothing is the one to look at. A task
        // reviewed twice appears once here regardless of how the retry went.
        // `supersedes` is a required array — `[]` on a first review, never
        // absent — so this is a length test, not a presence test.
        const firstAttempts = reviews.reviews.filter((review) => review.document.supersedes.length === 0);
        tasksReviewed += firstAttempts.length;
        firstPassPassed += firstAttempts.filter((review) => review.document.status === "accepted").length;
      }
    }
  }

  return {
    // Under a scope, the project's current stage and its recent guidance runs
    // describe whatever is happening now — which, for a phase completed before
    // later ones, is later project activity. Feeding those to the executor is
    // exactly the mislabelled-scope defect this selector exists to prevent, so
    // scoped mode omits them rather than filtering them: a guidance run records
    // no change, so there is nothing to filter on.
    ...(scopedChangeId === undefined ? { stage: state.stage } : { scopedChangeId }),
    changeCount,
    taskCount,
    acceptedReviews,
    escalations,
    escalationReasons: [...escalationReasons].sort(),
    changesComplete,
    firstPassReviews: { passed: firstPassPassed, reviewed: tasksReviewed },
    recentRuns: scopedChangeId === undefined ? recentRuns.map((run) => `${run.workflow}/${run.runId}: ${run.status}`) : [],
    summary: `${scopedChangeId === undefined ? `stage ${state.stage}` : `change ${scopedChangeId}`}, ${changeCount} change(s), ${taskCount} task(s), ${acceptedReviews} passing review(s), ${escalations} escalation(s)`
  };
}

export function renderRetroEvidence(evidence: RetroEvidence): string {
  return [
    evidence.scopedChangeId === undefined
      ? "Evidence from the project's committed artifacts. Ground every finding in it and say when it is insufficient:"
      : `Evidence from change ${evidence.scopedChangeId} alone. Ground every finding in it and say when it is insufficient. Project-wide stage and recent runs are deliberately excluded: they describe current activity, not this phase's.`,
    evidence.stage === undefined ? undefined : `- Workflow stage: ${evidence.stage}`,
    `- Changes recorded: ${evidence.changeCount} (${evidence.changesComplete} complete)`,
    `- Tasks planned across those changes: ${evidence.taskCount}`,
    `- Reviews with a passing verdict: ${evidence.acceptedReviews}`,
    evidence.firstPassReviews.reviewed === 0
      ? "- First-pass review rate: no task has been reviewed yet"
      : `- First-pass review rate: ${evidence.firstPassReviews.passed} of ${evidence.firstPassReviews.reviewed} passed on the first review`,
    `- Escalations (blocked runs and blocking findings): ${evidence.escalations}`,
    evidence.escalationReasons.length === 0
      ? "- Escalation reasons: none"
      : `- Escalation reasons: ${evidence.escalationReasons.join(", ")}`,
    evidence.scopedChangeId !== undefined
      ? undefined
      : evidence.recentRuns.length === 0
        ? "- Recent workflow runs: none"
        : `- Recent workflow runs:\n${evidence.recentRuns.map((run) => `  - ${run}`).join("\n")}`
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
