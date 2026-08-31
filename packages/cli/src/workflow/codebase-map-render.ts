import path from "node:path";

import type { CodebaseMapDocument, CodebaseMapFile } from "./codebase-map.js";

const MAX_MODULE_FILES = 160;
const MAX_GRAPH_EDGES = 160;
const MAX_FAN_ROWS = 24;
const MAX_SEARCH_SYMBOLS_PER_FILE = 40;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

export interface MapRenderIndex {
  readonly coverage?: readonly { readonly path: string }[];
  readonly symbols?: readonly {
    readonly path: string;
    readonly name: string;
    readonly kind: string;
    readonly exported?: boolean;
  }[];
  readonly imports?: readonly { readonly path: string; readonly specifier: string }[];
  readonly exports?: readonly { readonly path: string; readonly name: string; readonly kind: string }[];
  readonly rankedModules?: readonly {
    readonly path: string;
    readonly rank: number;
    readonly fanIn: number;
    readonly fanOut: number;
    readonly symbols: readonly string[];
  }[];
  readonly healthScores?: readonly {
    readonly path: string;
    readonly score: number;
    readonly signals: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
  }[];
  readonly gitHotspots?: readonly { readonly path: string; readonly changeCount: number; readonly lastChanged: string }[];
  readonly gitOwnership?: readonly { readonly path: string; readonly lastAuthor: string; readonly lastChanged: string }[];
  readonly gitBusFactor?: readonly { readonly directory: string; readonly contributorCount: number; readonly topContributors: readonly string[] }[];
}

export interface CodebaseMapDocuments {
  readonly codebaseMarkdown: string;
  readonly searchMarkdown: string;
  readonly symbolRecords: readonly { readonly symbol: string; readonly path: string }[];
  readonly preview: string;
}

interface TreeNode {
  readonly children: Map<string, TreeNode>;
  readonly files: string[];
}

const KIND_ABBREV: Readonly<Record<string, string>> = {
  function: "fn",
  method: "fn",
  class: "cl",
  interface: "iface",
  type: "type",
  variable: "var",
  constant: "const",
  enum: "enum",
  module: "mod"
};

export function renderCodebaseDocuments(input: {
  readonly map: CodebaseMapDocument;
  readonly snapshot?: MapRenderIndex;
}): CodebaseMapDocuments {
  const paths = input.map.files.map((file) => file.path);
  const tree = renderPathTree(paths);
  const modules = input.snapshot === undefined ? renderInventoryModules(input.map.files) : renderStructuralModules(input.snapshot);
  const graph = input.snapshot === undefined ? "" : renderReferenceGraph(input.snapshot, paths);
  const codebaseMarkdown = [
    "# Codebase Map",
    "",
    `Generated: ${input.map.generatedAt}`,
    `Scope: ${input.map.scope}`,
    `Source fingerprint: ${input.map.sourceFingerprint}`,
    `Source files: ${input.map.sourceFileCount}`,
    "",
    "This document is a deterministic map, index, and reference graph for LLM and human navigation.",
    "Static structure is not behavioral proof.",
    "",
    "## Modules",
    "",
    modules,
    ...renderIntelligenceSections(input.snapshot),
    ...(graph.length === 0 ? [] : ["", "## Reference graph", "", graph]),
    "",
    "## File types",
    "",
    ...renderExtensionCounts(input.map.files),
    "",
    "## Tree",
    "",
    "```",
    tree,
    "```",
    ""
  ].join("\n");
  const searchMarkdown = input.snapshot === undefined
    ? renderInventorySearch(input.map)
    : renderStructuralSearch(input.map, input.snapshot);
  const symbolRecords = input.snapshot === undefined
    ? input.map.files.flatMap((file) => file.symbols.map((symbol) => ({ symbol, path: file.path })))
    : structuralSymbolRecords(input.snapshot);
  return {
    codebaseMarkdown,
    searchMarkdown,
    symbolRecords,
    preview: [
      `# Codebase Map`,
      "",
      `Generated: ${input.map.generatedAt}`,
      `Scope: ${input.map.scope}`,
      `Source files: ${input.map.sourceFileCount}`,
      "",
      "## Modules",
      "",
      modules.split("\n\n").slice(0, 12).join("\n\n"),
      ...(graph.length === 0 ? [] : ["", "## Reference graph", "", previewReferenceGraph(graph)]),
      "",
      "Static structure is not behavioral proof. Full tree, remaining modules, and search index are in the map run directory."
    ].join("\n")
  };
}

