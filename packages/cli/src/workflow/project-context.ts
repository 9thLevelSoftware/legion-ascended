import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface ProjectContextInput {
  readonly repositoryRoot: string;
  readonly scope: string;
  readonly files: readonly {
    readonly path: string;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly symbols: readonly string[];
  }[];
  readonly imports: readonly { readonly path: string; readonly specifier: string }[];
  readonly exports: readonly { readonly path: string; readonly name: string; readonly kind: string }[];
  readonly coverage: readonly { readonly path: string; readonly status: string }[];
}

export interface ProjectContext {
  readonly agentsMd: string;
  readonly techStack: readonly string[];
  readonly entryPoints: readonly string[];
  readonly buildCommands: readonly string[];
  readonly testCommands: readonly string[];
}

const MAX_AGENTS_BYTES = 2_047;
const ENTRY_BASENAMES = new Set(["index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js"]);
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".go": "Go",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scala": "Scala",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue"
};
const PROGRAMMING_LANGUAGES = new Set([
  "C", "C++", "C#", "Go", "Java", "JavaScript", "Kotlin", "PHP", "Python", "Ruby", "Rust", "Scala", "Shell", "SQL", "Swift", "TypeScript", "Vue"
]);
const PACKAGE_MANAGER_NAMES = new Set(["npm", "pnpm", "yarn", "bun"]);

interface PackageManifest {
  readonly scripts: Readonly<Record<string, unknown>>;
  readonly dependencyNames: readonly string[];
  readonly packageManager?: string;
}

interface DetectedCommands {
  readonly build: readonly string[];
  readonly test: readonly string[];
  readonly lint: readonly string[];
}

interface MarkdownSection {
  readonly title: string;
  readonly lines: string[];
}

export function generateProjectContext(input: ProjectContextInput): ProjectContext {
  const files = input.files.map((file) => ({ ...file, path: normalizePath(file.path) }));
  const coveragePaths = input.coverage.map((file) => normalizePath(file.path));
  const packageManifest = readPackageManifest(input.repositoryRoot);
  const techStack = detectTechStack(input.repositoryRoot, files, coveragePaths, packageManifest);
  const entryPoints = identifyEntryPoints(files);
  const commands = detectCommands(input.repositoryRoot, packageManifest, techStack);
  const architecture = summarizeArchitecture(files);
  const keyModules = summarizeKeyModules(input.exports);
  const agentsMd = renderAgentsMarkdown({
    scope: normalizePath(input.scope),
    fileCount: files.length,
    coverageCount: input.coverage.length,
    techStack,
    entryPoints,
    architecture,
    keyModules,
    commands,
    hasTests: files.some(({ path: filePath }) => isTestPath(filePath)),
    hasDefaultExports: input.exports.some(({ name }) => name === "default")
  });

  return {
    agentsMd,
    techStack,
    entryPoints,
    buildCommands: commands.build,
    testCommands: commands.test
  };
}

function detectTechStack(
  repositoryRoot: string,
  files: readonly { readonly path: string }[],
  coveragePaths: readonly string[],
  packageManifest: PackageManifest | undefined
): readonly string[] {
  const stack = new Set<string>();
  const add = (value: string): void => {
    stack.add(value);
  };
  const manifestNames = new Set(rootNames(repositoryRoot));

  if (packageManifest !== undefined || manifestNames.has("package.json")) {
    add("Node.js");
    add("TypeScript");
  }
  if (manifestNames.has("requirements.txt") || manifestNames.has("pyproject.toml")) add("Python");
  if (manifestNames.has("cargo.toml")) add("Rust");
  if (manifestNames.has("go.mod")) add("Go");
  if (manifestNames.has("gemfile")) add("Ruby");
  if (manifestNames.has("pom.xml") || manifestNames.has("build.gradle") || manifestNames.has("build.gradle.kts")) add("Java");

  const extensions = new Set<string>();
  for (const filePath of [...files.map(({ path: filePath }) => filePath), ...coveragePaths]) {
    const extension = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language !== undefined) extensions.add(language);
  }
  for (const language of [...extensions].sort()) {
    if (PROGRAMMING_LANGUAGES.has(language)) add(language);
  }

  const manager = detectPackageManager(repositoryRoot, packageManifest);
  if (manager !== undefined) add(manager);

  const dependencyText = [
    ...(packageManifest?.dependencyNames ?? []),
    ...readRootText(repositoryRoot, "requirements.txt"),
    ...readRootText(repositoryRoot, "pyproject.toml"),
    ...readRootText(repositoryRoot, "cargo.toml"),
    ...readRootText(repositoryRoot, "go.mod"),
    ...readRootText(repositoryRoot, "pom.xml"),
    ...readRootText(repositoryRoot, "build.gradle"),
    ...readRootText(repositoryRoot, "build.gradle.kts")
  ].join("\n").toLowerCase();
  for (const framework of detectFrameworks(dependencyText)) add(framework);

  return [...stack];
}

