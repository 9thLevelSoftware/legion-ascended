import { readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { LEGION_PROJECT_ROOT } from "@legion/artifacts";
import type { GitSha, TaskContract } from "@legion/protocol";

import {
  observeWorkingTreeDiff,
  pathIsCoveredBy,
  reconcileTaskDiff,
  type DiffObservation,
  type ReconciliationResult
} from "./diff-reconciliation.js";
import { listProjectFiles } from "./project-files.js";
import type { ExecutionResult } from "./executor/types.js";

/**
 * The single path through which a writable executor may be dispatched.
 *
 * `legion build` and `legion review --auto` both run executors that can modify
 * the repository, and each had its own dispatch code. Enforcement was added to
 * one, so the other stayed an unguarded door for several review rounds. The
 * lesson was not "harden the other path" but "stop having two": a guarantee
 * added here applies everywhere, and a new caller cannot opt out by not knowing
 * the rules.
 *
 * Guarantees, in order:
 *
 *  1. The base SHA is supplied by the caller and used for everything, so the
 *     evidence, the snapshot and the reconciliation all describe one revision.
 *  2. The bytes of every protected file are captured before dispatch, because
 *     control artifacts are written by `plan` after the last commit and are
 *     therefore routinely untracked or dirty. Restoring them from git would roll
 *     a dirty artifact back to stale committed content and delete an untracked
 *     one outright — containment that destroys the state it defends.
 *  3. Dispatch and `afterRun` are wrapped, so an executor that throws after
 *     touching a protected file still gets reconciled and contained.
 *  4. The control-artifact prohibition runs **independently of**
 *     `completion.diffReconciliation`. It is a harness invariant; a contract
 *     that could switch it off by setting a flag would not be constrained by it.
 *  5. Protected files that *disappear* are caught too. A deletion leaves no
 *     entry in the post-run observation, so a check that only walks observed
 *     files would call it clean.
 */

export interface GuardedExecutionInput {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
  /** Captured once by the caller and shared with the task-run manifest. */
  readonly baseGitSha: GitSha;
  /** Harness-written paths for this run; excluded from attribution. */
  readonly harnessPaths: readonly string[];
  readonly run: () => Promise<ExecutionResult>;
  readonly afterRun?: () => Promise<void>;
}

export interface GuardedExecutionOutcome {
  readonly result: ExecutionResult;
  readonly reconciliation?: ReconciliationResult;
  readonly inContract: boolean;
  readonly restored: readonly string[];
  readonly unrestored: readonly string[];
  readonly blockedReason?: string;
}

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * What a protected path looked like before dispatch.
 *
 * `oversized` and `symlink` are distinct states rather than absences. Treating
 * "too big to snapshot" as "did not exist" made restoration delete a large
 * pre-existing artifact — an old executor log — on every writable run, so the
 * guard destroyed valid workflow state while reporting that it had protected it.
 * Absence from the map means, and only means, the path did not exist.
 */
type ProtectedEntry =
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "oversized"; readonly size: number | undefined }
  | { readonly kind: "symlink" };

type ProtectedSnapshot = ReadonlyMap<string, ProtectedEntry>;

function isHarnessPath(relative: string, harnessPaths: readonly string[]): boolean {
  return harnessPaths.some((entry) => pathIsCoveredBy(relative, entry));
}

function snapshotProtectedFiles(input: {
  readonly repositoryRoot: string;
  readonly harnessPaths: readonly string[];
}): ProtectedSnapshot {
  const snapshot = new Map<string, ProtectedEntry>();
  for (const entry of listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)) {
    if (isHarnessPath(entry.path, input.harnessPaths)) continue;

    if (entry.kind === "symlink") {
      snapshot.set(entry.path, { kind: "symlink" });
      continue;
    }
    if (entry.size !== undefined && entry.size > MAX_SNAPSHOT_BYTES) {
      snapshot.set(entry.path, { kind: "oversized", size: entry.size });
      continue;
    }
    try {
      snapshot.set(entry.path, {
        kind: "file",
        bytes: readFileSync(path.join(input.repositoryRoot, entry.path))
      });
    } catch {
      snapshot.set(entry.path, { kind: "oversized", size: entry.size });
    }
  }
  return snapshot;
}

/** Protected paths that differ from the pre-dispatch snapshot, including deletions and new symlinks. */
function protectedPathsTouched(input: {
  readonly repositoryRoot: string;
  readonly snapshot: ProtectedSnapshot;
  readonly harnessPaths: readonly string[];
}): readonly string[] {
  const touched = new Set<string>();
  const current = new Map(
    listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)
      .filter((entry) => !isHarnessPath(entry.path, input.harnessPaths))
      .map((entry) => [entry.path, entry] as const)
  );

  for (const [relative, before] of input.snapshot) {
    const now = current.get(relative);
    if (now === undefined) {
      // Removed. A deletion leaves nothing in the post-run listing, so a scan
      // that only walked observed files would call it clean.
      touched.add(relative);
      continue;
    }
    if (before.kind === "symlink" || now.kind === "symlink") {
      if (before.kind !== now.kind) touched.add(relative);
      continue;
    }
    if (before.kind === "oversized") {
      // Not snapshotted, so size is the only comparison available.
      if (before.size !== now.size) touched.add(relative);
      continue;
    }
    try {
      if (!before.bytes.equals(readFileSync(path.join(input.repositoryRoot, relative)))) {
        touched.add(relative);
      }
    } catch {
      touched.add(relative);
    }
  }

  for (const relative of current.keys()) {
    if (!input.snapshot.has(relative)) touched.add(relative);
  }

  return [...touched].sort();
}

