import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
import { resolveProjectArtifactPath, stableProtocolJson } from "@legion/artifacts";

import { expectedSourceHashes, type BrownfieldSignals } from "./brownfield-signals.js";
import {
  adapterForKind,
  MAX_ADAPTER_OUTPUT_BYTES,
  redactAdapterTranscript,
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
const MAX_EVIDENCE_PER_EXCERPT = 64;
const MAX_EXCERPT_CHARS = 1_024;
const MAX_DIAGNOSTIC_CHARS = 1_024;
const MAX_SPECIALIST_FINDINGS = 2_000;
const MAX_SPECIALIST_ASSUMPTIONS = 256;
const DEFAULT_SPECIALIST_TIMEOUT_MS = 600_000;
const SPECIALIST_TIMEOUT_DRAIN_MS = 1_000;
const EXECUTION_ARTIFACT_ROOT = ".legion/project/workflow/brownfield-specialists";
const BOUNDED_EVIDENCE_NOTE = " [BOUNDED_EVIDENCE]";
const BOUNDED_PROMPT_NOTE = "\n[BOUNDED_PROMPT_TRUNCATED]";
const BOUNDED_PACK_NOTE = "[BOUNDED_PACK_TRUNCATED]";
const MAX_READ_ONLY_SNAPSHOT_ENTRIES = 50_000;
const MAX_READ_ONLY_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_READ_ONLY_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_READ_ONLY_SYMLINK_BYTES = 64 * 1024;

let cleanupAdapterArtifacts: (root: string) => Promise<void> = (root) => rm(root, { recursive: true, force: true });

/** Test-only injection seam for proving cleanup failures fail closed. */
export function setBrownfieldSpecialistCleanupForTests(
  cleanup: ((root: string) => Promise<void>) | undefined
): void {
  cleanupAdapterArtifacts = cleanup ?? ((root) => rm(root, { recursive: true, force: true }));
}

const SECRET_ASSIGNMENT_RE =
  /\b(?:api[_-]?key|api[_-]?secret|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)\b\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/giu;
const JSON_CREDENTIAL_RE =
  /["'](?:api[_-]?key|api[_-]?secret|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)["']\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s}]+)/giu;
const URL_RE = /\b(?:https?|ssh|git\+https?):\/\/[^\s<>"']+/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu;
const TOKEN_RE = /\b(?:sk|ghp|gho|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gu;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ENCODED_SEGMENT_RE = /[^\s]*%[0-9a-f]{2}[^\s]*/giu;
const MAX_REDACTION_DECODE_PASSES = 4;
const MAX_REDACTION_DECODE_LENGTH = 64 * 1024;

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

export interface BrownfieldPackTruncation {
  readonly bounded: boolean;
  readonly excerptsTotal: number;
  readonly excerptsIncluded: number;
  readonly excerptsOmitted: number;
  readonly excerptsTruncated: boolean;
  readonly evidenceTotal: number;
  readonly evidenceIncluded: number;
  readonly evidenceOmitted: number;
  readonly evidenceTruncated: boolean;
  readonly promptTruncated: boolean;
}

export interface BrownfieldExcerptPack {
  readonly specialist: BrownfieldSpecialistSpec;
  readonly snapshotId: CodeIndexSnapshot["snapshotId"];
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
  readonly summary: AssessmentSignalSummary;
  readonly excerpts: readonly BrownfieldExcerpt[];
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly truncation: BrownfieldPackTruncation;
  readonly prompt: string;
  readonly promptHash: CodeIndexSha256;
  /** UTF-16 character count, matching the pre-spawn contract. */
  readonly promptSize: number;
  readonly promptBytes: number;
}

export interface BrownfieldSpecialistExecutionRequest {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshotId: CodeIndexSnapshot["snapshotId"];
  readonly specialist: BrownfieldSpecialistSpec;
  /** Bounded scalar summary; raw signal arrays never cross the executor seam. */
  readonly summary: AssessmentSignalSummary;
  /** Sanitized evidence metadata only; no source excerpts or snapshot object. */
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly excerptMetadata: readonly BrownfieldSpecialistEvidenceLocation[];
  readonly prompt: string;
  readonly promptHash: CodeIndexSha256;
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
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
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
  readonly summary: AssessmentSignalSummary;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly excerptPaths: readonly BrownfieldSpecialistEvidenceLocation[];
  readonly truncation: BrownfieldPackTruncation;
  readonly promptHash: CodeIndexSha256;
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

/** Redaction is shared with every generic executor adapter. */
export const redactBrownfieldSpecialistText = redactAdapterTranscript;

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

function normalizedEvidenceReference(reference: unknown): AssessmentEvidenceRef {
  return assessmentEvidenceRefSchema.parse(reference);
}

function parseSpecialistAssumption(value: unknown): AssessmentAssumption {
  if (!isRecord(value) || !Array.isArray(value["evidence"])) {
    return assessmentAssumptionSchema.parse(value);
  }
  const evidence = value["evidence"].map((entry) => sanitizeEvidence(entry as AssessmentEvidenceRef));
  return assessmentAssumptionSchema.parse({ ...value, evidence });
}

function parseSpecialistFinding(value: unknown): AssessmentFinding {
  if (!isRecord(value) || !Array.isArray(value["evidence"])) {
    return assessmentFindingSchema.parse(value);
  }
  const evidence = value["evidence"].map((entry) => sanitizeEvidence(entry as AssessmentEvidenceRef));
  return assessmentFindingSchema.parse({ ...value, evidence });
}

function sanitizeEvidence(reference: AssessmentEvidenceRef): AssessmentEvidenceRef {
  const parsed = normalizedEvidenceReference(reference);
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
    case "command-result":
    case "manifest":
    case "test-result":
    case "git-metadata":
      return assessmentEvidenceRefSchema.parse({ kind: parsed.kind, path: parsed.path, note });
    case "user-input":
      return assessmentEvidenceRefSchema.parse({
        kind: parsed.kind,
        path: parsed.path,
        note
      });
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

function coverageStatus(snapshot: CodeIndexSnapshot, sourcePath: string): string | undefined {
  return snapshot.coverage.find((entry) => entry.path === sourcePath)?.status;
}

function supportedTestLink(snapshot: CodeIndexSnapshot, link: BrownfieldSignals["testToSourceLinks"][number]): boolean {
  return coverageStatus(snapshot, link.testPath) === "parsed" && coverageStatus(snapshot, link.sourcePath) === "parsed";
}

type SnapshotCoverageWithSourceHash = CodeIndexSnapshot["coverage"][number] & {
  readonly sha256?: CodeIndexSha256;
};

function snapshotCoverageSourceHashes(snapshot: CodeIndexSnapshot): ReadonlyMap<string, CodeIndexSha256> {
  const sourceHashes = new Map<string, CodeIndexSha256>();
  for (const coverage of snapshot.coverage as readonly SnapshotCoverageWithSourceHash[]) {
    if (coverage.sha256 === undefined) continue;
    const sourceSha256 = codeIndexSha256Schema.parse(coverage.sha256);
    const previous = sourceHashes.get(coverage.path);
    if (previous !== undefined && previous !== sourceSha256) {
      throw new Error(`Snapshot coverage has inconsistent source hashes for ${coverage.path}.`);
    }
    sourceHashes.set(coverage.path, sourceSha256);
  }
  return sourceHashes;
}

function snapshotSourceHashes(snapshot: CodeIndexSnapshot): ReadonlyMap<string, CodeIndexSha256> {
  const sourceHashes = new Map(snapshotCoverageSourceHashes(snapshot));
  for (const fact of [...snapshot.symbols, ...snapshot.imports, ...snapshot.exports]) {
    const previous = sourceHashes.get(fact.path);
    if (previous !== undefined && previous !== fact.sourceSha256) {
      throw new Error(`Structural snapshot has inconsistent source hashes for ${fact.path}.`);
    }
    sourceHashes.set(fact.path, fact.sourceSha256);
  }
  return sourceHashes;
}

function attachCoverageSourceHashes(
  snapshot: CodeIndexSnapshot,
  hashes: ReadonlyMap<string, CodeIndexSha256>
): void {
  for (const coverage of snapshot.coverage as readonly SnapshotCoverageWithSourceHash[]) {
    const existing = (coverage as SnapshotCoverageWithSourceHash).sha256;
    const sha256 = hashes.get(coverage.path);
    if (sha256 === undefined) continue;
    if (existing !== undefined && existing !== sha256) {
      throw new Error(`Snapshot source hash mismatch for ${coverage.path}: pre-attached ${existing} vs inventory ${sha256}.`);
    }
    if (existing !== undefined) continue;
    Object.defineProperty(coverage, "sha256", { value: sha256, enumerable: false, configurable: true });
  }
}

async function inventoryHashesForSnapshot(
  repositoryRoot: string,
  snapshot: CodeIndexSnapshot
): Promise<ReadonlyMap<string, CodeIndexSha256>> {
  const mapArtifactPath = `${path.posix.dirname(snapshot.sqlite.path)}/map.json`;
  const absolutePath = path.join(repositoryRoot, ...mapArtifactPath.split("/"));
  try {
    await access(absolutePath);
  } catch {
    return new Map();
  }
  return expectedSourceHashes(repositoryRoot, snapshot.sqlite.path, snapshot);
}

function testMetadataEvidence(sourceHashes: ReadonlyMap<string, CodeIndexSha256>, sourcePath: string, note: string): AssessmentEvidenceRef {
  const path = codeIndexSourcePathSchema.parse(sourcePath);
  const sha256 = sourceHashes.get(path);
  if (sha256 === undefined) throw new Error(`Snapshot has no source hash for test metadata path ${path}.`);
  return assessmentEvidenceRefSchema.parse({
    kind: "source-file",
    path,
    sha256,
    note: boundedText(note, 512)
  });
}

function excerptFrom(input: {
  readonly kind: BrownfieldExcerpt["kind"];
  readonly text: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
}): BrownfieldExcerpt {
  const allEvidence = uniqueEvidence(input.evidence);
  const evidenceWasBounded = allEvidence.length > MAX_EVIDENCE_PER_EXCERPT;
  const evidence = allEvidence.slice(0, MAX_EVIDENCE_PER_EXCERPT);
  const primary = primaryEvidence(evidence);
  if (primary === undefined) throw new Error("Brownfield specialist excerpt has no evidence.");
  const factIds = evidence
    .filter((entry): entry is Extract<AssessmentEvidenceRef, { readonly kind: "structural-fact" }> => entry.kind === "structural-fact")
    .map((entry): string => entry.factId)
    .sort(compareStrings);
  const primarySha256 = "sha256" in primary ? primary.sha256 : undefined;
  const textLimit = evidenceWasBounded ? MAX_EXCERPT_CHARS - BOUNDED_EVIDENCE_NOTE.length : MAX_EXCERPT_CHARS;
  return {
    kind: input.kind,
    path: primary.path,
    ...(primarySha256 === undefined ? {} : { sha256: primarySha256 }),
    factIds,
    evidence,
    text: `${boundedText(input.text, Math.max(1, textLimit))}${evidenceWasBounded ? BOUNDED_EVIDENCE_NOTE : ""}`
  };
}

function validateSnapshot(snapshotInput: CodeIndexSnapshot): CodeIndexSnapshot {
  // Some snapshot producers attach the source hash inventory to coverage
  // entries even though the v1 structural schema predates that field. Preserve
  // those hashes across schema validation so coverage-only files remain bound.
  const coverageSourceHashes = snapshotCoverageSourceHashes(snapshotInput);
  const schemaInput = coverageSourceHashes.size === 0
    ? snapshotInput
    : {
        ...snapshotInput,
        coverage: snapshotInput.coverage.map((coverage) => {
          const { sha256: _sourceSha256, ...schemaCoverage } = coverage as SnapshotCoverageWithSourceHash;
          return schemaCoverage;
        })
      };
  const snapshot = codeIndexSnapshotSchema.parse(schemaInput);
  if (snapshot.profile !== "structural") throw new Error("Brownfield specialists require a structural CodeIndexSnapshot.");
  for (const coverage of snapshot.coverage as readonly SnapshotCoverageWithSourceHash[]) {
    const sourceSha256 = coverageSourceHashes.get(coverage.path);
    if (sourceSha256 !== undefined) {
      Object.defineProperty(coverage, "sha256", { value: sourceSha256, enumerable: false });
    }
  }
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
  const sourceHashes = snapshotSourceHashes(snapshot);
  const sourceEvidence = new Set<string>();
  const structuralEvidence = new Set<string>();
  const commandEvidence = new Set<string>();
  const signalEvidence: AssessmentEvidenceRef[] = [];
  const metadataEvidence: AssessmentEvidenceRef[] = [];

  const register = (referenceInput: AssessmentEvidenceRef, origin: string): void => {
    const reference = assessmentEvidenceRefSchema.parse(referenceInput);
    if (reference.kind === "source-file") {
      if (!coveredPaths.has(reference.path)) throw new Error(`${origin} references a source path outside snapshot coverage.`);
      const expectedSha256 = sourceHashes.get(reference.path);
      if (expectedSha256 === undefined) throw new Error(`${origin} references a source path without a snapshot source hash.`);
      if (reference.sha256 !== expectedSha256) throw new Error(`${origin} references a source file with the wrong source hash.`);
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
    if (supportedTestLink(snapshot, link)) {
      const refs = [
        testMetadataEvidence(sourceHashes, link.testPath, `Bounded test inventory metadata for ${link.testPath}; link is retained only for parsed supported coverage.`),
        testMetadataEvidence(sourceHashes, link.sourcePath, `Bounded source target metadata for ${link.sourcePath}; linked from parsed supported test ${link.testPath}.`)
      ];
      metadataEvidence.push(...refs);
      for (const reference of refs) sourceEvidence.add(evidenceKey(reference));
    }
  }
  for (const [index, testPath] of input.signals.testFiles.entries()) {
    codeIndexSourcePathSchema.parse(testPath);
    if (!coveredPaths.has(testPath)) throw new Error(`Test file ${index} is outside snapshot coverage.`);
    const reference = testMetadataEvidence(sourceHashes, testPath, `Bounded test inventory metadata for ${testPath}; presence is not execution or coverage proof.`);
    metadataEvidence.push(reference);
    sourceEvidence.add(evidenceKey(reference));
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
    evidence: uniqueEvidence([...signalEvidence, ...metadataEvidence]),
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
    const evidence = validated.evidence.filter((entry) =>
      (entry.kind === "source-file" || entry.kind === "user-input") && entry.path === testPath
    );
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
    if (!supportedTestLink(input.snapshot, link)) continue;
    const evidence = validated.evidence.filter((entry) =>
      (entry.kind === "source-file" || entry.kind === "user-input") &&
      (entry.path === link.testPath || entry.path === link.sourcePath)
    );
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
  );
}

function boundedPrompt(prompt: string): string {
  if (prompt.length <= MAX_SPECIALIST_PROMPT_CHARS && Buffer.byteLength(prompt, "utf8") <= MAX_SPECIALIST_PROMPT_CHARS) return prompt;
  const maxPrefixLength = Math.max(0, MAX_SPECIALIST_PROMPT_CHARS - BOUNDED_PROMPT_NOTE.length);
  let low = 0;
  let high = Math.min(prompt.length, maxPrefixLength);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${prompt.slice(0, middle)}${BOUNDED_PROMPT_NOTE}`;
    if (candidate.length <= MAX_SPECIALIST_PROMPT_CHARS && Buffer.byteLength(candidate, "utf8") <= MAX_SPECIALIST_PROMPT_CHARS) low = middle;
    else high = middle - 1;
  }
  return `${prompt.slice(0, low)}${BOUNDED_PROMPT_NOTE}`;
}

function packPrompt(input: {
  readonly specialist: BrownfieldSpecialistSpec;
  readonly snapshot: CodeIndexSnapshot;
  readonly summary: AssessmentSignalSummary;
  readonly excerpts: readonly BrownfieldExcerpt[];
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly truncation: BrownfieldPackTruncation;
}): { readonly prompt: string; readonly promptTruncated: boolean } {
  const evidence = uniqueEvidence(input.evidence);
  const excerpts = input.excerpts.map((excerpt) => ({
    kind: excerpt.kind,
    path: excerpt.path,
    ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
    factIds: [...excerpt.factIds],
    evidence: uniqueEvidence(excerpt.evidence),
    text: boundedText(excerpt.text, MAX_EXCERPT_CHARS)
  }));
  const packMarker = input.truncation.bounded
    ? `${BOUNDED_PACK_NOTE} excerpts_omitted=${input.truncation.excerptsOmitted} evidence_omitted=${input.truncation.evidenceOmitted}`
    : "[BOUNDED_PACK_COMPLETE]";
  const prompt = [
    `You are the ${input.specialist.name} assessor for a brownfield repository.`,
    packMarker,
    BROWNFIELD_SPECIALIST_SAFETY_CONTRACT,
    `Specialist pass: ${input.specialist.pass}. Focus: ${input.specialist.focus}.`,
    `Snapshot ID: ${input.snapshot.snapshotId}. Scope: ${input.snapshot.scope}.`,
    `Signal summary: ${JSON.stringify(input.summary)}.`,
    "Only the following bounded evidence pack is supplied; do not infer beyond it.",
    `Evidence references (bounded and deduplicated): ${JSON.stringify(evidence)}.`,
    `Excerpts (bounded and deduplicated): ${JSON.stringify(excerpts)}.`,
    "Return one JSON object with only `findings` and `assumptions` arrays."
  ].join("\n");
  const bounded = boundedPrompt(prompt);
  return { prompt: bounded, promptTruncated: bounded !== prompt };
}

function excerptsForPack(
  excerpts: readonly BrownfieldExcerpt[],
  evidence: readonly AssessmentEvidenceRef[]
): readonly BrownfieldExcerpt[] {
  const included = new Set(evidence.map(evidenceKey));
  return excerpts.flatMap((excerpt) => {
    const retainedEvidence = excerpt.evidence.filter((reference) => included.has(evidenceKey(reference)));
    if (retainedEvidence.length === 0) return [];
    const retainedFactIds = retainedEvidence
      .filter((reference): reference is Extract<AssessmentEvidenceRef, { readonly kind: "structural-fact" }> => reference.kind === "structural-fact")
      .map((reference) => reference.factId)
      .sort(compareStrings);
    const evidenceWasDropped = retainedEvidence.length !== excerpt.evidence.length;
    return [{
      ...excerpt,
      factIds: retainedFactIds,
      evidence: retainedEvidence,
      text: evidenceWasDropped ? `${boundedText(excerpt.text, Math.max(1, MAX_EXCERPT_CHARS - BOUNDED_EVIDENCE_NOTE.length))}${BOUNDED_EVIDENCE_NOTE}` : excerpt.text
    }];
  });
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
  const provenance = snapshotProvenance(snapshot);
  return roster.map((specialist) => {
    const allExcerpts = buildExcerpts(input, specialist, validated);
    const limitedExcerpts = allExcerpts.slice(0, MAX_EXCERPTS_PER_PACK);
    const allEvidence = uniqueEvidence([
      ...allExcerpts.flatMap((excerpt) => excerpt.evidence),
      ...validated.commandResults
    ]);
    const evidence = allEvidence.slice(0, MAX_EVIDENCE_PER_PACK);
    const excerpts = excerptsForPack(limitedExcerpts, evidence);
    const baseTruncation: BrownfieldPackTruncation = {
      bounded: allExcerpts.length > MAX_EXCERPTS_PER_PACK || allEvidence.length > MAX_EVIDENCE_PER_PACK,
      excerptsTotal: allExcerpts.length,
      excerptsIncluded: excerpts.length,
      excerptsOmitted: allExcerpts.length - excerpts.length,
      excerptsTruncated: allExcerpts.length > MAX_EXCERPTS_PER_PACK,
      evidenceTotal: allEvidence.length,
      evidenceIncluded: evidence.length,
      evidenceOmitted: allEvidence.length - evidence.length,
      evidenceTruncated: allEvidence.length > MAX_EVIDENCE_PER_PACK,
      promptTruncated: false
    };
    const packedPrompt = packPrompt({ specialist, snapshot, summary: validated.summary, excerpts, evidence, truncation: baseTruncation });
    const truncation: BrownfieldPackTruncation = {
      ...baseTruncation,
      promptTruncated: packedPrompt.promptTruncated,
      bounded: baseTruncation.bounded || packedPrompt.promptTruncated
    };
    return {
      specialist,
      snapshotId: snapshot.snapshotId,
      ...provenance,
      summary: validated.summary,
      excerpts,
      evidence,
      truncation,
      prompt: packedPrompt.prompt,
      promptHash: hashUnknown(packedPrompt.prompt),
      promptSize: packedPrompt.prompt.length,
      promptBytes: Buffer.byteLength(packedPrompt.prompt, "utf8")
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

function snapshotProvenance(snapshot: CodeIndexSnapshot): {
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
} {
  return {
    sourceFingerprint: snapshot.sourceFingerprint,
    semanticIndexSha256: hashUnknown(stableProtocolJson(snapshot)),
    semanticSqliteSha256: snapshot.sqlite.sha256
  };
}

function serializedSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value instanceof Error) {
    const code = (value as Error & { readonly code?: unknown }).code;
    return Buffer.byteLength(JSON.stringify({
      name: value.name,
      message: value.message,
      ...(code === undefined ? {} : { code })
    }), "utf8");
  }
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

function isSpecialistPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "findings" || key === "assumptions");
}

function unwrapSpecialistPayload(value: unknown): unknown {
  let current = value;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (isSpecialistPayload(current)) return current;
    if (typeof current === "string") {
      current = parseJsonText(current);
      continue;
    }
    if (!isRecord(current)) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    let next: unknown;
    for (const key of ["structuredOutput", "output", "text", "result", "payload"]) {
      if (current[key] !== undefined) {
        next = current[key];
        break;
      }
    }
    if (next === undefined) return undefined;
    current = next;
  }
  return undefined;
}

function specialistPayloadFrom(value: unknown): { readonly status: "succeeded" | "failed" | "blocked"; readonly payload?: unknown; readonly diagnostic: string } {
  if (isExecutionResult(value)) {
    if (value.status !== "succeeded") {
      return { status: value.status, diagnostic: value.summary || "Executor did not complete the specialist." };
    }
    const envelope = value as ExecutionResult & Record<string, unknown>;
    const structured = value.structuredOutput ?? envelope["output"] ?? envelope["text"];
    if (structured === undefined) {
      return { status: "failed", diagnostic: "Specialist executor completed without structured JSON output." };
    }
    try {
      const payload = unwrapSpecialistPayload(structured);
      if (payload === undefined) throw new Error("Specialist executor structured output did not contain a findings/assumptions object.");
      return {
        status: "succeeded",
        payload,
        diagnostic: ""
      };
    } catch (error) {
      return { status: "failed", diagnostic: safeDiagnostic(error) };
    }
  }
  if (typeof value === "string") {
    try {
      return { status: "succeeded", payload: unwrapSpecialistPayload(value), diagnostic: "" };
    } catch (error) {
      return { status: "failed", diagnostic: safeDiagnostic(error) };
    }
  }
  return { status: "succeeded", payload: value, diagnostic: "" };
}

function supportedEvidence(referenceInput: AssessmentEvidenceRef, support: EvidenceSupport): boolean {
  const reference = normalizedEvidenceReference(referenceInput);
  if (reference.kind === "source-file") return support.source.has(evidenceKey(reference));
  if (reference.kind === "structural-fact") return support.structural.has(evidenceKey(reference));
  if (reference.kind === "command-result") return support.command.has(evidenceKey(reference));
  return false;
}

function assertEvidenceClosure(evidence: readonly AssessmentEvidenceRef[], support: EvidenceSupport): void {
  if (evidence.length === 0) throw new Error("Specialist finding or assumption has no evidence.");
  for (const reference of evidence) {
    const parsed = normalizedEvidenceReference(reference);
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
  if (findingInputs.length > MAX_SPECIALIST_FINDINGS) throw new Error("Specialist findings exceeded the bounded output limit.");
  if (assumptionInputs.length > MAX_SPECIALIST_ASSUMPTIONS) throw new Error("Specialist assumptions exceeded the bounded output limit.");
  if (findingInputs.length === 0 && assumptionInputs.length === 0) throw new Error("Specialist returned empty output.");

  const assumptions: AssessmentAssumption[] = [];
  const assumptionIdMap = new Map<string, string>();
  for (const valueInput of assumptionInputs) {
    const parsed = parseSpecialistAssumption(valueInput);
    if (assumptionIdMap.has(parsed.id)) throw new Error("Specialist returned duplicate assumption IDs.");
    assertEvidenceClosure(parsed.evidence, support);
    const sanitized = parseSpecialistAssumption({
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
    const parsed = parseSpecialistFinding(valueInput);
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
    findings.push(parseSpecialistFinding({
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

function syntheticFailureEvidenceReference(assessmentId: string, specialist: BrownfieldSpecialistSpec): AssessmentEvidenceRef {
  return assessmentEvidenceRefSchema.parse({
    kind: "user-input",
    path: artifactPathSchema.parse(`${EXECUTION_ARTIFACT_ROOT}/${assessmentId}/${specialist.name}-pass-${specialist.pass}/failure-evidence.json`),
    note: "Synthetic user-input evidence for a failed, blocked, or invalid specialist result; explicit user input or command-result evidence is required for resolution."
  });
}

function fallbackEvidence(pack: BrownfieldExcerptPack, snapshot: CodeIndexSnapshot, assessmentId: string): readonly AssessmentEvidenceRef[] {
  const synthetic = syntheticFailureEvidenceReference(assessmentId, pack.specialist);
  if (pack.evidence.length > 0) return [...pack.evidence.slice(0, 1), synthetic];
  const fact = [...snapshot.symbols, ...snapshot.imports, ...snapshot.exports]
    .sort((left, right) => compareStrings(left.id, right.id))[0];
  if (fact === undefined) return [synthetic];
  return [
    assessmentEvidenceRefSchema.parse({
      kind: "structural-fact",
      path: snapshot.sqlite.path,
      sha256: snapshot.sqlite.sha256,
      factId: codeIndexFactIdSchema.parse(fact.id),
      note: "Structural snapshot evidence for an unknown specialist result."
    }),
    synthetic
  ];
}

function unknownAssumption(input: {
  readonly assessmentId: string;
  readonly specialist: BrownfieldSpecialistSpec;
  readonly diagnostic: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
}): AssessmentAssumption {
  const evidence = input.evidence.length > 0
    ? input.evidence
    : [syntheticFailureEvidenceReference(input.assessmentId, input.specialist)];
  const idDigest = createHash("sha256")
    .update([input.assessmentId, input.specialist.name, String(input.specialist.pass), input.diagnostic].join("\u0000"), "utf8")
    .digest("hex");
  const id = `asm_${idDigest.slice(0, 24)}`;
  return parseSpecialistAssumption({
    id,
    statement: boundedText(`The ${input.specialist.name} specialist pass ${input.specialist.pass} could not establish a supported conclusion: ${input.diagnostic}`, 2_000),
    confidence: "unknown",
    blocking: true,
    resolution: "Rerun this bounded specialist with a functioning executor and explicit evidence-backed output.",
    evidence: evidence.map(sanitizeEvidence)
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

function cleanupFailureResult(error: unknown): ExecutionResult {
  const diagnostic = safeDiagnostic(error);
  return {
    ok: false,
    status: "blocked",
    summary: `Adapter artifact cleanup failed; specialist execution is blocked. ${diagnostic}`,
    filesChanged: [],
    commandsRun: [],
    findings: [{
      id: "adapter-artifact-cleanup-failed",
      title: "Adapter artifact cleanup failed",
      body: `The isolated adapter artifact root was not removed. ${diagnostic}`,
      severity: "blocking"
    }]
  };
}

function assertNoRepositorySymlinks(snapshot: RepositorySnapshot): void {
  const symlinks = [...snapshot.entries()]
    .filter(([, entry]) => entry.kind === "symlink")
    .map(([relativePath]) => relativePath.length === 0 ? "repository root" : relativePath)
    .sort(compareStrings);
  if (symlinks.length === 0) return;
  const error = new Error(
    `Specialist execution is blocked because the repository contains symlinked paths: ${symlinks.slice(0, 8).join(", ")}${symlinks.length > 8 ? `, and ${symlinks.length - 8} more` : ""}.`
  ) as Error & { code?: string };
  error.code = "SPECIALIST_SYMLINK_BLOCKED";
  throw error;
}

function specialistAdapterHasStrictReadOnlyContainment(executor: ExecutionAdapterKind): boolean {
  // The generic Claude, Codex, Hermes, and Grok adapters expose CLI-level
  // read-only flags, but none provides an OS-level boundary that contains
  // detached or setsid descendants. Only non-process adapters are safe here.
  return executor === "fake" || executor === "manual";
}

function externalAdapterContainmentError(executor: ExecutionAdapterKind): Error & { readonly code: string } {
  const error = new Error(
    `External ${executor} specialist execution is blocked because no strict OS-level read-only containment is available.`
  ) as Error & { code: string };
  error.code = "SPECIALIST_CONTAINMENT_UNAVAILABLE";
  return error;
}

async function runWithExistingAdapter(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly pack: BrownfieldExcerptPack;
  readonly executor: ExecutionAdapterKind;
}): Promise<ExecutionResult> {
  const adapterArtifactRoot = await mkdtemp(path.join(tmpdir(), "legion-brownfield-adapter-"));
  let adapterResult: ExecutionResult | undefined;
  let executionFailure: { readonly error: unknown } | undefined;
  let repositoryBaseline: RepositorySnapshot | undefined;
  try {
    const artifacts = specialistArtifactPath(input.assessmentId, input.pack.specialist, "executor-result.json");
    const artifactPaths = [artifacts.context, artifacts.prompt, artifacts.result, artifacts.raw, artifacts.redacted];
    const resolvedPaths = await Promise.all(artifactPaths.map(async (artifactPath) => {
      const parsed = artifactPathSchema.parse(artifactPath);
      const resolved = await resolveProjectArtifactPath({ repositoryRoot: adapterArtifactRoot, artifactPath: parsed });
      return { parsed, absolutePath: resolved.absolutePath };
    }));
    const [context, prompt, result, raw, redacted] = resolvedPaths;
    if (context === undefined || prompt === undefined || result === undefined || raw === undefined || redacted === undefined) {
      throw new Error("Unable to prepare specialist adapter artifacts.");
    }
    await writeProjectTextFile({ repositoryRoot: adapterArtifactRoot, artifactPath: context.parsed, text: JSON.stringify({
      snapshotId: input.snapshot.snapshotId,
      summary: input.pack.summary,
      excerpts: input.pack.excerpts
    }) });
    await writeProjectTextFile({ repositoryRoot: adapterArtifactRoot, artifactPath: prompt.parsed, text: input.pack.prompt });
    const createdAt = new Date().toISOString();
    const task = syntheticTask({ assessmentId: input.assessmentId, specialist: input.pack.specialist, createdAt });
    const request: ExecutionRequest = {
      repositoryRoot: input.repositoryRoot,
      artifactRepositoryRoot: adapterArtifactRoot,
      changeId: task.changeId,
      runId: formatEntityId("run", `brownfield-${createHash("sha256").update(`${input.assessmentId}\u0000${input.pack.specialist.name}\u0000${input.pack.specialist.pass}`, "utf8").digest("hex").slice(0, 24)}`),
      task,
      mode: "review",
      executor: input.executor,
      readOnly: true,
      prompt: input.pack.prompt,
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
    // The adapter receives the real repository as its working directory. CLI
    // read-only flags are advisory, and snapshot/restore cannot contain a
    // detached or setsid descendant. Refuse external adapters unless their
    // implementation provides a strict OS-level boundary.
    repositoryBaseline = await snapshotRepository(input.repositoryRoot);
    assertNoRepositorySymlinks(repositoryBaseline);
    if (!specialistAdapterHasStrictReadOnlyContainment(input.executor)) {
      executionFailure = { error: externalAdapterContainmentError(input.executor) };
    } else {
      try {
        adapterResult = await adapterForKind(input.executor).run(request);
      } catch (error) {
        executionFailure = { error };
      }
    }
  } catch (error) {
    executionFailure = { error };
  }

  if (repositoryBaseline !== undefined) {
    let repositoryAfter: RepositorySnapshot | undefined;
    try {
      repositoryAfter = await snapshotRepository(input.repositoryRoot, { allowUnboundedFiles: true });
    } catch (error) {
      try {
        await restoreRepositoryFromBaseline(input.repositoryRoot, repositoryBaseline);
        executionFailure = {
          error: new Error(`Read-only external adapter state could not be inspected; baseline restoration completed before rejecting: ${safeDiagnostic(error)}.`)
        };
      } catch (cleanupError) {
        executionFailure = {
          error: new Error(`Read-only external adapter cleanup failed while inspecting repository state: ${safeDiagnostic(error)} Cleanup failed: ${safeDiagnostic(cleanupError)}.`)
        };
      }
    }
    if (repositoryAfter !== undefined) {
      const changed = changedRepositoryPaths(repositoryBaseline, repositoryAfter);
      if (changed.length > 0) {
        const mutation = boundedText(
          `External specialist adapter violated the read-only repository boundary: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? `, and ${changed.length - 8} more` : ""}.`,
          MAX_DIAGNOSTIC_CHARS
        );
        try {
          await restoreRepository(input.repositoryRoot, repositoryBaseline, repositoryAfter);
          executionFailure = { error: new Error(mutation) };
        } catch (error) {
          const restoreError = new Error(`${mutation} External adapter cleanup failed: ${safeDiagnostic(error)}.`) as Error & { code?: string };
          restoreError.code = "READ_ONLY_RESTORE_FAILED";
          executionFailure = { error: restoreError };
        }
      }
    }
  }

  try {
    await cleanupAdapterArtifacts(adapterArtifactRoot);
  } catch (error) {
    return cleanupFailureResult(error);
  }

  try {
    await access(adapterArtifactRoot);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      if (executionFailure !== undefined) throw executionFailure.error;
      if (adapterResult === undefined) throw new Error("Adapter completed without a result.");
      return adapterResult;
    }
    return cleanupFailureResult(error);
  }
  return cleanupFailureResult(new Error("Isolated adapter artifact root still exists after cleanup."));
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

async function drainPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (drained: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(drained);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    promise.then(() => finish(true), () => finish(true));
  });
}

function outputLimitError(outputSize: number): Error & { readonly code: string } {
  const error = new Error(`Specialist executor output exceeded the ${MAX_ADAPTER_OUTPUT_BYTES}-byte limit (${outputSize} bytes).`) as Error & { code: string };
  error.code = "SPECIALIST_OUTPUT_LIMIT";
  return error;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneAndFreeze(entry);
  return Object.freeze(clone) as T;
}

type RepositoryEntry = {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly digest: string;
  readonly mode: number;
  readonly bytes?: Buffer;
  readonly linkTarget?: string;
};

type RepositorySnapshot = ReadonlyMap<string, RepositoryEntry>;

interface RepositorySnapshotOptions {
  readonly allowUnboundedFiles?: boolean;
}

function repositoryAbsolutePath(root: string, relativePath: string): string {
  if (relativePath.includes("\u0000")) throw new Error("In-process specialist repository path contains a NUL byte.");
  const absoluteRoot = path.resolve(root);
  const absolutePath = relativePath.length === 0
    ? absoluteRoot
    : path.resolve(absoluteRoot, ...relativePath.split("/"));
  const relative = path.relative(absoluteRoot, absolutePath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`In-process specialist repository path escapes the repository root: ${relativePath}.`);
  }
  return absolutePath;
}

function repositoryMode(mode: number): number {
  return mode & 0o7777;
}

async function snapshotRepository(root: string, options: RepositorySnapshotOptions = {}): Promise<RepositorySnapshot> {
  const entries = new Map<string, RepositoryEntry>();
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return entries;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("In-process specialist repository root is not a directory.");
  }

  let snapshotBytes = 0;
  const addEntry = (relativePath: string, entry: RepositoryEntry): void => {
    if (entries.size >= MAX_READ_ONLY_SNAPSHOT_ENTRIES) {
      throw new Error(`In-process specialist repository snapshot exceeded ${MAX_READ_ONLY_SNAPSHOT_ENTRIES} entries.`);
    }
    entries.set(relativePath, entry);
  };
  addEntry("", { kind: "directory", digest: "", mode: repositoryMode(rootStat.mode) });

  const visit = async (absoluteRoot: string, relativeRoot: string): Promise<void> => {
    const children = (await readdir(absoluteRoot, { withFileTypes: true }))
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const child of children) {
      const absolutePath = path.join(absoluteRoot, child.name);
      const relativePath = relativeRoot.length === 0 ? child.name : `${relativeRoot}/${child.name}`;
      const stat = await lstat(absolutePath);
      if (stat.isDirectory()) {
        addEntry(relativePath, { kind: "directory", digest: "", mode: repositoryMode(stat.mode) });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (stat.isFile()) {
        const fileWithinBudget = Number.isSafeInteger(stat.size) &&
          stat.size <= MAX_READ_ONLY_SNAPSHOT_FILE_BYTES &&
          snapshotBytes + stat.size <= MAX_READ_ONLY_SNAPSHOT_BYTES;
        if (!fileWithinBudget) {
          if (options.allowUnboundedFiles !== true) {
            throw new Error(`In-process specialist repository file exceeds the bounded restoration limit: ${relativePath}.`);
          }
          addEntry(relativePath, {
            kind: "file",
            digest: `unavailable:${stat.size}`,
            mode: repositoryMode(stat.mode)
          });
          continue;
        }
        const bytes = await readFile(absolutePath);
        if (bytes.length > MAX_READ_ONLY_SNAPSHOT_FILE_BYTES || snapshotBytes + bytes.length > MAX_READ_ONLY_SNAPSHOT_BYTES) {
          if (options.allowUnboundedFiles !== true) {
            throw new Error(`In-process specialist repository file changed beyond the bounded restoration limit: ${relativePath}.`);
          }
          addEntry(relativePath, {
            kind: "file",
            digest: `unavailable:${bytes.length}`,
            mode: repositoryMode(stat.mode)
          });
          continue;
        }
        snapshotBytes += bytes.length;
        addEntry(relativePath, {
          kind: "file",
          digest: createHash("sha256").update(bytes).digest("hex"),
          mode: repositoryMode(stat.mode),
          bytes
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath);
        if (Buffer.byteLength(linkTarget, "utf8") > MAX_READ_ONLY_SYMLINK_BYTES) {
          if (options.allowUnboundedFiles !== true) {
            throw new Error(`In-process specialist repository symlink exceeds the bounded restoration limit: ${relativePath}.`);
          }
          addEntry(relativePath, {
            kind: "symlink",
            digest: "unavailable",
            mode: repositoryMode(stat.mode)
          });
          continue;
        }
        addEntry(relativePath, {
          kind: "symlink",
          digest: createHash("sha256").update(linkTarget, "utf8").digest("hex"),
          mode: repositoryMode(stat.mode),
          linkTarget
        });
        continue;
      }
      addEntry(relativePath, {
        kind: "other",
        digest: `${stat.mode}:${stat.size}`,
        mode: repositoryMode(stat.mode)
      });
    }
  };
  await visit(root, "");
  return entries;
}

function sameRepositoryEntry(left: RepositoryEntry, right: RepositoryEntry): boolean {
  return left.kind === right.kind &&
    left.digest === right.digest &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget;
}

function repositoryPathDepth(relativePath: string): number {
  return relativePath.length === 0 ? 0 : relativePath.split("/").length;
}

function repositoryChangeLabel(action: "added" | "removed" | "changed", relativePath: string): string {
  return `${action} ${relativePath.length === 0 ? "repository root" : relativePath}`;
}

function changedRepositoryPaths(before: RepositorySnapshot, after: RepositorySnapshot): string[] {
  const changed: string[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareStrings);
  for (const relativePath of paths) {
    const previous = before.get(relativePath);
    const current = after.get(relativePath);
    if (previous === undefined) changed.push(repositoryChangeLabel("added", relativePath));
    else if (current === undefined) changed.push(repositoryChangeLabel("removed", relativePath));
    else if (!sameRepositoryEntry(previous, current)) changed.push(repositoryChangeLabel("changed", relativePath));
  }
  return changed;
}

function mutationDiagnostic(changed: readonly string[]): string | undefined {
  if (changed.length === 0) return undefined;
  return boundedText(
    `In-process specialist callback violated the read-only repository boundary: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? `, and ${changed.length - 8} more` : ""}.`,
    MAX_DIAGNOSTIC_CHARS
  );
}

function addedSymlinkPaths(before: RepositorySnapshot, after: RepositorySnapshot): string[] {
  return [...after.entries()]
    .filter(([relativePath, entry]) => entry.kind === "symlink" && before.get(relativePath) === undefined)
    .map(([relativePath]) => repositoryChangeLabel("added", relativePath))
    .sort(compareStrings);
}

async function removeRepositoryEntry(root: string, relativePath: string): Promise<void> {
  if (relativePath.length === 0) throw new Error("Refusing to remove the in-process specialist repository root.");
  const absolutePath = repositoryAbsolutePath(root, relativePath);
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return;
    throw error;
  }
  await rm(absolutePath, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: false });
}

async function ensureRepositoryDirectory(root: string, relativePath: string): Promise<string> {
  const absoluteRoot = repositoryAbsolutePath(root, "");
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    if (!(isRecord(error) && error["code"] === "ENOENT")) throw error;
    await mkdir(absoluteRoot, { mode: 0o700 });
    rootStat = await lstat(absoluteRoot);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Cannot safely restore a repository directory through a non-directory root.");
  if (relativePath.length === 0) return absoluteRoot;

  const components = relativePath.split("/");
  let currentRelative = "";
  for (const component of components) {
    currentRelative = currentRelative.length === 0 ? component : `${currentRelative}/${component}`;
    const current = repositoryAbsolutePath(root, currentRelative);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!(isRecord(error) && error["code"] === "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Cannot safely restore through repository path ${currentRelative}.`);
  }
  return repositoryAbsolutePath(root, relativePath);
}

async function restoreFile(root: string, relativePath: string, entry: RepositoryEntry): Promise<void> {
  if (entry.bytes === undefined) throw new Error(`Missing bounded bytes for repository file ${relativePath}.`);
  const parentRelative = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  const parent = await ensureRepositoryDirectory(root, parentRelative);
  const absolutePath = repositoryAbsolutePath(root, relativePath);
  const temporaryRoot = await mkdtemp(path.join(parent, ".legion-read-only-restore-"));
  const temporaryPath = path.join(temporaryRoot, "entry");
  try {
    await writeFile(temporaryPath, entry.bytes, { mode: entry.mode });
    await chmod(temporaryPath, entry.mode);
    await rename(temporaryPath, absolutePath);
    await chmod(absolutePath, entry.mode);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function restoreSymlink(root: string, relativePath: string, entry: RepositoryEntry): Promise<void> {
  if (entry.linkTarget === undefined) throw new Error(`Missing bounded link target for repository symlink ${relativePath}.`);
  const parentRelative = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  const parent = await ensureRepositoryDirectory(root, parentRelative);
  const absolutePath = repositoryAbsolutePath(root, relativePath);
  const temporaryRoot = await mkdtemp(path.join(parent, ".legion-read-only-restore-"));
  const temporaryPath = path.join(temporaryRoot, "entry");
  try {
    await symlink(entry.linkTarget, temporaryPath);
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function clearRepositoryRoot(root: string): Promise<void> {
  const absoluteRoot = repositoryAbsolutePath(root, "");
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    if (!(isRecord(error) && error["code"] === "ENOENT")) throw error;
    await mkdir(absoluteRoot, { mode: 0o700 });
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    await rm(absoluteRoot, { recursive: false, force: false });
    await mkdir(absoluteRoot, { mode: 0o700 });
    return;
  }
  const children = (await readdir(absoluteRoot, { withFileTypes: true }))
    .sort((left, right) => compareStrings(left.name, right.name));
  for (const child of children) await removeRepositoryEntry(root, child.name);
}

async function prepareRepositoryTreeForRestore(root: string): Promise<void> {
  const absoluteRoot = repositoryAbsolutePath(root, "");
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      await mkdir(absoluteRoot, { mode: 0o700 });
      return;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;

  const queue = [absoluteRoot];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (visited >= MAX_READ_ONLY_SNAPSHOT_ENTRIES) {
      throw new Error(`Read-only repository cleanup exceeded ${MAX_READ_ONLY_SNAPSHOT_ENTRIES} directory entries while restoring access.`);
    }
    visited += 1;
    // The saved root/parent path remains inside the repository. Restoring
    // owner permissions before traversal lets cleanup proceed after a child
    // or the root was chmod'd to 000 by an adapter or callback.
    await chmod(current, 0o700);
    const children = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const childPath = path.join(current, child.name);
      await chmod(childPath, 0o700);
      queue.push(childPath);
    }
  }
}

async function restoreRepositoryFromBaseline(root: string, before: RepositorySnapshot): Promise<void> {
  if ([...before.values()].some((entry) => entry.kind === "other")) {
    throw new Error("Cannot safely restore a repository containing non-regular entries from a bounded snapshot.");
  }
  await prepareRepositoryTreeForRestore(root);
  await clearRepositoryRoot(root);
  const pathsToRestore = [...before.keys()]
    .sort((left, right) => repositoryPathDepth(left) - repositoryPathDepth(right) || compareStrings(left, right));
  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    if (previous === undefined) continue;
    if (previous.kind === "directory") {
      const absolutePath = await ensureRepositoryDirectory(root, relativePath);
      await chmod(absolutePath, 0o700);
    }
  }
  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    if (previous === undefined) continue;
    if (previous.kind === "file") {
      await restoreFile(root, relativePath, previous);
    } else if (previous.kind === "symlink") {
      await restoreSymlink(root, relativePath, previous);
    }
  }
  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    if (previous === undefined) continue;
    if (previous.kind === "directory") {
      const absolutePath = await ensureRepositoryDirectory(root, relativePath);
      await chmod(absolutePath, previous.mode);
    }
  }
  const verified = await snapshotRepository(root);
  const residual = changedRepositoryPaths(before, verified);
  if (residual.length > 0) {
    throw new Error(`Read-only repository cleanup did not restore the original state: ${residual.slice(0, 8).join(", ")}${residual.length > 8 ? `, and ${residual.length - 8} more` : ""}.`);
  }
}

async function restoreRepository(
  root: string,
  before: RepositorySnapshot,
  after: RepositorySnapshot
): Promise<void> {
  const changed = changedRepositoryPaths(before, after);
  if (changed.length === 0) return;

  // Special files cannot be reconstructed from bounded metadata. Refuse to
  // claim cleanup if one was deleted or changed instead of risking a partial
  // and inaccurate restoration.
  for (const [relativePath, previous] of before.entries()) {
    if (previous.kind !== "other") continue;
    const current = after.get(relativePath);
    if (current === undefined || !sameRepositoryEntry(previous, current)) {
      throw new Error(`Cannot safely restore non-regular repository entry ${relativePath.length === 0 ? "repository root" : relativePath}.`);
    }
  }

  const pathsToRestore = [...before.keys()]
    .sort((left, right) => repositoryPathDepth(left) - repositoryPathDepth(right) || compareStrings(left, right));
  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    const current = after.get(relativePath);
    if (previous?.kind === "directory" && (current === undefined || current.kind === "directory")) {
      const absolutePath = await ensureRepositoryDirectory(root, relativePath);
      await chmod(absolutePath, 0o700);
    }
  }

  const pathsToRemove = [...after.keys()]
    .filter((relativePath) => {
      if (relativePath.length === 0) return false;
      const previous = before.get(relativePath);
      const current = after.get(relativePath);
      return current !== undefined && (previous === undefined || previous.kind !== current.kind);
    })
    .sort((left, right) => repositoryPathDepth(right) - repositoryPathDepth(left) || compareStrings(left, right));
  for (const relativePath of pathsToRemove) await removeRepositoryEntry(root, relativePath);

  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    if (previous === undefined) continue;
    const current = after.get(relativePath);
    if (previous.kind === "file") {
      if (current === undefined || current.kind !== "file" || !sameRepositoryEntry(previous, current)) {
        await restoreFile(root, relativePath, previous);
      }
    } else if (previous.kind === "symlink") {
      if (current === undefined || current.kind !== "symlink" || !sameRepositoryEntry(previous, current)) {
        await restoreSymlink(root, relativePath, previous);
      }
    }
  }
  for (const relativePath of pathsToRestore) {
    const previous = before.get(relativePath);
    if (previous === undefined) continue;
    if (previous.kind === "directory") {
      const absolutePath = await ensureRepositoryDirectory(root, relativePath);
      await chmod(absolutePath, previous.mode);
    }
  }

  const verified = await snapshotRepository(root);
  const residual = changedRepositoryPaths(before, verified);
  if (residual.length > 0) {
    throw new Error(`Read-only repository cleanup did not restore the original state: ${residual.slice(0, 8).join(", ")}${residual.length > 8 ? `, and ${residual.length - 8} more` : ""}.`);
  }
}

