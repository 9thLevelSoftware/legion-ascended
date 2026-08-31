import path from "node:path";

export interface CodeHealthScore {
  readonly path: string;
  readonly score: number;
  readonly signals: readonly HealthSignal[];
}

export interface HealthSignal {
  readonly code: string;
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export interface CodeHealthInput {
  readonly files: readonly {
    readonly path: string;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly symbols: readonly string[];
  }[];
  readonly imports: readonly { readonly path: string; readonly specifier: string }[];
  readonly exports: readonly { readonly path: string; readonly name: string }[];
  readonly testFiles?: readonly string[];
}

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts",
  ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".swift", ".ts", ".tsx", ".vue"
]);
const IMPORT_EXTENSIONS = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|json|kt|kts|mjs|php|py|rb|rs|scala|sh|sql|swift|ts|tsx|vue)$/u;

function basenameWithoutExtension(filePath: string): string {
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(basename);
  return extension.length === 0 ? basename : basename.slice(0, -extension.length);
}

function isIndexFile(filePath: string): boolean {
  return basenameWithoutExtension(filePath).toLowerCase() === "index";
}

function isTestFile(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  const basename = parts.at(-1) ?? filePath;
  const stem = basenameWithoutExtension(basename);
  const lowerStem = stem.toLowerCase();
  return parts.slice(0, -1).some((part) => ["test", "tests", "spec", "specs", "__tests__"].includes(part.toLowerCase())) ||
    /(?:^|[._-])(test|spec)(?:$|[._-])/iu.test(lowerStem) ||
    /^(?:test|spec)(?:[._-]|$)/iu.test(lowerStem);
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function importCandidates(fromPath: string, specifier: string): readonly string[] {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const withoutExtension = normalized.replace(IMPORT_EXTENSIONS, "");
  return [
    normalized,
    withoutExtension,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.js`,
    `${withoutExtension}.jsx`,
    `${withoutExtension}.mjs`,
    `${withoutExtension}.cjs`,
    `${withoutExtension}.py`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
    `${withoutExtension}/index.js`,
    `${withoutExtension}/index.py`
  ];
}

function resolveImportTarget(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | undefined {
  if (!specifier.startsWith(".")) return knownPaths.has(specifier) ? specifier : undefined;
  return importCandidates(fromPath, specifier).find((candidate) => knownPaths.has(candidate));
}

function buildFanIn(
  imports: readonly { readonly path: string; readonly specifier: string }[],
  knownPaths: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> {
  const fanIn = new Map<string, Set<string>>();
  for (const item of imports) {
    const target = resolveImportTarget(item.path, item.specifier, knownPaths);
    if (target === undefined) continue;
    const importers = fanIn.get(target) ?? new Set<string>();
    importers.add(item.path);
    fanIn.set(target, importers);
  }
  return fanIn;
}

function hasTestNeighbor(filePath: string, testPaths: ReadonlySet<string>): boolean {
  const directory = path.posix.dirname(filePath);
  const sourceStem = basenameWithoutExtension(filePath);
  for (const testPath of testPaths) {
    if (path.posix.dirname(testPath) !== directory) continue;
    const testStem = basenameWithoutExtension(testPath);
    if (testStem === `${sourceStem}.test` || testStem === `${sourceStem}.spec`) return true;
  }
  return false;
}

function addSignal(
  signals: HealthSignal[],
  code: string,
  severity: HealthSignal["severity"],
  message: string,
  deduction: number
): number {
  signals.push({ code, severity, message });
  return deduction;
}

/**
 * Score each supplied file using only the deterministic inventory and graph
 * signals in the input. File order is preserved in the returned scores.
 */
export function scoreCodeHealth(input: CodeHealthInput): readonly CodeHealthScore[] {
  const knownPaths = new Set<string>([
    ...input.files.map((file) => file.path),
    ...(input.testFiles ?? [])
  ]);
  const inferredTestFiles = input.files.filter((file) => isTestFile(file.path)).map((file) => file.path);
  const testPaths = new Set<string>([...(input.testFiles ?? []), ...inferredTestFiles]);
  const fanIn = buildFanIn(input.imports, knownPaths);
  const exportsByPath = new Set(input.exports.map((item) => item.path));

  return input.files.map((file) => {
    const signals: HealthSignal[] = [];
    let score = 10;
    const testFile = testPaths.has(file.path) || isTestFile(file.path);

    if (file.lineCount > 1_000) {
      score += addSignal(
        signals,
        "very-large-file",
        "critical",
        `${file.path} has ${file.lineCount} lines, exceeding the 1,000-line critical threshold.`,
        -2
      );
    } else if (file.lineCount > 500) {
      score += addSignal(
        signals,
        "large-file",
        "warning",
        `${file.path} has ${file.lineCount} lines, exceeding the 500-line threshold.`,
        -1
      );
    }

    if (file.symbols.length === 0) {
      score += addSignal(
        signals,
        "no-symbols",
        "warning",
        `${file.path} has no extracted symbols.`,
        -1
      );
    }

    if (!testFile && !exportsByPath.has(file.path)) {
      score += addSignal(
        signals,
        "no-exports",
        "warning",
        `${file.path} has no extracted exports.`,
        -1
      );
    }

    const importers = fanIn.get(file.path);
    const importerCount = importers?.size ?? 0;
    if (importerCount > 10) {
      score += addSignal(
        signals,
        "high-fan-in",
        "info",
        `${file.path} is imported by ${importerCount} distinct files.`,
        -1
      );
    }

    if (isSourceFile(file.path) && !testFile && !hasTestNeighbor(file.path, testPaths)) {
      score += addSignal(
        signals,
        "no-tests",
        "warning",
        `${file.path} has no neighboring test file.`,
        -1
      );
    }

    if (file.lineCount === 0) {
      score += addSignal(
        signals,
        "empty-file",
        "critical",
        `${file.path} is empty.`,
        -3
      );
    }

    if (file.lineCount < 5 && !isIndexFile(file.path)) {
      score += addSignal(
        signals,
        "very-small-file",
        "info",
        `${file.path} has only ${file.lineCount} lines.`,
        -1
      );
    }

    return {
      path: file.path,
      score: Math.max(1, Math.min(10, score)),
      signals
    };
  });
}
