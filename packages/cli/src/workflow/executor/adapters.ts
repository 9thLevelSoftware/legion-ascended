import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
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
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu;
const TOKEN_RE = /\b(?:sk|ghp|gho|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ENCODED_SEGMENT_RE = /[^\s]*%[0-9a-f]{2}[^\s]*/giu;
const ENCODED_ESCAPE_RE = /%[0-9a-f]{2}/iu;
const MAX_REDACTION_DECODE_PASSES = 16;
const MAX_REDACTION_DECODE_LENGTH = 64 * 1024;
const MAX_REDACTION_INPUT_LENGTH = 1024 * 1024;
const MAX_URL_SCHEME_LENGTH = 1024;
const MAX_URL_LENGTH = 64 * 1024;
export const MAX_ADAPTER_OUTPUT_BYTES = 1 * 1024 * 1024;
const ADAPTER_OUTPUT_TRUNCATION_MARKER = "\n[ADAPTER_OUTPUT_TRUNCATED]";
const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;
const PROCESS_TERM_GRACE_MS = 250;
const PROCESS_QUIESCENCE_TIMEOUT_MS = 5_000;
const PROCESS_QUIESCENCE_POLL_MS = 25;

let adapterProcessContainmentOverride: boolean | undefined;

/** Test-only seam for exercising the unsupported-platform policy. */
export function setAdapterProcessContainmentForTests(available: boolean | undefined): void {
  adapterProcessContainmentOverride = available;
}

function isAsciiAlpha(character: string | undefined): boolean {
  return character !== undefined && ((character >= "a" && character <= "z") || (character >= "A" && character <= "Z"));
}

function isAsciiWord(character: string | undefined): boolean {
  return character !== undefined && (
    isAsciiAlpha(character) ||
    (character >= "0" && character <= "9") ||
    character === "_"
  );
}

function isUrlSchemeCharacter(character: string | undefined): boolean {
  return character !== undefined && (
    isAsciiAlpha(character) ||
    (character >= "0" && character <= "9") ||
    character === "+" ||
    character === "-" ||
    character === "."
  );
}

function isUrlTerminator(character: string | undefined): boolean {
  return character === undefined || /[\s<>"'`]/u.test(character);
}

/**
 * Redact URI authorities opaquely without putting an unbounded scheme or URL
 * body in a backtracking regex. The scanner still recognizes over-limit
 * scheme/body lengths and consumes the whole candidate so they fail closed.
 */
function redactUrls(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    const boundary = cursor === 0 || !isAsciiWord(value[cursor - 1]);
    if (isAsciiAlpha(character) && boundary) {
      const schemeScanLimit = Math.min(value.length, cursor + 1 + MAX_URL_SCHEME_LENGTH);
      let schemeEnd = cursor + 1;
      while (schemeEnd < schemeScanLimit && isUrlSchemeCharacter(value[schemeEnd])) schemeEnd += 1;
      if (schemeEnd === schemeScanLimit && isUrlSchemeCharacter(value[schemeEnd])) {
        while (schemeEnd < value.length && isUrlSchemeCharacter(value[schemeEnd])) schemeEnd += 1;
      }
      if (value.slice(schemeEnd, schemeEnd + 3) === "://") {
        let urlEnd = schemeEnd + 3;
        const urlScanLimit = Math.min(value.length, cursor + MAX_URL_LENGTH);
        while (urlEnd < urlScanLimit && !isUrlTerminator(value[urlEnd])) urlEnd += 1;
        if (urlEnd >= urlScanLimit && urlEnd < value.length && !isUrlTerminator(value[urlEnd])) {
          while (urlEnd < value.length && !isUrlTerminator(value[urlEnd])) urlEnd += 1;
        }
        const schemeLength = schemeEnd - cursor;
        const urlLength = urlEnd - cursor;
        if (schemeLength > 0 && urlLength > 3) {
          result += "[REDACTED_URL]";
          cursor = urlEnd;
          continue;
        }
      }
    }
    result += character;
    cursor += 1;
  }
  return result;
}

function decodeRepeatedly(value: string): { readonly decoded: string; readonly exhausted: boolean } {
  if (value.length > MAX_REDACTION_DECODE_LENGTH) return { decoded: value, exhausted: true };
  let decoded = value;
  for (let attempt = 0; attempt < MAX_REDACTION_DECODE_PASSES; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return { decoded, exhausted: false };
      if (next.length > MAX_REDACTION_DECODE_LENGTH) return { decoded, exhausted: true };
      decoded = next;
    } catch {
      return { decoded, exhausted: ENCODED_ESCAPE_RE.test(decoded) };
    }
  }
  return { decoded, exhausted: ENCODED_ESCAPE_RE.test(decoded) };
}

