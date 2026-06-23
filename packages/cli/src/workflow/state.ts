import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { listCurrentSpecs, loadChangeBundle, readTaskGraph } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";
import { loadWorkflowProject, validateWorkflowProject } from "./context.js";
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

  return {
    stage: "planned",
    projectId: project.loaded.project.id,
    currentSpecCount: specs.documents.length,
    nextAction: nextAction("legion build --dry-run", "Latest planned change is ready for build readiness checks."),
    diagnostics: []
  };
}

export async function findLatestWorkflowChangeId(repositoryRoot: string): Promise<LatestWorkflowChangeResult> {
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

  const changeIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (changeIds.length === 0) return noWorkflowChange(changesRoot);

  const validChanges: { readonly changeId: string; readonly createdAt: string }[] = [];
  const diagnostics: LatestWorkflowChangeDiagnostic[] = [];
  for (const changeId of changeIds) {
    const bundle = await loadChangeBundle({ repositoryRoot, changeId });
    if (bundle.ok) {
      validChanges.push({
        changeId,
        createdAt: bundle.bundle.change.createdAt
      });
      continue;
    }

    diagnostics.push(...bundle.diagnostics);
  }

  validChanges.sort((left, right) => {
    const byCreatedAt = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.changeId < right.changeId ? -1 : left.changeId > right.changeId ? 1 : 0;
  });

  const latest = validChanges.at(-1);
  if (latest === undefined) {
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

  return {
    ok: true,
    changeId: latest.changeId
  };
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