function detectFrameworks(dependencyText: string): readonly string[] {
  const frameworks: string[] = [];
  const matches = (names: readonly string[]): boolean => names.some((name) => dependencyText.includes(name));
  const candidates: readonly [string, readonly string[]][] = [
    ["Angular", ["@angular/core"]],
    ["React", ["react", "react-dom"]],
    ["Vue", ["vue"]],
    ["Svelte", ["svelte"]],
    ["Next.js", ["next"]],
    ["Nuxt", ["nuxt"]],
    ["NestJS", ["@nestjs/core"]],
    ["Express", ["express"]],
    ["Fastify", ["fastify"]],
    ["Koa", ["koa"]],
    ["FastAPI", ["fastapi"]],
    ["Flask", ["flask"]],
    ["Django", ["django"]],
    ["Vite", ["vite"]],
    ["Webpack", ["webpack"]],
    ["Spring", ["spring-boot", "org.springframework"]],
    ["Actix", ["actix-web"]],
    ["Axum", ["axum"]],
    ["Gin", ["github.com/gin-gonic/gin"]]
  ];
  for (const [framework, names] of candidates) {
    if (matches(names)) frameworks.push(framework);
  }
  return frameworks;
}

function identifyEntryPoints(files: readonly { readonly path: string; readonly symbols: readonly string[] }[]): readonly string[] {
  const candidates = new Map<string, number>();
  for (const file of files) {
    const baseName = path.posix.basename(file.path).toLowerCase();
    const inBin = file.path === "bin" || file.path.startsWith("bin/");
    const conventional = ENTRY_BASENAMES.has(baseName);
    const symbolEntry = file.symbols.some((symbol) => /(boot|start|main|init)/iu.test(symbol));
    if (inBin) candidates.set(file.path, 0);
    else if (conventional) candidates.set(file.path, 1);
    else if (symbolEntry) candidates.set(file.path, 2);
  }
  return [...candidates.entries()]
    .sort(([leftPath, leftPriority], [rightPath, rightPriority]) => leftPriority - rightPriority || leftPath.localeCompare(rightPath))
    .map(([filePath]) => filePath);
}

function summarizeArchitecture(files: readonly { readonly path: string }[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const directory = directoryOf(file.path);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftPath, leftCount], [rightPath, rightCount]) => rightCount - leftCount || leftPath.localeCompare(rightPath))
    .map(([directory, count]) => `${directory === "." ? "root/" : `${directory}/`} — ${count} ${count === 1 ? "file" : "files"}`);
}

function summarizeKeyModules(exports: readonly { readonly path: string }[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const entry of exports) {
    const filePath = normalizePath(entry.path);
    counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftPath, leftCount], [rightPath, rightCount]) => rightCount - leftCount || leftPath.localeCompare(rightPath))
    .map(([filePath, count]) => `${filePath} — ${count} ${count === 1 ? "export" : "exports"}`);
}

