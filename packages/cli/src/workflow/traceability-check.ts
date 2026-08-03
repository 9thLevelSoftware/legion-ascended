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
  requirementSetIndexPath,
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
    | "taskgraph_unreadable"
    | "requirement_set_unreadable";
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

/**
 * Every artifact read in this module goes through here.
 *
 * Four review rounds on this file were all the same defect: a read that fails is
 * not a read that returns nothing. Each round I fixed the call sites named and
 * left the others — the changes root, then the specs root, then three service
 * results, and still `loadChangeBundle` and `readOracleArtifact` could throw a
 * non-ENOENT filesystem error straight out of `legion validate --json`.
 *
 * Last round I wrote that "every read either contributes its result or
 * contributes a diagnostic, and none escape". That was an invariant I stated and
 * did not enforce, because enforcement was still a thing to remember at each
 * call site. This makes it structural: the raw functions are not called
 * directly, so a new read cannot forget.
 *
 * `absent` distinguishes "there is nothing here", which is ordinary, from "there
 * is something here I could not read", which is a finding.
 */
type GuardedRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: TraceabilityDiagnostic }
  | { readonly ok: "absent" };

async function guarded<T>(
  artifactPath: string,
  code: TraceabilityDiagnostic["code"],
  read: () => Promise<T>
): Promise<GuardedRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: "absent" };
    }
    return {
      ok: false,
      diagnostic: {
        code,
        message: `${artifactPath} could not be read, so it was not checked: ${
          error instanceof Error ? error.message : String(error)
        }`,
        source: { path: artifactPath }
      }
    };
  }
}

async function changeIds(repositoryRoot: string): Promise<GuardedRead<readonly string[]>> {
  return guarded(CHANGES_ROOT, "artifact_root_unreadable", async () => {
    const entries = await readdir(path.join(repositoryRoot, CHANGES_ROOT), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  });
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

  const change = await guarded(
    `${CHANGES_ROOT}/${changeId}`,
    "change_bundle_invalid",
    () => loadChangeBundle({ repositoryRoot, changeId })
  );
  if (change.ok === false) return { ids, diagnostics: [change.diagnostic] };
  if (change.ok === "absent") return { ids, diagnostics };

  if (change.value.ok) {
    // An `add` delta proposes a requirement that exists only under this change
    // until it ships. Scoped to the owning change, because that is all the
    // archive-time loader sees.
    for (const delta of change.value.deltaSpecs) {
      if (delta.proposedRequirement !== undefined) ids.add(delta.proposedRequirement.id);
    }
  } else {
    for (const diagnostic of change.value.diagnostics) {
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

/**
 * Current-spec requirements, and any reason they could not be read.
 *
 * Read once per run rather than per change: a project with no changes never
 * entered the loop, so a corrupt committed spec went unreported and both
 * `validate` and `doctor` reported success.
 */
async function currentSpecRequirements(
  repositoryRoot: string
): Promise<{ readonly ids: ReadonlySet<string>; readonly diagnostics: readonly TraceabilityDiagnostic[] }> {
  const ids = new Set<string>();
  const specs = await guarded(CURRENT_SPECS_ROOT, "artifact_root_unreadable", () =>
    listCurrentSpecs({ repositoryRoot })
  );

  if (specs.ok === false) return { ids, diagnostics: [specs.diagnostic] };
  if (specs.ok === "absent") return { ids, diagnostics: [] };

  if (specs.value.ok) {
    for (const document of specs.value.documents) {
      for (const requirement of document.requirements) ids.add(requirement.id);
    }
    return { ids, diagnostics: [] };
  }

  // A schema-invalid or duplicate-ID spec is a corrupted committed artifact.
  // Discarding the failure let validation pass whenever the same IDs happened to
  // resolve from the intake set.
  return {
    ids,
    diagnostics: specs.value.diagnostics.map((diagnostic) => ({
      code: "current_spec_invalid" as const,
      message: `A current spec could not be used: ${diagnostic.message}`,
      source: { path: diagnostic.source?.path ?? CURRENT_SPECS_ROOT }
    }))
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

  // A requirement set that cannot be read is not an empty one, and the two are
  // indistinguishable from here: without this, an unreadable index produced a
  // clean report over zero requirements — "0 of 0 planned", which reads as
  // traceability satisfied for a project whose requirements nobody could load.
  //
  // The guard was already applied once, in `resolveTraceabilityStatus`, and only
  // there — so `legion status` refused while `legion validate` and `legion
  // doctor` reported clean over the same broken set. It belongs here, where the
  // rule lives, rather than at each of the three entrances that has to remember
  // it.
  if (!set.ok && set.status !== "not_found") {
    return {
      diagnostics: [
        {
          code: "requirement_set_unreadable",
          message: `The requirement set could not be read, so traceability was not checked: ${set.reason ?? "unknown reason"}`,
          source: { path: requirementSetIndexPath() }
        }
      ],
      coverage: empty
    };
  }

  const diagnostics: TraceabilityDiagnostic[] = [];
  const covered = new Set<string>();

  const specs = await currentSpecRequirements(repositoryRoot);
  diagnostics.push(...specs.diagnostics);

  const scanned = await changeIds(repositoryRoot);
  if (scanned.ok === false) return { diagnostics: [...diagnostics, scanned.diagnostic], coverage: empty };
  const changes = scanned.ok === "absent" ? [] : scanned.value;

  for (const changeId of changes) {
    // Per change: a task may only name a requirement its own change proposes,
    // because that is all the archive-time loader will see.
    const resolved = await resolvableRequirementIds(repositoryRoot, set, changeId);
    diagnostics.push(...resolved.diagnostics);
    const resolvable = new Set([...specs.ids, ...resolved.ids]);

    const artifactPath = taskgraphArtifactPath(changeId);
    const read = await guarded(artifactPath, "taskgraph_unreadable", () =>
      readTaskGraph({ repositoryRoot, changeId })
    );
    if (read.ok === false) {
      diagnostics.push(read.diagnostic);
      continue;
    }
    if (read.ok === "absent") continue;
    const graph = read.value;

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
        const read = await guarded(
          `${CHANGES_ROOT}/${changeId}/oracle/${oracleId}`,
          "task_oracle_unresolved",
          () => readOracleArtifact({ repositoryRoot, changeId, oracleId })
        );
        if (read.ok === false) {
          diagnostics.push(read.diagnostic);
          continue;
        }
        const oracle = read.ok === "absent" ? undefined : read.value;
        if (oracle === undefined || !oracle.ok || oracle.document.id !== oracleId) {
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
