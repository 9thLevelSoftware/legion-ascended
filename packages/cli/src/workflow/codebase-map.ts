import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveProjectArtifactPath, stableProtocolJson } from "@legion/artifacts";
import { utcTimestampSchema, type ArtifactPath, type ArtifactReference, type UtcTimestamp } from "@legion/protocol";

import { writeProjectTextFile } from "./executor/result.js";
import { guidanceArtifactPath, latestGuidanceRuns, type GuidanceRunPaths } from "./guidance-run.js";
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
}): Promise<{ readonly scope: string; readonly files: readonly CodebaseMapFile[] }> {
  const scope = normalizeScope(input.repositoryRoot, input.scope);
  return { scope, files: await collectSourceFiles(input.repositoryRoot, scope) };
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
    text: stableProtocolJson(map)
  });

  return {
    map,
    codebaseArtifactPath,
    indexArtifactPath,
    symbolsArtifactPath,
    searchArtifactPath,
    mapArtifactPath
  };
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
    | "map_artifact_fingerprint_mismatch";
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

export async function discoverLatestCodebaseMap(repositoryRoot: string): Promise<LatestCodebaseMapDiscovery> {
  const runs = await latestGuidanceRuns({ repositoryRoot, workflows: ["map"], limitPerWorkflow: 20 });
  const diagnostics: MapCandidateDiagnostic[] = [];
  for (const run of runs) {
    const artifactPath = typeof run.outputs["mapArtifactPath"] === "string" ? run.outputs["mapArtifactPath"] : undefined;
    if (artifactPath === undefined) continue;
    const expectedArtifactPath = `.legion/project/workflow/map/${run.runId}/map.json`;
    let resolved;
    try {
      resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath });
      if (resolved.repositoryPath !== expectedArtifactPath) {
        throw new Error("map output does not belong to its declaring run");
      }
    } catch {
      diagnostics.push(mapCandidateDiagnostic(run.runId, new MapCandidateValidationError(
        "map_artifact_path_invalid",
        "map artifact path is unsafe or does not belong to its declaring run"
      )));
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch {
      diagnostics.push(mapCandidateDiagnostic(run.runId, new MapCandidateValidationError(
        "map_artifact_unreadable",
        "map artifact cannot be read"
      )));
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      diagnostics.push(mapCandidateDiagnostic(run.runId, new MapCandidateValidationError(
        "map_artifact_json_invalid",
        "map artifact is not valid JSON"
      )));
      continue;
    }
    try {
      const map = parseCodebaseMapDocument(value);
      return {
        record: {
          map,
          artifact: {
            path: resolved.repositoryPath,
            sha256: `sha256:${sha256(bytes)}` as ArtifactReference["sha256"]
          }
        },
        diagnostics
      };
    } catch (error) {
      const validation = error instanceof MapCandidateValidationError
        ? error
        : new MapCandidateValidationError("map_artifact_schema_invalid", "map artifact schema is invalid");
      diagnostics.push(mapCandidateDiagnostic(run.runId, validation));
    }
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
  const scope = normalizeScope(input.repositoryRoot, input.scope);
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

function normalizeScope(repositoryRoot: string, scope: string | undefined): string {
  if (scope === undefined || scope.trim().length === 0 || scope.trim() === ".") return ".";
  const absolute = path.resolve(repositoryRoot, scope);
  const relative = path.relative(repositoryRoot, absolute).replace(/\\/g, "/");
  if (relative.length === 0) return ".";
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Map scope must stay inside the repository: ${scope}`);
  }
  return relative;
}

async function collectSourceFiles(repositoryRoot: string, scope: string): Promise<readonly CodebaseMapFile[]> {
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
        : `${relative} is fingerprinted but omitted from textual analysis (${fileStat.size > 512 * 1024 ? "size limit" : "opaque content"})`
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
  now: string
): Promise<MapState | { readonly error: string }> {
  const discovery = await discoverLatestCodebaseMap(repositoryRoot);
  const latestRecord = discovery.record;
  const latest = latestRecord?.map;
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
    mapArtifact: latestRecord?.artifact ?? null,
    diagnostics: discovery.diagnostics
  };

  if (latest === undefined) {
    return { ...base, freshness: "absent", reason: "No codebase map has been generated.", ageDays: null };
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
    // The fingerprint can match while the map is still worth regenerating: the
    // schema moves, and a map old enough to predate it describes the repository
    // in a vocabulary the current reader no longer uses.
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
