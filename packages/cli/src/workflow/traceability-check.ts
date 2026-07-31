/**
 * Checking that the links between requirements, oracles and tasks resolve.
 *
 * The artifacts reference each other by ID, and until now nothing verified that
 * those IDs pointed at anything. A task could name a requirement that had been
 * removed, or an oracle belonging to a change that no longer existed, and every
 * command downstream would treat the contract as intact — traceability was a
 * naming convention rather than a checked property.
 *
 * Budget conformance sits here for the same reason. `scope.budget` is what diff
 * reconciliation enforces, so a task contract that raises its own budget above
 * the project policy has escaped the limit the operator set, while still
 * appearing to be governed by it.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readRequirementSet, type RequirementSet } from "@legion/artifacts";

export interface TraceabilityDiagnostic {
  readonly code:
    | "task_requirement_unresolved"
    | "task_oracle_unresolved"
    | "task_budget_exceeds_policy"
    | "taskgraph_unreadable";
  readonly message: string;
  readonly source: { readonly path: string };
}

export interface RequirementCoverage {
  /** Requirements in the set, excluding those recorded as out of scope. */
  readonly requirements: number;
  readonly planned: number;
  /** IDs with no task yet, newest phase last. */
  readonly unplanned: readonly string[];
}

export interface TraceabilityReport {
  readonly diagnostics: readonly TraceabilityDiagnostic[];
  readonly coverage: RequirementCoverage;
}

interface LoadedTaskGraph {
  readonly artifactPath: string;
  readonly changeId: string;
  readonly tasks: readonly Record<string, unknown>[];
}

const CHANGES_ROOT = ".legion/project/changes";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringsAt(task: Record<string, unknown>, key: string): readonly string[] {
  const value = task[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Every taskgraph on disk, with the change directory it belongs to. */
async function loadTaskGraphs(
  repositoryRoot: string
): Promise<{ readonly graphs: readonly LoadedTaskGraph[]; readonly unreadable: readonly string[] }> {
  const root = path.join(repositoryRoot, ".legion", "project", "changes");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { graphs: [], unreadable: [] };
  }

  const graphs: LoadedTaskGraph[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const artifactPath = `${CHANGES_ROOT}/${entry.name}/taskgraph.json`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(root, entry.name, "taskgraph.json"), "utf8"));
    } catch (error) {
      // A missing taskgraph is an unplanned change, which is ordinary. Anything
      // else means a planned change cannot be checked, and silence there would
      // be indistinguishable from having nothing to check.
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      unreadable.push(artifactPath);
      continue;
    }

    const document = asRecord(parsed);
    const tasks = Array.isArray(document?.["tasks"]) ? document["tasks"] : [];
    graphs.push({
      artifactPath,
      changeId: entry.name,
      tasks: tasks.map(asRecord).filter((task): task is Record<string, unknown> => task !== undefined)
    });
  }
  return { graphs, unreadable };
}

/** Oracle IDs available to a change, taken from its own oracle directory. */
async function oracleIdsForChange(repositoryRoot: string, changeId: string): Promise<ReadonlySet<string>> {
  const oracleRoot = path.join(repositoryRoot, ".legion", "project", "changes", changeId, "oracle");
  try {
    const entries = await readdir(oracleRoot, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name.replace(/\.(ya?ml|json)$/i, ""))
    );
  } catch {
    return new Set();
  }
}

function budgetAt(task: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(task["scope"])?.["budget"]);
}

function budgetExceeds(
  taskBudget: Record<string, unknown>,
  policy: NonNullable<RequirementSet["enforcement"]>["budget"]
): readonly string[] {
  const over: string[] = [];
  for (const [field, limit] of Object.entries(policy)) {
    const value = taskBudget[field];
    if (typeof value === "number" && value > limit) {
      over.push(`${field} is ${value}, policy allows ${limit}`);
    }
  }
  return over;
}

/**
 * Check the references and budgets of every planned task.
 *
 * Returns an empty report for a project with no requirement set: direct
 * initialization and the legacy importer both produce one, and their tasks have
 * nothing to trace to.
 */
export async function checkTraceability(repositoryRoot: string): Promise<TraceabilityReport> {
  const set = await readRequirementSet(repositoryRoot);
  const { graphs, unreadable } = await loadTaskGraphs(repositoryRoot);

  const diagnostics: TraceabilityDiagnostic[] = unreadable.map((artifactPath) => ({
    code: "taskgraph_unreadable" as const,
    message: `${artifactPath} exists but could not be read, so its tasks cannot be checked.`,
    source: { path: artifactPath }
  }));

  if (!set.ok) {
    return {
      diagnostics,
      coverage: { requirements: 0, planned: 0, unplanned: [] }
    };
  }

  const requirementIds = new Set(set.requirements.map((requirement) => requirement.id));
  // A `wont` requirement is a recorded decision not to build, so it is not part
  // of the surface a project is expected to cover.
  const expected = set.requirements
    .filter((requirement) => requirement.priority !== "wont")
    .map((requirement) => requirement.id);
  const covered = new Set<string>();

  for (const graph of graphs) {
    const oracleIds = await oracleIdsForChange(repositoryRoot, graph.changeId);

    for (const task of graph.tasks) {
      const taskId = typeof task["id"] === "string" ? task["id"] : "<unknown task>";

      for (const requirementId of stringsAt(task, "requirementIds")) {
        if (requirementIds.has(requirementId)) {
          covered.add(requirementId);
          continue;
        }
        diagnostics.push({
          code: "task_requirement_unresolved",
          message: `${taskId} names requirement ${requirementId}, which is not in the requirement set.`,
          source: { path: graph.artifactPath }
        });
      }

      for (const oracleId of stringsAt(task, "oracleRefs")) {
        if (oracleIds.has(oracleId)) continue;
        diagnostics.push({
          code: "task_oracle_unresolved",
          message: `${taskId} names oracle ${oracleId}, which does not exist in ${graph.changeId}.`,
          source: { path: graph.artifactPath }
        });
      }

      const policy = set.set.enforcement?.budget;
      const taskBudget = budgetAt(task);
      if (policy !== undefined && taskBudget !== undefined) {
        const over = budgetExceeds(taskBudget, policy);
        if (over.length > 0) {
          diagnostics.push({
            code: "task_budget_exceeds_policy",
            message: `${taskId} grants itself a wider blast radius than the project policy: ${over.join("; ")}.`,
            source: { path: graph.artifactPath }
          });
        }
      }
    }
  }

  return {
    diagnostics,
    coverage: {
      requirements: expected.length,
      planned: expected.filter((id) => covered.has(id)).length,
      // Reported, never failed. Later phases being unplanned is the normal state
      // of a project mid-flight; treating it as invalid would make `validate`
      // red for every such project and teach operators to ignore it.
      unplanned: expected.filter((id) => !covered.has(id))
    }
  };
}
