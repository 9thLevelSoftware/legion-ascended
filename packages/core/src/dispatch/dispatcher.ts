/**
 * P08-T01 — Fresh-context task dispatcher.
 *
 * Goal (from Phase 7 closeout handoff):
 *  "Spawn each worker with a fresh context derived from the
 *   TaskContract, not from previous task memory or session-global
 *   prose."
 *
 * What this module guarantees:
 *  1. `dispatch()` calls `preflightTaskContract` BEFORE constructing
 *     a context. Preflight failures short-circuit dispatch; the
 *     caller receives structured issues + board blockers and never
 *     sees a half-built context.
 *  2. On success, the returned `WorkerContext` is deeply frozen
 *     (Object.freeze recursively) so workers cannot mutate the
 *     contract boundary by accident.
 *  3. The WorkerContext exposes ONLY fields listed in
 *     `WORKER_CONTEXT_KEYS`. No scratch state, no `parentRunIds`,
 *     no run history from previous tasks.
 *  4. `isolationTag` is computed from the deterministic
 *     `workerContextHash` and is stable across replays. It is the
 *     proof-by-grep that the context was produced by the
 *     fresh-context dispatcher.
 *  5. The dispatcher is provider-neutral: it never imports a
 *     runtime driver, never reads `process.env` for provider
 *     configuration, and never references the board persistence
 *     package. The caller plugs in a `WorkerBundleRegistry` for
 *     worker bundles and a `RuntimeDriver` downstream; both stay
 *     outside core.
 *
 * What this module deliberately does NOT do:
 *  - Spawn a process, fork a worker, or read a prompt file. Those
 *    are concerns of the CLI adapter layer (P08-T02 per-task review).
 *  - Touch the board persistence layer directly. The dispatcher
 *    produces structured blockers; board adapters apply them.
 *  - Manage leases, heartbeats, or run lifecycles. Those are core
 *    state-machine concerns that pre-existed Phase 8.
 */

import {
  preflightTaskContract,
  taskContractSchema,
  type ArtifactReference,
  type SchemaVersion,
  type TaskContract,
  type TaskContractPreflightContext,
  type UtcTimestamp,
  type WorkerBundle,
  type ModelManifest
} from "@legion/protocol";

import {
  collectContextRefs,
  collectScope,
  WORKER_CONTEXT_KEYS,
  type DispatchBoardBlocker,
  type DispatchIssue,
  type FreshContextDispatchInput,
  type FreshContextDispatchResult,
  type WorkerBundleRegistry,
  type WorkerContext,
  type WorkerContextKey,
  type WorkerContextRefs,
  type WorkerContextScope
} from "./contract.js";

import {
  deriveIsolationTag,
  deriveWorkerContextHash
} from "./hash.js";

import {
  selectWorkerBundleForTask
} from "./selector.js";

import {
  DISPATCH_BLOCKER_REPORTER,
  mapDispatchIssuesToBoardBlockers,
  renderDispatchFailureReason
} from "./blocker.js";

const SCHEMA_VERSION: SchemaVersion = "1.0.0" as SchemaVersion;
const WORKER_CONTEXT_KIND = "worker-context" as const;

const fixedClock = (): UtcTimestamp =>
  "2026-06-22T01:00:00.000Z" as UtcTimestamp;

/**
 * Build a `TaskContractPreflightContext` from the dispatch input,
 * omitting undefined fields so the contract's `exactOptionalPropertyTypes`
 * stays satisfied. Mirrors the protocol-side default but keeps the
 * typing honest at the call site.
 */
function buildPreflightContext(
  input: FreshContextDispatchInput
): TaskContractPreflightContext {
  const context: TaskContractPreflightContext = {};
  if (input.availableContracts !== undefined) {
    (context as { availableContracts?: readonly { contractId: string; revision?: number }[] }).availableContracts =
      input.availableContracts;
  }
  if (input.availableAgents !== undefined) {
    (context as { availableAgents?: readonly string[] }).availableAgents = input.availableAgents;
  }
  if (input.availableArtifacts !== undefined) {
    (context as { availableArtifacts?: readonly ArtifactReference[] }).availableArtifacts =
      input.availableArtifacts;
  }
  return context;
}

export interface FreshContextDispatcherOptions {
  readonly now?: () => UtcTimestamp;
  readonly reporter?: string;
}

