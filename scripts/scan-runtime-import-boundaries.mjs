#!/usr/bin/env node
// scan-runtime-import-boundaries.mjs
//
// ADR-004 import-boundary verification for the RuntimeDriver contract.
//
// Verifies:
//   1. packages/core/src/runtime/*.ts imports nothing from provider
//      packages (eve, host CLIs, sqlite storage) and never imports a
//      legacy prompt asset path.
//   2. packages/core/src/runtime/*.ts imports only `@legion/protocol`
//      from workspace packages (per ADR-004: core domain types,
//      protocol entities, board records, policy records, task
//      contracts, approvals, evidence indexes, and worker bundle
//      manifests must not import Eve types or rely on private Eve
//      internals).
//   3. packages/core/src/** that is NOT under runtime/ does not import
//      from `./runtime/*` or `@legion/core/runtime/*` — runtime
//      concerns stay encapsulated until Phase 5 wires the board to the
//      driver.
//
// The scan is intentionally strict. Any forbidden import is reported
// with the file path and offending specifier. Used by:
//   - tests/runtime-import-boundaries.test.mjs (per-repo regression guard)
//   - scripts/validate-next.mjs `runtime-import-boundaries` step (CI gate)

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

const FORBIDDEN_PROVIDER_OR_STORAGE_IMPORTS = new Set([
  "eve",
  "node:sqlite",
  "better-sqlite3",
  "sqlite3"
]);

// Host CLI / v8 adapter adapter entry points are also forbidden — the
// runtime contract must not depend on host CLI internals per ADR-004
// (the rejected alternative "keep host CLI adapters as the runtime").
const FORBIDDEN_HOST_CLI_IMPORTS = new Set([
  "claude-code",
  "codex-cli",
  "kilo-cli",
  "kiro-cli",
  "opencode",
  "windsurf",
  "antigravity-cli",
  "copilot-cli",
  "cursor",
  "aider",
  "kilo-code",
  "gemini-cli"
]);

