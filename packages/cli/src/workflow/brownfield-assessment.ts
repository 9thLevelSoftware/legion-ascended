import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  artifactReferenceSchema,
  artifactPathSchema,
  assessmentIdSchema,
  assessmentEffortSchema,
  brownfieldAssessmentSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotSchema,
  codeIndexSourcePathSchema,
  type ArtifactPath,
  type BrownfieldAssessment,
  type CodeIndexSha256
} from "@legion/protocol";
import { resolveProjectArtifactPath, stableProtocolJson } from "@legion/artifacts";

import {
  discoverLatestStructuralCodeIndex,
  resolveMapState,
  type LatestStructuralCodeIndex
} from "./codebase-map.js";

const ASSESSMENT_ROOT = ".legion/project/assessment";
// artifactPathSchema rejects literal ".". Persist "repository" as a
// schema-valid, repository-relative sentinel for the repository root.
const SAFE_REPOSITORY_ROOT = "repository";
const REFRESH_ACTION = "legion map --refresh --profile structural";
const BUNDLE_FILE_NAMES = [
  "state.json",
  "signals.json",
  "assumptions.json",
  "findings.json",
  "synthesis.json",
  "review.json"
] as const;
const MAX_BUNDLE_FILE_BYTES = 16 * 1024 * 1024;
const BUNDLE_READ_CHUNK_BYTES = 64 * 1024;
const PUBLISH_LOCK_STALE_MS = 60_000;
const PUBLISH_LOCK_ATTEMPTS = 60_000;
const PUBLISH_LOCK_METADATA = "owner.json";
const MAX_PUBLISH_LOCK_METADATA_BYTES = 4 * 1024;
const DARWIN_O_NOFOLLOW = 0x100;
const LINUX_O_NOFOLLOW = 0x20000;
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number"
  ? fsConstants.O_NOFOLLOW
  : process.platform === "darwin" ? DARWIN_O_NOFOLLOW
    : process.platform === "linux" ? LINUX_O_NOFOLLOW
      : 0;
const DIRECTORY_FLAG = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
// Avoid blocking if a bundle entry is swapped to a FIFO/special file between
// validation and open. Regular files are unaffected by O_NONBLOCK.
const NONBLOCK_FLAG = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
const DESCRIPTOR_PATH_ROOT = process.platform === "linux" ? "/proc/self/fd" : undefined;

export interface BrownfieldAssessmentPaths {
  readonly root: ArtifactPath;
  readonly state: ArtifactPath;
  readonly signals: ArtifactPath;
  readonly assumptions: ArtifactPath;
  readonly findings: ArtifactPath;
  readonly synthesis: ArtifactPath;
  readonly review: ArtifactPath;
}

type BundleFileName = (typeof BUNDLE_FILE_NAMES)[number];

type AssessmentProvenance = {
  readonly generatedAt: string;
  readonly scope: string;
  readonly snapshotId: string;
  readonly sourceFingerprint: CodeIndexSha256;
  readonly semanticIndexSha256: CodeIndexSha256;
  readonly semanticSqliteSha256: CodeIndexSha256;
};

type ResolvedBundlePath = {
  readonly repositoryRoot: string;
  readonly repositoryPath: ArtifactPath;
  readonly absolutePath: string;
};

type BundleFileHandle = Awaited<ReturnType<typeof open>>;
type BundleStat = Awaited<ReturnType<typeof lstat>>;
type OpenedBundleFile = {
  readonly descriptor: BundleFileHandle;
  readonly openedStat: BundleStat;
};
type OpenedBundleDirectory = {
  readonly repositoryRoot: string;
  readonly absolutePath: string;
  readonly descriptor?: BundleFileHandle;
};
type PublishLock = {
  readonly absolutePath: string;
  readonly name: string;
  readonly parentDescriptor?: BundleFileHandle;
  readonly lockDescriptor?: BundleFileHandle;
};

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function descriptorPath(descriptor: BundleFileHandle): string {
  if (DESCRIPTOR_PATH_ROOT === undefined) {
    throw new Error("Descriptor-relative bundle operations are not supported on this platform");
  }
  return `${DESCRIPTOR_PATH_ROOT}/${descriptor.fd}`;
}

function descriptorChildPath(parent: BundleFileHandle, child: string): string {
  return path.join(descriptorPath(parent), child);
}

let descriptorTraversalAvailable: boolean | undefined;
async function canUseDescriptorTraversal(): Promise<boolean> {
  if (descriptorTraversalAvailable !== undefined) return descriptorTraversalAvailable;
  if (DESCRIPTOR_PATH_ROOT === undefined) {
    descriptorTraversalAvailable = false;
    return descriptorTraversalAvailable;
  }
  try {
    await access(DESCRIPTOR_PATH_ROOT);
    descriptorTraversalAvailable = true;
  } catch {
    descriptorTraversalAvailable = false;
  }
  return descriptorTraversalAvailable;
}

