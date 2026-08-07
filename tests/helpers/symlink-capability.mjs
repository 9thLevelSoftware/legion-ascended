import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Whether this machine can create symlinks, and what the suite does when it cannot.
 *
 * Nine tests across five files guard symlink-shaped attacks: an executor
 * planting a link inside the protected tree, a pin whose path leaves the
 * repository through one, a protected acceptance test swapped for one whose
 * bytes still match. Every one of them needs a real link to exist before it can
 * assert anything.
 *
 * Windows refuses `symlink(2)` with `EPERM` unless the process holds
 * `SeCreateSymbolicLinkPrivilege` — granted by Developer Mode or elevation.
 * Each of those nine sites had grown its own inline `catch`/skip, and they had
 * drifted into three different error-code sets and two genuinely unsafe shapes:
 * one that swallowed every error including `ENOENT`, and two that inferred
 * unavailability from a *missing outcome* rather than from an error at all.
 * That last shape is the dangerous one — a regression in the guard under test
 * produces exactly the same missing outcome, so those tests would have gone
 * quietly green on Linux while the thing they protect was broken.
 *
 * So capability is probed once, here, from an error object, and the default
 * when it is absent is to **fail**. A security boundary that silently stops
 * being tested is worse than a red build: the red build gets fixed.
 *
 * `LEGION_ALLOW_SYMLINK_SKIP=1` downgrades the failure to a skip for
 * contributors who cannot enable Developer Mode. It is a real escape hatch and
 * it forfeits real coverage, so it says so every time it is used.
 */

const UNAVAILABLE_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP"]);

const SETUP_HINT = [
  "Symlink creation is unavailable in this environment, so security-boundary tests cannot run.",
  "",
  "On Windows, enable Developer Mode:",
  "  Settings > System > For developers > Developer Mode: On",
  "or run the test suite from an elevated shell.",
  "",
  "To run anyway and forfeit this coverage:",
  "  LEGION_ALLOW_SYMLINK_SKIP=1 pnpm test"
].join("\n");

let cached;

/**
 * Force the probe to report file symlinks unavailable.
 *
 * GitHub's hosted Windows runners *do* hold symlink privilege, so the
 * unprivileged-Windows configuration — the one every contributor on a stock
 * Windows box actually runs — is the single configuration CI could never
 * observe. That is precisely how nine inline skips accumulated unnoticed.
 *
 * Setting this to `file` reproduces that machine anywhere: file links absent,
 * directory links still available through junctions, which is exactly the split
 * a real unprivileged Windows box has. It simulates the *environment*, never the
 * assertion — a forced run still executes every test that does not need a file
 * link, and still fails if one of them breaks.
 */
const FORCED = process.env.LEGION_FORCE_SYMLINK_UNAVAILABLE;

function probe() {
  const root = mkdtempSync(path.join(tmpdir(), "legion-symlink-probe-"));
  try {
    const fileTarget = path.join(root, "target.txt");
    writeFileSync(fileTarget, "probe", "utf8");
    const result = { file: false, dir: false, fileReason: undefined, dirReason: undefined };

    if (FORCED === "file" || FORCED === "all") {
      result.fileReason = "forced by LEGION_FORCE_SYMLINK_UNAVAILABLE";
    } else {
      try {
        symlinkSync(fileTarget, path.join(root, "file-link"), "file");
        result.file = true;
      } catch (error) {
        // Anything outside the known-unavailable set is a broken probe, not a
        // limited platform, and must not be reported as "no privilege here".
        if (!UNAVAILABLE_CODES.has(String(error?.code))) throw error;
        result.fileReason = String(error.code);
      }
    }

    if (FORCED === "all") {
      result.dirReason = "forced by LEGION_FORCE_SYMLINK_UNAVAILABLE";
    } else {
      try {
        // `"dir"` needs the same privilege as `"file"` on Windows; `"junction"`
        // does not. Probing the junction fallback is what lets the
        // directory-link tests keep running unprivileged. The probe root is
        // itself a directory, so it serves as the target.
        symlinkSync(root, path.join(root, "dir-link"), directoryLinkType());
        result.dir = true;
      } catch (error) {
        if (!UNAVAILABLE_CODES.has(String(error?.code))) throw error;
        result.dirReason = String(error.code);
      }
    }

    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Memoized capability probe. Runs at most once per process. */
export function symlinkCapability() {
  cached ??= probe();
  return cached;
}

/**
 * The directory-link type this platform can actually create.
 *
 * Windows junctions need no privilege but are directory-only and require an
 * absolute target, which is why this is not simply `"dir"` everywhere.
 */
export function directoryLinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function unavailable(t, what, reason) {
  if (process.env.LEGION_ALLOW_SYMLINK_SKIP === "1") {
    t.diagnostic(
      `COVERAGE GAP: ${what} symlink creation unavailable (${reason ?? "unknown"}); ` +
        "this security-boundary assertion did not run."
    );
    t.skip(`${what} symlink unavailable (${reason ?? "unknown"})`);
    return false;
  }
  throw new Error(`${what} symlink creation unavailable (${reason ?? "unknown"}).\n\n${SETUP_HINT}`);
}

/**
 * Require file-symlink capability, or fail the run with actionable setup steps.
 *
 * Returns `true` when the caller may proceed. Returns `false` only under the
 * documented opt-out, in which case the test has already been marked skipped
 * and the caller must `return`.
 */
export function requireFileSymlink(t) {
  const capability = symlinkCapability();
  if (capability.file) return true;
  return unavailable(t, "file", capability.fileReason);
}

/** As {@link requireFileSymlink}, for directory links. Junction-backed on Windows. */
export function requireDirSymlink(t) {
  const capability = symlinkCapability();
  if (capability.dir) return true;
  return unavailable(t, "directory", capability.dirReason);
}
