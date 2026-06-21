import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PROJECT_ARTIFACT_PATHS,
  createCurrentSpec,
  initProject,
  stableProtocolJson
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  requirementIdSchema,
  utcTimestampSchema,
  type Actor,
  type ArtifactPath,
  type Requirement,
  type RequirementId,
  type UtcTimestamp
} from "@legion/protocol";
import { parse as parseYaml } from "yaml";

export type PlanningSourceClassification =
  | "project"
  | "requirements"
  | "roadmap"
  | "state"
  | "phase-plan"
  | "phase-summary"
  | "phase-context"
  | "config"
  | "template"
  | "research"
  | "archive"
  | "unsupported";

export type PlanningMappingClassification =
  | "direct"
  | "derived"
  | "uncertain-narrative"
  | "operational-only"
  | "unsupported";

export interface PlanningImportProjectInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly decisionOwners: readonly Actor[];
  readonly createdAt?: UtcTimestamp | string;
}

export interface PlanningImportDryRunInput {
  readonly repositoryRoot: string;
  readonly planningRoot: string;
  readonly stagingRoot: string;
  readonly runId: string;
  readonly project: PlanningImportProjectInput;
}

export interface PlanningImportApplyInput {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly appliedAt?: UtcTimestamp | string;
  readonly reviewAccepted: boolean;
  readonly allowReplaceExistingProject?: boolean;
}

export interface PlanningImportRollbackInput {
  readonly repositoryRoot: string;
  readonly backupManifestPath: string;
}

export interface PlanningDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly sourcePath: string;
}

export interface PlanningSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly classification: PlanningSourceClassification;
}

export interface PlanningSourceInventory {
  readonly root: string;
  readonly treeHash: string;
  readonly files: readonly PlanningSourceFile[];
}

export interface PlanningImportMapping {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly classification: PlanningMappingClassification;
  readonly rationale: string;
}

export interface PlanningImportConflict {
  readonly code: string;
  readonly message: string;
  readonly sourcePaths: readonly string[];
}

export interface PlanningImportUncertainty {
  readonly code: string;
  readonly severity: "info" | "warning" | "blocker";
  readonly message: string;
  readonly sourcePaths: readonly string[];
  readonly blocksAutomaticAcceptance: boolean;
}

export interface PlanningImportReport {
  readonly schemaVersion: "0.1.0";
  readonly kind: "planning-import-report";
  readonly runId: string;
  readonly createdAt: UtcTimestamp;
  readonly requiresReview: true;
  readonly source: PlanningSourceInventory;
  readonly target: {
    readonly root: string;
    readonly treeHash: string;
    readonly files: readonly PlanningSourceFile[];
  };
  readonly mappings: readonly PlanningImportMapping[];
  readonly conflicts: readonly PlanningImportConflict[];
  readonly uncertainties: readonly PlanningImportUncertainty[];
  readonly policy: {
    readonly planningReadOnlyAfterApply: true;
    readonly legacySourceDeleted: false;
    readonly mutableStateImportedAsCurrentTruth: false;
  };
}

export interface PlanningImportDryRunSuccess {
  readonly ok: true;
  readonly status: "dry_run";
  readonly report: PlanningImportReport;
  readonly stagingRoot: string;
}

export interface PlanningImportFailure {
  readonly ok: false;
  readonly status: "invalid" | "blocked" | "conflict";
  readonly diagnostics: readonly PlanningDiagnostic[];
}

export interface PlanningImportBackupRecord {
  readonly manifestPath: string;
  readonly backupPath: string;
  readonly preImportHash: string;
  readonly sourceHash: string;
}

export interface PlanningImportApplySuccess {
  readonly ok: true;
  readonly status: "applied";
  readonly backup: PlanningImportBackupRecord;
  readonly installedFiles: readonly string[];
  readonly policy: PlanningImportReport["policy"];
}

