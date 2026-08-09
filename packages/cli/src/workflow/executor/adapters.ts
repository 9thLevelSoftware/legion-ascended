import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { artifactPathSchema } from "@legion/protocol";

import type {
  ExecutionAdapter,
  ExecutionAdapterKind,
  ExecutionFinding,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatus
} from "./types.js";
import { applyFakeExecutorPlan, readFakeExecutorPlan } from "./fake-plan.js";
import {
  normalizeExecutionResult,
  parseResultFromText,
  prepareProjectTextFile,
  readOptionalText,
  redactTranscript,
  writeProjectExecutionResult,
  writeProjectTextFile
} from "./result.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_CLAUDE_EXEC_TIMEOUT_MS = 900_000;

// Claude Code has no OS-level sandbox flag, so a read-only run is enforced by
// denying the file-mutating tools rather than by confining writes the way
// codex's `--sandbox read-only` does. Bash is deliberately still allowed: a
// review pass has to be able to run the test command, and codex's read-only
// sandbox permits non-writing commands too. The difference that remains is
// real and worth naming -- a `Bash` invocation that writes is refused by the
// codex sandbox and is not refused here. What backstops it is the guarded
// execution harness, which snapshots the control plane before dispatch and
// restores it after, so an out-of-contract write cannot survive as evidence.
const CLAUDE_READ_ONLY_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

export function claudeExecArgs(input: {
  readonly readOnly: boolean;
}): readonly string[] {
  return [
    "--print",
    "--output-format",
    "json",
    // No human is attached to answer a permission prompt. This is the same
    // posture as the codex adapter's `approval_policy="never"`.
    "--permission-mode",
    "bypassPermissions",
    ...(input.readOnly ? ["--disallowedTools", CLAUDE_READ_ONLY_DENIED_TOOLS.join(" ")] : [])
  ];
}

export function codexExecArgs(input: {
  readonly repositoryRoot: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly outputLastMessagePath: string;
}): readonly string[] {
  return [
    "exec",
    "-c",
    "approval_policy=\"never\"",
    "-C",
    input.repositoryRoot,
    "--sandbox",
    input.sandbox,
    "--json",
    "--output-last-message",
    input.outputLastMessagePath,
    "-"
  ];
}

export async function selectExecutionAdapterKind(explicit: string | undefined): Promise<ExecutionAdapterKind | {
  readonly ok: false;
  readonly diagnostic: { readonly code: string; readonly message: string };
}> {
  if (explicit !== undefined) {
    if (explicit === "claude" || explicit === "codex" || explicit === "manual" || explicit === "fake") return explicit;
    return {
      ok: false,
      diagnostic: {
        code: "invalid_executor",
        message: `Unsupported executor "${explicit}". Use claude, codex, manual, or fake.`
      }
    };
  }
  // Probed in order, and the order is the claim: whichever driver is installed
  // runs the work, and `manual` is what "no driver is installed" looks like
  // rather than a silent no-op.
  if (!runningInsideClaudeCode() && await claudeAvailable()) return "claude";
  if (await codexAvailable()) return "codex";
  return "manual";
}

/**
 * Whether this process was started by a Claude Code session.
 *
 * Auto-selection skips the claude driver here, and the reason is not tidiness.
 * The installed `/legion` entry point runs `legion build` from inside a Claude
 * Code session, so auto-selecting claude would spawn a second session --
 * bypassing permissions, billing a second agent, and handing the work to a
 * subprocess when the agent that asked for it is already sitting in the
 * repository. The manual executor's prompt artifact hands it to that agent
 * instead, which is the flow the entry point documents.
 *
 * An explicit `--executor claude` is still honored: a nested run someone asked
 * for by name is a choice, not a surprise.
 */
function runningInsideClaudeCode(): boolean {
  const marker = process.env["CLAUDECODE"];
  return marker !== undefined && marker.length > 0 && marker !== "0";
}

export function adapterForKind(kind: ExecutionAdapterKind): ExecutionAdapter {
  switch (kind) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter;
    case "manual":
      return manualAdapter;
    case "fake":
      return fakeAdapter;
  }
}

