#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASELINE_PACK_PATH = "docs/next/evidence/P01-PREFLIGHT/v8-npm-pack-dry-run.json";
export const DEFAULT_CHECKSUM_PATH = "checksums.sha256";

export const LEGACY_CHECKSUM_PREFIXES = Object.freeze([
  ".codex-plugin/",
  "adapters/",
  "agents/",
  "commands/",
  "skills/"
]);

export const ROOT_ROUTER_PACKAGE_PATHS = Object.freeze([
  "bin/legion.js",
  "dist/legion-cli.mjs",
  "dist/legion-cli.mjs.map"
]);

export const CLI_RUNTIME_PACKAGE_FILES = Object.freeze([
  "evals/baseline/corpus-manifest.yaml",
  "evals/baseline/fixture-hashes.sha256",
  "evals/baseline/manifest.yaml",
  "scripts/dogfood-workflow.mjs"
]);

export const CLI_RUNTIME_PACKAGE_PREFIXES = Object.freeze([
  "evals/baseline/scenarios/",
  "evals/baseline/schema/",
  "evals/fixtures/public/",
  "docs/cli/",
  "scripts/baseline/",
  "scripts/release/"
]);

export const LEGACY_CHECKSUM_FILES = Object.freeze([
  "bin/install.js",
  "bin/runtime-metadata.js",
  ...ROOT_ROUTER_PACKAGE_PATHS,
  ...CLI_RUNTIME_PACKAGE_FILES,
  "docs/control-modes.md",
  "docs/runtime-audit.md",
  "docs/runtime-certification-checklists.md",
  "docs/security/install-integrity.md",
  "docs/settings.schema.json",
  "settings.json"
]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function sortPaths(paths) {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function uniqueSorted(paths) {
  return sortPaths([...new Set(paths)]);
}

function isProtectedChecksumPath(filePath, prefixes = LEGACY_CHECKSUM_PREFIXES, files = LEGACY_CHECKSUM_FILES) {
  return prefixes.some((prefix) => filePath.startsWith(prefix)) || files.includes(filePath);
}

export function readNpmPackDryRun(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const pack = Array.isArray(raw) ? raw[0] : raw;
  if (!pack || !Array.isArray(pack.files)) {
    throw new TypeError(`${filePath} must be an npm pack --dry-run --json artifact.`);
  }

  return {
    name: pack.name,
    version: pack.version,
    fileCount: pack.files.length,
    files: uniqueSorted(pack.files.map((entry) => entry.path))
  };
}

export function runNpmPackDryRun(root) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const spawnError = result.error ? `\nerror:\n${result.error.message}` : "";
    throw new Error(`npm pack --dry-run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}${spawnError}`);
  }

  const raw = JSON.parse(result.stdout);
  const pack = Array.isArray(raw) ? raw[0] : raw;
  if (!pack || !Array.isArray(pack.files)) {
    throw new TypeError("npm pack --dry-run did not return a package file list.");
  }

  return {
    name: pack.name,
    version: pack.version,
    fileCount: pack.files.length,
    files: uniqueSorted(pack.files.map((entry) => entry.path)),
    raw
  };
}

export function comparePackagePathSets(input) {
  const baselinePaths = uniqueSorted(input.baselinePaths);
  const currentPaths = uniqueSorted(input.currentPaths);
  const approvedExtraPaths = new Set(input.approvedExtraPaths ?? []);
  const approvedExtraPrefixes = input.approvedExtraPrefixes ?? [];
  const currentSet = new Set(currentPaths);
  const baselineSet = new Set(baselinePaths);
  const hasApprovedPrefix = (filePath) => approvedExtraPrefixes.some((prefix) => filePath.startsWith(prefix));

  return {
    missingLegacyPaths: baselinePaths.filter((filePath) => !currentSet.has(filePath)),
    missingApprovedPackagePaths: sortPaths(input.approvedExtraPaths ?? []).filter((filePath) => !currentSet.has(filePath)),
    missingApprovedPackagePrefixes: sortPaths(approvedExtraPrefixes).filter((prefix) => !currentPaths.some((filePath) => filePath.startsWith(prefix))),
    extraPackagePaths: currentPaths.filter((filePath) => !baselineSet.has(filePath) && !approvedExtraPaths.has(filePath) && !hasApprovedPrefix(filePath)),
    workspacePackagePaths: currentPaths.filter((filePath) => filePath.startsWith("packages/"))
  };
}

export function parseChecksumText(text) {
  const checksums = new Map();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    if (!match) {
      throw new TypeError(`Invalid checksum line: ${line}`);
    }

    checksums.set(match[2], match[1]);
  }

  return checksums;
}

export function readChecksumFile(filePath) {
  return parseChecksumText(readFileSync(filePath, "utf8"));
}

function sha256FileNormalized(filePath) {
  const data = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(Buffer.from(data, "utf8")).digest("hex");
}

export function computeChecksumMap(root, paths) {
  const checksums = new Map();

  for (const filePath of uniqueSorted(paths)) {
    const absolutePath = path.join(root, filePath);
    if (!existsSync(absolutePath)) continue;
    checksums.set(filePath, sha256FileNormalized(absolutePath));
  }

  return checksums;
}

