import type { TaskContractScopeBudget } from "@legion/protocol";

/**
 * Write-scope entries as declared by a caller. Deliberately unbranded: the
 * budget only counts entries and detects repository-wide scope, so it accepts
 * paths that have not yet been parsed into `ArtifactPath`.
 */
export type DeclaredWriteScope = readonly string[];

/**
 * Derive a blast-radius budget from a task's declared write scope.
 *
 * A budget is required on every task contract, and it must mean something: it
 * is the number the post-execution diff is reconciled against. Deriving it from
 * `scope.write` keeps the two in step, so widening what a task may touch is a
 * visible edit to the contract rather than a silent overrun at build time.
 *
 * `slack` covers incidental in-scope churn a task legitimately needs — a lock
 * file, an index re-export — without opening the budget to unrelated work.
 */
export interface WriteScopeBudgetOptions {
  /** Extra changed files allowed beyond the declared write paths. Defaults to 0. */
  readonly slackFiles?: number;
  /** Line allowance per changed file. Defaults to 200. */
  readonly linesPerFile?: number;
}

const DEFAULT_LINES_PER_FILE = 200;

/**
 * Budget for a task whose write scope is the whole repository (`"."`).
 *
 * `legion quick` and `legion polish` accept repository-wide scope because the
 * caller often cannot name the files in advance. That makes the budget the only
 * thing bounding them, so it is stated explicitly here rather than derived from
 * a path count that would be meaninglessly small.
 */
export const REPOSITORY_WIDE_TASK_BUDGET: TaskContractScopeBudget = {
  maxFilesChanged: 20,
  maxLinesChanged: 2_000,
  maxNewFiles: 10
};

function isRepositoryWide(write: DeclaredWriteScope): boolean {
  return write.some((entry) => entry === ".");
}

export function budgetForWriteScope(
  write: DeclaredWriteScope,
  options: WriteScopeBudgetOptions = {}
): TaskContractScopeBudget {
  if (isRepositoryWide(write)) return REPOSITORY_WIDE_TASK_BUDGET;

  const slackFiles = options.slackFiles ?? 0;
  const linesPerFile = options.linesPerFile ?? DEFAULT_LINES_PER_FILE;

  // An empty write scope is a contract-authoring error. Rounding it up to a
  // one-file budget would silently accept the mistake and reconcile the run
  // against a limit nobody wrote.
  if (write.length === 0) {
    throw new RangeError(
      "Cannot derive a blast-radius budget from an empty write scope; the task contract must declare what it may write."
    );
  }

  const declaredFiles = write.length;
  const maxFilesChanged = declaredFiles + slackFiles;

  return {
    maxFilesChanged,
    maxLinesChanged: maxFilesChanged * linesPerFile,
    maxNewFiles: declaredFiles
  };
}