export interface PlanningImportRollbackSuccess {
  readonly ok: true;
  readonly status: "rolled_back";
  readonly restoredHash: string;
}

export type PlanningImportDryRunResult = PlanningImportDryRunSuccess | PlanningImportFailure;
export type PlanningImportApplyResult = PlanningImportApplySuccess | PlanningImportFailure;
export type PlanningImportRollbackResult = PlanningImportRollbackSuccess | PlanningImportFailure;

interface LegacyRequirement {
  readonly code: string;
  readonly id: RequirementId;
  readonly sourcePath: string;
  readonly statement: string;
  readonly checked: boolean;
}

interface ParsedPlan {
  readonly sourcePath: string;
  readonly filesModified: readonly string[];
}

interface BackupManifest {
  readonly schemaVersion: "0.1.0";
  readonly kind: "planning-import-backup";
  readonly createdAt: UtcTimestamp;
  readonly backupPath: string;
  readonly repositoryRoot: string;
  readonly preImportHash: string;
  readonly sourceHash: string;
  readonly existingLegionRoot: boolean;
}

const REPORT_PATH = ".legion/project/migration/planning-import-report.json";
const EMPTY_TREE_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function failure(status: PlanningImportFailure["status"], diagnostics: readonly PlanningDiagnostic[]): PlanningImportFailure {
  return { ok: false, status, diagnostics };
}

function diagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly sourcePath?: string;
}): PlanningDiagnostic {
  return {
    code: input.code,
    message: input.message,
    sourcePath: input.sourcePath ?? ".planning"
  };
}

function bytesHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashFiles(root: string, files: readonly string[]): Promise<string> {
  if (files.length === 0) return Promise.resolve(EMPTY_TREE_HASH);

  const hash = createHash("sha256");
  return (async () => {
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(await readFile(path.join(root, ...file.split("/"))));
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  })();
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
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

async function hashTree(root: string): Promise<string> {
  return hashFiles(root, await listFiles(root));
}

async function hashTreeExcluding(root: string, excludedFiles: readonly string[]): Promise<string> {
  const excluded = new Set(excludedFiles);
  return hashFiles(root, (await listFiles(root)).filter((file) => !excluded.has(file)));
}

function classifyPlanningFile(relativePath: string): PlanningSourceClassification {
  if (relativePath === ".planning/PROJECT.md") return "project";
  if (relativePath === ".planning/REQUIREMENTS.md") return "requirements";
  if (relativePath === ".planning/ROADMAP.md") return "roadmap";
  if (relativePath === ".planning/STATE.md") return "state";
  if (/^\.planning\/phases\/.+\/\d{2}-\d{2}-PLAN\.md$/.test(relativePath)) return "phase-plan";
  if (/^\.planning\/phases\/.+\/\d{2}-\d{2}-SUMMARY\.md$/.test(relativePath)) return "phase-summary";
  if (/^\.planning\/phases\/.+\/\d{2}-CONTEXT\.md$/.test(relativePath)) return "phase-context";
  if (relativePath.startsWith(".planning/config/") || relativePath === ".planning/config.json") return "config";
  if (relativePath.startsWith(".planning/templates/")) return "template";
  if (relativePath.startsWith(".planning/research/")) return "research";
  if (relativePath.startsWith(".planning/archive/")) return "archive";
  return "unsupported";
}

async function sourceInventory(planningRoot: string): Promise<PlanningSourceInventory | PlanningImportFailure> {
  if (!(await pathExists(planningRoot))) {
    return failure("invalid", [
      diagnostic({
        code: "planning_root_missing",
        message: "Legacy .planning root does not exist.",
        sourcePath: ".planning"
      })
    ]);
  }

  const files: PlanningSourceFile[] = [];
  for (const file of await listFiles(planningRoot)) {
    const absolutePath = path.join(planningRoot, ...file.split("/"));
    const bytes = await readFile(absolutePath);
    const relativePath = toPosixPath(path.join(".planning", file));
    files.push({
      path: relativePath,
      sha256: bytesHash(bytes),
      bytes: bytes.byteLength,
      classification: classifyPlanningFile(relativePath)
    });
  }

  return {
    root: planningRoot,
    treeHash: await hashTree(planningRoot),
    files
  };
}

function requirementSuffix(code: string): string {
  const normalized = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length >= 3 ? normalized.slice(0, 63).replace(/-+$/g, "") : `legacy-${normalized}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + ".";
}

function extractRequirements(projectMarkdown: string): readonly LegacyRequirement[] | PlanningImportFailure {
  const requirements: LegacyRequirement[] = [];
  const seen = new Set<string>();
  const pattern = /^-\s+\[([ xX])\]\s+([A-Za-z][A-Za-z0-9_-]{1,31}):\s+(.+?)\s*$/gm;

  for (const match of projectMarkdown.matchAll(pattern)) {
    const code = match[2];
    const statement = match[3];
    if (code === undefined || statement === undefined) continue;
    const suffix = requirementSuffix(code);
    const id = requirementIdSchema.safeParse(`req_${suffix}`);
    if (!id.success) {
      return failure("invalid", [
        diagnostic({
          code: "invalid_requirement_id",
          message: `Legacy requirement code ${code} cannot be converted to a v9 requirement ID.`,
          sourcePath: ".planning/PROJECT.md"
        })
      ]);
    }
    if (seen.has(id.data)) continue;
    seen.add(id.data);
    requirements.push({
      code,
      id: id.data,
      sourcePath: ".planning/PROJECT.md",
      statement: truncate(statement.trim(), 2_048),
      checked: match[1]?.toLowerCase() === "x"
    });
  }

  return requirements.sort((left, right) => compareStrings(left.id, right.id));
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parsePlanFrontmatter(content: string): Record<string, unknown> | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex < 0) return undefined;
  try {
    return readObject(parseYaml(normalized.slice(4, closeIndex)));
  } catch {
    return undefined;
  }
}

function summaryFilesModified(content: string): readonly string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^## Files Modified\s*$(?<body>.*?)(?=^## |$(?![\s\S]))/ms.exec(normalized);
  const body = match?.groups?.["body"];
  if (body === undefined) return [];

  return [...body.matchAll(/^-\s+`?([^`\n]+?)`?\s*$/gm)]
    .map((entry) => entry[1]?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .sort(compareStrings);
}

async function readUtf8IfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function parsePlans(planningRoot: string, inventory: PlanningSourceInventory): Promise<readonly ParsedPlan[]> {
  const plans: ParsedPlan[] = [];
  for (const file of inventory.files) {
    if (file.classification !== "phase-plan") continue;
    const relativeToPlanning = file.path.slice(".planning/".length);
    const content = await readFile(path.join(planningRoot, ...relativeToPlanning.split("/")), "utf8");
    const frontmatter = parsePlanFrontmatter(content);
    plans.push({
      sourcePath: file.path,
      filesModified: [...readStringArray(frontmatter?.["files_modified"])].sort(compareStrings)
    });
  }
  return plans;
}

async function planSummaryConflicts(planningRoot: string, plans: readonly ParsedPlan[]): Promise<readonly PlanningImportConflict[]> {
  const conflicts: PlanningImportConflict[] = [];

  for (const plan of plans) {
    const summaryPath = plan.sourcePath.replace(/-PLAN\.md$/, "-SUMMARY.md");
    const summaryContent = await readUtf8IfExists(path.join(planningRoot, ...summaryPath.slice(".planning/".length).split("/")));
    if (summaryContent === undefined) continue;

    const summaryFiles = summaryFilesModified(summaryContent);
    if (plan.filesModified.length === 0 || summaryFiles.length === 0) continue;

    const planJoined = plan.filesModified.join("\n");
    const summaryJoined = summaryFiles.join("\n");
    if (planJoined !== summaryJoined) {
      conflicts.push({
        code: "plan_summary_mismatch",
        message: `Plan ${plan.sourcePath} declares modified files that differ from ${summaryPath}.`,
        sourcePaths: [plan.sourcePath, summaryPath]
      });
    }
  }

  return conflicts;
}

async function stateUncertainties(planningRoot: string): Promise<readonly PlanningImportUncertainty[]> {
  const state = await readUtf8IfExists(path.join(planningRoot, "STATE.md"));
  if (state === undefined) return [];

  const uncertainties: PlanningImportUncertainty[] = [
    {
      code: "operational_state_not_authoritative",
      severity: "info",
      message: "Legacy STATE.md is imported as source context only; mutable execution state is not accepted as current truth.",
      sourcePaths: [".planning/STATE.md"],
      blocksAutomaticAcceptance: false
    }
  ];

  if (/stale notice|outdated|package metadata is authoritative/i.test(state)) {
    uncertainties.push({
      code: "stale_operational_state",
      severity: "blocker",
      message: "Legacy STATE.md declares itself stale or superseded, so automatic acceptance is blocked until review.",
      sourcePaths: [".planning/STATE.md"],
      blocksAutomaticAcceptance: true
    });
  }

  return uncertainties;
}

function sourceReference(pathValue: ArtifactPath, requirementId: RequirementId) {
  return {
    path: pathValue,
    anchor: requirementId,
    relation: "defines" as const,
    entity: {
      kind: "requirement" as const,
      id: requirementId
    }
  };
}

function requirementDocument(input: {
  readonly requirement: LegacyRequirement;
  readonly projectId: string;
  readonly artifactPath: ArtifactPath;
  readonly createdAt: UtcTimestamp;
}): Requirement {
  const category = input.requirement.code.toLowerCase().startsWith("mig") ? "migration" : "behavior";

  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.createdAt,
    provenance: {
      actor: { kind: "system", id: "system:planning-importer", displayName: "Planning Importer" },
      createdAt: input.createdAt,
      source: "migration",
      schemaVersion: LEGION_PROTOCOL_VERSION
    },
    kind: "requirement",
    id: input.requirement.id,
    projectId: input.projectId,
    priority: "must",
    category,
    status: "accepted",
    statement: input.requirement.statement,
    acceptance: {
      language: "Imported from legacy .planning requirements for human review before apply.",
      criteria: [truncate(input.requirement.statement, 1_024)],
      oracleRefs: []
    },
    traceRefs: [sourceReference(input.artifactPath, input.requirement.id)],
    supersedes: []
  } satisfies Requirement;
}

function sectionsForRequirement(requirement: LegacyRequirement) {
  return {
    purpose: `Preserve and review legacy requirement ${requirement.code} from .planning/PROJECT.md.`,
    behaviors: requirement.statement,
    constraints: "The legacy .planning source remains read-only; mutable execution state is not imported as truth.",
    scenarios: "During migration review, the user can inspect this requirement against the source report before applying.",
    interfaces: "The requirement is represented as a v9 current-spec artifact with a stable trace anchor.",
    compatibility: "The import keeps source references in the migration report so later phases can reconcile legacy context.",
    failureModes: "If the source is stale, contradictory, or missing required mappings, the report blocks automatic acceptance.",
    traceIds: [requirement.id]
  };
}

async function writeReport(stagingRoot: string, report: PlanningImportReport): Promise<void> {
  const reportPath = path.join(stagingRoot, ...REPORT_PATH.split("/"));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, stableProtocolJson(report), "utf8");
}

