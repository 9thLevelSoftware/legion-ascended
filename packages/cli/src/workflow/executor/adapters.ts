import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { ExecutionAdapter, ExecutionAdapterKind, ExecutionRequest, ExecutionResult } from "./types.js";
import {
  normalizeExecutionResult,
  parseResultFromText,
  readOptionalText,
  redactTranscript,
  writeExecutionResult,
  writeTextFile
} from "./result.js";

const execFileAsync = promisify(execFile);

export function codexExecArgs(input: {
  readonly repositoryRoot: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly outputLastMessagePath: string;
}): readonly string[] {
  return [
    "exec",
    "-C",
    input.repositoryRoot,
    "--sandbox",
    input.sandbox,
    "--ask-for-approval",
    "never",
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
    await execFileAsync("codex", ["exec", "--help"], {
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
    await writeTextFile(request.rawLogAbsolutePath, `${result.summary}\n`);
    await writeTextFile(request.redactedLogAbsolutePath, redactTranscript(`${result.summary}\n`));
    await writeExecutionResult(request.resultAbsolutePath, result);
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
    await writeTextFile(request.rawLogAbsolutePath, `${summary}\n`);
    await writeTextFile(request.redactedLogAbsolutePath, `${summary}\n`);
    await writeExecutionResult(request.resultAbsolutePath, result);
    return result;
  }
};

const codexAdapter: ExecutionAdapter = {
  kind: "codex",
  async run(request) {
    const outputLastMessagePath = request.resultAbsolutePath.replace(/\.json$/u, "-last-message.txt");
    const args = codexExecArgs({
      repositoryRoot: request.repositoryRoot,
      sandbox: request.readOnly ? "read-only" : "workspace-write",
      outputLastMessagePath
    });
    const processResult = await spawnWithInput("codex", args, request.prompt, request.repositoryRoot);
    const rawOutput = [
      processResult.stdout,
      processResult.stderr
    ].filter((entry) => entry.length > 0).join("\n");
    const lastMessage = await readOptionalText(outputLastMessagePath);
    const parsed = parseResultFromText(lastMessage.length > 0 ? lastMessage : rawOutput);
    const status = processResult.exitCode === 0 ? "succeeded" : "failed";
    const result = normalizeExecutionResult(parsed, {
      status,
      summary: processResult.exitCode === 0 ? "Codex executor completed." : "Codex executor failed.",
      rawOutput,
      exitCode: processResult.exitCode
    });
    const redacted = redactTranscript(rawOutput);
    await writeTextFile(request.rawLogAbsolutePath, rawOutput.length > 0 ? rawOutput : `${result.summary}\n`);
    await writeTextFile(request.redactedLogAbsolutePath, redacted.length > 0 ? redacted : `${result.summary}\n`);
    await writeExecutionResult(request.resultAbsolutePath, result);
    return result;
  }
};

function fakeSummary(request: ExecutionRequest): string {
  if (request.mode === "review") return `Fake review passed for ${request.task.id}.`;
  if (request.mode === "fix") return `Fake fix cycle completed for ${request.task.id}.`;
  return `Fake build executed ${request.task.id}.`;
}

async function spawnWithInput(command: string, args: readonly string[], input: string, cwd: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
    child.stdin.end(input);
  });
}