export function formatChecksumMap(checksums) {
  return sortPaths(checksums.keys()).map((filePath) => `${checksums.get(filePath)}  ${filePath}`).join("\n") + "\n";
}

export function writeChecksumFile(root, paths, checksumPath = DEFAULT_CHECKSUM_PATH) {
  const checksums = computeChecksumMap(root, paths.filter((filePath) => filePath !== checksumPath));
  const outputPath = path.join(root, checksumPath);
  writeFileSync(outputPath, formatChecksumMap(checksums), "utf8");
  return outputPath;
}

export function compareChecksumMaps(input) {
  const protectedPrefixes = input.protectedPrefixes ?? LEGACY_CHECKSUM_PREFIXES;
  const protectedFiles = input.protectedFiles ?? LEGACY_CHECKSUM_FILES;
  const protectedPaths = sortPaths(input.baselineChecksums.keys()).filter((filePath) =>
    isProtectedChecksumPath(filePath, protectedPrefixes, protectedFiles)
  );

  return {
    missingChecksumPaths: protectedPaths.filter((filePath) => !input.currentChecksums.has(filePath)),
    legacyChecksumMismatches: protectedPaths.filter((filePath) => {
      if (!input.currentChecksums.has(filePath)) return false;
      return input.currentChecksums.get(filePath) !== input.baselineChecksums.get(filePath);
    })
  };
}

export function compareInstallerMatrix(input) {
  const missingInstallerPaths = [];
  const changedInstallerPaths = [];

  for (const [key, expected] of input.expected.entries()) {
    if (!input.actual.has(key)) {
      missingInstallerPaths.push(key);
      continue;
    }

    const actual = input.actual.get(key);
    if (actual !== expected) {
      changedInstallerPaths.push({ key, expected, actual });
    }
  }

  return { missingInstallerPaths, changedInstallerPaths };
}

export async function checkLegacyPackageContents(input = {}) {
  const root = input.root ?? process.cwd();
  const baselinePackPath = input.baselinePackPath ?? path.join(root, DEFAULT_BASELINE_PACK_PATH);
  const checksumPath = input.baselineChecksumPath ?? path.join(root, DEFAULT_CHECKSUM_PATH);
  const baseline = readNpmPackDryRun(baselinePackPath);
  const current = input.currentPack ?? runNpmPackDryRun(root);
  const packageComparison = comparePackagePathSets({
    baselinePaths: baseline.files,
    currentPaths: current.files,
    approvedExtraPaths: [
      ...ROOT_ROUTER_PACKAGE_PATHS,
      ...CLI_RUNTIME_PACKAGE_FILES
    ],
    approvedExtraPrefixes: CLI_RUNTIME_PACKAGE_PREFIXES
  });
  const baselineChecksums = readChecksumFile(checksumPath);
  const currentChecksums = computeChecksumMap(root, current.files.filter((filePath) => filePath !== DEFAULT_CHECKSUM_PATH));
  const checksumComparison = compareChecksumMaps({
    baselineChecksums,
    currentChecksums
  });
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  return {
    ok:
      packageComparison.missingLegacyPaths.length === 0 &&
      packageComparison.missingApprovedPackagePaths.length === 0 &&
      packageComparison.missingApprovedPackagePrefixes.length === 0 &&
      packageComparison.extraPackagePaths.length === 0 &&
      packageComparison.workspacePackagePaths.length === 0 &&
      checksumComparison.missingChecksumPaths.length === 0 &&
      checksumComparison.legacyChecksumMismatches.length === 0 &&
      packageJson.bin?.legion === "bin/legion.js",
    baselinePackage: {
      name: baseline.name,
      version: baseline.version,
      fileCount: baseline.fileCount
    },
    currentPackage: {
      name: current.name,
      version: current.version,
      fileCount: current.fileCount
    },
    bin: packageJson.bin ?? {},
    ...packageComparison,
    ...checksumComparison
  };
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    baselinePackPath: null,
    baselineChecksumPath: null,
    writeChecksums: false,
    out: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = path.resolve(argv[++index]);
    else if (arg === "--baseline-pack") options.baselinePackPath = path.resolve(argv[++index]);
    else if (arg === "--baseline-checksums") options.baselineChecksumPath = path.resolve(argv[++index]);
    else if (arg === "--write-checksums") options.writeChecksums = true;
    else if (arg === "--out") options.out = path.resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-package-contents.mjs [options]

Options:
  --root <path>                 Repository root. Defaults to cwd.
  --baseline-pack <path>        Frozen v8 npm pack --dry-run JSON artifact.
  --baseline-checksums <path>   Checksum manifest to compare against. Defaults to checksums.sha256.
  --write-checksums             Regenerate checksums.sha256 from the current npm pack file set.
  --out <path>                  Write JSON report to this path.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const root = options.root;
  const current = runNpmPackDryRun(root);
  if (options.writeChecksums) {
    writeChecksumFile(root, current.files);
  }

  const report = await checkLegacyPackageContents({
    root,
    baselinePackPath: options.baselinePackPath ?? path.join(root, DEFAULT_BASELINE_PACK_PATH),
    baselineChecksumPath: options.baselineChecksumPath ?? path.join(root, DEFAULT_CHECKSUM_PATH),
    currentPack: current
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (options.out) {
    writeFileSync(options.out, json, "utf8");
  } else {
    process.stdout.write(json);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