function previewReferenceGraph(graph: string): string {
  const sections = graph.split(/(?=^### )/mu).filter((section) => section.length > 0);
  return sections.map((section) => {
    const lines = section.replace(/\n$/u, "").split("\n");
    if (lines.length <= 12) return lines.join("\n");
    return `${lines.slice(0, 12).join("\n")}\n… truncated`;
  }).join("\n\n");
}

export function renderPathTree(paths: readonly string[]): string {
  const root: TreeNode = { children: new Map(), files: [] };
  for (const filePath of [...paths].sort(compareStrings)) {
    const parts = filePath.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    let node = root;
    for (const directory of parts.slice(0, -1)) {
      let child = node.children.get(directory);
      if (child === undefined) {
        child = { children: new Map(), files: [] };
        node.children.set(directory, child);
      }
      node = child;
    }
    node.files.push(parts[parts.length - 1] ?? filePath);
  }
  const lines = ["."];
  writeTree(root, "", lines);
  return lines.join("\n");
}

function writeTree(node: TreeNode, prefix: string, lines: string[]): void {
  const directories = [...node.children.keys()].sort(compareStrings);
  const files = [...node.files].sort(compareStrings);
  const entries: Array<{ readonly kind: "dir" | "file"; readonly name: string }> = [
    ...directories.map((name) => ({ kind: "dir" as const, name })),
    ...files.map((name) => ({ kind: "file" as const, name }))
  ];
  for (const [index, entry] of entries.entries()) {
    const last = index === entries.length - 1;
    const branch = last ? "└── " : "├── ";
    const nextPrefix = `${prefix}${last ? "    " : "│   "}`;
    if (entry.kind === "file") {
      lines.push(`${prefix}${branch}${entry.name}`);
      continue;
    }
    lines.push(`${prefix}${branch}${entry.name}/`);
    const child = node.children.get(entry.name);
    if (child !== undefined) writeTree(child, nextPrefix, lines);
  }
}

function renderStructuralModules(snapshot: MapRenderIndex): string {
  const byPath = new Map<string, { readonly exports: string[]; readonly imports: string[] }>();
  const ensure = (filePath: string): { readonly exports: string[]; readonly imports: string[] } => {
    const current = byPath.get(filePath);
    if (current !== undefined) return current;
    const created = { exports: [] as string[], imports: [] as string[] };
    byPath.set(filePath, created);
    return created;
  };
  for (const item of snapshot.exports ?? []) {
    ensure(item.path).exports.push(`${abbrevKind(item.kind)} ${item.name}`);
  }
  for (const item of snapshot.imports ?? []) {
    ensure(item.path).imports.push(item.specifier);
  }
  const ranked = [...byPath.entries()]
    .filter(([filePath, entry]) => SOURCE_EXTENSIONS.has(path.extname(filePath)) && (entry.exports.length > 0 || entry.imports.length > 0))
    .sort((left, right) => right[1].exports.length - left[1].exports.length || compareStrings(left[0], right[0]));
  const selected = ranked.slice(0, MAX_MODULE_FILES);
  const lines = selected.map(([filePath, entry]) => {
    const exportLines = uniqueSorted(entry.exports).slice(0, 24).map((value) => `  ${value}`);
    const importLine = uniqueSorted(entry.imports).slice(0, 12);
    return [
      filePath,
      ...exportLines,
      ...(importLine.length === 0 ? [] : [`  import ${importLine.join(", ")}`])
    ].join("\n");
  });
  if (ranked.length > selected.length) {
    lines.push(`… ${ranked.length - selected.length} more modules`);
  }
  return lines.length === 0 ? "_No exported modules were extracted._" : lines.join("\n\n");
}

function renderInventoryModules(files: readonly CodebaseMapFile[]): string {
  const lines = files
    .filter((file) => file.symbols.length > 0)
    .slice(0, MAX_MODULE_FILES)
    .map((file) => `${file.path}\n  ${file.symbols.slice(0, 12).join(", ")}`);
  return lines.length === 0 ? "_No module symbols were extracted from inventory heuristics._" : lines.join("\n\n");
}

function renderIntelligenceSections(snapshot: MapRenderIndex | undefined): readonly string[] {
  if (snapshot === undefined) return [];
  return [
    ...renderArchitectureOverview(snapshot),
    ...renderCodeHealth(snapshot),
    ...renderDevelopmentHotspots(snapshot),
    ...renderBusFactor(snapshot)
  ];
}

function renderArchitectureOverview(snapshot: MapRenderIndex): readonly string[] {
  if (snapshot.rankedModules === undefined) return [];
  const modules = [...snapshot.rankedModules]
    .sort((left, right) => right.rank - left.rank || compareStrings(left.path, right.path))
    .slice(0, 10);
  return [
    "",
    "## Architecture Overview",
    "",
    "### Top Modules by Importance",
    "",
    ...(modules.length === 0
      ? ["_No ranked modules were provided._"]
      : modules.map((module) => {
          const symbols = module.symbols.length === 0 ? "" : ` — ${module.symbols.join(", ")}`;
          return `- ${module.path} (rank: ${formatNumber(module.rank)}, fan-in: ${module.fanIn}, fan-out: ${module.fanOut})${symbols}`;
        }))
  ];
}

function renderCodeHealth(snapshot: MapRenderIndex): readonly string[] {
  if (snapshot.healthScores === undefined) return [];
  const scores = [...snapshot.healthScores];
  const critical = scores.filter((item) => item.score < 5);
  const warning = scores.filter((item) => item.score >= 5 && item.score <= 7);
  const signalCounts = new Map<string, { count: number; severity: string; message: string }>();
  for (const score of scores) {
    for (const signal of score.signals) {
      const current = signalCounts.get(signal.code);
      if (current === undefined) {
        signalCounts.set(signal.code, { count: 1, severity: signal.severity, message: signal.message });
      } else {
        current.count += 1;
      }
    }
  }
  const topSignals = [...signalCounts.entries()]
    .sort(([leftCode, left], [rightCode, right]) => right.count - left.count || compareStrings(leftCode, rightCode))
    .slice(0, 3);
  const average = scores.length === 0
    ? "n/a"
    : formatNumber(scores.reduce((total, item) => total + item.score, 0) / scores.length);
  return [
    "",
    "## Code Health",
    "",
    `- Average health score: ${average}`,
    "",
    "### Critical Files (score below 5)",
    "",
    ...(critical.length === 0 ? ["_None_"] : critical.map((item) => `- ${item.path} (score: ${formatNumber(item.score)})`)),
    "",
    "### Warning Files (score 5-7)",
    "",
    ...(warning.length === 0 ? ["_None_"] : warning.map((item) => `- ${item.path} (score: ${formatNumber(item.score)})`)),
    "",
    "### Top Health Signals",
    "",
    ...(topSignals.length === 0
      ? ["_None_"]
      : topSignals.map(([code, signal]) => `- ${code} (${signal.count}) — ${signal.severity}: ${signal.message}`))
  ];
}

function renderDevelopmentHotspots(snapshot: MapRenderIndex): readonly string[] {
  if (snapshot.gitHotspots === undefined) return [];
  const hotspots = [...snapshot.gitHotspots]
    .sort((left, right) => right.changeCount - left.changeCount || compareStrings(left.path, right.path))
    .slice(0, 10);
  return [
    "",
    "## Development Hotspots",
    "",
    ...(hotspots.length === 0
      ? ["_No git history hotspots were found._"]
      : hotspots.map((item) => `- ${item.path} (${item.changeCount} changes, last: ${item.lastChanged})`))
  ];
}

function renderBusFactor(snapshot: MapRenderIndex): readonly string[] {
  if (snapshot.gitBusFactor === undefined) return [];
  const risks = [...snapshot.gitBusFactor]
    .filter((item) => item.contributorCount < 3)
    .sort((left, right) => left.contributorCount - right.contributorCount || compareStrings(left.directory, right.directory));
  return [
    "",
    "## Bus Factor",
    "",
    ...(risks.length === 0
      ? ["_No directories have fewer than 3 contributors._"]
      : risks.map((item) => {
          const contributorLabel = item.contributorCount === 1 ? "contributor" : "contributors";
          return `- ${displayDirectory(item.directory)} (${item.contributorCount} ${contributorLabel}) — risk: single point of failure`;
        }))
  ];
}

function displayDirectory(directory: string): string {
  if (directory === ".") return "./";
  return `${directory}/`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

function renderReferenceGraph(snapshot: MapRenderIndex, paths: readonly string[]): string {
  const known = new Set(paths);
  for (const item of snapshot.coverage ?? []) known.add(item.path);
  for (const item of snapshot.exports ?? []) known.add(item.path);
  for (const item of snapshot.imports ?? []) known.add(item.path);
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const edges: string[] = [];
  for (const item of snapshot.imports ?? []) {
    const target = resolveImportTarget(item.path, item.specifier, known);
    bump(fanOut, item.path);
    bump(fanIn, target);
    edges.push(`${item.path} -> ${target}`);
  }
  const uniqueEdges = uniqueSorted(edges).slice(0, MAX_GRAPH_EDGES);
  const topFanIn = topCounts(fanIn);
  const topFanOut = topCounts(fanOut);
  return [
    "### Highest fan-in",
    "",
    ...topFanIn.map(([name, count]) => `- ${name} (${count})`),
    ...(topFanIn.length === 0 ? ["_None_"] : []),
    "",
    "### Highest fan-out",
    "",
    ...topFanOut.map(([name, count]) => `- ${name} (${count})`),
    ...(topFanOut.length === 0 ? ["_None_"] : []),
    "",
    "```",
    ...uniqueEdges,
    ...(edges.length > uniqueEdges.length ? [`… ${edges.length - uniqueEdges.length} more edges`] : []),
    "```"
  ].join("\n");
}

function resolveImportTarget(fromPath: string, specifier: string, known: ReadonlySet<string>): string {
  if (!specifier.startsWith(".")) return specifier;
  const directory = path.posix.dirname(fromPath);
  const normalized = path.posix.normalize(path.posix.join(directory, specifier));
  const withoutExt = normalized.replace(/\.(?:js|mjs|cjs|jsx|ts|tsx)$/u, "");
  const candidates = [
    normalized,
    withoutExt,
    `${withoutExt}.ts`,
    `${withoutExt}.tsx`,
    `${withoutExt}.js`,
    `${withoutExt}.mjs`,
    `${withoutExt}.cjs`,
    `${withoutExt}.py`,
    `${withoutExt}/index.ts`,
    `${withoutExt}/index.js`,
    `${withoutExt}/index.py`
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? normalized;
}

function renderStructuralSearch(map: CodebaseMapDocument, snapshot: MapRenderIndex): string {
  const symbolsByPath = new Map<string, string[]>();
  for (const item of snapshot.exports ?? []) {
    const list = symbolsByPath.get(item.path) ?? [];
    list.push(`${abbrevKind(item.kind)} ${item.name}`);
    symbolsByPath.set(item.path, list);
  }
  for (const item of snapshot.symbols ?? []) {
    if (item.exported === true) continue;
    const list = symbolsByPath.get(item.path) ?? [];
    if (list.length >= MAX_SEARCH_SYMBOLS_PER_FILE) continue;
    list.push(`${abbrevKind(item.kind)} ${item.name}`);
    symbolsByPath.set(item.path, list);
  }
  return [
    "# Codebase Search Index",
    "",
    "Use `legion map --query <text>` to search the structural index.",
    "",
    ...map.files.flatMap((file) => {
      const symbols = uniqueSorted(symbolsByPath.get(file.path) ?? file.symbols);
      return [
        `## ${file.path}`,
        "",
        symbols.length > 0 ? `Symbols: ${symbols.join(", ")}` : "Symbols: none",
        ""
      ];
    })
  ].join("\n");
}

function renderInventorySearch(map: CodebaseMapDocument): string {
  return [
    "# Codebase Search Index",
    "",
    "Use `legion map --query <text>` to search this deterministic index.",
    "",
    ...map.files.flatMap((file) => [
      `## ${file.path}`,
      "",
      file.symbols.length > 0 ? `Symbols: ${file.symbols.join(", ")}` : "Symbols: none",
      ""
    ])
  ].join("\n");
}

function structuralSymbolRecords(snapshot: MapRenderIndex): readonly { readonly symbol: string; readonly path: string }[] {
  const records: Array<{ symbol: string; path: string }> = [];
  const seen = new Set<string>();
  const add = (symbol: string, filePath: string): void => {
    const key = `${filePath}\0${symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({ symbol, path: filePath });
  };
  for (const item of snapshot.exports ?? []) add(item.name, item.path);
  for (const item of snapshot.symbols ?? []) add(item.name, item.path);
  return records.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.symbol, right.symbol));
}

function renderExtensionCounts(files: readonly CodebaseMapFile[]): readonly string[] {
  const byExtension = new Map<string, number>();
  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase() || "(none)";
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }
  return [...byExtension.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .map(([extension, count]) => `- ${extension}: ${count}`);
}

function abbrevKind(kind: string): string {
  return KIND_ABBREV[kind] ?? kind;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function topCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .slice(0, MAX_FAN_ROWS);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
