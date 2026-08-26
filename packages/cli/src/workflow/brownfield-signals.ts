import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import {
  artifactPathSchema,
  assessmentSeveritySchema,
  codeIndexFactIdSchema,
  codeIndexSha256Schema,
  type ArtifactPath,
  type AssessmentEvidenceRef,
  type AssessmentSeverity,
  type AssessmentSignalSummary,
  type CodeIndexImport,
  type CodeIndexSha256,
  type CodeIndexSnapshot,
  type CodeIndexSourcePath
} from "@legion/protocol";

const MAX_BOUNDED_SOURCE_BYTES = 256 * 1024;
const TEST_DIRECTORY_NAMES = new Set(["test", "tests", "spec", "__tests__"]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.toml",
  "cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "gemfile",
  "gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts"
]);
const CI_FILE_NAMES = new Set(["jenkinsfile", ".gitlab-ci.yml", ".gitlab-ci.yaml", "azure-pipelines.yml"]);

export interface BrownfieldSignals {
  readonly summary: AssessmentSignalSummary;
  readonly dependencyEdges: readonly {
    readonly from: CodeIndexSourcePath;
    readonly to: string;
    readonly evidence: AssessmentEvidenceRef;
  }[];
  readonly testFiles: readonly CodeIndexSourcePath[];
  readonly testToSourceLinks: readonly {
    readonly testPath: CodeIndexSourcePath;
    readonly sourcePath: CodeIndexSourcePath;
    readonly reason: string;
  }[];
  readonly architectureSignals: readonly {
    readonly code: string;
    readonly severity: AssessmentSeverity;
    readonly statement: string;
    readonly evidence: readonly AssessmentEvidenceRef[];
  }[];
  readonly riskSignals: readonly {
    readonly code: string;
    readonly severity: AssessmentSeverity;
    readonly statement: string;
    readonly evidence: readonly AssessmentEvidenceRef[];
  }[];
}

type Signal = BrownfieldSignals["architectureSignals"][number];
type SourceObservation = {
  readonly path: CodeIndexSourcePath;
  readonly sha256: CodeIndexSha256;
  readonly text: string;
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sorted<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare);
}

function sourceEvidence(observation: SourceObservation, note: string): AssessmentEvidenceRef {
  return {
    kind: "source-file",
    path: observation.path,
    sha256: observation.sha256,
    note
  };
}

function structuralFactEvidence(
  sqliteArtifactPath: ArtifactPath,
  sqliteSha256: CodeIndexSha256,
  fact: { readonly id: string },
  note: string
): AssessmentEvidenceRef {
  return {
    kind: "structural-fact",
    path: sqliteArtifactPath,
    sha256: sqliteSha256,
    factId: codeIndexFactIdSchema.parse(fact.id),
    note
  };
}


function isTestFile(sourcePath: string): boolean {
  const parts = sourcePath.split("/");
  const basename = parts.at(-1) ?? sourcePath;
  const extension = path.posix.extname(basename);
  const stem = extension.length === 0 ? basename : basename.slice(0, -extension.length);
  return parts.slice(0, -1).some((part) => TEST_DIRECTORY_NAMES.has(part.toLowerCase())) ||
    /(?:^|[._-])(test|spec)(?:$|[._-])/iu.test(stem);
}

function sourceStem(sourcePath: string): string {
  const basename = path.posix.basename(sourcePath);
  const extension = path.posix.extname(basename);
  const stem = extension.length === 0 ? basename : basename.slice(0, -extension.length);
  return stem.replace(/(?:[._-])(test|spec)$/iu, "");
}

function sourceBasename(sourcePath: string): string {
  return sourceStem(sourcePath).toLowerCase();
}

function topLevelRoot(sourcePath: string): string {
  return sourcePath.split("/")[0] ?? sourcePath;
}

function isManifestOrCi(sourcePath: string): boolean {
  const basename = path.posix.basename(sourcePath).toLowerCase();
  return MANIFEST_NAMES.has(basename) || CI_FILE_NAMES.has(basename) ||
    (sourcePath.startsWith(".github/workflows/") && sourcePath.split("/").length > 2);
}

function isDocumentation(sourcePath: string): boolean {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  return extension === ".md" || extension === ".mdx" || sourcePath.toLowerCase().includes("/docs/") ||
    sourcePath.toLowerCase().startsWith("docs/");
}

