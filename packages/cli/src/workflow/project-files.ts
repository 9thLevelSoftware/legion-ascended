import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * List every file beneath a repository-relative directory, as POSIX paths.
 *
 * Used to snapshot the control-artifact tree before a writable dispatch.
 * Returns an empty list when the directory is absent, because a project that has
 * not been initialised has nothing to protect yet.
 */
export function listProjectFiles(repositoryRoot: string, relativeRoot: string): readonly string[] {
  const results: string[] = [];

  const walk = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(repositoryRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      // Symlinks are not followed: a link could otherwise walk the snapshot out
      // of the repository, and restoring through one would write outside it.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.isFile()) results.push(child);
    }
  };

  walk(relativeRoot);
  return results.sort();
}