async function codexAvailable(): Promise<boolean> {
  try {
    const invocation = codexInvocation(["exec", "--help"]);
    await execFileAsync(invocation.command, invocation.args, {
      timeout: 5_000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

async function claudeAvailable(): Promise<boolean> {
  try {
    // `--version` rather than `--help`: it neither reads settings nor resolves
    // credentials, so a probe cannot be slowed down by either.
    const invocation = claudeInvocation(["--version"]);
    await execFileAsync(invocation.command, invocation.args, {
      timeout: 5_000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

const fakeAdapter: ExecutionAdapter = {
  kind: "fake",
  async run(request) {
    // A scripted plan lets tests drive real write-path violations. Absent one,
    // the fake behaves exactly as it always has and touches nothing.
    const plan = readFakeExecutorPlan();
    const written = plan === undefined
      ? []
      : applyFakeExecutorPlan({ repositoryRoot: request.repositoryRoot, plan, readOnly: request.readOnly });
    const status = plan?.status ?? "succeeded";

    const result: ExecutionResult = {
      ok: status === "succeeded",
      status,
      summary: plan?.summary ?? fakeSummary(request),
      // What it claims, which a plan may deliberately set at odds with `written`.
      filesChanged: plan?.claimFilesChanged ?? written,
      commandsRun: [
        {
          command: "legion-executor",
          args: ["fake", request.mode],
          exitCode: 0
        }
      ],
      findings: [],
      ...(request.mode === "review"
        ? {
            reviewVerdicts: {
              specification: "pass",
              integration: "pass",
              evidence: "pass"
            }
          }
        : {})
    };
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.rawLogArtifactPath, text: `${result.summary}\n` });
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.redactedLogArtifactPath, text: redactTranscript(`${result.summary}\n`) });
    await writeProjectExecutionResult({ repositoryRoot: request.repositoryRoot, artifactPath: request.resultArtifactPath, result });
    return result;
  }
};

const manualAdapter: ExecutionAdapter = {
  kind: "manual",
  async run(request) {
    const summary = `Manual executor prepared ${request.mode} instructions at ${request.promptArtifactPath}.`;
    const result: ExecutionResult = {
      ok: false,
      status: "blocked",
      summary,
      filesChanged: [],
      commandsRun: [
        {
          command: "legion-executor",
          args: ["manual", request.mode],
          exitCode: 1
        }
      ],
      findings: [
        {
          id: "manual-execution-required",
          title: "Manual execution required",
          body: "No executable adapter was selected. Review the prompt and run the requested work manually, then rerun the command with an executor.",
          severity: "blocking"
        }
      ]
    };
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.rawLogArtifactPath, text: `${summary}\n` });
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.redactedLogArtifactPath, text: `${summary}\n` });
    await writeProjectExecutionResult({ repositoryRoot: request.repositoryRoot, artifactPath: request.resultArtifactPath, result });
    return result;
  }
};

