import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { listCurrentSpecs, listReviewDecisionsForChange, loadChangeBundle, readEvidenceIndex, readTaskGraph } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";
import { loadWorkflowProject, validateWorkflowProject } from "./context.js";
import { latestEvidenceEntries } from "./evidence-selection.js";
import { taskIdForContractId } from "./run-artifacts.js";
import { nextAction, type NextAction } from "./render.js";

export type WorkflowStage =
  | "uninitialized"
  | "started"
  | "planned"
  | "built"
  | "reviewed"
  | "ship_ready"
  | "blocked";

export interface WorkflowState {
  readonly stage: WorkflowStage;
  readonly projectId: string | null;
  readonly currentSpecCount: number;
  readonly nextAction: NextAction;
  readonly diagnostics: readonly unknown[];
}

export interface LatestWorkflowChangeSuccess {
  readonly ok: true;
  readonly changeId: string;
}

export interface LatestWorkflowChangeFailure {
  readonly ok: false;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
}

export type LatestWorkflowChangeResult = LatestWorkflowChangeSuccess | LatestWorkflowChangeFailure;
type LatestWorkflowChangeDiagnostic = LatestWorkflowChangeFailure["diagnostics"][number];

export async function resolveWorkflowState(context: CliContext): Promise<WorkflowState> {
  const project = await loadWorkflowProject(context);
  if (!project.ok) {
    if (project.reason === "not_found") {
      return {
        stage: "uninitialized",
        projectId: null,
        currentSpecCount: 0,
        nextAction: nextAction("legion start", "No .legion/project/project.json exists."),
        diagnostics: project.diagnostics
      };
    }

    return {
      stage: "blocked",
      projectId: null,
      currentSpecCount: 0,
      nextAction: nextAction("legion validate", "Project state must be repaired before planning can continue."),
      diagnostics: project.diagnostics
    };
  }

  const validation = await validateWorkflowProject(context);
  if (!validation.ok) {
    return {
      stage: "blocked",
      projectId: project.loaded.project.id,
      currentSpecCount: 0,
      nextAction: nextAction("legion validate", "Project state must be repaired before planning can continue."),
      diagnostics: validation.diagnostics
    };
  }

  const specs = await listCurrentSpecs({ repositoryRoot: context.repositoryRoot });
  if (!specs.ok) {
    return {
      stage: "blocked",
      projectId: project.loaded.project.id,
      currentSpecCount: 0,
      nextAction: nextAction("legion validate", "Current project truth must be repaired before planning can continue."),
      diagnostics: specs.diagnostics
    };
  }

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    if (latestChange.diagnostics.every((diagnostic) => diagnostic.code === "change_missing")) {
      return {
        stage: "started",
        projectId: project.loaded.project.id,
        currentSpecCount: specs.documents.length,
        nextAction: nextAction("legion plan 1", "Project is initialized and ready for the first planned change."),
        diagnostics: []
      };
    }

    return {
      stage: "blocked",
      projectId: project.loaded.project.id,
      currentSpecCount: specs.documents.length,
      nextAction: nextAction("legion validate", "Workflow change state must be repaired before build can continue."),
      diagnostics: latestChange.diagnostics
    };
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return {
      stage: "blocked",
      projectId: project.loaded.project.id,
      currentSpecCount: specs.documents.length,
      nextAction: nextAction("legion validate", "The latest workflow change must have a valid taskgraph before build can continue."),
      diagnostics: taskgraph.diagnostics
    };
  }

  const evidence = await readEvidenceIndex({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  const reviews = await listReviewDecisionsForChange({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (evidence.ok && reviews.ok && hasAcceptedReview(reviews.reviews) && hasAcceptedEvidence(evidence.document.entries)) {
    return {
      stage: "ship_ready",
      projectId: project.loaded.project.id,
      currentSpecCount: specs.documents.length,
      nextAction: nextAction("legion ship", "Accepted review and evidence are ready for the ship readiness gate."),
      diagnostics: []
    };
  }

  if (reviews.ok && reviews.reviews.length > 0) {
    return {
      stage: "reviewed",
      projectId: project.loaded.project.id,
      currentSpecCount: specs.documents.length,
      nextAction: nextAction("legion review --accept", "A review decision exists and may need human acceptance."),
      diagnostics: []
    };
  }

  if (evidence.ok && evidence.document.entries.length > 0) {
    return {
      stage: "built",
      projectId: project.loaded.project.id,
      currentSpecCount: specs.documents.length,
      nextAction: nextAction("legion review", "Build evidence exists and is ready for review."),
      diagnostics: []
    };
  }

  return {
    stage: "planned",
    projectId: project.loaded.project.id,
    currentSpecCount: specs.documents.length,
    nextAction: nextAction("legion build", "Latest planned change is ready for guided build execution."),
    diagnostics: []
  };
}

function hasAcceptedReview(reviews: readonly { readonly document: { readonly status: string } }[]): boolean {
  return reviews.some((review) => review.document.status === "accepted");
}

function hasAcceptedEvidence(entries: readonly { readonly acceptance: { readonly status: string } }[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.acceptance.status === "accepted");
}

export interface WorkflowChangeSummary {
  readonly changeId: string;
  readonly createdAt: string;
}

export type ListWorkflowChangesResult =
  | { readonly ok: true; readonly changes: readonly WorkflowChangeSummary[] }
  | LatestWorkflowChangeFailure;

/**
 * Every change that loads as a valid typed bundle, oldest first.
 *
 * This walk already existed inside `findLatestWorkflowChangeId`, which built the
 * whole list and then returned only its last element. Anything else wanting to
 * reason across changes — a retrospective scoped to a phase, a milestone's
 * progress — had nowhere to get one, and a first attempt at retro evidence
 * counted raw directories instead, which counts `LEGION-NEXT/` (a docs folder
 * with no change.yaml) as a change.
 *
 * Validity is load-bearing: a directory is not a change, and a bundle that does
 * not parse is reported rather than counted.
 */
export async function listWorkflowChanges(repositoryRoot: string): Promise<ListWorkflowChangesResult> {
  const changesRoot = path.join(repositoryRoot, ".legion", "project", "changes");
  let entries: Dirent[];
  try {
    entries = await readdir(changesRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return noWorkflowChange(changesRoot);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [
        {
          code: "change_discovery_failed",
          message: `Failed to inspect workflow changes: ${message}`,
          path: changesRoot
        }
      ]
    };
  }

  const changeIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (changeIds.length === 0) return noWorkflowChange(changesRoot);

  const validChanges: WorkflowChangeSummary[] = [];
  const diagnostics: LatestWorkflowChangeDiagnostic[] = [];
  for (const changeId of changeIds) {
    const bundle = await loadChangeBundle({ repositoryRoot, changeId });
    if (bundle.ok) {
      validChanges.push({ changeId, createdAt: bundle.bundle.change.createdAt });
      continue;
    }
    diagnostics.push(...bundle.diagnostics);
  }

  if (validChanges.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "change_discovery_failed",
          message: "Workflow change directories exist, but none could be loaded as valid typed change bundles.",
          path: changesRoot
        },
        ...diagnostics
      ]
    };
  }

  validChanges.sort((left, right) => {
    const byCreatedAt = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.changeId < right.changeId ? -1 : left.changeId > right.changeId ? 1 : 0;
  });

  return { ok: true, changes: validChanges };
}

