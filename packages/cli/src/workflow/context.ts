import { loadProject, validateProject } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";

export type WorkflowProjectState =
  | { readonly ok: true; readonly loaded: Extract<Awaited<ReturnType<typeof loadProject>>, { readonly ok: true }> }
  | { readonly ok: false; readonly reason: "not_found" | "invalid" | "migration_required"; readonly diagnostics: readonly unknown[] };

export async function loadWorkflowProject(context: CliContext): Promise<WorkflowProjectState> {
  const loaded = await loadProject({ repositoryRoot: context.repositoryRoot });
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.status,
      diagnostics: loaded.diagnostics
    };
  }
  return { ok: true, loaded };
}

export async function validateWorkflowProject(context: CliContext) {
  return validateProject({ repositoryRoot: context.repositoryRoot });
}