function addSignal(
  target: Signal[],
  code: string,
  severity: AssessmentSeverity,
  statement: string,
  evidence: readonly AssessmentEvidenceRef[]
): void {
  if (evidence.length === 0) throw new Error(`Brownfield signal ${code} has no evidence.`);
  target.push({ code, severity: assessmentSeveritySchema.parse(severity), statement, evidence });
}

function sortSignals(signals: readonly Signal[]): Signal[] {
  return sorted(signals, (left, right) =>
    compareStrings(left.code, right.code) ||
    compareStrings(left.statement, right.statement) ||
    compareStrings(JSON.stringify(left.evidence), JSON.stringify(right.evidence))
  );
}

function artifactPathForSqlite(repositoryRoot: string, sqlitePath: string, expected: string): ArtifactPath {
  const root = path.resolve(repositoryRoot);
  const absolute = path.resolve(root, sqlitePath);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  const parsed = artifactPathSchema.parse(relative);
  if (parsed !== expected) {
    throw new Error(`SQLite path ${sqlitePath} does not match the validated snapshot path ${expected}.`);
  }
  return parsed;
}

async function hashFile(absolutePath: string): Promise<CodeIndexSha256> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) digest.update(chunk as Buffer);
  return codeIndexSha256Schema.parse(digest.digest("hex"));
}

