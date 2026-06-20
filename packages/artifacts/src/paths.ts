import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  artifactPathSchema,
  changeIdSchema,
  oracleIdSchema,
  requirementIdSchema,
  type ArtifactPath,
  type ArtifactRole,
  type ChangeId,
  type OracleId,
  type RequirementId
} from "@legion/protocol";

export const LEGION_PROJECT_ROOT = ".legion/project" as const;

export const PROJECT_ARTIFACT_PATHS = Object.freeze({
  projectMetadata: ".legion/project/project.json",
  constitution: ".legion/project/constitution.md",
  currentSpecs: ".legion/project/specs",
  changes: ".legion/project/changes",
  adr: ".legion/project/adr"
});

export interface ArtifactSourceLocation {
  readonly path: ArtifactPath;
  readonly line?: number;
  readonly column?: number;
}

export interface ArtifactDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source: ArtifactSourceLocation;
}

export interface ResolvedProjectArtifactPath {
  readonly repositoryRoot: string;
  readonly repositoryPath: ArtifactPath;
  readonly absolutePath: string;
}

export interface ResolveProjectArtifactPathInput {
  readonly repositoryRoot: string;
  readonly artifactPath: unknown;
}

export interface ArtifactPathForRoleInput {
  readonly role: ArtifactRole;
  readonly changeId?: ChangeId | string;
  readonly requirementId?: RequirementId | string;
  readonly oracleId?: OracleId | string;
}

export class ArtifactPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