function detectCommands(repositoryRoot: string, manifest: PackageManifest | undefined, techStack: readonly string[]): DetectedCommands {
  const manager = techStack.find((value) => PACKAGE_MANAGER_NAMES.has(value)) ?? "npm";
  const build: string[] = [];
  const test: string[] = [];
  const lint: string[] = [];
  const addTarget = (target: string, tool: string): void => {
    const command = `${tool} ${target}`;
    if (/^(build|compile|typecheck)(?::|$)/iu.test(target)) addUnique(build, command);
    if (/^test(?::|$)/iu.test(target)) addUnique(test, command);
    if (/^(lint|format)(?::|$)/iu.test(target)) addUnique(lint, command);
  };

  if (manifest !== undefined) {
    const scriptNames = Object.keys(manifest.scripts).sort();
    for (const scriptName of scriptNames) {
      if (typeof manifest.scripts[scriptName] !== "string") continue;
      const command = packageScriptCommand(manager, scriptName);
      if (/^(build|compile|typecheck)(?::|$)/iu.test(scriptName)) addUnique(build, command);
      if (/^test(?::|$)/iu.test(scriptName)) addUnique(test, command);
      if (/^(lint|format)(?::|$)/iu.test(scriptName)) addUnique(lint, command);
    }
  }

  const makefile = readRootText(repositoryRoot, "Makefile").join("\n");
  for (const target of targetNames(makefile)) addTarget(target, "make");
  const justfile = readRootText(repositoryRoot, "Justfile").join("\n");
  for (const target of targetNames(justfile)) addTarget(target, "just");

  if (test.length === 0) {
    if (techStack.includes("Rust")) addUnique(test, "cargo test");
    else if (techStack.includes("Go")) addUnique(test, "go test ./...");
    else if (techStack.includes("Python")) addUnique(test, "pytest");
    else if (techStack.includes("Java")) addUnique(test, "mvn test");
    else if (manifest !== undefined) addUnique(test, `${manager} test`);
  }
  if (build.length === 0) {
    if (techStack.includes("Rust")) addUnique(build, "cargo build");
    else if (techStack.includes("Go")) addUnique(build, "go build ./...");
  }

  return { build, test, lint };
}

function renderAgentsMarkdown(input: {
  readonly scope: string;
  readonly fileCount: number;
  readonly coverageCount: number;
  readonly techStack: readonly string[];
  readonly entryPoints: readonly string[];
  readonly architecture: readonly string[];
  readonly keyModules: readonly string[];
  readonly commands: DetectedCommands;
  readonly hasTests: boolean;
  readonly hasDefaultExports: boolean;
}): string {
  const techLines = input.techStack.map((value) => `- ${renderTech(value)}`);
  const entryLines = input.entryPoints.slice(0, 8).map((filePath) => `- ${filePath}`);
  const architectureLines = input.architecture.slice(0, 10).map((line) => `- ${line}`);
  const keyModuleLines = input.keyModules.slice(0, 6).map((line) => `- ${line}`);
  const buildLines = input.commands.build.slice(0, 4).map((command) => `- Build: ${command}`);
  const testLines = input.commands.test.slice(0, 4).map((command) => `- Test: ${command}`);
  const lintLines = input.commands.lint.slice(0, 2).map((command) => `- Lint: ${command}`);
  const commandLines = [...buildLines, ...testLines, ...lintLines];
  const sections: MarkdownSection[] = [
    { title: "Tech Stack", lines: techLines },
    { title: "Entry Points", lines: entryLines },
    {
      title: "Architecture",
      lines: [`- Scope: ${input.scope}; ${input.fileCount} mapped file(s), ${input.coverageCount} coverage record(s).`, ...architectureLines]
    },
    { title: "Key Modules", lines: keyModuleLines },
    { title: "Build & Test", lines: commandLines },
    {
      title: "Conventions",
      lines: [
        `- ${input.hasTests ? "Tests are present under test paths." : "No test paths were observed in the mapped files."}`,
        `- ${input.hasDefaultExports ? "Default exports were observed." : "No default exports were observed in the structural export facts."}`,
        "- This context is deterministic and derived from repository structure; verify behavior in source and tests."
      ]
    }
  ];

  const boundedSections = sections.map((section) => ({
    title: section.title,
    lines: section.lines.map((line) => shortenLine(line, 128))
  }));
  const reductionOrder = ["Entry Points", "Architecture", "Key Modules", "Tech Stack", "Build & Test", "Conventions"];
  let boundedMarkdown = ["# Project Context", "", ...renderSections(boundedSections)].join("\n");
  while (Buffer.byteLength(boundedMarkdown, "utf8") >= MAX_AGENTS_BYTES) {
    let reduced = false;
    for (const title of reductionOrder) {
      const section = boundedSections.find((candidate) => candidate.title === title);
      if (section !== undefined && section.lines.length > 1) {
        section.lines.pop();
        reduced = true;
        break;
      }
    }
    if (!reduced) break;
    boundedMarkdown = ["# Project Context", "", ...renderSections(boundedSections)].join("\n");
  }
  return truncateUtf8(boundedMarkdown.endsWith("\n") ? boundedMarkdown : `${boundedMarkdown}\n`, MAX_AGENTS_BYTES);
}

