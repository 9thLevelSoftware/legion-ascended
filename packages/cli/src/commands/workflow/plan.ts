import {
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  readCurrentSpec,
  writeTaskGraph,
  type ArtifactDiagnostic,
  type CurrentSpecSuccess
} from "@legion/artifacts";
import type { Project, UtcTimestamp } from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import {
  buildChangeBundleInput,
  buildPhaseCurrentSpecInput,
  currentUtcTimestamp,
  resolveBaseGitSha
} from "../../workflow/change-input.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import { buildOracleArtifactInput } from "../../workflow/oracle-input.js";
import { resolvePhaseSource, type PhaseSource } from "../../workflow/phase-compat.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";
import { buildTaskGraphInput } from "../../workflow/taskgraph-input.js";

const PLAN_USAGE = "Use: legion plan 1";
const PLAN_FROM_ROADMAP_USAGE = "Use: legion plan 1 --from-roadmap ROADMAP.md";
const PLAN_HELP = `legion plan <phase-number> [--from-roadmap <path>] [--dry-run] [--auto-refine]

Create a typed change bundle, oracle artifact, and taskgraph for a roadmap phase.

Examples:
  legion plan 1 --from-roadmap ROADMAP.md
  legion plan 1 --from-roadmap ROADMAP.md --dry-run --json`;

export async function handlePlanWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(PLAN_HELP);
  }

  const phaseNumberResult = parsePhaseNumber(context.args.positionals[0]);
  if (typeof phaseNumberResult !== "number") return phaseNumberResult;

  const fromRoadmapResult = validateFromRoadmapOption(context);
  if (fromRoadmapResult !== undefined) return fromRoadmapResult;

  const workflowState = await resolveWorkflowState(context);
  if (workflowState.stage === "uninitialized") {
    return blockedPlan(workflowState.diagnostics, workflowState.nextAction);
  }
  if (workflowState.stage === "blocked") {
    return blockedPlan(workflowState.diagnostics, workflowState.nextAction);
  }

  const resolved = await resolvePhaseSource(context, phaseNumberResult);
  if (!resolved.ok) {
    const diagnostics = [resolved.diagnostic];
    const action = nextAction(
      "legion explore",
      "A phase source is required before planning can produce a task graph."
    );
    return failure(
      {
        ok: false,
        status: "blocked",
        diagnostics,
        nextAction: action
      },
      [
        "Planning is blocked.",
        renderDiagnostics(diagnostics),
        renderNextAction(action)
      ].join("\n")
    );
  }

  const action = nextAction(
    "legion build",
    "The phase source is resolved; build is the next workflow step after task artifacts exist."
  );
  const dryRun = hasFlag(context, "dry-run");
  if (dryRun) {
    return success(
      {
        ok: true,
        status: "planned",
        dryRun,
        phase: resolved.phase,
        autoRefine: hasFlag(context, "auto-refine"),
        nextAction: action,
        diagnostics: []
      },
      planningSuccessHuman(resolved.phase.number, resolved.phase.name, dryRun, action)
    );
  }

  const loadedProject = await loadWorkflowProject(context);
  if (!loadedProject.ok) {
    return blockedPlan(loadedProject.diagnostics, workflowState.nextAction);
  }

  const createdAt = currentUtcTimestamp();
  const baseGitSha = resolveBaseGitSha(context.repositoryRoot);
  const currentSpec = await ensurePhaseCurrentSpec({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    phase: resolved.phase,
    createdAt
  });
  if (!currentSpec.ok) {
    return artifactCreationFailure("current-spec", currentSpec.status, currentSpec.diagnostics, action);
  }

  const change = await createChangeBundle(buildChangeBundleInput({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    phase: resolved.phase,
    currentSpec,
    baseGitSha,
    createdAt
  }));
  if (!change.ok) {
    return artifactCreationFailure("change", change.status, change.diagnostics, action);
  }

  const oracle = await createOracleArtifact(buildOracleArtifactInput({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    phase: resolved.phase,
    change,
    baseGitSha,
    createdAt
  }));
  if (!oracle.ok) {
    return artifactCreationFailure("oracle", oracle.status, oracle.diagnostics, action);
  }

  const taskgraph = await writeTaskGraph(buildTaskGraphInput({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    phase: resolved.phase,
    change,
    oracle,
    baseGitSha,
    createdAt
  }));
  if (!taskgraph.ok) {
    return artifactCreationFailure("taskgraph", taskgraph.status, taskgraph.diagnostics, action);
  }

  return success(
    {
      ok: true,
      status: "planned",
      dryRun,
      phase: resolved.phase,
      change: {
        changeId: change.bundle.change.id,
        artifactPath: change.artifactPath,
        status: change.status
      },
      oracle: {
        oracleId: oracle.document.id,
        artifactPath: oracle.artifactPath,
        status: oracle.status
      },
      taskgraph: {
        artifactPath: taskgraph.artifactPath,
        status: taskgraph.status,
        taskIds: taskgraph.document.tasks.map((task) => task.id)
      },
      autoRefine: hasFlag(context, "auto-refine"),
      nextAction: action,
      diagnostics: []
    },
    planningSuccessHuman(resolved.phase.number, resolved.phase.name, dryRun, action)
  );
}