async function runReadOnlyInProcessCallback(input: {
  readonly repositoryRoot: string;
  readonly execute: BrownfieldSpecialistExecutor;
  readonly request: BrownfieldSpecialistExecutionRequest;
  readonly timeoutMs: number;
  readonly baseline?: RepositorySnapshot;
}): Promise<unknown> {
  const before = input.baseline ?? await snapshotRepository(input.repositoryRoot);
  assertNoRepositorySymlinks(before);
  // Keep the callback promise alive after the observation timeout. An
  // in-process callback cannot be cancelled safely, so returning at the race
  // boundary would let it mutate the repository while the next specialist is
  // already running. Drain it for a bounded interval; if it still does not
  // settle, restore the baseline and abort the remaining roster.
  const callbackPromise = Promise.resolve().then(() => input.execute(input.request));
  let result: unknown;
  let callbackError: unknown;
  try {
    result = await withTimeout(callbackPromise, input.timeoutMs);
  } catch (error) {
    callbackError = error;
    if (isRecord(error) && error["code"] === "SPECIALIST_TIMEOUT") {
      // Await the original promise long enough to consume a late rejection,
      // but never let an uncooperative callback hold the roster forever.
      const drained = await drainPromise(callbackPromise, SPECIALIST_TIMEOUT_DRAIN_MS);
      if (!drained) {
        try {
          await restoreRepositoryFromBaseline(input.repositoryRoot, before);
        } catch (cleanupError) {
          const restoreError = new Error(`Read-only repository cleanup failed after specialist timeout: ${safeDiagnostic(cleanupError)}.`) as Error & { code?: string };
          restoreError.code = "READ_ONLY_RESTORE_FAILED";
          throw restoreError;
        }
        const drainError = timeoutError(input.timeoutMs) as Error & { code?: string };
        drainError.code = "SPECIALIST_TIMEOUT_DRAIN";
        throw drainError;
      }
    }
  }

  let after: RepositorySnapshot;
  try {
    after = await snapshotRepository(input.repositoryRoot, { allowUnboundedFiles: true });
  } catch (error) {
    try {
      await restoreRepositoryFromBaseline(input.repositoryRoot, before);
    } catch (cleanupError) {
      const restoreError = new Error(`Read-only repository cleanup failed while inspecting callback state: ${safeDiagnostic(error)} Cleanup failed: ${safeDiagnostic(cleanupError)}.`) as Error & { code?: string };
      restoreError.code = "READ_ONLY_RESTORE_FAILED";
      throw restoreError;
    }
    throw new Error(`Read-only callback state exceeded the bounded inspection limit; cleanup restored the baseline before rejecting: ${safeDiagnostic(error)}.`);
  }
  const mutation = mutationDiagnostic(changedRepositoryPaths(before, after));
  if (mutation !== undefined) {
    // If the callback created a symlink during execution, restoration cannot
    // undo writes that flowed through it to an outside target. Detect that
    // before cleanup and mark the run blocked with an explicit symlink
    // diagnostic; the repository snapshot is still restored below.
    const createdSymlinks = addedSymlinkPaths(before, after);
    let cleanupError: Error | undefined;
    try {
      await restoreRepository(input.repositoryRoot, before, after);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(safeDiagnostic(error));
    }
    if (cleanupError !== undefined) {
      const restoreError = new Error(`${mutation} Read-only repository cleanup failed: ${safeDiagnostic(cleanupError)}.`) as Error & { code?: string };
      restoreError.code = "READ_ONLY_RESTORE_FAILED";
      throw restoreError;
    }
    const symlinkDiagnostic = createdSymlinks.length === 0
      ? mutation
      : `In-process specialist callback created repository symlink(s) during execution: ${createdSymlinks.slice(0, 8).join(", ")}${createdSymlinks.length > 8 ? `, and ${createdSymlinks.length - 8} more` : ""}. External writes through those links cannot be undone; the result is blocked and the repository was restored.`;
    const diagnostic = createdSymlinks.length > 0
      ? symlinkDiagnostic
      : callbackError === undefined
        ? mutation
        : `${safeDiagnostic(callbackError)} ${mutation}`;
    const mutationError = new Error(diagnostic) as Error & { code?: string };
    if (createdSymlinks.length > 0) {
      // A mid-run symlink is the most severe read-only violation and always
      // yields a blocked status, regardless of any concurrent callback error.
      mutationError.code = "SPECIALIST_SYMLINK_BLOCKED";
    } else if (isRecord(callbackError) && typeof callbackError["code"] === "string") {
      mutationError.code = callbackError["code"];
    }
    throw mutationError;
  }
  if (callbackError !== undefined) throw callbackError;
  return result;
}

