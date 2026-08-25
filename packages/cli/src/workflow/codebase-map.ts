import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  hashContent,
  readCodeIndexSnapshot,
  resolveProjectArtifactPath,
  stableProtocolJson,
  verifyCodeIndexSqlite
} from "@legion/artifacts";
import {
  artifactPathSchema,
  codeIndexFactIdSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotIdSchema,
  formatEntityId,
  utcTimestampSchema,
  type ArtifactPath,
  type ArtifactReference,
  type CodeIndexFact,
  type CodeIndexSnapshot,
  type CodeIndexSnapshotId,
  type CodeIndexSha256,
  type RunId,
  type UtcTimestamp
} from "@legion/protocol";
import { findCodeIndexFact, queryCodeIndexStore, writeCodeIndexStore, type CodeIndexSearchHit } from "@legion/index-store";

import { buildStructuralCodeIndex, type CodeIndexSnapshotDraft } from "./code-index.js";
import { writeProjectTextFile } from "./executor/result.js";
import { guidanceArtifactPath, latestGuidanceRuns, type GuidanceRunDocument, type GuidanceRunPaths } from "./guidance-run.js";
import { isFullMapAuthoredFile, shouldTraverseAuthoredDirectory } from "./authored-source.js";

export interface CodebaseMapFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly symbols: readonly string[];
  readonly headings: readonly string[];
  readonly summary: string;
}

export type MapProfile = "inventory" | "structural";

export interface MapSourceFile extends CodebaseMapFile {
  /** Text from the same source walk, when it was safe to analyze. */
  readonly text?: string;
}

export interface CodebaseMapDocument {
  readonly schemaVersion: 1;
  readonly kind: "codebase_map";
  readonly generatedAt: UtcTimestamp;
  readonly scope: string;
  readonly sourceFingerprint: string;
  readonly sourceFileCount: number;
  readonly files: readonly CodebaseMapFile[];
}

export interface CodebaseMapArtifacts {
  readonly map: CodebaseMapDocument;
  readonly mapRunId: RunId;
  readonly mapArtifactSha256: string;
  readonly codebaseArtifactPath: ArtifactPath;
  readonly indexArtifactPath: ArtifactPath;
  readonly symbolsArtifactPath: ArtifactPath;
  readonly searchArtifactPath: ArtifactPath;
  readonly mapArtifactPath: ArtifactPath;
}

export interface CodebaseMapQueryMatch {
  readonly path: string;
  readonly score: number;
  readonly symbols: readonly string[];
  readonly summary: string;
}

/**
 * Refresh, or report that there was nothing to refresh.
 *
 * The empty-source check lives here rather than in the caller so the source set
 * is collected once. A caller-side pre-flight walked and read every file, then
 * this walked and read them again — double the I/O on a large repository, and
 * worse, the decision "there is nothing to map" was made against a different
 * snapshot from the one the artifacts were written from.
 */
/**
 * The source set a refresh would map, collected once.
 *
 * Separate from `refreshCodebaseMap` so the caller can decide whether there is
 * anything to map *before* claiming a run directory. Deciding afterwards left an
 * empty run directory behind on every refusal, and deciding from a second walk
 * meant the "nothing to map" answer came from a different snapshot than the
 * artifacts would have been written from.
 */
export async function collectMapSource(input: {
  readonly repositoryRoot: string;
  readonly scope?: string;
}): Promise<{
  readonly scope: string;
  readonly files: readonly CodebaseMapFile[];
  readonly sourceFiles: readonly MapSourceFile[];
}> {
  const scope = await normalizeScope(input.repositoryRoot, input.scope);
  const sourceFiles = await collectSourceFiles(input.repositoryRoot, scope);
  return {
    scope,
    sourceFiles,
    files: sourceFiles.map(({ text: _text, ...file }) => file)
  };
}

export async function refreshCodebaseMap(input: {
  readonly repositoryRoot: string;
  readonly paths: GuidanceRunPaths;
  readonly scope: string;
  readonly files: readonly CodebaseMapFile[];
}): Promise<CodebaseMapArtifacts> {
  const { scope, files } = input;
  const map: CodebaseMapDocument = {
    schemaVersion: 1,
    kind: "codebase_map",
    generatedAt: input.paths.createdAt,
    scope,
    sourceFingerprint: fingerprintFiles(files),
    sourceFileCount: files.length,
    files
  };

  const codebaseArtifactPath = guidanceArtifactPath(input.paths, "codebase.md");
  const indexArtifactPath = guidanceArtifactPath(input.paths, "index.jsonl");
  const symbolsArtifactPath = guidanceArtifactPath(input.paths, "symbols.json");
  const searchArtifactPath = guidanceArtifactPath(input.paths, "search.md");
  const mapArtifactPath = guidanceArtifactPath(input.paths, "map.json");
  const mapText = stableProtocolJson(map);
  const mapRunId = structuralMapRunId(input.paths.runId);

  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: codebaseArtifactPath,
    text: renderCodebaseMarkdown(map)
  });
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: indexArtifactPath,
    text: `${files.map((file) => stableProtocolJson(file).trimEnd()).join("\n")}\n`
  });
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: symbolsArtifactPath,
    text: stableProtocolJson({
      schemaVersion: 1,
      kind: "codebase_symbols",
      generatedAt: map.generatedAt,
      symbols: files.flatMap((file) => file.symbols.map((symbol) => ({ symbol, path: file.path })))
    })
  });
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: searchArtifactPath,
    text: renderSearchMarkdown(map)
  });
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: mapArtifactPath,
    text: mapText
  });

  return {
    map,
    mapRunId,
    mapArtifactSha256: hashContent(mapText).slice("sha256:".length),
    codebaseArtifactPath,
    indexArtifactPath,
    symbolsArtifactPath,
    searchArtifactPath,
    mapArtifactPath
  };
}

