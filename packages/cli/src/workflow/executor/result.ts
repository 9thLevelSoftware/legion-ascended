import { readFile, writeFile } from "node:fs/promises";

import { ensureProjectArtifactParent, stableProtocolJson } from "@legion/artifacts";
import type { ArtifactPath } from "@legion/protocol";

import type {
  ExecutionCommandResult,
  ExecutionFinding,
  ExecutionResult,
  ExecutionReviewVerdicts,
  ExecutionStatus
} from "./types.js";

const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)\b\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;
const JSON_CREDENTIAL_RE =
  /"(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;

export function redactTranscript(text: string): string {
  return text
    .replace(JSON_CREDENTIAL_RE, (match) => match.replace(/:\s*"(?:[^"\\]|\\.)*"/, ': "[REDACTED_JSON_SECRET]"'))
    .replace(SECRET_ASSIGNMENT_RE, (_match, key: string) => `${key}=[REDACTED_SECRET]`);
}

export async function writeProjectTextFile(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
  readonly text: string;
}): Promise<string> {
  const absolutePath = await prepareProjectTextFile(input);
  await writeFile(absolutePath, input.text, "utf8");
  return absolutePath;
}

export async function prepareProjectTextFile(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
}): Promise<string> {
  const resolved = await ensureProjectArtifactParent({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.artifactPath
  });
  return resolved.absolutePath;
}

export async function writeProjectExecutionResult(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
  readonly result: ExecutionResult;
}): Promise<string> {
  return writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.artifactPath,
    text: stableProtocolJson(input.result)
  });
}

export async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

export function normalizeExecutionResult(input: unknown, fallback: {
  readonly status: ExecutionStatus;
  readonly summary: string;
  readonly rawOutput?: string;
  readonly exitCode?: number;
}): ExecutionResult {
  const value = isRecord(input) ? input : {};
  const status = parseStatus(value["status"]) ?? fallback.status;
  const commandsRun = parseCommands(value["commandsRun"]);
  const findings = parseFindings(value["findings"]);
  const reviewVerdicts = parseReviewVerdicts(value["reviewVerdicts"]);
  return {
    ok: status === "succeeded",
    status,
    summary: parseString(value["summary"]) ?? fallback.summary,
    filesChanged: parseStringArray(value["filesChanged"]),
    commandsRun,
    findings,
    ...(reviewVerdicts === undefined ? {} : { reviewVerdicts }),
    ...(fallback.rawOutput === undefined ? {} : { rawOutput: fallback.rawOutput }),
    ...(fallback.exitCode === undefined ? {} : { exitCode: fallback.exitCode })
  };
}

export function parseResultFromText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (match?.[0] === undefined) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parseStatus(value: unknown): ExecutionStatus | undefined {
  return value === "succeeded" || value === "failed" || value === "blocked" ? value : undefined;
}

function parseCommands(value: unknown): readonly ExecutionCommandResult[] {
  if (!Array.isArray(value)) return [];
  const commands: ExecutionCommandResult[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const command = parseString(entry["command"]);
    const args = parseStringArray(entry["args"]);
    const exitCode = entry["exitCode"];
    if (command === undefined || typeof exitCode !== "number" || !Number.isInteger(exitCode)) continue;
    commands.push({ command, args, exitCode });
  }
  return commands;
}

function parseFindings(value: unknown): readonly ExecutionFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ExecutionFinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = parseString(entry["id"]);
    const title = parseString(entry["title"]);
    const body = parseString(entry["body"]);
    const severity = entry["severity"];
    if (
      id === undefined ||
      title === undefined ||
      body === undefined ||
      (severity !== "minor" && severity !== "major" && severity !== "blocking")
    ) {
      continue;
    }
    const evidenceRefs = parseStringArray(entry["evidenceRefs"]);
    findings.push({
      id,
      title,
      body,
      severity,
      ...(evidenceRefs.length === 0 ? {} : { evidenceRefs })
    });
  }
  return findings;
}

function parseReviewVerdicts(value: unknown): ExecutionReviewVerdicts | undefined {
  if (!isRecord(value)) return undefined;
  const specification = parseReviewVerdict(value["specification"]);
  const integration = parseReviewVerdict(value["integration"]);
  const evidence = parseReviewVerdict(value["evidence"]);
  if (specification === undefined || integration === undefined || evidence === undefined) return undefined;
  return { specification, integration, evidence };
}

function parseReviewVerdict(value: unknown): ExecutionReviewVerdicts["specification"] | undefined {
  return value === "pass" ||
    value === "fail" ||
    value === "unknown" ||
    value === "not_verified" ||
    value === "not_applicable"
    ? value
    : undefined;
}
