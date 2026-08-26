import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  artifactReferenceSchema,
  artifactPathSchema,
  assessmentIdSchema,
  assessmentEffortSchema,
  brownfieldAssessmentSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotSchema,
  codeIndexSourcePathSchema,
  type ArtifactPath,
  type BrownfieldAssessment,
  type CodeIndexSha256
} from "@legion/protocol";
import { resolveProjectArtifactPath, stableProtocolJson } from "@legion/artifacts";

import {
  discoverLatestStructuralCodeIndex,
  resolveMapState,
  type LatestStructuralCodeIndex
} from "./codebase-map.js";

const ASSESSMENT_ROOT = ".legion/project/assessment";
// artifactPathSchema intentionally rejects a dot-only path. Keep the root
// representation relative and host-independent while remaining schema-valid.
const SAFE_REPOSITORY_ROOT = "repository";
const REFRESH_ACTION = "legion map --refresh --profile structural";
const BUNDLE_FILE_NAMES = [
  "state.json",
  "signals.json",
  "assumptions.json",
  "findings.json",
  "synthesis.json",
  "review.json"
] as const;
const MAX_BUNDLE_FILE_BYTES = 16 * 1024 * 1024;
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export interface BrownfieldAssessmentPaths {
  readonly root: ArtifactPath;
  readonly state: ArtifactPath;
  readonly signals: ArtifactPath;
  readonly assumptions: ArtifactPath;
  readonly findings: ArtifactPath;
  readonly synthesis: ArtifactPath;
  readonly review: ArtifactPath;
}

type BundleFileName = (typeof BUNDLE_FILE_NAMES)[number];

type AssessmentProvenance = {
  readonly generatedAt: string;
  readonly scope: string;
  readonly snapshotId: string;
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
};

type ResolvedBundlePath = {
  readonly repositoryPath: ArtifactPath;
  readonly absolutePath: string;
};

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function stripSha256Prefix(value: string): CodeIndexSha256 {
  return codeIndexSha256Schema.parse(value.startsWith("sha256:") ? value.slice("sha256:".length) : value);
}

function assessmentPaths(assessmentId: string): BrownfieldAssessmentPaths {
  const root = artifactPathSchema.parse(`${ASSESSMENT_ROOT}/${assessmentId}`);
  const pathFor = (fileName: BundleFileName): ArtifactPath => artifactPathSchema.parse(`${root}/${fileName}`);
  return {
    root,
    state: pathFor("state.json"),
    signals: pathFor("signals.json"),
    assumptions: pathFor("assumptions.json"),
    findings: pathFor("findings.json"),
    synthesis: pathFor("synthesis.json"),
    review: pathFor("review.json")
  };
}

function assertAssessmentArtifactPath(artifactPath: ArtifactPath): void {
  if (artifactPath !== ASSESSMENT_ROOT && !artifactPath.startsWith(`${ASSESSMENT_ROOT}/`)) {
    throw new Error(`Brownfield assessment artifact path must stay under ${ASSESSMENT_ROOT}: ${artifactPath}`);
  }
}

async function resolveSafeBundlePath(repositoryRoot: string, artifactPath: ArtifactPath): Promise<ResolvedBundlePath> {
  assertAssessmentArtifactPath(artifactPath);
  const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath });
  const repositoryRealPath = path.resolve(resolved.repositoryRoot);
  const assessmentRealPath = path.join(repositoryRealPath, ".legion", "project", "assessment");
  const relativeToAssessment = path.relative(assessmentRealPath, resolved.absolutePath);
  if (relativeToAssessment === ".." || relativeToAssessment.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToAssessment)) {
    throw new Error(`Brownfield assessment artifact path escapes ${ASSESSMENT_ROOT}: ${artifactPath}`);
  }

  let current = repositoryRealPath;
  for (const [index, component] of artifactPath.split("/").entries()) {
    current = path.join(current, component);
    let componentStat;
    try {
      componentStat = await lstat(current);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) break;
      throw error;
    }
    if (componentStat.isSymbolicLink()) {
      throw new Error(`Brownfield assessment artifact path contains a symbolic link: ${artifactPath}`);
    }
    const isFinalComponent = index === artifactPath.split("/").length - 1;
    if (!isFinalComponent && !componentStat.isDirectory()) {
      throw new Error(`Brownfield assessment artifact path contains a non-directory component: ${artifactPath}`);
    }
  }

  return { repositoryPath: resolved.repositoryPath, absolutePath: resolved.absolutePath };
}

