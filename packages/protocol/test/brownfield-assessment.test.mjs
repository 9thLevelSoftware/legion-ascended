import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  assessmentAssumptionSchema,
  assessmentConfidenceSchema,
  assessmentEffortSchema,
  assessmentEvidenceRefSchema,
  assessmentFindingSchema,
  assessmentPhaseSchema,
  assessmentSeveritySchema,
  assessmentSignalSummarySchema,
  brownfieldAssessmentSchema,
  entityJsonSchemas
} from "../dist/index.js";

const HASH = "a".repeat(64);
const SNAPSHOT_ID = "idx_3f93b1d6df4af0fe5cc5a6e4";
const ASSESSMENT_ID = "assess_3f93b1d6df4af0fe5cc5a6e4";
const ASSUMPTION_ID = "asm_4f93b1d6df4af0fe5cc5a6e4";
const FINDING_ID = "af_5f93b1d6df4af0fe5cc5a6e4";

function evidence(overrides = {}) {
  return {
    kind: "structural-fact",
    path: ".legion/index/semantic-map.json",
    note: "Structural export fact",
    ...overrides
  };
}

function validAssumption(overrides = {}) {
  return {
    id: ASSUMPTION_ID,
    statement: "The repository's test command is authoritative for this scope.",
    confidence: "unknown",
    blocking: true,
    resolution: "Confirm with the repository owner before synthesis.",
    evidence: [evidence({ kind: "user-input", path: ".legion/assessment/user-input.json" })],
    ...overrides
  };
}

function validFinding(overrides = {}) {
  return {
    id: FINDING_ID,
    specialist: "architecture",
    title: "Source graph has an unverified boundary",
    statement: "The structural map shows a cross-boundary import that needs runtime verification.",
    severity: "major",
    confidence: "low",
    evidence: [evidence({ factId: "imp_6f93b1d6df4af0fe5cc5a6e4" })],
    assumptions: [ASSUMPTION_ID],
    recommendation: "Add a focused integration check for the boundary.",
    ...overrides
  };
}

function validAssessment(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "brownfield_assessment",
    assessmentId: ASSESSMENT_ID,
    generatedAt: "2026-08-26T12:00:00.000Z",
    effort: 3,
    phase: "review",
    repositoryRoot: ".legion/assessments/assess_3f93b1d6df4af0fe5cc5a6e4",
    scope: ".",
    snapshotId: SNAPSHOT_ID,
    sourceFingerprint: HASH,
    semanticIndexSha256: HASH,
    semanticSqliteSha256: HASH,
    signals: {
      sourceFiles: 12,
      coverageFiles: 12,
      symbols: 24,
      imports: 18,
      exports: 9,
      testFiles: 4,
      testToSourceLinks: 3,
      dependencyEdges: 18,
      highRiskSignals: 2,
      unsupportedSignals: 1
    },
    assumptions: [validAssumption()],
    findings: [validFinding()],
    nextActions: ["Confirm runtime behavior at the unverified boundary.", "Review the proposed integration test."] ,
    ...overrides
  };
}

test("assessment primitive enums and effort bounds are strict", () => {
  for (const effort of [1, 2, 3, 4, 5]) {
    assert.equal(assessmentEffortSchema.safeParse(effort).success, true);
  }
  for (const effort of [0, 6, 1.5, "3"]) {
    assert.equal(assessmentEffortSchema.safeParse(effort).success, false, String(effort));
  }

  for (const phase of ["setup", "signals", "specialists", "assumptions", "synthesis", "review", "complete", "blocked"]) {
    assert.equal(assessmentPhaseSchema.safeParse(phase).success, true, phase);
  }
  assert.equal(assessmentPhaseSchema.safeParse("needs-input").success, false);

  for (const confidence of ["high", "medium", "low", "unknown"]) {
    assert.equal(assessmentConfidenceSchema.safeParse(confidence).success, true, confidence);
  }
  assert.equal(assessmentConfidenceSchema.safeParse("needs-input").success, false);

  for (const severity of ["critical", "major", "moderate", "minor", "informational"]) {
    assert.equal(assessmentSeveritySchema.safeParse(severity).success, true, severity);
  }
  assert.equal(assessmentSeveritySchema.safeParse("warning").success, false);
});

test("evidence references require safe artifact paths and notes", () => {
  assert.equal(assessmentEvidenceRefSchema.safeParse(evidence()).success, true);
  assert.equal(
    assessmentEvidenceRefSchema.safeParse({
      ...evidence(),
      sha256: HASH,
      factId: "sym_7f93b1d6df4af0fe5cc5a6e4"
    }).success,
    true
  );

  for (const invalid of [
    { ...evidence(), path: "../outside.json" },
    { ...evidence(), path: "/absolute.json" },
    { ...evidence(), note: "" },
    { ...evidence(), sha256: `sha256:${HASH}` },
    { ...evidence(), factId: "fact_123" },
    { ...evidence(), unexpected: true }
  ]) {
    assert.equal(assessmentEvidenceRefSchema.safeParse(invalid).success, false);
  }
});

