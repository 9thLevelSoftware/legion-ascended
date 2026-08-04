/**
 * Which worker bundle a task should be dispatched to.
 *
 * Every planned task named `["implementer"]`, hardcoded, and every guidance run
 * named `["explorer"]` — so "which agents worked on this" was a constant
 * dressed as a measurement, and a retrospective reporting it would have been
 * reporting the literal in the planner.
 *
 * Selection is deliberately narrow. It reads what the task already declares —
 * whether it writes code, and what kind of proof it carries — rather than
 * guessing from prose. A task whose shape does not match a specialist bundle
 * gets the implementer, which is what it would have got anyway; the difference
 * is that now the ones that *are* distinguishable are distinguished.
 */

/** Bundle IDs from bundles/index.json. A bundle that does not exist cannot be dispatched. */
export const WORKER_BUNDLE_IDS = Object.freeze([
  "explorer",
  "specifier",
  "oracle-author",
  "architect",
  "planner",
  "implementer",
  "task-reviewer",
  "integration-evaluator",
  "release-controller"
] as const);

export type WorkerBundleId = (typeof WORKER_BUNDLE_IDS)[number];

export interface AgentSelectionInput {
  /** Paths the task may write. An empty write scope means it produces no code. */
  readonly writeScope: readonly string[];
  /** Whether the task's acceptance is decided by a command rather than a reader. */
  readonly hasExecutableProof: boolean;
  /** The kind of ad-hoc work, when the task came from `quick` or `polish`. */
  readonly adHocKind?: "quick" | "polish";
}

/**
 * The bundles a task should be dispatched to, most specific first.
 *
 * Always includes `implementer` when the task writes anything, because
 * something has to make the change. Specialists are added, not substituted.
 */
export function selectAgents(input: AgentSelectionInput): readonly WorkerBundleId[] {
  const selected: WorkerBundleId[] = [];

  // A task that writes nothing is an investigation, whatever else it is.
  const writes = input.writeScope.length > 0;
  if (!writes) return ["explorer"];

  selected.push("implementer");

  // An executable criterion means a runner decides acceptance, so the fixture
  // that runner executes is part of the work.
  if (input.hasExecutableProof) selected.push("oracle-author");

  // Polish is behaviour-preserving by definition, which is a review property
  // rather than an implementation one.
  if (input.adHocKind === "polish") selected.push("task-reviewer");

  return selected;
}
