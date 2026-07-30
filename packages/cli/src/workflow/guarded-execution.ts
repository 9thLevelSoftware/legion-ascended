import { LEGION_PROJECT_ROOT } from "@legion/artifacts";
import type { GitSha, TaskContract } from "@legion/protocol";

import { resolveBaseGitSha } from "./change-input.js";
import {
  observeWorkingTreeDiff,
  reconcileTaskDiff,
  restorePathsToBase,
  type ReconciliationResult
} from "./diff-reconciliation.js";
import type { ExecutionResult } from "./executor/types.js";

/**
 * The single path through which a writable executor may be dispatched.
 *
 * `legion build` and `legion review --auto` both run executors that can modify
 * the repository, and each had its own dispatch code. Enforcement was added to
 * one of them, so the other stayed an unguarded door for several rounds — the
 * auto-fix run could rewrite the very control artifacts `review` and `ship`
 * reload next, and the build that followed treated the tampering as
 * pre-existing.
 *
 * The lesson was not "harden the other path" but "stop having two". Every
 * writable dispatch goes through here, so a guarantee added once applies
 * everywhere, and a new caller cannot accidentally opt out by not knowing the
 * rules.
 *
 * The guarantees, in order:
 *
 *  1. The base SHA is resolved **once**, before anything runs. Re-resolving
 *     afterwards would return the executor's own commit as the base, and
 *     anything it committed would diff clean.
 *  2. The tree is observed before dispatch, so a pre-existing dirty state under
 *     `--allow-dirty` is not blamed on this run.
 *  3. `afterRun` happens inside the guarded window, so side effects of
 *     verification commands are reconciled rather than escaping the snapshot.
 *  4. Control artifacts are forbidden at the harness level, not by the
 *     contract, so a contract cannot grant the authority and a contract written
 *     before the rule existed cannot sidestep it.
 *  5. A forbidden write is **restored**, not merely reported. Detection without
 *     containment leaves the rewritten file on disk for the next command.
 */

export interface GuardedExecutionInput {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
  /** Harness-written paths for this run; excluded from attribution. */
  readonly harnessPaths: readonly string[];
  /** Dispatch the executor. Called once, inside the guarded window. */
  readonly run: () => Promise<ExecutionResult>;
  /**
   * Work that must be reconciled alongside the run — verification commands and
   * anything else that can touch the repository after dispatch.
   */
  readonly afterRun?: () => Promise<void>;
}

export interface GuardedExecutionOutcome {
  readonly result: ExecutionResult;
  readonly baseGitSha: GitSha;
  readonly reconciliation?: ReconciliationResult;
  /** True when the run stayed inside its contract. */
  readonly inContract: boolean;
  /** Forbidden paths restored to their pre-run state. */
  readonly restored: readonly string[];
  /** Forbidden paths that could not be restored; the worktree still holds them. */
  readonly unrestored: readonly string[];
  readonly blockedReason?: string;
}

export async function runGuardedExecution(
  input: GuardedExecutionInput
): Promise<GuardedExecutionOutcome> {
  const baseGitSha = resolveBaseGitSha(input.repositoryRoot);
  const before = observeWorkingTreeDiff({
    repositoryRoot: input.repositoryRoot,
    baseGitSha
  }).observation;

  const result = await input.run();
  if (input.afterRun !== undefined) await input.afterRun();

  const reconciliation = input.task.completion.diffReconciliation.required
    ? reconcileTaskDiff({
        repositoryRoot: input.repositoryRoot,
        baseGitSha,
        scope: input.task.scope,
        harnessPaths: input.harnessPaths,
        alwaysForbidden: [LEGION_PROJECT_ROOT],
        ...(before === undefined ? {} : { before })
      })
    : undefined;

  if (reconciliation === undefined || reconciliation.status === "clean" || reconciliation.status === "not_applicable") {
    return {
      result,
      baseGitSha,
      ...(reconciliation === undefined ? {} : { reconciliation }),
      inContract: true,
      restored: [],
      unrestored: []
    };
  }

  if (reconciliation.status === "unavailable") {
    // A harness-side git failure is not an executor confession, and saying so
    // would send whoever triages a CI outage looking in the wrong place.
    return {
      result,
      baseGitSha,
      reconciliation,
      inContract: false,
      restored: [],
      unrestored: [],
      blockedReason: `The run could not be reconciled against its task contract, so it is not proven in contract. ${reconciliation.unavailableReason ?? ""}`.trim()
    };
  }

  const forbiddenPaths = reconciliation.violations
    .filter((violation) => violation.code === "forbidden_path_touched")
    .flatMap((violation) => violation.paths);

  const unrestored = forbiddenPaths.length === 0
    ? []
    : restorePathsToBase({
        repositoryRoot: input.repositoryRoot,
        baseGitSha,
        paths: forbiddenPaths
      });
  const restored = forbiddenPaths.filter((entry) => !unrestored.includes(entry));

  const containment = forbiddenPaths.length === 0
    ? ""
    : unrestored.length === 0
      ? ` Restored ${restored.length} protected path(s) to their pre-run state.`
      : ` Could not restore ${unrestored.join(", ")}; inspect the worktree before rerunning.`;

  return {
    result,
    baseGitSha,
    reconciliation,
    inContract: false,
    restored,
    unrestored,
    blockedReason: `${reconciliation.violations.map((violation) => violation.message).join(" ")}${containment}`.trim()
  };
}
