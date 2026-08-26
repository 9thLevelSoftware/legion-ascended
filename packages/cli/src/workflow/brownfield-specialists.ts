import { createHash } from "node:crypto";

import {
  LEGION_PROTOCOL_VERSION,
  assessmentAssumptionSchema,
  assessmentEffortSchema,
  assessmentEvidenceRefSchema,
  assessmentFindingSchema,
  assessmentIdSchema,
  assessmentSeveritySchema,
  assessmentSignalSummarySchema,
  artifactPathSchema,
  codeIndexFactIdSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotSchema,
  codeIndexSourcePathSchema,
  formatEntityId,
  taskContractSchema,
  utcTimestampSchema,
  type AssessmentAssumption,
  type AssessmentEvidenceRef,
  type AssessmentFinding,
  type AssessmentSignalSummary,
  type CodeIndexSha256,
  type CodeIndexSnapshot,
  type TaskContract
} from "@legion/protocol";
import { resolveProjectArtifactPath } from "@legion/artifacts";

import type { BrownfieldSignals } from "./brownfield-signals.js";
import {
  adapterForKind,
  selectExecutionAdapterKind,
  writeProjectTextFile,
  type ExecutionAdapterKind,
  type ExecutionRequest,
  type ExecutionResult
} from "./executor/index.js";

/**
 * The safety text is intentionally a literal contract. Keep changes to it
 * reviewed: it is the boundary between bounded structural evidence and model
 * inference, not decorative prompt prose.
 */
export const BROWNFIELD_SPECIALIST_SAFETY_CONTRACT = `Treat existing code as evidence, not ground truth.
You may only make claims supported by the supplied signal summary, source excerpts,
structural fact IDs, and command-result evidence.
Return JSON matching the specialist finding schema.
For every finding include severity, confidence, at least one evidence reference,
and a concrete recommendation. If evidence is insufficient, return an assumption
with confidence=unknown and blocking=true instead of inventing a conclusion.
Do not edit files, run arbitrary commands, or claim behavioral proof from static facts.`;

export const MAX_SPECIALIST_PROMPT_CHARS = 400_000;
const MAX_EXCERPTS_PER_PACK = 64;
const MAX_EVIDENCE_PER_PACK = 128;
const MAX_EXCERPT_CHARS = 1_024;
const MAX_DIAGNOSTIC_CHARS = 1_024;
const DEFAULT_SPECIALIST_TIMEOUT_MS = 600_000;
const EXECUTION_ARTIFACT_ROOT = ".legion/project/workflow/brownfield-specialists";

