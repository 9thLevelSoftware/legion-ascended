import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LEGION_PROTOCOL_VERSION,
  actorSchema,
  formatEntityId,
  projectSchema,
  utcTimestampSchema,
  type Actor,
  type ArtifactReference,
  type ArtifactRevision,
  type Project,
  type RepositoryReference,
  type UtcTimestamp
} from "@legion/protocol";

import {
  PROJECT_ARTIFACT_PATHS,
  artifactPathForRole,
  diagnosticForPath,
  resolveProjectArtifactPath,
  type ArtifactDiagnostic
} from "../paths.js";
import {
  artifactRevisionForContent,
  hashContent,
  readJsonArtifact,
  stableProtocolJson
} from "../revisions.js";
import { writeRevisionedArtifact } from "../atomic-write.js";
import {
  DEFAULT_PROJECT_CONSTITUTION,
  validateConstitutionText
} from "./constitution.js";
import {
  PROJECT_MANIFEST_SCHEMA_VERSION,
  projectManifestSchema,
  type ProjectManifest
} from "./schema.js";

export const PROJECT_MANIFEST_PATH = PROJECT_ARTIFACT_PATHS.projectManifest;
export const LEGION_LEGACY_PROTOCOL_ROOT = ".legion/legacy-protocol" as const;
export const LEGION_VAR_ROOT = ".legion/var" as const;
export const LEGION_VAR_GITIGNORE_ENTRY = ".legion/var/" as const;

const PROJECT_MANIFEST_ARTIFACT_PATH = artifactPathForRole({ role: "project-manifest" });
const CONSTITUTION_ARTIFACT_PATH = artifactPathForRole({ role: "constitution" });
const PLANNED_INIT_WRITES = Object.freeze([
  ".gitignore",
  PROJECT_ARTIFACT_PATHS.constitution,
  PROJECT_ARTIFACT_PATHS.projectManifest,
  `${LEGION_VAR_ROOT}/`
]);

export interface InitProjectInput {
  readonly repositoryRoot: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly repository?: Partial<RepositoryReference>;
  readonly decisionOwners: readonly Actor[];
  readonly createdAt?: UtcTimestamp | string;
  readonly dryRun?: boolean;
  readonly constitutionTemplate?: string;
}

export interface LoadProjectInput {
  readonly repositoryRoot: string;
}

export interface ValidateProjectInput {
  readonly repositoryRoot: string;
}

export interface UpdateConstitutionInput {
  readonly repositoryRoot: string;
  readonly expectedManifestRevision: number;
  readonly content: string;
  readonly updatedAt?: UtcTimestamp | string;
}

export interface ProjectSuccess {
  readonly ok: true;
  readonly status: "initialized" | "already_initialized" | "dry_run" | "updated";
  readonly project: Project;
  readonly manifest: ProjectManifest;
  readonly manifestPath: typeof PROJECT_MANIFEST_PATH;
  readonly constitutionPath: typeof PROJECT_ARTIFACT_PATHS.constitution;
  readonly manifestRevision?: ArtifactRevision;
  readonly constitutionRevision: ArtifactRevision;
  readonly wouldWrite: readonly string[];
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface LoadedProjectSuccess {
  readonly ok: true;
  readonly project: Project;
  readonly manifest: ProjectManifest;
  readonly manifestPath: typeof PROJECT_MANIFEST_PATH;
  readonly manifestReference: ArtifactReference;
  readonly constitutionRevision: ArtifactRevision;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface ProjectFailure {
  readonly ok: false;
  readonly status: "invalid" | "migration_required" | "not_found";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type InitProjectResult = ProjectSuccess | ProjectFailure;
export type LoadProjectResult = LoadedProjectSuccess | ProjectFailure;
export type ValidateProjectResult = { readonly ok: true; readonly diagnostics: readonly [] } | ProjectFailure;
export type UpdateConstitutionResult = ProjectSuccess | ProjectFailure;

function nowTimestamp(): UtcTimestamp {
  return utcTimestampSchema.parse(new Date().toISOString());
}

function parseTimestamp(value: UtcTimestamp | string | undefined): UtcTimestamp {
  return value === undefined ? nowTimestamp() : utcTimestampSchema.parse(value);
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
  status: ProjectFailure["status"],
  diagnostics: readonly ArtifactDiagnostic[]
): ProjectFailure {
  return { ok: false, status, diagnostics };
}

function pathDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: typeof PROJECT_MANIFEST_ARTIFACT_PATH;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? PROJECT_MANIFEST_ARTIFACT_PATH
  });
}

