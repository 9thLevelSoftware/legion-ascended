import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  artifactPathSchema,
  assessmentSeveritySchema,
  codeIndexFactIdSchema,
  codeIndexSha256Schema,
  codeIndexSourcePathSchema,
  type ArtifactPath,
  type AssessmentEvidenceRef,
  type AssessmentSeverity,
  type AssessmentSignalSummary,
  type CodeIndexImport,
  type CodeIndexSha256,
  type CodeIndexSnapshot,
  type CodeIndexSourcePath
} from "@legion/protocol";
import { fingerprintSourceFiles } from "./codebase-map.js";

const MAX_BOUNDED_SOURCE_BYTES = 256 * 1024;
const MAX_BOUNDED_MAP_BYTES = 16 * 1024 * 1024;
const MAX_SIGNAL_EVIDENCE = 64;
const BOUNDED_SAMPLE_NOTE = `Bounded sample: first ${MAX_SIGNAL_EVIDENCE} deterministic evidence references.`;
const OPAQUE_IMPORT_SPECIFIER = "opaque external import specifier (redacted)";
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
const SOURCE_CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py"]);
const BINARY_EXTENSIONS = new Set([
  ".a", ".bin", ".class", ".dll", ".dylib", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3",
  ".mp4", ".o", ".pdf", ".png", ".so", ".tar", ".ttf", ".wasm", ".wav", ".webp", ".woff", ".woff2", ".zip"
]);
const GENERATED_DIRECTORY_NAMES = new Set(["build", "dist", "generated", "gen", "out", "target", "__generated__"]);

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

function sourceExtension(sourcePath: string): string {
  return path.posix.extname(sourcePath).toLowerCase();
}

function isGeneratedPath(sourcePath: string): boolean {
  const parts = sourcePath.toLowerCase().split("/");
  const basename = path.posix.basename(sourcePath).toLowerCase();
  const extension = path.posix.extname(basename);
  const stem = extension.length === 0 ? basename : basename.slice(0, -extension.length);
  return parts.slice(0, -1).some((part) => GENERATED_DIRECTORY_NAMES.has(part)) ||
    /(?:^|[._-])(?:generated|gen)(?:$|[._-])/u.test(stem);
}

function isEligibleSourceForTestNeighbor(coverage: CodeIndexSnapshot["coverage"][number]): boolean {
  return coverage.status === "parsed" && SOURCE_CODE_EXTENSIONS.has(sourceExtension(coverage.path)) &&
    !isGeneratedPath(coverage.path) && !isDocumentation(coverage.path) && !isManifestOrCi(coverage.path);
}

function topLevelRoot(sourcePath: string): string {
  return sourcePath.split("/")[0] ?? sourcePath;
}

function isManifestOrCi(sourcePath: string): boolean {
  const normalizedPath = sourcePath.toLowerCase();
  const basename = path.posix.basename(sourcePath).toLowerCase();
  return MANIFEST_NAMES.has(basename) ||
    (basename.startsWith("package.") && basename.endsWith(".json")) ||
    CI_FILE_NAMES.has(basename) ||
    normalizedPath.startsWith("ci/") ||
    (normalizedPath.startsWith(".github/workflows/") && normalizedPath.split("/").length > 2);
}

function isBinaryPath(sourcePath: string): boolean {
  return BINARY_EXTENSIONS.has(sourceExtension(sourcePath));
}

function isDocumentation(sourcePath: string): boolean {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  return extension === ".md" || extension === ".mdx" || sourcePath.toLowerCase().includes("/docs/") ||
    sourcePath.toLowerCase().startsWith("docs/");
}

function isEligibleTestInventoryPath(sourcePath: string): boolean {
  return !isGeneratedPath(sourcePath) && !isDocumentation(sourcePath) && !isManifestOrCi(sourcePath) && !isBinaryPath(sourcePath);
}