function normalizeForPlatform(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeForPlatform(root), normalizeForPlatform(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function startsWithProjectRoot(value: string): boolean {
  return value === LEGION_PROJECT_ROOT || value.startsWith(`${LEGION_PROJECT_ROOT}/`);
}

function assertLowercaseProjectPath(value: string): void {
  if (value !== value.toLowerCase()) {
    throw new ArtifactPathError(`Project artifact path must be lowercase to avoid platform-ambiguous casing: ${value}`);
  }
}

function assertNoWindowsStreamSeparator(value: string): void {
  if (value.includes(":")) {
    throw new ArtifactPathError(`Project artifact path must not contain ':' to avoid Windows alternate data streams: ${value}`);
  }
}

export function canonicalProjectArtifactPath(input: unknown): ArtifactPath {
  const parsed = artifactPathSchema.safeParse(input);
  if (!parsed.success) {
    throw new ArtifactPathError(`Invalid artifact path: ${String(input)}`);
  }

  if (!startsWithProjectRoot(parsed.data)) {
    throw new ArtifactPathError(`Project artifact path must stay under ${LEGION_PROJECT_ROOT}: ${parsed.data}`);
  }

  assertLowercaseProjectPath(parsed.data);
  assertNoWindowsStreamSeparator(parsed.data);
  return parsed.data;
}

export function diagnosticForPath(input: {
  readonly code: string;
  readonly message: string;
  readonly path: ArtifactPath;
  readonly line?: number;
  readonly column?: number;
}): ArtifactDiagnostic {
  const source: ArtifactSourceLocation = {
    path: input.path,
    ...(input.line === undefined ? {} : { line: input.line }),
    ...(input.column === undefined ? {} : { column: input.column })
  };

  return {
    code: input.code,
    message: input.message,
    source
  };
}

export function detectCaseCollisions(paths: readonly unknown[]): readonly ArtifactDiagnostic[] {
  const byFoldedPath = new Map<string, ArtifactPath>();
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const candidate of paths) {
    const parsed = artifactPathSchema.safeParse(candidate);
    if (!parsed.success) {
      diagnostics.push({
        code: "invalid_path",
        message: `Invalid artifact path: ${String(candidate)}`,
        source: { path: artifactPathSchema.parse(".legion/project/invalid-path-placeholder") }
      });
      continue;
    }

    const folded = parsed.data.toLowerCase();
    const prior = byFoldedPath.get(folded);
    if (prior !== undefined && prior !== parsed.data) {
      diagnostics.push(
        diagnosticForPath({
          code: "case_collision",
          message: `Artifact path has a case-insensitive collision with ${prior}: ${parsed.data}`,
          path: parsed.data
        })
      );
      continue;
    }

    byFoldedPath.set(folded, parsed.data);
  }

  return diagnostics;
}

function parseChangeId(input: ChangeId | string | undefined): ChangeId {
  return changeIdSchema.parse(input);
}

function parseRequirementId(input: RequirementId | string | undefined): RequirementId {
  return requirementIdSchema.parse(input);
}

function parseOracleId(input: OracleId | string | undefined): OracleId {
  return oracleIdSchema.parse(input);
}

export function artifactPathForRole(input: ArtifactPathForRoleInput): ArtifactPath {
  switch (input.role) {
    case "constitution":
      return canonicalProjectArtifactPath(PROJECT_ARTIFACT_PATHS.constitution);
    case "current-spec": {
      const requirementId = parseRequirementId(input.requirementId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.currentSpecs}/${requirementId}.md`);
    }
    case "proposal": {
      const changeId = parseChangeId(input.changeId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/change.yaml`);
    }
    case "delta-spec": {
      const changeId = parseChangeId(input.changeId);
      const requirementId = parseRequirementId(input.requirementId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/delta-specs/${requirementId}.md`);
    }
    case "design": {
      const changeId = parseChangeId(input.changeId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/design.md`);
    }
    case "decision-log": {
      const changeId = parseChangeId(input.changeId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/decisions.md`);
    }
    case "oracle": {
      const changeId = parseChangeId(input.changeId);
      const oracleId = parseOracleId(input.oracleId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/oracle/${oracleId}.yaml`);
    }
    case "taskgraph": {
      const changeId = parseChangeId(input.changeId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/taskgraph.json`);
    }
    case "evidence-index": {
      const changeId = parseChangeId(input.changeId);
      return canonicalProjectArtifactPath(`${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/evidence-index.json`);
    }
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    return stat.isDirectory();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function discoverProjectRoot(startDirectory: string): Promise<string> {
  let current = path.resolve(startDirectory);

  while (true) {
    if (await directoryExists(path.join(current, ".legion", "project"))) {
      return realpath(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new ArtifactPathError(`No ${LEGION_PROJECT_ROOT} directory found from ${startDirectory}`);
    }
    current = parent;
  }
}

async function nearestExistingAncestor(targetPath: string): Promise<string> {
  let current = targetPath;

  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function rejectFinalSymlink(absolutePath: string, repositoryPath: ArtifactPath): Promise<void> {
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new ArtifactPathError(`Project artifact path cannot be a symbolic link: ${repositoryPath}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function resolveProjectArtifactPath(input: ResolveProjectArtifactPathInput): Promise<ResolvedProjectArtifactPath> {
  const repositoryPath = canonicalProjectArtifactPath(input.artifactPath);
  const repositoryRoot = await realpath(path.resolve(input.repositoryRoot));
  const absolutePath = path.resolve(repositoryRoot, ...repositoryPath.split("/"));

  if (!isInsideOrEqual(repositoryRoot, absolutePath)) {
    throw new ArtifactPathError(`Project artifact path escapes repository root: ${repositoryPath}`);
  }

  const existingAncestor = await nearestExistingAncestor(absolutePath);
  const ancestorRealPath = await realpath(existingAncestor);
  if (!isInsideOrEqual(repositoryRoot, ancestorRealPath)) {
    throw new ArtifactPathError(`Project artifact path escapes repository root through a symlink: ${repositoryPath}`);
  }

  await rejectFinalSymlink(absolutePath, repositoryPath);

  return {
    repositoryRoot,
    repositoryPath,
    absolutePath
  };
}

export async function ensureProjectArtifactParent(input: ResolveProjectArtifactPathInput): Promise<ResolvedProjectArtifactPath> {
  const resolved = await resolveProjectArtifactPath(input);
  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  return resolveProjectArtifactPath(input);
}