// Linux uses descriptor-relative, O_NOFOLLOW traversal below. Other platforms
// retain compatibility with a realpath-before/after fallback; that fallback
// detects path mutations but cannot make a concurrent reparse race impossible.
async function assertStableAbsolutePath(absolutePath: string, displayPath: string, allowMissingFinal = true): Promise<void> {
  const expectedParent = path.dirname(absolutePath);
  let parentRealPath: string;
  try {
    parentRealPath = await realpath(expectedParent);
  } catch (error) {
    if (allowMissingFinal && isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!samePath(parentRealPath, expectedParent)) {
    throw new Error(`Brownfield assessment artifact path contains a symbolic link: ${displayPath}`);
  }
  try {
    const targetRealPath = await realpath(absolutePath);
    if (!samePath(targetRealPath, absolutePath)) {
      throw new Error(`Brownfield assessment artifact path contains a symbolic link: ${displayPath}`);
    }
  } catch (error) {
    if (allowMissingFinal && isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

async function assertStableFallbackPath(resolved: ResolvedBundlePath, artifactPath: ArtifactPath, allowMissingFinal = true): Promise<void> {
  await assertStableAbsolutePath(resolved.absolutePath, artifactPath, allowMissingFinal);
}

async function openRelativeDirectory(parent: BundleFileHandle, name: string): Promise<BundleFileHandle> {
  return open(descriptorChildPath(parent, name), fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG | NONBLOCK_FLAG);
}

async function openRelativeFile(parent: BundleFileHandle, name: string, flags: number, mode?: number): Promise<BundleFileHandle> {
  return open(descriptorChildPath(parent, name), flags | NOFOLLOW_FLAG | NONBLOCK_FLAG, mode);
}

async function mkdirRelative(parent: BundleFileHandle, name: string): Promise<void> {
  await mkdir(descriptorChildPath(parent, name), { mode: 0o700 });
}

async function removeRelative(parent: BundleFileHandle, name: string): Promise<void> {
  await rm(descriptorChildPath(parent, name), { recursive: true, force: true });
}

async function openBundleDirectory(
  repositoryRoot: string,
  artifactPath: ArtifactPath,
  createMissing: boolean
): Promise<OpenedBundleDirectory> {
  const resolved = await resolveSafeBundlePath(repositoryRoot, artifactPath);
  if (!(await canUseDescriptorTraversal())) {
    await assertStableFallbackPath(resolved, artifactPath, true);
    return { repositoryRoot: resolved.repositoryRoot, absolutePath: resolved.absolutePath };
  }

  const handles: BundleFileHandle[] = [];
  try {
    const root = await open(
      resolved.repositoryRoot,
      fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG | NONBLOCK_FLAG
    );
    handles.push(root);
    const rootStat = await root.stat();
    if (!rootStat.isDirectory()) {
      throw new Error(`Brownfield assessment repository root is not a directory: ${repositoryRoot}`);
    }
    let current = root;
    for (const component of artifactPath.split("/")) {
      let next: BundleFileHandle;
      try {
        next = await openRelativeDirectory(current, component);
      } catch (error) {
        if (!createMissing || !isNodeErrorCode(error, "ENOENT")) throw error;
        try {
          await mkdirRelative(current, component);
        } catch (mkdirError) {
          if (!isNodeErrorCode(mkdirError, "EEXIST")) throw mkdirError;
        }
        next = await openRelativeDirectory(current, component);
      }
      const nextStat = await next.stat();
      if (!nextStat.isDirectory()) {
        await next.close().catch(() => undefined);
        throw new Error(`Brownfield assessment artifact path contains a non-directory component: ${artifactPath}`);
      }
      handles.push(next);
      current = next;
    }
    for (const handle of handles.slice(0, -1)) await handle.close();
    return { repositoryRoot: resolved.repositoryRoot, absolutePath: resolved.absolutePath, descriptor: current };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}

async function closeBundleDirectory(directory: OpenedBundleDirectory | undefined): Promise<void> {
  await directory?.descriptor?.close().catch(() => undefined);
}

function stripSha256Prefix(value: string): CodeIndexSha256 {
  return codeIndexSha256Schema.parse(value.startsWith("sha256:") ? value.slice("sha256:".length) : value);
}

function assessmentPaths(assessmentId: string): BrownfieldAssessmentPaths {
  const root = artifactPathSchema.parse(`${ASSESSMENT_ROOT}/${assessmentId}`);
  const pathFor = (fileName: BundleFileName): ArtifactPath => artifactPathSchema.parse(`${root}/${fileName}`);
  return {
    root,
    state: pathFor("state.json"),
    signals: pathFor("signals.json"),
    assumptions: pathFor("assumptions.json"),
    findings: pathFor("findings.json"),
    synthesis: pathFor("synthesis.json"),
    review: pathFor("review.json")
  };
}

function assertAssessmentArtifactPath(artifactPath: ArtifactPath): void {
  if (artifactPath !== ASSESSMENT_ROOT && !artifactPath.startsWith(`${ASSESSMENT_ROOT}/`)) {
    throw new Error(`Brownfield assessment artifact path must stay under ${ASSESSMENT_ROOT}: ${artifactPath}`);
  }
}

async function resolveSafeBundlePath(repositoryRoot: string, artifactPath: ArtifactPath): Promise<ResolvedBundlePath> {
  assertAssessmentArtifactPath(artifactPath);
  const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath });
  const repositoryRealPath = path.resolve(resolved.repositoryRoot);
  const assessmentRealPath = path.join(repositoryRealPath, ".legion", "project", "assessment");
  const relativeToAssessment = path.relative(assessmentRealPath, resolved.absolutePath);
  if (relativeToAssessment === ".." || relativeToAssessment.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToAssessment)) {
    throw new Error(`Brownfield assessment artifact path escapes ${ASSESSMENT_ROOT}: ${artifactPath}`);
  }

  let current = repositoryRealPath;
  for (const [index, component] of artifactPath.split("/").entries()) {
    current = path.join(current, component);
    let componentStat;
    try {
      componentStat = await lstat(current);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) break;
      throw error;
    }
    if (componentStat.isSymbolicLink()) {
      throw new Error(`Brownfield assessment artifact path contains a symbolic link: ${artifactPath}`);
    }
    const isFinalComponent = index === artifactPath.split("/").length - 1;
    if (!isFinalComponent && !componentStat.isDirectory()) {
      throw new Error(`Brownfield assessment artifact path contains a non-directory component: ${artifactPath}`);
    }
  }

  return { repositoryRoot: repositoryRealPath, repositoryPath: resolved.repositoryPath, absolutePath: resolved.absolutePath };
}

async function lstatIfPresent(absolutePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function fsyncDirectoryIfSupported(directory: string): Promise<void> {
  let handle;
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return;
    handle = await open(
      directory,
      fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG | NONBLOCK_FLAG
    );
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) return;
    await handle.sync();
  } catch (error) {
    if (isNodeErrorCode(error, "EACCES") || isNodeErrorCode(error, "EBADF") ||
      isNodeErrorCode(error, "EISDIR") || isNodeErrorCode(error, "EINVAL") ||
      isNodeErrorCode(error, "ENOTSUP") || isNodeErrorCode(error, "EPERM")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function errorWithCode(code: string, message: string): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function sameFileIdentity(left: BundleStat, right: BundleStat): boolean | undefined {
  if (left.dev === 0 || right.dev === 0 || left.ino === 0 || right.ino === 0) return undefined;
  return left.dev === right.dev && left.ino === right.ino;
}

function boundedReadError(artifactPath: ArtifactPath): Error & { readonly code: string } {
  return errorWithCode(
    "ERR_BROWNFIELD_BUNDLE_SIZE",
    `Brownfield assessment artifact exceeds the bounded read limit: ${artifactPath}`
  );
}

async function writeLockMetadata(lockPath: string, lockDescriptor?: BundleFileHandle): Promise<void> {
  const metadata = JSON.stringify({
    pid: process.pid,
    acquiredAt: Date.now(),
    token: randomUUID()
  });
  let descriptor: BundleFileHandle | undefined;
  try {
    if (lockDescriptor === undefined) await assertStableAbsolutePath(lockPath, lockPath, false);
    descriptor = lockDescriptor === undefined
      ? await open(path.join(lockPath, PUBLISH_LOCK_METADATA), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG, 0o600)
      : await openRelativeFile(lockDescriptor, PUBLISH_LOCK_METADATA, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await descriptor.writeFile(metadata, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}

async function readLockMetadata(lockPath: string, lockDescriptor?: BundleFileHandle): Promise<string | undefined> {
  let descriptor: BundleFileHandle | undefined;
  try {
    const metadataPath = path.join(lockPath, PUBLISH_LOCK_METADATA);
    const fallbackStat = lockDescriptor === undefined ? await lstatIfPresent(metadataPath) : undefined;
    if (fallbackStat !== undefined && (fallbackStat.isSymbolicLink() || !fallbackStat.isFile())) return undefined;
    descriptor = lockDescriptor === undefined
      ? await open(metadataPath, fsConstants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG)
      : await openRelativeFile(lockDescriptor, PUBLISH_LOCK_METADATA, fsConstants.O_RDONLY);
    const metadataStat = await descriptor.stat();
    if (!metadataStat.isFile() ||
      (fallbackStat !== undefined && sameFileIdentity(fallbackStat, metadataStat) === false) ||
      Number(metadataStat.size) > MAX_PUBLISH_LOCK_METADATA_BYTES) return undefined;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = MAX_PUBLISH_LOCK_METADATA_BYTES + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(remaining);
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      if (totalBytes > MAX_PUBLISH_LOCK_METADATA_BYTES) return undefined;
    }
    const finalStat = await descriptor.stat();
    if (!finalStat.isFile() || finalStat.size !== totalBytes) return undefined;
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

async function lockIsStale(lockPath: string, lockDescriptor?: BundleFileHandle): Promise<boolean> {
  const lockStat = lockDescriptor === undefined
    ? await lstatIfPresent(lockPath)
    : await lockDescriptor.stat();
  if (lockStat === undefined) return false;
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(`Brownfield assessment publication lock is unsafe: ${lockPath}`);
  }
  const metadataText = await readLockMetadata(lockPath, lockDescriptor);
  if (metadataText !== undefined) {
    try {
      const metadata = JSON.parse(metadataText) as { pid?: unknown; acquiredAt?: unknown };
      if (typeof metadata.acquiredAt === "number" && Date.now() - metadata.acquiredAt < PUBLISH_LOCK_STALE_MS) {
        return false;
      }
      if (typeof metadata.pid === "number" && processIsAlive(metadata.pid)) return false;
    } catch {
      // Corrupt metadata is only recoverable once the directory itself is old.
    }
  }
  return Date.now() - Number(lockStat.mtimeMs) >= PUBLISH_LOCK_STALE_MS;
}

async function releasePublishLock(lock: PublishLock): Promise<void> {
  await lock.lockDescriptor?.close().catch(() => undefined);
  if (lock.parentDescriptor !== undefined) {
    await removeRelative(lock.parentDescriptor, lock.name).catch(() => undefined);
  } else {
    await rm(lock.absolutePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function quarantineStaleLock(parent: OpenedBundleDirectory, lockName: string, lockPath: string): Promise<boolean> {
  const quarantineName = `${lockName}.stale-${process.pid}-${randomUUID()}`;
  try {
    if (parent.descriptor === undefined) {
      await assertStableAbsolutePath(parent.absolutePath, parent.absolutePath, false);
      await rename(lockPath, path.join(parent.absolutePath, quarantineName));
    } else {
      await rename(
        descriptorChildPath(parent.descriptor, lockName),
        descriptorChildPath(parent.descriptor, quarantineName)
      );
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  if (parent.descriptor === undefined) {
    await rm(path.join(parent.absolutePath, quarantineName), { recursive: true, force: true }).catch(() => undefined);
  } else {
    await removeRelative(parent.descriptor, quarantineName).catch(() => undefined);
  }
  return true;
}

async function acquirePublishLock(
  parent: OpenedBundleDirectory,
  finalPath: string,
  finalName: string
): Promise<PublishLock> {
  const lockName = `.${finalName}.publish-lock`;
  const lockPath = path.join(parent.absolutePath, lockName);
  for (let attempt = 0; attempt < PUBLISH_LOCK_ATTEMPTS; attempt += 1) {
    try {
      if (parent.descriptor === undefined) {
        await assertStableFallbackPath(
          { repositoryRoot: parent.repositoryRoot, repositoryPath: artifactPathSchema.parse(ASSESSMENT_ROOT), absolutePath: parent.absolutePath },
          artifactPathSchema.parse(ASSESSMENT_ROOT),
          false
        );
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeLockMetadata(lockPath);
        } catch (metadataError) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw metadataError;
        }
      } else {
        await mkdirRelative(parent.descriptor, lockName);
        const lockDescriptor = await openRelativeDirectory(parent.descriptor, lockName);
        try {
          await writeLockMetadata(lockPath, lockDescriptor);
          return { absolutePath: lockPath, name: lockName, parentDescriptor: parent.descriptor, lockDescriptor };
        } catch (error) {
          await lockDescriptor.close().catch(() => undefined);
          await removeRelative(parent.descriptor, lockName).catch(() => undefined);
          throw error;
        }
      }
      return { absolutePath: lockPath, name: lockName };
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      const lockStat = parent.descriptor === undefined
        ? await lstatIfPresent(lockPath)
        : await lstatIfPresent(descriptorChildPath(parent.descriptor, lockName));
      if (lockStat !== undefined && (lockStat.isSymbolicLink() || !lockStat.isDirectory())) {
        throw new Error(`Brownfield assessment publication lock is unsafe: ${lockPath}`);
      }
      const finalStat = parent.descriptor === undefined
        ? await lstatIfPresent(finalPath)
        : await lstatIfPresent(descriptorChildPath(parent.descriptor, finalName));
      if (finalStat !== undefined) {
        throw errorWithCode("EEXIST", `Brownfield assessment bundle already exists: ${finalPath}`);
      }
      let stale: boolean;
      if (parent.descriptor === undefined) {
        stale = await lockIsStale(lockPath);
      } else {
        const lockDescriptor = await openRelativeDirectory(parent.descriptor, lockName);
        try {
          stale = await lockIsStale(lockPath, lockDescriptor);
        } finally {
          await lockDescriptor.close().catch(() => undefined);
        }
      }
      if (stale) {
        await quarantineStaleLock(parent, lockName, lockPath);
        continue;
      }
      await delay(1);
    }
  }
  throw new Error(`Timed out waiting to publish the brownfield assessment bundle: ${finalPath}`);
}

async function writeStagedText(
  stageDirectory: string,
  fileName: BundleFileName,
  text: string,
  stageDescriptor?: BundleFileHandle
): Promise<void> {
  const stagedPath = path.join(stageDirectory, fileName);
  let stagedHandle: BundleFileHandle | undefined;
  let completed = false;
  try {
    if (stageDescriptor === undefined) await assertStableAbsolutePath(stageDirectory, stageDirectory, false);
    stagedHandle = stageDescriptor === undefined
      ? await open(stagedPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG, 0o600)
      : await openRelativeFile(stageDescriptor, fileName, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await stagedHandle.writeFile(text, "utf8");
    await stagedHandle.sync();
    completed = true;
  } finally {
    await stagedHandle?.close().catch(() => undefined);
    if (!completed) {
      if (stageDescriptor === undefined) await rm(stagedPath, { force: true }).catch(() => undefined);
      else await removeRelative(stageDescriptor, fileName).catch(() => undefined);
    }
  }
}

async function syncBundleDirectory(directory: OpenedBundleDirectory): Promise<void> {
  if (directory.descriptor !== undefined) {
    try {
      await directory.descriptor.sync();
    } catch (error) {
      if (!(isNodeErrorCode(error, "EBADF") || isNodeErrorCode(error, "EINVAL") || isNodeErrorCode(error, "ENOTSUP") || isNodeErrorCode(error, "EPERM"))) throw error;
    }
    return;
  }
  await fsyncDirectoryIfSupported(directory.absolutePath);
}

async function publishStagedBundle(
  paths: BrownfieldAssessmentPaths,
  stagedPath: string,
  parent: OpenedBundleDirectory
): Promise<void> {
  const final = await resolveSafeBundlePath(path.dirname(path.dirname(path.dirname(parent.absolutePath))), paths.root);
  const finalName = path.basename(final.absolutePath);
  const stagedName = path.basename(stagedPath);
  const lock = await acquirePublishLock(parent, final.absolutePath, finalName);
  try {
    const existing = parent.descriptor === undefined
      ? await lstatIfPresent(final.absolutePath)
      : await lstatIfPresent(descriptorChildPath(parent.descriptor, finalName));
    if (existing !== undefined) {
      throw errorWithCode("EEXIST", `Brownfield assessment bundle already exists: ${paths.root}`);
    }
    if (parent.descriptor === undefined) {
      await assertStableFallbackPath(final, paths.root, true);
      await rename(stagedPath, final.absolutePath);
    } else {
      await rename(
        descriptorChildPath(parent.descriptor, stagedName),
        descriptorChildPath(parent.descriptor, finalName)
      );
    }
    await syncBundleDirectory(parent);
  } finally {
    await releasePublishLock(lock);
    await syncBundleDirectory(parent);
  }
}

async function openValidatedBundleFile(repositoryRoot: string, artifactPath: ArtifactPath): Promise<OpenedBundleFile> {
  const resolved = await resolveSafeBundlePath(repositoryRoot, artifactPath);
  if (await canUseDescriptorTraversal()) {
    const parentArtifactPath = artifactPathSchema.parse(artifactPath.slice(0, artifactPath.lastIndexOf("/")));
    const parent = await openBundleDirectory(repositoryRoot, parentArtifactPath, false);
    let descriptor: BundleFileHandle | undefined;
    try {
      descriptor = await openRelativeFile(parent.descriptor!, path.basename(artifactPath), fsConstants.O_RDONLY);
      const openedStat = await descriptor.stat();
      if (!openedStat.isFile()) throw new Error(`Brownfield assessment artifact is not a regular file: ${artifactPath}`);
      if (openedStat.size > MAX_BUNDLE_FILE_BYTES) throw boundedReadError(artifactPath);
      return { descriptor, openedStat };
    } catch (error) {
      await descriptor?.close().catch(() => undefined);
      throw error;
    } finally {
      await closeBundleDirectory(parent);
    }
  }

  await assertStableFallbackPath(resolved, artifactPath, false);
  const linkStat = await lstatIfPresent(resolved.absolutePath);
  if (linkStat === undefined) throw new Error(`Brownfield assessment artifact is missing: ${artifactPath}`);
  if (linkStat.isSymbolicLink()) throw new Error(`Brownfield assessment artifact must not be a symbolic link: ${artifactPath}`);
  if (!linkStat.isFile()) throw new Error(`Brownfield assessment artifact is not a regular file: ${artifactPath}`);

  const descriptor = await open(resolved.absolutePath, fsConstants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
  try {
    const openedStat = await descriptor.stat();
    if (!openedStat.isFile()) throw new Error(`Brownfield assessment artifact is not a regular file: ${artifactPath}`);
    const identity = sameFileIdentity(linkStat, openedStat);
    if (identity === false) throw new Error(`Brownfield assessment artifact changed while opening: ${artifactPath}`);
    if (openedStat.size > MAX_BUNDLE_FILE_BYTES) throw boundedReadError(artifactPath);
    await assertStableFallbackPath(resolved, artifactPath, false);
    return { descriptor, openedStat };
  } catch (error) {
    await descriptor.close().catch(() => undefined);
    throw error;
  }
}

async function readBoundedBundleText(
  descriptor: BundleFileHandle,
  openedStat: BundleStat,
  artifactPath: ArtifactPath
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const remaining = MAX_BUNDLE_FILE_BYTES + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(BUNDLE_READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
    if (totalBytes > MAX_BUNDLE_FILE_BYTES) throw boundedReadError(artifactPath);
  }
  const finalStat = await descriptor.stat();
  const finalIdentity = sameFileIdentity(openedStat, finalStat);
  if (!finalStat.isFile() || finalIdentity === false || finalStat.size !== totalBytes) {
    throw new Error(`Brownfield assessment artifact changed while reading: ${artifactPath}`);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readBundleJson(repositoryRoot: string, artifactPath: ArtifactPath): Promise<unknown> {
  const opened = await openValidatedBundleFile(repositoryRoot, artifactPath);
  try {
    const text = await readBoundedBundleText(opened.descriptor, opened.openedStat, artifactPath);
    return JSON.parse(text);
  } catch (error) {
    if (isNodeErrorCode(error, "ERR_BROWNFIELD_BUNDLE_SIZE") || String(error).includes("changed while reading")) throw error;
    throw new Error(`Brownfield assessment artifact is not valid JSON: ${artifactPath}`, { cause: error });
  } finally {
    await opened.descriptor.close();
  }
}

async function assertCompleteBundle(repositoryRoot: string, paths: BrownfieldAssessmentPaths): Promise<void> {
  const root = await openBundleDirectory(repositoryRoot, paths.root, false).catch((error) => {
    if (isNodeErrorCode(error, "ENOENT")) throw new Error(`Brownfield assessment bundle is missing: ${paths.root}`, { cause: error });
    throw error;
  });
  if (root.descriptor !== undefined) {
    try {
      let entries;
      try {
        entries = await readdir(descriptorPath(root.descriptor), { withFileTypes: true });
      } catch (error) {
        throw new Error(`Brownfield assessment bundle cannot be read: ${paths.root}`, { cause: error });
      }
      const expected = new Set<string>(BUNDLE_FILE_NAMES);
      if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name))) {
        throw new Error(`Brownfield assessment bundle is partial or contains unexpected files: ${paths.root}`);
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`Brownfield assessment bundle contains an unsafe file: ${paths.root}/${entry.name}`);
        }
        const descriptor = await openRelativeFile(root.descriptor, entry.name, fsConstants.O_RDONLY);
        try {
          const fileStat = await descriptor.stat();
          if (!fileStat.isFile()) throw new Error(`Brownfield assessment bundle contains an unsafe file: ${paths.root}/${entry.name}`);
        } finally {
          await descriptor.close();
        }
      }
    } finally {
      await closeBundleDirectory(root);
    }
    return;
  }

  try {
    const rootStat = await lstatIfPresent(root.absolutePath);
    if (rootStat === undefined) throw new Error(`Brownfield assessment bundle is missing: ${paths.root}`);
    if (rootStat.isSymbolicLink()) throw new Error(`Brownfield assessment bundle root must not be a symbolic link: ${paths.root}`);
    if (!rootStat.isDirectory()) throw new Error(`Brownfield assessment bundle root is not a directory: ${paths.root}`);
    let entries;
    try {
      entries = await readdir(root.absolutePath, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Brownfield assessment bundle cannot be read: ${paths.root}`, { cause: error });
    }
    const expected = new Set<string>(BUNDLE_FILE_NAMES);
    if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name))) {
      throw new Error(`Brownfield assessment bundle is partial or contains unexpected files: ${paths.root}`);
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Brownfield assessment bundle contains an unsafe file: ${paths.root}/${entry.name}`);
      }
    }
    for (const fileName of BUNDLE_FILE_NAMES) {
      const artifactPath = paths[fileName.slice(0, -5) as "state" | "signals" | "assumptions" | "findings" | "synthesis" | "review"];
      await resolveSafeBundlePath(repositoryRoot, artifactPath);
    }
  } finally {
    await closeBundleDirectory(root);
  }
}

function parseScope(scope: string): string {
  if (scope === ".") return scope;
  return codeIndexSourcePathSchema.parse(scope);
}

function diagnostic(message: string): Error {
  return new Error(`Brownfield assessment is blocked: ${message} Next action: ${REFRESH_ACTION}.`);
}

function inputProvenance(snapshot: LatestStructuralCodeIndex, scope: string): AssessmentProvenance {
  const parsedSnapshot = codeIndexSnapshotSchema.parse(snapshot.snapshot);
  const snapshotArtifact = artifactReferenceSchema.parse(snapshot.snapshotArtifact);
  const sqliteArtifact = artifactReferenceSchema.parse(snapshot.sqliteArtifact);
  const sqliteSha256 = stripSha256Prefix(sqliteArtifact.sha256);
  if (snapshotArtifact.path !== snapshot.semanticIndexArtifactPath ||
    parsedSnapshot.sqlite.path !== sqliteArtifact.path || parsedSnapshot.sqlite.sha256 !== sqliteSha256) {
    throw diagnostic("the structural snapshot artifact paths or SQLite provenance do not match their artifact references");
  }
  return {
    generatedAt: parsedSnapshot.generatedAt,
    scope,
    snapshotId: parsedSnapshot.snapshotId,
    sourceFingerprint: parsedSnapshot.sourceFingerprint,
    semanticIndexSha256: stripSha256Prefix(snapshotArtifact.sha256),
    semanticSqliteSha256: sqliteSha256
  };
}

function latestProvenance(latest: LatestStructuralCodeIndex): AssessmentProvenance {
  return inputProvenance(latest, latest.snapshot.scope);
}

function assertSameProvenance(expected: AssessmentProvenance, actual: AssessmentProvenance): void {
  const fields: readonly (keyof AssessmentProvenance)[] = [
    "scope",
    "snapshotId",
    "sourceFingerprint",
    "semanticIndexSha256",
    "semanticSqliteSha256",
    "generatedAt"
  ];
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      throw diagnostic(`structural snapshot provenance mismatch for ${field}; the assessment is bound to a different snapshot`);
    }
  }
}

async function validateFreshStructuralSnapshot(input: {
  readonly repositoryRoot: string;
  readonly expected: AssessmentProvenance;
  readonly supplied?: LatestStructuralCodeIndex;
}): Promise<LatestStructuralCodeIndex> {
  const now = new Date().toISOString();
  let mapState;
  try {
    mapState = await resolveMapState(input.repositoryRoot, input.expected.scope, now, "structural");
  } catch (error) {
    throw diagnostic(`unable to validate the latest structural snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ("error" in mapState) throw diagnostic(mapState.error);
  if (mapState.freshness !== "fresh") {
    throw diagnostic(`${mapState.reason} A fresh structural snapshot is required.`);
  }

  let discovery;
  try {
    discovery = await discoverLatestStructuralCodeIndex(input.repositoryRoot);
  } catch (error) {
    throw diagnostic(`unable to discover the latest structural snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = discovery.record;
  if (latest === undefined) {
    const details = discovery.diagnostics.map((entry) => entry.message).join("; ");
    throw diagnostic(`no usable structural snapshot exists${details.length > 0 ? `: ${details}` : "."}`);
  }
  const actual = latestProvenance(latest);
  assertSameProvenance(input.expected, actual);
  if (input.supplied !== undefined) {
    const suppliedProvenance = inputProvenance(input.supplied, input.expected.scope);
    assertSameProvenance(input.expected, suppliedProvenance);
    if (input.supplied.semanticIndexArtifactPath !== latest.semanticIndexArtifactPath ||
      input.supplied.semanticSqliteArtifactPath !== latest.semanticSqliteArtifactPath ||
      input.supplied.snapshot.sqlite.path !== latest.snapshot.sqlite.path) {
      throw diagnostic("the supplied structural snapshot artifact paths do not match the latest snapshot");
    }
  }
  return latest;
}

function assessmentIdFor(input: AssessmentProvenance, effort: number): string {
  const identity = [
    input.snapshotId,
    input.scope,
    String(effort),
    input.sourceFingerprint,
    input.semanticIndexSha256,
    input.semanticSqliteSha256,
    input.generatedAt
  ].join("\u0000");
  return `assess_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

function initialAssessment(input: {
  readonly assessmentId: string;
  readonly effort: number;
  readonly provenance: AssessmentProvenance;
}): BrownfieldAssessment {
  return brownfieldAssessmentSchema.parse({
    schemaVersion: 1,
    kind: "brownfield_assessment",
    assessmentId: input.assessmentId,
    generatedAt: input.provenance.generatedAt,
    effort: input.effort,
    phase: "setup",
    repositoryRoot: SAFE_REPOSITORY_ROOT,
    scope: input.provenance.scope,
    snapshotId: input.provenance.snapshotId,
    sourceFingerprint: input.provenance.sourceFingerprint,
    semanticIndexSha256: input.provenance.semanticIndexSha256,
    semanticSqliteSha256: input.provenance.semanticSqliteSha256,
    signals: {
      sourceFiles: 0,
      coverageFiles: 0,
      symbols: 0,
      imports: 0,
      exports: 0,
      testFiles: 0,
      testToSourceLinks: 0,
      dependencyEdges: 0,
      highRiskSignals: 0,
      unsupportedSignals: 0
    },
    assumptions: [],
    findings: [],
    nextActions: []
  });
}

async function readAssessmentState(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
  readonly paths: BrownfieldAssessmentPaths;
}): Promise<BrownfieldAssessment> {
  const value = await readBundleJson(input.repositoryRoot, input.paths.state);
  const state = brownfieldAssessmentSchema.parse(value);
  if (state.assessmentId !== input.assessmentId) {
    throw new Error(`Brownfield assessment state ID does not match its directory: ${input.assessmentId}`);
  }
  const recomputedAssessmentId = assessmentIdFor({
    generatedAt: state.generatedAt,
    scope: state.scope,
    snapshotId: state.snapshotId,
    sourceFingerprint: state.sourceFingerprint,
    semanticIndexSha256: state.semanticIndexSha256,
    semanticSqliteSha256: state.semanticSqliteSha256
  }, state.effort);
  if (recomputedAssessmentId !== input.assessmentId) {
    throw new Error(`Brownfield assessment identity does not match its directory or persisted state: ${input.assessmentId}`);
  }
  if (state.repositoryRoot !== SAFE_REPOSITORY_ROOT) {
    throw new Error(`Brownfield assessment repositoryRoot must be the safe repository-relative value '${SAFE_REPOSITORY_ROOT}'.`);
  }
  return state;
}

async function bundleRootStatus(repositoryRoot: string, paths: BrownfieldAssessmentPaths): Promise<"missing" | "existing"> {
  let root: OpenedBundleDirectory;
  try {
    root = await openBundleDirectory(repositoryRoot, paths.root, false);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
  try {
    if (root.descriptor !== undefined) return "existing";
    const rootStat = await lstatIfPresent(root.absolutePath);
    if (rootStat === undefined) return "missing";
    if (rootStat.isSymbolicLink()) throw new Error(`Brownfield assessment bundle root must not be a symbolic link: ${paths.root}`);
    if (!rootStat.isDirectory()) throw new Error(`Brownfield assessment bundle root is not a directory: ${paths.root}`);
    return "existing";
  } finally {
    await closeBundleDirectory(root);
  }
}

async function writeInitialBundle(input: {
  readonly repositoryRoot: string;
  readonly paths: BrownfieldAssessmentPaths;
  readonly state: BrownfieldAssessment;
}): Promise<void> {
  const parentArtifactPath = artifactPathSchema.parse(ASSESSMENT_ROOT);
  let parent = await openBundleDirectory(input.repositoryRoot, parentArtifactPath, true);
  if (parent.descriptor === undefined) {
    await mkdir(parent.absolutePath, { recursive: true });
    await closeBundleDirectory(parent);
    parent = await openBundleDirectory(input.repositoryRoot, parentArtifactPath, false);
  }

  const placeholder = stableProtocolJson([]);
  const contentByFile: Readonly<Record<BundleFileName, string>> = {
    "state.json": stableProtocolJson(input.state),
    "signals.json": placeholder,
    "assumptions.json": placeholder,
    "findings.json": placeholder,
    "synthesis.json": placeholder,
    "review.json": placeholder
  };
  const stageName = `.${path.basename(input.paths.root)}.${process.pid}.${randomUUID()}.staging`;
  const stagedPath = path.join(parent.absolutePath, stageName);
  let stageDirectory: OpenedBundleDirectory | undefined;
  let staged = false;
  try {
    if (parent.descriptor === undefined) {
      await assertStableFallbackPath(
        { repositoryRoot: parent.repositoryRoot, repositoryPath: parentArtifactPath, absolutePath: parent.absolutePath },
        parentArtifactPath,
        false
      );
      await mkdir(stagedPath, { mode: 0o700 });
      stageDirectory = { repositoryRoot: parent.repositoryRoot, absolutePath: stagedPath };
    } else {
      await mkdirRelative(parent.descriptor, stageName);
      stageDirectory = {
        repositoryRoot: parent.repositoryRoot,
        absolutePath: stagedPath,
        descriptor: await openRelativeDirectory(parent.descriptor, stageName)
      };
    }
    staged = true;
    for (const fileName of BUNDLE_FILE_NAMES) {
      await writeStagedText(stagedPath, fileName, contentByFile[fileName], stageDirectory.descriptor);
    }
    await syncBundleDirectory(stageDirectory);
    await publishStagedBundle(input.paths, stagedPath, parent);
    staged = false;
  } finally {
    await closeBundleDirectory(stageDirectory);
    if (staged) {
      if (parent.descriptor === undefined) await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
      else await removeRelative(parent.descriptor, stageName).catch(() => undefined);
    }
    await closeBundleDirectory(parent);
  }
}

export async function createBrownfieldAssessment(input: {
  readonly repositoryRoot: string;
  readonly effort: number;
  readonly scope?: string;
  readonly snapshot: LatestStructuralCodeIndex;
}): Promise<{ readonly assessmentId: string; readonly paths: BrownfieldAssessmentPaths }> {
  const effort = assessmentEffortSchema.parse(input.effort);
  let suppliedSnapshot;
  try {
    suppliedSnapshot = codeIndexSnapshotSchema.parse(input.snapshot?.snapshot);
  } catch (error) {
    let discovery;
    try {
      discovery = await discoverLatestStructuralCodeIndex(input.repositoryRoot);
    } catch (discoveryError) {
      throw diagnostic(`no usable structural snapshot exists: ${discoveryError instanceof Error ? discoveryError.message : String(discoveryError)}`);
    }
    if (discovery.record === undefined) {
      const details = discovery.diagnostics.map((entry) => entry.message).join("; ");
      throw diagnostic(`no usable structural snapshot exists${details.length > 0 ? `: ${details}` : "."}`);
    }
    throw error;
  }
  const scope = parseScope(input.scope ?? suppliedSnapshot.scope);
  if (suppliedSnapshot.scope !== scope) {
    throw diagnostic(`requested scope ${scope} does not exactly match the supplied structural snapshot scope ${suppliedSnapshot.scope}`);
  }
  const suppliedProvenance = inputProvenance(input.snapshot, scope);
  const latest = await validateFreshStructuralSnapshot({
    repositoryRoot: input.repositoryRoot,
    expected: suppliedProvenance,
    supplied: input.snapshot
  });
  const provenance = latestProvenance(latest);
  assertSameProvenance(suppliedProvenance, provenance);
  const assessmentId = assessmentIdFor(provenance, effort);
  const paths = assessmentPaths(assessmentId);
  const existingStatus = await bundleRootStatus(input.repositoryRoot, paths);
  if (existingStatus === "existing") {
    await assertCompleteBundle(input.repositoryRoot, paths);
    await readBrownfieldAssessment({ repositoryRoot: input.repositoryRoot, assessmentId });
    return { assessmentId, paths };
  }

  try {
    await writeInitialBundle({
      repositoryRoot: input.repositoryRoot,
      paths,
      state: initialAssessment({ assessmentId, effort, provenance })
    });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      await assertCompleteBundle(input.repositoryRoot, paths);
      await readBrownfieldAssessment({ repositoryRoot: input.repositoryRoot, assessmentId });
      return { assessmentId, paths };
    }
    throw error;
  }
  await assertCompleteBundle(input.repositoryRoot, paths);
  return { assessmentId, paths };
}

export async function readBrownfieldAssessment(input: {
  readonly repositoryRoot: string;
  readonly assessmentId: string;
}): Promise<{ readonly state: BrownfieldAssessment; readonly paths: BrownfieldAssessmentPaths }> {
  const assessmentId = input.assessmentId;
  const parsedAssessmentId = assessmentIdSchema.parse(assessmentId);
  const paths = assessmentPaths(parsedAssessmentId);
  await assertCompleteBundle(input.repositoryRoot, paths);
  const state = await readAssessmentState({ repositoryRoot: input.repositoryRoot, assessmentId: parsedAssessmentId, paths });
  for (const artifactPath of [paths.signals, paths.assumptions, paths.findings, paths.synthesis, paths.review]) {
    await readBundleJson(input.repositoryRoot, artifactPath);
  }
  const expected: AssessmentProvenance = {
    generatedAt: state.generatedAt,
    scope: state.scope,
    snapshotId: state.snapshotId,
    sourceFingerprint: state.sourceFingerprint,
    semanticIndexSha256: state.semanticIndexSha256,
    semanticSqliteSha256: state.semanticSqliteSha256
  };
  await validateFreshStructuralSnapshot({ repositoryRoot: input.repositoryRoot, expected });
  return { state, paths };
}