export interface StructuralCodeIndexArtifacts {
  readonly snapshot: CodeIndexSnapshot;
  readonly semanticIndexArtifactPath: ArtifactPath;
  readonly semanticSqliteArtifactPath: ArtifactPath;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly parserDiagnostics: readonly string[];
  readonly factCount: number;
}

/**
 * Parse and materialize the structural index from the exact source walk used by
 * the v1 map. The SQLite bytes are written before the JSON snapshot is built so
 * the snapshot pins the materialization that readers will query.
 */
export async function refreshStructuralCodeIndex(input: {
  readonly repositoryRoot: string;
  readonly paths: GuidanceRunPaths;
  readonly scope: string;
  readonly sourceFingerprint: string;
  readonly files: readonly MapSourceFile[];
}): Promise<StructuralCodeIndexArtifacts> {
  const snapshotId = structuralSnapshotId(input.paths.runId, input.sourceFingerprint);
  const mapRunId = structuralMapRunId(input.paths.runId);
  const draft: CodeIndexSnapshotDraft = await buildStructuralCodeIndex({
    snapshotId,
    mapRunId,
    generatedAt: input.paths.createdAt,
    scope: input.scope,
    sourceFingerprint: codeIndexSha256Schema.parse(input.sourceFingerprint),
    files: input.files.map((file) => ({
      path: artifactPathSchema.parse(file.path),
      sha256: codeIndexSha256Schema.parse(file.sha256),
      ...(file.text === undefined ? {} : { text: file.text })
    }))
  });

  const semanticIndexArtifactPath = guidanceArtifactPath(input.paths, "semantic-index.json");
  const semanticSqliteArtifactPath = guidanceArtifactPath(input.paths, "semantic-index.sqlite");
  const databasePath = path.join(input.repositoryRoot, ...semanticSqliteArtifactPath.split("/"));
  const provisional: CodeIndexSnapshot = {
    schemaVersion: 1,
    kind: "code_index_snapshot",
    ...draft,
    scope: draft.scope === "." ? "." : artifactPathSchema.parse(draft.scope),
    coverage: [...draft.coverage],
    symbols: [...draft.symbols],
    imports: [...draft.imports],
    exports: [...draft.exports],
    sqlite: {
      path: semanticSqliteArtifactPath,
      sha256: codeIndexSha256Schema.parse("0".repeat(64))
    }
  };

  const store = writeCodeIndexStore({ databasePath, snapshot: provisional });
  const sqliteBytes = await readFile(databasePath);
  const sqliteSha256 = codeIndexSha256Schema.parse(hashContent(sqliteBytes).slice("sha256:".length));
  const snapshot: CodeIndexSnapshot = {
    ...provisional,
    sqlite: { path: semanticSqliteArtifactPath, sha256: sqliteSha256 }
  };
  const semanticIndexText = stableProtocolJson(snapshot);
  await writeProjectTextFile({
    repositoryRoot: input.repositoryRoot,
    artifactPath: semanticIndexArtifactPath,
    text: semanticIndexText
  });
  const semanticIndexSha256 = codeIndexSha256Schema.parse(sha256(Buffer.from(semanticIndexText, "utf8")));

  const parserDiagnostics = draft.coverage.flatMap((coverage) => {
    if (coverage.status !== "parser-error") return [];
    const diagnostics = coverage.diagnostics ?? ["parser error"];
    return diagnostics.map((message) => `${coverage.path}: ${message}`);
  });
  return {
    snapshot,
    semanticIndexArtifactPath,
    semanticSqliteArtifactPath,
    semanticIndexSha256,
    parserDiagnostics,
    factCount: store.factCount
  };
}

export interface LatestStructuralCodeIndex {
  readonly snapshot: CodeIndexSnapshot;
  readonly snapshotArtifact: ArtifactReference;
  readonly sqliteArtifact: ArtifactReference;
  readonly runId: string;
  readonly semanticIndexArtifactPath: ArtifactPath;
  readonly semanticSqliteArtifactPath: ArtifactPath;
}

export interface StructuralCodeIndexDiscovery {
  readonly record?: LatestStructuralCodeIndex;
  readonly diagnostics: readonly MapCandidateDiagnostic[];
}