function normalizeGitignoreLine(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function isLegionVarIgnorePattern(value: string): boolean {
  const line = normalizeGitignoreLine(value);
  return line === ".legion/var" || line === ".legion/var/" || line === "/.legion/var" || line === "/.legion/var/";
}

function isIgnorableLegionRootEntry(name: string): boolean {
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}

async function ensureVarIgnored(repositoryRoot: string): Promise<void> {
  const gitignorePath = path.join(repositoryRoot, ".gitignore");
  let existing = "";
  let lineEnding = "\n";

  try {
    existing = await readFile(gitignorePath, "utf8");
    lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const lines = existing.split(/\r?\n/);
  if (lines.some(isLegionVarIgnorePattern)) return;

  const prefix = existing.length === 0 || existing.endsWith("\n") || existing.endsWith("\r\n") ? existing : `${existing}${lineEnding}`;
  await writeFile(gitignorePath, `${prefix}${LEGION_VAR_GITIGNORE_ENTRY}${lineEnding}`, "utf8");
}

async function createOperationalVarRoot(repositoryRoot: string): Promise<void> {
  await mkdir(path.join(repositoryRoot, ".legion", "var"), { recursive: true });
}

async function detectPreInitCollision(repositoryRoot: string): Promise<readonly ArtifactDiagnostic[]> {
  const legionRoot = path.join(repositoryRoot, ".legion");
  if (!(await pathExists(legionRoot))) return [];

  const entries = await readdir(legionRoot, { withFileTypes: true });
  const unknownEntries = entries
    .map((entry) => entry.name)
    .filter((name) => name !== "project" && name !== "var" && name !== "legacy-protocol" && !isIgnorableLegionRootEntry(name))
    .sort();

  if (unknownEntries.length > 0) {
    return [
      pathDiagnostic({
        code: "migration_required",
        message: `Existing .legion entries require explicit migration before initialization: ${unknownEntries.join(", ")}.`
      })
    ];
  }

  const projectRoot = path.join(legionRoot, "project");
  const manifestPath = path.join(projectRoot, "project.json");
  if ((await pathExists(projectRoot)) && !(await pathExists(manifestPath))) {
    if (await containsOnlyPreInitWorkflowRecords(projectRoot)) return [];
    return [
      pathDiagnostic({
        code: "migration_required",
        message: "Existing .legion/project data has no project manifest; explicit migration or reconciliation is required before initialization."
      })
    ];
  }

  return [];
}

export async function containsOnlyPreInitWorkflowRecords(projectRoot: string): Promise<boolean> {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.isDirectory() !== true || entries[0].name !== "workflow") {
    return false;
  }
  return containsOnlyRecognizedWorkflowRecords(path.join(projectRoot, "workflow"));
}

async function containsOnlyRecognizedWorkflowRecords(workflowRoot: string): Promise<boolean> {
  const entries = await readdir(workflowRoot, { withFileTypes: true });
  let recordCount = 0;

  for (const entry of entries) {
    if (isIgnorableLegionRootEntry(entry.name)) continue;
    if (!entry.isDirectory()) return false;

    const result = await workflowRecordDirectoryStats(path.join(workflowRoot, entry.name), entry.name);
    if (!result.valid) return false;
    recordCount += result.recordCount;
  }

  return recordCount > 0;
}

async function workflowRecordDirectoryStats(
  absoluteDirectory: string,
  workflow: string
): Promise<{ readonly valid: boolean; readonly recordCount: number }> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  let recordCount = 0;

  for (const entry of entries) {
    if (isIgnorableLegionRootEntry(entry.name)) continue;
    const absolutePath = entry.isDirectory()
      ? path.join(absoluteDirectory, entry.name, "workflow-run.json")
      : path.join(absoluteDirectory, entry.name);
    if (!entry.isDirectory() && (!entry.isFile() || !entry.name.endsWith(".json"))) return { valid: false, recordCount: 0 };

    let raw: string;
    let parsed: unknown;
    try {
      raw = await readFile(absolutePath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      return { valid: false, recordCount: 0 };
    }

    if (!isRecognizedWorkflowRecord(parsed, workflow) && !isRecognizedWorkflowRun(parsed, workflow)) return { valid: false, recordCount: 0 };
    recordCount += 1;
  }

  return { valid: true, recordCount };
}

function isRecognizedWorkflowRecord(value: unknown, workflow: string): boolean {
  if (!isJsonObject(value)) return false;
  const nextAction = value["nextAction"];

  return (
    value["schemaVersion"] === 1 &&
    value["kind"] === "workflow_record" &&
    value["workflow"] === workflow &&
    typeof value["createdAt"] === "string" &&
    value["createdAt"].trim().length > 0 &&
    isJsonObject(value["input"]) &&
    isJsonObject(nextAction) &&
    typeof nextAction["command"] === "string" &&
    nextAction["command"].trim().length > 0 &&
    typeof nextAction["reason"] === "string" &&
    nextAction["reason"].trim().length > 0
  );
}

function isRecognizedWorkflowRun(value: unknown, workflow: string): boolean {
  if (!isJsonObject(value)) return false;
  const nextAction = value["nextAction"];

  return (
    value["schemaVersion"] === 1 &&
    value["kind"] === "workflow_run" &&
    value["workflow"] === workflow &&
    typeof value["runId"] === "string" &&
    value["runId"].trim().length > 0 &&
    typeof value["createdAt"] === "string" &&
    value["createdAt"].trim().length > 0 &&
    typeof value["status"] === "string" &&
    isJsonObject(value["input"]) &&
    isJsonObject(value["outputs"]) &&
    isJsonObject(nextAction) &&
    typeof nextAction["command"] === "string" &&
    nextAction["command"].trim().length > 0 &&
    typeof nextAction["reason"] === "string" &&
    nextAction["reason"].trim().length > 0
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createConstitutionRevision(content: string): ArtifactRevision {
  return artifactRevisionForContent({
    role: "constitution",
    path: CONSTITUTION_ARTIFACT_PATH,
    content,
    revision: 1,
    mediaType: "text/markdown"
  });
}

function buildProject(input: {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly repository?: Partial<RepositoryReference>;
  readonly decisionOwners: readonly Actor[];
  readonly createdAt: UtcTimestamp;
  readonly constitution: ArtifactReference;
}): Project {
  const decisionOwners = input.decisionOwners.map((owner) => actorSchema.parse(owner));
  const repository = {
    provider: input.repository?.provider ?? "git",
    defaultBranch: input.repository?.defaultBranch ?? "main",
    ...(input.repository?.remoteUrl === undefined ? {} : { remoteUrl: input.repository.remoteUrl })
  };

  return projectSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt: input.createdAt,
    kind: "project",
    id: formatEntityId("project", input.slug),
    slug: input.slug,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    repository,
    policy: {
      constitution: input.constitution,
      currentSpecRoot: PROJECT_ARTIFACT_PATHS.currentSpecs,
      changeRoot: PROJECT_ARTIFACT_PATHS.changes,
      adrRoot: PROJECT_ARTIFACT_PATHS.adr,
      riskPolicyRefs: [],
      oraclePolicyRefs: [],
      decisionOwners
    }
  });
}

function buildManifest(input: {
  readonly revision: number;
  readonly project: Project;
  readonly constitutionRevision: ArtifactRevision;
}): ProjectManifest {
  return projectManifestSchema.parse({
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    kind: "project-manifest",
    revision: input.revision,
    project: input.project,
    artifactRevisions: {
      constitution: input.constitutionRevision
    }
  });
}

function success(input: {
  readonly status: ProjectSuccess["status"];
  readonly project: Project;
  readonly manifest: ProjectManifest;
  readonly constitutionRevision: ArtifactRevision;
  readonly manifestRevision?: ArtifactRevision;
  readonly wouldWrite?: readonly string[];
}): ProjectSuccess {
  return {
    ok: true,
    status: input.status,
    project: input.project,
    manifest: input.manifest,
    manifestPath: PROJECT_MANIFEST_PATH,
    constitutionPath: PROJECT_ARTIFACT_PATHS.constitution,
    ...(input.manifestRevision === undefined ? {} : { manifestRevision: input.manifestRevision }),
    constitutionRevision: input.constitutionRevision,
    wouldWrite: input.wouldWrite ?? [],
    diagnostics: []
  };
}

export async function loadProject(input: LoadProjectInput): Promise<LoadProjectResult> {
  const result = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: PROJECT_MANIFEST_PATH,
    schema: projectManifestSchema
  });

  if (!result.ok) {
    const notFound = result.diagnostics.some((diagnostic) => diagnostic.code === "not_found");
    return failure(notFound ? "not_found" : "invalid", result.diagnostics);
  }

  return {
    ok: true,
    project: result.value.project,
    manifest: result.value,
    manifestPath: PROJECT_MANIFEST_PATH,
    manifestReference: result.reference,
    constitutionRevision: result.value.artifactRevisions.constitution,
    diagnostics: []
  };
}