async function targetInventory(stagingRoot: string): Promise<PlanningImportReport["target"]> {
  const projectRoot = path.join(stagingRoot, ".legion", "project");
  const files: PlanningSourceFile[] = [];
  for (const file of await listFiles(projectRoot)) {
    if (file === "migration/planning-import-report.json") continue;
    const bytes = await readFile(path.join(projectRoot, ...file.split("/")));
    const relativePath = toPosixPath(path.join(".legion/project", file));
    files.push({
      path: relativePath,
      sha256: bytesHash(bytes),
      bytes: bytes.byteLength,
      classification: "unsupported"
    });
  }

  return {
    root: ".legion/project",
    treeHash: await hashTreeExcluding(projectRoot, ["migration/planning-import-report.json"]),
    files: files.sort((left, right) => compareStrings(left.path, right.path))
  };
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

async function resolveExistingPathComponents(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const suffix: string[] = [];
  let candidate = resolved;

  while (!(await pathExists(candidate))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(candidate, ...suffix);
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }

  return path.resolve(await realpath(candidate), ...suffix);
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === "win32") return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function safeResolvedStagingRoot(input: PlanningImportDryRunInput): string | PlanningImportFailure {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const planningRoot = path.resolve(input.planningRoot);
  const stagingRoot = path.resolve(input.stagingRoot);

  if (pathsOverlap(stagingRoot, repositoryRoot) || pathsOverlap(stagingRoot, planningRoot)) {
    return failure("invalid", [
      diagnostic({
        code: "unsafe_staging_root",
        message: "Staging root must not overlap the repository root or .planning source."
      })
    ]);
  }

  return stagingRoot;
}

async function safeResolvedBackupRoot(input: {
  readonly repositoryRoot: string;
  readonly planningRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
}): Promise<string | PlanningImportFailure> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const backupRoot = path.resolve(input.backupRoot);
  const legionRoot = path.join(repositoryRoot, ".legion");
  const planningRoot = path.resolve(input.planningRoot);
  const stagingRoot = path.resolve(input.stagingRoot);
  const realRepositoryRoot = await resolveExistingPathComponents(repositoryRoot);
  const realBackupRoot = await resolveExistingPathComponents(backupRoot);
  const realLegionRoot = await resolveExistingPathComponents(legionRoot);
  const realPlanningRoot = await resolveExistingPathComponents(planningRoot);
  const realStagingRoot = await resolveExistingPathComponents(stagingRoot);

  if (
    pathsOverlap(backupRoot, repositoryRoot) ||
    pathsOverlap(backupRoot, legionRoot) ||
    pathsOverlap(backupRoot, planningRoot) ||
    pathsOverlap(backupRoot, stagingRoot) ||
    pathsOverlap(realBackupRoot, realRepositoryRoot) ||
    pathsOverlap(realBackupRoot, realLegionRoot) ||
    pathsOverlap(realBackupRoot, realPlanningRoot) ||
    pathsOverlap(realBackupRoot, realStagingRoot)
  ) {
    return failure("invalid", [
      diagnostic({
        code: "unsafe_backup_root",
        message: "Backup root must not overlap the repository root, .legion source, planning source, or staging root.",
        sourcePath: input.backupRoot
      })
    ]);
  }

  return realBackupRoot;
}