async function readBoundedSource(absolutePath: string): Promise<string> {
  const descriptor = await open(absolutePath, "r");
  try {
    const sizeBytes = (await descriptor.stat()).size;
    const bytesToRead = Math.min(sizeBytes, MAX_BOUNDED_SOURCE_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const result = await descriptor.read(buffer, offset, bytesToRead - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return "";
    return bytes.toString("utf8");
  } finally {
    await descriptor.close();
  }
}

async function inspectSourceFile(
  repositoryRoot: string,
  sourcePath: CodeIndexSourcePath,
  expectedHashes: ReadonlyMap<string, CodeIndexSha256>
): Promise<SourceObservation> {
  const absolutePath = path.join(repositoryRoot, ...sourcePath.split("/"));
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error(`Snapshot source path is not a regular file: ${sourcePath}.`);
  const sha256 = await hashFile(absolutePath);
  const expectedHash = expectedHashes.get(sourcePath);
  if (expectedHash !== undefined && expectedHash !== sha256) {
    throw new Error(`Source file ${sourcePath} changed after the validated structural snapshot.`);
  }
  const text = await readBoundedSource(absolutePath);
  return { path: sourcePath, sha256, text };
}

function expectedSourceHashes(snapshot: CodeIndexSnapshot): ReadonlyMap<string, CodeIndexSha256> {
  const result = new Map<string, CodeIndexSha256>();
  for (const fact of [...snapshot.symbols, ...snapshot.imports, ...snapshot.exports]) {
    const existing = result.get(fact.path);
    if (existing !== undefined && existing !== fact.sourceSha256) {
      throw new Error(`Structural snapshot has inconsistent source hashes for ${fact.path}.`);
    }
    result.set(fact.path, fact.sourceSha256);
  }
  return result;
}

function findTestLinks(
  testFiles: readonly CodeIndexSourcePath[],
  sourceFiles: readonly CodeIndexSourcePath[]
): BrownfieldSignals["testToSourceLinks"] {
  const sourceCandidates = sourceFiles.filter((sourcePath) => !isTestFile(sourcePath));
  const links: BrownfieldSignals["testToSourceLinks"][number][] = [];
  for (const testPath of sorted(testFiles, compareStrings)) {
    const testStem = sourceBasename(testPath);
    const testDirectory = path.posix.dirname(testPath);
    const candidates = sourceCandidates.filter((sourcePath) => sourceBasename(sourcePath) === testStem);
    if (candidates.length === 0) continue;
    candidates.sort((left, right) => {
      const leftSameDirectory = path.posix.dirname(left) === testDirectory ? 0 : 1;
      const rightSameDirectory = path.posix.dirname(right) === testDirectory ? 0 : 1;
      return leftSameDirectory - rightSameDirectory || compareStrings(left, right);
    });
    const sourcePath = candidates[0];
    if (sourcePath === undefined) continue;
    links.push({
      testPath,
      sourcePath,
      reason: "heuristic filename/path match; low confidence"
    });
  }
  return links;
}

function importFactEvidence(
  sqliteArtifactPath: ArtifactPath,
  sqliteSha256: CodeIndexSha256,
  fact: CodeIndexImport
): AssessmentEvidenceRef {
  return structuralFactEvidence(sqliteArtifactPath, sqliteSha256, fact, "Persisted import fact; specifier is not a resolved dependency claim.");
}

function sourceObservationFor(
  observations: ReadonlyMap<string, SourceObservation>,
  sourcePath: string
): SourceObservation {
  const observation = observations.get(sourcePath);
  if (observation === undefined) throw new Error(`Missing bounded source observation for ${sourcePath}.`);
  return observation;
}

function collectArchitectureSignals(input: {
  readonly snapshot: CodeIndexSnapshot;
  readonly observations: ReadonlyMap<string, SourceObservation>;
  readonly sqliteArtifactPath: ArtifactPath;
}): Signal[] {
  const { snapshot, observations, sqliteArtifactPath } = input;
  const signals: Signal[] = [];
  const sourceFacts = new Map<string, CodeIndexImport[]>();
  for (const fact of snapshot.imports) {
    const facts = sourceFacts.get(fact.path) ?? [];
    facts.push(fact);
    sourceFacts.set(fact.path, facts);
  }
  const sqliteSha256 = snapshot.sqlite.sha256;

  for (const [sourcePath, facts] of [...sourceFacts.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    if (facts.length < 2) continue;
    const observation = sourceObservationFor(observations, sourcePath);
    addSignal(
      signals,
      "fan-out-hotspot",
      "moderate",
      `File ${sourcePath} contains ${facts.length} persisted import facts; this is a structural fan-out hotspot, not a resolved dependency claim.`,
      [sourceEvidence(observation, "Source file for persisted import fan-out."), ...facts.slice(0, 8).map((fact) => importFactEvidence(sqliteArtifactPath, sqliteSha256, fact))]
    );
  }

  const importsBySpecifier = new Map<string, CodeIndexImport[]>();
  for (const fact of snapshot.imports) {
    const facts = importsBySpecifier.get(fact.specifier) ?? [];
    facts.push(fact);
    importsBySpecifier.set(fact.specifier, facts);
  }
  for (const [specifier, facts] of [...importsBySpecifier.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    if (facts.length < 2) continue;
    const observationsForFacts = facts.slice(0, 8).map((fact) => sourceEvidence(
      sourceObservationFor(observations, fact.path),
      "Source file containing a repeated persisted import specifier."
    ));
    addSignal(
      signals,
      "fan-in-hotspot",
      "moderate",
      `Import specifier ${JSON.stringify(specifier)} appears in ${facts.length} persisted import facts; the collector does not resolve it to a module.`,
      [...observationsForFacts, ...facts.slice(0, 8).map((fact) => importFactEvidence(sqliteArtifactPath, sqliteSha256, fact))]
    );
  }

  const exportedNames = new Set(snapshot.imports.flatMap((fact) => {
    const basename = path.posix.basename(fact.specifier).replace(/\.[^.]+$/u, "");
    return [fact.specifier, basename];
  }));
  for (const fact of snapshot.exports) {
    if (!fact.name || [...exportedNames].some((name) => name.includes(fact.name))) continue;
    const observation = sourceObservationFor(observations, fact.path);
    addSignal(
      signals,
      "orphan-export",
      "minor",
      `Exported symbol ${fact.name} in ${fact.path} has no matching persisted import name; this is a structural orphan heuristic, not proof of unused behavior.`,
      [sourceEvidence(observation, "Source file containing the exported symbol."), structuralFactEvidence(sqliteArtifactPath, sqliteSha256, fact, "Persisted export fact used for orphan-export heuristic.")]
    );
  }

  const modulesByBasename = new Map<string, CodeIndexSourcePath[]>();
  for (const coverage of snapshot.coverage) {
    const basename = sourceBasename(coverage.path);
    const paths = modulesByBasename.get(basename) ?? [];
    paths.push(coverage.path);
    modulesByBasename.set(basename, paths);
  }
  for (const [basename, paths] of [...modulesByBasename.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    const uniqueRoots = new Set(paths.map((sourcePath) => path.posix.dirname(sourcePath)));
    if (paths.length < 2 || uniqueRoots.size < 2) continue;
    addSignal(
      signals,
      "duplicate-module-basename",
      "moderate",
      `Module basename ${JSON.stringify(basename)} occurs across ${uniqueRoots.size} repository roots; path identity must remain explicit.`,
      sorted(paths, compareStrings).map((sourcePath) => sourceEvidence(
        sourceObservationFor(observations, sourcePath),
        "Source file participating in duplicate module basename heuristic."
      ))
    );
  }

  for (const coverage of snapshot.coverage) {
    const observation = sourceObservationFor(observations, coverage.path);
    if (coverage.status === "parser-error") {
      addSignal(
        signals,
        "parser-error",
        "moderate",
        `Structural parsing reported an error for ${coverage.path}; static facts for this file are incomplete.`,
        [sourceEvidence(observation, "Source file with persisted parser-error coverage.")]
      );
    } else if (coverage.status === "unsupported" || coverage.status === "opaque" || coverage.status === "size-limited") {
      addSignal(
        signals,
        "unsupported-file",
        "moderate",
        `Structural coverage for ${coverage.path} is ${coverage.status}; architecture conclusions are incomplete for this file.`,
        [sourceEvidence(observation, "Source file with unsupported, opaque, or size-limited coverage.")]
      );
    }
  }

  for (const fact of snapshot.imports) {
    if (!fact.specifier.startsWith("../")) continue;
    const sourceRoot = topLevelRoot(fact.path);
    const lexicalTarget = path.posix.normalize(path.posix.join(path.posix.dirname(fact.path), fact.specifier));
    const targetRoot = topLevelRoot(lexicalTarget);
    if (sourceRoot === targetRoot) continue;
    const observation = sourceObservationFor(observations, fact.path);
    addSignal(
      signals,
      "cross-boundary-import",
      "moderate",
      `Relative import specifier ${JSON.stringify(fact.specifier)} from ${fact.path} crosses a repository root boundary; it is not resolved here.`,
      [sourceEvidence(observation, "Source file containing the cross-boundary relative import."), importFactEvidence(sqliteArtifactPath, sqliteSha256, fact)]
    );
  }

  for (const coverage of snapshot.coverage) {
    if (!isDocumentation(coverage.path)) continue;
    addSignal(
      signals,
      "documentation-metadata",
      "informational",
      `Documentation file ${coverage.path} is present as bounded metadata; presence is not product-intent or behavioral proof.`,
      [sourceEvidence(sourceObservationFor(observations, coverage.path), "Bounded documentation metadata source file.")]
    );
  }

  return signals;
}


function collectRiskSignals(input: {
  readonly observations: ReadonlyMap<string, SourceObservation>;
  readonly sourceFiles: readonly CodeIndexSourcePath[];
  readonly testFiles: readonly CodeIndexSourcePath[];
  readonly testLinks: BrownfieldSignals["testToSourceLinks"];
}): Signal[] {
  const { observations, sourceFiles, testFiles, testLinks } = input;
  const signals: Signal[] = [];
  const linkedSources = new Set(testLinks.map((link) => link.sourcePath));
  const verificationEvidence = testFiles.map((testPath) => sourceEvidence(
    sourceObservationFor(observations, testPath),
    "Test source inventory; no command result was supplied to this deterministic collector."
  ));

  for (const sourcePath of sourceFiles) {
    const observation = sourceObservationFor(observations, sourcePath);
    if (/\b(?:TODO|FIXME)\b/iu.test(observation.text)) {
      addSignal(signals, "todo-fixme", "informational", `Static TODO/FIXME marker present in ${sourcePath}; marker presence is not proof of an unfinished behavior.`, [sourceEvidence(observation, "Bounded source read containing TODO/FIXME marker.")]);
    }
    if (/(?:\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*\}|=>\s*\{\s*\})/u.test(observation.text)) {
      addSignal(signals, "empty-function", "minor", `Empty function body pattern present in ${sourcePath}; static pattern requires review.`, [sourceEvidence(observation, "Bounded source read containing empty function pattern.")]);
    }
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/u.test(observation.text)) {
      addSignal(signals, "catch-and-ignore", "minor", `Empty catch body pattern present in ${sourcePath}; static pattern does not establish runtime error handling behavior.`, [sourceEvidence(observation, "Bounded source read containing catch-and-ignore pattern.")]);
    }
    if (/\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"']{4,}["']/iu.test(observation.text)) {
      addSignal(signals, "credential-like-string", "moderate", `Credential-like assignment pattern present in ${sourcePath}; this is a conservative static match, not confirmed secret exposure.`, [sourceEvidence(observation, "Bounded source read containing credential-like assignment pattern.")]);
    }
    if (/\b(?:req|request)\.(?:body|query|params)\b|\bprocess\.stdin\b/iu.test(observation.text)) {
      addSignal(signals, "unbounded-input", "major", `Potentially unbounded input access pattern present in ${sourcePath}; runtime validation and limits are not proven by static structure.`, [sourceEvidence(observation, "Bounded source read containing unbounded-input pattern.")]);
    }
    if (!isTestFile(sourcePath) && !linkedSources.has(sourcePath) && sourcePath !== "package.json") {
      addSignal(signals, "missing-test-neighbor", "minor", `No conservative test-to-source neighbor was found for ${sourcePath}; static absence is not proof that no test exists.`, [sourceEvidence(observation, "Source file without a conservative test neighbor link.")]);
    }
    if (isManifestOrCi(sourcePath)) {
      addSignal(
        signals,
        "verification-evidence-missing",
        "moderate",
        `Manifest or CI file ${sourcePath} is present without a command-result or test-result evidence record in this collector input.`,
        [sourceEvidence(observation, "Manifest or CI source file requiring explicit verification evidence."), ...verificationEvidence]
      );
    }
  }
  return signals;
}

export async function collectBrownfieldSignals(input: {
  readonly repositoryRoot: string;
  readonly snapshot: CodeIndexSnapshot;
  readonly sqlitePath: string;
}): Promise<BrownfieldSignals> {
  if (input.snapshot.profile !== "structural") throw new Error("Brownfield signals require a structural CodeIndexSnapshot.");
  const sqliteArtifactPath = artifactPathForSqlite(input.repositoryRoot, input.sqlitePath, input.snapshot.sqlite.path);
  const sourcePaths = sorted(input.snapshot.coverage.map((coverage) => coverage.path), compareStrings);
  const expectedHashes = expectedSourceHashes(input.snapshot);
  const observations = new Map<string, SourceObservation>();
  for (const sourcePath of sourcePaths) {
    const observation = await inspectSourceFile(input.repositoryRoot, sourcePath, expectedHashes);
    observations.set(sourcePath, observation);
  }

  const testFiles = sourcePaths.filter(isTestFile);
  const sourceFiles = sourcePaths.filter((sourcePath) => !isTestFile(sourcePath));
  const testToSourceLinks = findTestLinks(testFiles, sourcePaths);
  const dependencyEdges = sorted(input.snapshot.imports, (left, right) =>
    compareStrings(left.path, right.path) || compareStrings(left.specifier, right.specifier) || compareStrings(left.id, right.id)
  ).map((fact) => ({
    from: fact.path,
    to: fact.specifier,
    evidence: importFactEvidence(sqliteArtifactPath, input.snapshot.sqlite.sha256, fact)
  }));
  const architectureSignals = sortSignals(collectArchitectureSignals({
    snapshot: input.snapshot,
    observations,
    sqliteArtifactPath
  }));
  const riskSignals = sortSignals(collectRiskSignals({
    observations,
    sourceFiles,
    testFiles,
    testLinks: testToSourceLinks
  }));
  const unsupportedSignals = architectureSignals.filter((signal) => signal.code === "unsupported-file").length;
  const highRiskSignals = riskSignals.filter((signal) => signal.severity === "critical" || signal.severity === "major").length;
  const summary: AssessmentSignalSummary = {
    sourceFiles: sourcePaths.length,
    coverageFiles: input.snapshot.coverage.length,
    symbols: input.snapshot.symbols.length,
    imports: input.snapshot.imports.length,
    exports: input.snapshot.exports.length,
    testFiles: testFiles.length,
    testToSourceLinks: testToSourceLinks.length,
    dependencyEdges: dependencyEdges.length,
    highRiskSignals,
    unsupportedSignals
  };
  return {
    summary,
    dependencyEdges,
    testFiles,
    testToSourceLinks,
    architectureSignals,
    riskSignals
  };
}
