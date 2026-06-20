#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PACKAGES = [
  {
    name: "@legion/protocol",
    root: "packages/protocol",
    src: "packages/protocol/src",
    allowedWorkspaceImports: []
  },
  {
    name: "@legion/core",
    root: "packages/core",
    src: "packages/core/src",
    allowedWorkspaceImports: ["@legion/protocol"]
  },
  {
    name: "@legion/artifacts",
    root: "packages/artifacts",
    src: "packages/artifacts/src",
    allowedWorkspaceImports: ["@legion/protocol", "@legion/core"]
  }
];

const FORBIDDEN_PROVIDER_OR_STORAGE_IMPORTS = new Set([
  "eve",
  "node:sqlite",
  "better-sqlite3",
  "sqlite3"
]);

const LEGACY_PROMPT_ROOTS = [
  ".codex-plugin",
  "adapters",
  "agents",
  "commands",
  "skills"
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

async function listSourceFiles(root, packageConfig) {
  const sourceRoot = path.join(root, packageConfig.src);
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

  await visit(sourceRoot);
  return files;
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

function workspacePackageName(specifier) {
  if (!specifier.startsWith("@legion/")) return null;
  const [scope, name] = specifier.split("/");
  if (!scope || !name) return null;
  return `${scope}/${name}`;
}

function isDeepWorkspaceImport(specifier, packageName) {
  return specifier !== packageName && specifier.startsWith(`${packageName}/`);
}

function resolvesToLegacyPromptAsset(specifier, relativeFile) {
  if (!specifier.startsWith(".")) return null;

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), specifier));
  if (resolved.startsWith("..")) return null;

  const root = LEGACY_PROMPT_ROOTS.find((legacyRoot) => {
    return resolved === legacyRoot || resolved.startsWith(`${legacyRoot}/`);
  });

  return root ? resolved : null;
}

function validateSpecifier({ specifier, packageConfig, relativeFile }) {
  const violations = [];

  if (FORBIDDEN_PROVIDER_OR_STORAGE_IMPORTS.has(specifier)) {
    violations.push({
      file: relativeFile,
      specifier,
      message: `${packageConfig.name} cannot use forbidden provider or storage import ${specifier}`
    });
  }

  const legacyPromptAsset = resolvesToLegacyPromptAsset(specifier, relativeFile);
  if (legacyPromptAsset) {
    violations.push({
      file: relativeFile,
      specifier,
      message: `${packageConfig.name} cannot import legacy prompt asset ${legacyPromptAsset}; legacy Markdown assets are package/install compatibility data only`
    });
  }

  const workspaceName = workspacePackageName(specifier);
  if (!workspaceName) return violations;

  if (workspaceName === packageConfig.name) {
    if (isDeepWorkspaceImport(specifier, workspaceName)) {
      violations.push({
        file: relativeFile,
        specifier,
        message: `${packageConfig.name} cannot use deep import ${specifier}; use the package export ${workspaceName}`
      });
    }
    return violations;
  }

  if (!packageConfig.allowedWorkspaceImports.includes(workspaceName)) {
    violations.push({
      file: relativeFile,
      specifier,
      message: `${packageConfig.name} cannot import ${workspaceName}`
    });
    return violations;
  }

  if (isDeepWorkspaceImport(specifier, workspaceName)) {
    violations.push({
      file: relativeFile,
      specifier,
      message: `${packageConfig.name} cannot use deep import ${specifier}; use the package export ${workspaceName}`
    });
  }

  return violations;
}

export async function checkPackageBoundaries(options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const packageConfigs = options.packages ?? DEFAULT_PACKAGES;
  const violations = [];

  for (const packageConfig of packageConfigs) {
    const files = await listSourceFiles(root, packageConfig);
    for (const file of files) {
      const sourceText = await readFile(file, "utf8");
      const relativeFile = toPosixPath(path.relative(root, file));
      for (const specifier of extractImportSpecifiers(sourceText)) {
        violations.push(...validateSpecifier({ specifier, packageConfig, relativeFile }));
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}

async function main() {
  const result = await checkPackageBoundaries();
  if (result.ok) {
    console.log("Package boundary check passed.");
    return;
  }

  console.error("Package boundary check failed:");
  for (const violation of result.violations) {
    console.error(`- ${violation.file}: ${violation.message} (${violation.specifier})`);
  }
  process.exitCode = 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