/**
 * Restore protected paths to their pre-dispatch state.
 *
 * Only a path genuinely absent before the run is removed. Anything that existed
 * but could not be snapshotted is left in place and reported, because deleting
 * it would be worse than the modification it is meant to undo.
 */
function restoreProtectedFiles(input: {
  readonly repositoryRoot: string;
  readonly snapshot: ProtectedSnapshot;
  readonly paths: readonly string[];
}): { readonly restored: readonly string[]; readonly unrestored: readonly string[] } {
  const restored: string[] = [];
  const unrestored: string[] = [];

  for (const relative of input.paths) {
    const absolute = path.join(input.repositoryRoot, relative);
    const before = input.snapshot.get(relative);
    try {
      if (before === undefined) {
        // Appeared during the run. `rmSync` removes a symlink itself rather
        // than following it, which is what makes a planted link safe to clear.
        rmSync(absolute, { force: true, recursive: true });
        restored.push(relative);
        continue;
      }
      if (before.kind === "file") {
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, before.bytes);
        restored.push(relative);
        continue;
      }
      // Existed as a symlink or was too large to capture: its original content
      // cannot be reproduced, so say so rather than destroy it.
      unrestored.push(relative);
    } catch {
      unrestored.push(relative);
    }
  }

  return { restored, unrestored };
}

export async function runGuardedExecution(
  input: GuardedExecutionInput
): Promise<GuardedExecutionOutcome> {
  const before: DiffObservation | undefined = observeWorkingTreeDiff({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha
  }).observation;

  // Byte-exact, because git cannot restore an artifact that was never committed.
  const snapshot = snapshotProtectedFiles({
    repositoryRoot: input.repositoryRoot,
    harnessPaths: input.harnessPaths
  });

  let result: ExecutionResult | undefined;
  let thrown: unknown;
  try {
    result = await input.run();
    if (input.afterRun !== undefined) await input.afterRun();
  } catch (error) {
    // A run that throws after writing must still be contained; jumping straight
    // to the caller would leave a poisoned control artifact on disk.
    thrown = error;
  }

  const touchedProtected = protectedPathsTouched({
    repositoryRoot: input.repositoryRoot,
    snapshot,
    harnessPaths: input.harnessPaths
  });

  const containment = touchedProtected.length === 0
    ? { restored: [] as readonly string[], unrestored: [] as readonly string[] }
    : restoreProtectedFiles({
        repositoryRoot: input.repositoryRoot,
        snapshot,
        paths: touchedProtected
      });

  // Contract-driven reconciliation is optional; the control-artifact invariant
  // is not, so it has already run above regardless of this flag.
  const reconciliation = input.task.completion.diffReconciliation.required
    ? reconcileTaskDiff({
        repositoryRoot: input.repositoryRoot,
        baseGitSha: input.baseGitSha,
        scope: input.task.scope,
        harnessPaths: input.harnessPaths,
        alwaysForbidden: [LEGION_PROJECT_ROOT],
        ...(before === undefined ? {} : { before })
      })
    : undefined;

  const reasons: string[] = [];
  if (thrown !== undefined) {
    reasons.push(`The run failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  if (touchedProtected.length > 0) {
    const note = containment.unrestored.length === 0
      ? `Restored ${containment.restored.length} protected path(s) to their pre-run state.`
      : `Could not restore ${containment.unrestored.join(", ")}; inspect the worktree before rerunning.`;
    reasons.push(
      `The run modified ${touchedProtected.length} protected control artifact(s): ${touchedProtected.join(", ")}. ${note}`
    );
  }
  if (reconciliation?.status === "unavailable") {
    reasons.push(
      `The run could not be reconciled against its task contract, so it is not proven in contract. ${reconciliation.unavailableReason ?? ""}`.trim()
    );
  }
  if (reconciliation?.status === "violated") {
    reasons.push(...reconciliation.violations.map((violation) => violation.message));
  }

  const inContract = reasons.length === 0;
  if (result === undefined) {
    // The run threw, so there is no executor result to report.
    result = {
      ok: false,
      status: "failed",
      summary: reasons.join(" "),
      filesChanged: [],
      commandsRun: [],
      findings: []
    };
  }

  return {
    result,
    ...(reconciliation === undefined ? {} : { reconciliation }),
    inContract,
    restored: containment.restored,
    unrestored: containment.unrestored,
    ...(inContract ? {} : { blockedReason: reasons.join(" ") })
  };
}
