import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
 *  1. The base SHA is supplied by the caller and used throughout, so evidence,
 *     snapshot and reconciliation all describe one revision.
 *  2. Protected files are captured by content before dispatch. Control
 *     artifacts are written by `plan` after the last commit and are routinely
 *     untracked, so restoring them from git would roll a dirty artifact back to
 *     stale content and delete an untracked one outright.
 *  3. Dispatch and `afterRun` are wrapped, so a run that throws after writing is
 *     still reconciled and contained.
 *  4. The control-artifact prohibition runs independently of
 *     `completion.diffReconciliation`. It is a harness invariant; a contract
 *     able to switch it off with a flag would not be constrained by it.
 *  5. Containment covers the index as well as the working tree, and never
 *     writes through a symlink an executor may have left behind.
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
 * Each variant carries enough to detect a change and, where possible, undo it.
 * Absence from the map means one thing only: the path did not exist. An earlier
 * version conflated "too large to capture" with absence, so restoration deleted
 * large pre-existing artifacts.
 */
type ProtectedEntry =
  | { readonly kind: "file"; readonly bytes: Buffer }
  /** Too large to hold; identified by digest so a same-length rewrite is still caught. */
  | { readonly kind: "oversized"; readonly sha256: string | undefined }
  /** Never followed. The target is recorded so a retarget is detectable and reversible. */
  | { readonly kind: "symlink"; readonly target: string | undefined };

type ProtectedSnapshot = ReadonlyMap<string, ProtectedEntry>;

interface ProtectedState {
  readonly entries: ProtectedSnapshot;
  /** Protected paths already staged before dispatch, so staging can be put back. */
  readonly staged: ReadonlySet<string>;
}

function isHarnessPath(relative: string, harnessPaths: readonly string[]): boolean {
  return harnessPaths.some((entry) => pathIsCoveredBy(relative, entry));
}

