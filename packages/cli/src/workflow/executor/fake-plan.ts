import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExecutionResult } from "./types.js";

/**
 * A scripted misbehaviour plan for the `fake` executor.
 *
 * The `fake` executor wrote nothing, so no test could exercise a write-path
 * violation end to end. That single gap is why an unsatisfiable task contract,
 * an unreconciled auto-fix path, a double-resolved base SHA and a missing
 * containment step all shipped through a green suite: every reconciliation test
 * operated on synthetic observations rather than on an executor actually doing
 * the wrong thing.
 *
 * This lets a test say "write here, claim you wrote there, then commit" and
 * assert that the harness catches it. It is deliberately blunt — the point is
 * to produce real filesystem and git effects the enforcement path must observe,
 * not to simulate a plausible agent.
 *
 * Activated only by `LEGION_FAKE_EXECUTOR_PLAN`, so ordinary `--executor fake`
 * runs behave exactly as before.
 */

export const FAKE_PLAN_ENV = "LEGION_FAKE_EXECUTOR_PLAN";

export interface FakeExecutorPlan {
  /** Files to create or overwrite, relative to the repository root. */
  readonly writes?: readonly { readonly path: string; readonly content: string }[];
  /** Files to delete, relative to the repository root. */
  readonly deletes?: readonly string[];
  /** Commit the working tree after writing — the case that breaks a re-resolved base SHA. */
  readonly commit?: boolean;
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
export function applyFakeExecutorPlan(input: {
  readonly repositoryRoot: string;
  readonly plan: FakeExecutorPlan;
}): readonly string[] {
  const written: string[] = [];

  for (const entry of input.plan.writes ?? []) {
    const absolute = path.join(input.repositoryRoot, ...entry.path.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.content, "utf8");
    written.push(entry.path);
  }

  for (const entry of input.plan.deletes ?? []) {
    rmSync(path.join(input.repositoryRoot, ...entry.split("/")), { force: true });
    written.push(entry);
  }

  if (input.plan.commit === true) {
    try {
      execFileSync("git", ["-C", input.repositoryRoot, "add", "-A"], { stdio: "ignore" });
      execFileSync(
        "git",
        ["-C", input.repositoryRoot, "-c", "user.email=fake@legion", "-c", "user.name=Fake Executor", "commit", "-m", "fake executor commit"],
        { stdio: "ignore" }
      );
    } catch {
      // Nothing to commit, or not a git repository; the plan's other effects stand.
    }
  }

  return written;
}
