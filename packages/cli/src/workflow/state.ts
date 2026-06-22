import { listCurrentSpecs } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";
import { loadWorkflowProject } from "./context.js";
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

  const specs = await listCurrentSpecs({ repositoryRoot: context.repositoryRoot });
  const currentSpecCount = specs.ok ? specs.documents.length : 0;

  return {
    stage: "started",
    projectId: project.loaded.project.id,
    currentSpecCount,
    nextAction: nextAction("legion plan 1", "Project is initialized and ready for the first planned change."),
    diagnostics: specs.ok ? [] : specs.diagnostics
  };
}
