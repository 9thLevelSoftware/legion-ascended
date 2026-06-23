import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { containsOnlyPreInitWorkflowRecords, loadProject, validateProject } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";

export type WorkflowProjectState =
  | { readonly ok: true; readonly loaded: Extract<Awaited<ReturnType<typeof loadProject>>, { readonly ok: true }> }
  | { readonly ok: false; readonly reason: "not_found" | "invalid" | "migration_required"; readonly diagnostics: readonly unknown[] };

export async function loadWorkflowProject(context: CliContext): Promise<WorkflowProjectState> {
  const loaded = await loadProject({ repositoryRoot: context.repositoryRoot });
  if (!loaded.ok) {
    if (loaded.status === "not_found") {
      const collisionDiagnostics = await detectPreInitCollision(context.repositoryRoot);
      if (collisionDiagnostics.length > 0) {
        return {
          ok: false,
          reason: "migration_required",
          diagnostics: collisionDiagnostics
        };
      }
    }

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

async function detectPreInitCollision(repositoryRoot: string): Promise<readonly unknown[]> {
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (!(await pathExists(legionRoot))) return [];

  const entries = await readdir(legionRoot, { withFileTypes: true });
  const unknownEntries = entries
    .map((entry) => entry.name)
    .filter((name) => name !== "project" && name !== "var" && name !== "legacy-protocol" && !isIgnorableLegionRootEntry(name))
    .sort();

  if (unknownEntries.length > 0) {
    return [
      migrationDiagnostic(`Existing .legion entries require explicit migration before initialization: ${unknownEntries.join(", ")}.`)
    ];
  }

  const projectRoot = path.join(legionRoot, "project");
  const manifestPath = path.join(projectRoot, "project.json");
  if ((await pathExists(projectRoot)) && !(await pathExists(manifestPath))) {
    if (await containsOnlyPreInitWorkflowRecords(projectRoot)) return [];
    return [
      migrationDiagnostic("Existing .legion/project data has no project manifest; explicit migration or reconciliation is required before initialization.")
    ];
  }

  return [];
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isIgnorableLegionRootEntry(name: string): boolean {
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}

function migrationDiagnostic(message: string): {
  readonly code: "migration_required";
  readonly message: string;
  readonly source: { readonly path: ".legion/project/project.json" };
} {
  return {
    code: "migration_required",
    message,
    source: { path: ".legion/project/project.json" }
  };
}
