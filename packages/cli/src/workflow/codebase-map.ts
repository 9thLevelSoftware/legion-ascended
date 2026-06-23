import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { stableProtocolJson } from "@legion/artifacts";
import type { ArtifactPath, UtcTimestamp } from "@legion/protocol";

import { writeProjectTextFile } from "./executor/result.js";
import { guidanceArtifactPath, latestGuidanceRuns, type GuidanceRunPaths } from "./guidance-run.js";

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

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".legion",
  ".worktrees",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
  "target",
  "build",
  ".next"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

export async function refreshCodebaseMap(input: {
  readonly repositoryRoot: string;
  readonly paths: GuidanceRunPaths;
  readonly scope?: string;
}): Promise<CodebaseMapArtifacts> {
  const scope = normalizeScope(input.repositoryRoot, input.scope);
  const files = await collectSourceFiles(input.repositoryRoot, scope);
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

export async function getLatestCodebaseMap(repositoryRoot: string): Promise<CodebaseMapDocument | undefined> {
  const runs = await latestGuidanceRuns({ repositoryRoot, workflows: ["map"], limitPerWorkflow: 20 });
  for (const run of runs) {
    const artifactPath = typeof run.outputs["mapArtifactPath"] === "string" ? run.outputs["mapArtifactPath"] : undefined;
    if (artifactPath === undefined) continue;
    try {
      return JSON.parse(await readFile(path.join(repositoryRoot, ...artifactPath.split("/")), "utf8")) as CodebaseMapDocument;
    } catch {
      continue;
    }
  }
  return undefined;
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
    const extension = path.extname(relative).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !isTextLikeName(path.basename(relative))) continue;
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > 512 * 1024) continue;
    const bytes = await readFile(absolutePath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    const lines = text.split(/\r?\n/u);
    const symbols = extractSymbols(text);
    const headings = extractHeadings(text);
    files.push({
      path: relative,
      sha256: sha256(bytes),
      sizeBytes: fileStat.size,
      lineCount: lines.length,
      symbols,
      headings,
      summary: summarizeFile(relative, lines, symbols, headings)
    });
  }
  return files;
}

async function walk(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && ![".github", ".codex-plugin", ".npmrc", ".nvmrc", ".node-version"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
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

function isTextLikeName(name: string): boolean {
  return [
    "README",
    "LICENSE",
    "CHANGELOG",
    "Dockerfile"
  ].includes(name);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