export async function discoverLatestStructuralCodeIndex(repositoryRoot: string): Promise<StructuralCodeIndexDiscovery> {
  const diagnostics: MapCandidateDiagnostic[] = [];
  const candidate = await latestStructuralMapRun(repositoryRoot);
  if (candidate === undefined) return { diagnostics };
  if (candidate.failure !== undefined) {
    return { diagnostics: [structuralLatestFailureDiagnostic(candidate.runId, candidate.failure)] };
  }
  const run = candidate.run;
  if (run === undefined) return { diagnostics };

  const rejectLatest = (
    code: MapCandidateDiagnostic["code"],
    message: string
  ): StructuralCodeIndexDiscovery => {
    diagnostics.push(structuralCandidateDiagnostic(run.runId, code, message));
    diagnostics.push(structuralLatestFailureDiagnostic(run.runId, message));
    return { diagnostics };
  };

  if (!isStructuralMapRun(run)) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "workflow run profile markers do not identify a structural map refresh"
    );
  }
  if (run.status !== "completed") {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      `latest structural map refresh has status ${run.status}`
    );
  }

  const snapshotPath = run.outputs["semanticIndexArtifactPath"];
  const expectedRoot = `.legion/project/workflow/map/${run.runId}/`;
  const expectedSnapshotPath = `${expectedRoot}semantic-index.json`;
  const expectedSqlitePath = `${expectedRoot}semantic-index.sqlite`;
  const expectedMapPath = `${expectedRoot}map.json`;
  if (typeof snapshotPath !== "string" || snapshotPath !== expectedSnapshotPath ||
    run.outputs["semanticSqliteArtifactPath"] !== expectedSqlitePath ||
    run.outputs["mapArtifactPath"] !== expectedMapPath) {
    return rejectLatest(
      "map_semantic_artifact_path_invalid",
      "semantic or v1 map artifact paths do not belong to the declaring run"
    );
  }

  const snapshotResult = await readCodeIndexSnapshot({ repositoryRoot, artifactPath: snapshotPath });
  if (!snapshotResult.ok) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      formatArtifactDiagnostics(snapshotResult.diagnostics)
    );
  }
  const snapshot = snapshotResult.snapshot;
  if (snapshot.profile !== "structural" || snapshot.snapshotId !== run.outputs["snapshotId"]) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot identity or profile does not match the workflow output"
    );
  }
  if (snapshot.snapshotId !== structuralSnapshotId(run.runId, snapshot.sourceFingerprint)) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot ID is not bound to the declaring run and source fingerprint"
    );
  }
  const sourceFingerprint = run.outputs["sourceFingerprint"];
  if (typeof sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(sourceFingerprint) ||
      snapshot.sourceFingerprint !== sourceFingerprint) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot source fingerprint is missing, malformed, or does not match the workflow output"
    );
  }
  const sourceFileCount = run.outputs["sourceFileCount"];
  if (!Number.isSafeInteger(sourceFileCount) || Number(sourceFileCount) < 0 ||
      snapshot.coverage.length !== Number(sourceFileCount)) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot coverage count is missing, malformed, or does not match the workflow output"
    );
  }
  const expectedMapRunId = structuralMapRunId(run.runId);
  const recordedMapRunId = run.outputs["mapRunId"];
  if (typeof recordedMapRunId !== "string" || recordedMapRunId !== expectedMapRunId ||
      snapshot.mapRunId !== expectedMapRunId) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot or workflow output mapRunId is missing or not derived from the declaring run"
    );
  }
  const generatedAt = run.outputs["generatedAt"];
  if (typeof generatedAt !== "string" || generatedAt !== run.createdAt) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "generatedAt is missing or does not match the declaring run"
    );
  }
  const mapArtifactSha256 = run.outputs["mapArtifactSha256"];
  if (typeof mapArtifactSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(mapArtifactSha256)) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "mapArtifactSha256 is missing or malformed in the workflow output"
    );
  }
  if (snapshot.sqlite.path !== expectedSqlitePath) {
    return rejectLatest(
      "map_semantic_artifact_path_invalid",
      "SQLite path does not belong to its declaring run"
    );
  }
  const semanticIndexSha256 = run.outputs["semanticIndexSha256"];
  if (typeof semanticIndexSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(semanticIndexSha256) ||
      snapshotResult.reference.sha256 !== `sha256:${semanticIndexSha256}`) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot content hash does not match the workflow output"
    );
  }
  if (snapshot.generatedAt !== generatedAt) {
    return rejectLatest(
      "map_semantic_snapshot_invalid",
      "semantic snapshot generatedAt does not match the declaring run"
    );
  }
  const sqliteResult = await verifyCodeIndexSqlite({ repositoryRoot, snapshot });
  if (!sqliteResult.ok) {
    return rejectLatest(
      "map_semantic_sqlite_invalid",
      formatArtifactDiagnostics(sqliteResult.diagnostics)
    );
  }
  const mapResult = await readMapArtifactForRun(repositoryRoot, run);
  if (!mapResult.ok) {
    return rejectLatest(mapResult.error.code, mapResult.error.message);
  }
  const map = mapResult.record.map;
  const actualMapArtifactSha256 = mapResult.record.artifact.sha256.slice("sha256:".length);
  if (actualMapArtifactSha256 !== mapArtifactSha256) {
    return rejectLatest(
      "map_artifact_fingerprint_mismatch",
      "map artifact content hash does not match the workflow output mapArtifactSha256"
    );
  }
  if (map.generatedAt !== generatedAt) {
    return rejectLatest(
      "map_artifact_fingerprint_mismatch",
      "v1 map generatedAt does not match the declaring run and semantic snapshot"
    );
  }
  const mapFilePaths = map.files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
  const coveragePaths = snapshot.coverage.map((coverage) => coverage.path).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(mapFilePaths) !== JSON.stringify(coveragePaths)) {
    return rejectLatest(
      "map_artifact_fingerprint_mismatch",
      "semantic snapshot coverage paths do not exactly match the v1 map files"
    );
  }
  if (map.scope !== snapshot.scope || map.sourceFingerprint !== snapshot.sourceFingerprint ||
      map.sourceFileCount !== snapshot.coverage.length ||
      map.sourceFingerprint !== sourceFingerprint ||
      map.sourceFileCount !== sourceFileCount) {
    return rejectLatest(
      "map_artifact_fingerprint_mismatch",
      "v1 map scope, source fingerprint, or source file count does not match the structural snapshot and workflow output"
    );
  }
  return {
    record: {
      snapshot,
      snapshotArtifact: snapshotResult.reference,
      sqliteArtifact: sqliteResult.reference,
      runId: run.runId,
      semanticIndexArtifactPath: snapshotPath as ArtifactPath,
      semanticSqliteArtifactPath: snapshot.sqlite.path
    },
    diagnostics
  };
}

