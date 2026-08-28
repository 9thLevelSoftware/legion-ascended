import { createHash } from "node:crypto";

import {
  assessmentAssumptionIdSchema,
  assessmentAssumptionSchema,
  assessmentConfidenceSchema,
  assessmentEvidenceRefSchema,
  assessmentFindingIdSchema,
  assessmentFindingSchema,
  assessmentSeveritySchema,
  assessmentSignalSummarySchema,
  artifactPathSchema,
  type AssessmentAssumption,
  type AssessmentConfidence,
  type AssessmentEvidenceRef,
  type AssessmentFinding,
  type AssessmentSeverity
} from "@legion/protocol";
import { stableProtocolJson } from "@legion/artifacts";

import type { BrownfieldSignals } from "./brownfield-signals.js";
import { redactBrownfieldSpecialistText } from "./brownfield-specialists.js";
import type {
  BrownfieldSpecialistExecutionRecord,
  BrownfieldSpecialistsResult
} from "./brownfield-specialists.js";

/** The machine-readable result of the deterministic brownfield synthesis pass. */
export interface BrownfieldDesign {
  readonly title: string;
  readonly executiveSummary: string;
  readonly currentArchitecture: string;
  readonly evidenceBackedStrengths: readonly string[];
  readonly prioritizedFindings: readonly AssessmentFinding[];
  readonly assumptionsRequiringInput: readonly AssessmentAssumption[];
  readonly improvementPlan: readonly BrownfieldImprovementItem[];
  readonly nonGoals: readonly string[];
  readonly behavioralProofGaps: readonly string[];
  readonly openQuestions: readonly string[];
}

export interface BrownfieldImprovementItem {
  readonly id: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly objective: string;
  readonly rationale: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly prerequisites: readonly string[];
  readonly verification: readonly string[];
}

/**
 * Synthesis deliberately accepts partial specialist results. A failed or
 * unavailable specialist is useful evidence in its own right, and callers
 * should not have to manufacture an otherwise-empty result just to preserve
 * that fact.
 */
export interface BrownfieldSynthesisInput {
  readonly signals?: BrownfieldSignals | null;
  readonly specialists?: Partial<BrownfieldSpecialistsResult> | readonly AssessmentFinding[] | null;
  readonly findings?: readonly AssessmentFinding[];
  readonly assumptions?: readonly AssessmentAssumption[];
  readonly specialistFindings?: readonly AssessmentFinding[];
  readonly specialistAssumptions?: readonly AssessmentAssumption[];
  readonly commandResults?: readonly AssessmentEvidenceRef[];
  readonly unrunCommands?: readonly string[];
  readonly unsupportedAreas?: readonly string[];
  readonly strengths?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly title?: string;
  readonly assessmentId?: string;
}

const MAX_TITLE_CHARS = 256;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_STRENGTHS = 64;
const MAX_FINDINGS = 2_000;
const MAX_ASSUMPTIONS = 256;
const MAX_IMPROVEMENTS = 2_000;
const MAX_GAPS = 256;
const MAX_QUESTIONS = 256;
const MAX_STRING_CHARS = 4_000;
const SYNTHESIS_EVIDENCE_PATH = ".legion/project/assessment/synthesis-input.json";

const SEVERITY_ORDER: Readonly<Record<AssessmentSeverity, number>> = {
  critical: 0,
  major: 1,
  moderate: 2,
  minor: 3,
  informational: 4
};

const CONFIDENCE_ORDER: Readonly<Record<AssessmentConfidence, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  unknown: 3
};

const EMPTY_SUMMARY = {
  sourceFiles: 0,
  coverageFiles: 0,
  symbols: 0,
  imports: 0,
  exports: 0,
  testFiles: 0,
  testToSourceLinks: 0,
  dependencyEdges: 0,
  highRiskSignals: 0,
  unsupportedSignals: 0
};