const ESCAPED_JSON_PUNCTUATION_RE = /\\+(?=[{}\[\],:"])/gu;

function normalizeEscapedJsonRepresentation(value: string): string {
  // Adapter envelopes and model messages can contain JSON serialized more than
  // once. Remove every escape layer that protects JSON punctuation before the
  // credential scanner runs, without decoding arbitrary backslash escapes.
  return value.replace(ESCAPED_JSON_PUNCTUATION_RE, "");
}

function redactDirectText(value: string): string {
  const normalized = normalizeEscapedJsonRepresentation(value);
  const redacted = redactUrls(normalized
    .replace(CONTROL_RE, "�")
    .replace(JSON_CREDENTIAL_RE, "[REDACTED_JSON_SECRET]")
    .replace(BEARER_RE, "Bearer [REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT_RE, "[REDACTED_SECRET]")
    .replace(TOKEN_RE, "[REDACTED_TOKEN]"));
  // Preserve non-sensitive escaped text byte-for-byte. A changed normalized
  // form is returned only when redaction or another direct sanitizer did work.
  return redacted === normalized ? value : redacted;
}

export function redactAdapterTranscript(text: string): string {
  if (text.length > MAX_REDACTION_INPUT_LENGTH) return "[REDACTED_TRANSCRIPT]";
  const direct = redactDirectText(text);
  if (!direct.includes("%")) return direct;
  return direct.replace(ENCODED_SEGMENT_RE, (match) => {
    if (!match.includes("%")) return match;
    if (match.length > MAX_REDACTION_DECODE_LENGTH) return "[REDACTED_ENCODED_SECRET]";
    const decodedResult = decodeRepeatedly(match);
    // A bounded decoder must fail closed. Returning a partially decoded value
    // after the budget is exhausted would preserve an opaque credential that
    // can be decoded by the next consumer of the transcript.
    if (decodedResult.exhausted) return "[REDACTED_ENCODED_SECRET]";
    const decoded = decodedResult.decoded;
    return decoded !== match && redactDirectText(decoded) !== decoded
      ? "[REDACTED_ENCODED_SECRET]"
      : match;
  });
}

// Claude Code has no OS-level sandbox flag. These disallowed-tool arguments
// reduce accidental writes, but they are not sufficient containment for
// specialist orchestration because a child can still spawn an uncontained
// descendant. The orchestration boundary must gate this adapter separately.
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

function isolatedArtifactText(_request: ExecutionRequest, text: string): string {
  // Adapter-owned artifacts are persistent outputs even when a caller does not
  // request an isolated root. Never allow the compatibility fallback to write
  // the raw transcript/result bytes.
  return redactAdapterTranscript(text);
}

function isolatedExecutionResult(_request: ExecutionRequest, result: ExecutionResult): ExecutionResult {
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

function processContainmentBlockedResult(kind: Exclude<ExecutionAdapterKind, "fake" | "manual">, label: string): ExecutionResult {
  return {
    ok: false,
    status: "blocked",
    summary: `${label} executor is unavailable because strict process-group containment is unsupported on this platform.`,
    filesChanged: [],
    commandsRun: [],
    findings: [{
      id: `${kind}-process-containment-unavailable`,
      title: `${label} process containment is unavailable`,
      body: `${label} was not spawned because Legion cannot guarantee strict process-group/session containment for external specialist execution on this platform.`,
      severity: "blocking"
    }]
  };
}

async function processContainmentBlockedBeforeSpawn(
  request: ExecutionRequest,
  kind: Exclude<ExecutionAdapterKind, "fake" | "manual">,
  label: string
): Promise<ExecutionResult> {
  const result = processContainmentBlockedResult(kind, label);
  const artifactRoot = artifactRepositoryRoot(request);
  const text = `${result.summary}\n`;
  await writeProjectTextFile({ repositoryRoot: artifactRoot, artifactPath: request.rawLogArtifactPath, text });
  await writeProjectTextFile({ repositoryRoot: artifactRoot, artifactPath: request.redactedLogArtifactPath, text });
  await persistExecutionResult(request, result);
  return result;
}

const hermesAdapter: ExecutionAdapter = {
  kind: "hermes",
  async run(request) {
    if (!supportsIsolatedProcessGroup()) return processContainmentBlockedBeforeSpawn(request, "hermes", "Hermes Agent");
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
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0
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
    const resultStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0
          ? "failed"
          : normalized.status;
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
    } else if (processResult.outputLimitExceeded) {
      blockingFindings.push(outputLimitFinding("Hermes Agent", "hermes-executor-output-limit"));
    }
    if (!processResult.quiescenceProven) {
      blockingFindings.push({
        id: "hermes-executor-process-not-quiescent",
        title: "Hermes executor descendants were not quiescent",
        body: "Hermes exited, but its process group could not be proven quiescent before the result was finalized.",
        severity: "blocking"
      });
    }
    const result: ExecutionResult = {
      ...withStructured,
      ok: resultStatus === "succeeded" && blockingFindings.length === 0,
      status: blockingFindings.length === 0
        ? resultStatus
        : processResult.timedOut || !processResult.quiescenceProven ? "blocked" : "failed",
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
    if (!supportsIsolatedProcessGroup()) return processContainmentBlockedBeforeSpawn(request, "grok", "Grok Build");
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
        outputLimitExceeded: false,
        timeoutMs,
        quiescenceProven: true
      };
    }

    const rawOutput = [processResult.stdout, processResult.stderr]
      .filter((entry) => entry.length > 0)
      .join("\n");
    const envelope = parseGrokEnvelope(processResult.stdout);
    const processStatus: ExecutionStatus = processResult.timedOut
      ? "blocked"
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0
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
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0 || !envelope.ok
          ? "failed"
          : normalized.status;
    const findings: ExecutionFinding[] = [];
    if (processResult.outputLimitExceeded) {
      findings.push(outputLimitFinding("Grok Build", "grok-executor-output-limit"));
    }
    if (!processResult.quiescenceProven) {
      findings.push({
        id: "grok-executor-process-not-quiescent",
        title: "Grok Build descendants were not quiescent",
        body: "Grok Build exited, but its process group could not be proven quiescent before the result was finalized.",
        severity: "blocking"
      });
    }
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
  const discriminator = value["type"];
  if (discriminator === "error") return { ok: false, message: "Grok Build reported an error envelope." };
  if (discriminator !== "result") {
    return { ok: false, message: "Grok Build result envelope has an unknown or missing type discriminator." };
  }
  if (!hasRequiredKeys(value, ["type", "text", "stopReason", "sessionId", "requestId"])) {
    return { ok: false, message: "Grok Build result envelope is missing required core fields." };
  }
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
  return isCompleteExecutionResult(value) || isCompleteSpecialistPayload(value);
}

function isCompleteExecutionResult(value: unknown): value is Record<string, unknown> {
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

function isCompleteSpecialistPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecordValue(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 &&
    keys.every((key) => key === "findings" || key === "assumptions") &&
    (value["findings"] === undefined || Array.isArray(value["findings"])) &&
    (value["assumptions"] === undefined || Array.isArray(value["assumptions"]));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
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
    if (!supportsIsolatedProcessGroup()) return processContainmentBlockedBeforeSpawn(request, "claude", "Claude");
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
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0 || envelope?.isError === true
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
      : !processResult.quiescenceProven
        ? "blocked"
        : processResult.outputLimitExceeded || processResult.exitCode !== 0 || envelope?.isError === true
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
    } else if (processResult.outputLimitExceeded) {
      blockingFindings.push(outputLimitFinding("Claude", "claude-executor-output-limit"));
    } else if (processResult.exitCode !== 0) {
      blockingFindings.push({
        id: "claude-executor-failed",
        title: "Claude executor exited unsuccessfully",
        body: `Claude exited with code ${processResult.exitCode}. Check the raw and redacted executor logs before retrying.`,
        severity: "blocking"
      });
    }
    if (!processResult.quiescenceProven) {
      blockingFindings.push({
        id: "claude-executor-process-not-quiescent",
        title: "Claude executor descendants were not quiescent",
        body: "Claude exited, but its process group could not be proven quiescent before the result was finalized.",
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
      status: blockingFindings.length === 0
        ? resultStatus
        : processResult.timedOut || !processResult.quiescenceProven ? "blocked" : "failed",
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
    if (!supportsIsolatedProcessGroup()) return processContainmentBlockedBeforeSpawn(request, "codex", "Codex");
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
    const lastMessageResult = await readBoundedText(outputLastMessagePath);
    const lastMessage = lastMessageResult.text;
    const outputLimitExceeded = processResult.outputLimitExceeded || lastMessageResult.outputLimitExceeded;
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
      : !processResult.quiescenceProven
        ? "blocked"
        : outputLimitExceeded || processResult.exitCode !== 0 ? "failed" : "succeeded";
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
      : !processResult.quiescenceProven
        ? "blocked"
        : outputLimitExceeded || processResult.exitCode !== 0
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
    } else if (outputLimitExceeded) {
      blockingFindings.push(outputLimitFinding("Codex", "codex-executor-output-limit"));
    } else if (processResult.exitCode !== 0) {
      blockingFindings.push({
        id: "codex-executor-failed",
        title: "Codex executor exited unsuccessfully",
        body: `Codex exited with code ${processResult.exitCode}. Check the raw and redacted executor logs before retrying.`,
        severity: "blocking"
      });
    }
    if (!processResult.quiescenceProven) {
      blockingFindings.push({
        id: "codex-executor-process-not-quiescent",
        title: "Codex executor descendants were not quiescent",
        body: "Codex exited, but its process group could not be proven quiescent before the result was finalized.",
        severity: "blocking"
      });
    }
    const result: ExecutionResult = {
      ...withStructured,
      ok: resultStatus === "succeeded" && blockingFindings.length === 0,
      status: blockingFindings.length === 0
        ? resultStatus
        : processResult.timedOut || !processResult.quiescenceProven ? "blocked" : "failed",
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

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

type OutputStream = "stdout" | "stderr";

class BoundedOutputCapture {
  private stdoutValue = "";
  private stderrValue = "";
  private totalBytes = 0;
  private exceeded = false;

  append(stream: OutputStream, chunk: string | Buffer): void {
    if (this.exceeded) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const remaining = MAX_ADAPTER_OUTPUT_BYTES - this.totalBytes;
    const markerBytes = Buffer.byteLength(ADAPTER_OUTPUT_TRUNCATION_MARKER, "utf8");
    const chunkBytes = Buffer.byteLength(text, "utf8");
    if (chunkBytes <= remaining) {
      this.set(stream, this.get(stream) + text);
      this.totalBytes += chunkBytes;
      return;
    }
    const prefixBudget = Math.max(0, remaining - markerBytes);
    const bounded = `${utf8Prefix(text, prefixBudget)}${remaining >= markerBytes ? ADAPTER_OUTPUT_TRUNCATION_MARKER : ""}`;
    this.set(stream, this.get(stream) + bounded);
    this.totalBytes += Buffer.byteLength(bounded, "utf8");
    this.exceeded = true;
  }

  get stdout(): string {
    return this.stdoutValue;
  }

  get stderr(): string {
    return this.stderrValue;
  }

  get outputLimitExceeded(): boolean {
    return this.exceeded;
  }

  private get(stream: OutputStream): string {
    return stream === "stdout" ? this.stdoutValue : this.stderrValue;
  }

  private set(stream: OutputStream, value: string): void {
    if (stream === "stdout") this.stdoutValue = value;
    else this.stderrValue = value;
  }
}

async function readBoundedText(filePath: string): Promise<{ readonly text: string; readonly outputLimitExceeded: boolean }> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (isRecordValue(error) && error["code"] === "ENOENT") return { text: "", outputLimitExceeded: false };
    throw error;
  }
  const capture = new BoundedOutputCapture();
  const buffer = Buffer.allocUnsafe(BOUNDED_READ_CHUNK_BYTES);
  try {
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      capture.append("stdout", buffer.subarray(0, read.bytesRead));
      if (capture.outputLimitExceeded) break;
    }
    return { text: capture.stdout, outputLimitExceeded: capture.outputLimitExceeded };
  } finally {
    await handle.close();
  }
}

function outputLimitFinding(executorLabel: string, findingId: string): ExecutionFinding {
  return {
    id: findingId,
    title: `${executorLabel} executor output exceeded the bounded capture limit`,
    body: `${executorLabel} output exceeded the ${MAX_ADAPTER_OUTPUT_BYTES}-byte capture limit and the process or payload was rejected before unbounded accumulation.`,
    severity: "blocking"
  };
}

interface SpawnedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly timeoutMs: number;
  readonly quiescenceProven: boolean;
}

async function spawnWithInput(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  executorLabel: string
): Promise<SpawnedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: supportsIsolatedProcessGroup(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output = new BoundedOutputCapture();
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationPending = false;
    let terminationExitCode: number | undefined;
    let terminationPromise: Promise<void> | undefined;
    let spawnError: Error | undefined;
    let quiescenceProven = true;

    const settle = (exitCode: number) => {
      if (settled || terminationPending) return;
      settled = true;
      clearTimeout(timeout);
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      resolve({
        exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        timedOut,
        outputLimitExceeded,
        timeoutMs,
        quiescenceProven
      });
    };

    const requestTermination = (exitCode: number): void => {
      if (terminationExitCode === undefined) terminationExitCode = exitCode;
      if (terminationPromise !== undefined) return;
      terminationPending = true;
      terminationPromise = terminateProcessTree(child.pid).catch(() => false).then((proven) => {
        quiescenceProven = proven;
        terminationPending = false;
        settle(terminationExitCode ?? exitCode);
      });
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      output.append("stderr", `${output.stderr.length === 0 ? "" : "\n"}${executorLabel} executor timed out after ${timeoutMs}ms.`);
      requestTermination(124);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.append("stdout", String(chunk));
      if (output.outputLimitExceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        requestTermination(125);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output.append("stderr", String(chunk));
      if (output.outputLimitExceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        requestTermination(125);
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (settled) return;
      spawnError = error;
      requestTermination(1);
    });
    const settleAfterQuiescence = async (exitCode: number): Promise<void> => {
      if (settled || terminationPending) return;
      if (!supportsIsolatedProcessGroup()) {
        quiescenceProven = false;
      } else if (child.pid !== undefined && processGroupStillExists(child.pid)) {
        // A normal leader exit is not a safe completion boundary when a
        // descendant remains. Kill the entire group before settling so no late
        // write can race repository reconciliation or artifact publication.
        quiescenceProven = false;
        await terminateProcessTree(child.pid).catch(() => false);
      } else {
        quiescenceProven = true;
      }
      settle(exitCode);
    };
    child.on("close", (code) => {
      void settleAfterQuiescence(timedOut ? 124 : outputLimitExceeded ? 125 : code ?? 1);
    });
    child.stdin.end(input);
  });
}

async function spawnWithoutInput(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<SpawnedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: supportsIsolatedProcessGroup(),
      // Grok consumes the prompt from --prompt-file. `ignore` is deliberate:
      // Legion neither writes a prompt to stdin nor leaves a pipe for a child
      // to mistake for an interactive session.
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = new BoundedOutputCapture();
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationPending = false;
    let terminationExitCode: number | undefined;
    let terminationPromise: Promise<void> | undefined;
    let spawnError: Error | undefined;
    let quiescenceProven = true;

    const settle = (exitCode: number) => {
      if (settled || terminationPending) return;
      settled = true;
      clearTimeout(timeout);
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      resolve({
        exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        timedOut,
        outputLimitExceeded,
        timeoutMs,
        quiescenceProven
      });
    };

    const requestTermination = (exitCode: number): void => {
      if (terminationExitCode === undefined) terminationExitCode = exitCode;
      if (terminationPromise !== undefined) return;
      terminationPending = true;
      terminationPromise = terminateProcessTree(child.pid).catch(() => false).then((proven) => {
        quiescenceProven = proven;
        terminationPending = false;
        settle(terminationExitCode ?? exitCode);
      });
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      output.append("stderr", `${output.stderr.length === 0 ? "" : "\n"}Grok Build executor timed out after ${timeoutMs}ms.`);
      requestTermination(124);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.append("stdout", String(chunk));
      if (output.outputLimitExceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        requestTermination(125);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output.append("stderr", String(chunk));
      if (output.outputLimitExceeded && !outputLimitExceeded) {
        outputLimitExceeded = true;
        requestTermination(125);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      spawnError = error;
      requestTermination(1);
    });
    const settleAfterQuiescence = async (exitCode: number): Promise<void> => {
      if (settled || terminationPending) return;
      if (!supportsIsolatedProcessGroup()) {
        quiescenceProven = false;
      } else if (child.pid !== undefined && processGroupStillExists(child.pid)) {
        // A normal leader exit is not a safe completion boundary when a
        // descendant remains. Kill the entire group before settling so no late
        // write can race repository reconciliation or artifact publication.
        quiescenceProven = false;
        await terminateProcessTree(child.pid).catch(() => false);
      } else {
        quiescenceProven = true;
      }
      settle(exitCode);
    };
    child.on("close", (code) => {
      void settleAfterQuiescence(timedOut ? 124 : outputLimitExceeded ? 125 : code ?? 1);
    });
  });
}

function supportsIsolatedProcessGroup(): boolean {
  if (adapterProcessContainmentOverride !== undefined) return adapterProcessContainmentOverride;
  // Node's detached/session semantics used here are POSIX-specific. External
  // adapters are refused before spawn when this guarantee is unavailable.
  return process.platform !== "win32" && process.platform !== "android";
}

function processGroupStillExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitForQuiescence(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROCESS_QUIESCENCE_POLL_MS));
  }
}

async function processQuiescenceProven(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true;
  if (!supportsIsolatedProcessGroup()) return false;
  const stillExists = () => processGroupStillExists(pid);
  await waitForQuiescence(stillExists, PROCESS_QUIESCENCE_TIMEOUT_MS);
  return !stillExists();
}

async function terminateProcessTree(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true;
  if (!supportsIsolatedProcessGroup()) return false;
  if (process.platform === "win32") {
    // Fixed executable and fixed argv: no shell interpolation or user-provided
    // process-kill command is involved. `/t` covers the Windows child tree.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return processQuiescenceProven(pid);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process group may have exited between timeout and termination.
  }
  await waitForQuiescence(() => processGroupStillExists(pid), PROCESS_TERM_GRACE_MS);
  if (processGroupStillExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group may have exited between the probes.
    }
  }
  // Do not let reconciliation run while a descendant remains in the group.
  return processQuiescenceProven(pid);
}