export function queryStructuralCodeIndex(input: {
  readonly repositoryRoot: string;
  readonly record: LatestStructuralCodeIndex;
  readonly query: string;
  readonly limit?: number;
}): readonly CodeIndexSearchHit[] {
  const databasePath = path.join(input.repositoryRoot, ...input.record.semanticSqliteArtifactPath.split("/"));
  return queryCodeIndexStore({ databasePath, query: input.query, limit: input.limit ?? 10 });
}

export function findStructuralCodeIndexFact(input: {
  readonly repositoryRoot: string;
  readonly record: LatestStructuralCodeIndex;
  readonly id: string;
}): CodeIndexFact | undefined {
  const factId = codeIndexFactIdSchema.parse(input.id);
  const databasePath = path.join(input.repositoryRoot, ...input.record.semanticSqliteArtifactPath.split("/"));
  return findCodeIndexFact({ databasePath, id: factId });
}

function structuralCandidateDiagnostic(
  runId: string,
  code: MapCandidateDiagnostic["code"],
  message: string
): MapCandidateDiagnostic {
  return { runId, code, message: `Ignored structural map run ${runId}: ${message}.` };
}

function formatArtifactDiagnostics(diagnostics: readonly { readonly code: string; readonly message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
}

interface StructuralMapRunCandidate {
  readonly runId: string;
  readonly run?: GuidanceRunDocument;
  readonly failure?: string;
  readonly sortKey: number;
}

async function latestStructuralMapRun(repositoryRoot: string): Promise<StructuralMapRunCandidate | undefined> {
  const workflowRoot = path.join(repositoryRoot, ".legion", "project", "workflow", "map");
  let entries;
  try {
    entries = await readdir(workflowRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  const candidates: StructuralMapRunCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runRoot = path.join(workflowRoot, entry.name);
    let hasStructuralArtifacts = false;
    try {
      const artifacts = await readdir(runRoot, { withFileTypes: true });
      hasStructuralArtifacts = artifacts.some((artifact) =>
        artifact.name === "semantic-index.json" || artifact.name === "semantic-index.sqlite"
      );
    } catch {
      // Reading workflow-run.json below supplies the useful failure diagnostic.
    }

    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(runRoot, "workflow-run.json"), "utf8"));
    } catch (error) {
      if (!hasStructuralArtifacts) continue;
      candidates.push({
        runId: entry.name,
        failure: `cannot read workflow run: ${error instanceof Error ? error.message : String(error)}`,
        sortKey: structuralRunSortKey(undefined, entry.name)
      });
      continue;
    }

    const record = isRecord(value) ? value : undefined;
    const structuralEvidence = hasStructuralArtifacts ||
      (record !== undefined && hasStructuralRunEvidence(record));
    if (!structuralEvidence) continue;
    if (record === undefined || !isGuidanceRunRecord(record, entry.name)) {
      candidates.push({
        runId: entry.name,
        failure: "workflow run has malformed required fields",
        sortKey: structuralRunSortKey(undefined, entry.name)
      });
      continue;
    }
    candidates.push({
      runId: entry.name,
      run: record as unknown as GuidanceRunDocument,
      sortKey: structuralRunSortKey(record["createdAt"], entry.name)
    });
  }

  candidates.sort((left, right) => right.sortKey - left.sortKey || right.runId.localeCompare(left.runId));
  return candidates[0];
}

