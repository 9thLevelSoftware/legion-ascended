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
  loadChangeBundle,
  readOracleArtifact,
  readRequirementSet,
  readTaskGraph,
  type RequirementSet
} from "@legion/artifacts";

export interface TraceabilityDiagnostic {
  readonly code:
    | "task_requirement_unresolved"
    | "task_oracle_unresolved"
    | "task_oracle_missing_coverage"
    | "artifact_root_unreadable"
    | "current_spec_invalid"
    | "change_bundle_invalid"
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
const CURRENT_SPECS_ROOT = ".legion/project/specs";

function taskgraphArtifactPath(changeId: string): string {
  return `${CHANGES_ROOT}/${changeId}/taskgraph.json`;
}

class ScanFailure extends Error {
  public constructor(
    public readonly root: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Read a directory, distinguishing "absent" from "unreadable".
 *
 * Shared by every directory this module scans. Guarding the changes root and
 * leaving the specs root unguarded was the same defect one directory over: an
 * unreadable specs root threw out of `legion validate` entirely instead of
 * producing a diagnostic, and a third scan added later would have repeated it.
 */
async function scan<T>(root: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return empty;
    }
    throw new ScanFailure(root, error instanceof Error ? error.message : String(error));
  }
}

async function changeIds(repositoryRoot: string): Promise<readonly string[]> {
  return scan(
    CHANGES_ROOT,
    async () => {
      const entries = await readdir(path.join(repositoryRoot, CHANGES_ROOT), {
        withFileTypes: true
      });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },
    []
  );
}

/**
 * The requirement IDs a task in one change may name, plus anything that went
 * wrong finding them.
 *
 * Diagnostics are returned rather than swallowed. Three review rounds on this
 * module were all the same defect: an artifact read that fails is not an
 * artifact read that returns nothing. A schema-invalid current spec, a change
 * bundle whose delta or design is corrupt, an unreadable directory — each was
 * treated as "no requirements from here", so validation passed on a project
 * whose committed artifacts archive would reject.
 *
 * Every read in this module now either contributes its result or contributes a
 * diagnostic. None are dropped, and none escape as exceptions.
 */
interface ResolvedRequirements {
  readonly ids: ReadonlySet<string>;
  readonly diagnostics: readonly TraceabilityDiagnostic[];
}

export async function resolvableRequirementIds(
  repositoryRoot: string,
  set: Awaited<ReturnType<typeof readRequirementSet>>,
  changeId: string
): Promise<ResolvedRequirements> {
  const ids = new Set<string>();
  const diagnostics: TraceabilityDiagnostic[] = [];
  if (set.ok) for (const requirement of set.requirements) ids.add(requirement.id);

  let specs: Awaited<ReturnType<typeof listCurrentSpecs>>;
  try {
    specs = await scan(
      CURRENT_SPECS_ROOT,
      () => listCurrentSpecs({ repositoryRoot }),
      { ok: true, status: "read", documents: [], index: undefined, diagnostics: [] } as never
    );
  } catch (error) {
    if (!(error instanceof ScanFailure)) throw error;
    return { ids, diagnostics: [scanDiagnostic(error)] };
  }

  if (specs.ok) {
    for (const document of specs.documents) {
      for (const requirement of document.requirements) ids.add(requirement.id);
    }
  } else {
    // A schema-invalid or duplicate-ID spec is a corrupted committed artifact.
    // Discarding the failure let validation pass whenever the same IDs happened
    // to resolve from the intake set.
    for (const diagnostic of specs.diagnostics) {
      diagnostics.push({
        code: "current_spec_invalid",
        message: `A current spec could not be used: ${diagnostic.message}`,
        source: { path: diagnostic.source?.path ?? CURRENT_SPECS_ROOT }
      });
    }
  }

  const change = await loadChangeBundle({ repositoryRoot, changeId });
  if (change.ok) {
    // An `add` delta proposes a requirement that exists only under this change
    // until it ships. Scoped to the owning change, because that is all the
    // archive-time loader sees.
    for (const delta of change.deltaSpecs) {
      if (delta.proposedRequirement !== undefined) ids.add(delta.proposedRequirement.id);
    }
  } else {
    for (const diagnostic of change.diagnostics) {
      diagnostics.push({
        code: "change_bundle_invalid",
        message: `${changeId} could not be loaded, so its proposed requirements were not checked: ${diagnostic.message}`,
        source: { path: diagnostic.source?.path ?? `${CHANGES_ROOT}/${changeId}` }
      });
    }
  }

  return { ids, diagnostics };
}

/**
 * Fields where a task's own budget is wider than the project policy.
 *
 * `scope.budget` is what diff reconciliation enforces, so a task contract that
 * raises its own budget has escaped the operator's limit while still appearing
 * to be governed by it.
 */
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

function scanDiagnostic(error: ScanFailure): TraceabilityDiagnostic {
  return {
    code: "artifact_root_unreadable",
    message: `${error.root} could not be read, so its contents were not checked: ${error.message}`,
    source: { path: error.root }
  };
}

/**
 * Check the references and budgets of every planned task.
 *
 * A project with no requirement set still has its references checked — ad-hoc
 * and imported projects have tasks too — but has no policy to check budgets
 * against and no expected coverage surface.
 */
export async function checkTraceability(repositoryRoot: string): Promise<TraceabilityReport> {
  const empty = { requirements: 0, planned: 0, unplanned: [] as readonly string[] };

  const set = await readRequirementSet(repositoryRoot);
  const diagnostics: TraceabilityDiagnostic[] = [];
  const covered = new Set<string>();

  let changes: readonly string[];
  try {
    changes = await changeIds(repositoryRoot);
  } catch (error) {
    if (!(error instanceof ScanFailure)) throw error;
    return { diagnostics: [scanDiagnostic(error)], coverage: empty };
  }

  for (const changeId of changes) {
    // Per change: a task may only name a requirement its own change proposes,
    // because that is all the archive-time loader will see.
    const resolved = await resolvableRequirementIds(repositoryRoot, set, changeId);
    diagnostics.push(...resolved.diagnostics);
    const resolvable = resolved.ids;

    const artifactPath = taskgraphArtifactPath(changeId);
    // `readTaskGraph` rethrows a non-ENOENT filesystem error, which aborted
    // `legion validate --json` instead of returning its payload. A taskgraph
    // replaced by a directory is a finding, not a crash.
    let graph: Awaited<ReturnType<typeof readTaskGraph>>;
    try {
      graph = await readTaskGraph({ repositoryRoot, changeId });
    } catch (error) {
      diagnostics.push({
        code: "taskgraph_unreadable",
        message: `${artifactPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        source: { path: artifactPath }
      });
      continue;
    }

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

      // Read through the oracle service, not matched by filename. A file merely
      // having the right basename made a truncated, empty or ID-mismatched
      // oracle count as present.
      const oracleCoverage = new Set<string>();
      for (const oracleId of task.oracleRefs) {
        const oracle = await readOracleArtifact({ repositoryRoot, changeId, oracleId });
        if (!oracle.ok || oracle.document.id !== oracleId) {
          diagnostics.push({
            code: "task_oracle_unresolved",
            message: `${task.id} names oracle ${oracleId}, which does not exist as a valid oracle in ${changeId}.`,
            source: { path: artifactPath }
          });
          continue;
        }
        for (const entry of oracle.document.requirementCoverage) oracleCoverage.add(entry.requirementId);
      }

      // Existing is not the same as covering. `validateChangeTraceability`
      // rejects a task whose oracle covers a different requirement, so accepting
      // it here would let a project pass validation and fail later at archive.
      for (const requirementId of task.requirementIds) {
        if (task.oracleRefs.length === 0 || oracleCoverage.has(requirementId)) continue;
        diagnostics.push({
          code: "task_oracle_missing_coverage",
          message: `${task.id} has no oracle covering ${requirementId}.`,
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