function renderTech(value: string): string {
  if (value === "Node.js") return "Runtime: Node.js";
  if (PACKAGE_MANAGER_NAMES.has(value)) return `Package Manager: ${value}`;
  if (PROGRAMMING_LANGUAGES.has(value)) return `Language: ${value}`;
  return `Framework: ${value}`;
}

function renderSections(sections: readonly MarkdownSection[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push(...(section.lines.length === 0 ? ["- None detected."] : section.lines));
    lines.push("");
  }
  return lines;
}

function packageScriptCommand(manager: string, scriptName: string): string {
  if (scriptName === "test") return `${manager} test`;
  if (manager === "npm" || manager === "bun") return `${manager} run ${scriptName}`;
  return `${manager} ${scriptName}`;
}

function targetNames(text: string): readonly string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_.-]+):(?:\s|$)/u.exec(line);
    const name = match?.[1];
    if (name !== undefined && !name.startsWith(".")) addUnique(names, name);
  }
  return names.sort();
}

function readPackageManifest(repositoryRoot: string): PackageManifest | undefined {
  const packagePath = rootFilePath(repositoryRoot, "package.json");
  if (packagePath === undefined) return undefined;
  const text = readText(packagePath);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const scripts = isRecord(parsed["scripts"]) ? parsed["scripts"] : {};
    const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => {
      const value = parsed[key];
      return isRecord(value) ? Object.keys(value) : [];
    });
    return {
      scripts,
      dependencyNames: [...new Set(dependencies)].sort(),
      ...(typeof parsed["packageManager"] === "string" ? { packageManager: parsed["packageManager"] } : {})
    };
  } catch {
    return undefined;
  }
}

function detectPackageManager(repositoryRoot: string, manifest: PackageManifest | undefined): string | undefined {
  const packageManager = manifest?.packageManager?.match(/^(npm|pnpm|yarn|bun)(?:@|$)/iu)?.[1]?.toLowerCase();
  if (packageManager !== undefined) return packageManager;
  const names = new Set(rootNames(repositoryRoot));
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (manifest !== undefined || names.has("package-lock.json")) return "npm";
  return undefined;
}

function rootNames(repositoryRoot: string): readonly string[] {
  try {
    return readdirSync(repositoryRoot, { withFileTypes: true }).map((entry) => entry.name.toLowerCase());
  } catch {
    return [];
  }
}

function readRootText(repositoryRoot: string, name: string): readonly string[] {
  const filePath = rootFilePath(repositoryRoot, name);
  const text = filePath === undefined ? undefined : readText(filePath);
  return text === undefined ? [] : [text];
}

function rootFilePath(repositoryRoot: string, name: string): string | undefined {
  const exactPath = path.join(repositoryRoot, name);
  if (existsSync(exactPath)) return exactPath;
  try {
    const entry = readdirSync(repositoryRoot, { withFileTypes: true }).find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    return entry === undefined ? undefined : path.join(repositoryRoot, entry.name);
  } catch {
    return undefined;
  }
}

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function directoryOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? "." : filePath.slice(0, slash);
}

function isTestPath(filePath: string): boolean {
  return /(?:^|\/)(?:test|tests)(?:\/|$)|(?:\.test|\.spec)\.[^.]+$/iu.test(filePath);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function shortenLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(1, maxLength - 3))}...`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(`${truncated.trimEnd()}\n`, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return `${truncated.trimEnd()}\n`;
}
