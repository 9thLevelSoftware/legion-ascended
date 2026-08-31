import path from "node:path";

const DAMPING_FACTOR = 0.85;
const MAX_ITERATIONS = 50;
const CONVERGENCE_THRESHOLD = 0.001;
const DEFAULT_TOKEN_BUDGET = 4_000;
const DEFAULT_TOKENS_PER_MODULE = 80;
const SOURCE_EXTENSIONS = /\.(?:cjs|js|json|mjs|py|ts|tsx|yaml|yml)$/u;
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".yaml", ".yml"] as const;

export interface GraphRankResult {
  readonly ranked: readonly RankedModule[];
}

export interface RankedModule {
  readonly path: string;
  readonly rank: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly symbols: readonly string[];
}

type ImportRecord = {
  readonly path: string;
  readonly specifier: string;
};

type ExportRecord = {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
};

type CoverageRecord = {
  readonly path: string;
};

/**
 * Rank covered modules by their importance in the import graph.
 *
 * Relative import specifiers are resolved against the supplied coverage set so
 * that TypeScript's emitted `.js` specifiers can still point at `.ts` files.
 */
export function rankModules(input: {
  readonly imports: readonly ImportRecord[];
  readonly exports: readonly ExportRecord[];
  readonly coverage: readonly CoverageRecord[];
  readonly tokenBudget?: number;
  readonly tokensPerModule?: number;
}): GraphRankResult {
  const knownPaths = new Set<string>();
  for (const file of input.coverage) knownPaths.add(file.path);
  for (const item of input.exports) knownPaths.add(item.path);
  for (const item of input.imports) knownPaths.add(item.path);

  const modulePaths = [...knownPaths].sort(compareStrings);
  if (modulePaths.length === 0) return { ranked: [] };

  const moduleIndex = new Map(modulePaths.map((modulePath, index) => [modulePath, index]));
  const adjacency = modulePaths.map(() => new Set<number>());
  const incoming = modulePaths.map(() => new Set<number>());

  for (const item of input.imports) {
    const sourceIndex = moduleIndex.get(item.path);
    if (sourceIndex === undefined) continue;
    const targetPath = resolveImportTarget(item.path, item.specifier, knownPaths);
    if (targetPath === undefined) continue;
    const targetIndex = moduleIndex.get(targetPath);
    if (targetIndex === undefined) continue;
    adjacency[sourceIndex]?.add(targetIndex);
    incoming[targetIndex]?.add(sourceIndex);
  }

  const scores = pageRank(adjacency);
  const maxScore = Math.max(...scores);
  const symbolsByPath = collectExportedSymbols(input.exports);
  const ranked = modulePaths.map((modulePath, index) => {
    const score = scores[index] ?? 0;
    return {
      path: modulePath,
      rank: maxScore > 0 ? score / maxScore : 0,
      fanIn: incoming[index]?.size ?? 0,
      fanOut: adjacency[index]?.size ?? 0,
      symbols: symbolsByPath.get(modulePath) ?? []
    } satisfies RankedModule;
  }).sort(compareRankedModules);

  return {
    ranked: ranked.slice(0, moduleLimit(input.tokenBudget, input.tokensPerModule, ranked.length))
  };
}

function pageRank(adjacency: readonly ReadonlySet<number>[]): number[] {
  const moduleCount = adjacency.length;
  const initialScore = 1 / moduleCount;
  let scores = Array.from({ length: moduleCount }, () => initialScore);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const nextScores = Array.from(
      { length: moduleCount },
      () => (1 - DAMPING_FACTOR) / moduleCount
    );
    let danglingScore = 0;

    for (const [sourceIndex, targets] of adjacency.entries()) {
      const sourceScore = scores[sourceIndex] ?? 0;
      if (targets.size === 0) {
        danglingScore += sourceScore;
        continue;
      }
      const contribution = DAMPING_FACTOR * sourceScore / targets.size;
      for (const targetIndex of targets) {
        nextScores[targetIndex] = (nextScores[targetIndex] ?? 0) + contribution;
      }
    }

    const danglingContribution = DAMPING_FACTOR * danglingScore / moduleCount;
    for (let index = 0; index < nextScores.length; index += 1) {
      nextScores[index] = (nextScores[index] ?? 0) + danglingContribution;
    }

    const change = scores.reduce(
      (maximum, score, index) => Math.max(maximum, Math.abs(score - (nextScores[index] ?? 0))),
      0
    );
    scores = nextScores;
    if (change < CONVERGENCE_THRESHOLD) break;
  }

  return scores;
}

function collectExportedSymbols(exports: readonly ExportRecord[]): Map<string, readonly string[]> {
  const symbolsByPath = new Map<string, Set<string>>();
  for (const item of exports) {
    const symbols = symbolsByPath.get(item.path) ?? new Set<string>();
    symbols.add(item.name);
    symbolsByPath.set(item.path, symbols);
  }
  return new Map(
    [...symbolsByPath.entries()].map(([modulePath, symbols]) => [modulePath, [...symbols].sort(compareStrings)])
  );
}

function resolveImportTarget(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | undefined {
  if (!specifier.startsWith(".")) return knownPaths.has(specifier) ? specifier : undefined;

  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const withoutExtension = normalized.replace(SOURCE_EXTENSIONS, "");
  const candidates = [
    normalized,
    withoutExtension,
    ...IMPORT_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) => `${withoutExtension}/index${extension}`)
  ];
  return candidates.find((candidate) => knownPaths.has(candidate));
}

function moduleLimit(
  tokenBudget: number | undefined,
  tokensPerModule: number | undefined,
  moduleCount: number
): number {
  const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const perModule = tokensPerModule ?? DEFAULT_TOKENS_PER_MODULE;
  if (!Number.isFinite(budget) || !Number.isFinite(perModule) || perModule <= 0) return moduleCount;
  return Math.min(moduleCount, Math.max(0, Math.floor(budget / perModule)));
}

function compareRankedModules(left: RankedModule, right: RankedModule): number {
  return right.rank - left.rank || compareStrings(left.path, right.path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