type FindingCandidate = AssessmentFinding & { readonly _sourceOrder: number };
type AssumptionAccumulator = {
  readonly values: AssessmentAssumption[];
  readonly byKey: Map<string, AssessmentAssumption>;
  readonly ids: Set<string>;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function redactText(value: string): string {
  // Synthesis carries specialist prose forward, so apply a final bounded
  // redaction even when a caller did not use the specialist orchestrator.
  return redactBrownfieldSpecialistText(value)
    .replace(/\b(?:api[_-]?key|api[_-]?secret|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)\b\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|gho|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
}

function boundedText(value: unknown, limit: number, fallback = "Unknown"): string {
  const source = typeof value === "string" ? value : fallback;
  const sanitized = redactText(source).replace(/\r\n?/gu, "\n").trim();
  if (sanitized.length <= limit) return sanitized || fallback;
  const marker = " …[TRUNCATED]";
  return `${sanitized.slice(0, Math.max(1, limit - marker.length))}${marker}`;
}

function hash24(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validConfidence(value: unknown): AssessmentConfidence {
  const parsed = assessmentConfidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function validSeverity(value: unknown): AssessmentSeverity {
  const parsed = assessmentSeveritySchema.safeParse(value);
  return parsed.success ? parsed.data : "moderate";
}

function validSpecialist(value: unknown): AssessmentFinding["specialist"] {
  return value === "architecture" || value === "code" || value === "tests" ||
    value === "security" || value === "product-intent" || value === "documentation"
    ? value
    : "code";
}

function evidenceIdentity(reference: AssessmentEvidenceRef): string {
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
  return `${evidenceIdentity(reference)}\u0000${reference.note}`;
}

function normalizeEvidence(values: readonly unknown[] | undefined): AssessmentEvidenceRef[] {
  const byIdentity = new Map<string, AssessmentEvidenceRef>();
  for (const value of values ?? []) {
    const parsed = assessmentEvidenceRefSchema.safeParse(value);
    if (!parsed.success) continue;
    const candidate = parsed.data;
    const sanitized = assessmentEvidenceRefSchema.parse({ ...candidate, note: boundedText(candidate.note, 512) });
    const key = evidenceIdentity(sanitized);
    const existing = byIdentity.get(key);
    if (existing === undefined || compareStrings(sanitized.note, existing.note) < 0) byIdentity.set(key, sanitized);
  }
  return [...byIdentity.values()].sort((left, right) => compareStrings(evidenceSortKey(left), evidenceSortKey(right)));
}

function fallbackEvidence(note: string): AssessmentEvidenceRef {
  return assessmentEvidenceRefSchema.parse({
    kind: "user-input",
    path: artifactPathSchema.parse(SYNTHESIS_EVIDENCE_PATH),
    note: boundedText(note, 512)
  });
}

function signalEvidence(signal: { readonly evidence?: readonly AssessmentEvidenceRef[] }, fallback: string): AssessmentEvidenceRef[] {
  const evidence = normalizeEvidence(signal.evidence);
  return evidence.length > 0 ? evidence.slice(0, 128) : [fallbackEvidence(fallback)];
}

function findingSemanticKey(finding: AssessmentFinding): string {
  return JSON.stringify({
    title: normalizedText(finding.title),
    statement: normalizedText(finding.statement),
    severity: finding.severity,
    confidence: finding.confidence,
    recommendation: normalizedText(finding.recommendation),
    evidence: [...finding.evidence].map(evidenceIdentity).sort(compareStrings),
    assumptions: [...finding.assumptions].sort(compareStrings)
  });
}

function findingTieKey(finding: AssessmentFinding): string {
  return [
    findingSemanticKey(finding),
    finding.specialist,
    finding.id
  ].join("\u0000");
}

function sourcePathKey(finding: AssessmentFinding): string {
  const sourcePaths = finding.evidence
    .filter((reference) => reference.kind === "source-file")
    .map((reference) => reference.path)
    .sort(compareStrings);
  const paths = (sourcePaths.length > 0 ? sourcePaths : finding.evidence.map((reference) => reference.path)).sort(compareStrings);
  return paths[0] ?? "~";
}

function factIdKey(finding: AssessmentFinding): string {
  const factIds = finding.evidence
    .filter((reference): reference is Extract<AssessmentEvidenceRef, { readonly kind: "structural-fact" }> => reference.kind === "structural-fact")
    .map((reference) => reference.factId)
    .sort(compareStrings);
  return factIds[0] ?? "~";
}

function findingRank(left: AssessmentFinding, right: AssessmentFinding): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence] ||
    right.evidence.length - left.evidence.length ||
    compareStrings(sourcePathKey(left), sourcePathKey(right)) ||
    compareStrings(factIdKey(left), factIdKey(right)) ||
    compareStrings(findingTieKey(left), findingTieKey(right));
}

function deterministicFindingId(input: {
  readonly specialist: string;
  readonly title: string;
  readonly statement: string;
  readonly severity: AssessmentSeverity;
  readonly evidence: readonly AssessmentEvidenceRef[];
}): string {
  return `af_${hash24(JSON.stringify({
    specialist: input.specialist,
    title: normalizedText(input.title),
    statement: normalizedText(input.statement),
    severity: input.severity,
    evidence: input.evidence.map(evidenceIdentity).sort(compareStrings)
  }))}`;
}

function normalizeFinding(value: unknown, sourceOrder: number): FindingCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const title = boundedText(value["title"], 256, "Unnamed finding");
  const statement = boundedText(value["statement"], 4_000, "The evidence requires further investigation.");
  const recommendation = boundedText(value["recommendation"], 4_000, "Investigate the bounded evidence before changing source.");
  const severity = validSeverity(value["severity"]);
  const confidence = validConfidence(value["confidence"]);
  const specialist = validSpecialist(value["specialist"]);
  const evidence = normalizeEvidence(Array.isArray(value["evidence"]) ? value["evidence"] : undefined);
  const retainedEvidence = evidence.length > 0
    ? evidence.slice(0, 128)
    : [fallbackEvidence(`Evidence is required to validate finding '${title}'.`)];
  const idCandidate = typeof value["id"] === "string" && assessmentFindingIdSchema.safeParse(value["id"]).success
    ? value["id"]
    : deterministicFindingId({ specialist, title, statement, severity, evidence: retainedEvidence });
  const assumptions = Array.isArray(value["assumptions"])
    ? value["assumptions"].filter((entry): entry is string => typeof entry === "string" && assessmentAssumptionIdSchema.safeParse(entry).success)
    : [];
  const parsed = assessmentFindingSchema.safeParse({
    id: idCandidate,
    specialist,
    title,
    statement,
    severity,
    confidence,
    evidence: retainedEvidence,
    assumptions: [...new Set(assumptions)],
    recommendation
  });
  if (!parsed.success) return undefined;
  return { ...parsed.data, _sourceOrder: sourceOrder };
}

function deterministicSignalFinding(input: {
  readonly code: string;
  readonly statement: string;
  readonly severity: AssessmentSeverity;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly specialist: AssessmentFinding["specialist"];
}): AssessmentFinding {
  const title = `Structural signal: ${boundedText(input.code, 256, "unknown")}`;
  const statement = boundedText(input.statement, 4_000, "A deterministic signal requires review.");
  const evidence = signalEvidence({ evidence: input.evidence }, `Deterministic evidence for ${input.code}.`);
  const id = deterministicFindingId({ ...input, title, statement });
  return assessmentFindingSchema.parse({
    id,
    specialist: input.specialist,
    title,
    statement,
    severity: input.severity,
    confidence: "high",
    evidence,
    assumptions: [],
    recommendation: boundedText(`Review the ${input.code} signal and verify its impact before making changes.`, 4_000)
  });
}

function signalFindings(signals: NormalizedSignals): AssessmentFinding[] {
  const architecture = signals.architectureSignals.map((signal) => deterministicSignalFinding({
    ...signal,
    specialist: "architecture"
  }));
  const risks = signals.riskSignals.map((signal) => {
    const security = /credential|secret|security|input|supply-chain/iu.test(signal.code);
    return deterministicSignalFinding({ ...signal, specialist: security ? "security" : "code" });
  });
  return [...architecture, ...risks];
}

function normalizeAssumption(value: unknown, fallback: AssessmentEvidenceRef[], seed: string): AssessmentAssumption | undefined {
  if (!isRecord(value)) return undefined;
  const evidence = normalizeEvidence(Array.isArray(value["evidence"]) ? value["evidence"] : undefined);
  const retainedEvidence = evidence.length > 0 ? evidence.slice(0, 64) : fallback.slice(0, 64);
  const statement = boundedText(value["statement"], 2_000, "An assessment assumption requires owner input.");
  const confidence = validConfidence(value["confidence"]);
  const blocking = value["blocking"] === true;
  const resolution = boundedText(value["resolution"], 1_000, "Provide bounded evidence or explicit owner input.");
  const suppliedId = typeof value["id"] === "string" && assessmentAssumptionIdSchema.safeParse(value["id"]).success
    ? value["id"]
    : `asm_${hash24(`${seed}\u0000${normalizedText(statement)}\u0000${confidence}\u0000${blocking}`)}`;
  const parsed = assessmentAssumptionSchema.safeParse({
    id: suppliedId,
    statement,
    confidence,
    blocking,
    resolution,
    evidence: retainedEvidence.length > 0 ? retainedEvidence : [fallbackEvidence("Assumption evidence requires owner input.")]
  });
  return parsed.success ? parsed.data : undefined;
}

function assumptionSemanticKey(assumption: AssessmentAssumption): string {
  return JSON.stringify({
    statement: normalizedText(assumption.statement),
    confidence: assumption.confidence,
    blocking: assumption.blocking,
    resolution: normalizedText(assumption.resolution),
    evidence: assumption.evidence.map(evidenceIdentity).sort(compareStrings)
  });
}

function addAssumption(
  accumulator: AssumptionAccumulator,
  value: unknown,
  fallbackEvidence: AssessmentEvidenceRef[],
  seed: string,
  options: { readonly deduplicate?: boolean } = {}
): string | undefined {
  const assumption = normalizeAssumption(value, fallbackEvidence, seed);
  if (assumption === undefined) return undefined;
  const key = assumptionSemanticKey(assumption);
  const existing = accumulator.byKey.get(key);
  if (existing !== undefined && options.deduplicate === true) return existing.id;
  let id: string = assumption.id;
  if (accumulator.ids.has(id)) id = `asm_${hash24(`${seed}\u0000${key}`)}`;
  const retained = assessmentAssumptionSchema.parse({ ...assumption, id: assessmentAssumptionIdSchema.parse(id) });
  if (existing === undefined) accumulator.byKey.set(key, retained);
  accumulator.ids.add(id);
  accumulator.values.push(retained);
  return id;
}

function emptySummary(): NormalizedSignals["summary"] {
  return assessmentSignalSummarySchema.parse(EMPTY_SUMMARY);
}

type NormalizedSignals = {
  readonly summary: ReturnType<typeof assessmentSignalSummarySchema.parse>;
  readonly dependencyEdges: readonly BrownfieldSignals["dependencyEdges"][number][];
  readonly testFiles: readonly string[];
  readonly testToSourceLinks: readonly BrownfieldSignals["testToSourceLinks"][number][];
  readonly architectureSignals: readonly BrownfieldSignals["architectureSignals"][number][];
  readonly riskSignals: readonly BrownfieldSignals["riskSignals"][number][];
};

function normalizeSignals(input: BrownfieldSignals | null | undefined): NormalizedSignals {
  if (input === null || input === undefined) {
    return {
      summary: emptySummary(),
      dependencyEdges: [],
      testFiles: [],
      testToSourceLinks: [],
      architectureSignals: [],
      riskSignals: []
    };
  }
  const summary = assessmentSignalSummarySchema.parse(input.summary);
  return {
    summary,
    dependencyEdges: Array.isArray(input.dependencyEdges) ? input.dependencyEdges : [],
    testFiles: Array.isArray(input.testFiles) ? [...input.testFiles].sort(compareStrings) : [],
    testToSourceLinks: Array.isArray(input.testToSourceLinks) ? input.testToSourceLinks : [],
    architectureSignals: Array.isArray(input.architectureSignals) ? input.architectureSignals : [],
    riskSignals: Array.isArray(input.riskSignals) ? input.riskSignals : []
  };
}

function deduplicateAndRankFindings(values: readonly FindingCandidate[]): AssessmentFinding[] {
  const canonical = [...values].sort((left, right) => compareStrings(findingTieKey(left), findingTieKey(right)));
  const unique = new Map<string, AssessmentFinding>();
  const usedIds = new Set<string>();
  for (const candidate of canonical) {
    const semanticKey = findingSemanticKey(candidate);
    if (unique.has(semanticKey)) continue;
    let id: string = candidate.id;
    if (usedIds.has(id)) id = `af_${hash24(`${semanticKey}\u0000${candidate.id}`)}`;
    const { _sourceOrder: ignoredSourceOrder, ...findingWithoutSourceOrder } = candidate;
    void ignoredSourceOrder;
    const retained = assessmentFindingSchema.parse({
      ...findingWithoutSourceOrder,
      id: assessmentFindingIdSchema.parse(id)
    });
    unique.set(semanticKey, retained);
    usedIds.add(id);
  }
  return [...unique.values()].sort(findingRank).slice(0, MAX_FINDINGS);
}

function makeGeneratedAssumption(input: {
  readonly statement: string;
  readonly resolution: string;
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly seed: string;
}): AssessmentAssumption {
  const evidence = normalizeEvidence(input.evidence);
  const id = `asm_${hash24(`${input.seed}\u0000${normalizedText(input.statement)}\u0000${evidence.map(evidenceIdentity).sort(compareStrings).join("\u0001")}`)}`;
  return assessmentAssumptionSchema.parse({
    id,
    statement: boundedText(input.statement, 2_000),
    confidence: "unknown",
    blocking: true,
    resolution: boundedText(input.resolution, 1_000),
    evidence: evidence.length > 0 ? evidence.slice(0, 64) : [fallbackEvidence("Generated assumption requires owner input.")]
  });
}

function addGeneratedAssumption(accumulator: AssumptionAccumulator, assumption: AssessmentAssumption): string {
  return addAssumption(accumulator, assumption, [...assumption.evidence], assumption.id, { deduplicate: true }) ?? assumption.id;
}

function isBehavioralClaim(finding: AssessmentFinding): boolean {
  return /\b(runtime|behavior|behaviour|execute|executed|execution|integration|coverage|tested|test suite|works safely|production)\b/iu.test(
    `${finding.title} ${finding.statement} ${finding.recommendation}`
  );
}

function hasBehaviorEvidence(finding: AssessmentFinding): boolean {
  return finding.evidence.some((reference) => reference.kind === "command-result" || reference.kind === "test-result");
}

function collectUniqueText(accumulator: Map<string, string>, value: string): void {
  const bounded = boundedText(value, MAX_STRING_CHARS);
  const key = normalizedText(bounded);
  const existing = accumulator.get(key);
  // Keep the lexicographically first original spelling so output is
  // deterministic regardless of input order.
  if (existing === undefined || bounded < existing) accumulator.set(key, bounded);
}

function finalizeBoundedSet(accumulator: Map<string, string>, limit: number): string[] {
  return [...accumulator.entries()]
    .sort(([leftKey], [rightKey]) => compareStrings(leftKey, rightKey))
    .slice(0, limit)
    .map(([, value]) => value);
}

function criticalInputAssumption(finding: AssessmentFinding): AssessmentAssumption {
  return makeGeneratedAssumption({
    seed: `critical\u0000${findingSemanticKey(finding)}`,
    statement: `[needs-user-input] Critical finding '${finding.title}' has ${finding.confidence} confidence and requires owner validation before action.`,
    resolution: "Confirm the critical finding with an explicit command-result, test-result, or repository-owner decision.",
    evidence: finding.evidence
  });
}

function dissentAssumption(title: string, findings: readonly AssessmentFinding[]): AssessmentAssumption {
  const evidence = findings.flatMap((finding) => finding.evidence);
  return makeGeneratedAssumption({
    seed: `dissent\u0000${normalizedText(title)}`,
    statement: `[needs-user-input] Specialists disagree about '${boundedText(title, 256)}'; their evidence-backed interpretations must not be averaged.`,
    resolution: "Ask the repository owner which interpretation reflects the intended architecture or behavior, then run bounded verification.",
    evidence
  });
}

function improvementPriority(severity: AssessmentSeverity): BrownfieldImprovementItem["priority"] {
  switch (severity) {
    case "critical": return "P0";
    case "major": return "P1";
    case "moderate": return "P2";
    case "minor":
    case "informational": return "P3";
  }
}

function improvementVerification(finding: AssessmentFinding): string[] {
  const behavioralEvidence = finding.evidence.find((reference) => reference.kind === "command-result" || reference.kind === "test-result");
  if (behavioralEvidence !== undefined) {
    return [boundedText(`Re-run the recorded verification represented by ${behavioralEvidence.path}.`, 1_000)];
  }
  return ["needs-user-input: provide an executable command-result or test-result verification before implementation."];
}

function makeImprovement(finding: AssessmentFinding): BrownfieldImprovementItem {
  const prerequisites = finding.assumptions.map((id) => `Resolve assumption ${id} before implementation.`).sort(compareStrings);
  const objective = boundedText(`Bounded objective: address ${finding.title}.`, 1_000);
  const rationale = boundedText(`${finding.statement} Recommendation: ${finding.recommendation}`, 4_000);
  return {
    id: `imp_${hash24(JSON.stringify({ finding: findingSemanticKey(finding), objective, prerequisites }))}`,
    priority: improvementPriority(finding.severity),
    objective,
    rationale,
    evidence: normalizeEvidence(finding.evidence),
    prerequisites,
    verification: improvementVerification(finding)
  };
}

function currentArchitectureSummary(signals: NormalizedSignals): string {
  const summary = signals.summary;
  return boundedText(
    `The validated structural view covers ${summary.sourceFiles} source files (${summary.coverageFiles} coverage entries), ${summary.symbols} symbols, ${summary.imports} imports, ${summary.exports} exports, and ${summary.dependencyEdges} persisted dependency edges. It inventories ${summary.testFiles} test files and ${summary.testToSourceLinks} conservative test-to-source links. These are structural observations, not runtime proof.`,
    MAX_SUMMARY_CHARS
  );
}

function executiveSummary(signals: NormalizedSignals, findings: readonly AssessmentFinding[], assumptions: readonly AssessmentAssumption[], gaps: readonly string[]): string {
  return boundedText(
    `Synthesis produced ${findings.length} prioritized findings from deterministic signals and specialist output, retained ${assumptions.length} assumptions requiring input, and identified ${gaps.length} behavioral-proof gaps. Severity and confidence are ranked deterministically; dissent remains explicit rather than averaged.`,
    MAX_SUMMARY_CHARS
  );
}

/**
 * Merge deterministic signal findings and specialist findings into a stable,
 * evidence-closed design. This function has no filesystem, network, or source
 * mutation side effects; callers may serialize the returned object as JSON.
 */
export function synthesizeBrownfieldDesign(input: BrownfieldSynthesisInput = {}): BrownfieldDesign {
  const signals = normalizeSignals(input.signals);
  const specialistResult = input.specialists;
  const specialistRecord = (Array.isArray(specialistResult)
    ? { findings: specialistResult as readonly AssessmentFinding[] }
    : specialistResult ?? undefined) as Partial<BrownfieldSpecialistsResult> | undefined;
  const candidates: FindingCandidate[] = [];
  let sourceOrder = 0;
  for (const finding of signalFindings(signals)) candidates.push({ ...finding, _sourceOrder: sourceOrder++ });
  for (const finding of [
    ...(input.findings ?? []),
    ...(input.specialistFindings ?? []),
    ...((specialistRecord?.findings ?? []) as readonly AssessmentFinding[])
  ]) {
    const normalized = normalizeFinding(finding, sourceOrder++);
    if (normalized !== undefined) candidates.push(normalized);
  }
  const prioritizedFindings = deduplicateAndRankFindings(candidates);

  const accumulator: AssumptionAccumulator = { values: [], byKey: new Map(), ids: new Set() };
  const assumptionInputs = [
    ...(input.assumptions ?? []),
    ...(input.specialistAssumptions ?? []),
    ...((specialistRecord?.assumptions ?? []) as readonly AssessmentAssumption[])
  ];
  for (const assumption of assumptionInputs) addAssumption(accumulator, assumption, [fallbackEvidence("Assumption evidence requires owner input.")], "input-assumption");
  const specialistFindings = (specialistRecord?.findings ?? []) as readonly AssessmentFinding[];
  const specialistAssumptions = (specialistRecord?.assumptions ?? []) as readonly AssessmentAssumption[];
  const specialistDiagnostics = (specialistRecord?.diagnostics ?? []) as readonly unknown[];
  if (input.specialists === null || (input.specialists !== undefined && specialistFindings.length === 0 && specialistAssumptions.length === 0)) {
    addGeneratedAssumption(accumulator, makeGeneratedAssumption({
      seed: input.specialists === null ? "specialists-null" : "specialists-empty",
      statement: input.specialists === null
        ? "[needs-user-input] Specialist output was explicitly unavailable; no specialist conclusion can be treated as established."
        : "[needs-user-input] Specialist output was empty; no specialist conclusion can be treated as established.",
      resolution: "Run the bounded specialist roster or provide an owner-reviewed specialist result.",
      evidence: [fallbackEvidence("Explicit null specialist result; specialist execution did not provide output.")]
    }));
  }

  const findingsWithResolvedAssumptions: AssessmentFinding[] = [];
  for (const finding of prioritizedFindings) {
    const resolvedAssumptions: string[] = [];
    for (const assumptionId of finding.assumptions) {
      if (accumulator.ids.has(assumptionId)) {
        resolvedAssumptions.push(assumptionId);
      } else {
        const newId = addGeneratedAssumption(accumulator, makeGeneratedAssumption({
          seed: `unresolved\u0000${assumptionId}`,
          statement: `[needs-user-input] Finding '${finding.title}' references unresolved assumption ${assumptionId}.`,
          resolution: "Provide the missing assumption record or remove the unresolved reference.",
          evidence: finding.evidence
        }));
        resolvedAssumptions.push(newId);
      }
    }
    findingsWithResolvedAssumptions.push(assessmentFindingSchema.parse({
      ...finding,
      assumptions: [...new Set(resolvedAssumptions)]
    }));
  }

  const byTitle = new Map<string, AssessmentFinding[]>();
  for (const finding of findingsWithResolvedAssumptions) {
    const key = normalizedText(finding.title);
    const group = byTitle.get(key) ?? [];
    group.push(finding);
    byTitle.set(key, group);
  }
  const dissentQuestionTitles: string[] = [];
  const dissentIds = new Map<string, string>();
  for (const [titleKey, group] of byTitle) {
    const opinionKeys = new Set(group.map((finding) => JSON.stringify({
      statement: normalizedText(finding.statement),
      severity: finding.severity,
      confidence: finding.confidence,
      recommendation: normalizedText(finding.recommendation)
    })));
    if (opinionKeys.size <= 1) continue;
    const title = group.map((finding) => finding.title).sort(compareStrings)[0] ?? titleKey;
    const id = addGeneratedAssumption(accumulator, dissentAssumption(title, group));
    dissentIds.set(titleKey, id);
    dissentQuestionTitles.push(title);
  }

  const criticalIds = new Map<string, string>();
  for (const finding of findingsWithResolvedAssumptions) {
    if (finding.severity !== "critical" || (finding.confidence !== "low" && finding.confidence !== "unknown")) continue;
    criticalIds.set(finding.id, addGeneratedAssumption(accumulator, criticalInputAssumption(finding)));
  }

  const finalFindings = findingsWithResolvedAssumptions.map((finding) => {
    const added: string[] = [];
    const dissentId = dissentIds.get(normalizedText(finding.title));
    if (dissentId !== undefined) added.push(dissentId);
    const criticalId = criticalIds.get(finding.id);
    if (criticalId !== undefined) added.push(criticalId);
    return assessmentFindingSchema.parse({
      ...finding,
      assumptions: [...new Set([...finding.assumptions, ...added])]
    });
  });

  const gapCollector = new Map<string, string>();
  const commandResultEvidenceKeys = new Set(input.commandResults?.map(evidenceIdentity) ?? []);
  for (const testPath of signals.testFiles) {
    collectUniqueText(gapCollector, `Test inventory entry '${testPath}' does not prove test execution or coverage.`);
  }
  for (const link of signals.testToSourceLinks) {
    collectUniqueText(gapCollector, `Conservative test-to-source link '${link.testPath}' -> '${link.sourcePath}' is not behavioral proof.`);
  }
  if (signals.summary.unsupportedSignals > 0) {
    collectUniqueText(gapCollector, `${signals.summary.unsupportedSignals} unsupported structural area(s) remain without behavioral proof.`);
  }
  for (const signal of [...signals.architectureSignals, ...signals.riskSignals]) {
    if (/unsupported|opaque|size-limit|parser-error|unreadable/iu.test(signal.code)) {
      collectUniqueText(gapCollector, `Unsupported or incomplete coverage signal '${signal.code}' requires explicit verification.`);
    }
  }
  for (const command of input.unrunCommands ?? []) {
    collectUniqueText(gapCollector, `Unrun command: ${command}`);
  }
  for (const area of input.unsupportedAreas ?? []) {
    collectUniqueText(gapCollector, `Unsupported area: ${area}`);
  }
  if ((input.commandResults ?? []).length > 0) {
    // Command-result evidence was supplied at the synthesis boundary but
    // the specialist output did not reference it. This is not a gap — it
    // is recorded as available behavioral evidence below.
  }
  for (const diagnostic of specialistDiagnostics) {
    collectUniqueText(gapCollector, `Unresolved specialist output: ${diagnostic}`);
  }
  for (const record of (specialistRecord?.executionRecords ?? []) as readonly Partial<BrownfieldSpecialistExecutionRecord>[]) {
    if (record.status === "succeeded") continue;
    const name = isRecord(record.specialist) && typeof record.specialist["name"] === "string" ? record.specialist["name"] : "unknown";
    const pass = isRecord(record.specialist) && typeof record.specialist["pass"] === "number" ? String(record.specialist["pass"]) : "?";
    collectUniqueText(gapCollector, `Specialist ${name} pass ${pass} did not produce resolved output; behavioral proof is unavailable.`);
  }
  for (const finding of finalFindings) {
    const hasCommandEvidence = finding.evidence.some((reference) =>
      reference.kind === "command-result" || reference.kind === "test-result" || commandResultEvidenceKeys.has(evidenceIdentity(reference))
    );
    if (isBehavioralClaim(finding) && !hasCommandEvidence) {
      collectUniqueText(gapCollector, `Behavioral claim '${finding.title}' lacks explicit command-result or test-result evidence.`);
    }
  }
  const behavioralProofGaps = finalizeBoundedSet(gapCollector, MAX_GAPS);

  const assumptionsRequiringInput = accumulator.values
    .filter((assumption) => assumption.confidence === "unknown" || assumption.blocking)
    .sort((left, right) => compareStrings(left.id, right.id))
    .slice(0, MAX_ASSUMPTIONS);

  const questionCollector = new Map<string, string>();
  for (const question of input.openQuestions ?? []) collectUniqueText(questionCollector, question);
  for (const title of dissentQuestionTitles.sort(compareStrings)) {
    collectUniqueText(questionCollector, `Which evidence-backed interpretation of '${title}' reflects the intended architecture or behavior?`);
  }
  for (const assumption of assumptionsRequiringInput) {
    collectUniqueText(questionCollector, `Resolve assumption ${assumption.id}: ${assumption.statement}`);
  }
  const openQuestions = finalizeBoundedSet(questionCollector, MAX_QUESTIONS);

  const improvementPlan = finalFindings.slice(0, MAX_IMPROVEMENTS).map(makeImprovement);
  const summary = signals.summary;
  const strengthCollector = new Map<string, string>();
  for (const value of input.strengths ?? []) collectUniqueText(strengthCollector, value);
  if (strengthCollector.size === 0 && summary.sourceFiles > 0) {
    collectUniqueText(strengthCollector, `A bounded structural snapshot covers ${summary.sourceFiles} source files and ${summary.coverageFiles} coverage entries.`);
  }
  if (summary.testToSourceLinks > 0) collectUniqueText(strengthCollector, `${summary.testToSourceLinks} conservative test-to-source link(s) are available for follow-up verification.`);
  const strengths = finalizeBoundedSet(strengthCollector, MAX_STRENGTHS);

  return {
    title: boundedText(input.title, MAX_TITLE_CHARS, "Brownfield assessment improvement design"),
    executiveSummary: executiveSummary(signals, finalFindings, assumptionsRequiringInput, behavioralProofGaps),
    currentArchitecture: currentArchitectureSummary(signals),
    evidenceBackedStrengths: strengths,
    prioritizedFindings: finalFindings,
    assumptionsRequiringInput,
    improvementPlan,
    nonGoals: [
      "Do not modify source files, manifests, or runtime configuration as part of synthesis.",
      "Do not infer runtime behavior, product intent, or test coverage from structural evidence alone.",
      "Do not silently average conflicting specialist findings."
    ].sort(compareStrings),
    behavioralProofGaps,
    openQuestions
  };
}

/** Alias used by workflow callers that name the operation after its bundle. */
export const synthesizeBrownfieldAssessment = synthesizeBrownfieldDesign;
export const synthesizeBrownfield = synthesizeBrownfieldDesign;

/** Stable JSON serialization for CLI and bundle writers; no Markdown is emitted. */
export function serializeBrownfieldDesign(design: BrownfieldDesign): string {
  return stableProtocolJson(design);
}
