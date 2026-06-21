import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stableProtocolJson } from "@legion/artifacts";
import { utcTimestampSchema, type UtcTimestamp } from "@legion/protocol";

export type CodexLegionSourceClassification =
  | "installer-manifest"
  | "generated-plugin-protocol"
  | "user-authored-or-customized"
  | "migrated-legacy-protocol"
  | "v9-project-state"
  | "operational-var-state";

export interface CodexLegionMigrationDryRunInput {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly runId: string;
  readonly createdAt?: UtcTimestamp | string;
}

export interface CodexLegionMigrationApplyInput {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly appliedAt?: UtcTimestamp | string;
  readonly reviewAccepted: boolean;
}

export interface CodexLegionMigrationRollbackInput {
  readonly repositoryRoot: string;
  readonly backupManifestPath: string;
}

export interface CodexLegionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly sourcePath: string;
}

export interface CodexLegionSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly classification: CodexLegionSourceClassification;
}

export interface CodexLegionInventory {
  readonly root: string;
  readonly treeHash: string;
  readonly files: readonly CodexLegionSourceFile[];
}

export interface CodexLegionManifestSummary {
  readonly path: ".legion/manifest.json";
  readonly runtime?: string;
  readonly scope?: string;
  readonly version?: string;
  readonly installSurface?: string;
}

export interface CodexLegionNativeSurface {
  readonly path: string;
  readonly source: "manifest-native-artifact" | "prompt-file" | "bridge-skill";
}

export interface CodexLegionMigrationMove {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly classification: "move-to-legacy-protocol";
  readonly rationale: string;
}

export interface CodexLegionMigrationUncertainty {
  readonly code: string;
  readonly severity: "info" | "warning" | "blocker";
  readonly message: string;
  readonly sourcePaths: readonly string[];
  readonly blocksAutomaticAcceptance: boolean;
}

export interface CodexLegionMigrationConflict {
  readonly code: string;
  readonly message: string;
  readonly sourcePaths: readonly string[];
}

export interface CodexLegionMigrationReport {
  readonly schemaVersion: "0.1.0";
  readonly kind: "codex-legion-migration-report";
  readonly runId: string;
  readonly createdAt: UtcTimestamp;
  readonly requiresReview: true;
  readonly source: CodexLegionInventory;
  readonly target: CodexLegionInventory;
  readonly manifest?: CodexLegionManifestSummary;
  readonly nativeSurfaces: readonly CodexLegionNativeSurface[];
  readonly moves: readonly CodexLegionMigrationMove[];
  readonly conflicts: readonly CodexLegionMigrationConflict[];
  readonly uncertainties: readonly CodexLegionMigrationUncertainty[];
  readonly policy: {
    readonly v8DefaultInstallUnchanged: true;
    readonly nativeCodexSurfacesUntouched: true;
    readonly v9ProjectNamespaceReserved: true;
    readonly legacyProtocolPreserved: true;
  };
}

export interface CodexLegionMigrationDryRunSuccess {
  readonly ok: true;
  readonly status: "dry_run";
  readonly report: CodexLegionMigrationReport;
  readonly stagingRoot: string;
}

export interface CodexLegionMigrationFailure {
  readonly ok: false;
  readonly status: "invalid" | "blocked" | "conflict";
  readonly diagnostics: readonly CodexLegionDiagnostic[];
}

export interface CodexLegionMigrationBackupRecord {
  readonly manifestPath: string;
  readonly backupPath: string;
  readonly preMigrationHash: string;
  readonly sourceHash: string;
}

export interface CodexLegionMigrationApplySuccess {
  readonly ok: true;
  readonly status: "applied";
  readonly backup: CodexLegionMigrationBackupRecord;
  readonly installedFiles: readonly string[];
  readonly policy: CodexLegionMigrationReport["policy"];
}

export interface CodexLegionMigrationRollbackSuccess {
  readonly ok: true;
  readonly status: "rolled_back";
  readonly restoredHash: string;
}

