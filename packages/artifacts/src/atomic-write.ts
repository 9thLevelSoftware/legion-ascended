import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type {
  ArtifactPath,
  ArtifactReference,
  ArtifactRevision,
  ArtifactRole,
  GitSha
} from "@legion/protocol";

import { ensureProjectArtifactParent } from "./paths.js";
import {
  artifactRevisionForContent,
  contentBytes,
  type ArtifactContent
} from "./revisions.js";

export interface WriteRevisionedArtifactInput {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath | string;
  readonly role: ArtifactRole;
  readonly content: ArtifactContent;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly mediaType?: string;
  readonly baseGitSha?: GitSha;
  readonly supersedes?: ArtifactReference;
  readonly beforeCommit?: (context: BeforeArtifactCommitContext) => Promise<void> | void;
}

export interface BeforeArtifactCommitContext {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly revision: ArtifactRevision;
}

export interface WriteRevisionedArtifactResult {
  readonly artifactPath: ArtifactPath;
  readonly absolutePath: string;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
}

export class ArtifactRevisionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactRevisionConflictError";
  }
}

function assertRevision(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeSyncedTempFile(tempPath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectoryIfSupported(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(String(error.code))
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function tempFilePath(targetPath: string): string {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  return path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
}

export async function writeRevisionedArtifact(input: WriteRevisionedArtifactInput): Promise<WriteRevisionedArtifactResult> {
  assertRevision(input.expectedRevision, "expectedRevision");
  assertRevision(input.currentRevision, "currentRevision");

  if (input.expectedRevision !== input.currentRevision) {
    throw new ArtifactRevisionConflictError(
      `stale artifact revision: expected ${input.expectedRevision}, current ${input.currentRevision}`
    );
  }

  const resolved = await ensureProjectArtifactParent({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.artifactPath
  });
  const targetExists = await pathExists(resolved.absolutePath);
  if (input.currentRevision === 0 && targetExists) {
    throw new ArtifactRevisionConflictError("artifact already exists but current revision is 0");
  }
  if (input.currentRevision > 0 && !targetExists) {
    throw new ArtifactRevisionConflictError(`artifact revision ${input.currentRevision} requires an existing artifact file`);
  }

  const bytes = contentBytes(input.content);
  const revision = artifactRevisionForContent({
    role: input.role,
    path: resolved.repositoryPath,
    content: bytes,
    revision: input.currentRevision + 1,
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.baseGitSha === undefined ? {} : { baseGitSha: input.baseGitSha }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
  });
  const tempPath = tempFilePath(resolved.absolutePath);

  try {
    await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    await writeSyncedTempFile(tempPath, bytes);
    await input.beforeCommit?.({
      targetPath: resolved.absolutePath,
      tempPath,
      revision
    });
    await rename(tempPath, resolved.absolutePath);
    await fsyncDirectoryIfSupported(path.dirname(resolved.absolutePath));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return {
    artifactPath: resolved.repositoryPath,
    absolutePath: resolved.absolutePath,
    reference: revision.artifact,
    revision
  };
}
