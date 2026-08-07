import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * What a Windows junction looks like to the guards, pinned.
 *
 * Six production modules decide whether to refuse a path by asking
 * `lstat().isSymbolicLink()` or `Dirent.isSymbolicLink()`:
 * `artifacts/src/paths.ts` (`rejectFinalSymlink`), `cli/src/workflow/
 * project-files.ts`, `guarded-execution.ts` (`classifyAcceptancePath`),
 * `intake/driver.ts` (`classifyRoadmap`), `requirements/service.ts`, and
 * `legacy-bridge/src/import-codex` (`validateNoSymbolicLinks`).
 *
 * On Windows a *junction* is a second kind of reparse point, created without
 * the privilege a symlink needs. If `isSymbolicLink()` did not report one, every
 * guard above would be bypassable on Windows by substituting a junction for the
 * symlink it refuses — the guards would still be "passing" on Linux while a
 * Windows operator had no protection at all.
 *
 * libuv maps both `IO_REPARSE_TAG_SYMLINK` and `IO_REPARSE_TAG_MOUNT_POINT` to
 * `S_IFLNK`, so the answer is yes. Nothing in this repository said so. Every
 * junction test that existed asserted a `realpath`-based containment check,
 * which resolves junctions whatever `isSymbolicLink()` returns, so none of them
 * touched this. That left the assumption load-bearing and unpinned; this file
 * is the pin, and it reddens if a Node or libuv change ever moves it.
 */

const describeOnWindows = process.platform === "win32" ? test : test.skip;

describeOnWindows("a Windows junction is a symlink to lstat, so the guards see it", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "legion-junction-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const target = path.join(root, "target-dir");
  mkdirSync(target);
  writeFileSync(path.join(target, "inside.txt"), "inside\n", "utf8");

  const link = path.join(root, "link");
  // Junctions need no privilege, but the target must be an existing absolute
  // directory. If this throws, the assumption under test is moot on this box.
  symlinkSync(target, link, "junction");

  const stats = lstatSync(link);

  // The load-bearing one. A `false` here means every `isSymbolicLink()` guard in
  // the codebase is bypassable on Windows with a junction.
  assert.equal(stats.isSymbolicLink(), true, "a junction must report as a symbolic link to lstat");

  // `lstat` must not follow it, or a guard would classify the link as the
  // directory it points at and let it through as an ordinary path.
  assert.equal(stats.isDirectory(), false, "lstat must not resolve the junction to its target");

  // `guarded-execution.ts` records the target so a retarget is detectable and a
  // restore is possible; both need `readlink` to answer for a junction.
  assert.equal(
    path.resolve(readlinkSync(link)),
    path.resolve(target),
    "readlink must report the junction target"
  );
});