function structuralRunSortKey(createdAt: unknown, runId: string): number {
  const encodedTimestamp = /^(\d{4}-\d{2}-\d{2})t(\d{2})-(\d{2})-(\d{2})-(\d{3})z(?:-|$)/iu.exec(runId);
  if (encodedTimestamp !== null) {
    const parsed = Date.parse(`${encodedTimestamp[1]}T${encodedTimestamp[2]}:${encodedTimestamp[3]}:${encodedTimestamp[4]}.${encodedTimestamp[5]}Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStructuralRunEvidence(record: Record<string, unknown>): boolean {
  const input = isRecord(record["input"]) ? record["input"] : undefined;
  const outputs = isRecord(record["outputs"]) ? record["outputs"] : undefined;
  return input?.["profile"] === "structural" ||
    outputs?.["indexProfile"] === "structural" ||
    typeof outputs?.["semanticIndexArtifactPath"] === "string";
}

function isGuidanceRunRecord(record: Record<string, unknown>, directoryRunId: string): boolean {
  const input = record["input"];
  const outputs = record["outputs"];
  const nextAction = record["nextAction"];
  return record["schemaVersion"] === 1 &&
    record["kind"] === "workflow_run" &&
    record["workflow"] === "map" &&
    record["runId"] === directoryRunId &&
    typeof record["createdAt"] === "string" &&
    typeof record["status"] === "string" &&
    isRecord(input) &&
    isRecord(outputs) &&
    isRecord(nextAction) &&
    typeof nextAction["command"] === "string" &&
    nextAction["command"].length > 0 &&
    typeof nextAction["reason"] === "string" &&
    Array.isArray(record["diagnostics"]);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function isStructuralMapRun(run: GuidanceRunDocument): boolean {
  return run.input["profile"] === "structural" &&
    run.outputs["indexProfile"] === "structural";
}

function structuralMapRunId(runId: string): RunId {
  return formatEntityId("run", `map-${sha256(Buffer.from(runId, "utf8")).slice(0, 32)}`) as RunId;
}

function structuralLatestFailureDiagnostic(runId: string, message: string): MapCandidateDiagnostic {
  return {
    runId,
    code: "map_structural_latest_failure",
    message: `Latest structural map run ${runId} is unusable: ${message}.`
  };
}

export function structuralSnapshotId(runId: string, sourceFingerprint: string): CodeIndexSnapshotId {
  return codeIndexSnapshotIdSchema.parse(`idx_${sha256(Buffer.from(`${runId}\0${sourceFingerprint}`, "utf8")).slice(0, 24)}`);
}

export interface MapCandidateDiagnostic {
  readonly runId: string;
  readonly code:
    | "map_artifact_path_invalid"
    | "map_artifact_unreadable"
    | "map_artifact_json_invalid"
    | "map_artifact_schema_invalid"
    | "map_artifact_duplicate_path"
    | "map_artifact_unsafe_path"
    | "map_artifact_count_mismatch"
    | "map_artifact_fingerprint_mismatch"
    | "map_semantic_artifact_path_invalid"
    | "map_semantic_snapshot_invalid"
    | "map_semantic_sqlite_invalid"
    | "map_structural_latest_failure";
  readonly message: string;
}

export interface LatestCodebaseMap {
  readonly map: CodebaseMapDocument;
  readonly artifact: ArtifactReference;
}

export interface LatestCodebaseMapDiscovery {
  readonly record?: LatestCodebaseMap;
  readonly diagnostics: readonly MapCandidateDiagnostic[];
}

class MapCandidateValidationError extends Error {
  readonly code: MapCandidateDiagnostic["code"];

  constructor(code: MapCandidateDiagnostic["code"], message: string) {
    super(message);
    this.name = "MapCandidateValidationError";
    this.code = code;
  }
}

const MAP_DOCUMENT_KEYS = ["files", "generatedAt", "kind", "schemaVersion", "scope", "sourceFileCount", "sourceFingerprint"] as const;
const MAP_FILE_KEYS = ["headings", "lineCount", "path", "sha256", "sizeBytes", "summary", "symbols"] as const;

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || !keys.every((key, index) => actual[index] === key)) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", `${label} has an invalid field set`);
  }
  return record;
}

function safeMapRelativePath(value: unknown, options: { readonly allowDot?: boolean } = {}): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new MapCandidateValidationError("map_artifact_unsafe_path", `unsafe map path ${String(value)}`);
  }
  if (options.allowDot === true && value === ".") return value;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    throw new MapCandidateValidationError("map_artifact_unsafe_path", `unsafe map path ${value}`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", `${label} must be an array of strings`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", `${label} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function parseCodebaseMapDocument(value: unknown): CodebaseMapDocument {
  const record = exactObject(value, MAP_DOCUMENT_KEYS, "codebase map");
  if (record["schemaVersion"] !== 1 || record["kind"] !== "codebase_map") {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", "codebase map identity is invalid");
  }
  const generatedAt = utcTimestampSchema.safeParse(record["generatedAt"]);
  if (!generatedAt.success) throw new MapCandidateValidationError("map_artifact_schema_invalid", "codebase map generatedAt is invalid");
  const scope = safeMapRelativePath(record["scope"], { allowDot: true });
  if (typeof record["sourceFingerprint"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["sourceFingerprint"])) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", "codebase map sourceFingerprint is invalid");
  }
  const sourceFileCount = nonnegativeInteger(record["sourceFileCount"], "codebase map sourceFileCount");
  if (!Array.isArray(record["files"])) {
    throw new MapCandidateValidationError("map_artifact_schema_invalid", "codebase map files must be an array");
  }
  const seen = new Set<string>();
  const files: CodebaseMapFile[] = record["files"].map((entry, index) => {
    const file = exactObject(entry, MAP_FILE_KEYS, `codebase map file ${index}`);
    const filePath = safeMapRelativePath(file["path"]);
    if (seen.has(filePath)) {
      throw new MapCandidateValidationError("map_artifact_duplicate_path", `codebase map repeats file path ${filePath}`);
    }
    seen.add(filePath);
    if (scope !== "." && filePath !== scope && !filePath.startsWith(`${scope}/`)) {
      throw new MapCandidateValidationError("map_artifact_unsafe_path", `map file ${filePath} is outside declared scope ${scope}`);
    }
    if (typeof file["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(file["sha256"])) {
      throw new MapCandidateValidationError("map_artifact_schema_invalid", `codebase map file ${filePath} has an invalid sha256`);
    }
    if (typeof file["summary"] !== "string") {
      throw new MapCandidateValidationError("map_artifact_schema_invalid", `codebase map file ${filePath} has an invalid summary`);
    }
    return {
      path: filePath,
      sha256: file["sha256"],
      sizeBytes: nonnegativeInteger(file["sizeBytes"], `codebase map file ${filePath} sizeBytes`),
      lineCount: nonnegativeInteger(file["lineCount"], `codebase map file ${filePath} lineCount`),
      symbols: stringArray(file["symbols"], `codebase map file ${filePath} symbols`),
      headings: stringArray(file["headings"], `codebase map file ${filePath} headings`),
      summary: file["summary"]
    };
  });
  if (sourceFileCount !== files.length) {
    throw new MapCandidateValidationError("map_artifact_count_mismatch", `declared sourceFileCount ${sourceFileCount} does not match ${files.length} files`);
  }
  const sourceFingerprint = record["sourceFingerprint"];
  const computedFingerprint = fingerprintFiles(files);
  if (sourceFingerprint !== computedFingerprint) {
    throw new MapCandidateValidationError("map_artifact_fingerprint_mismatch", "declared sourceFingerprint does not match the map file entries");
  }
  return {
    schemaVersion: 1,
    kind: "codebase_map",
    generatedAt: generatedAt.data,
    scope,
    sourceFingerprint,
    sourceFileCount,
    files
  };
}

function mapCandidateDiagnostic(runId: string, error: MapCandidateValidationError): MapCandidateDiagnostic {
  return { runId, code: error.code, message: `Ignored map run ${runId}: ${error.message}.` };
}

interface MapArtifactReadResult {
  readonly ok: true;
  readonly record: LatestCodebaseMap;
}

interface InvalidMapArtifactReadResult {
  readonly ok: false;
  readonly error: MapCandidateValidationError;
}

async function readMapArtifactForRun(
  repositoryRoot: string,
  run: GuidanceRunDocument
): Promise<MapArtifactReadResult | InvalidMapArtifactReadResult> {
  const artifactPath = typeof run.outputs["mapArtifactPath"] === "string" ? run.outputs["mapArtifactPath"] : undefined;
  const expectedArtifactPath = `.legion/project/workflow/map/${run.runId}/map.json`;
  if (artifactPath === undefined) {
    return {
      ok: false,
      error: new MapCandidateValidationError("map_artifact_path_invalid", "map artifact path is missing")
    };
  }
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath });
    if (resolved.repositoryPath !== expectedArtifactPath) {
      throw new Error("map output does not belong to its declaring run");
    }
  } catch {
    return {
      ok: false,
      error: new MapCandidateValidationError(
        "map_artifact_path_invalid",
        "map artifact path is unsafe or does not belong to its declaring run"
      )
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.absolutePath);
  } catch {
    return {
      ok: false,
      error: new MapCandidateValidationError("map_artifact_unreadable", "map artifact cannot be read")
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ok: false,
      error: new MapCandidateValidationError("map_artifact_json_invalid", "map artifact is not valid JSON")
    };
  }

  try {
    return {
      ok: true,
      record: {
        map: parseCodebaseMapDocument(value),
        artifact: {
          path: resolved.repositoryPath,
          sha256: hashContent(bytes)
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof MapCandidateValidationError
        ? error
        : new MapCandidateValidationError("map_artifact_schema_invalid", "map artifact schema is invalid")
    };
  }
}

export async function discoverLatestCodebaseMap(repositoryRoot: string): Promise<LatestCodebaseMapDiscovery> {
  const runs = await latestGuidanceRuns({ repositoryRoot, workflows: ["map"], limitPerWorkflow: 20 });
  const diagnostics: MapCandidateDiagnostic[] = [];
  for (const run of runs) {
    if (typeof run.outputs["mapArtifactPath"] !== "string") continue;
    const result = await readMapArtifactForRun(repositoryRoot, run);
    if (!result.ok) {
      diagnostics.push(mapCandidateDiagnostic(run.runId, result.error));
      continue;
    }
    return { record: result.record, diagnostics };
  }
  return { diagnostics };
}

async function getLatestCodebaseMapRecord(repositoryRoot: string): Promise<LatestCodebaseMap | undefined> {
  return (await discoverLatestCodebaseMap(repositoryRoot)).record;
}

export async function getLatestCodebaseMap(repositoryRoot: string): Promise<CodebaseMapDocument | undefined> {
  return (await getLatestCodebaseMapRecord(repositoryRoot))?.map;
}

export async function currentCodebaseFingerprint(input: {
  readonly repositoryRoot: string;
  readonly scope?: string;
}): Promise<{ readonly scope: string; readonly sourceFingerprint: string; readonly sourceFileCount: number }> {
  const scope = await normalizeScope(input.repositoryRoot, input.scope);
  const files = await collectSourceFiles(input.repositoryRoot, scope);
  return {
    scope,
    sourceFingerprint: fingerprintFiles(files),
    sourceFileCount: files.length
  };
}

export function queryCodebaseMap(map: CodebaseMapDocument, query: string, limit = 10): readonly CodebaseMapQueryMatch[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return map.files
    .map((file) => {
      const haystack = [
        file.path,
        file.summary,
        ...file.symbols,
        ...file.headings
      ].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + occurrences(haystack, term), 0);
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .slice(0, limit)
    .map((entry) => ({
      path: entry.file.path,
      score: entry.score,
      symbols: entry.file.symbols.slice(0, 8),
      summary: entry.file.summary
    }));
}

async function normalizeScope(repositoryRoot: string, scope: string | undefined): Promise<string> {
  const repositoryRealPath = await realpath(repositoryRoot);
  const isRepositoryScope = scope === undefined || scope.trim().length === 0 || scope.trim() === ".";
  const absolute = isRepositoryScope ? repositoryRoot : path.resolve(repositoryRoot, scope);
  const relative = path.relative(repositoryRoot, absolute).replace(/\\/g, "/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Map scope must stay inside the repository: ${scope ?? "."}`);
  }

  const scopeRealPath = await realpath(absolute);
  const realRelative = path.relative(repositoryRealPath, scopeRealPath);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Map scope must stay inside the repository: ${scope ?? "."}`);
  }
  return relative.length === 0 ? "." : relative;
}

async function collectSourceFiles(repositoryRoot: string, scope: string): Promise<readonly MapSourceFile[]> {
  const root = scope === "." ? repositoryRoot : path.join(repositoryRoot, ...scope.split("/"));
  const rootStat = await stat(root);
  const candidates = rootStat.isFile() ? [root] : await walk(root);
  const files: CodebaseMapFile[] = [];
  for (const absolutePath of [...candidates].sort((left, right) => left.localeCompare(right))) {
    const relative = path.relative(repositoryRoot, absolutePath).replace(/\\/g, "/");
    if (!isFullMapAuthoredFile(relative)) continue;
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) continue;
    const bytes = fileStat.size <= 512 * 1024 ? await readFile(absolutePath) : undefined;
    const analyzable = bytes !== undefined && !bytes.includes(0);
    const text = analyzable ? bytes.toString("utf8") : "";
    const lines = analyzable ? text.split(/\r?\n/u) : [];
    const symbols = analyzable ? extractSymbols(text) : [];
    const headings = analyzable ? extractHeadings(text) : [];
    files.push({
      path: relative,
      sha256: bytes === undefined ? await sha256File(absolutePath) : sha256(bytes),
      sizeBytes: fileStat.size,
      lineCount: lines.length,
      symbols,
      headings,
      summary: analyzable
        ? summarizeFile(relative, lines, symbols, headings)
        : `${relative} is fingerprinted but omitted from textual analysis (${fileStat.size > 512 * 1024 ? "size limit" : "opaque content"})`,
      ...(analyzable ? { text } : {})
    });
  }
  return files;
}

async function walk(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!shouldTraverseAuthoredDirectory(entry.name)) continue;
      files.push(...await walk(absolute));
      continue;
    }
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function extractSymbols(text: string): readonly string[] {
  const symbols = new Set<string>();
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gmu,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gmu,
    /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gmu,
    /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gmu,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
    /^\s*def\s+([A-Za-z_][\w]*)/gmu,
    /^\s*class\s+([A-Za-z_][\w]*)/gmu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) symbols.add(match[1]);
    }
  }
  return [...symbols].sort((left, right) => left.localeCompare(right)).slice(0, 50);
}

function extractHeadings(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => /^#{1,6}\s+(.+)$/u.exec(line.trim())?.[1]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .slice(0, 20);
}

function summarizeFile(relative: string, lines: readonly string[], symbols: readonly string[], headings: readonly string[]): string {
  const firstContent = lines.map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("#"));
  const parts = [`${relative} has ${lines.length} lines`];
  if (symbols.length > 0) parts.push(`symbols: ${symbols.slice(0, 6).join(", ")}`);
  if (headings.length > 0) parts.push(`headings: ${headings.slice(0, 3).join(", ")}`);
  if (firstContent !== undefined) parts.push(`first content: ${firstContent.slice(0, 120)}`);
  return parts.join("; ");
}

export function fingerprintSourceFiles(files: readonly CodebaseMapFile[]): string {
  return fingerprintFiles(files);
}

function fingerprintFiles(files: readonly CodebaseMapFile[]): string {
  return sha256(Buffer.from(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"), "utf8"));
}

function renderCodebaseMarkdown(map: CodebaseMapDocument): string {
  const byExtension = new Map<string, number>();
  for (const file of map.files) {
    const extension = path.extname(file.path).toLowerCase() || "(none)";
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }
  const extensionRows = [...byExtension.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([extension, count]) => `- ${extension}: ${count}`);
  return [
    "# Codebase Map",
    "",
    `Generated: ${map.generatedAt}`,
    `Scope: ${map.scope}`,
    `Source fingerprint: ${map.sourceFingerprint}`,
    `Source files: ${map.sourceFileCount}`,
    "",
    "## File Types",
    "",
    ...extensionRows,
    "",
    "## Files",
    "",
    ...map.files.slice(0, 200).map((file) => `- ${file.path} (${file.lineCount} lines): ${file.summary}`),
    ""
  ].join("\n");
}

function renderSearchMarkdown(map: CodebaseMapDocument): string {
  return [
    "# Codebase Search Index",
    "",
    "Use `legion map --query <text>` to search this deterministic index.",
    "",
    ...map.files.map((file) => [
      `## ${file.path}`,
      "",
      file.summary,
      file.symbols.length > 0 ? `Symbols: ${file.symbols.join(", ")}` : "Symbols: none",
      ""
    ].join("\n")),
    ""
  ].join("\n");
}

