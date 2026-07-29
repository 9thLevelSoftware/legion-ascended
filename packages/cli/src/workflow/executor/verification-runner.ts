import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  VerificationCommandRequest,
  VerificationCommandResult,
  VerificationRunner
} from "@legion/core";
import type { ContentHash, UtcTimestamp } from "@legion/protocol";

import { currentUtcTimestamp } from "../change-input.js";
import { resolveCliSourceRoot } from "../../source-root.js";

/**
 * The real verification runner.
 *
 * `TaskContract.verification[]` has always been rendered into the executor
 * prompt as text and then never executed — the "verification" recorded in
 * evidence was whatever exit code the executor reported about itself. This
 * module is what makes the field mean something: the declared commands are run
 * by the harness, and their exit codes are observed rather than reported.
 *
 * `@legion/core` owns the deterministic record shape and injects this runner,
 * which is why the execution concern lives here in the CLI rather than in core
 * (ADR-004 / ADR-005 keep core provider-neutral).
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_EXIT_CODE = 124;
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;
const LEGION_BIN = "bin/legion.js";

/**
 * Resolve a bare `legion` verification command to the Legion that is running.
 *
 * Task contracts are committed artifacts, so they must stay portable — baking
 * an absolute interpreter path into `verification[]` would tie a contract to
 * the machine that planned it. A contract therefore names the tool, and the
 * runner resolves it, exactly as it would resolve any other command on PATH.
 * Without this, a contract that verifies itself with `legion validate` only
 * works where Legion happens to be globally installed.
 */
function resolveCommand(
  command: string,
  args: readonly string[]
): { readonly command: string; readonly args: readonly string[] } {
  if (command !== "legion") return { command, args };

  const sourceRoot = resolveCliSourceRoot(import.meta.url, LEGION_BIN);
  const binPath = path.join(sourceRoot, ...LEGION_BIN.split("/"));
  if (!existsSync(binPath)) return { command, args };

  return { command: process.execPath, args: [binPath, ...args] };
}

function sha256(value: string): ContentHash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as ContentHash;
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process already exited; nothing to terminate.
  }
}

interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: Error;
}

function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    // A verification command that cannot even be spawned (missing binary,
    // bad path) is a failed verification, not a crashed build — resolve with a
    // structured outcome so the report records it like any other failure.
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    const settle = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      setTimeout(
        () => settle({ exitCode: TIMEOUT_EXIT_CODE, stdout, stderr, timedOut: true }),
        1_000
      ).unref();
    }, input.timeoutMs);

    const append = (current: string, chunk: unknown): string =>
      current.length >= MAX_CAPTURED_BYTES ? current : current + String(chunk);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      settle({ exitCode: 1, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code) => {
      settle({ exitCode: timedOut ? TIMEOUT_EXIT_CODE : code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export interface CreateVerificationRunnerOptions {
  readonly repositoryRoot: string;
  readonly defaultTimeoutMs?: number;
  /** Injected for deterministic tests. */
  readonly now?: () => UtcTimestamp;
}

/**
 * Build a `VerificationRunner` bound to a repository root.
 *
 * Commands run with `shell: false` and an explicit argv, so a declared
 * verification command cannot expand into shell metacharacters supplied by
 * whatever wrote the contract.
 */
export function createVerificationRunner(
  options: CreateVerificationRunnerOptions
): VerificationRunner {
  const now = options.now ?? currentUtcTimestamp;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request: VerificationCommandRequest): Promise<VerificationCommandResult> => {
    const startedAt = now();
    const startedMs = Date.now();
    const resolved = resolveCommand(request.command, request.args);
    const outcome = await runCommand({
      command: resolved.command,
      args: resolved.args,
      cwd: options.repositoryRoot,
      timeoutMs: request.timeoutMs ?? defaultTimeoutMs
    });
    const finishedAt = now();

    const notes = outcome.spawnError !== undefined
      ? `Verification command could not be started: ${outcome.spawnError.message}`
      : outcome.timedOut
        ? `Verification command timed out after ${request.timeoutMs ?? defaultTimeoutMs}ms.`
        : undefined;

    return {
      index: request.index,
      command: request.command,
      args: [...request.args],
      exitCode: outcome.exitCode,
      expectedExitCode: request.expectedExitCode,
      stdoutSha256: sha256(outcome.stdout),
      stderrSha256: sha256(outcome.stderr),
      // `sha256(stdout ++ stderr)`, in that order — NOT a digest of the two
      // streams interleaved as a terminal would show them. The streams are
      // captured separately, so real arrival order is not recoverable here.
      // Treat this as a cheap combined fingerprint, not a reproduction of the
      // run's console output.
      combinedSha256: sha256(`${outcome.stdout}${outcome.stderr}`),
      durationMs: Date.now() - startedMs,
      timedOut: outcome.timedOut,
      startedAt,
      finishedAt,
      ...(notes === undefined ? {} : { notes })
    };
  };
}
