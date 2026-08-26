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
  writeProjectExecutionResult,
  writeProjectTextFile
} from "./result.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_CLAUDE_EXEC_TIMEOUT_MS = 900_000;
const DEFAULT_HERMES_EXEC_TIMEOUT_MS = 600_000;
const DEFAULT_GROK_EXEC_TIMEOUT_MS = 600_000;
const GROK_VERSION_RE = /^grok\s+(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\s+\([0-9A-Za-z-]+\))?(?:\s+\[[A-Za-z0-9.-]+\])?\s*$/u;
const SECRET_ASSIGNMENT_RE =
  /\b(?:api[_-]?key|api[_-]?secret|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|passwd|pwd|token|secret)\b\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/giu;
const JSON_CREDENTIAL_RE =
  /["'](?:api[_-]?key|api[_-]?secret|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|passwd|pwd|token|secret)["']\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s}]+)/giu;
// Treat every URI with an authority as sensitive. This deliberately uses an
// opaque replacement rather than trying to preserve a public URL while
// accidentally leaking userinfo, query, or fragment credentials.
const URL_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`]+/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu;
const TOKEN_RE = /\b(?:sk|ghp|gho|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ENCODED_SEGMENT_RE = /[^\s]*%[0-9a-f]{2}[^\s]*/giu;
const MAX_REDACTION_DECODE_PASSES = 16;
const MAX_REDACTION_DECODE_LENGTH = 64 * 1024;

function decodeRepeatedly(value: string): string {
  if (value.length > MAX_REDACTION_DECODE_LENGTH) return value;
  let decoded = value;
  for (let attempt = 0; attempt < MAX_REDACTION_DECODE_PASSES; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded || next.length > MAX_REDACTION_DECODE_LENGTH) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function redactDirectText(value: string): string {
  return value
    .replace(CONTROL_RE, "�")
    .replace(URL_RE, "[REDACTED_URL]")
    .replace(JSON_CREDENTIAL_RE, "[REDACTED_JSON_SECRET]")
    .replace(BEARER_RE, "Bearer [REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT_RE, "[REDACTED_SECRET]")
    .replace(TOKEN_RE, "[REDACTED_TOKEN]");
}

export function redactAdapterTranscript(text: string): string {
  const direct = redactDirectText(text);
  return direct.replace(ENCODED_SEGMENT_RE, (match) => {
    if (!match.includes("%")) return match;
    if (match.length > MAX_REDACTION_DECODE_LENGTH) return "[REDACTED_ENCODED_SECRET]";
    const decoded = decodeRepeatedly(match);
    return decoded !== match && redactDirectText(decoded) !== decoded
      ? "[REDACTED_ENCODED_SECRET]"
      : match;
  });
}

// Claude Code has no OS-level sandbox flag, so a read-only run is enforced by
// denying every tool that can mutate the repository. The guarded execution
// harness is the second line of defense for a tool that still writes despite
// this list, but leaving Bash enabled would make the adapter's read-only claim
// false by construction.
const CLAUDE_READ_ONLY_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"] as const;

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

/**
 * Grok Build's headless JSON surface takes the prompt from a file. Keep the
 * path as one argv entry so quotes, shell metacharacters, and newlines in an
 * artifact path are never interpreted by a shell.
 */
export function grokExecArgs(input: {
  readonly repositoryRoot: string;
  readonly prompt: string;
  readonly readOnly?: boolean;
}): readonly string[] {
  return [
    "--prompt-file",
    input.prompt,
    "--cwd",
    input.repositoryRoot,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    ...(input.readOnly ? ["--sandbox", "read-only"] : [])
  ];
}

export async function selectExecutionAdapterKind(explicit: string | undefined): Promise<ExecutionAdapterKind | {
  readonly ok: false;
  readonly diagnostic: { readonly code: string; readonly message: string };
}> {
  if (explicit !== undefined) {
    if (explicit === "claude" || explicit === "codex" || explicit === "hermes" || explicit === "grok" || explicit === "manual" || explicit === "fake") return explicit;
    return {
      ok: false,
      diagnostic: {
        code: "invalid_executor",
        message: `Unsupported executor "${explicit}". Use claude, codex, hermes, grok, manual, or fake.`
      }
    };
  }
  // Probed in order, and the order is the claim: whichever driver is installed
  // runs the work, and `manual` is what "no driver is installed" looks like
  // rather than a silent no-op.
  if (!runningInsideClaudeCode() && await claudeAvailable()) return "claude";
  if (await codexAvailable()) return "codex";
  if (await hermesAvailable()) return "hermes";
  if (!runningInsideGrokBuild() && await grokAvailable()) return "grok";
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

function runningInsideGrokBuild(): boolean {
  return activeSessionMarker(process.env["GROK_AGENT"]) || activeSessionMarker(process.env["GROK_SESSION_ID"]);
}

function activeSessionMarker(marker: string | undefined): boolean {
  if (marker === undefined) return false;
  const normalized = marker.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function adapterForKind(kind: ExecutionAdapterKind): ExecutionAdapter {
  switch (kind) {
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter;
    case "hermes":
      return hermesAdapter;
    case "grok":
      return grokAdapter;
    case "manual":
      return manualAdapter;
    case "fake":
      return fakeAdapter;
  }
}

function artifactRepositoryRoot(request: ExecutionRequest): string {
  return request.artifactRepositoryRoot ?? request.repositoryRoot;
}

function isolatedArtifactText(request: ExecutionRequest, text: string): string {
  return request.artifactRepositoryRoot === undefined ? text : redactAdapterTranscript(text);
}

function isolatedExecutionResult(request: ExecutionRequest, result: ExecutionResult): ExecutionResult {
  if (request.artifactRepositoryRoot === undefined) return result;
  return {
    ...(result.structuredOutput === undefined ? {} : { structuredOutput: redactAdapterTranscript(result.structuredOutput) }),
    ok: result.ok,
    status: result.status,
    summary: redactAdapterTranscript(result.summary),
    filesChanged: result.filesChanged.map((entry) => redactAdapterTranscript(entry)),
    commandsRun: result.commandsRun.map((entry) => ({
      command: redactAdapterTranscript(entry.command),
      args: entry.args.map((arg) => redactAdapterTranscript(arg)),
      exitCode: entry.exitCode
    })),
    findings: result.findings.map((entry) => ({
      id: redactAdapterTranscript(entry.id),
      title: redactAdapterTranscript(entry.title),
      body: redactAdapterTranscript(entry.body),
      severity: entry.severity,
      ...(entry.evidenceRefs === undefined ? {} : { evidenceRefs: entry.evidenceRefs.map((ref) => redactAdapterTranscript(ref)) })
    })),
    ...(result.reviewVerdicts === undefined ? {} : { reviewVerdicts: result.reviewVerdicts }),
    ...(result.rawOutput === undefined ? {} : { rawOutput: redactAdapterTranscript(result.rawOutput) }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
  };
}

async function persistExecutionResult(request: ExecutionRequest, result: ExecutionResult): Promise<void> {
  await writeProjectExecutionResult({
    repositoryRoot: artifactRepositoryRoot(request),
    artifactPath: request.resultArtifactPath,
    result: isolatedExecutionResult(request, result)
  });
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

async function hermesAvailable(): Promise<boolean> {
  try {
    const invocation = hermesInvocation(["--version"]);
    await execFileAsync(invocation.command, invocation.args, {
      timeout: 5_000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

export async function grokAvailable(): Promise<boolean> {
  try {
    const invocation = grokInvocation(["--version"]);
    const result = await execFileAsync(invocation.command, invocation.args, {
      timeout: 5_000,
      windowsHide: true
    });
    const versionOutput = [String(result.stdout), String(result.stderr)].join("\n");
    return GROK_VERSION_RE.test(versionOutput);
  } catch {
    return false;
  }
}

function hermesInvocation(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") {
    return { command: "hermes", args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "hermes", ...args]
  };
}

function grokInvocation(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") {
    return { command: "grok", args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "grok", ...args]
  };
}

function hermesExecTimeoutMs(): number {
  const configured = process.env["LEGION_HERMES_EXEC_TIMEOUT_MS"];
  if (configured === undefined) return DEFAULT_HERMES_EXEC_TIMEOUT_MS;
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HERMES_EXEC_TIMEOUT_MS;
}

function grokExecTimeoutMs(): number {
  const configured = process.env["LEGION_GROK_EXEC_TIMEOUT_MS"];
  if (configured === undefined) return DEFAULT_GROK_EXEC_TIMEOUT_MS;
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GROK_EXEC_TIMEOUT_MS;
}

export function hermesReadOnlyBlockedResult(): ExecutionResult {
  return {
    ok: false,
    status: "blocked",
    summary: "Hermes Agent cannot guarantee read-only execution for this specialist request.",
    filesChanged: [],
    commandsRun: [],
    findings: [{
      id: "hermes-read-only-unsupported",
      title: "Hermes read-only execution is unavailable",
      body: "The Hermes adapter has no platform-enforced read-only mode for this request. The specialist is blocked rather than being run with prompt-only safety claims.",
      severity: "blocking"
    }]
  };
}

const hermesAdapter: ExecutionAdapter = {
  kind: "hermes",
  async run(request) {
    if (request.readOnly) {
      const result = hermesReadOnlyBlockedResult();
      const artifactRoot = artifactRepositoryRoot(request);
      await writeProjectTextFile({ repositoryRoot: artifactRoot, artifactPath: request.redactedLogArtifactPath, text: `${result.summary}\n` });
      await persistExecutionResult(request, result);
      return result;
    }
    // hermes chat -q takes the query as an argv argument (no stdin support).
    // The prompt is a task description, not a secret — argv exposure via `ps`
    // is acceptable here, matching how claude passes --print prompts.
    const args = ["chat", "-q", request.prompt, "--source", "legion", "-Q", "--in", request.repositoryRoot];
    const invocation = hermesInvocation(args);
    const processResult = await spawnWithInput(
      invocation.command,
      invocation.args,
      "",  // stdin unused — hermes reads from -q arg
      request.repositoryRoot,
      hermesExecTimeoutMs(),
      "Hermes Agent"
    );
    const rawOutput = [
      processResult.stdout,
      processResult.stderr
    ].filter((entry) => entry.length > 0).join("\n");
    const parsed = parseResultFromText(rawOutput);
    const status: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0
        ? "failed"
        : "succeeded";
    const normalized = normalizeExecutionResult(parsed, {
      status,
      summary: processResult.exitCode === 0
        ? "Hermes Agent executor completed."
        : "Hermes Agent executor failed.",
      rawOutput,
      exitCode: processResult.exitCode
    });
    const hermesOutput = hermesStructuredOutput(parsed);
    const withStructured: ExecutionResult = hermesOutput === undefined
      ? normalized
      : { ...normalized, structuredOutput: hermesOutput };
    const blockingFindings: ExecutionFinding[] = [];
    if (processResult.timedOut) {
      blockingFindings.push({
        id: "hermes-executor-timeout",
        title: "Hermes executor timed out",
        body: `Hermes did not complete within ${processResult.timeoutMs}ms. Check Hermes auth/configuration, raise LEGION_HERMES_EXEC_TIMEOUT_MS, or rerun with the manual executor.`,
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
    const redacted = redactAdapterTranscript(rawOutput);
    const artifactRoot = artifactRepositoryRoot(request);
    await writeProjectTextFile({ repositoryRoot: artifactRoot, artifactPath: request.rawLogArtifactPath, text: isolatedArtifactText(request, redacted.length > 0 ? redacted : `${result.summary}\n`) });
    await writeProjectTextFile({ repositoryRoot: artifactRoot, artifactPath: request.redactedLogArtifactPath, text: isolatedArtifactText(request, redacted.length > 0 ? redacted : `${result.summary}\n`) });
    await persistExecutionResult(request, result);
    return result;
  }
};

interface GrokEnvelopeSuccess {
  readonly ok: true;
  readonly text: string;
  readonly result: Record<string, unknown>;
}

interface GrokEnvelopeFailure {
  readonly ok: false;
  readonly message: string;
}

const grokAdapter: ExecutionAdapter = {
  kind: "grok",
  async run(request) {
    const timeoutMs = grokExecTimeoutMs();
    const args = grokExecArgs({
      repositoryRoot: request.repositoryRoot,
      prompt: request.promptAbsolutePath,
      readOnly: request.readOnly
    });
    const invocation = grokInvocation(args);
    let processResult: Awaited<ReturnType<typeof spawnWithoutInput>>;
    try {
      processResult = await spawnWithoutInput(
        invocation.command,
        invocation.args,
        request.repositoryRoot,
        timeoutMs
      );
    } catch {
      // An explicitly selected but missing executable is a failed execution,
      // not a thrown adapter error that would discard the task-run artifacts.
      processResult = {
        exitCode: 127,
        stdout: "",
        stderr: "Grok Build executable could not be started.",
        timedOut: false,
        timeoutMs
      };
    }

    const rawOutput = [processResult.stdout, processResult.stderr]
      .filter((entry) => entry.length > 0)
      .join("\n");
    const envelope = parseGrokEnvelope(processResult.stdout);
    const processStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0
        ? "failed"
        : envelope.ok
          ? "succeeded"
          : "failed";
    const parsed = envelope.ok ? envelope.result : undefined;
    const normalized = normalizeExecutionResult(parsed, {
      status: processStatus,
      summary: processResult.timedOut
        ? `Grok Build executor timed out after ${timeoutMs}ms.`
        : processResult.exitCode !== 0
          ? "Grok Build executor failed."
          : envelope.ok
            ? "Grok Build executor completed."
            : "Grok Build executor returned an invalid result envelope.",
      rawOutput,
      exitCode: processResult.exitCode
    });
    // Process status outranks model-reported status. A nonzero child cannot
    // become a success merely because its last JSON body said `succeeded`.
    const resultStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0 || !envelope.ok
        ? "failed"
        : normalized.status;
    const findings: ExecutionFinding[] = [];
    if (!envelope.ok) {
      findings.push({
        id: "grok-executor-invalid-output",
        title: "Grok Build returned an invalid result",
        body: envelope.message,
        severity: "blocking"
      });
    }
    if (processResult.timedOut) {
      findings.push({
        id: "grok-executor-timeout",
        title: "Grok Build executor timed out",
        body: `Grok Build did not complete within ${timeoutMs}ms. Check Grok auth/configuration, raise LEGION_GROK_EXEC_TIMEOUT_MS, or rerun with the manual executor.`,
        severity: "blocking"
      });
    } else if (processResult.exitCode !== 0) {
      findings.push({
        id: "grok-executor-failed",
        title: "Grok Build executor exited unsuccessfully",
        body: `Grok Build exited with code ${processResult.exitCode}. Check the raw and redacted executor logs before retrying.`,
        severity: "blocking"
      });
    }
    const withEnvelope: ExecutionResult = envelope.ok
      ? { ...normalized, structuredOutput: envelope.text }
      : normalized;
    const result: ExecutionResult = {
      ...withEnvelope,
      ok: resultStatus === "succeeded",
      status: resultStatus,
      findings: [...withEnvelope.findings, ...findings]
    };

    const redacted = redactAdapterTranscript(rawOutput);
    await writeProjectTextFile({
      repositoryRoot: artifactRepositoryRoot(request),
      artifactPath: request.rawLogArtifactPath,
      text: isolatedArtifactText(request, rawOutput.length > 0 ? rawOutput : `${result.summary}\n`)
    });
    await writeProjectTextFile({
      repositoryRoot: artifactRepositoryRoot(request),
      artifactPath: request.redactedLogArtifactPath,
      text: isolatedArtifactText(request, redacted.length > 0 ? redacted : `${result.summary}\n`)
    });
    await persistExecutionResult(request, result);
    return result;
  }
};

function parseGrokEnvelope(stdout: string): GrokEnvelopeSuccess | GrokEnvelopeFailure {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false, message: "Grok Build produced no JSON output." };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Grok Build output was not one complete JSON envelope." };
  }
  if (!isRecordValue(value)) return { ok: false, message: "Grok Build output was not a JSON object envelope." };
  if (value["type"] === "error") return { ok: false, message: "Grok Build reported an error envelope." };
  const text = value["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, message: "Grok Build result envelope is missing non-empty text." };
  }
  if (typeof value["stopReason"] !== "string" || value["stopReason"].length === 0) {
    return { ok: false, message: "Grok Build result envelope is missing stopReason." };
  }
  if (typeof value["sessionId"] !== "string" || value["sessionId"].length === 0) {
    return { ok: false, message: "Grok Build result envelope is missing sessionId." };
  }
  if (typeof value["requestId"] !== "string" || value["requestId"].length === 0) {
    return { ok: false, message: "Grok Build result envelope is missing requestId." };
  }

  let result: unknown;
  try {
    // Parse only the envelope's text field. In particular, do not use the
    // permissive transcript extractor here: ACP streaming-json is NDJSON and
    // must never be mistaken for one completed ExecutionResult.
    result = JSON.parse(text.trim());
  } catch {
    return { ok: false, message: "Grok Build envelope text was not one complete JSON result." };
  }
  if (!isCompleteGrokResult(result)) {
    return { ok: false, message: "Grok Build envelope text was an incomplete ExecutionResult." };
  }
  return { ok: true, text, result };
}

function isCompleteGrokResult(value: unknown): value is Record<string, unknown> {
  if (!isRecordValue(value)) return false;
  return (
    (value["status"] === "succeeded" || value["status"] === "failed" || value["status"] === "blocked") &&
    typeof value["summary"] === "string" &&
    value["summary"].length > 0 &&
    Array.isArray(value["filesChanged"]) &&
    Array.isArray(value["commandsRun"]) &&
    Array.isArray(value["findings"])
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hermesStructuredOutput(value: unknown): string | undefined {
  if (!isRecordValue(value)) return undefined;
  for (const key of ["structuredOutput", "output", "text", "result"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && parseResultFromText(candidate) !== undefined) return candidate;
    if (isRecordValue(candidate) || Array.isArray(candidate)) {
      const serialized = JSON.stringify(candidate);
      if (serialized !== undefined) return serialized;
    }
  }
  if (Array.isArray(value["findings"]) && Array.isArray(value["assumptions"])) return JSON.stringify(value);
  return undefined;
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
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.rawLogArtifactPath, text: isolatedArtifactText(request, `${result.summary}\n`) });
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.redactedLogArtifactPath, text: isolatedArtifactText(request, `${result.summary}\n`) });
    await persistExecutionResult(request, result);
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
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.rawLogArtifactPath, text: isolatedArtifactText(request, `${summary}\n`) });
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.redactedLogArtifactPath, text: isolatedArtifactText(request, `${summary}\n`) });
    await persistExecutionResult(request, result);
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
      claudeExecTimeoutMs(),
      "Claude"
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
    const processStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0 || envelope?.isError === true
        ? "failed"
        : "succeeded";

    const normalized = normalizeExecutionResult(parsed, {
      status: processStatus,
      summary: claudeFallbackSummary(processResult, envelope),
      rawOutput,
      exitCode: processResult.exitCode
    });
    const resultStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0 || envelope?.isError === true
        ? "failed"
        : normalized.status;
    const withStructured: ExecutionResult = lastMessage.length > 0 && resultStatus === "succeeded"
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
    } else if (processResult.exitCode !== 0) {
      blockingFindings.push({
        id: "claude-executor-failed",
        title: "Claude executor exited unsuccessfully",
        body: `Claude exited with code ${processResult.exitCode}. Check the raw and redacted executor logs before retrying.`,
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

    const result: ExecutionResult = {
      ...withStructured,
      ok: resultStatus === "succeeded" && blockingFindings.length === 0,
      status: blockingFindings.length === 0 ? resultStatus : processResult.timedOut ? "blocked" : "failed",
      findings: [...withStructured.findings, ...blockingFindings]
    };

    const redacted = redactAdapterTranscript(rawOutput);
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.rawLogArtifactPath, text: isolatedArtifactText(request, rawOutput.length > 0 ? rawOutput : `${result.summary}\n`) });
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.redactedLogArtifactPath, text: isolatedArtifactText(request, redacted.length > 0 ? redacted : `${result.summary}\n`) });
    await persistExecutionResult(request, result);
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
      repositoryRoot: artifactRepositoryRoot(request),
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
      codexExecTimeoutMs(),
      "Codex"
    );
    const rawOutput = [
      processResult.stdout,
      processResult.stderr
    ].filter((entry) => entry.length > 0).join("\n");
    const lastMessage = await readOptionalText(outputLastMessagePath);
    // Codex writes this file itself. Scrub it immediately after reading, before
    // parsing or any later persistence can fail and reach the cleanup fence.
    await writeProjectTextFile({
      repositoryRoot: artifactRepositoryRoot(request),
      artifactPath: outputLastMessageArtifactPath,
      text: lastMessage.length > 0 ? redactAdapterTranscript(lastMessage) : ""
    });
    const parsed = parseResultFromText(lastMessage.length > 0 ? lastMessage : rawOutput);
    const processStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode === 0 ? "succeeded" : "failed";
    const normalized = normalizeExecutionResult(parsed, {
      status: processStatus,
      summary: processResult.timedOut
        ? `Codex executor timed out after ${processResult.timeoutMs}ms.`
        : processResult.exitCode === 0 ? "Codex executor completed." : "Codex executor failed.",
      rawOutput,
      exitCode: processResult.exitCode
    });
    const resultStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : processResult.exitCode !== 0
        ? "failed"
        : normalized.status;
    // Kept separate from rawOutput, which is process output. Downstream typed
    // parsing needs the reply the contract asked for, not the log around it.
    // Never claim a structured reply after a failed child process.
    const withStructured: ExecutionResult = lastMessage.length > 0 && resultStatus === "succeeded"
      ? { ...normalized, structuredOutput: lastMessage }
      : normalized;
    const blockingFindings: ExecutionFinding[] = [];
    if (processResult.timedOut) {
      blockingFindings.push({
        id: "codex-executor-timeout",
        title: "Codex executor timed out",
        body: `Codex did not complete within ${processResult.timeoutMs}ms. Check Codex auth/configuration or rerun with the manual executor.`,
        severity: "blocking"
      });
    } else if (processResult.exitCode !== 0) {
      blockingFindings.push({
        id: "codex-executor-failed",
        title: "Codex executor exited unsuccessfully",
        body: `Codex exited with code ${processResult.exitCode}. Check the raw and redacted executor logs before retrying.`,
        severity: "blocking"
      });
    }
    const result: ExecutionResult = {
      ...withStructured,
      ok: resultStatus === "succeeded" && blockingFindings.length === 0,
      status: blockingFindings.length === 0 ? resultStatus : processResult.timedOut ? "blocked" : "failed",
      findings: [...withStructured.findings, ...blockingFindings]
    };
    const redacted = redactAdapterTranscript(rawOutput);
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.rawLogArtifactPath, text: isolatedArtifactText(request, rawOutput.length > 0 ? rawOutput : `${result.summary}\n`) });
    await writeProjectTextFile({ repositoryRoot: artifactRepositoryRoot(request), artifactPath: request.redactedLogArtifactPath, text: isolatedArtifactText(request, redacted.length > 0 ? redacted : `${result.summary}\n`) });
    await persistExecutionResult(request, result);
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

async function spawnWithInput(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  executorLabel: string
): Promise<{
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
      stderr += `${stderr.length === 0 ? "" : "\n"}${executorLabel} executor timed out after ${timeoutMs}ms.`;
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

async function spawnWithoutInput(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{
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
      // Grok consumes the prompt from --prompt-file. `ignore` is deliberate:
      // Legion neither writes a prompt to stdin nor leaves a pipe for a child
      // to mistake for an interactive session.
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr, timedOut, timeoutMs });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `${stderr.length === 0 ? "" : "\n"}Grok Build executor timed out after ${timeoutMs}ms.`;
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
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      settle(timedOut ? 124 : code ?? 1);
    });
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
