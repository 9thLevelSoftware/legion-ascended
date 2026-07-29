import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { TaskContract } from "@legion/protocol";

/**
 * Post-execution diff reconciliation.
 *
 * Everything else in the build path records what an executor *said* it did.
 * This module records what the working tree *shows* it did, and compares the
 * two against the task contract. It is the only check in the workflow that does
 * not take the executor's word for anything.
 *
 * The comparison is deliberately one-directional: a diff that stays inside
 * `scope.write` and within `scope.budget` proves nothing about correctness, but
 * a diff that leaves them proves the run is out of contract. That asymmetry is
 * the point — this catches drift regardless of how good the plan was.
 */

export type ReconciliationViolationCode =
  | "out_of_scope_write"
  | "forbidden_path_touched"
  | "budget_files_exceeded"
  | "budget_lines_exceeded"
  | "budget_new_files_exceeded";

export interface ReconciliationViolation {
  readonly code: ReconciliationViolationCode;
  readonly message: string;
  readonly paths: readonly string[];
}

export interface DiffObservation {
  /** Repository-relative POSIX paths that changed, tracked and untracked. */
  readonly changedFiles: readonly string[];
  /** Subset of `changedFiles` that did not exist at the base commit. */
  readonly newFiles: readonly string[];
  /** Added + deleted lines across all changed files. Binary files count as 0. */
  readonly linesChanged: number;
  readonly baseGitSha: string;
}

/**
 * `not_applicable` and `unavailable` are deliberately distinct.
 *
 * A project that is not under git simply cannot be reconciled — that is a
 * property of the environment, not evidence of misbehaviour, and Legion stays
 * usable there (the dirty-worktree pre-flight already tolerates non-git
 * projects the same way). A project that *is* under git but whose diff could
 * not be read is a different matter: the check that should have run did not,
 * and the run is not proven in-contract.
 *
 * Collapsing the two would force a choice between breaking every non-git
 * project and silently passing runs whose diff was unreadable.
 */
export type ReconciliationStatus = "clean" | "violated" | "not_applicable" | "unavailable";

export interface ReconciliationResult {
  readonly status: ReconciliationStatus;
  readonly observation?: DiffObservation;
  readonly violations: readonly ReconciliationViolation[];
  /** Set for `not_applicable` and `unavailable`; explains which and why. */
  readonly unavailableReason?: string;
}

/** True when the result proves the run stayed inside its contract. */
export function reconciliationBlocks(result: ReconciliationResult | undefined): boolean {
  if (result === undefined) return false;
  return result.status === "violated" || result.status === "unavailable";
}

const MAX_UNTRACKED_LINE_COUNT_BYTES = 2_000_000;

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024
  });
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function splitLines(value: string): readonly string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

/**
 * Untracked files have no base blob to diff against, so their whole contents
 * count toward the line budget. Oversized or unreadable files contribute 0
 * rather than failing the run — the file-count budget still bounds them.
 */
function countUntrackedLines(absolutePath: string): number {
  try {
    if (statSync(absolutePath).size > MAX_UNTRACKED_LINE_COUNT_BYTES) return 0;
    const contents = readFileSync(absolutePath, "utf8");
    if (contents.length === 0) return 0;
    return contents.split(/\r?\n/u).length;
  } catch {
    return 0;
  }
}

/**
 * Observe what actually changed between `baseGitSha` and the current working
 * tree, including uncommitted and untracked files.
 */
