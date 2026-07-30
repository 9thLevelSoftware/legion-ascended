import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * An entry in the protected tree, classified without following symlinks.
 *
 * Symlinks are recorded rather than skipped. Skipping them made a link created
 * beneath `.legion/project` invisible to both the snapshot and the post-run
 * scan, so an executor could plant one, have the run report `inContract: true`,
 * and leave it for a later command to follow. They are never traversed or read
 * through — only noted, so they can be detected and removed.
 */
export interface ProjectFileEntry {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly kind: "file" | "symlink";
  /** Byte size for regular files; `undefined` when it could not be read. */
  readonly size: number | undefined;
}

/**
 * List every entry beneath a repository-relative directory.
 *
 * Returns an empty list when the directory is absent, because a project that has
 * not been initialised has nothing to protect yet.
 */
export function listProjectFiles(
  repositoryRoot: string,
  relativeRoot: string
): readonly ProjectFileEntry[] {
  const results: ProjectFileEntry[] = [];

  // Classify the root itself before walking it. `readdirSync` follows a
  // symlinked directory, and only descendants get a `Dirent` to classify — so a
  // run that replaced `.legion/project` with a link would have its target's
  // contents listed as protected files, and containment would write the saved
  // artifacts through the surviving link while never restoring the real control
  // directory. The root is reported as its own entry instead, so it is detected
  // and unlinked like any other planted link.
  try {
    if (lstatSync(path.join(repositoryRoot, relativeRoot)).isSymbolicLink()) {
      return [{ path: relativeRoot, kind: "symlink", size: undefined }];
    }
  } catch {
    return [];
  }

  const walk = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(repositoryRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        results.push({ path: child, kind: "symlink", size: undefined });
        continue;
      }
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number | undefined;
      try {
        size = lstatSync(path.join(repositoryRoot, child)).size;
      } catch {
        size = undefined;
      }
      results.push({ path: child, kind: "file", size });
    }
  };

  walk(relativeRoot);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}