function addSignal(
  target: Signal[],
  code: string,
  severity: AssessmentSeverity,
  statement: string,
  evidence: readonly AssessmentEvidenceRef[],
  boundedSample = false
): void {
  if (evidence.length === 0) throw new Error(`Brownfield signal ${code} has no evidence.`);
  const isBoundedSample = boundedSample || evidence.length > MAX_SIGNAL_EVIDENCE;
  const sampledEvidence = evidence.slice(0, MAX_SIGNAL_EVIDENCE);
  const finalEvidence = isBoundedSample
    ? sampledEvidence.map((reference) => ({
      ...reference,
      note: `${reference.note.slice(0, Math.max(0, 512 - BOUNDED_SAMPLE_NOTE.length - 1))} ${BOUNDED_SAMPLE_NOTE}`
    }))
    : sampledEvidence;
  const finalStatement = isBoundedSample
    ? `${statement} Evidence is a bounded sample capped at ${MAX_SIGNAL_EVIDENCE} references.`
    : statement;
  target.push({ code, severity: assessmentSeveritySchema.parse(severity), statement: finalStatement, evidence: finalEvidence });
}

function sortSignals(signals: readonly Signal[]): Signal[] {
  return sorted(signals, (left, right) =>
    compareStrings(left.code, right.code) ||
    compareStrings(left.statement, right.statement) ||
    compareStrings(JSON.stringify(left.evidence), JSON.stringify(right.evidence))
  );
}

