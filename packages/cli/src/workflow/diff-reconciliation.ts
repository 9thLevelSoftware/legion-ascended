import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
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

/**
 * One changed file, with everything needed to attribute it.
 *
 * Per-file granularity is load-bearing rather than tidy. An earlier version
 * tracked only path lists plus a single total line count, which broke two ways:
 * subtracting a pre-existing dirty path removed it wholesale even if the
 * executor went on to edit that same file, and filtering harness paths out of
 * the path lists left their lines inside the total. Both are fixed by filtering
 * files and deriving the totals.
 */
export interface ObservedFile {
  readonly path: string;
  /** Added + deleted lines. Binary files count as 0. */
  readonly linesChanged: number;
  /** Did not exist at the base commit. */
  readonly isNew: boolean;
  /**
   * Content hash of the file as it currently stands, or `undefined` when it is
   * unreadable (deleted, binary-unreadable, oversized). Comparing hashes across
   * two observations is what distinguishes "this file was already dirty" from
   * "the executor changed this file too".
   */
  readonly contentSha256: string | undefined;
}

export interface DiffObservation {
  readonly files: readonly ObservedFile[];
  /** Repository-relative POSIX paths that changed, tracked and untracked. */
  readonly changedFiles: readonly string[];
  /** Subset of `changedFiles` that did not exist at the base commit. */
  readonly newFiles: readonly string[];
  /** Added + deleted lines across `files`. */
  readonly linesChanged: number;
  readonly baseGitSha: string;
}

/** Derive the summary views from the authoritative per-file list. */
export function summarizeObservation(
  files: readonly ObservedFile[],
  baseGitSha: string
): DiffObservation {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: ordered,
    changedFiles: ordered.map((file) => file.path),
    newFiles: ordered.filter((file) => file.isNew).map((file) => file.path),
    linesChanged: ordered.reduce((total, file) => total + file.linesChanged, 0),
    baseGitSha
  };
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
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

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
 * Hash a file's current bytes so two observations can be compared by content.
 *
 * Returns `undefined` when the file cannot be read — deleted, oversized, or
 * permission-denied. Callers treat an unknown hash as "assume it changed",
 * because an unreadable file is not evidence that nothing happened to it.
 */