function parseUtcTimestamp(input: {
  readonly value: UtcTimestamp | string | undefined;
  readonly code: string;
  readonly sourcePath: string;
}): UtcTimestamp | PlanningImportFailure {
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

export async function scanPlanningSource(input: {
  readonly planningRoot: string;
}): Promise<PlanningSourceInventory | PlanningImportFailure> {
  return sourceInventory(input.planningRoot);
}

export async function createPlanningImportDryRun(input: PlanningImportDryRunInput): Promise<PlanningImportDryRunResult> {
  const stagingRoot = safeResolvedStagingRoot(input);
  if (typeof stagingRoot !== "string") return stagingRoot;
  const planningRoot = await resolveExistingPathComponents(input.planningRoot);

  const createdAt = parseUtcTimestamp({
    value: input.project.createdAt,
    code: "invalid_project_created_at",
    sourcePath: "project.createdAt"
  });
  if (typeof createdAt !== "string") return createdAt;

  const inventory = await sourceInventory(planningRoot);
  if ("diagnostics" in inventory) return inventory;

  const projectMarkdown = await readUtf8IfExists(path.join(planningRoot, "PROJECT.md"));
  if (projectMarkdown === undefined) {
    return failure("invalid", [
      diagnostic({
        code: "missing_project",
        message: "Legacy .planning/PROJECT.md is required for planning import.",
        sourcePath: ".planning/PROJECT.md"
      })
    ]);
  }

  const requirements = extractRequirements(projectMarkdown);
  if ("diagnostics" in requirements) return requirements;
  if (requirements.length === 0) {
    return failure("invalid", [
      diagnostic({
        code: "missing_requirements",
        message: "Legacy .planning/PROJECT.md does not contain importable requirement bullets.",
        sourcePath: ".planning/PROJECT.md"
      })
    ]);
  }

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const initialized = await initProject({
    repositoryRoot: stagingRoot,
    slug: input.project.slug,
    name: input.project.name,
    ...(input.project.description === undefined ? {} : { description: input.project.description }),
    decisionOwners: input.project.decisionOwners,
    createdAt
  });
  if (!initialized.ok) {
    return failure("invalid", initialized.diagnostics.map((entry) =>
      diagnostic({
        code: entry.code,
        message: entry.message,
        sourcePath: entry.source.path
      })
    ));
  }

  const mappings: PlanningImportMapping[] = [];
  for (const requirement of requirements) {
    const specPath = `${PROJECT_ARTIFACT_PATHS.currentSpecs}/${requirement.id}.md` as ArtifactPath;
    const document = {
      primaryRequirementId: requirement.id,
      capability: {
        id: requirementSuffix(requirement.code),
        title: truncate(`${requirement.code}: ${requirement.statement}`, 128),
        status: "active" as const
      },
      requirements: [
        requirementDocument({
          requirement,
          projectId: initialized.project.id,
          artifactPath: specPath,
          createdAt
        })
      ],
      sections: sectionsForRequirement(requirement)
    };

    const created = await createCurrentSpec({
      repositoryRoot: stagingRoot,
      document
    });
    if (!created.ok) {
      return failure("invalid", created.diagnostics.map((entry) =>
        diagnostic({
          code: entry.code,
          message: entry.message,
          sourcePath: entry.source.path
        })
      ));
    }

    mappings.push({
      sourcePath: requirement.sourcePath,
      targetPath: specPath,
      classification: "direct",
      rationale: `Legacy requirement ${requirement.code} maps to a reviewable v9 current spec.`
    });
  }

  const plans = await parsePlans(planningRoot, inventory);
  for (const plan of plans) {
    mappings.push({
      sourcePath: plan.sourcePath,
      targetPath: REPORT_PATH,
      classification: "derived",
      rationale: "Legacy phase plans are preserved as historical migration context, not imported as live queue state."
    });
  }

  const reportWithoutTarget: Omit<PlanningImportReport, "target"> = {
    schemaVersion: "0.1.0",
    kind: "planning-import-report",
    runId: input.runId,
    createdAt,
    requiresReview: true,
    source: inventory,
    mappings: mappings.sort((left, right) =>
      compareStrings(`${left.sourcePath}\0${left.targetPath}`, `${right.sourcePath}\0${right.targetPath}`)
    ),
    conflicts: await planSummaryConflicts(planningRoot, plans),
    uncertainties: await stateUncertainties(planningRoot),
    policy: {
      planningReadOnlyAfterApply: true,
      legacySourceDeleted: false,
      mutableStateImportedAsCurrentTruth: false
    }
  };
  const target = await targetInventory(stagingRoot);
  const report: PlanningImportReport = {
    ...reportWithoutTarget,
    target
  };
  await writeReport(stagingRoot, report);

  return {
    ok: true,
    status: "dry_run",
    report,
    stagingRoot
  };
}

async function readReport(stagingRoot: string): Promise<PlanningImportReport | PlanningImportFailure> {
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

  if (!isPlanningImportReport(parsed)) {
    return failure("invalid", [
      diagnostic({
        code: "invalid_dry_run_report",
        message: "Dry-run report is missing required planning import fields.",
        sourcePath: REPORT_PATH
      })
    ]);
  }

  return parsed;
}

function backupId(appliedAt: UtcTimestamp, sourceHash: string): string {
  const hash = createHash("sha256").update(`${appliedAt}\0${sourceHash}`).digest("hex").slice(0, 16);
  return `planning-import-${appliedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${hash}`;
}

async function backupLegionRoot(input: {
  readonly repositoryRoot: string;
  readonly backupRoot: string;
  readonly appliedAt: UtcTimestamp;
  readonly report: PlanningImportReport;
}): Promise<PlanningImportBackupRecord> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const legionRoot = path.join(repositoryRoot, ".legion");
  const preImportHash = await hashTree(legionRoot);
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
    kind: "planning-import-backup",
    createdAt: input.appliedAt,
    backupPath,
    repositoryRoot,
    preImportHash,
    sourceHash: input.report.source.treeHash,
    existingLegionRoot
  };
  const manifestPath = path.resolve(backupDirectory, "backup-manifest.json");
  await writeFile(manifestPath, stableProtocolJson(manifest), "utf8");

  return {
    manifestPath,
    backupPath,
    preImportHash,
    sourceHash: input.report.source.treeHash
  };
}