async function artifactPathForSqlite(
  repositoryRoot: string,
  sqlitePath: string,
  expected: string,
  expectedSha256: CodeIndexSha256
): Promise<ArtifactPath> {
  const root = path.resolve(repositoryRoot);
  const absolute = path.resolve(root, sqlitePath);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  const parsed = artifactPathSchema.parse(relative);
  if (parsed !== expected) {
    throw new Error(`SQLite path ${sqlitePath} does not match the validated snapshot path ${expected}.`);
  }

  let fileStat;
  try {
    fileStat = await stat(absolute);
  } catch (error) {
    throw new Error(`SQLite materialization is missing or unreadable at ${parsed}.`, { cause: error });
  }
  if (!fileStat.isFile()) throw new Error(`SQLite materialization is not a regular file at ${parsed}.`);

  const actualSha256 = await hashFile(absolute);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SQLite materialization hash does not match the snapshot: expected ${expectedSha256}, got ${actualSha256}.`);
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

type RiskPatternMatches = {
  readonly todoFixme: boolean;
  readonly emptyFunction: boolean;
  readonly catchAndIgnore: boolean;
  readonly credentialLikeString: boolean;
  readonly unboundedInput: boolean;
};

/**
 * Scan one bounded source read and return only booleans to the caller. Keeping
 * the text local to this helper prevents the risk collector from retaining a
 * source string in its loop state, signals, or closures.
 */
async function scanBoundedSourceFile(absolutePath: string): Promise<RiskPatternMatches> {
  const text = await readBoundedSource(absolutePath);
  return {
    todoFixme: /\b(?:TODO|FIXME)\b/iu.test(text),
    emptyFunction: /(?:\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*\}|=>\s*\{\s*\})/u.test(text),
    catchAndIgnore: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/u.test(text),
    credentialLikeString: /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"']{4,}["']/iu.test(text),
    unboundedInput: /\b(?:req|request)\.(?:body|query|params)\b|\bprocess\.stdin\b/iu.test(text)
  };
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
  if (expectedHash === undefined) {
    throw new Error(`Snapshot source path ${sourcePath} has no validated source hash.`);
  }
  if (expectedHash !== sha256) {
    throw new Error(`Source file ${sourcePath} changed after the validated structural snapshot.`);
  }
  return { path: sourcePath, sha256 };
}

async function readBoundedMapDocument(absolutePath: string): Promise<Record<string, unknown>> {
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    throw new Error(`Snapshot source hash inventory is missing or unreadable at ${absolutePath}.`, { cause: error });
  }
  if (!fileStat.isFile()) throw new Error(`Snapshot source hash inventory is not a regular file at ${absolutePath}.`);
  if (fileStat.size > MAX_BOUNDED_MAP_BYTES) {
    throw new Error(`Snapshot source hash inventory exceeds the bounded metadata limit at ${absolutePath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Snapshot source hash inventory is not valid JSON at ${absolutePath}.`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Snapshot source hash inventory must be an object at ${absolutePath}.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Structural facts carry source hashes individually, but coverage-only files do
 * not have facts. The sibling v1 map.json is produced by the same map run and
 * carries the complete path/hash inventory; its fingerprint binds that inventory
 * to this structural snapshot before source evidence is emitted.
 */
async function expectedSourceHashes(
  repositoryRoot: string,
  sqliteArtifactPath: ArtifactPath,
  snapshot: CodeIndexSnapshot
): Promise<ReadonlyMap<string, CodeIndexSha256>> {
  const sqliteAbsolutePath = path.join(repositoryRoot, ...sqliteArtifactPath.split("/"));
  const mapAbsolutePath = path.join(path.dirname(sqliteAbsolutePath), "map.json");
  const mapDocument = await readBoundedMapDocument(mapAbsolutePath);
  if (mapDocument["schemaVersion"] !== 1 || mapDocument["kind"] !== "codebase_map") {
    throw new Error("Snapshot source hash inventory has invalid map identity.");
  }
  if (mapDocument["scope"] !== snapshot.scope) {
    throw new Error("Snapshot source hash inventory scope does not match the validated structural snapshot.");
  }
  if (mapDocument["generatedAt"] !== snapshot.generatedAt) {
    throw new Error("Snapshot source hash inventory timestamp does not match the validated structural snapshot.");
  }

  const declaredSourceFingerprint = codeIndexSha256Schema.parse(mapDocument["sourceFingerprint"]);
  const declaredSourceFileCount = mapDocument["sourceFileCount"];
  if (!Number.isSafeInteger(declaredSourceFileCount) || Number(declaredSourceFileCount) < 0) {
    throw new Error("Snapshot source hash inventory has an invalid source file count.");
  }

  const files = mapDocument["files"];
  if (!Array.isArray(files)) throw new Error("Snapshot source hash inventory has no file entries.");

  const sourceHashes = new Map<string, CodeIndexSha256>();
  const fingerprintEntries = [] as {
    readonly path: CodeIndexSourcePath;
    readonly sha256: CodeIndexSha256;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly symbols: readonly string[];
    readonly headings: readonly string[];
    readonly summary: string;
  }[];
  for (const file of files) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new Error("Snapshot source hash inventory contains an invalid file entry.");
    }
    const record = file as Record<string, unknown>;
    const sourcePath = codeIndexSourcePathSchema.parse(record["path"]);
    const sourceSha256 = codeIndexSha256Schema.parse(record["sha256"]);
    if (sourceHashes.has(sourcePath)) throw new Error(`Snapshot source hash inventory contains a duplicate path: ${sourcePath}.`);
    sourceHashes.set(sourcePath, sourceSha256);
    fingerprintEntries.push({
      path: sourcePath,
      sha256: sourceSha256,
      sizeBytes: 0,
      lineCount: 0,
      symbols: [],
      headings: [],
      summary: ""
    });
  }

  if (declaredSourceFileCount !== files.length || files.length !== snapshot.coverage.length) {
    throw new Error("Snapshot source hash inventory file count does not match the validated structural snapshot coverage.");
  }
  const coveragePaths = new Set<string>(snapshot.coverage.map((coverage) => coverage.path));
  for (const sourcePath of sourceHashes.keys()) {
    if (!coveragePaths.has(sourcePath)) {
      throw new Error(`Snapshot source hash inventory path ${sourcePath} is absent from snapshot coverage.`);
    }
  }
  for (const coverage of snapshot.coverage) {
    if (!sourceHashes.has(coverage.path)) {
      throw new Error(`Snapshot source hash inventory has no hash for coverage path ${coverage.path}.`);
    }
  }

  const computedSourceFingerprint = fingerprintSourceFiles(fingerprintEntries);
  if (declaredSourceFingerprint !== computedSourceFingerprint) {
    throw new Error("Snapshot source hash inventory fingerprint does not match its validated file entries.");
  }
  if (declaredSourceFingerprint !== snapshot.sourceFingerprint) {
    throw new Error("Snapshot source hash inventory does not match the validated structural snapshot fingerprint.");
  }

  const result = new Map<string, CodeIndexSha256>();
  for (const coverage of snapshot.coverage) {
    const sourceSha256 = sourceHashes.get(coverage.path);
    if (sourceSha256 === undefined) {
      throw new Error(`Snapshot source hash inventory has no hash for coverage path ${coverage.path}.`);
    }
    result.set(coverage.path, sourceSha256);
  }
  for (const fact of [...snapshot.symbols, ...snapshot.imports, ...snapshot.exports]) {
    const sourceSha256 = result.get(fact.path);
    if (sourceSha256 === undefined) {
      throw new Error(`Structural fact path ${fact.path} is absent from snapshot coverage.`);
    }
    if (sourceSha256 !== fact.sourceSha256) {
      throw new Error(`Structural snapshot has inconsistent source hashes for ${fact.path}.`);
    }
  }
  return result;
}

function findTestLinks(
  testFiles: readonly CodeIndexSourcePath[],
  coverage: readonly CodeIndexSnapshot["coverage"][number][]
): BrownfieldSignals["testToSourceLinks"] {
  const sourceCandidates = coverage
    .filter((entry) => !isTestFile(entry.path) && isEligibleSourceForTestNeighbor(entry))
    .map((entry) => entry.path);
  const eligibleTestPaths = new Set(
    coverage
      .filter((entry) => testFiles.includes(entry.path) && isEligibleSourceForTestNeighbor(entry))
      .map((entry) => entry.path)
  );

  const links: BrownfieldSignals["testToSourceLinks"][number][] = [];
  for (const testPath of sorted(testFiles, compareStrings)) {
    if (!eligibleTestPaths.has(testPath)) continue;
    const testStem = sourceBasename(testPath);
    const testDirectory = path.posix.dirname(testPath);
    const candidates = sourceCandidates.filter((sourcePath) => sourceBasename(sourcePath) === testStem);
    if (candidates.length === 0) continue;

    let sourcePath: CodeIndexSourcePath | undefined;
    if (candidates.length === 1) {
      sourcePath = candidates[0];
    } else {
      const compatibleCandidates = candidates.filter((candidate) => sourceExtension(candidate) === sourceExtension(testPath));
      if (compatibleCandidates.length === 1) {
        sourcePath = compatibleCandidates[0];
      } else if (compatibleCandidates.length > 1) {
        const sameDirectoryCandidates = compatibleCandidates.filter((candidate) => path.posix.dirname(candidate) === testDirectory);
        if (sameDirectoryCandidates.length === 1) sourcePath = sameDirectoryCandidates[0];
      }
    }
    if (sourcePath === undefined) continue;
    links.push({
      testPath,
      sourcePath,
      reason: "parsed, supported, non-generated test-convention path; heuristic filename/path match; low confidence"
    });
  }
  return links;
}

/**
 * Return a provenance-safe representation of a persisted import specifier.
 * External specifiers can contain credentials, URLs, or query secrets, so they
 * are never copied into returned signals. Relative specifiers are normalized,
 * stripped of query/fragment data, and restricted to a bounded path token.
 */
function isRelativeImportSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function safeImportSpecifier(specifier: string): string {
  if (!isRelativeImportSpecifier(specifier)) return OPAQUE_IMPORT_SPECIFIER;
  const pathOnly = specifier.split(/[?#]/u, 1)[0] ?? ".";
  const normalized = path.posix.normalize(pathOnly);
  const relative = normalized === "." || normalized === ".." || normalized.startsWith("../")
    ? normalized
    : `./${normalized}`;
  const safe = relative.replace(/[^A-Za-z0-9._/-]/gu, "_").slice(0, 256);
  return safe.length > 0 ? safe : "./_";
}

/**
 * Resolve relative imports to every compatible repository path. When more than
 * one candidate exists, retain all candidates so the orphan heuristic remains
 * conservative instead of inventing a single module resolution.
 */
function importTargetPaths(
  fact: CodeIndexImport,
  availablePaths: ReadonlySet<string>
): readonly string[] {
  const specifier = fact.specifier;
  if (!isRelativeImportSpecifier(specifier)) return [];
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fact.path), specifier));
  const candidates = [target];
  const extension = sourceExtension(target);
  if (extension === ".js") candidates.push(`${target.slice(0, -extension.length)}.ts`, `${target.slice(0, -extension.length)}.tsx`);
  else if (extension === ".jsx") candidates.push(`${target.slice(0, -extension.length)}.tsx`);
  else if (extension.length === 0) {
    for (const candidateExtension of [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py"]) {
      candidates.push(`${target}${candidateExtension}`);
    }
  }
  return candidates.filter((candidate, index) => availablePaths.has(candidate) && candidates.indexOf(candidate) === index);
}

function modulesWithResolvedImports(snapshot: CodeIndexSnapshot): ReadonlySet<string> {
  const availablePaths = new Set(snapshot.coverage.map((coverage) => coverage.path));
  const importedPaths = new Set<string>();
  for (const fact of snapshot.imports) {
    for (const target of importTargetPaths(fact, availablePaths)) importedPaths.add(target);
  }
  return importedPaths;
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
      [sourceEvidence(observation, "Source file for persisted import fan-out."), ...facts.slice(0, 8).map((fact) => importFactEvidence(sqliteArtifactPath, sqliteSha256, fact))],
      facts.length > 8
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
      `Import specifier ${safeImportSpecifier(specifier)} appears in ${facts.length} persisted import facts; the collector does not resolve it to a module.`,
      [...observationsForFacts, ...facts.slice(0, 8).map((fact) => importFactEvidence(sqliteArtifactPath, sqliteSha256, fact))],
      facts.length > 8
    );
  }

  const modulesWithImports = modulesWithResolvedImports(snapshot);
  for (const fact of snapshot.exports) {
    if (!fact.name || modulesWithImports.has(fact.path)) continue;
    const observation = sourceObservationFor(observations, fact.path);
    addSignal(
      signals,
      "orphan-export",
      "minor",
      `Exported symbol ${fact.name} in ${fact.path} has no resolved relative import to its module; this is an unreferenced module-level export heuristic, not symbol-level import matching or proof of unused behavior.`,
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
      `Relative import specifier ${safeImportSpecifier(fact.specifier)} from ${fact.path} crosses a repository root boundary; it is not resolved here.`,
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


async function collectRiskSignals(input: {
  readonly repositoryRoot: string;
  readonly observations: ReadonlyMap<string, SourceObservation>;
  readonly sourceFiles: readonly CodeIndexSourcePath[];
  readonly testFiles: readonly CodeIndexSourcePath[];
  readonly testLinks: BrownfieldSignals["testToSourceLinks"];
  readonly eligibleTestNeighborSources: ReadonlySet<string>;
}): Promise<Signal[]> {
  const { repositoryRoot, observations, sourceFiles, testFiles, testLinks, eligibleTestNeighborSources } = input;
  const signals: Signal[] = [];
  const linkedSources = new Set(testLinks.map((link) => link.sourcePath));
  const verificationEvidence = testFiles.slice(0, MAX_SIGNAL_EVIDENCE - 1).map((testPath) => sourceEvidence(
    sourceObservationFor(observations, testPath),
    "Test source inventory; no command result was supplied to this deterministic collector."
  ));
  const verificationEvidenceBounded = testFiles.length > MAX_SIGNAL_EVIDENCE - 1;

  for (const sourcePath of sourceFiles) {
    const observation = sourceObservationFor(observations, sourcePath);
    const absolutePath = path.join(repositoryRoot, ...sourcePath.split("/"));
    const patternMatches = await scanBoundedSourceFile(absolutePath);
    if (patternMatches.todoFixme) {
      addSignal(signals, "todo-fixme", "informational", `Static TODO/FIXME marker present in ${sourcePath}; marker presence is not proof of an unfinished behavior.`, [sourceEvidence(observation, "Bounded source read containing TODO/FIXME marker.")]);
    }
    if (patternMatches.emptyFunction) {
      addSignal(signals, "empty-function", "minor", `Empty function body pattern present in ${sourcePath}; static pattern requires review.`, [sourceEvidence(observation, "Bounded source read containing empty function pattern.")]);
    }
    if (patternMatches.catchAndIgnore) {
      addSignal(signals, "catch-and-ignore", "minor", `Empty catch body pattern present in ${sourcePath}; static pattern does not establish runtime error handling behavior.`, [sourceEvidence(observation, "Bounded source read containing catch-and-ignore pattern.")]);
    }
    if (patternMatches.credentialLikeString) {
      addSignal(signals, "credential-like-string", "moderate", `Credential-like assignment pattern present in ${sourcePath}; this is a conservative static match, not confirmed secret exposure.`, [sourceEvidence(observation, "Bounded source read containing credential-like assignment pattern.")]);
    }
    if (patternMatches.unboundedInput) {
      addSignal(signals, "unbounded-input", "major", `Potentially unbounded input access pattern present in ${sourcePath}; runtime validation and limits are not proven by static structure.`, [sourceEvidence(observation, "Bounded source read containing unbounded-input pattern.")]);
    }
    if (eligibleTestNeighborSources.has(sourcePath) && !linkedSources.has(sourcePath)) {
      addSignal(signals, "missing-test-neighbor", "minor", `No conservative test-to-source neighbor was found for ${sourcePath}; static absence is not proof that no test exists.`, [sourceEvidence(observation, "Source file without a conservative test neighbor link.")]);
    }
    if (isManifestOrCi(sourcePath)) {
      addSignal(
        signals,
        "verification-evidence-missing",
        "moderate",
        `Manifest or CI file ${sourcePath} is present without a command-result or test-result evidence record in this collector input.`,
        [sourceEvidence(observation, "Manifest or CI source file requiring explicit verification evidence."), ...verificationEvidence],
        verificationEvidenceBounded
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
  const sqliteArtifactPath = await artifactPathForSqlite(
    input.repositoryRoot,
    input.sqlitePath,
    input.snapshot.sqlite.path,
    input.snapshot.sqlite.sha256
  );
  const sourcePaths = sorted(input.snapshot.coverage.map((coverage) => coverage.path), compareStrings);
  const expectedHashes = await expectedSourceHashes(input.repositoryRoot, sqliteArtifactPath, input.snapshot);
  const observations = new Map<string, SourceObservation>();
  for (const sourcePath of sourcePaths) {
    const observation = await inspectSourceFile(input.repositoryRoot, sourcePath, expectedHashes);
    observations.set(sourcePath, observation);
  }

  const testFiles = sorted(
    input.snapshot.coverage
      .filter((coverage) => isTestFile(coverage.path) && isEligibleTestInventoryPath(coverage.path))
      .map((coverage) => coverage.path),
    compareStrings
  );
  const sourceFiles = sourcePaths.filter((sourcePath) => !isTestFile(sourcePath));
  const eligibleTestNeighborSources = new Set(
    input.snapshot.coverage
      .filter((coverage) => !isTestFile(coverage.path) && isEligibleSourceForTestNeighbor(coverage))
      .map((coverage) => coverage.path)
  );
  const testToSourceLinks = findTestLinks(testFiles, input.snapshot.coverage);
  const dependencyEdges = sorted(input.snapshot.imports, (left, right) =>
    compareStrings(left.path, right.path) || compareStrings(left.specifier, right.specifier) || compareStrings(left.id, right.id)
  ).map((fact) => ({
    from: fact.path,
    to: safeImportSpecifier(fact.specifier),
    evidence: importFactEvidence(sqliteArtifactPath, input.snapshot.sqlite.sha256, fact)
  }));
  const architectureSignals = sortSignals(collectArchitectureSignals({
    snapshot: input.snapshot,
    observations,
    sqliteArtifactPath
  }));
  const riskSignals = sortSignals(await collectRiskSignals({
    repositoryRoot: input.repositoryRoot,
    observations,
    sourceFiles,
    testFiles,
    testLinks: testToSourceLinks,
    eligibleTestNeighborSources
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
