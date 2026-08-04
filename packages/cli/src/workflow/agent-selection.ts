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
 * The single bundle a task will be dispatched to.
 *
 * One, not a list. `selectWorkerBundleForTask` in
 * `packages/core/src/dispatch/selector.ts` resolves `taskContract.agents[0]` and
 * nothing else — multi-agent fan-out is deferred work. A first version of this
 * function returned `["implementer", "oracle-author"]` for a task with an
 * executable criterion, reasoning that specialists are added rather than
 * substituted. Every entry after the first was inert: never dispatched, never
 * consulted, and reported by anything counting "agents used" as though it had
 * worked on the task. That is the advertised-but-never-read defect this
 * repository keeps finding, produced while trying to remove a different one.
 *
 * So the choice is narrow by necessity rather than by taste, and it is honest
 * about being narrow. A writing task gets the implementer, because something has
 * to make the change and putting a specialist first would mean the code never
 * gets written. The distinction that survives is real and was previously absent:
 * a task that writes nothing is an investigation, not an implementation.
 *
 * Selecting on proof kind or ad-hoc kind becomes meaningful when fan-out exists.
 * Until then a longer list would be a claim about work nobody does.
 */
export function selectAgents(input: AgentSelectionInput): readonly [WorkerBundleId] {
  // A task that writes nothing is an investigation, whatever else it is.
  if (input.writeScope.length === 0) return ["explorer"];
  return ["implementer"];
}
