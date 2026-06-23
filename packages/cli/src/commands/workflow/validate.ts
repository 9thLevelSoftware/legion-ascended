import { stat } from "node:fs/promises";
import path from "node:path";

import {
  failure,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { validateWorkflowProject } from "../../workflow/context.js";
import { renderDiagnostics } from "../../workflow/render.js";

interface ShallowCheck {
  readonly ok: boolean;
  readonly status: string;
  readonly path?: string;
  readonly message?: string;
}

export async function handleValidateCommand(context: CliContext): Promise<CliResult> {
  const result = await validateWorkflowProject(context);
  const payload = {
    ...result,
    status: result.ok ? "valid" : result.status
  };

  if (!result.ok) {
    return failure(payload, validationFailureHuman(result.diagnostics));
  }

  return success(payload, "Project is valid.");
}

export async function handleDoctorCommand(context: CliContext): Promise<CliResult> {
  const result = await validateWorkflowProject(context);
  const checks = {
    project: {
      ok: result.ok,
      status: result.ok ? "valid" : result.status,
      diagnostics: result.diagnostics
    },
    operationalStore: await pathCheck(context.repositoryRoot, ".legion/var"),
    workerBundles: await pathCheck(context.repositoryRoot, "bundles/index.json")
  };
  const payload = {
    ...result,
    status: result.ok ? "valid" : result.status,
    checks
  };

  if (!result.ok) {
    return failure(payload, `Doctor found project validation issues.\n${renderDiagnostics(result.diagnostics)}`);
  }

  return success(payload, doctorHuman(checks));
}

function validationFailureHuman(diagnostics: readonly unknown[]): string {
  const rendered = renderDiagnostics(diagnostics);
  return rendered.length > 0 ? `Project validation failed.\n${rendered}` : "Project validation failed.";
}

async function pathCheck(root: string, relativePath: string): Promise<ShallowCheck> {
  try {
    await stat(path.join(root, relativePath));
    return {
      ok: true,
      status: "present",
      path: relativePath
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        ok: false,
        status: "missing",
        path: relativePath,
        message: `${relativePath} was not found.`
      };
    }
    throw error;
  }
}

function doctorHuman(checks: {
  readonly project: ShallowCheck & { readonly diagnostics: readonly unknown[] };
  readonly operationalStore: ShallowCheck;
  readonly workerBundles: ShallowCheck;
}): string {
  return [
    "Doctor checks completed.",
    `Project: ${checks.project.status}`,
    `Operational store: ${checks.operationalStore.status}`,
    `Worker bundles: ${checks.workerBundles.status}`
  ].join("\n");
}