export async function findLatestWorkflowChangeId(repositoryRoot: string): Promise<LatestWorkflowChangeResult> {
  const listed = await listWorkflowChanges(repositoryRoot);
  if (!listed.ok) return listed;
  const latest = listed.changes.at(-1);
  if (latest === undefined) return noWorkflowChange(path.join(repositoryRoot, ".legion", "project", "changes"));
  return { ok: true, changeId: latest.changeId };
}

/**
 * Whether one named change is finished, rather than whether the latest one is.
 *
 * `resolveWorkflowState` answers only for the newest change, so nothing could
 * ask "is change X complete" — which a scoped retrospective and a milestone gate
 * both need. The rule is the one `ship_ready` already uses, stated per change:
 * the taskgraph has at least one task, every task's latest evidence is accepted,
 * and an accepted review exists.
 *
 * Note what this deliberately does not consult: `change.acceptance`. Nothing
 * promotes a change out of `draft`, so keying completeness to it would report
 * every change incomplete forever.
 */
export async function isChangeComplete(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<{ readonly complete: boolean; readonly reason: string }> {
  const taskgraph = await readTaskGraph({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (!taskgraph.ok) return { complete: false, reason: "The taskgraph could not be read." };
  if (taskgraph.document.tasks.length === 0) return { complete: false, reason: "The taskgraph has no tasks." };

  const evidence = await readEvidenceIndex({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (!evidence.ok) return { complete: false, reason: "No evidence has been collected." };

  const latest = latestEvidenceEntries(evidence.document.entries);
  const taskIds = new Set(taskgraph.document.tasks.map((task) => taskIdForContractId(task.id)));
  for (const taskId of taskIds) {
    const entry = latest.find((candidate) => candidate.evidence.taskId === taskId);
    if (entry === undefined) return { complete: false, reason: `Task ${taskId} has no evidence.` };
    if (entry.acceptance.status !== "accepted") {
      return { complete: false, reason: `Task ${taskId} evidence is ${entry.acceptance.status}, not accepted.` };
    }
  }

  const reviews = await listReviewDecisionsForChange({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (!reviews.ok) return { complete: false, reason: "Review decisions could not be read." };
  if (!reviews.reviews.some((review) => review.document.status === "accepted")) {
    return { complete: false, reason: "No accepted review covers this change." };
  }

  return { complete: true, reason: "Every task's evidence is accepted and an accepted review covers the change." };
}

function noWorkflowChange(changesRoot: string): LatestWorkflowChangeFailure {
  return {
    ok: false,
    diagnostics: [
      {
        code: "change_missing",
        message: "No planned change exists. Run legion plan 1 first.",
        path: changesRoot
      }
    ]
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