function parsePhaseNumber(value: string | undefined): number | CliResult {
  if (value === undefined) {
    return usageError(`Missing phase number. ${PLAN_USAGE}`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return usageError(`Invalid phase number "${value}". Use a positive integer. ${PLAN_USAGE}`);
  }
  return Number.parseInt(value, 10);
}

function validateFromRoadmapOption(context: CliContext): CliResult | undefined {
  if (!context.args.options.has("from-roadmap")) return undefined;

  const value = context.args.options.get("from-roadmap");
  if (typeof value === "string" && value.trim().length > 0) return undefined;

  return usageError(`Missing required option --from-roadmap. ${PLAN_FROM_ROADMAP_USAGE}`);
}

function blockedPlan(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics,
      nextAction: action
    },
    [
      "Planning is blocked.",
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}

function artifactCreationFailure(
  kind: "current-spec" | "change" | "oracle" | "taskgraph",
  status: "invalid" | "not_found" | "conflict",
  diagnostics: readonly ArtifactDiagnostic[],
  action: ReturnType<typeof nextAction>
): CliResult {
  const label = kind === "current-spec"
    ? "Current spec"
    : kind === "taskgraph"
      ? "Taskgraph"
      : kind[0]?.toUpperCase() + kind.slice(1);
  return failure(
    {
      ok: false,
      status,
      failedStep: kind,
      diagnostics,
      nextAction: action
    },
    [
      `${label} creation failed during planning.`,
      renderDiagnostics(diagnostics),
      renderNextAction(action)
    ].join("\n")
  );
}

async function ensurePhaseCurrentSpec(input: {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly phase: PhaseSource;
  readonly createdAt: UtcTimestamp;
}): Promise<CurrentSpecSuccess | {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}> {
  const specInput = buildPhaseCurrentSpecInput(input);
  const existing = await readCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    requirementId: specInput.document.primaryRequirementId
  });
  if (existing.ok) return existing;
  if (existing.status !== "not_found") return existing;
  return createCurrentSpec(specInput);
}

function planningSuccessHuman(
  phaseNumber: number,
  phaseName: string,
  dryRun: boolean,
  action: ReturnType<typeof nextAction>
): string {
  const summary = dryRun
    ? `Planning preview for phase ${phaseNumber}: ${phaseName}.`
    : `Created typed planning artifacts for phase ${phaseNumber}: ${phaseName}.`;
  const mode = dryRun
    ? "Dry run: no task graph was written."
    : "Change, oracle, and taskgraph artifacts were written.";
  return [summary, mode, renderNextAction(action)].join("\n");
}
