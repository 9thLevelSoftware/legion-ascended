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
 *
 * Everything is read through the artifact services rather than by hand. A first
 * version parsed JSON directly and treated a schema-invalid taskgraph as one
 * with no tasks, so `legion validate` reported success while every task contract
 * had effectively disappeared; and it resolved oracles by filename, so a
 * truncated or replaced oracle still counted as present.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  listCurrentSpecs,
  readOracleArtifact,
  readRequirementSet,
  readTaskGraph,
  type RequirementSet
} from "@legion/artifacts";

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
  /** IDs with no task yet, in requirement-set order. */
  readonly unplanned: readonly string[];
}

export interface TraceabilityReport {
  readonly diagnostics: readonly TraceabilityDiagnostic[];
  readonly coverage: RequirementCoverage;
}

const CHANGES_ROOT = ".legion/project/changes";

function taskgraphArtifactPath(changeId: string): string {
  return `${CHANGES_ROOT}/${changeId}/taskgraph.json`;
}

async function changeIds(repositoryRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path.join(repositoryRoot, ...CHANGES_ROOT.split("/")), {
      withFileTypes: true
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function budgetExceeds(
  taskBudget: { readonly [field: string]: number },
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
 * Requirement IDs a task may legitimately name.
 *
 * The intake set is not the only source. `legion quick` and `legion polish`
 * author a requirement into a current spec without adding it to the intake set,
 * so resolving against the set alone reported every ad-hoc task as unresolved —
 * and because those tasks verify with `legion validate`, their builds could
 * never complete. An ad-hoc requirement is still a real, typed requirement; it
 * just entered through a different door.
 */
async function resolvableRequirementIds(
  repositoryRoot: string,
  set: Awaited<ReturnType<typeof readRequirementSet>>
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  if (set.ok) for (const requirement of set.requirements) ids.add(requirement.id);

  const specs = await listCurrentSpecs({ repositoryRoot });
  if (specs.ok) {
    for (const document of specs.documents) {
      for (const requirement of document.requirements) ids.add(requirement.id);
    }
  }
  return ids;
}

/**
 * Check the references and budgets of every planned task.
 *
 * A project with no requirement set still has its references checked — ad-hoc
 * and imported projects have tasks too — but has no policy to check budgets
 * against and no expected coverage surface.
 */
export async function checkTraceability(repositoryRoot: string): Promise<TraceabilityReport> {
  const set = await readRequirementSet(repositoryRoot);
  const resolvable = await resolvableRequirementIds(repositoryRoot, set);
  const diagnostics: TraceabilityDiagnostic[] = [];
  const covered = new Set<string>();

  for (const changeId of await changeIds(repositoryRoot)) {
    const artifactPath = taskgraphArtifactPath(changeId);
    const graph = await readTaskGraph({ repositoryRoot, changeId });

    if (!graph.ok) {
      // `not_found` is an unplanned change, which is ordinary. Anything else is
      // a taskgraph that exists and cannot be trusted: treating it as empty let
      // `{"tasks":"corrupt"}` pass as a change with no tasks, so validate
      // reported success while every contract in it had disappeared.
      if (graph.status === "not_found") continue;
      diagnostics.push({
        code: "taskgraph_unreadable",
        message: `${artifactPath} exists but is not a valid taskgraph, so its tasks cannot be checked: ${graph.diagnostics
          .map((entry) => entry.message)
          .join("; ")}`,
        source: { path: artifactPath }
      });
      continue;
    }

    for (const task of graph.document.tasks) {
      for (const requirementId of task.requirementIds) {
        if (resolvable.has(requirementId)) {
          covered.add(requirementId);
          continue;
        }
        diagnostics.push({
          code: "task_requirement_unresolved",
          message: `${task.id} names requirement ${requirementId}, which is not in the requirement set or any current spec.`,
          source: { path: artifactPath }
        });
      }

      for (const oracleId of task.oracleRefs) {
        // Read through the oracle service, not matched by filename. A file
        // merely having the right basename made a truncated, empty or
        // ID-mismatched oracle count as present.
        const oracle = await readOracleArtifact({ repositoryRoot, changeId, oracleId });
        if (oracle.ok && oracle.document.id === oracleId) continue;
        diagnostics.push({
          code: "task_oracle_unresolved",
          message: `${task.id} names oracle ${oracleId}, which does not exist as a valid oracle in ${changeId}.`,
          source: { path: artifactPath }
        });
      }

      const policy = set.ok ? set.set.enforcement?.budget : undefined;
      if (policy !== undefined) {
        const over = budgetExceeds(task.scope.budget, policy);
        if (over.length > 0) {
          diagnostics.push({
            code: "task_budget_exceeds_policy",
            message: `${task.id} grants itself a wider blast radius than the project policy: ${over.join("; ")}.`,
            source: { path: artifactPath }
          });
        }
      }
    }
  }

  // A `wont` requirement is a recorded decision not to build, so it is not part
  // of the surface a project is expected to cover.
  const expected = set.ok
    ? set.requirements.filter((requirement) => requirement.priority !== "wont").map((r) => r.id)
    : [];

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