// ---------------------------------------------------------------------------
// Deep-freeze helper
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  const frozen = Object.freeze(value) as T;
  for (const key of Object.keys(value as object)) {
    const child = (value as unknown as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return frozen;
}

// ---------------------------------------------------------------------------
// Isolation invariant check
// ---------------------------------------------------------------------------

/**
 * Assert a context satisfies the fresh-context isolation rules. Used
 * by tests and by downstream consumers before they pass the context
 * to a worker. Throws `FreshContextIsolationError` if any rule is
 * violated.
 */
export class FreshContextIsolationError extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(
      `WorkerContext isolation violated: ${violations.join("; ")}`
    );
    this.name = "FreshContextIsolationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertIsolatedWorkerContext(
  context: unknown
): asserts context is WorkerContext {
  const violations: string[] = [];

  if (!isPlainObject(context)) {
    throw new FreshContextIsolationError(["context is not an object"]);
  }

  const allowed = new Set<string>(WORKER_CONTEXT_KEYS);
  for (const key of Object.keys(context)) {
    if (!allowed.has(key)) {
      violations.push(`unexpected key "${key}" (not in WORKER_CONTEXT_KEYS)`);
    }
  }

  if (context["kind"] !== WORKER_CONTEXT_KIND) {
    violations.push(`kind must be "${WORKER_CONTEXT_KIND}"`);
  }

  if (context["schemaVersion"] !== SCHEMA_VERSION) {
    violations.push(`schemaVersion must be "${SCHEMA_VERSION}"`);
  }

  if (!Object.isFrozen(context)) {
    violations.push("context is not deeply frozen");
  }

  // Walk every nested object and verify it is frozen too.
  const visit = (value: unknown, trail: string): void => {
    if (value === null || typeof value !== "object") return;
    if (!Object.isFrozen(value)) {
      violations.push(`nested object at ${trail} is not frozen`);
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${trail}[${index}]`);
      }
      return;
    }
    for (const key of Object.keys(value as object)) {
      const child = (value as Record<string, unknown>)[key];
      visit(child, `${trail}.${key}`);
    }
  };
  visit(context, "<root>");

  // The contract itself must parse — guards against ad-hoc objects
  // slipping through.
  const parsedContract = taskContractSchema.safeParse(context["taskContract"]);
  if (!parsedContract.success) {
    violations.push(
      `taskContract failed schema parse: ${parsedContract.error.issues.map((i) => i.message).join(", ")}`
    );
  }

  // No "parent run history" or scratch state allowed.
  const forbiddenKeys = ["parentRunIds", "scratch", "extras", "sessionState", "history"];
  for (const key of forbiddenKeys) {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      violations.push(`forbidden isolation-leaking field "${key}" present`);
    }
  }

  if (violations.length > 0) {
    throw new FreshContextIsolationError(violations);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export class FreshContextDispatcher {
  private readonly now: () => UtcTimestamp;
  private readonly reporter: string;

  constructor(options: FreshContextDispatcherOptions = {}) {
    this.now = options.now ?? fixedClock;
    this.reporter = options.reporter ?? DISPATCH_BLOCKER_REPORTER;
  }

  /**
   * Spawn a fresh worker context for a preflighted TaskContract.
   *
   * Steps:
   *  1. Schema-parse the contract (defence in depth — the caller
   *     should already have validated, but this guards against
   *     typed-narrow bypasses).
   *  2. Run `preflightTaskContract` against the supplied ready
   *     context (contracts, agents, artifacts). If preflight fails,
   *     return `{ ok: false, issues, blockers }` — DO NOT attempt
   *     to build a context for an unprepared contract.
   *  3. Select a worker bundle for the contract's primary agent.
   *     If selection fails, return `{ ok: false, issues, blockers }`
   *     with a single `resource_unavailable` issue tagged with the
   *     agent id.
   *  4. Build the `WorkerContext` deterministically:
   *     - `taskContract` (deep-frozen)
   *     - `contextRefs` (collected from specRefs/designRefs/predecessors)
   *     - `scope` (mirrors contract scope)
   *     - `workerBundle`, `model` (from selector)
   *     - `workerContextHash` (content-addressed)
   *     - `isolationTag` (audit-friendly)
   *     - `createdAt` (clock-driven)
   *     - `protocolVersion` (caller-provided)
   *  5. Deep-freeze the entire object graph and assert the
   *     isolation invariants before returning.
   */
  dispatch(input: FreshContextDispatchInput): FreshContextDispatchResult {
    const parsedContract = taskContractSchema.safeParse(input.taskContract);
    if (!parsedContract.success) {
      const issues: readonly DispatchIssue[] = parsedContract.error.issues.map((issue) => ({
        code: "worker_context_dispatcher_failure",
        message: `TaskContract failed schema parse: ${issue.message}`,
        path: issue.path.map((segment) => segment as string | number),
        source: "dispatcher" as const
      }));
      return {
        ok: false,
        taskContract: input.taskContract,
        issues,
        blockers: mapDispatchIssuesToBoardBlockers(issues, {
          now: this.now,
          reporter: this.reporter
        })
      };
    }

    const contract = parsedContract.data;

    const preflight = preflightTaskContract(contract, buildPreflightContext(input));

    if (!preflight.ok) {
      const issues: readonly DispatchIssue[] = preflight.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
        source: "preflight" as const
      }));
      return {
        ok: false,
        taskContract: contract,
        issues,
        blockers: mapDispatchIssuesToBoardBlockers(issues, {
          now: this.now,
          reporter: this.reporter
        })
      };
    }

    // Cross-check: every reference in the contract context MUST
    // appear in the supplied ready context (preflight already checks
    // predecessorArtifacts, but specRefs/designRefs must also be
    // resolvable, otherwise the worker cannot read them).
    const referenced = collectContextRefs(contract);
    const readyArtifactKeys = new Set(
      (input.availableArtifacts ?? []).map((reference) => `${reference.path}|${reference.sha256}`)
    );
    const missingRefs: DispatchIssue[] = [];
    for (const reference of referenced.all) {
      const key = `${reference.path}|${reference.sha256}`;
      if (!readyArtifactKeys.has(key)) {
        missingRefs.push({
          code: "context_reference_out_of_scope",
          message: `Context reference ${reference.path} is not in the ready artifact set.`,
          path: ["context"],
          source: "dispatcher"
        });
      }
    }
    if (missingRefs.length > 0) {
      const blockers = mapDispatchIssuesToBoardBlockers(missingRefs, {
        now: this.now,
        reporter: this.reporter
      });
      return {
        ok: false,
        taskContract: contract,
        issues: missingRefs,
        blockers
      };
    }

    const selection = selectWorkerBundleForTask(contract, input.bundleRegistry);
    if (!selection.ok) {
      const issues: readonly DispatchIssue[] = [
        {
          code: "resource_unavailable",
          message:
            selection.reason === "agent_not_registered"
              ? `No worker bundle registered for agent ${selection.agentId || "<unknown>"}.`
              : `Multiple worker bundles registered for agent ${selection.agentId}; cannot disambiguate.`,
          path: ["agents", 0],
          source: "dispatcher"
        }
      ];
      return {
        ok: false,
        taskContract: contract,
        issues,
        blockers: mapDispatchIssuesToBoardBlockers(issues, {
          now: this.now,
          reporter: this.reporter
        })
      };
    }

    const workerContext = this.buildWorkerContext({
      contract,
      contextRefs: referenced,
      scope: collectScope(contract),
      workerBundle: selection.bundle,
      model: selection.model,
      protocolVersion: input.protocolVersion,
      matchedAgentId: selection.agentId
    });

    // Final isolation assertion — if any future change breaks
    // invariants, fail loudly rather than leak state.
    assertIsolatedWorkerContext(workerContext);

    return {
      ok: true,
      workerContext,
      matchedAgentId: selection.agentId,
      preflightIssueCount: 0
    };
  }

  private buildWorkerContext(input: {
    readonly contract: TaskContract;
    readonly contextRefs: WorkerContextRefs;
    readonly scope: WorkerContextScope;
    readonly workerBundle: WorkerBundle;
    readonly model: ModelManifest;
    readonly protocolVersion: SchemaVersion;
    readonly matchedAgentId: string;
  }): WorkerContext {
    const hash = deriveWorkerContextHash({
      taskContract: input.contract,
      contextRefs: input.contextRefs.all,
      workerBundle: input.workerBundle,
      model: input.model,
      protocolVersion: input.protocolVersion
    });

    const isolationTag = deriveIsolationTag(hash);

    const context: WorkerContext = {
      schemaVersion: SCHEMA_VERSION,
      kind: WORKER_CONTEXT_KIND,
      taskContract: input.contract,
      contextRefs: input.contextRefs,
      scope: input.scope,
      workerBundle: input.workerBundle,
      model: input.model,
      workerContextHash: hash,
      isolationTag,
      createdAt: this.now(),
      protocolVersion: input.protocolVersion
    };

    return deepFreeze(context);
  }
}

// ---------------------------------------------------------------------------
// Renderer helpers (tested independently)
// ---------------------------------------------------------------------------

/**
 * Format a `FreshContextDispatchResult` as a human-readable string.
 * Used by the CLI `next board` subcommand and the evidence indexer.
 * Pure function — no I/O.
 */
export function renderDispatchResult(result: FreshContextDispatchResult): string {
  if (result.ok) {
    return (
      `fresh-context dispatch ok: ` +
      `agent=${result.matchedAgentId} ` +
      `hash=${result.workerContext.workerContextHash} ` +
      `isolation=${result.workerContext.isolationTag}`
    );
  }

  return (
    `fresh-context dispatch blocked: ` +
    `issues=${result.issues.length} ` +
    `reason=${renderDispatchFailureReason(result.issues)}`
  );
}

/**
 * Collect every blocker from a list of dispatch results in
 * dispatch order. Used by the CLI to render a board panel after a
 * wave of dispatches.
 */
export function collectBlockers(
  results: readonly FreshContextDispatchResult[]
): readonly DispatchBoardBlocker[] {
  const blockers: DispatchBoardBlocker[] = [];
  for (const result of results) {
    if (result.ok) continue;
    blockers.push(...result.blockers);
  }
  return blockers;
}

/**
 * Sanity helper: re-export protocol artifacts so downstream callers
 * (tests, CLI adapters) do not need to also import from
 * `@legion/protocol` directly.
 */
export type { ArtifactReference, TaskContract, WorkerBundle, ModelManifest };