async function installStagedProject(input: {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
}): Promise<void> {
  const stagedProject = path.join(input.stagingRoot, ".legion", "project");
  const destinationProject = path.join(input.repositoryRoot, ".legion", "project");
  await mkdir(path.dirname(destinationProject), { recursive: true });
  await rm(destinationProject, { recursive: true, force: true });
  await cp(stagedProject, destinationProject, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInventory(value: unknown): value is PlanningSourceInventory {
  return (
    isRecord(value) &&
    typeof value["root"] === "string" &&
    typeof value["treeHash"] === "string" &&
    Array.isArray(value["files"])
  );
}

function isPlanningImportReport(value: unknown): value is PlanningImportReport {
  if (!isRecord(value)) return false;
  const policy = value["policy"];
  const target = value["target"];
  return (
    value["schemaVersion"] === "0.1.0" &&
    value["kind"] === "planning-import-report" &&
    typeof value["runId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    value["requiresReview"] === true &&
    isInventory(value["source"]) &&
    isInventory(target) &&
    Array.isArray(value["mappings"]) &&
    Array.isArray(value["conflicts"]) &&
    Array.isArray(value["uncertainties"]) &&
    isRecord(policy) &&
    policy["planningReadOnlyAfterApply"] === true &&
    policy["legacySourceDeleted"] === false &&
    policy["mutableStateImportedAsCurrentTruth"] === false
  );
}

function isBackupManifest(value: unknown): value is BackupManifest {
  return (
    isRecord(value) &&
    value["schemaVersion"] === "0.1.0" &&
    value["kind"] === "planning-import-backup" &&
    typeof value["createdAt"] === "string" &&
    typeof value["backupPath"] === "string" &&
    typeof value["repositoryRoot"] === "string" &&
    typeof value["preImportHash"] === "string" &&
    typeof value["sourceHash"] === "string" &&
    typeof value["existingLegionRoot"] === "boolean"
  );
}

async function validateStagedProjectHash(input: {
  readonly stagingRoot: string;
  readonly report: PlanningImportReport;
}): Promise<PlanningImportFailure | undefined> {
  const stagedProject = path.join(input.stagingRoot, ".legion", "project");
  const actualHash = await hashTreeExcluding(stagedProject, ["migration/planning-import-report.json"]);
  if (actualHash === input.report.target.treeHash) return undefined;

  return failure("invalid", [
    diagnostic({
      code: "staged_project_hash_mismatch",
      message: "Staged project bytes no longer match the reviewed dry-run report.",
      sourcePath: ".legion/project"
    })
  ]);
}

export async function applyPlanningImport(input: PlanningImportApplyInput): Promise<PlanningImportApplyResult> {
  const report = await readReport(input.stagingRoot);
  if ("diagnostics" in report) return report;

  if (!input.reviewAccepted) {
    return failure("blocked", [
      diagnostic({
        code: "dry_run_review_required",
        message: "Planning imports require explicit reviewed apply after the dry-run report is inspected.",
        sourcePath: REPORT_PATH
      })
    ]);
  }

  const stagedHashFailure = await validateStagedProjectHash({
    stagingRoot: input.stagingRoot,
    report
  });
  if (stagedHashFailure !== undefined) return stagedHashFailure;

  const destinationProject = path.join(input.repositoryRoot, ".legion", "project");
  if ((await pathExists(destinationProject)) && input.allowReplaceExistingProject !== true) {
    return failure("conflict", [
      diagnostic({
        code: "destination_contains_v9_project",
        message: "Destination already contains .legion/project; pass allowReplaceExistingProject only after review.",
        sourcePath: ".legion/project"
      })
    ]);
  }

  const appliedAt = parseUtcTimestamp({
    value: input.appliedAt,
    code: "invalid_applied_at",
    sourcePath: "appliedAt"
  });
  if (typeof appliedAt !== "string") return appliedAt;

  const backupRoot = await safeResolvedBackupRoot({
    repositoryRoot: input.repositoryRoot,
    planningRoot: report.source.root,
    stagingRoot: input.stagingRoot,
    backupRoot: input.backupRoot
  });
  if (typeof backupRoot !== "string") return backupRoot;

  const backup = await backupLegionRoot({
    repositoryRoot: input.repositoryRoot,
    backupRoot,
    appliedAt,
    report
  });

  try {
    await installStagedProject({
      repositoryRoot: input.repositoryRoot,
      stagingRoot: input.stagingRoot
    });
  } catch (error) {
    try {
      await rollbackPlanningImport({
        repositoryRoot: input.repositoryRoot,
        backupManifestPath: backup.manifestPath
      });
    } catch {
      // Preserve the original installation failure; rollback is best-effort here.
    }
    return failure("invalid", [
      diagnostic({
        code: "apply_failed",
        message: error instanceof Error ? error.message : "Staged project installation failed.",
        sourcePath: ".legion/project"
      })
    ]);
  }

  return {
    ok: true,
    status: "applied",
    backup,
    installedFiles: (await listFiles(path.join(input.repositoryRoot, ".legion", "project"))).map((file) =>
      toPosixPath(path.join(".legion/project", file))
    ),
    policy: report.policy
  };
}

export async function rollbackPlanningImport(input: PlanningImportRollbackInput): Promise<PlanningImportRollbackResult> {
  let manifest: BackupManifest;
  const backupManifestPath = path.resolve(input.backupManifestPath);
  try {
    const parsed = JSON.parse(await readFile(backupManifestPath, "utf8"));
    if (!isBackupManifest(parsed)) {
      throw new Error("Backup manifest is missing required planning import fields.");
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
  if (!path.isAbsolute(manifest.repositoryRoot)) {
    return failure("invalid", [
      diagnostic({
        code: "invalid_backup_manifest",
        message: "Backup manifest repositoryRoot must be absolute.",
        sourcePath: backupManifestPath
      })
    ]);
  }
  if (!sameResolvedPath(manifest.repositoryRoot, repositoryRoot)) {
    return failure("invalid", [
      diagnostic({
        code: "backup_repository_mismatch",
        message: "Backup manifest repositoryRoot does not match the requested repository root.",
        sourcePath: backupManifestPath
      })
    ]);
  }

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
    const backupHash = await hashTree(manifest.backupPath);
    if (backupHash !== manifest.preImportHash) {
      return failure("invalid", [
        diagnostic({
          code: "backup_hash_mismatch",
          message: "Backup bytes no longer match the manifest pre-import hash.",
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
