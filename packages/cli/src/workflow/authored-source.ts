import path from "node:path";

/** One definition shared by project classification and full-map collection. */
export const AUTHORED_SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs", ".scala",
  ".sh", ".sql", ".swift", ".ts", ".tsx", ".vue"
]);

export const AUTHORED_DEPENDENCY_MANIFESTS = new Set([
  "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb",
  "deno.json", "deno.jsonc", "cargo.toml", "cargo.lock", "go.mod", "go.sum", "composer.json",
  "gemfile", "gemfile.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "pipfile",
  "pom.xml", "build.gradle", "build.gradle.kts", "packages.config"
]);

export const AUTHORED_BUILD_CONFIGURATION = new Set([
  "tsconfig.json", "jsconfig.json", "vite.config.js", "vite.config.ts", "webpack.config.js",
  "webpack.config.ts", "rollup.config.js", "rollup.config.ts", "makefile", "cmakelists.txt",
  "dockerfile", "compose.yaml", "docker-compose.yml", "turbo.json", "nx.json"
]);

export const AUTHORED_IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".legion", ".worktrees", "node_modules", "dist", "build",
  "coverage", ".next", ".turbo", ".cache", "target", "tmp", "temp"
]);

/** Host-authored draft input lives under ignored runtime state so composing it cannot stale a fresh map. */
export const INTAKE_DRAFT_INPUT_DIRECTORY = ".legion/var/intake-drafts" as const;
export const DEFAULT_INTAKE_DRAFT_INPUT_PATH = `${INTAKE_DRAFT_INPUT_DIRECTORY}/intake-draft.json` as const;

export function shouldTraverseAuthoredDirectory(name: string): boolean {
  return !AUTHORED_IGNORED_DIRECTORIES.has(name.toLowerCase());
}

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const MAP_CONTEXT_EXTENSIONS = new Set([".json", ".toml", ".yaml", ".yml", ...DOCUMENT_EXTENSIONS]);

export function isAuthoredCodeOrBuildFile(file: string): boolean {
  const basename = path.basename(file).toLowerCase();
  return AUTHORED_SOURCE_EXTENSIONS.has(path.extname(basename)) ||
    AUTHORED_DEPENDENCY_MANIFESTS.has(basename) ||
    AUTHORED_BUILD_CONFIGURATION.has(basename);
}

export function isDocumentationFile(file: string): boolean {
  const basename = path.basename(file).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(path.extname(basename)) || basename === "license" || basename.startsWith("license.");
}

/** Context files plus every file capable of making a repository brownfield. */
export function isFullMapAuthoredFile(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized === INTAKE_DRAFT_INPUT_DIRECTORY || normalized.startsWith(`${INTAKE_DRAFT_INPUT_DIRECTORY}/`)) return false;
  const basename = path.basename(file).toLowerCase();
  return isAuthoredCodeOrBuildFile(file) || MAP_CONTEXT_EXTENSIONS.has(path.extname(basename)) ||
    ["readme", "license", "changelog"].includes(basename);
}