const claudeAdapter: ExecutionAdapter = {
  kind: "claude",
  async run(request) {
    const args = claudeExecArgs({ readOnly: request.readOnly });
    const invocation = claudeInvocation(args);
    const processResult = await spawnWithInput(
      invocation.command,
      invocation.args,
      request.prompt,
      request.repositoryRoot,
      claudeExecTimeoutMs()
    );
    const rawOutput = [
      processResult.stdout,
      processResult.stderr
    ].filter((entry) => entry.length > 0).join("\n");

    // `--output-format json` wraps the run: the model's final message is the
    // `result` field, and the envelope around it carries the run's own verdict.
    // Parsing the contract reply out of the whole transcript would find log
    // noise, which is the mistake `structuredOutput` exists to avoid.
    const envelope = parseClaudeEnvelope(processResult.stdout);
    const lastMessage = envelope?.result ?? "";
    const parsed = parseResultFromText(lastMessage.length > 0 ? lastMessage : rawOutput);

    // Three ways this run did not do what was asked, and they are not the same
    // fact: the process died, the harness reported its own error, or the model
    // stopped early. `is_error` is the envelope's own verdict and outranks a
    // zero exit code -- claude exits 0 on an API error it reports in-band.
    const status: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0 || envelope?.isError === true
        ? "failed"
        : "succeeded";

    const normalized = normalizeExecutionResult(parsed, {
      status,
      summary: claudeFallbackSummary(processResult, envelope),
      rawOutput,
      exitCode: processResult.exitCode
    });
    const withStructured: ExecutionResult = lastMessage.length > 0
      ? { ...normalized, structuredOutput: lastMessage }
      : normalized;

    const blockingFindings: ExecutionFinding[] = [];
    if (processResult.timedOut) {
      blockingFindings.push({
        id: "claude-executor-timeout",
        title: "Claude executor timed out",
        body: `Claude did not complete within ${processResult.timeoutMs}ms. Check Claude Code auth/configuration, raise LEGION_CLAUDE_EXEC_TIMEOUT_MS, or rerun with the manual executor.`,
        severity: "blocking"
      });
    }
    // A denied permission is why a task can report success having done nothing,
    // so it is recorded as a finding rather than left in the transcript for a
    // human to notice.
    if (envelope !== undefined && envelope.permissionDenials.length > 0) {
      blockingFindings.push({
        id: "claude-executor-permission-denied",
        title: "Claude executor was denied a tool it asked for",
        body: `Denied: ${envelope.permissionDenials.join(", ")}. The run may be incomplete even where it reports success.`,
        severity: "blocking"
      });
    }

    const result: ExecutionResult = blockingFindings.length === 0
      ? withStructured
      : {
          ...withStructured,
          ok: false,
          status: processResult.timedOut ? "blocked" : "failed",
          findings: [...withStructured.findings, ...blockingFindings]
        };

    const redacted = redactTranscript(rawOutput);
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.rawLogArtifactPath, text: rawOutput.length > 0 ? rawOutput : `${result.summary}\n` });
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.redactedLogArtifactPath, text: redacted.length > 0 ? redacted : `${result.summary}\n` });
    await writeProjectExecutionResult({ repositoryRoot: request.repositoryRoot, artifactPath: request.resultArtifactPath, result });
    return result;
  }
};

interface ClaudeEnvelope {
  readonly isError: boolean;
  readonly result: string;
  readonly apiErrorStatus: string | undefined;
  readonly permissionDenials: readonly string[];
}

function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "result") return undefined;
  const denials = Array.isArray(record["permission_denials"])
    ? record["permission_denials"].map(claudeDenialLabel).filter((entry): entry is string => entry !== undefined)
    : [];
  return {
    isError: record["is_error"] === true,
    result: typeof record["result"] === "string" ? record["result"] : "",
    apiErrorStatus: typeof record["api_error_status"] === "string" ? record["api_error_status"] : undefined,
    permissionDenials: denials
  };
}