function digestOf(absolute: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

function readTarget(absolute: string): string | undefined {
  try {
    return readlinkSync(absolute);
  } catch {
    return undefined;
  }
}

function stagedProtectedPaths(repositoryRoot: string): ReadonlySet<string> {
  try {
    const output = execFileSync(
      "git",
      ["-C", repositoryRoot, "diff", "--cached", "--name-only", "--", LEGION_PROJECT_ROOT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return new Set(
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );
  } catch {
    return new Set();
  }
}

function snapshotProtectedState(input: {
  readonly repositoryRoot: string;
  readonly harnessPaths: readonly string[];
}): ProtectedState {
  const entries = new Map<string, ProtectedEntry>();

  for (const entry of listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)) {
    if (isHarnessPath(entry.path, input.harnessPaths)) continue;
    const absolute = path.join(input.repositoryRoot, entry.path);

    if (entry.kind === "symlink") {
      entries.set(entry.path, { kind: "symlink", target: readTarget(absolute) });
      continue;
    }
    if (entry.size !== undefined && entry.size > MAX_SNAPSHOT_BYTES) {
      // Digest rather than size: a rewrite preserving byte length would
      // otherwise be invisible.
      entries.set(entry.path, { kind: "oversized", sha256: digestOf(absolute) });
      continue;
    }
    try {
      entries.set(entry.path, { kind: "file", bytes: readFileSync(absolute) });
    } catch {
      entries.set(entry.path, { kind: "oversized", sha256: undefined });
    }
  }

  return { entries, staged: stagedProtectedPaths(input.repositoryRoot) };
}

/** Protected paths that differ from the snapshot: modified, deleted, retargeted or created. */
function protectedPathsTouched(input: {
  readonly repositoryRoot: string;
  readonly state: ProtectedState;
  readonly harnessPaths: readonly string[];
}): readonly string[] {
  const touched = new Set<string>();
  const current = new Map(
    listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)
      .filter((entry) => !isHarnessPath(entry.path, input.harnessPaths))
      .map((entry) => [entry.path, entry] as const)
  );

  for (const [relative, before] of input.state.entries) {
    const now = current.get(relative);
    if (now === undefined) {
      // Deletion leaves nothing in the listing, so a scan that only walked
      // observed files would call it clean.
      touched.add(relative);
      continue;
    }

    const absolute = path.join(input.repositoryRoot, relative);
    const nowIsSymlink = now.kind === "symlink";

    if (before.kind === "symlink" || nowIsSymlink) {
      // A file swapped for a link, or the reverse, is a change even when the
      // bytes behind it happen to match.
      if (before.kind !== "symlink" || !nowIsSymlink) {
        touched.add(relative);
        continue;
      }
      if (readTarget(absolute) !== before.target) touched.add(relative);
      continue;
    }

    if (before.kind === "oversized") {
      if (digestOf(absolute) !== before.sha256) touched.add(relative);
      continue;
    }

    try {
      if (!before.bytes.equals(readFileSync(absolute))) touched.add(relative);
    } catch {
      touched.add(relative);
    }
  }

  for (const relative of current.keys()) {
    if (!input.state.entries.has(relative)) touched.add(relative);
  }

  return [...touched].sort();
}

/**
 * Put the Git index back for restored paths.
 *
 * Rewriting the working tree is not enough: an executor that ran `git add`
 * leaves its blob staged, and the operator's next commit would reintroduce the
 * tampering even though the run was reported blocked and restored.
 */
function restoreProtectedIndex(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
  readonly state: ProtectedState;
  readonly paths: readonly string[];
}): readonly string[] {
  if (input.paths.length === 0) return [];
  // Failures are returned rather than swallowed: a reset that did not happen
  // leaves the tampered blob staged while containment reports the path restored.
  const run = (args: readonly string[]): boolean => {
    try {
      execFileSync("git", ["-C", input.repositoryRoot, ...args], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  // Reset against the pre-dispatch commit, not the current one. A bare
  // `git reset -- <path>` resets to HEAD, and if the executor committed its
  // rewrite then HEAD is the executor's — so the index would be restored to the
  // tampered blob. Naming the base makes the reference point one the run could
  // not influence.
  const failures: string[] = [];
  if (!run(["reset", "--quiet", input.baseGitSha, "--", ...input.paths])) {
    failures.push(...input.paths);
  }
  const restage = input.paths.filter((relative) => input.state.staged.has(relative));
  if (restage.length > 0 && !run(["add", "--", ...restage])) {
    failures.push(...restage);
  }
  return failures;
}

/**
 * Protected paths that differ between the base commit and the current HEAD.
 *
 * Checked independently of the working tree. An executor can commit a rewrite
 * and then put the files back, leaving nothing for the snapshot comparison to
 * find while the poisoned blob sits in history — a guard that only looks at the
 * tree is defeated by tidying up.
 */
function protectedPathsCommittedSince(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
}): readonly string[] {
  try {
    const output = execFileSync(
      "git",
      [
        "-C",
        input.repositoryRoot,
        "diff",
        "--name-only",
        input.baseGitSha,
        "HEAD",
        "--",
        LEGION_PROJECT_ROOT
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The commit the worktree is on now, or `undefined` when it cannot be read. */
function currentHead(repositoryRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Restore protected paths to their pre-dispatch state, working tree and index.
 *
 * Every replacement removes the current entry first. Writing straight to the
 * path would follow a symlink an executor had put there, overwriting whatever it
 * points at — possibly outside the repository — with the saved control-artifact
 * bytes, while leaving the link in place and reporting the path restored. That
 * turns containment into an arbitrary-write primitive.
 *
 * Anything that cannot be faithfully recreated is left alone and reported,
 * because deleting it would be worse than the modification being undone.
 */
function restoreProtectedFiles(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
  readonly state: ProtectedState;
  readonly paths: readonly string[];
}): { readonly restored: readonly string[]; readonly unrestored: readonly string[] } {
  const restored: string[] = [];
  const unrestored: string[] = [];

  // A replaced root is handled first and alone. Restoring a root symlink and
  // then processing descendants would make every later `rmSync` traverse the
  // recreated link and delete files in its target; a root replaced by a regular
  // file blocks descendant restoration with ENOTDIR until it is removed.
  const rootTouched = input.paths.includes(LEGION_PROJECT_ROOT);
  const ordered = rootTouched
    ? [LEGION_PROJECT_ROOT, ...input.paths.filter((entry) => entry !== LEGION_PROJECT_ROOT)]
    : input.paths;
  const rootWasProtectedEntry = input.state.entries.has(LEGION_PROJECT_ROOT);

  for (const relative of ordered) {
    const absolute = path.join(input.repositoryRoot, relative);
    const before = input.state.entries.get(relative);

    // When the root itself was a snapshotted non-directory, it is the whole
    // protected tree; there are no descendants to walk into afterwards.
    if (rootWasProtectedEntry && relative !== LEGION_PROJECT_ROOT) continue;

    try {
      if (before === undefined) {
        rmSync(absolute, { force: true, recursive: true });
        restored.push(relative);
        continue;
      }
      if (before.kind === "file") {
        rmSync(absolute, { force: true, recursive: true });
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, before.bytes);
        restored.push(relative);
        continue;
      }
      if (before.kind === "symlink" && before.target !== undefined) {
        rmSync(absolute, { force: true, recursive: true });
        mkdirSync(path.dirname(absolute), { recursive: true });
        symlinkSync(before.target, absolute);
        restored.push(relative);
        continue;
      }
      unrestored.push(relative);
    } catch {
      unrestored.push(relative);
    }
  }

  const indexFailures = restoreProtectedIndex({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha,
    state: input.state,
    paths: restored
  });

  // A path whose index entry could not be reset is not restored, whatever the
  // working tree looks like.
  const stillStaged = new Set(indexFailures);
  return {
    restored: restored.filter((entry) => !stillStaged.has(entry)),
    unrestored: [...unrestored, ...indexFailures]
  };
}

export async function runGuardedExecution(
  input: GuardedExecutionInput
): Promise<GuardedExecutionOutcome> {
  const before: DiffObservation | undefined = observeWorkingTreeDiff({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha
  }).observation;

  const state = snapshotProtectedState({
    repositoryRoot: input.repositoryRoot,
    harnessPaths: input.harnessPaths
  });

  let result: ExecutionResult | undefined;
  let thrown: unknown;
  try {
    result = await input.run();
    if (input.afterRun !== undefined) await input.afterRun();
  } catch (error) {
    // A run that throws after writing must still be contained; returning here
    // would leave a poisoned control artifact on disk.
    thrown = error;
  }

  const touchedProtected = protectedPathsTouched({
    repositoryRoot: input.repositoryRoot,
    state,
    harnessPaths: input.harnessPaths
  });

  const containment = touchedProtected.length === 0
    ? { restored: [] as readonly string[], unrestored: [] as readonly string[] }
    : restoreProtectedFiles({
        repositoryRoot: input.repositoryRoot,
        baseGitSha: input.baseGitSha,
        state,
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
  const committedProtected = protectedPathsCommittedSince({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha
  });
  const headAfter = currentHead(input.repositoryRoot);
  if (committedProtected.length > 0 && headAfter !== undefined && headAfter !== input.baseGitSha) {
    // The worktree and index are restored, but a commit the run created still
    // contains the rewrite. Rewriting history here would discard whatever else
    // that commit holds, so the operator is told instead of guessed for.
    reasons.push(
      `The run committed changes to ${committedProtected.length} protected control artifact(s): ${committedProtected.join(", ")}. HEAD is now ${headAfter} rather than ${input.baseGitSha}; the working tree and index were restored, but that commit still contains the change.`
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
