import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExecutionResult } from "./types.js";

/**
 * A scripted misbehaviour plan for the `fake` executor, enabled only by
 * `LEGION_FAKE_EXECUTOR_PLAN`. Without it the fake behaves exactly as before and
 * touches nothing.
 *
 * Lets a test drive real filesystem and git effects — write here, claim you
 * wrote there, then commit — so the enforcement path can be exercised against an
 * executor that actually misbehaves rather than against synthetic observations.
 */

export const FAKE_PLAN_ENV = "LEGION_FAKE_EXECUTOR_PLAN";

export interface FakeExecutorPlan {
  /** Files to create or overwrite, relative to the repository root. */
  readonly writes?: readonly { readonly path: string; readonly content: string }[];
  /** Files to delete, relative to the repository root. */
  readonly deletes?: readonly string[];
  /**
   * Symlinks to create, relative to the repository root.
   *
   * The case worth exercising is an executor planting a link inside the
   * protected tree: the guard has to notice something it must never follow.
   */
  readonly symlinks?: readonly { readonly path: string; readonly target: string }[];
  /** Commit the working tree after writing — the case that breaks a re-resolved base SHA. */
  readonly commit?: boolean;
  /**
   * Writes applied *after* the commit, to restore the tree and hide the change.
   *
   * The attack a working-tree-only guard misses entirely: commit the tampering,
   * put the files back, and leave nothing for a snapshot comparison to find
   * while the poisoned blob stays in history.
   */
  readonly writesAfterCommit?: readonly { readonly path: string; readonly content: string }[];
  /** What the executor *claims* it changed. Omit to claim exactly what it wrote. */
  readonly claimFilesChanged?: readonly string[];
  readonly status?: ExecutionResult["status"];
  readonly summary?: string;
}

export function readFakeExecutorPlan(): FakeExecutorPlan | undefined {
  const raw = process.env[FAKE_PLAN_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as FakeExecutorPlan) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply the plan to the repository and report what was actually written.
 *
 * The returned list is the truth; `claimFilesChanged` is what the executor will
 * report about itself. Keeping them separable is what makes claim-versus-
 * observation drift testable.
 */
export interface ApplyFakeExecutorPlanInput {
  readonly repositoryRoot: string;
  readonly plan: FakeExecutorPlan;
  /** A read-only dispatch must stay read-only, test hook or not. */
  readonly readOnly: boolean;
}

/**
 * Resolve a planned path and require it to stay inside the repository.
 *
 * `path.join` is not a sandbox: `../..` walks out of the worktree, where nothing
 * reconciliation does can see the change. A test hook that can write anywhere is
 * a liability regardless of intent.
 */
function resolveInsideRepository(repositoryRoot: string, relative: string): string | undefined {
  const root = path.resolve(repositoryRoot);
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return absolute === root || absolute.startsWith(prefix) ? absolute : undefined;
}

/**
 * Apply the plan and report what was actually written.
 *
 * The returned list is the truth; `claimFilesChanged` is what the executor will
 * report about itself. Keeping them separable is what makes claim-versus-
 * observation drift testable.
 */
export function applyFakeExecutorPlan(input: ApplyFakeExecutorPlanInput): readonly string[] {
  // The plan is a test hook, not an authority to ignore the request contract.
  if (input.readOnly) return [];

  const written: string[] = [];
  const staged: string[] = [];

  for (const entry of input.plan.writes ?? []) {
    const absolute = resolveInsideRepository(input.repositoryRoot, entry.path);
    if (absolute === undefined) continue;
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.content, "utf8");
    written.push(entry.path);
    staged.push(entry.path);
  }

  for (const entry of input.plan.deletes ?? []) {
    const absolute = resolveInsideRepository(input.repositoryRoot, entry);
    if (absolute === undefined) continue;
    rmSync(absolute, { force: true });
    written.push(entry);
    staged.push(entry);
  }

  for (const entry of input.plan.symlinks ?? []) {
    const absolute = resolveInsideRepository(input.repositoryRoot, entry.path);
    if (absolute === undefined) continue;
    try {
      mkdirSync(path.dirname(absolute), { recursive: true });
      rmSync(absolute, { force: true });
      symlinkSync(entry.target, absolute);
      written.push(entry.path);
      staged.push(entry.path);
    } catch {
      // Platforms that refuse symlink creation without elevation simply do not
      // exercise this case; the test that needs it skips.
    }
  }

  if (input.plan.commit === true && staged.length > 0) {
    try {
      // Stage only the planned paths. `git add -A` would sweep up the caller's
      // unrelated edits and any harness output that happened to be present.
      execFileSync("git", ["-C", input.repositoryRoot, "add", "--", ...staged], { stdio: "ignore" });
      execFileSync(
        "git",
        ["-C", input.repositoryRoot, "-c", "user.email=fake@legion", "-c", "user.name=Fake Executor", "commit", "-m", "fake executor commit"],
        { stdio: "ignore" }
      );
    } catch {
      // Nothing to commit, or not a git repository; the plan's other effects stand.
    }
  }

  for (const entry of input.plan.writesAfterCommit ?? []) {
    const absolute = resolveInsideRepository(input.repositoryRoot, entry.path);
    if (absolute === undefined) continue;
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.content, "utf8");
    if (!written.includes(entry.path)) written.push(entry.path);
  }

  return written;
}