function evidenceSupportForPack(
  pack: BrownfieldExcerptPack
): EvidenceSupport {
  const source = new Set<string>();
  const structural = new Set<string>();
  const command = new Set<string>();
  const add = (referenceInput: AssessmentEvidenceRef): void => {
    const reference = normalizedEvidenceReference(referenceInput);
    if (reference.kind === "source-file") source.add(evidenceKey(reference));
    else if (reference.kind === "structural-fact") {
      structural.add(evidenceKey(reference));
      structural.add([reference.kind, reference.path, "", reference.factId].join("\u0000"));
    } else if (reference.kind === "command-result") command.add(evidenceKey(reference));
  };
  for (const reference of pack.evidence) add(reference);
  return { source, structural, command };
}

async function runOne(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly executor: ExecutionAdapterKind;
  readonly pack: BrownfieldExcerptPack;
  readonly execute: BrownfieldSpecialistExecutor | undefined;
  readonly readOnlyBaseline?: RepositorySnapshot;
  readonly timeoutMs: number;
}): Promise<{
  readonly record: BrownfieldSpecialistExecutionRecord;
  readonly parsed?: ParsedSpecialistOutput;
  readonly diagnostic?: string;
  readonly abortRemaining?: boolean;
}> {
  const { pack } = input;
  const request = cloneAndFreeze<BrownfieldSpecialistExecutionRequest>({
    repositoryRoot: input.repositoryRoot,
    assessmentId: input.assessmentId,
    snapshotId: pack.snapshotId,
    specialist: { ...pack.specialist },
    summary: { ...pack.summary },
    evidence: pack.evidence.map(sanitizeEvidence),
    excerptMetadata: pack.excerpts.map((excerpt) => ({
      path: excerpt.path,
      ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
      factIds: [...excerpt.factIds]
    })),
    prompt: pack.prompt,
    promptHash: pack.promptHash,
    sourceFingerprint: pack.sourceFingerprint,
    semanticIndexSha256: pack.semanticIndexSha256,
    semanticSqliteSha256: pack.semanticSqliteSha256,
    executor: input.executor
  });
  const support = evidenceSupportForPack(pack);
  let outcome: SpecialistRunOutcome;
  let observedOutputSize: number | undefined;
  let abortRemaining = false;
  try {
    let raw: unknown;
    if (input.execute === undefined) {
      raw = await runWithExistingAdapter({
        repositoryRoot: input.repositoryRoot,
        assessmentId: input.assessmentId,
        snapshot: input.snapshot,
        pack,
        executor: input.executor
      });
    } else {
      raw = await runReadOnlyInProcessCallback({
        repositoryRoot: input.repositoryRoot,
        execute: input.execute,
        request,
        timeoutMs: input.timeoutMs,
        ...(input.readOnlyBaseline === undefined ? {} : { baseline: input.readOnlyBaseline })
      });
    }
    observedOutputSize = serializedSize(raw);
    if (input.execute !== undefined && observedOutputSize > MAX_ADAPTER_OUTPUT_BYTES) throw outputLimitError(observedOutputSize);
    const parsedEnvelope = specialistPayloadFrom(raw);
    outcome = { status: parsedEnvelope.status, raw, ...(parsedEnvelope.payload === undefined ? {} : { payload: parsedEnvelope.payload }), diagnostic: parsedEnvelope.diagnostic };
  } catch (error) {
    const diagnostic = safeDiagnostic(error);
    const errorCode = (error as { readonly code?: unknown })?.code;
    abortRemaining = errorCode === "READ_ONLY_RESTORE_FAILED" || errorCode === "SPECIALIST_TIMEOUT_DRAIN";
    outcome = {
      status: errorCode === "SPECIALIST_TIMEOUT" ||
        errorCode === "SPECIALIST_TIMEOUT_DRAIN" ||
        errorCode === "SPECIALIST_SYMLINK_BLOCKED" ||
        errorCode === "SPECIALIST_CONTAINMENT_UNAVAILABLE"
        ? "blocked"
        : "failed",
      raw: error,
      diagnostic
    };
  }

  let parsed: ParsedSpecialistOutput | undefined;
  let diagnostic = outcome.diagnostic;
  let status = outcome.status;
  if (status === "succeeded") {
    try {
      parsed = normalizeSpecialistOutput({ value: outcome.payload, specialist: pack.specialist, support });
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
    sourceFingerprint: pack.sourceFingerprint,
    semanticIndexSha256: pack.semanticIndexSha256,
    semanticSqliteSha256: pack.semanticSqliteSha256,
    summary: pack.summary,
    evidence,
    excerptPaths: pack.excerpts.map((excerpt) => ({
      path: excerpt.path,
      ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
      factIds: excerpt.factIds
    })),
    truncation: pack.truncation,
    promptHash: pack.promptHash,
    promptSize: pack.promptSize,
    promptBytes: pack.promptBytes,
    resultHash: hashExecutionOutcome(outcome),
    outputSize: observedOutputSize ?? serializedSize(outcome.raw),
    diagnostic: status === "succeeded" ? "" : boundedText(diagnostic || "Specialist output was rejected.", MAX_DIAGNOSTIC_CHARS)
  };
  return {
    record,
    ...(parsed === undefined ? {} : { parsed }),
    ...(status === "succeeded" ? {} : { diagnostic: record.diagnostic }),
    ...(abortRemaining ? { abortRemaining: true } : {})
  };
}

function unexecutedRecord(input: {
  readonly pack: BrownfieldExcerptPack;
  readonly snapshot: CodeIndexSnapshot;
  readonly executor: ExecutionAdapterKind;
  readonly execute: BrownfieldSpecialistExecutor | undefined;
  readonly status: "failed" | "blocked";
  readonly diagnostic: string;
}): BrownfieldSpecialistExecutionRecord {
  const diagnostic = boundedText(input.diagnostic, MAX_DIAGNOSTIC_CHARS);
  return {
    specialist: input.pack.specialist,
    executor: input.executor,
    transport: input.execute === undefined ? "adapter" : "in-process",
    status: input.status,
    snapshotId: input.snapshot.snapshotId,
    sourceFingerprint: input.pack.sourceFingerprint,
    semanticIndexSha256: input.pack.semanticIndexSha256,
    semanticSqliteSha256: input.pack.semanticSqliteSha256,
    summary: input.pack.summary,
    evidence: input.pack.evidence,
    excerptPaths: input.pack.excerpts.map((excerpt) => ({
      path: excerpt.path,
      ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
      factIds: excerpt.factIds
    })),
    truncation: input.pack.truncation,
    promptHash: input.pack.promptHash,
    promptSize: input.pack.promptSize,
    promptBytes: input.pack.promptBytes,
    resultHash: hashUnknown({ status: input.status, diagnostic }),
    outputSize: 0,
    diagnostic
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
  attachCoverageSourceHashes(snapshot, await inventoryHashesForSnapshot(input.repositoryRoot, snapshot));
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
  const packs = buildBrownfieldExcerptPacks(packInput);
  const records: BrownfieldSpecialistExecutionRecord[] = [];
  const findings: AssessmentFinding[] = [];
  const assumptions: AssessmentAssumption[] = [];
  const diagnostics: string[] = [];
  let readOnlyBaseline: RepositorySnapshot | undefined;
  let baselineFailure: string | undefined;
  if (input.execute !== undefined) {
    try {
      readOnlyBaseline = await snapshotRepository(input.repositoryRoot);
    } catch (error) {
      baselineFailure = `In-process specialist baseline could not be captured: ${safeDiagnostic(error)}.`;
    }
  }
  const seenFindingIds = new Set<string>();
  const seenAssumptionIds = new Set<string>();
  const appendFailure = (pack: BrownfieldExcerptPack, record: BrownfieldSpecialistExecutionRecord, diagnosticInput: string): void => {
    const diagnostic = diagnosticInput || "Specialist execution failed.";
    records.push(record);
    const evidence = fallbackEvidence(pack, snapshot, assessmentId);
    try {
      const assumption = unknownAssumption({ assessmentId, specialist: pack.specialist, diagnostic, evidence });
      if (!seenAssumptionIds.has(assumption.id)) {
        seenAssumptionIds.add(assumption.id);
        assumptions.push(assumption);
      }
    } catch (error) {
      diagnostics.push(safeDiagnostic(error));
    }
    const specialistDiagnostic = `${pack.specialist.name} pass ${pack.specialist.pass}: ${diagnostic}`;
    if (!diagnostics.includes(specialistDiagnostic)) diagnostics.push(specialistDiagnostic);
  };

  if (baselineFailure !== undefined) {
    for (const pack of packs) {
      appendFailure(pack, unexecutedRecord({
        pack,
        snapshot,
        executor: selected,
        execute: input.execute,
        status: "failed",
        diagnostic: baselineFailure
      }), baselineFailure);
    }
  }

  for (const [packIndex, pack] of packs.entries()) {
    if (baselineFailure !== undefined) break;
    const run = await runOne({
      repositoryRoot: input.repositoryRoot,
      assessmentId,
      snapshot,
      executor: selected,
      pack,
      execute: input.execute,
      ...(readOnlyBaseline === undefined ? {} : { readOnlyBaseline }),
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
    if (parsed === undefined) {
      const diagnostic = run.diagnostic ?? record.diagnostic;
      appendFailure(pack, record, diagnostic);
      if (run.abortRemaining === true) {
        const remainingDiagnostic = `Specialist dispatch halted after ${pack.specialist.name} pass ${pack.specialist.pass}: repository restoration did not complete safely.`;
        for (const remainingPack of packs.slice(packIndex + 1)) {
          appendFailure(remainingPack, unexecutedRecord({
            pack: remainingPack,
            snapshot,
            executor: selected,
            execute: input.execute,
            status: "blocked",
            diagnostic: remainingDiagnostic
          }), remainingDiagnostic);
        }
        break;
      }
      continue;
    }
    records.push(record);
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