export async function initProject(input: InitProjectInput): Promise<InitProjectResult> {
  const existing = await loadProject({ repositoryRoot: input.repositoryRoot });
  if (existing.ok) {
    const validation = await validateProject({ repositoryRoot: input.repositoryRoot });
    if (!validation.ok) return validation;
    return success({
      status: "already_initialized",
      project: existing.project,
      manifest: existing.manifest,
      constitutionRevision: existing.constitutionRevision
    });
  }

  if (existing.status === "invalid") return existing;

  const collisionDiagnostics = await detectPreInitCollision(input.repositoryRoot);
  if (collisionDiagnostics.length > 0) return failure("migration_required", collisionDiagnostics);

  const createdAt = parseTimestamp(input.createdAt);
  const constitutionContent = input.constitutionTemplate ?? DEFAULT_PROJECT_CONSTITUTION;
  const constitutionDiagnostics = validateConstitutionText({ content: constitutionContent });
  if (constitutionDiagnostics.length > 0) return failure("invalid", constitutionDiagnostics);

  const plannedConstitutionRevision = createConstitutionRevision(constitutionContent);
  const project = buildProject({
    slug: input.slug,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    decisionOwners: input.decisionOwners,
    createdAt,
    constitution: plannedConstitutionRevision.artifact
  });
  const plannedManifest = buildManifest({
    revision: 1,
    project,
    constitutionRevision: plannedConstitutionRevision
  });

  if (input.dryRun === true) {
    return success({
      status: "dry_run",
      project,
      manifest: plannedManifest,
      constitutionRevision: plannedConstitutionRevision,
      wouldWrite: PLANNED_INIT_WRITES
    });
  }

  await ensureVarIgnored(input.repositoryRoot);
  await createOperationalVarRoot(input.repositoryRoot);

  const constitutionWrite = await writeRevisionedArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: CONSTITUTION_ARTIFACT_PATH,
    role: "constitution",
    content: constitutionContent,
    expectedRevision: 0,
    currentRevision: 0,
    mediaType: "text/markdown"
  });

  const initializedProject = buildProject({
    slug: input.slug,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    decisionOwners: input.decisionOwners,
    createdAt,
    constitution: constitutionWrite.reference
  });
  const manifest = buildManifest({
    revision: 1,
    project: initializedProject,
    constitutionRevision: constitutionWrite.revision
  });
  const manifestContent = stableProtocolJson(manifest);
  const manifestWrite = await writeRevisionedArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: PROJECT_MANIFEST_ARTIFACT_PATH,
    role: "project-manifest",
    content: manifestContent,
    expectedRevision: 0,
    currentRevision: 0,
    mediaType: "application/json"
  });

  return success({
    status: "initialized",
    project: initializedProject,
    manifest,
    manifestRevision: manifestWrite.revision,
    constitutionRevision: constitutionWrite.revision,
    wouldWrite: PLANNED_INIT_WRITES
  });
}