async function lstatIfPresent(absolutePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function fsyncDirectoryIfSupported(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (isNodeErrorCode(error, "EACCES") || isNodeErrorCode(error, "EBADF") ||
      isNodeErrorCode(error, "EISDIR") || isNodeErrorCode(error, "EINVAL") ||
      isNodeErrorCode(error, "ENOTSUP") || isNodeErrorCode(error, "EPERM")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWriteText(repositoryRoot: string, artifactPath: ArtifactPath, text: string): Promise<void> {
  const resolved = await resolveSafeBundlePath(repositoryRoot, artifactPath);
  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await resolveSafeBundlePath(repositoryRoot, artifactPath);

  const existing = await lstatIfPresent(resolved.absolutePath);
  if (existing !== undefined) {
    throw new Error(`Refusing to overwrite existing brownfield assessment artifact: ${artifactPath}`);
  }

  const temporaryPath = path.join(
    path.dirname(resolved.absolutePath),
    `.${path.basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW_FLAG,
      0o600
    );
    await temporaryHandle.writeFile(text, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, resolved.absolutePath);
    await fsyncDirectoryIfSupported(path.dirname(resolved.absolutePath));
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function openValidatedBundleFile(repositoryRoot: string, artifactPath: ArtifactPath): Promise<import("node:fs/promises").FileHandle> {
  const resolved = await resolveSafeBundlePath(repositoryRoot, artifactPath);
  const linkStat = await lstatIfPresent(resolved.absolutePath);
  if (linkStat === undefined) throw new Error(`Brownfield assessment artifact is missing: ${artifactPath}`);
  if (linkStat.isSymbolicLink()) throw new Error(`Brownfield assessment artifact must not be a symbolic link: ${artifactPath}`);
  if (!linkStat.isFile()) throw new Error(`Brownfield assessment artifact is not a regular file: ${artifactPath}`);

  const descriptor = await open(resolved.absolutePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    const openedStat = await descriptor.stat();
    if (!openedStat.isFile()) throw new Error(`Brownfield assessment artifact is not a regular file: ${artifactPath}`);
    if (linkStat.dev !== 0 && openedStat.dev !== 0 && (linkStat.dev !== openedStat.dev || linkStat.ino !== openedStat.ino)) {
      throw new Error(`Brownfield assessment artifact changed while opening: ${artifactPath}`);
    }
    if (openedStat.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`Brownfield assessment artifact exceeds the bounded size limit: ${artifactPath}`);
    }
    return descriptor;
  } catch (error) {
    await descriptor.close().catch(() => undefined);
    throw error;
  }
}

async function readBundleJson(repositoryRoot: string, artifactPath: ArtifactPath): Promise<unknown> {
  const descriptor = await openValidatedBundleFile(repositoryRoot, artifactPath);
  try {
    const text = await descriptor.readFile({ encoding: "utf8" });
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Brownfield assessment artifact is not valid JSON: ${artifactPath}`, { cause: error });
  } finally {
    await descriptor.close();
  }
}

async function assertCompleteBundle(repositoryRoot: string, paths: BrownfieldAssessmentPaths): Promise<void> {
  const root = await resolveSafeBundlePath(repositoryRoot, paths.root);
  const rootStat = await lstatIfPresent(root.absolutePath);
  if (rootStat === undefined) throw new Error(`Brownfield assessment bundle is missing: ${paths.root}`);
  if (rootStat.isSymbolicLink()) throw new Error(`Brownfield assessment bundle root must not be a symbolic link: ${paths.root}`);
  if (!rootStat.isDirectory()) throw new Error(`Brownfield assessment bundle root is not a directory: ${paths.root}`);

  let entries;
  try {
    entries = await readdir(root.absolutePath, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Brownfield assessment bundle cannot be read: ${paths.root}`, { cause: error });
  }
  const expected = new Set<string>(BUNDLE_FILE_NAMES);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name))) {
    throw new Error(`Brownfield assessment bundle is partial or contains unexpected files: ${paths.root}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Brownfield assessment bundle contains an unsafe file: ${paths.root}/${entry.name}`);
    }
  }
  for (const fileName of BUNDLE_FILE_NAMES) {
    const artifactPath = paths[fileName.slice(0, -5) as "state" | "signals" | "assumptions" | "findings" | "synthesis" | "review"];
    await resolveSafeBundlePath(repositoryRoot, artifactPath);
  }
}

function parseScope(scope: string): string {
  if (scope === ".") return scope;
  return codeIndexSourcePathSchema.parse(scope);
}

function diagnostic(message: string): Error {
  return new Error(`Brownfield assessment is blocked: ${message} Next action: ${REFRESH_ACTION}.`);
}

function inputProvenance(snapshot: LatestStructuralCodeIndex, scope: string): AssessmentProvenance {
  const parsedSnapshot = codeIndexSnapshotSchema.parse(snapshot.snapshot);
  const snapshotArtifact = artifactReferenceSchema.parse(snapshot.snapshotArtifact);
  const sqliteArtifact = artifactReferenceSchema.parse(snapshot.sqliteArtifact);
  const sqliteSha256 = stripSha256Prefix(sqliteArtifact.sha256);
  if (snapshotArtifact.path !== snapshot.semanticIndexArtifactPath ||
    parsedSnapshot.sqlite.path !== sqliteArtifact.path || parsedSnapshot.sqlite.sha256 !== sqliteSha256) {
    throw diagnostic("the structural snapshot artifact paths or SQLite provenance do not match their artifact references");
  }
  return {
    generatedAt: parsedSnapshot.generatedAt,
    scope,
    snapshotId: parsedSnapshot.snapshotId,
    sourceFingerprint: parsedSnapshot.sourceFingerprint,
    semanticIndexSha256: stripSha256Prefix(snapshotArtifact.sha256),
    semanticSqliteSha256: sqliteSha256
  };
}

function latestProvenance(latest: LatestStructuralCodeIndex): AssessmentProvenance {
  return inputProvenance(latest, latest.snapshot.scope);
}

function assertSameProvenance(expected: AssessmentProvenance, actual: AssessmentProvenance): void {
  const fields: readonly (keyof AssessmentProvenance)[] = [
    "scope",
    "snapshotId",
    "sourceFingerprint",
    "semanticIndexSha256",
    "semanticSqliteSha256",
    "generatedAt"
  ];
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      throw diagnostic(`structural snapshot provenance mismatch for ${field}; the assessment is bound to a different snapshot`);
    }
  }
}

async function validateFreshStructuralSnapshot(input: {
  readonly repositoryRoot: string;
  readonly expected: AssessmentProvenance;
  readonly supplied?: LatestStructuralCodeIndex;
}): Promise<LatestStructuralCodeIndex> {
  const now = new Date().toISOString();
  let mapState;
  try {
    mapState = await resolveMapState(input.repositoryRoot, input.expected.scope, now, "structural");
  } catch (error) {
    throw diagnostic(`unable to validate the latest structural snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ("error" in mapState) throw diagnostic(mapState.error);
  if (mapState.freshness !== "fresh") {
    throw diagnostic(`${mapState.reason} A fresh structural snapshot is required.`);
  }

  let discovery;
  try {
    discovery = await discoverLatestStructuralCodeIndex(input.repositoryRoot);
  } catch (error) {
    throw diagnostic(`unable to discover the latest structural snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = discovery.record;
  if (latest === undefined) {
    const details = discovery.diagnostics.map((entry) => entry.message).join("; ");
    throw diagnostic(`no usable structural snapshot exists${details.length > 0 ? `: ${details}` : "."}`);
  }
  const actual = latestProvenance(latest);
  assertSameProvenance(input.expected, actual);
  if (input.supplied !== undefined) {
    const suppliedProvenance = inputProvenance(input.supplied, input.expected.scope);
    assertSameProvenance(input.expected, suppliedProvenance);
    if (input.supplied.semanticIndexArtifactPath !== latest.semanticIndexArtifactPath ||
      input.supplied.semanticSqliteArtifactPath !== latest.semanticSqliteArtifactPath ||
      input.supplied.snapshot.sqlite.path !== latest.snapshot.sqlite.path) {
      throw diagnostic("the supplied structural snapshot artifact paths do not match the latest snapshot");
    }
  }
  return latest;
}

function assessmentIdFor(input: AssessmentProvenance, effort: number): string {
  const identity = [
    input.snapshotId,
    input.scope,
    String(effort),
    input.sourceFingerprint,
    input.semanticIndexSha256,
    input.semanticSqliteSha256,
    input.generatedAt
  ].join("\u0000");
  return `assess_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

function initialAssessment(input: {
  readonly assessmentId: string;
  readonly effort: number;
  readonly provenance: AssessmentProvenance;
}): BrownfieldAssessment {
  return brownfieldAssessmentSchema.parse({
    schemaVersion: 1,
    kind: "brownfield_assessment",
    assessmentId: input.assessmentId,
    generatedAt: input.provenance.generatedAt,
    effort: input.effort,
    phase: "setup",
    repositoryRoot: SAFE_REPOSITORY_ROOT,
    scope: input.provenance.scope,
    snapshotId: input.provenance.snapshotId,
    sourceFingerprint: input.provenance.sourceFingerprint,
    semanticIndexSha256: input.provenance.semanticIndexSha256,
    semanticSqliteSha256: input.provenance.semanticSqliteSha256,
    signals: {
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
    },
    assumptions: [],
    findings: [],
    nextActions: []
  });
}

async function readAssessmentState(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly paths: BrownfieldAssessmentPaths;
}): Promise<BrownfieldAssessment> {
  const value = await readBundleJson(input.repositoryRoot, input.paths.state);
  const state = brownfieldAssessmentSchema.parse(value);
  if (state.assessmentId !== input.assessmentId) {
    throw new Error(`Brownfield assessment state ID does not match its directory: ${input.assessmentId}`);
  }
  if (state.repositoryRoot !== SAFE_REPOSITORY_ROOT) {
    throw new Error(`Brownfield assessment repositoryRoot must be the safe repository-relative value '${SAFE_REPOSITORY_ROOT}'.`);
  }
  return state;
}

async function bundleRootStatus(repositoryRoot: string, paths: BrownfieldAssessmentPaths): Promise<"missing" | "existing"> {
  const resolved = await resolveSafeBundlePath(repositoryRoot, paths.root);
  const rootStat = await lstatIfPresent(resolved.absolutePath);
  if (rootStat === undefined) return "missing";
  if (rootStat.isSymbolicLink()) throw new Error(`Brownfield assessment bundle root must not be a symbolic link: ${paths.root}`);
  if (!rootStat.isDirectory()) throw new Error(`Brownfield assessment bundle root is not a directory: ${paths.root}`);
  return "existing";
}

async function writeInitialBundle(input: {
  readonly repositoryRoot: string;
  readonly paths: BrownfieldAssessmentPaths;
  readonly state: BrownfieldAssessment;
}): Promise<void> {
  const root = await resolveSafeBundlePath(input.repositoryRoot, input.paths.root);
  await mkdir(root.absolutePath, { recursive: true });
  await resolveSafeBundlePath(input.repositoryRoot, input.paths.root);

  const placeholder = stableProtocolJson([]);
  const contentByFile: Readonly<Record<BundleFileName, string>> = {
    "state.json": stableProtocolJson(input.state),
    "signals.json": placeholder,
    "assumptions.json": placeholder,
    "findings.json": placeholder,
    "synthesis.json": placeholder,
    "review.json": placeholder
  };
  for (const fileName of BUNDLE_FILE_NAMES) {
    const field = fileName.slice(0, -5) as "state" | "signals" | "assumptions" | "findings" | "synthesis" | "review";
    await atomicWriteText(input.repositoryRoot, input.paths[field], contentByFile[fileName]);
  }
}

export async function createBrownfieldAssessment(input: {
  readonly repositoryRoot: string;
  readonly effort: number;
  readonly scope?: string;
  readonly snapshot: LatestStructuralCodeIndex;
}): Promise<{ readonly assessmentId: string; readonly paths: BrownfieldAssessmentPaths }> {
  const effort = assessmentEffortSchema.parse(input.effort);
  let suppliedSnapshot;
  try {
    suppliedSnapshot = codeIndexSnapshotSchema.parse(input.snapshot?.snapshot);
  } catch (error) {
    let discovery;
    try {
      discovery = await discoverLatestStructuralCodeIndex(input.repositoryRoot);
    } catch (discoveryError) {
      throw diagnostic(`no usable structural snapshot exists: ${discoveryError instanceof Error ? discoveryError.message : String(discoveryError)}`);
    }
    if (discovery.record === undefined) {
      const details = discovery.diagnostics.map((entry) => entry.message).join("; ");
      throw diagnostic(`no usable structural snapshot exists${details.length > 0 ? `: ${details}` : "."}`);
    }
    throw error;
  }
  const scope = parseScope(input.scope ?? suppliedSnapshot.scope);
  if (suppliedSnapshot.scope !== scope) {
    throw diagnostic(`requested scope ${scope} does not exactly match the supplied structural snapshot scope ${suppliedSnapshot.scope}`);
  }
  const suppliedProvenance = inputProvenance(input.snapshot, scope);
  const latest = await validateFreshStructuralSnapshot({
    repositoryRoot: input.repositoryRoot,
    expected: suppliedProvenance,
    supplied: input.snapshot
  });
  const provenance = latestProvenance(latest);
  assertSameProvenance(suppliedProvenance, provenance);
  const assessmentId = assessmentIdFor(provenance, effort);
  const paths = assessmentPaths(assessmentId);
  const existingStatus = await bundleRootStatus(input.repositoryRoot, paths);
  if (existingStatus === "existing") {
    await assertCompleteBundle(input.repositoryRoot, paths);
    await readBrownfieldAssessment({ repositoryRoot: input.repositoryRoot, assessmentId });
    return { assessmentId, paths };
  }

  try {
    await writeInitialBundle({
      repositoryRoot: input.repositoryRoot,
      paths,
      state: initialAssessment({ assessmentId, effort, provenance })
    });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      await assertCompleteBundle(input.repositoryRoot, paths);
      await readBrownfieldAssessment({ repositoryRoot: input.repositoryRoot, assessmentId });
      return { assessmentId, paths };
    }
    throw error;
  }
  await assertCompleteBundle(input.repositoryRoot, paths);
  return { assessmentId, paths };
}

export async function readBrownfieldAssessment(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
}): Promise<{ readonly state: BrownfieldAssessment; readonly paths: BrownfieldAssessmentPaths }> {
  const assessmentId = input.assessmentId;
  const parsedAssessmentId = assessmentIdSchema.parse(assessmentId);
  const paths = assessmentPaths(parsedAssessmentId);
  await assertCompleteBundle(input.repositoryRoot, paths);
  const state = await readAssessmentState({ repositoryRoot: input.repositoryRoot, assessmentId: parsedAssessmentId, paths });
  for (const artifactPath of [paths.signals, paths.assumptions, paths.findings, paths.synthesis, paths.review]) {
    await readBundleJson(input.repositoryRoot, artifactPath);
  }
  const expected: AssessmentProvenance = {
    generatedAt: state.generatedAt,
    scope: state.scope,
    snapshotId: state.snapshotId,
    sourceFingerprint: state.sourceFingerprint,
    semanticIndexSha256: state.semanticIndexSha256,
    semanticSqliteSha256: state.semanticSqliteSha256
  };
  await validateFreshStructuralSnapshot({ repositoryRoot: input.repositoryRoot, expected });
  return { state, paths };
}