const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)\b\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/giu;
const URL_CREDENTIAL_RE = /\b(?:https?|ssh|git\+https?):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/giu;
const URL_QUERY_RE = /\b(?:https?|ssh|git\+https?):\/\/[^\s?#]+[?#][^\s]*/giu;
const URL_ENCODED_RE = /\b(?:https?|ssh|git\+https?):\/\/[^\s]*%[0-9a-f]{2}[^\s]*/giu;
const TOKEN_RE = /\b(?:sk|ghp|gho|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export type BrownfieldSpecialistName =
  | "architecture"
  | "code"
  | "tests"
  | "security"
  | "product-intent"
  | "documentation";

export interface BrownfieldSpecialistSpec {
  readonly name: BrownfieldSpecialistName;
  readonly pass: number;
  readonly focus: string;
}

const ROSTER: readonly BrownfieldSpecialistSpec[] = [
  { name: "architecture", pass: 1, focus: "module boundaries, imports, exports, and structural architecture" },
  { name: "code", pass: 1, focus: "implementation risks, static code signals, and error handling" },
  { name: "tests", pass: 1, focus: "test inventory, conservative test links, and proof gaps" },
  { name: "documentation", pass: 1, focus: "bounded documentation metadata and documentation coverage" },
  { name: "product-intent", pass: 1, focus: "evidence-backed product intent and unresolved intent questions" },
  { name: "security", pass: 1, focus: "credential-like, input-boundary, supply-chain, and verification risk signals" },
  { name: "code", pass: 2, focus: "an independent second code pass over the supplied evidence" },
  // The protocol's finding specialist enum has no separate integration value.
  // This remains a tests specialist so its output is representable by the v1
  // protocol, while the focus makes the adversarial integration scope explicit.
  { name: "tests", pass: 2, focus: "adversarial integration pass over boundaries and proof gaps" }
];

export interface BrownfieldExcerpt {
  readonly kind: "architecture-signal" | "risk-signal" | "dependency-edge" | "test-inventory" | "test-link";
  /** Primary evidence path, retained for operator traceability. */
  readonly path: string;
  readonly sha256?: CodeIndexSha256;
  readonly factIds: readonly string[];
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly text: string;
}

export interface BrownfieldExcerptPack {
  readonly specialist: BrownfieldSpecialistSpec;
  readonly snapshotId: CodeIndexSnapshot["snapshotId"];
  readonly summary: AssessmentSignalSummary;
  readonly excerpts: readonly BrownfieldExcerpt[];
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly prompt: string;
  /** UTF-16 character count, matching the pre-spawn contract. */
  readonly promptSize: number;
  readonly promptBytes: number;
}

export interface BrownfieldSpecialistExecutionRequest {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly signals: BrownfieldSignals;
  readonly specialist: BrownfieldSpecialistSpec;
  readonly pack: BrownfieldExcerptPack;
  readonly prompt: string;
  readonly executor: ExecutionAdapterKind;
}

export type BrownfieldSpecialistExecutor =
  (request: BrownfieldSpecialistExecutionRequest) => Promise<unknown>;

export interface BrownfieldSpecialistEvidenceLocation {
  readonly path: string;
  readonly sha256?: CodeIndexSha256;
  readonly factIds: readonly string[];
}

export interface BrownfieldSpecialistExecutionRecord {
  readonly specialist: BrownfieldSpecialistSpec;
  readonly executor: ExecutionAdapterKind;
  readonly transport: "adapter" | "in-process";
  readonly status: "succeeded" | "failed" | "blocked";
  readonly snapshotId: CodeIndexSnapshot["snapshotId"];
  readonly summary: AssessmentSignalSummary;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly excerptPaths: readonly BrownfieldSpecialistEvidenceLocation[];
  readonly promptSize: number;
  readonly promptBytes: number;
  readonly resultHash: CodeIndexSha256;
  readonly outputSize: number;
  /** Empty on success; bounded and redacted on failure. */
  readonly diagnostic: string;
}

export interface BrownfieldSpecialistsResult {
  readonly ok: boolean;
  readonly roster: readonly BrownfieldSpecialistSpec[];
  readonly packs: readonly BrownfieldExcerptPack[];
  readonly findings: readonly AssessmentFinding[];
  readonly assumptions: readonly AssessmentAssumption[];
  readonly executionRecords: readonly BrownfieldSpecialistExecutionRecord[];
  readonly diagnostics: readonly string[];
}

interface PackInput {
  readonly snapshot: CodeIndexSnapshot;
  readonly signals: BrownfieldSignals;
  readonly effort: number;
  readonly commandResults?: readonly AssessmentEvidenceRef[];
}

interface EvidenceSupport {
  readonly source: ReadonlySet<string>;
  readonly structural: ReadonlySet<string>;
  readonly command: ReadonlySet<string>;
}

interface ParsedSpecialistOutput {
  readonly findings: readonly AssessmentFinding[];
  readonly assumptions: readonly AssessmentAssumption[];
}

interface SpecialistRunOutcome {
  readonly status: "succeeded" | "failed" | "blocked";
  readonly raw: unknown;
  readonly payload?: unknown;
  readonly diagnostic: string;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sorted<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare);
}

function boundedText(value: string, limit: number): string {
  const sanitized = redactBrownfieldSpecialistText(value).replace(/\r\n?/gu, "\n").trim();
  if (sanitized.length <= limit) return sanitized;
  const marker = " …[TRUNCATED]";
  return `${sanitized.slice(0, Math.max(1, limit - marker.length))}${marker}`;
}

/**
 * Redaction is applied before a string can enter a prompt, diagnostic, or
 * returned pack. In particular, persisted import specifiers and model prose
 * are treated as untrusted data, not as prompt instructions.
 */
export function redactBrownfieldSpecialistText(value: string): string {
  return value
    .replace(URL_CREDENTIAL_RE, "[REDACTED_URL]")
    .replace(URL_QUERY_RE, (match) => match.split(/[?#]/u, 1)[0] ?? "[REDACTED_URL]")
    .replace(URL_ENCODED_RE, "[REDACTED_URL]")
    .replace(SECRET_ASSIGNMENT_RE, (_match, key: string) => `${key}=[REDACTED_SECRET]`)
    .replace(TOKEN_RE, "[REDACTED_TOKEN]")
    .replace(CONTROL_RE, "�");
}

function evidenceKey(reference: AssessmentEvidenceRef): string {
  switch (reference.kind) {
    case "structural-fact":
      return [reference.kind, reference.path, reference.sha256 ?? "", reference.factId].join("\u0000");
    case "source-file":
      return [reference.kind, reference.path, reference.sha256].join("\u0000");
    default:
      return [reference.kind, reference.path].join("\u0000");
  }
}

function evidenceSortKey(reference: AssessmentEvidenceRef): string {
  return [evidenceKey(reference), reference.note].join("\u0000");
}

function sanitizeEvidence(reference: AssessmentEvidenceRef): AssessmentEvidenceRef {
  const parsed = assessmentEvidenceRefSchema.parse(reference);
  const note = boundedText(parsed.note, 512);
  switch (parsed.kind) {
    case "structural-fact":
      return assessmentEvidenceRefSchema.parse({
        kind: parsed.kind,
        path: parsed.path,
        ...(parsed.sha256 === undefined ? {} : { sha256: parsed.sha256 }),
        factId: parsed.factId,
        note
      });
    case "source-file":
      return assessmentEvidenceRefSchema.parse({ kind: parsed.kind, path: parsed.path, sha256: parsed.sha256, note });
    default:
      return assessmentEvidenceRefSchema.parse({ kind: parsed.kind, path: parsed.path, note });
  }
}

function uniqueEvidence(values: readonly AssessmentEvidenceRef[]): AssessmentEvidenceRef[] {
  const byKey = new Map<string, AssessmentEvidenceRef>();
  for (const value of values) {
    const sanitized = sanitizeEvidence(value);
    const key = evidenceSortKey(sanitized);
    if (!byKey.has(key)) byKey.set(key, sanitized);
  }
  return sorted([...byKey.values()], (left, right) => compareStrings(evidenceSortKey(left), evidenceSortKey(right)));
}

function primaryEvidence(evidence: readonly AssessmentEvidenceRef[]): AssessmentEvidenceRef | undefined {
  return evidence.find((entry) => entry.kind === "source-file") ?? evidence[0];
}

function excerptFrom(input: {
  readonly kind: BrownfieldExcerpt["kind"];
  readonly text: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
}): BrownfieldExcerpt {
  const evidence = uniqueEvidence(input.evidence);
  const primary = primaryEvidence(evidence);
  if (primary === undefined) throw new Error("Brownfield specialist excerpt has no evidence.");
  const factIds = evidence
    .filter((entry): entry is Extract<AssessmentEvidenceRef, { readonly kind: "structural-fact" }> => entry.kind === "structural-fact")
    .map((entry): string => entry.factId)
    .sort(compareStrings);
  const primarySha256 = "sha256" in primary ? primary.sha256 : undefined;
  return {
    kind: input.kind,
    path: primary.path,
    ...(primarySha256 === undefined ? {} : { sha256: primarySha256 }),
    factIds,
    evidence,
    text: boundedText(input.text, MAX_EXCERPT_CHARS)
  };
}

function validateSnapshot(snapshotInput: CodeIndexSnapshot): CodeIndexSnapshot {
  const snapshot = codeIndexSnapshotSchema.parse(snapshotInput);
  if (snapshot.profile !== "structural") throw new Error("Brownfield specialists require a structural CodeIndexSnapshot.");
  return snapshot;
}

function validateSignals(input: PackInput, snapshot: CodeIndexSnapshot): {
  readonly summary: AssessmentSignalSummary;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly commandResults: readonly AssessmentEvidenceRef[];
  readonly support: EvidenceSupport;
} {
  const summary = assessmentSignalSummarySchema.parse(input.signals.summary);
  const coveredPaths = new Set(snapshot.coverage.map((entry) => entry.path));
  const factIds = new Set<string>([
    ...snapshot.symbols.map((entry): string => entry.id),
    ...snapshot.imports.map((entry): string => entry.id),
    ...snapshot.exports.map((entry): string => entry.id)
  ]);
  const sourceEvidence = new Set<string>();
  const structuralEvidence = new Set<string>();
  const commandEvidence = new Set<string>();
  const signalEvidence: AssessmentEvidenceRef[] = [];

  const register = (referenceInput: AssessmentEvidenceRef, origin: string): void => {
    const reference = assessmentEvidenceRefSchema.parse(referenceInput);
    if (reference.kind === "source-file") {
      if (!coveredPaths.has(reference.path)) throw new Error(`${origin} references a source path outside snapshot coverage.`);
      sourceEvidence.add(evidenceKey(reference));
    } else if (reference.kind === "structural-fact") {
      if (reference.path !== snapshot.sqlite.path || !factIds.has(reference.factId)) {
        throw new Error(`${origin} references an unknown structural fact.`);
      }
      if (reference.sha256 !== undefined && reference.sha256 !== snapshot.sqlite.sha256) {
        throw new Error(`${origin} references a structural fact with the wrong SQLite hash.`);
      }
      structuralEvidence.add(evidenceKey(reference));
      structuralEvidence.add([reference.kind, reference.path, "", reference.factId].join("\u0000"));
      structuralEvidence.add([reference.kind, reference.path, snapshot.sqlite.sha256, reference.factId].join("\u0000"));
    } else if (reference.kind === "command-result") {
      // Command-result evidence is registered only from the explicit input below.
      throw new Error(`${origin} contains command-result evidence without explicit command-result input.`);
    } else {
      throw new Error(`${origin} contains unsupported evidence kind ${reference.kind}.`);
    }
    signalEvidence.push(reference);
  };

  for (const [index, signal] of [...input.signals.architectureSignals, ...input.signals.riskSignals].entries()) {
    if (typeof signal.code !== "string" || typeof signal.statement !== "string") throw new Error(`Signal ${index} has invalid text.`);
    assessmentSeveritySchema.parse(signal.severity);
    if (!Array.isArray(signal.evidence) || signal.evidence.length === 0) throw new Error(`Signal ${index} has no evidence.`);
    for (const reference of signal.evidence) register(reference, `Signal ${signal.code}`);
  }
  for (const [index, edge] of input.signals.dependencyEdges.entries()) {
    codeIndexSourcePathSchema.parse(edge.from);
    if (!coveredPaths.has(edge.from) || typeof edge.to !== "string") throw new Error(`Dependency edge ${index} is outside snapshot coverage.`);
    register(edge.evidence, `Dependency edge ${index}`);
  }
  for (const [index, link] of input.signals.testToSourceLinks.entries()) {
    codeIndexSourcePathSchema.parse(link.testPath);
    codeIndexSourcePathSchema.parse(link.sourcePath);
    if (!coveredPaths.has(link.testPath) || !coveredPaths.has(link.sourcePath)) throw new Error(`Test link ${index} is outside snapshot coverage.`);
    if (typeof link.reason !== "string") throw new Error(`Test link ${index} has invalid reason.`);
  }
  for (const [index, testPath] of input.signals.testFiles.entries()) {
    codeIndexSourcePathSchema.parse(testPath);
    if (!coveredPaths.has(testPath)) throw new Error(`Test file ${index} is outside snapshot coverage.`);
  }

  const commandResults: AssessmentEvidenceRef[] = [];
  for (const [index, commandResultInput] of (input.commandResults ?? []).entries()) {
    const commandResult = assessmentEvidenceRefSchema.parse(commandResultInput);
    if (commandResult.kind !== "command-result") throw new Error(`Command-result evidence ${index} has the wrong kind.`);
    const sanitized = sanitizeEvidence(commandResult);
    commandResults.push(sanitized);
    commandEvidence.add(evidenceKey(sanitized));
  }

  return {
    summary,
    evidence: uniqueEvidence(signalEvidence),
    commandResults: uniqueEvidence(commandResults),
    support: { source: sourceEvidence, structural: structuralEvidence, command: commandEvidence }
  };
}

function rosterForEffort(effortInput: number): BrownfieldSpecialistSpec[] {
  const effort = assessmentEffortSchema.parse(effortInput);
  const count = effort === 1 ? 2 : effort === 2 ? 3 : effort === 3 ? 5 : effort === 4 ? 6 : 8;
  const seen = new Set<string>();
  return ROSTER.slice(0, count).filter((specialist) => {
    const key = `${specialist.name}\u0000${specialist.pass}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((specialist) => ({ ...specialist }));
}

/** Public roster seam used by Task5/6 and by deterministic contract tests. */
export function getBrownfieldSpecialistRoster(effort: number): readonly BrownfieldSpecialistSpec[] {
  return rosterForEffort(effort);
}

/** Alias kept intentionally descriptive for callers that prefer noun-first APIs. */
export const brownfieldSpecialistRoster = getBrownfieldSpecialistRoster;

function selectedExcerptKinds(specialist: BrownfieldSpecialistSpec): ReadonlySet<BrownfieldExcerpt["kind"]> {
  switch (specialist.name) {
    case "architecture":
      return new Set(["architecture-signal", "dependency-edge"]);
    case "code":
      return new Set(["architecture-signal", "risk-signal", "dependency-edge"]);
    case "tests":
      return specialist.pass === 2
        ? new Set(["architecture-signal", "risk-signal", "dependency-edge", "test-inventory", "test-link"])
        : new Set(["risk-signal", "test-inventory", "test-link"]);
    case "documentation":
    case "product-intent":
      return new Set(["architecture-signal"]);
    case "security":
      return new Set(["risk-signal", "dependency-edge"]);
  }
}

function buildExcerpts(input: PackInput, specialist: BrownfieldSpecialistSpec, validated: ReturnType<typeof validateSignals>): BrownfieldExcerpt[] {
  const excerpts: BrownfieldExcerpt[] = [];
  const selected = selectedExcerptKinds(specialist);
  const add = (entry: BrownfieldExcerpt): void => {
    if (selected.has(entry.kind)) excerpts.push(entry);
  };

  for (const signal of sorted(
    [...input.signals.architectureSignals],
    (left, right) => compareStrings(left.code, right.code) || compareStrings(left.statement, right.statement)
  )) {
    add(excerptFrom({
      kind: "architecture-signal",
      text: `Signal ${signal.code} (${signal.severity}): ${signal.statement}`,
      evidence: signal.evidence
    }));
  }
  for (const signal of sorted(
    [...input.signals.riskSignals],
    (left, right) => compareStrings(left.code, right.code) || compareStrings(left.statement, right.statement)
  )) {
    add(excerptFrom({
      kind: "risk-signal",
      text: `Risk signal ${signal.code} (${signal.severity}): ${signal.statement}`,
      evidence: signal.evidence
    }));
  }
  for (const edge of sorted(
    [...input.signals.dependencyEdges],
    (left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to)
  )) {
    add(excerptFrom({
      kind: "dependency-edge",
      text: `Persisted import edge from ${edge.from} to ${edge.to}. This is an import fact, not a resolved runtime dependency claim.`,
      evidence: [edge.evidence]
    }));
  }
  for (const testPath of sorted([...input.signals.testFiles], compareStrings)) {
    const evidence = validated.evidence.filter((entry) => entry.kind === "source-file" && entry.path === testPath);
    if (evidence.length > 0) {
      add(excerptFrom({
        kind: "test-inventory",
        text: `Test inventory path: ${testPath}. Presence is not execution or coverage proof.`,
        evidence
      }));
    }
  }
  for (const link of sorted(
    [...input.signals.testToSourceLinks],
    (left, right) => compareStrings(left.testPath, right.testPath) || compareStrings(left.sourcePath, right.sourcePath)
  )) {
    const evidence = validated.evidence.filter((entry) => entry.kind === "source-file" &&
      (entry.path === link.testPath || entry.path === link.sourcePath));
    if (evidence.length > 0) {
      add(excerptFrom({
        kind: "test-link",
        text: `Conservative test-to-source link: ${link.testPath} -> ${link.sourcePath}; ${link.reason}`,
        evidence
      }));
    }
  }

  return sorted(excerpts, (left, right) =>
    compareStrings(left.kind, right.kind) || compareStrings(left.path, right.path) ||
    compareStrings(left.text, right.text) || compareStrings(JSON.stringify(left.evidence), JSON.stringify(right.evidence))
  ).slice(0, MAX_EXCERPTS_PER_PACK);
}

function packPrompt(input: {
  readonly specialist: BrownfieldSpecialistSpec;
  readonly snapshot: CodeIndexSnapshot;
  readonly summary: AssessmentSignalSummary;
  readonly excerpts: readonly BrownfieldExcerpt[];
  readonly evidence: readonly AssessmentEvidenceRef[];
}): string {
  const evidence = input.evidence.map((reference) => {
    const sanitized = sanitizeEvidence(reference);
    return sanitized;
  });
  const prompt = [
    `You are the ${input.specialist.name} assessor for a brownfield repository.`,
    BROWNFIELD_SPECIALIST_SAFETY_CONTRACT,
    `Specialist pass: ${input.specialist.pass}. Focus: ${input.specialist.focus}.`,
    `Snapshot ID: ${input.snapshot.snapshotId}. Scope: ${input.snapshot.scope}.`,
    `Signal summary: ${JSON.stringify(input.summary)}.`,
    "Only the following bounded evidence pack is supplied; do not infer beyond it.",
    `Evidence references: ${JSON.stringify(evidence)}.`,
    `Excerpts: ${JSON.stringify(input.excerpts.map((excerpt) => ({
      kind: excerpt.kind,
      path: excerpt.path,
      ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
      factIds: excerpt.factIds,
      evidence: excerpt.evidence,
      text: excerpt.text
    })))}.`,
    "Return one JSON object with only `findings` and `assumptions` arrays."
  ].join("\n");
  if (prompt.length > MAX_SPECIALIST_PROMPT_CHARS) {
    throw new Error(`Brownfield specialist prompt exceeds the ${MAX_SPECIALIST_PROMPT_CHARS}-character bound.`);
  }
  return prompt;
}

/**
 * Build all packs without executing anything. Sorting and fixed limits make
 * this seam suitable for prompt snapshots and reproducible assessment resumes.
 */
export function buildBrownfieldExcerptPacks(input: PackInput): readonly BrownfieldExcerptPack[] {
  const snapshot = validateSnapshot(input.snapshot);
  const effort = assessmentEffortSchema.parse(input.effort);
  const validated = validateSignals(input, snapshot);
  const roster = rosterForEffort(effort);
  return roster.map((specialist) => {
    const excerpts = buildExcerpts(input, specialist, validated);
    const evidence = uniqueEvidence([
      ...excerpts.flatMap((excerpt) => excerpt.evidence),
      ...validated.commandResults
    ]).slice(0, MAX_EVIDENCE_PER_PACK);
    const prompt = packPrompt({ specialist, snapshot, summary: validated.summary, excerpts, evidence });
    return {
      specialist,
      snapshotId: snapshot.snapshotId,
      summary: validated.summary,
      excerpts,
      evidence,
      prompt,
      promptSize: prompt.length,
      promptBytes: Buffer.byteLength(prompt, "utf8")
    };
  });
}

function hashUnknown(value: unknown): CodeIndexSha256 {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  return codeIndexSha256Schema.parse(createHash("sha256").update(text, "utf8").digest("hex"));
}

function serializedSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function hashExecutionOutcome(outcome: SpecialistRunOutcome): CodeIndexSha256 {
  const raw = outcome.raw instanceof Error ? { error: outcome.raw.message } : outcome.raw;
  return hashUnknown({ status: outcome.status, diagnostic: outcome.diagnostic, output: raw });
}

function safeDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Specialist execution failed.";
  return boundedText(message, MAX_DIAGNOSTIC_CHARS) || "Specialist execution failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  return isRecord(value) &&
    (value["status"] === "succeeded" || value["status"] === "failed" || value["status"] === "blocked") &&
    typeof value["summary"] === "string" && Array.isArray(value["findings"]);
}

function parseJsonText(text: string): unknown {
  if (text.trim().length === 0) throw new Error("Specialist returned empty output.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Specialist returned malformed JSON.");
  }
}

function specialistPayloadFrom(value: unknown): { readonly status: "succeeded" | "failed" | "blocked"; readonly payload?: unknown; readonly diagnostic: string } {
  if (isExecutionResult(value)) {
    if (value.status !== "succeeded") {
      return { status: value.status, diagnostic: value.summary || "Executor did not complete the specialist." };
    }
    if (value.structuredOutput === undefined) {
      return { status: "failed", diagnostic: "Specialist executor completed without structured JSON output." };
    }
    try {
      return { status: "succeeded", payload: parseJsonText(value.structuredOutput), diagnostic: "" };
    } catch (error) {
      return { status: "failed", diagnostic: safeDiagnostic(error) };
    }
  }
  if (typeof value === "string") {
    try {
      return { status: "succeeded", payload: parseJsonText(value), diagnostic: "" };
    } catch (error) {
      return { status: "failed", diagnostic: safeDiagnostic(error) };
    }
  }
  return { status: "succeeded", payload: value, diagnostic: "" };
}

function supportedEvidence(referenceInput: AssessmentEvidenceRef, support: EvidenceSupport): boolean {
  const reference = assessmentEvidenceRefSchema.parse(referenceInput);
  if (reference.kind === "source-file") return support.source.has(evidenceKey(reference));
  if (reference.kind === "structural-fact") return support.structural.has(evidenceKey(reference));
  if (reference.kind === "command-result") return support.command.has(evidenceKey(reference));
  return false;
}

function assertEvidenceClosure(evidence: readonly AssessmentEvidenceRef[], support: EvidenceSupport): void {
  if (evidence.length === 0) throw new Error("Specialist finding or assumption has no evidence.");
  for (const reference of evidence) {
    const parsed = assessmentEvidenceRefSchema.parse(reference);
    if (!supportedEvidence(parsed, support)) {
      throw new Error(`Specialist evidence reference is not backed by the supplied signal pack: ${parsed.path}.`);
    }
  }
}

function normalizeSpecialistOutput(input: {
  readonly value: unknown;
  readonly specialist: BrownfieldSpecialistSpec;
  readonly support: EvidenceSupport;
}): ParsedSpecialistOutput {
  const { value, specialist, support } = input;
  if (!isRecord(value)) throw new Error("Specialist output must be a JSON object.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "findings" && key !== "assumptions")) {
    throw new Error("Specialist output contains unknown fields.");
  }
  const rawFindings = value["findings"];
  const rawAssumptions = value["assumptions"];
  if (rawFindings !== undefined && !Array.isArray(rawFindings)) throw new Error("Specialist findings must be an array.");
  if (rawAssumptions !== undefined && !Array.isArray(rawAssumptions)) throw new Error("Specialist assumptions must be an array.");
  const findingInputs = (rawFindings ?? []) as readonly unknown[];
  const assumptionInputs = (rawAssumptions ?? []) as readonly unknown[];
  if (findingInputs.length === 0 && assumptionInputs.length === 0) throw new Error("Specialist returned empty output.");

  const assumptions: AssessmentAssumption[] = [];
  const assumptionIdMap = new Map<string, string>();
  for (const valueInput of assumptionInputs) {
    const parsed = assessmentAssumptionSchema.parse(valueInput);
    if (assumptionIdMap.has(parsed.id)) throw new Error("Specialist returned duplicate assumption IDs.");
    assertEvidenceClosure(parsed.evidence, support);
    const sanitized = assessmentAssumptionSchema.parse({
      ...parsed,
      statement: boundedText(parsed.statement, 2_000),
      resolution: boundedText(parsed.resolution, 1_000),
      evidence: parsed.evidence.map(sanitizeEvidence)
    });
    assumptionIdMap.set(parsed.id, sanitized.id);
    assumptions.push(sanitized);
  }

  const findings: AssessmentFinding[] = [];
  const findingIds = new Set<string>();
  for (const valueInput of findingInputs) {
    const parsed = assessmentFindingSchema.parse(valueInput);
    if (parsed.specialist !== specialist.name) {
      throw new Error(`Specialist finding names ${parsed.specialist}, expected ${specialist.name}.`);
    }
    if (findingIds.has(parsed.id)) throw new Error("Specialist returned duplicate finding IDs.");
    findingIds.add(parsed.id);
    assertEvidenceClosure(parsed.evidence, support);
    const assumptionsForFinding: string[] = [];
    const seenAssumptions = new Set<string>();
    for (const assumptionId of parsed.assumptions) {
      if (seenAssumptions.has(assumptionId)) throw new Error("Finding assumption references must be unique.");
      const normalizedId = assumptionIdMap.get(assumptionId);
      if (normalizedId === undefined) throw new Error("Finding references an assumption outside this specialist output.");
      seenAssumptions.add(assumptionId);
      assumptionsForFinding.push(normalizedId);
    }
    findings.push(assessmentFindingSchema.parse({
      ...parsed,
      title: boundedText(parsed.title, 256),
      statement: boundedText(parsed.statement, 4_000),
      recommendation: boundedText(parsed.recommendation, 4_000),
      evidence: parsed.evidence.map(sanitizeEvidence),
      assumptions: assumptionsForFinding
    }));
  }
  return { findings, assumptions };
}

function fallbackEvidence(pack: BrownfieldExcerptPack, snapshot: CodeIndexSnapshot): readonly AssessmentEvidenceRef[] {
  if (pack.evidence.length > 0) return pack.evidence.slice(0, 1);
  const fact = [...snapshot.symbols, ...snapshot.imports, ...snapshot.exports]
    .sort((left, right) => compareStrings(left.id, right.id))[0];
  if (fact === undefined) return [];
  return [assessmentEvidenceRefSchema.parse({
    kind: "structural-fact",
    path: snapshot.sqlite.path,
    sha256: snapshot.sqlite.sha256,
    factId: codeIndexFactIdSchema.parse(fact.id),
    note: "Structural snapshot evidence for an unknown specialist result."
  })];
}

function unknownAssumption(input: {
  readonly assessmentId: string;
  readonly specialist: BrownfieldSpecialistSpec;
  readonly diagnostic: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
}): AssessmentAssumption {
  if (input.evidence.length === 0) {
    throw new Error(`Cannot persist failed specialist ${input.specialist.name} without supplied evidence.`);
  }
  const idDigest = createHash("sha256")
    .update([input.assessmentId, input.specialist.name, String(input.specialist.pass), input.diagnostic].join("\u0000"), "utf8")
    .digest("hex");
  const id = `asm_${idDigest.slice(0, 24)}`;
  return assessmentAssumptionSchema.parse({
    id,
    statement: boundedText(`The ${input.specialist.name} specialist pass ${input.specialist.pass} could not establish a supported conclusion: ${input.diagnostic}`, 2_000),
    confidence: "unknown",
    blocking: true,
    resolution: "Rerun this bounded specialist with a functioning executor and explicit evidence-backed output.",
    evidence: input.evidence.map(sanitizeEvidence)
  });
}

function specialistArtifactPath(assessmentId: string, specialist: BrownfieldSpecialistSpec, fileName: string) {
  const base = `${EXECUTION_ARTIFACT_ROOT}/${assessmentId}/${specialist.name}-pass-${specialist.pass}`;
  return {
    base: `${base}`,
    context: `${base}/context-pack.json`,
    prompt: `${base}/executor-prompt.md`,
    result: `${base}/executor-result.json`,
    raw: `${base}/executor-raw.log`,
    redacted: `${base}/executor-redacted.log`,
    fileName
  };
}

function syntheticTask(input: {
  readonly assessmentId: string;
  readonly specialist: BrownfieldSpecialistSpec;
  readonly createdAt: string;
}): TaskContract {
  const suffix = `brownfield-${createHash("sha256").update(`${input.assessmentId}\u0000${input.specialist.name}\u0000${input.specialist.pass}`, "utf8").digest("hex").slice(0, 24)}`;
  const projectId = formatEntityId("project", suffix);
  const changeId = formatEntityId("change", suffix);
  const requirementId = formatEntityId("requirement", suffix);
  const contractId = formatEntityId("contract", suffix);
  const oracleId = formatEntityId("oracle", suffix);
  return taskContractSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: utcTimestampSchema.parse(input.createdAt),
    kind: "task-contract",
    id: contractId,
    projectId,
    changeId,
    revision: 1,
    title: `Brownfield ${input.specialist.name} assessment`,
    objective: "Produce bounded, evidence-backed specialist findings without editing the repository.",
    requirementIds: [requirementId],
    wave: "LEGACY",
    agents: ["legacy-agent"],
    dependencies: [],
    context: { specRefs: [], designRefs: [], predecessorArtifacts: [] },
    scope: { read: ["."], write: ["."], forbidden: [], sequentialFiles: [], budget: { maxFilesChanged: 1, maxLinesChanged: 1, maxNewFiles: 0 } },
    interfaces: { consumes: [], produces: [{ name: "brownfield.specialist.findings", description: "Typed evidence-bound specialist findings." }] },
    oracleRefs: [oracleId],
    verification: [{ command: "legion", args: ["assess"], expectedExitCode: 0 }],
    risk: { tier: "R2", reasons: ["read-only bounded assessment"] },
    approvals: [],
    completion: {
      expectedArtifacts: [],
      requiredEvidence: ["snapshot"],
      blockedConditions: ["executor failure", "unsupported evidence"],
      diffReconciliation: { required: false, allowUnlistedReads: true }
    }
  });
}

async function runWithExistingAdapter(input: BrownfieldSpecialistExecutionRequest): Promise<ExecutionResult> {
  const artifacts = specialistArtifactPath(input.assessmentId, input.specialist, "executor-result.json");
  const contextPackArtifactPath = artifacts.context;
  const promptArtifactPath = artifacts.prompt;
  const resultArtifactPath = artifacts.result;
  const rawLogArtifactPath = artifacts.raw;
  const redactedLogArtifactPath = artifacts.redacted;
  const artifactPaths = [contextPackArtifactPath, promptArtifactPath, resultArtifactPath, rawLogArtifactPath, redactedLogArtifactPath];
  const resolvedPaths = await Promise.all(artifactPaths.map(async (artifactPath) => {
    const parsed = artifactPathSchema.parse(artifactPath);
    const resolved = await resolveProjectArtifactPath({ repositoryRoot: input.repositoryRoot, artifactPath: parsed });
    return { parsed, absolutePath: resolved.absolutePath };
  }));
  const [context, prompt, result, raw, redacted] = resolvedPaths;
  if (context === undefined || prompt === undefined || result === undefined || raw === undefined || redacted === undefined) {
    throw new Error("Unable to prepare specialist adapter artifacts.");
  }
  await writeProjectTextFile({ repositoryRoot: input.repositoryRoot, artifactPath: context.parsed, text: JSON.stringify({
    snapshotId: input.snapshot.snapshotId,
    summary: input.pack.summary,
    excerpts: input.pack.excerpts
  }) });
  await writeProjectTextFile({ repositoryRoot: input.repositoryRoot, artifactPath: prompt.parsed, text: input.prompt });
  const createdAt = new Date().toISOString();
  const task = syntheticTask({ assessmentId: input.assessmentId, specialist: input.specialist, createdAt });
  const request: ExecutionRequest = {
    repositoryRoot: input.repositoryRoot,
    changeId: task.changeId,
    runId: formatEntityId("run", `brownfield-${createHash("sha256").update(`${input.assessmentId}\u0000${input.specialist.name}\u0000${input.specialist.pass}`, "utf8").digest("hex").slice(0, 24)}`),
    task,
    mode: "review",
    executor: input.executor,
    readOnly: true,
    prompt: input.prompt,
    contextPackArtifactPath: context.parsed,
    contextPackAbsolutePath: context.absolutePath,
    promptArtifactPath: prompt.parsed,
    promptAbsolutePath: prompt.absolutePath,
    resultArtifactPath: result.parsed,
    resultAbsolutePath: result.absolutePath,
    rawLogArtifactPath: raw.parsed,
    rawLogAbsolutePath: raw.absolutePath,
    redactedLogArtifactPath: redacted.parsed,
    redactedLogAbsolutePath: redacted.absolutePath
  };
  return adapterForKind(input.executor).run(request);
}

function timeoutError(timeoutMs: number): Error & { readonly code: string } {
  const error = new Error(`Specialist executor timed out after ${timeoutMs}ms.`) as Error & { code: string };
  error.code = "SPECIALIST_TIMEOUT";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
      timer.unref();
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runOne(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly signals: BrownfieldSignals;
  readonly executor: ExecutionAdapterKind;
  readonly pack: BrownfieldExcerptPack;
  readonly execute: BrownfieldSpecialistExecutor | undefined;
  readonly support: EvidenceSupport;
  readonly timeoutMs: number;
}): Promise<{
  readonly record: BrownfieldSpecialistExecutionRecord;
  readonly parsed?: ParsedSpecialistOutput;
  readonly diagnostic?: string;
}> {
  const { pack } = input;
  const request: BrownfieldSpecialistExecutionRequest = {
    repositoryRoot: input.repositoryRoot,
    assessmentId: input.assessmentId,
    snapshot: input.snapshot,
    signals: input.signals,
    specialist: pack.specialist,
    pack,
    prompt: pack.prompt,
    executor: input.executor
  };
  let outcome: SpecialistRunOutcome;
  try {
    let raw: unknown;
    if (input.execute === undefined) {
      raw = await runWithExistingAdapter(request);
    } else {
      raw = await withTimeout(Promise.resolve(input.execute(request)), input.timeoutMs);
    }
    const parsedEnvelope = specialistPayloadFrom(raw);
    outcome = { status: parsedEnvelope.status, raw, ...(parsedEnvelope.payload === undefined ? {} : { payload: parsedEnvelope.payload }), diagnostic: parsedEnvelope.diagnostic };
  } catch (error) {
    const diagnostic = safeDiagnostic(error);
    outcome = { status: (error as { readonly code?: unknown })?.code === "SPECIALIST_TIMEOUT" ? "blocked" : "failed", raw: error, diagnostic };
  }

  let parsed: ParsedSpecialistOutput | undefined;
  let diagnostic = outcome.diagnostic;
  let status = outcome.status;
  if (status === "succeeded") {
    try {
      parsed = normalizeSpecialistOutput({ value: outcome.payload, specialist: pack.specialist, support: input.support });
    } catch (error) {
      status = "failed";
      diagnostic = safeDiagnostic(error);
    }
  }
  const evidence = pack.evidence;
  const record: BrownfieldSpecialistExecutionRecord = {
    specialist: pack.specialist,
    executor: input.executor,
    transport: input.execute === undefined ? "adapter" : "in-process",
    status,
    snapshotId: input.snapshot.snapshotId,
    summary: pack.summary,
    evidence,
    excerptPaths: pack.excerpts.map((excerpt) => ({
      path: excerpt.path,
      ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
      factIds: excerpt.factIds
    })),
    promptSize: pack.promptSize,
    promptBytes: pack.promptBytes,
    resultHash: hashExecutionOutcome(outcome),
    outputSize: serializedSize(outcome.raw),
    diagnostic: status === "succeeded" ? "" : boundedText(diagnostic || "Specialist output was rejected.", MAX_DIAGNOSTIC_CHARS)
  };
  return {
    record,
    ...(parsed === undefined ? {} : { parsed }),
    ...(status === "succeeded" ? {} : { diagnostic: record.diagnostic })
  };
}

/**
 * Execute effort-scaled specialists sequentially. Sequential dispatch is the
 * conservative default: adapters may share credentials, process state, and
 * artifact paths, while the result still records enough metadata for a future
 * isolated parallel runner.
 */
export async function runBrownfieldSpecialists(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly signals: BrownfieldSignals;
  readonly effort: number;
  readonly executor?: ExecutionAdapterKind | string;
  readonly commandResults?: readonly AssessmentEvidenceRef[];
  readonly timeoutMs?: number;
  readonly execute?: BrownfieldSpecialistExecutor;
}): Promise<BrownfieldSpecialistsResult> {
  const snapshot = validateSnapshot(input.snapshot);
  const assessmentId = assessmentIdSchema.parse(input.assessmentId);
  const effort = assessmentEffortSchema.parse(input.effort);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Specialist timeoutMs must be a positive safe integer.");
  const selected = await selectExecutionAdapterKind(input.executor);
  if (typeof selected !== "string") throw new Error(selected.diagnostic.message);
  const packInput: PackInput = {
    snapshot,
    signals: input.signals,
    effort,
    ...(input.commandResults === undefined ? {} : { commandResults: input.commandResults })
  };
  const validated = validateSignals(packInput, snapshot);
  const packs = buildBrownfieldExcerptPacks(packInput);
  const records: BrownfieldSpecialistExecutionRecord[] = [];
  const findings: AssessmentFinding[] = [];
  const assumptions: AssessmentAssumption[] = [];
  const diagnostics: string[] = [];
  const seenFindingIds = new Set<string>();
  const seenAssumptionIds = new Set<string>();

  for (const pack of packs) {
    const run = await runOne({
      repositoryRoot: input.repositoryRoot,
      assessmentId,
      snapshot,
      signals: input.signals,
      executor: selected,
      pack,
      execute: input.execute,
      support: validated.support,
      timeoutMs
    });
    let record = run.record;
    let parsed = run.parsed;
    if (parsed !== undefined) {
      const duplicateAssumption = parsed.assumptions.some((assumption) => seenAssumptionIds.has(assumption.id));
      const duplicateFinding = parsed.findings.some((finding) => seenFindingIds.has(finding.id));
      if (duplicateAssumption || duplicateFinding) {
        const diagnostic = "Output reused an ID from an earlier specialist pass.";
        record = { ...record, status: "failed", diagnostic };
        parsed = undefined;
      }
    }
    records.push(record);
    if (parsed === undefined) {
      const diagnostic = run.diagnostic ?? record.diagnostic;
      const evidence = fallbackEvidence(pack, snapshot);
      try {
        const assumption = unknownAssumption({ assessmentId, specialist: pack.specialist, diagnostic, evidence });
        if (!seenAssumptionIds.has(assumption.id)) {
          seenAssumptionIds.add(assumption.id);
          assumptions.push(assumption);
        }
      } catch (error) {
        diagnostics.push(safeDiagnostic(error));
      }
      if (!diagnostics.includes(`${pack.specialist.name} pass ${pack.specialist.pass}: ${diagnostic}`)) {
        diagnostics.push(`${pack.specialist.name} pass ${pack.specialist.pass}: ${diagnostic}`);
      }
      continue;
    }
    for (const assumption of parsed.assumptions) {
      seenAssumptionIds.add(assumption.id);
      assumptions.push(assumption);
    }
    for (const finding of parsed.findings) {
      seenFindingIds.add(finding.id);
      findings.push(finding);
    }
  }

  return {
    ok: records.every((record) => record.status === "succeeded") && diagnostics.length === 0,
    roster: rosterForEffort(effort),
    packs,
    findings,
    assumptions,
    executionRecords: records,
    diagnostics
  };
}
