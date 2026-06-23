import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { artifactPathSchema } from "@legion/protocol";

import type { ExecutionAdapter, ExecutionAdapterKind, ExecutionRequest, ExecutionResult } from "./types.js";
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
    if (explicit === "codex" || explicit === "manual" || explicit === "fake") return explicit;
    return {
      ok: false,
      diagnostic: {
        code: "invalid_executor",
        message: `Unsupported executor "${explicit}". Use codex, manual, or fake.`
      }
    };
  }
  return await codexAvailable() ? "codex" : "manual";
}

export function adapterForKind(kind: ExecutionAdapterKind): ExecutionAdapter {
  switch (kind) {
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

const fakeAdapter: ExecutionAdapter = {
  kind: "fake",
  async run(request) {
    const result: ExecutionResult = {
      ok: true,
      status: "succeeded",
      summary: fakeSummary(request),
      filesChanged: [],
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
    const result: ExecutionResult = processResult.timedOut
      ? {
          ...normalized,
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
      : normalized;
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
