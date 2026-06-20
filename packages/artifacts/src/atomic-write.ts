import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
  hashContent,
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

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Cleanup must not hide the original write failure.
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

function lockFilePath(targetPath: string): string {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  return path.join(directory, `.${basename}.lock`);
}

async function acquireArtifactWriteLock(targetPath: string): Promise<() => Promise<void>> {
  const lockPath = lockFilePath(targetPath);
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await removeIfExists(lockPath);
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new ArtifactRevisionConflictError(`artifact write already in progress: ${targetPath}`);
    }
    throw error;
  }

  const activeHandle = handle;
  return async () => {
    let closeError: unknown;
    try {
      await activeHandle.close();
    } catch (error) {
      closeError = error;
    }

    try {
      await rm(lockPath, { force: true });
    } catch (error) {
      if (closeError === undefined) throw error;
    }

    if (closeError !== undefined) throw closeError;
  };
}

async function withArtifactWriteLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const releaseLock = await acquireArtifactWriteLock(targetPath);
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      if (operationError === undefined) throw error;
    }
  }
}

async function assertSupersededContent(input: {
  readonly currentRevision: number;
  readonly artifactPath: ArtifactPath;
  readonly absolutePath: string;
  readonly supersedes?: ArtifactReference;
}): Promise<void> {
  if (input.currentRevision === 0) return;
  if (input.supersedes === undefined) {
    throw new ArtifactRevisionConflictError("artifact updates require the superseded artifact reference");
  }
  if (input.supersedes.path !== input.artifactPath) {
    throw new ArtifactRevisionConflictError("superseded artifact path does not match target artifact path");
  }

  const currentHash = hashContent(await readFile(input.absolutePath));
  if (currentHash !== input.supersedes.sha256) {
    throw new ArtifactRevisionConflictError("current artifact content does not match expected superseded reference");
  }
}

async function writeRevisionedArtifactWithLock(input: WriteRevisionedArtifactInput): Promise<WriteRevisionedArtifactResult> {
  const resolved = await ensureProjectArtifactParent({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.artifactPath
  });
  const tempPath = tempFilePath(resolved.absolutePath);

  return withArtifactWriteLock(resolved.absolutePath, async () => {
    const targetExists = await pathExists(resolved.absolutePath);
    if (input.currentRevision === 0 && targetExists) {
      throw new ArtifactRevisionConflictError("artifact already exists but current revision is 0");
    }
    if (input.currentRevision > 0 && !targetExists) {
      throw new ArtifactRevisionConflictError(`artifact revision ${input.currentRevision} requires an existing artifact file`);
    }
    await assertSupersededContent({
      currentRevision: input.currentRevision,
      artifactPath: resolved.repositoryPath,
      absolutePath: resolved.absolutePath,
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
    });

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
      await removeIfExists(tempPath);
      throw error;
    }

    return {
      artifactPath: resolved.repositoryPath,
      absolutePath: resolved.absolutePath,
      reference: revision.artifact,
      revision
    };
  });
}

export async function writeRevisionedArtifact(input: WriteRevisionedArtifactInput): Promise<WriteRevisionedArtifactResult> {
  assertRevision(input.expectedRevision, "expectedRevision");
  assertRevision(input.currentRevision, "currentRevision");

  if (input.expectedRevision !== input.currentRevision) {
    throw new ArtifactRevisionConflictError(
      `stale artifact revision: expected ${input.expectedRevision}, current ${input.currentRevision}`
    );
  }

  return writeRevisionedArtifactWithLock(input);
}