export type CodexLegionMigrationDryRunResult =
  | CodexLegionMigrationDryRunSuccess
  | CodexLegionMigrationFailure;
export type CodexLegionMigrationApplyResult =
  | CodexLegionMigrationApplySuccess
  | CodexLegionMigrationFailure;
export type CodexLegionMigrationRollbackResult =
  | CodexLegionMigrationRollbackSuccess
  | CodexLegionMigrationFailure;

interface ParsedCodexManifest {
  readonly summary?: CodexLegionManifestSummary;
  readonly generatedPaths: ReadonlySet<string>;
  readonly nativeSurfaces: readonly CodexLegionNativeSurface[];
  readonly uncertainty?: CodexLegionMigrationUncertainty;
}

interface BackupManifest {
  readonly schemaVersion: "0.1.0";
  readonly kind: "codex-legion-migration-backup";
  readonly createdAt: UtcTimestamp;
  readonly repositoryRoot: string;
  readonly backupPath: string;
  readonly preMigrationHash: string;
  readonly sourceHash: string;
  readonly existingLegionRoot: boolean;
}

const REPORT_PATH = ".legion/migration/codex-legion-migration-report.json";
const LEGACY_PROTOCOL_ROOT = ".legion/legacy-protocol";
const LEGION_ROOT = ".legion";
const EMPTY_TREE_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function failure(
  status: CodexLegionMigrationFailure["status"],
  diagnostics: readonly CodexLegionDiagnostic[]
): CodexLegionMigrationFailure {
  return { ok: false, status, diagnostics };
}

function diagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly sourcePath?: string;
}): CodexLegionDiagnostic {
  return {
    code: input.code,
    message: input.message,
    sourcePath: input.sourcePath ?? LEGION_ROOT
  };
}

function bytesHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }

    for (const entry of [...entries].sort((left, right) => compareStrings(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile()) files.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }

  await visit(root);
  return files.sort(compareStrings);
}