test("assumptions require evidence, bounded fields, and strict IDs", () => {
  assert.equal(assessmentAssumptionSchema.safeParse(validAssumption()).success, true);
  assert.equal(assessmentAssumptionSchema.safeParse({ ...validAssumption(), evidence: [] }).success, false);
  assert.equal(assessmentAssumptionSchema.safeParse({ ...validAssumption(), id: "asm_not-a-valid-id" }).success, false);
  assert.equal(assessmentAssumptionSchema.safeParse({ ...validAssumption(), blocking: "yes" }).success, false);
  assert.equal(assessmentAssumptionSchema.safeParse({ ...validAssumption(), unexpected: true }).success, false);
});

test("findings require specialist, severity, evidence, and valid assumption references", () => {
  assert.equal(assessmentFindingSchema.safeParse(validFinding()).success, true);
  assert.equal(assessmentFindingSchema.safeParse({ ...validFinding(), specialist: "runtime" }).success, false);
  assert.equal(assessmentFindingSchema.safeParse({ ...validFinding(), evidence: [] }).success, false);
  assert.equal(assessmentFindingSchema.safeParse({ ...validFinding(), assumptions: ["asm_invalid"] }).success, false);
  assert.equal(assessmentFindingSchema.safeParse({ ...validFinding(), unexpected: true }).success, false);

  for (const specialist of ["architecture", "code", "tests", "security", "product-intent", "documentation"]) {
    assert.equal(assessmentFindingSchema.safeParse({ ...validFinding(), specialist }).success, true, specialist);
  }
});

test("signal summary is strict, nonnegative, and bounded to declared counts", () => {
  const summary = validAssessment().signals;
  assert.equal(assessmentSignalSummarySchema.safeParse(summary).success, true);
  assert.equal(assessmentSignalSummarySchema.safeParse({ ...summary, symbols: -1 }).success, false);
  assert.equal(assessmentSignalSummarySchema.safeParse({ ...summary, testFiles: 1.5 }).success, false);
  assert.equal(assessmentSignalSummarySchema.safeParse({ ...summary, unexpected: 1 }).success, false);
});

test("brownfield assessment binds strict provenance, scope, and bounded collections", () => {
  const assessment = validAssessment();
  assert.deepEqual(brownfieldAssessmentSchema.parse(assessment), assessment);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, schemaVersion: 2 }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, kind: "assessment" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, assessmentId: "assess_invalid" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, generatedAt: "2026-08-26T12:00:00Z" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, repositoryRoot: "../repo" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, scope: "../src" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, snapshotId: "idx_invalid" }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, sourceFingerprint: `sha256:${HASH}` }).success, false);
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...assessment, unexpected: true }).success, false);
});

test("brownfield assessment accepts unknown confidence and user-input evidence for needs-input cases", () => {
  const assessment = validAssessment({
    phase: "blocked",
    assumptions: [validAssumption({ confidence: "unknown", blocking: true })],
    findings: [validFinding({ confidence: "unknown", evidence: [evidence({ kind: "user-input", path: ".legion/assessment/user-input.json", note: "Owner input is required." })] })],
    nextActions: ["Request the missing product intent from the repository owner."]
  });

  assert.equal(brownfieldAssessmentSchema.safeParse(assessment).success, true);
});

test("brownfield assessment collections enforce their declared maxima", () => {
  const assessment = validAssessment();
  assessment.assumptions = Array.from({ length: 257 }, (_, index) => validAssumption({ id: `asm_${index.toString(16).padStart(24, "0")}` }));
  assert.equal(brownfieldAssessmentSchema.safeParse(assessment).success, false);

  const findings = Array.from({ length: 2_001 }, (_, index) => validFinding({ id: `af_${index.toString(16).padStart(24, "0")}` }));
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...validAssessment(), findings }).success, false);

  const nextActions = Array.from({ length: 65 }, () => "Review the bounded assessment evidence.");
  assert.equal(brownfieldAssessmentSchema.safeParse({ ...validAssessment(), nextActions }).success, false);
});

test("brownfield assessment generated JSON schema matches its committed artifact", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(testDirectory, "..", "..", "..", "schemas", "entities", "brownfield-assessment.schema.json");
  const committed = JSON.parse(await readFile(schemaPath, "utf8"));

  assert.deepEqual(committed, entityJsonSchemas.brownfieldAssessment);
});