/** The terms a query reduces to; empty means nothing was searched for. */
export function queryTerms(value: string): readonly string[] {
  return tokenize(value);
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function occurrences(value: string, term: string): number {
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** How long a map stays trustworthy before it should be regenerated. */
export const MAP_MAX_AGE_DAYS = 30;

export type MapFreshness = "fresh" | "stale" | "partial" | "absent";

export interface MapState {
  readonly freshness: MapFreshness;
  readonly reason: string;
  readonly scope: string;
  readonly sourceFingerprint: string;
  readonly sourceFileCount: number;
  readonly latestSourceFingerprint: string | null;
  readonly generatedAt: string | null;
  readonly ageDays: number | null;
  readonly mapArtifact: ArtifactReference | null;
  readonly indexProfile?: MapProfile;
  readonly snapshotId?: string | null;
  readonly diagnostics: readonly MapCandidateDiagnostic[];
}

/**
 * The four states the command distinguishes and the verb collapsed into two.
 *
 * `mapCheck` computed one boolean and called everything that was not fresh
 * "stale", so a project that had never run map reported the same status as one
 * whose fingerprint had moved by a line — and a map generated against a
 * different scope reported stale without saying that the comparison was not
 * like for like.
 */
export async function resolveMapState(
  repositoryRoot: string,
  scope: string | undefined,
  now: string,
  profile: MapProfile = "inventory"
): Promise<MapState | { readonly error: string }> {
  const discovery = profile === "structural"
    ? await discoverLatestStructuralCodeIndex(repositoryRoot)
    : await discoverLatestCodebaseMap(repositoryRoot);
  const structuralRecord = profile === "structural" ? (discovery as StructuralCodeIndexDiscovery).record : undefined;
  const inventoryRecord = profile === "inventory" ? (discovery as LatestCodebaseMapDiscovery).record : undefined;
  const latest = profile === "structural" ? structuralRecord?.snapshot : inventoryRecord?.map;
  let current: Awaited<ReturnType<typeof currentCodebaseFingerprint>>;
  try {
    current = await currentCodebaseFingerprint({ repositoryRoot, ...(scope === undefined ? {} : { scope }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unable to read the codebase map. ${message}` };
  }

  const base = {
    scope: current.scope,
    sourceFingerprint: current.sourceFingerprint,
    sourceFileCount: current.sourceFileCount,
    latestSourceFingerprint: latest?.sourceFingerprint ?? null,
    generatedAt: latest?.generatedAt ?? null,
    mapArtifact: profile === "structural"
      ? (structuralRecord?.snapshotArtifact ?? null)
      : (inventoryRecord?.artifact ?? null),
    ...(profile === "structural"
      ? { indexProfile: "structural" as const, snapshotId: structuralRecord?.snapshot.snapshotId ?? null }
      : {}),
    diagnostics: discovery.diagnostics
  };

  if (latest === undefined) {
    return {
      ...base,
      freshness: "absent",
      reason: profile === "structural" ? "No structural code index has been generated." : "No codebase map has been generated.",
      ageDays: null
    };
  }

  const ageDays = ageInDays(latest.generatedAt, now);
  if (latest.scope !== current.scope) {
    return {
      ...base,
      freshness: "partial",
      reason: `The stored map covers ${latest.scope}, which is not the scope being checked (${current.scope}).`,
      ageDays
    };
  }
  if (latest.sourceFingerprint !== current.sourceFingerprint) {
    return { ...base, freshness: "stale", reason: "Source files have changed since the map was generated.", ageDays };
  }
  if (ageDays !== null && ageDays > MAP_MAX_AGE_DAYS) {
    return {
      ...base,
      freshness: "stale",
      reason: `The map is ${Math.floor(ageDays)} days old, past the ${MAP_MAX_AGE_DAYS}-day limit.`,
      ageDays
    };
  }
  return { ...base, freshness: "fresh", reason: "The map matches the current source files.", ageDays };
}

function ageInDays(generatedAt: string, now: string): number | null {
  const from = Date.parse(generatedAt);
  const to = Date.parse(now);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86_400_000;
}