export function observeWorkingTreeDiff(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: string;
}): ReconciliationResult {
  try {
    git(input.repositoryRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      status: "not_applicable",
      violations: [],
      unavailableReason: "The project is not under git, so a working-tree diff cannot be observed."
    };
  }

  const changed = new Set<string>();
  const created = new Set<string>();
  let linesChanged = 0;

  try {
    // Tracked changes since the base commit, whether committed or staged.
    for (const line of splitLines(git(input.repositoryRoot, ["diff", "--numstat", input.baseGitSha, "--"]))) {
      const [added, deleted, ...rest] = line.split("\t");
      const filePath = toPosix(rest.join("\t"));
      if (filePath.length === 0) continue;
      changed.add(filePath);
      // Binary files report "-" for both counts.
      linesChanged += (Number.parseInt(added ?? "", 10) || 0) + (Number.parseInt(deleted ?? "", 10) || 0);
    }

    for (const line of splitLines(git(input.repositoryRoot, ["diff", "--name-status", input.baseGitSha, "--"]))) {
      const [status, ...rest] = line.split("\t");
      const filePath = toPosix(rest[rest.length - 1] ?? "");
      if (filePath.length === 0) continue;
      changed.add(filePath);
      if (status?.startsWith("A")) created.add(filePath);
    }

    // Untracked files never appear in `git diff`.
    for (const line of splitLines(git(input.repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]))) {
      const code = line.slice(0, 2);
      const filePath = toPosix(line.slice(3).trim());
      if (filePath.length === 0) continue;
      changed.add(filePath);
      if (code === "??") {
        created.add(filePath);
        linesChanged += countUntrackedLines(path.join(input.repositoryRoot, filePath));
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      violations: [],
      unavailableReason: `The working tree diff could not be read: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  return {
    status: "clean",
    violations: [],
    observation: {
      changedFiles: [...changed].sort(),
      newFiles: [...created].sort(),
      linesChanged,
      baseGitSha: input.baseGitSha
    }
  };
}

/**
 * True when `filePath` is covered by `scopeEntry`, which may be `"."` (the
 * whole repository), an exact file, or a directory prefix.
 */
export function pathIsCoveredBy(filePath: string, scopeEntry: string): boolean {
  if (scopeEntry === ".") return true;
  const normalized = toPosix(scopeEntry).replace(/\/+$/u, "");
  if (normalized.length === 0) return true;
  return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

function coveredByAny(filePath: string, entries: readonly string[]): boolean {
  return entries.some((entry) => pathIsCoveredBy(filePath, entry));
}

/**
 * Compare an observation against the contract's scope and budget.
 *
 * Ordering matters for the operator: forbidden-path hits and out-of-scope
 * writes name the offending files, because those are actionable. Budget
 * overruns report counts, because the file list is usually long and the number
 * is the decision.
 */
export function reconcileDiff(input: {
  readonly observation: DiffObservation;
  readonly scope: TaskContract["scope"];
  /**
   * Paths written by the harness itself — run artifacts, prompts, logs.
   *
   * These are Legion's own bookkeeping, produced by the CLI around the
   * dispatch rather than by the executor, so blaming the executor for them
   * would make every build fail reconciliation. Kept narrow and explicit: this
   * is an exclusion for known-harness output, never a general escape hatch.
   */
  readonly harnessPaths?: readonly string[];
}): readonly ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];
  const harnessPaths = input.harnessPaths ?? [];
  const attributable = input.observation.changedFiles.filter(
    (filePath) => !coveredByAny(filePath, harnessPaths)
  );
  const changedFiles = attributable;
  const newFiles = input.observation.newFiles.filter(
    (filePath) => !coveredByAny(filePath, harnessPaths)
  );
  const { linesChanged } = input.observation;
  const { write, forbidden, budget } = input.scope;

  const forbiddenHits = changedFiles.filter((filePath) => coveredByAny(filePath, forbidden));
  if (forbiddenHits.length > 0) {
    violations.push({
      code: "forbidden_path_touched",
      message: `The run modified ${forbiddenHits.length} path(s) the task contract forbids.`,
      paths: forbiddenHits
    });
  }

  const outOfScope = changedFiles.filter(
    (filePath) => !coveredByAny(filePath, write) && !coveredByAny(filePath, forbidden)
  );
  if (outOfScope.length > 0) {
    violations.push({
      code: "out_of_scope_write",
      message: `The run modified ${outOfScope.length} path(s) outside the task contract write scope.`,
      paths: outOfScope
    });
  }

  if (changedFiles.length > budget.maxFilesChanged) {
    violations.push({
      code: "budget_files_exceeded",
      message: `The run changed ${changedFiles.length} files; the contract budget allows ${budget.maxFilesChanged}.`,
      paths: []
    });
  }

  if (linesChanged > budget.maxLinesChanged) {
    violations.push({
      code: "budget_lines_exceeded",
      message: `The run changed ${linesChanged} lines; the contract budget allows ${budget.maxLinesChanged}.`,
      paths: []
    });
  }

  if (newFiles.length > budget.maxNewFiles) {
    violations.push({
      code: "budget_new_files_exceeded",
      message: `The run created ${newFiles.length} files; the contract budget allows ${budget.maxNewFiles}.`,
      paths: newFiles
    });
  }

  return violations;
}

/**
 * Attribute to the run only what the run actually changed.
 *
 * `legion build --allow-dirty` permits a worktree that was already modified
 * before dispatch. Reconciling the raw post-run diff would then blame the
 * executor for edits it never made, which would make the check untrustworthy
 * and, worse, trainable-around. Subtracting a pre-dispatch observation keeps
 * the reconciliation honest on both paths.
 *
 * Line counts are a difference of totals rather than a per-file diff, so a run
 * that both adds and reverts lines can under-report. That is the safe direction
 * for a budget check: it never invents an overrun.
 */
export function diffDelta(before: DiffObservation, after: DiffObservation): DiffObservation {
  const preexisting = new Set(before.changedFiles);
  const preexistingNew = new Set(before.newFiles);
  return {
    changedFiles: after.changedFiles.filter((filePath) => !preexisting.has(filePath)),
    newFiles: after.newFiles.filter((filePath) => !preexistingNew.has(filePath)),
    linesChanged: Math.max(0, after.linesChanged - before.linesChanged),
    baseGitSha: after.baseGitSha
  };
}

/**
 * Reconcile what a run changed against its contract.
 *
 * An `unavailable` result is never reported as clean. A run whose diff cannot
 * be observed has not been proven to be in contract, and the caller is expected
 * to treat that as a blocking condition rather than a passing one.
 */
export function reconcileTaskDiff(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: string;
  readonly scope: TaskContract["scope"];
  /** Pre-dispatch observation, so pre-existing edits are not blamed on the run. */
  readonly before?: DiffObservation;
  /** Harness-written paths to exclude; see `reconcileDiff`. */
  readonly harnessPaths?: readonly string[];
}): ReconciliationResult {
  const observed = observeWorkingTreeDiff(input);
  if (observed.observation === undefined) return observed;

  const delta =
    input.before === undefined ? observed.observation : diffDelta(input.before, observed.observation);

  // Strip harness output once, here, so the returned observation is exactly
  // "what the executor is answerable for". Callers comparing the executor's
  // self-reported file list against this must see the same set reconciliation
  // judged, or they report mismatches for files the executor never claimed
  // because it never touched them.
  const harnessPaths = input.harnessPaths ?? [];
  const attributable: DiffObservation = {
    ...delta,
    changedFiles: delta.changedFiles.filter((filePath) => !coveredByAny(filePath, harnessPaths)),
    newFiles: delta.newFiles.filter((filePath) => !coveredByAny(filePath, harnessPaths))
  };

  const violations = reconcileDiff({ observation: attributable, scope: input.scope });
  return {
    status: violations.length === 0 ? "clean" : "violated",
    observation: attributable,
    violations
  };
}