const LEGACY_PROMPT_ROOTS = [
  ".codex-plugin",
  "adapters",
  "agents",
  "commands",
  "skills"
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const RUNTIME_RELATIVE_ROOT = path.join("packages", "core", "src", "runtime");
const CORE_SRC_ROOT = path.join("packages", "core", "src");

export const RUNTIME_IMPORT_BOUNDARY_RULES = Object.freeze({
  allowedWorkspaceImportsForRuntime: new Set(["@legion/protocol"]),
  forbiddenProviderOrStorageImports: FORBIDDEN_PROVIDER_OR_STORAGE_IMPORTS,
  forbiddenHostCliImports: FORBIDDEN_HOST_CLI_IMPORTS,
  legacyPromptRoots: LEGACY_PROMPT_ROOTS
});

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isWorkspaceImport(specifier) {
  return specifier.startsWith("@legion/");
}

function workspacePackageName(specifier) {
  if (!isWorkspaceImport(specifier)) return null;
  const [scope, name] = specifier.split("/");
  if (!scope || !name) return null;
  return `${scope}/${name}`;
}

function isDeepWorkspaceImport(specifier, packageName) {
  return specifier !== packageName && specifier.startsWith(`${packageName}/`);
}

function matchesImportRoot(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function resolvesToLegacyPromptAsset(specifier, relativeFile) {
  if (!specifier.startsWith(".")) return null;

  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativeFile), specifier)
  );
  if (resolved.startsWith("..")) return null;

  for (const root of LEGACY_PROMPT_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}/`)) return resolved;
  }
  return null;
}

function extractImportSpecifiers(sourceText) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(sourceText);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(sourceText);
    }
  }
  return specifiers;
}

async function listSourceFiles(root, relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolutePath);
      }
    }
  }

  await visit(absoluteDir);
  return files;
}

function validateRuntimeModule({ relativeFile, specifier }) {
  const violations = [];

  if ([...FORBIDDEN_PROVIDER_OR_STORAGE_IMPORTS].some((forbidden) => matchesImportRoot(specifier, forbidden))) {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "forbidden_provider_or_storage_import",
      message: `packages/core/src/runtime cannot use provider or storage import ${specifier}`
    });
  }

  if ([...FORBIDDEN_HOST_CLI_IMPORTS].some((forbidden) => matchesImportRoot(specifier, forbidden))) {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "forbidden_host_cli_import",
      message: `packages/core/src/runtime cannot depend on host CLI ${specifier}`
    });
  }

  const legacyPromptAsset = resolvesToLegacyPromptAsset(specifier, relativeFile);
  if (legacyPromptAsset) {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "legacy_prompt_asset_import",
      message: `packages/core/src/runtime cannot import legacy prompt asset ${legacyPromptAsset}`
    });
  }

  const workspaceName = workspacePackageName(specifier);
  if (workspaceName && workspaceName !== "@legion/protocol") {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "disallowed_workspace_import",
      message: `packages/core/src/runtime can only import @legion/protocol from the workspace; saw ${workspaceName}`
    });
  }

  if (workspaceName === "@legion/protocol" && isDeepWorkspaceImport(specifier, workspaceName)) {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "deep_workspace_import",
      message: `packages/core/src/runtime cannot use deep import ${specifier}; use @legion/protocol`
    });
  }

  return violations;
}

function resolvesToRuntimeModule(specifier, relativeFile) {
  if (!specifier.startsWith(".")) {
    return (
      specifier === "@legion/core/runtime" ||
      specifier.startsWith("@legion/core/runtime/")
    );
  }

  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativeFile), specifier)
  );
  if (resolved.startsWith("..")) return false;
  if (!resolved.startsWith("packages/core/src/runtime/")) return false;
  return resolved.startsWith("packages/core/src/runtime/");
}

function validateOutsideRuntime({ relativeFile, specifier }) {
  const violations = [];

  // The public API barrel (`packages/core/src/index.ts`) is the one
  // place that legitimately re-exports the runtime module so
  // downstream packages can `import { RuntimeDriver } from
  // "@legion/core"`. Any other core source must not depend on it
  // until Phase 5 wires the board to the driver.
  if (relativeFile === "packages/core/src/index.ts") {
    return violations;
  }

  if (resolvesToRuntimeModule(specifier, relativeFile)) {
    violations.push({
      file: relativeFile,
      specifier,
      rule: "core_module_must_not_depend_on_runtime",
      message: `${relativeFile} cannot depend on the runtime module yet (Phase 5 wires the board to the driver)`
    });
  }

  return violations;
}

export async function scanRuntimeImportBoundaries(options = {}) {
  const root = options.root ? path.resolve(options.root) : DEFAULT_ROOT;
  const violations = [];

  // Rule 1 + 2: only allowed workspace imports inside runtime/.
  const runtimeFiles = await listSourceFiles(root, RUNTIME_RELATIVE_ROOT);
  for (const file of runtimeFiles) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = toPosixPath(path.relative(root, file));
    for (const specifier of extractImportSpecifiers(sourceText)) {
      violations.push(...validateRuntimeModule({ relativeFile, specifier }));
    }
  }

  // Rule 3: core source OUTSIDE runtime/ must not import from runtime/.
  const allCoreFiles = await listSourceFiles(root, CORE_SRC_ROOT);
  for (const file of allCoreFiles) {
    const relativeFile = toPosixPath(path.relative(root, file));
    if (relativeFile.startsWith("packages/core/src/runtime/")) continue;

    const sourceText = await readFile(file, "utf8");
    for (const specifier of extractImportSpecifiers(sourceText)) {
      violations.push(...validateOutsideRuntime({ relativeFile, specifier }));
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    runtimeFilesScanned: runtimeFiles.length,
    coreFilesScanned: allCoreFiles.length
  };
}

async function main() {
  const result = await scanRuntimeImportBoundaries();
  if (result.ok) {
    console.log(
      `RuntimeDriver import-boundary scan passed (${result.runtimeFilesScanned} runtime files, ${result.coreFilesScanned} core files).`
    );
    return;
  }

  console.error("RuntimeDriver import-boundary scan failed:");
  for (const violation of result.violations) {
    console.error(`- ${violation.file}: ${violation.message} (${violation.specifier})`);
  }
  process.exitCode = 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