async function hashFiles(root: string, files: readonly string[]): Promise<string> {
  if (files.length === 0) return EMPTY_TREE_HASH;

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(root, ...file.split("/"))));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashTree(root: string): Promise<string> {
  return hashFiles(root, await listFiles(root));
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function safeResolvedStagingRoot(input: {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
}): string | CodexLegionMigrationFailure {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const stagingRoot = path.resolve(input.stagingRoot);
  const legacyRoot = path.join(repositoryRoot, ".legion");

  if (pathsOverlap(stagingRoot, repositoryRoot) || pathsOverlap(stagingRoot, legacyRoot)) {
    return failure("invalid", [
      diagnostic({
        code: "unsafe_staging_root",
        message: "Staging root must not overlap the repository root or .legion source.",
        sourcePath: input.stagingRoot
      })
    ]);
  }

  return stagingRoot;
}

function parseUtcTimestamp(input: {
  readonly value: UtcTimestamp | string | undefined;
  readonly code: string;
  readonly sourcePath: string;
}): UtcTimestamp | CodexLegionMigrationFailure {
  const value = input.value ?? new Date().toISOString();
  try {
    return utcTimestampSchema.parse(value);
  } catch (error) {
    return failure("invalid", [
      diagnostic({
        code: input.code,
        message: error instanceof Error ? error.message : "Value is not a valid UTC timestamp.",
        sourcePath: input.sourcePath
      })
    ]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeReportedPath(repositoryRoot: string, value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (path.isAbsolute(value)) {
    const relative = path.relative(repositoryRoot, value);
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return toPosixPath(relative);
    }
  }
  return normalized.replace(/^\.\//, "");
}

function collectManagedPath(input: {
  readonly repositoryRoot: string;
  readonly value: unknown;
  readonly generatedPaths: Set<string>;
}): void {
  const parsed = readString(input.value);
  if (parsed === undefined) return;
  const normalized = normalizeReportedPath(input.repositoryRoot, parsed);
  if (normalized === ".legion/manifest.json" || normalized.startsWith(".legion/")) {
    input.generatedPaths.add(normalized);
  }
}

function nativeSurface(input: {
  readonly repositoryRoot: string;
  readonly value: unknown;
  readonly source: CodexLegionNativeSurface["source"];
}): CodexLegionNativeSurface | undefined {
  const parsed = readString(input.value);
  if (parsed === undefined) return undefined;
  const normalized = normalizeReportedPath(input.repositoryRoot, parsed);
  if (normalized.startsWith(".legion/")) return undefined;
  return { path: normalized, source: input.source };
}

async function parseCodexManifest(repositoryRoot: string, legionRoot: string): Promise<ParsedCodexManifest> {
  const manifestPath = path.join(legionRoot, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isEnoent(error)) {
      return {
        generatedPaths: new Set<string>(),
        nativeSurfaces: [],
        uncertainty: {
          code: "missing_codex_manifest",
          severity: "warning",
          message: "Legacy .legion has no installer manifest, so all files are treated as user-authored or customized data.",
          sourcePaths: [LEGION_ROOT],
          blocksAutomaticAcceptance: false
        }
      };
    }
    return {
      generatedPaths: new Set<string>(),
      nativeSurfaces: [],
      uncertainty: {
        code: "unreadable_codex_manifest",
        severity: "blocker",
        message: error instanceof Error ? error.message : "Legacy installer manifest could not be read.",
        sourcePaths: [".legion/manifest.json"],
        blocksAutomaticAcceptance: true
      }
    };
  }

  if (!isRecord(parsed)) {
    return {
      generatedPaths: new Set<string>(),
      nativeSurfaces: [],
      uncertainty: {
        code: "invalid_codex_manifest",
        severity: "blocker",
        message: "Legacy installer manifest is not a JSON object.",
        sourcePaths: [".legion/manifest.json"],
        blocksAutomaticAcceptance: true
      }
    };
  }

  const generatedPaths = new Set<string>([".legion/manifest.json"]);
  const pathsValue = isRecord(parsed["paths"]) ? parsed["paths"] : {};
  for (const key of ["agents", "commands", "skills", "adapters", "manifest"] as const) {
    collectManagedPath({
      repositoryRoot,
      value: pathsValue[key],
      generatedPaths
    });
  }

  const nativeSurfaces: CodexLegionNativeSurface[] = [];
  const promptSurface = nativeSurface({
    repositoryRoot,
    value: pathsValue["prompts"],
    source: "prompt-file"
  });
  const bridgeSurface = nativeSurface({
    repositoryRoot,
    value: pathsValue["bridgeSkill"],
    source: "bridge-skill"
  });
  if (promptSurface !== undefined) nativeSurfaces.push(promptSurface);
  if (bridgeSurface !== undefined) nativeSurfaces.push(bridgeSurface);

  if (Array.isArray(parsed["nativeArtifacts"])) {
    for (const artifact of parsed["nativeArtifacts"]) {
      if (!isRecord(artifact)) continue;
      const surface = nativeSurface({
        repositoryRoot,
        value: artifact["path"],
        source: "manifest-native-artifact"
      });
      if (surface !== undefined) nativeSurfaces.push(surface);
    }
  }

  if (Array.isArray(parsed["promptFiles"])) {
    const promptsRoot = readString(pathsValue["prompts"]);
    if (promptsRoot !== undefined) {
      const normalizedRoot = normalizeReportedPath(repositoryRoot, promptsRoot).replace(/\/+$/g, "");
      for (const promptFile of parsed["promptFiles"]) {
        if (typeof promptFile !== "string") continue;
        nativeSurfaces.push({
          path: `${normalizedRoot}/${promptFile}`,
          source: "prompt-file"
        });
      }
    }
  }

  const runtime = readString(parsed["runtime"]);
  const scope = readString(parsed["scope"]);
  const version = readString(parsed["version"]);
  const installSurface = readString(parsed["installSurface"]);
  const summary: CodexLegionManifestSummary = {
    path: ".legion/manifest.json",
    ...(runtime === undefined ? {} : { runtime }),
    ...(scope === undefined ? {} : { scope }),
    ...(version === undefined ? {} : { version }),
    ...(installSurface === undefined ? {} : { installSurface })
  };

  const uncertainty = summary.runtime === "codex" ? undefined : {
    code: "non_codex_manifest",
    severity: "warning" as const,
    message: "Legacy installer manifest does not identify a Codex install; files are still preserved under legacy protocol.",
    sourcePaths: [".legion/manifest.json"],
    blocksAutomaticAcceptance: false
  };

  return {
    summary,
    generatedPaths,
    nativeSurfaces: uniqueNativeSurfaces(nativeSurfaces),
    ...(uncertainty === undefined ? {} : { uncertainty })
  };
}

function uniqueNativeSurfaces(surfaces: readonly CodexLegionNativeSurface[]): readonly CodexLegionNativeSurface[] {
  const byPath = new Map<string, CodexLegionNativeSurface>();
  for (const surface of surfaces) {
    if (!byPath.has(surface.path)) byPath.set(surface.path, surface);
  }
  return [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function topLevelLegionEntry(legionRelativeFile: string): string {
  return legionRelativeFile.split("/")[0] ?? legionRelativeFile;
}

function shouldMoveLegacyFile(legionRelativeFile: string): boolean {
  const root = topLevelLegionEntry(legionRelativeFile);
  return root !== "project" && root !== "var" && root !== "legacy-protocol" && root !== "migration";
}

function classifySourceFile(relativePath: string, generatedPaths: ReadonlySet<string>): CodexLegionSourceClassification {
  const legionRelativeFile = relativePath.slice(".legion/".length);
  const root = topLevelLegionEntry(legionRelativeFile);
  if (relativePath === ".legion/manifest.json") return generatedPaths.size > 0 ? "installer-manifest" : "user-authored-or-customized";
  if (root === "project") return "v9-project-state";
  if (root === "var") return "operational-var-state";
  if (root === "legacy-protocol") return "migrated-legacy-protocol";

  for (const generatedPath of generatedPaths) {
    if (relativePath === generatedPath || relativePath.startsWith(`${generatedPath.replace(/\/+$/g, "")}/`)) {
      return "generated-plugin-protocol";
    }
  }

  return "user-authored-or-customized";
}

async function sourceInventory(input: {
  readonly repositoryRoot: string;
  readonly legionRoot: string;
  readonly generatedPaths: ReadonlySet<string>;
}): Promise<CodexLegionInventory> {
  const files: CodexLegionSourceFile[] = [];
  for (const file of await listFiles(input.legionRoot)) {
    const bytes = await readFile(path.join(input.legionRoot, ...file.split("/")));
    const relativePath = `.legion/${file}`;
    files.push({
      path: relativePath,
      sha256: bytesHash(bytes),
      bytes: bytes.byteLength,
      classification: classifySourceFile(relativePath, input.generatedPaths)
    });
  }

  return {
    root: LEGION_ROOT,
    treeHash: await hashTree(input.legionRoot),
    files: files.sort((left, right) => compareStrings(left.path, right.path))
  };
}

function migrationMoves(source: CodexLegionInventory): readonly CodexLegionMigrationMove[] {
  return source.files
    .filter((file) => shouldMoveLegacyFile(file.path.slice(".legion/".length)))
    .map((file) => ({
      sourcePath: file.path,
      targetPath: `${LEGACY_PROTOCOL_ROOT}/${file.path.slice(".legion/".length)}`,
      classification: "move-to-legacy-protocol" as const,
      rationale: "Preserve legacy Codex protocol bytes outside the v9 .legion/project namespace."
    }))
    .sort((left, right) => compareStrings(left.sourcePath, right.sourcePath));
}

async function stageLegacyProtocol(input: {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly moves: readonly CodexLegionMigrationMove[];
}): Promise<CodexLegionInventory> {
  const targetRoot = path.join(input.stagingRoot, ".legion", "legacy-protocol");
  await rm(input.stagingRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  for (const move of input.moves) {
    const sourcePath = path.join(input.repositoryRoot, ...move.sourcePath.split("/"));
    const targetPath = path.join(input.stagingRoot, ...move.targetPath.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
  }

  const files: CodexLegionSourceFile[] = [];
  for (const file of await listFiles(targetRoot)) {
    const bytes = await readFile(path.join(targetRoot, ...file.split("/")));
    files.push({
      path: `${LEGACY_PROTOCOL_ROOT}/${file}`,
      sha256: bytesHash(bytes),
      bytes: bytes.byteLength,
      classification: "migrated-legacy-protocol"
    });
  }

  return {
    root: LEGACY_PROTOCOL_ROOT,
    treeHash: await hashTree(targetRoot),
    files: files.sort((left, right) => compareStrings(left.path, right.path))
  };
}

async function writeReport(stagingRoot: string, report: CodexLegionMigrationReport): Promise<void> {
  const reportPath = path.join(stagingRoot, ...REPORT_PATH.split("/"));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, stableProtocolJson(report), "utf8");
}

function alreadyMigratedUncertainty(source: CodexLegionInventory, moves: readonly CodexLegionMigrationMove[]): CodexLegionMigrationUncertainty | undefined {
  if (moves.length > 0) return undefined;
  if (!source.files.some((file) => file.classification === "migrated-legacy-protocol")) return undefined;
  return {
    code: "legacy_protocol_already_migrated",
    severity: "info",
    message: "Legacy protocol bytes are already under .legion/legacy-protocol; no additional moves are needed.",
    sourcePaths: [LEGACY_PROTOCOL_ROOT],
    blocksAutomaticAcceptance: false
  };
}

export async function scanCodexLegionSource(input: {
  readonly repositoryRoot: string;
}): Promise<CodexLegionInventory | CodexLegionMigrationFailure> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (!(await pathExists(legionRoot))) {
    return failure("invalid", [
      diagnostic({
        code: "legacy_legion_root_missing",
        message: "Legacy .legion root does not exist.",
        sourcePath: LEGION_ROOT
      })
    ]);
  }
  const manifest = await parseCodexManifest(repositoryRoot, legionRoot);
  return sourceInventory({ repositoryRoot, legionRoot, generatedPaths: manifest.generatedPaths });
}

export async function createCodexLegionMigrationDryRun(
  input: CodexLegionMigrationDryRunInput
): Promise<CodexLegionMigrationDryRunResult> {
  const stagingRoot = safeResolvedStagingRoot(input);
  if (typeof stagingRoot !== "string") return stagingRoot;

  const createdAt = parseUtcTimestamp({
    value: input.createdAt,
    code: "invalid_created_at",
    sourcePath: "createdAt"
  });
  if (typeof createdAt !== "string") return createdAt;

  const repositoryRoot = path.resolve(input.repositoryRoot);
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (!(await pathExists(legionRoot))) {
    return failure("invalid", [
      diagnostic({
        code: "legacy_legion_root_missing",
        message: "Legacy .legion root does not exist.",
        sourcePath: LEGION_ROOT
      })
    ]);
  }

  const manifest = await parseCodexManifest(repositoryRoot, legionRoot);
  const source = await sourceInventory({ repositoryRoot, legionRoot, generatedPaths: manifest.generatedPaths });
  const moves = migrationMoves(source);
  const target = await stageLegacyProtocol({ repositoryRoot, stagingRoot, moves });
  const uncertainties = [
    ...(manifest.uncertainty === undefined ? [] : [manifest.uncertainty]),
    ...(alreadyMigratedUncertainty(source, moves) === undefined ? [] : [alreadyMigratedUncertainty(source, moves)])
  ].filter((entry): entry is CodexLegionMigrationUncertainty => entry !== undefined);

  const report: CodexLegionMigrationReport = {
    schemaVersion: "0.1.0",
    kind: "codex-legion-migration-report",
    runId: input.runId,
    createdAt,
    requiresReview: true,
    source,
    target,
    ...(manifest.summary === undefined ? {} : { manifest: manifest.summary }),
    nativeSurfaces: manifest.nativeSurfaces,
    moves,
    conflicts: [],
    uncertainties,
    policy: {
      v8DefaultInstallUnchanged: true,
      nativeCodexSurfacesUntouched: true,
      v9ProjectNamespaceReserved: true,
      legacyProtocolPreserved: true
    }
  };
  await writeReport(stagingRoot, report);

  return {
    ok: true,
    status: "dry_run",
    report,
    stagingRoot
  };
}

async function readReport(stagingRoot: string): Promise<CodexLegionMigrationReport | CodexLegionMigrationFailure> {
  const reportPath = path.join(stagingRoot, ...REPORT_PATH.split("/"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    return failure("invalid", [
      diagnostic({
        code: "missing_dry_run_report",
        message: error instanceof Error ? error.message : "Dry-run report could not be read.",
        sourcePath: REPORT_PATH
      })
    ]);
  }

  if (!isCodexLegionMigrationReport(parsed)) {
    return failure("invalid", [
      diagnostic({
        code: "invalid_dry_run_report",
        message: "Dry-run report is missing required Codex Legion migration fields.",
        sourcePath: REPORT_PATH
      })
    ]);
  }

  return parsed;
}

function isInventory(value: unknown): value is CodexLegionInventory {
  return isRecord(value) && typeof value["root"] === "string" && typeof value["treeHash"] === "string" && Array.isArray(value["files"]);
}

function isCodexLegionMigrationReport(value: unknown): value is CodexLegionMigrationReport {
  if (!isRecord(value)) return false;
  const policy = value["policy"];
  return (
    value["schemaVersion"] === "0.1.0" &&
    value["kind"] === "codex-legion-migration-report" &&
    typeof value["runId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    value["requiresReview"] === true &&
    isInventory(value["source"]) &&
    isInventory(value["target"]) &&
    Array.isArray(value["nativeSurfaces"]) &&
    Array.isArray(value["moves"]) &&
    Array.isArray(value["conflicts"]) &&
    Array.isArray(value["uncertainties"]) &&
    isRecord(policy) &&
    policy["v8DefaultInstallUnchanged"] === true &&
    policy["nativeCodexSurfacesUntouched"] === true &&
    policy["v9ProjectNamespaceReserved"] === true &&
    policy["legacyProtocolPreserved"] === true
  );
}

function isBackupManifest(value: unknown): value is BackupManifest {
  return (
    isRecord(value) &&
    value["schemaVersion"] === "0.1.0" &&
    value["kind"] === "codex-legion-migration-backup" &&
    typeof value["createdAt"] === "string" &&
    typeof value["repositoryRoot"] === "string" &&
    typeof value["backupPath"] === "string" &&
    typeof value["preMigrationHash"] === "string" &&
    typeof value["sourceHash"] === "string" &&
    typeof value["existingLegionRoot"] === "boolean"
  );
}

async function validateStagedTargetHash(input: {
  readonly stagingRoot: string;
  readonly report: CodexLegionMigrationReport;
}): Promise<CodexLegionMigrationFailure | undefined> {
  const targetRoot = path.join(input.stagingRoot, ".legion", "legacy-protocol");
  const actualHash = await hashTree(targetRoot);
  if (actualHash === input.report.target.treeHash) return undefined;

  return failure("invalid", [
    diagnostic({
      code: "staged_legacy_protocol_hash_mismatch",
      message: "Staged legacy protocol bytes no longer match the reviewed dry-run report.",
      sourcePath: LEGACY_PROTOCOL_ROOT
    })
  ]);
}

async function validateCurrentSourceHash(input: {
  readonly repositoryRoot: string;
  readonly report: CodexLegionMigrationReport;
}): Promise<CodexLegionMigrationFailure | undefined> {
  const currentHash = await hashTree(path.join(input.repositoryRoot, ".legion"));
  if (currentHash === input.report.source.treeHash) return undefined;

  return failure("invalid", [
    diagnostic({
      code: "source_hash_mismatch",
      message: "Current .legion bytes differ from the reviewed dry-run report.",
      sourcePath: LEGION_ROOT
    })
  ]);
}

function backupId(appliedAt: UtcTimestamp, sourceHash: string): string {
  const hash = createHash("sha256").update(`${appliedAt}\0${sourceHash}`).digest("hex").slice(0, 16);
  return `codex-legion-migration-${appliedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${hash}`;
}

async function backupLegionRoot(input: {
  readonly repositoryRoot: string;
  readonly backupRoot: string;
  readonly appliedAt: UtcTimestamp;
  readonly report: CodexLegionMigrationReport;
}): Promise<CodexLegionMigrationBackupRecord> {
  const legionRoot = path.join(input.repositoryRoot, ".legion");
  const preMigrationHash = await hashTree(legionRoot);
  const id = backupId(input.appliedAt, input.report.source.treeHash);
  const backupDirectory = path.resolve(input.backupRoot, id);
  const backupPath = path.resolve(backupDirectory, "legion");
  const existingLegionRoot = await pathExists(legionRoot);

  await rm(backupDirectory, { recursive: true, force: true });
  await mkdir(backupDirectory, { recursive: true });
  if (existingLegionRoot) {
    await cp(legionRoot, backupPath, { recursive: true });
  }

  const manifest: BackupManifest = {
    schemaVersion: "0.1.0",
    kind: "codex-legion-migration-backup",
    createdAt: input.appliedAt,
    repositoryRoot: input.repositoryRoot,
    backupPath,
    preMigrationHash,
    sourceHash: input.report.source.treeHash,
    existingLegionRoot
  };
  const manifestPath = path.resolve(backupDirectory, "backup-manifest.json");
  await writeFile(manifestPath, stableProtocolJson(manifest), "utf8");

  return {
    manifestPath,
    backupPath,
    preMigrationHash,
    sourceHash: input.report.source.treeHash
  };
}

async function installStagedLegacyProtocol(input: {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly report: CodexLegionMigrationReport;
}): Promise<void> {
  if (input.report.moves.length === 0) return;

  const legionRoot = path.join(input.repositoryRoot, ".legion");
  const destination = path.join(legionRoot, "legacy-protocol");
  if (await pathExists(destination)) {
    throw new Error(".legion/legacy-protocol already exists; rerun dry-run and review the no-op report.");
  }

  const temporary = path.join(legionRoot, `.legacy-protocol.${process.pid}.${Date.now()}.tmp`);
  await rm(temporary, { recursive: true, force: true });
  await cp(path.join(input.stagingRoot, ".legion", "legacy-protocol"), temporary, { recursive: true });
  await rename(temporary, destination);

  const roots = [...new Set(input.report.moves.map((move) => topLevelLegionEntry(move.sourcePath.slice(".legion/".length))))]
    .filter((entry) => entry.length > 0)
    .sort(compareStrings);
  for (const root of roots) {
    await rm(path.join(legionRoot, root), { recursive: true, force: true });
  }
}

async function installedLegacyProtocolFiles(repositoryRoot: string): Promise<readonly string[]> {
  const targetRoot = path.join(repositoryRoot, ".legion", "legacy-protocol");
  return (await listFiles(targetRoot)).map((file) => `${LEGACY_PROTOCOL_ROOT}/${file}`);
}

export async function applyCodexLegionMigration(
  input: CodexLegionMigrationApplyInput
): Promise<CodexLegionMigrationApplyResult> {
  const report = await readReport(input.stagingRoot);
  if ("diagnostics" in report) return report;

  if (!input.reviewAccepted) {
    return failure("blocked", [
      diagnostic({
        code: "dry_run_review_required",
        message: "Codex .legion migrations require explicit reviewed apply after the dry-run report is inspected.",
        sourcePath: REPORT_PATH
      })
    ]);
  }

  const appliedAt = parseUtcTimestamp({
    value: input.appliedAt,
    code: "invalid_applied_at",
    sourcePath: "appliedAt"
  });
  if (typeof appliedAt !== "string") return appliedAt;

  const stagedHashFailure = await validateStagedTargetHash({
    stagingRoot: input.stagingRoot,
    report
  });
  if (stagedHashFailure !== undefined) return stagedHashFailure;

  const repositoryRoot = path.resolve(input.repositoryRoot);
  const sourceHashFailure = await validateCurrentSourceHash({
    repositoryRoot,
    report
  });
  if (sourceHashFailure !== undefined) return sourceHashFailure;

  const backup = await backupLegionRoot({
    repositoryRoot,
    backupRoot: input.backupRoot,
    appliedAt,
    report
  });

  try {
    await installStagedLegacyProtocol({
      repositoryRoot,
      stagingRoot: input.stagingRoot,
      report
    });
  } catch (error) {
    try {
      await rollbackCodexLegionMigration({
        repositoryRoot,
        backupManifestPath: backup.manifestPath
      });
    } catch {
      // Preserve the original migration failure; rollback is best-effort here.
    }
    return failure("invalid", [
      diagnostic({
        code: "apply_failed",
        message: error instanceof Error ? error.message : "Codex .legion migration apply failed.",
        sourcePath: LEGACY_PROTOCOL_ROOT
      })
    ]);
  }

  return {
    ok: true,
    status: "applied",
    backup,
    installedFiles: await installedLegacyProtocolFiles(repositoryRoot),
    policy: report.policy
  };
}

export async function rollbackCodexLegionMigration(
  input: CodexLegionMigrationRollbackInput
): Promise<CodexLegionMigrationRollbackResult> {
  let manifest: BackupManifest;
  const backupManifestPath = path.resolve(input.backupManifestPath);
  try {
    const parsed = JSON.parse(await readFile(backupManifestPath, "utf8"));
    if (!isBackupManifest(parsed)) {
      throw new Error("Backup manifest is missing required Codex Legion migration fields.");
    }
    manifest = parsed;
  } catch (error) {
    return failure("invalid", [
      diagnostic({
        code: "invalid_backup_manifest",
        message: error instanceof Error ? error.message : "Backup manifest could not be read.",
        sourcePath: backupManifestPath
      })
    ]);
  }

  const repositoryRoot = path.resolve(input.repositoryRoot);
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (manifest.existingLegionRoot) {
    if (!path.isAbsolute(manifest.backupPath)) {
      return failure("invalid", [
        diagnostic({
          code: "invalid_backup_manifest",
          message: "Backup manifest backupPath must be absolute.",
          sourcePath: backupManifestPath
        })
      ]);
    }
    if (!(await pathExists(manifest.backupPath))) {
      return failure("invalid", [
        diagnostic({
          code: "invalid_backup_manifest",
          message: "Backup manifest references a missing .legion backup directory.",
          sourcePath: backupManifestPath
        })
      ]);
    }
  }

  await rm(legionRoot, { recursive: true, force: true });
  if (manifest.existingLegionRoot) {
    await cp(manifest.backupPath, legionRoot, { recursive: true });
  }

  return {
    ok: true,
    status: "rolled_back",
    restoredHash: await hashTree(legionRoot)
  };
}