function claudeDenialLabel(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const name = (entry as Record<string, unknown>)["tool_name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function claudeFallbackSummary(
  processResult: { readonly timedOut: boolean; readonly exitCode: number; readonly timeoutMs: number },
  envelope: ClaudeEnvelope | undefined
): string {
  if (processResult.timedOut) return `Claude executor timed out after ${processResult.timeoutMs}ms.`;
  if (envelope?.apiErrorStatus !== undefined) return `Claude executor failed with API status ${envelope.apiErrorStatus}.`;
  if (envelope?.isError === true) return "Claude executor reported an error.";
  return processResult.exitCode === 0 ? "Claude executor completed." : "Claude executor failed.";
}

const codexAdapter: ExecutionAdapter = {
  kind: "codex",
  async run(request) {
    const outputLastMessageArtifactPath = artifactPathSchema.parse(request.resultArtifactPath.replace(/executor-result\.json$/u, "executor-last-message.txt"));
    const outputLastMessagePath = await prepareProjectTextFile({
      repositoryRoot: request.repositoryRoot,
      artifactPath: outputLastMessageArtifactPath
    });
    const args = codexExecArgs({
      repositoryRoot: request.repositoryRoot,
      sandbox: request.readOnly ? "read-only" : "workspace-write",
      outputLastMessagePath
    });
    const invocation = codexInvocation(args);
    const processResult = await spawnWithInput(
      invocation.command,
      invocation.args,
      request.prompt,
      request.repositoryRoot,
      codexExecTimeoutMs()
    );
    const rawOutput = [
      processResult.stdout,
      processResult.stderr
    ].filter((entry) => entry.length > 0).join("\n");
    const lastMessage = await readOptionalText(outputLastMessagePath);
    const parsed = parseResultFromText(lastMessage.length > 0 ? lastMessage : rawOutput);
    const status = processResult.timedOut ? "blocked" : processResult.exitCode === 0 ? "succeeded" : "failed";
    const normalized = normalizeExecutionResult(parsed, {
      status,
      summary: processResult.timedOut
        ? `Codex executor timed out after ${processResult.timeoutMs}ms.`
        : processResult.exitCode === 0 ? "Codex executor completed." : "Codex executor failed.",
      rawOutput,
      exitCode: processResult.exitCode
    });
    // Kept separate from rawOutput, which is process output. Downstream typed
    // parsing needs the reply the contract asked for, not the log around it.
    const withStructured: ExecutionResult = lastMessage.length > 0
      ? { ...normalized, structuredOutput: lastMessage }
      : normalized;
    const result: ExecutionResult = processResult.timedOut
      ? {
          ...withStructured,
          ok: false,
          status: "blocked",
          findings: [
            ...normalized.findings,
            {
              id: "codex-executor-timeout",
              title: "Codex executor timed out",
              body: `Codex did not complete within ${processResult.timeoutMs}ms. Check Codex auth/configuration or rerun with the manual executor.`,
              severity: "blocking"
            }
          ]
        }
      : withStructured;
    const redacted = redactTranscript(rawOutput);
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.rawLogArtifactPath, text: rawOutput.length > 0 ? rawOutput : `${result.summary}\n` });
    await writeProjectTextFile({ repositoryRoot: request.repositoryRoot, artifactPath: request.redactedLogArtifactPath, text: redacted.length > 0 ? redacted : `${result.summary}\n` });
    await writeProjectExecutionResult({ repositoryRoot: request.repositoryRoot, artifactPath: request.resultArtifactPath, result });
    return result;
  }
};

function codexInvocation(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") {
    return { command: "codex", args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex", ...args]
  };
}

function claudeInvocation(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") {
    return { command: "claude", args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "claude", ...args]
  };
}

function fakeSummary(request: ExecutionRequest): string {
  if (request.mode === "review") return `Fake review passed for ${request.task.id}.`;
  if (request.mode === "fix") return `Fake fix cycle completed for ${request.task.id}.`;
  return `Fake build executed ${request.task.id}.`;
}

function codexExecTimeoutMs(): number {
  const configured = process.env["LEGION_CODEX_EXEC_TIMEOUT_MS"];
  if (configured === undefined) return DEFAULT_CODEX_EXEC_TIMEOUT_MS;
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_EXEC_TIMEOUT_MS;
}

// Longer than codex's default: a task contract that builds and verifies is one
// agentic session here, not one completion, and 5 minutes truncates real work.
function claudeExecTimeoutMs(): number {
  const configured = process.env["LEGION_CLAUDE_EXEC_TIMEOUT_MS"];
  if (configured === undefined) return DEFAULT_CLAUDE_EXEC_TIMEOUT_MS;
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAUDE_EXEC_TIMEOUT_MS;
}

async function spawnWithInput(command: string, args: readonly string[], input: string, cwd: string, timeoutMs: number): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        timeoutMs
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `${stderr.length === 0 ? "" : "\n"}Codex executor timed out after ${timeoutMs}ms.`;
      terminateProcessTree(child.pid);
      setTimeout(() => settle(124), 1_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      settle(timedOut ? 124 : code ?? 1);
    });
    child.stdin.end(input);
  });
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
    // The process may have exited just before the timeout handler ran.
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }, 1_000).unref();
}
