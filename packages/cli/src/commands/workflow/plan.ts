import {
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  readCurrentSpec,
  readRequirementSet,
  writeTaskGraph,
  type ArtifactDiagnostic,
  type CurrentSpecSuccess
} from "@legion/artifacts";
import type { Project, Requirement, UtcTimestamp } from "@legion/protocol";

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
import { resolvePhaseRequirement } from "../../workflow/phase-requirement.js";
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

  // Read first, so a corrupt requirement set is reported as corrupt rather than
  // as a phase whose requirement cannot be resolved. Both are refusals, but they
  // name different repairs.
  // Read here rather than defaulted inside the builder so a project with no
  // requirement set is visibly a different case from one whose operator chose
  // the repository-wide limits.
  const requirementSet = await readRequirementSet(context.repositoryRoot);
  // `not_found` is a project that never held an interview, which plans on
  // repository defaults. `invalid` is a requirement set that exists and is
  // damaged — treating the two alike silently dropped the recorded risk tier,
  // budget and verification command and emitted a task under defaults the
  // operator never chose.
  if (!requirementSet.ok && requirementSet.status === "invalid") {
    return failure(
      {
        ok: false,
        status: "requirement_set_invalid",
        diagnostics: [{ code: "requirement_set_invalid", message: requirementSet.reason }],
        nextAction: nextAction("legion validate", "Repair the requirement set before planning against it.")
      },
      `The requirement set is invalid, so planning would silently use defaults instead of the recorded policy.
  - ${requirementSet.reason}`
    );
  }
  const enforcement = requirementSet.ok ? requirementSet.set.enforcement : undefined;

  // The requirement this phase was rendered from. A roadmap that names one it
  // cannot resolve is a broken trace, not an absent one — planning against a
  // stale roadmap would silently produce a contract for a requirement that no
  // longer exists.
  const phaseRequirement = await resolvePhaseRequirement(context.repositoryRoot, resolved.phase);
  if (phaseRequirement.ok === false) {
    return failure(
      {
        ok: false,
        status: "requirement_unresolved",
        diagnostics: [{ code: "requirement_unresolved", message: phaseRequirement.reason }],
        nextAction: nextAction("legion validate", "Repair the roadmap or requirement set, then plan again.")
      },
      `Planning is blocked.
  - ${phaseRequirement.reason}`
    );
  }
  const requirement = phaseRequirement.ok === true ? phaseRequirement.resolved : undefined;

  const currentSpec = await ensurePhaseCurrentSpec({
    repositoryRoot: context.repositoryRoot,
    project: loadedProject.loaded.project,
    phase: resolved.phase,
    ...(requirement === undefined ? {} : { requirement: requirement.requirement }),
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
    ...(requirement === undefined ? {} : { requirement: requirement.requirement }),
    ...(enforcement === undefined ? {} : { enforcement: enforcement.risk }),
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
    ...(requirement === undefined ? {} : { requirement }),
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
    createdAt,
    ...(enforcement === undefined ? {} : { enforcement }),
    ...(requirement === undefined ? {} : { requirement })
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
  readonly requirement?: Requirement;
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