async function readConstitution(repositoryRoot: string, manifest: ProjectManifest): Promise<{
  readonly ok: true;
  readonly content: string;
} | {
  readonly ok: false;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}> {
  const resolved = await resolveProjectArtifactPath({
    repositoryRoot,
    artifactPath: manifest.project.policy.constitution.path
  });

  try {
    return {
      ok: true,
      content: await readFile(resolved.absolutePath, "utf8")
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        ok: false,
        diagnostics: [
          diagnosticForPath({
            code: "constitution_missing",
            message: "Constitution file does not exist.",
            path: manifest.project.policy.constitution.path
          })
        ]
      };
    }
    throw error;
  }
}

async function validateVarIgnore(repositoryRoot: string): Promise<readonly ArtifactDiagnostic[]> {
  const gitignorePath = path.join(repositoryRoot, ".gitignore");
  try {
    const contents = await readFile(gitignorePath, "utf8");
    const lines = contents.split(/\r?\n/);
    if (lines.some(isLegionVarIgnorePattern)) return [];
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  return [
    pathDiagnostic({
      code: "var_not_ignored",
      message: ".legion/var/ must be ignored so operational files do not become committed intent."
    })
  ];
}

export async function validateProject(input: ValidateProjectInput): Promise<ValidateProjectResult> {
  const loaded = await loadProject(input);
  if (!loaded.ok) return loaded;

  const diagnostics: ArtifactDiagnostic[] = [];
  const constitution = await readConstitution(input.repositoryRoot, loaded.manifest);
  if (!constitution.ok) {
    diagnostics.push(...constitution.diagnostics);
  } else {
    const actualHash = hashContent(constitution.content);
    if (actualHash !== loaded.manifest.project.policy.constitution.sha256) {
      diagnostics.push(
        diagnosticForPath({
          code: "constitution_hash_mismatch",
          message: "Constitution bytes do not match the hash recorded in the project manifest.",
          path: loaded.manifest.project.policy.constitution.path
        })
      );
    }

    diagnostics.push(
      ...validateConstitutionText({
        content: constitution.content,
        path: loaded.manifest.project.policy.constitution.path
      })
    );
  }

  diagnostics.push(...(await validateVarIgnore(input.repositoryRoot)));

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return { ok: true, diagnostics: [] };
}

export async function updateConstitution(input: UpdateConstitutionInput): Promise<UpdateConstitutionResult> {
  const loaded = await loadProject({ repositoryRoot: input.repositoryRoot });
  if (!loaded.ok) return loaded;

  if (input.expectedManifestRevision !== loaded.manifest.revision) {
    return failure("invalid", [
      pathDiagnostic({
        code: "stale_manifest_revision",
        message: `Expected project manifest revision ${input.expectedManifestRevision}, but current revision is ${loaded.manifest.revision}.`
      })
    ]);
  }

  const constitutionDiagnostics = validateConstitutionText({
    content: input.content,
    path: loaded.manifest.project.policy.constitution.path
  });
  if (constitutionDiagnostics.length > 0) return failure("invalid", constitutionDiagnostics);

  const constitutionWrite = await writeRevisionedArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: loaded.manifest.project.policy.constitution.path,
    role: "constitution",
    content: input.content,
    expectedRevision: loaded.constitutionRevision.revision,
    currentRevision: loaded.constitutionRevision.revision,
    supersedes: loaded.constitutionRevision.artifact,
    mediaType: "text/markdown"
  });

  const updatedProject = projectSchema.parse({
    ...loaded.project,
    updatedAt: parseTimestamp(input.updatedAt),
    policy: {
      ...loaded.project.policy,
      constitution: constitutionWrite.reference
    }
  });
  const updatedManifest = buildManifest({
    revision: loaded.manifest.revision + 1,
    project: updatedProject,
    constitutionRevision: constitutionWrite.revision
  });
  const manifestWrite = await writeRevisionedArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: PROJECT_MANIFEST_ARTIFACT_PATH,
    role: "project-manifest",
    content: stableProtocolJson(updatedManifest),
    expectedRevision: loaded.manifest.revision,
    currentRevision: loaded.manifest.revision,
    supersedes: loaded.manifestReference,
    mediaType: "application/json"
  });

  return success({
    status: "updated",
    project: updatedProject,
    manifest: updatedManifest,
    manifestRevision: manifestWrite.revision,
    constitutionRevision: constitutionWrite.revision
  });
}