function hashFileContent(absolutePath: string): string | undefined {
  try {
    if (statSync(absolutePath).size > MAX_HASHED_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return undefined;
  }
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

  // `git init` creates a work tree before the first commit exists. In that
  // state the resolver supplies the all-zero SHA, but `git diff BASE` cannot
  // read it. Treat this like a non-git project: there is no baseline to
  // reconcile against, but that environmental limitation is not a violation.
  if (/^0{40}$/u.test(input.baseGitSha)) {
    return {
      status: "not_applicable",
      violations: [],
      unavailableReason: "The repository has no commit yet, so a working-tree diff cannot be reconciled."
    };
  }

  const lines = new Map<string, number>();
  const created = new Set<string>();

  try {
    // Tracked changes since the base commit, whether committed or staged.
    for (const line of splitLines(git(input.repositoryRoot, ["diff", "--numstat", input.baseGitSha, "--"]))) {
      const [added, deleted, ...rest] = line.split("\t");
      const filePath = toPosix(rest.join("\t"));
      if (filePath.length === 0) continue;
      // Binary files report "-" for both counts.
      const count = (Number.parseInt(added ?? "", 10) || 0) + (Number.parseInt(deleted ?? "", 10) || 0);
      lines.set(filePath, (lines.get(filePath) ?? 0) + count);
    }

    for (const line of splitLines(git(input.repositoryRoot, ["diff", "--name-status", input.baseGitSha, "--"]))) {
      const [status, ...rest] = line.split("\t");
      const filePath = toPosix(rest[rest.length - 1] ?? "");
      if (filePath.length === 0) continue;
      if (!lines.has(filePath)) lines.set(filePath, 0);
      if (status?.startsWith("A")) created.add(filePath);
    }

    // Untracked files never appear in `git diff`.
    for (const line of splitLines(git(input.repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]))) {
      const code = line.slice(0, 2);
      const filePath = toPosix(line.slice(3).trim());
      if (filePath.length === 0) continue;
      if (code === "??") {
        created.add(filePath);
        lines.set(filePath, countUntrackedLines(path.join(input.repositoryRoot, filePath)));
      } else if (!lines.has(filePath)) {
        lines.set(filePath, 0);
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      violations: [],
      unavailableReason: `The working tree diff could not be read: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const files: ObservedFile[] = [...lines.entries()].map(([filePath, linesChanged]) => ({
    path: filePath,
    linesChanged,
    isNew: created.has(filePath),
    contentSha256: hashFileContent(path.join(input.repositoryRoot, filePath))
  }));

  return {
    status: "clean",
    violations: [],
    observation: summarizeObservation(files, input.baseGitSha)
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
  /** Forbidden regardless of the contract, for harness invariants older taskgraphs must not be able to waive. */
  readonly alwaysForbidden?: readonly string[];
}): readonly ReconciliationViolation[] {
  const violations: ReconciliationViolation[] = [];
  const harnessPaths = input.harnessPaths ?? [];
  // Filter files, then derive the totals. Filtering the path lists while reusing
  // the observation's own line total would leave harness log lines inside the
  // budget, so a verbose executor log could block an in-contract run.
  const attributable = summarizeObservation(
    input.observation.files.filter((file) => !coveredByAny(file.path, harnessPaths)),
    input.observation.baseGitSha
  );
  const { changedFiles, newFiles, linesChanged } = attributable;
  const { write, budget } = input.scope;
  const forbidden = [...input.scope.forbidden, ...(input.alwaysForbidden ?? [])];

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
 * executor for edits it never made.
 *
 * Attribution is by **content**, not by path. Dropping every path that was
 * already dirty would let an executor edit an already-dirty forbidden or
 * out-of-scope file with no trace — a bypass of the very checks this module
 * exists to perform, and one that a dirty worktree makes trivially reachable.
 * A file therefore stays attributable whenever its content hash differs from
 * the pre-dispatch snapshot, and is dropped only when it is byte-identical to
 * what was already there.
 *
 * A file whose content cannot be hashed on either side is kept rather than
 * dropped: an unreadable file is not evidence of innocence.
 */
export function diffDelta(before: DiffObservation, after: DiffObservation): DiffObservation {
  const priorByPath = new Map(before.files.map((file) => [file.path, file]));

  const attributable = after.files.filter((file) => {
    const prior = priorByPath.get(file.path);
    if (prior === undefined) return true;
    if (prior.contentSha256 === undefined || file.contentSha256 === undefined) return true;
    return prior.contentSha256 !== file.contentSha256;
  });

  return summarizeObservation(
    attributable.map((file) => {
      const prior = priorByPath.get(file.path);
      if (prior === undefined) return file;

      // The file was already dirty and the executor changed it again. Both
      // counts are diffs against the same base, so their difference is the
      // additional churn — except when the executor replaced one edit with a
      // similarly sized different edit, where the net is zero or negative even
      // though the content hash proves work happened. Subtracting alone would
      // let arbitrary churn in already-dirty in-scope files bypass the line
      // budget entirely.
      //
      // When the net is not positive, fall back to the file's whole diff against
      // the base. That overstates the executor's share, which is the safe
      // direction for a budget: it can block a run that deserved more room, but
      // it cannot wave through unbounded rewriting.
      const additional = file.linesChanged - prior.linesChanged;
      return {
        ...file,
        linesChanged: additional > 0 ? additional : file.linesChanged,
        // A file that already existed as a pre-existing new file is not newly
        // created by this run.
        isNew: file.isNew && !prior.isNew
      };
    }),
    after.baseGitSha
  );
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
  /** Forbidden regardless of contract; see `reconcileDiff`. */
  readonly alwaysForbidden?: readonly string[];
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
  //
  // Filter `files` and re-derive, never spread-and-patch: the summary views are
  // computed from `files`, so patching them while leaving `files` intact puts
  // harness output back into the budget totals.
  const harnessPaths = input.harnessPaths ?? [];
  const attributable = summarizeObservation(
    delta.files.filter((file) => !coveredByAny(file.path, harnessPaths)),
    delta.baseGitSha
  );

  const violations = reconcileDiff({
    observation: attributable,
    scope: input.scope,
    ...(input.alwaysForbidden === undefined ? {} : { alwaysForbidden: input.alwaysForbidden })
  });
  return {
    status: violations.length === 0 ? "clean" : "violated",
    observation: attributable,
    violations
  };
}

/**
 * Restore paths to their state at `baseGitSha`, discarding whatever a run wrote.
 *
 * Detecting a forbidden write is not enough on its own: if the offending file
 * stays on disk, the next command reads it. Control artifacts are exactly the
 * files later stages reload, so a rewrite that is merely *reported* is still a
 * rewrite that gets consumed. Restoring is what turns detection into
 * containment.
 *
 * Returns the paths it could not restore, so the caller can say so rather than
 * implying the tree is clean.
 */
export function restorePathsToBase(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: string;
  readonly paths: readonly string[];
}): readonly string[] {
  const failed: string[] = [];
  for (const filePath of input.paths) {
    try {
      git(input.repositoryRoot, ["checkout", input.baseGitSha, "--", filePath]);
      continue;
    } catch {
      // Not present at the base commit, so restoring means removing it.
    }
    try {
      rmSync(path.join(input.repositoryRoot, filePath), { force: true });
    } catch {
      failed.push(filePath);
    }
  }
  return failed;
}
