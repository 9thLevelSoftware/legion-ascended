import { stat } from "node:fs/promises";
import path from "node:path";

import { requirementSetIndexPath, verifyRequirementSet } from "@legion/artifacts";

import {
  failure,
  helpResult,
  success,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { validateWorkflowProject } from "../../workflow/context.js";
import { checkTraceability } from "../../workflow/traceability-check.js";
import { renderDiagnostics } from "../../workflow/render.js";

interface ShallowCheck {
  readonly ok: boolean;
  readonly status: string;
  readonly path?: string;
  readonly message?: string;
}

const VALIDATE_HELP = `legion validate

Validate committed Legion project state under .legion/project.

Examples:
  legion validate
  legion validate --json`;

const DOCTOR_HELP = `legion doctor

Validate project state and check shallow operational paths such as .legion/var and bundles/index.json.

Examples:
  legion doctor
  legion doctor --json`;

export async function handleValidateCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(VALIDATE_HELP);
  }

  const result = await validateWorkflowProject(context);
  // The requirement set hash is only worth writing if something recomputes it.
  // Without this the set could be edited, truncated or reordered under the
  // project and `legion validate` would still report "valid" — the drift the
  // hash exists to name was the one condition nothing looked for.
  const drift = await requirementSetDiagnostics(context.repositoryRoot);
  // References between requirements, oracles and tasks are IDs, and an ID that
  // resolves to nothing looks exactly like one that resolves.
  const trace = await checkTraceability(context.repositoryRoot);
  const diagnostics = [...result.diagnostics, ...drift, ...trace.diagnostics];
  const ok = result.ok && drift.length === 0 && trace.diagnostics.length === 0;
  const payload = {
    ...result,
    ok,
    diagnostics,
    coverage: trace.coverage,
    status: failureStatus(result, drift.length, trace.diagnostics.length)
  };

  if (!ok) {
    return failure(payload, validationFailureHuman(diagnostics));
  }

  return success(payload, `Project is valid.
${renderCoverage(trace.coverage)}`);
}

/**
 * One status label for a payload that can carry several kinds of failure.
 *
 * A nested ternary picked `requirement_set_drift` whenever drift was present,
 * so a project with both drift and a broken task reference reported a label that
 * excluded the traceability findings — the diagnostics told the truth while the
 * status misled anything filtering on it. Traceability now takes precedence
 * because it is the more specific failure, and both remain in `diagnostics`
 * either way.
 */
function failureStatus(
  result: { readonly ok: boolean; readonly status?: string },
  driftCount: number,
  traceCount: number
): string {
  if (!result.ok) return result.status ?? "invalid";
  if (traceCount > 0) return "traceability_broken";
  if (driftCount > 0) return "requirement_set_drift";
  return "valid";
}

/**
 * One line saying how much of the requirement set has been planned.
 *
 * Reported on success rather than as a diagnostic: later phases being unplanned
 * is the normal state of a project mid-flight, so failing on it would make
 * `validate` red for everyone and teach operators to ignore the result.
 */
function renderCoverage(coverage: {
  readonly requirements: number;
  readonly planned: number;
  readonly unplanned: readonly string[];
}): string {
  if (coverage.requirements === 0) return "No requirement set; nothing to trace.";
  const line = `Planned ${coverage.planned} of ${coverage.requirements} requirement(s).`;
  if (coverage.unplanned.length === 0) return line;
  return `${line} Not yet planned: ${coverage.unplanned.join(", ")}.`;
}

async function requirementSetDiagnostics(
  repositoryRoot: string
): Promise<readonly { readonly code: string; readonly message: string; readonly source: { readonly path: string } }[]> {
  const drift = await verifyRequirementSet(repositoryRoot);
  return drift.map((entry) => ({
    code: entry.code,
    message: entry.message,
    source: { path: requirementSetIndexPath() }
  }));
}

export async function handleDoctorCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") {
    return helpResult(DOCTOR_HELP);
  }

  const result = await validateWorkflowProject(context);
  // Doctor is the broader diagnostic, so it must not report a project healthy
  // that `legion validate` refuses. Two validation entrances that disagree teach
  // operators to trust whichever one is currently passing.
  const drift = await requirementSetDiagnostics(context.repositoryRoot);
  const trace = await checkTraceability(context.repositoryRoot);
  const checks = {
    project: {
      ok: result.ok,
      status: result.ok ? "valid" : result.status,
      diagnostics: result.diagnostics
    },
    requirementSet: {
      ok: drift.length === 0,
      status: drift.length === 0 ? "valid" : "requirement_set_drift",
      diagnostics: drift
    },
    traceability: {
      ok: trace.diagnostics.length === 0,
      status: trace.diagnostics.length === 0 ? "valid" : "traceability_broken",
      diagnostics: trace.diagnostics,
      coverage: trace.coverage
    },
    operationalStore: await pathCheck(context.repositoryRoot, ".legion/var"),
    workerBundles: await pathCheck(context.repositoryRoot, "bundles/index.json")
  };

  const ok = result.ok && drift.length === 0 && trace.diagnostics.length === 0;
  const diagnostics = [...result.diagnostics, ...drift, ...trace.diagnostics];
  const payload = {
    ...result,
    ok,
    diagnostics,
    status: failureStatus(result, drift.length, trace.diagnostics.length),
    checks
  };

  if (!ok) {
    return failure(payload, `Doctor found project validation issues.\n${renderDiagnostics(diagnostics)}`);
  }

  return success(payload, doctorHuman(checks));
}

function validationFailureHuman(diagnostics: readonly unknown[]): string {
  const rendered = renderDiagnostics(diagnostics);
  return rendered.length > 0 ? `Project validation failed.\n${rendered}` : "Project validation failed.";
}

export async function pathCheck(root: string, relativePath: string): Promise<ShallowCheck> {
  try {
    await stat(path.join(root, relativePath));
    return {
      ok: true,
      status: "present",
      path: relativePath
    };
  } catch (error) {
    const isMissing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: isMissing ? "missing" : "error",
      path: relativePath,
      message: isMissing ? `${relativePath} was not found.` : `Failed to check ${relativePath}: ${message}`
    };
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
