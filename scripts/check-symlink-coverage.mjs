#!/usr/bin/env node
/**
 * Prove the suite degrades honestly when file symlinks are unavailable.
 *
 * The configuration this checks — Windows without `SeCreateSymbolicLinkPrivilege`
 * — is the one CI could never see. GitHub's hosted Windows runners hold the
 * privilege, so every symlink guard passed there while a contributor on a stock
 * Windows box silently ran eight fewer security tests than CI did. Nine inline
 * `catch`/skip blocks accumulated under that blind spot, two of which inferred
 * "unavailable" from a missing outcome and would therefore have gone green
 * against a genuinely broken guard on *any* platform.
 *
 * So this forces the unprivileged split (file links absent, junctions present),
 * runs the files that own symlink tests, and asserts three things:
 *
 *  1. the run still passes — no test crashes when it cannot make a link;
 *  2. exactly EXPECTED_SKIPS tests skip, each reporting a COVERAGE GAP, so a
 *     removed or newly-guarded test moves the number and has to be decided on.
 *
 * Those two alone do **not** catch the case this check most needs to catch: a new
 * symlink test that never calls the shared helper. `LEGION_FORCE_SYMLINK_UNAVAILABLE`
 * is read only by the helper — it does not make `symlink()` fail in the subprocess —
 * so a test with its own inline creation would create a real link, pass, and leave
 * the count at EXPECTED_SKIPS. The first draft of this script claimed otherwise.
 *
 * So there is a third, independent check that does not depend on the run at all:
 *
 *  3. every test file that creates a symlink imports the capability helper.
 *
 * What none of it proves: that the guards themselves work. That is what the same
 * tests assert on Linux and macOS, where the links can actually be created.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Tests that need a *file* symlink, and so cannot run unprivileged on Windows.
 * Directory-link tests are excluded: junctions need no privilege, so they run.
 */
const EXPECTED_SKIPS = 7;

const FILES = [
  "tests/cli-workflow-ux.test.mjs",
  "tests/evals-sandbox.test.mjs",
  "tests/guarded-execution.test.mjs",
  "tests/intake-session-driver.test.mjs",
  "tests/pinned-references.test.mjs"
];

const result = spawnSync(process.execPath, ["--test", ...FILES], {
  encoding: "utf8",
  env: {
    ...process.env,
    LEGION_FORCE_SYMLINK_UNAVAILABLE: "file",
    LEGION_ALLOW_SYMLINK_SKIP: "1"
  }
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const gaps = output.match(/COVERAGE GAP:/gu)?.length ?? 0;
const failures = Number(/^\s*(?:ℹ|#)\s*fail (\d+)/mu.exec(output)?.[1] ?? "0");

/**
  * Every test file that creates a symlink must route through the shared helper.
  *
  * This is a source scan rather than a run assertion, because the run cannot see
  * a bypass: an inline `symlink()` succeeds on a privileged machine whatever the
  * forcing env says, and the skip count stays put. Scanning is the only way to
  * notice a guard test that quietly stopped participating.
  */
const HELPER = "helpers/symlink-capability.mjs";

/**
  * Files allowed to call `symlink` directly, each for a stated reason.
  *
  * Deliberately tiny and deliberately not a pattern: an allowlist that grows
  * without argument is how the nine inline blocks happened in the first place.
  */
const EXEMPT = new Map([
  [
    "windows-junction.test.mjs",
    "asserts what a junction *is* to lstat rather than testing a guard, and is already " +
      "platform-gated; routing it through the capability helper would make it assert the helper"
  ]
]);

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return /\.test\.(mjs|cjs)$/u.test(entry.name) ? [full] : [];
  });
}

const bypasses = testFiles("tests")
  .filter((file) => !EXEMPT.has(path.basename(file)))
  .filter((file) => {
    const source = readFileSync(file, "utf8");
    // `symlink(`, `symlinkSync(` or a destructured `symlink` call. Comments
    // mentioning the word are not calls, so the paren is required.
    if (!/(?<![A-Za-z])symlink(Sync)?\s*\(/u.test(source)) return false;
    return !source.includes(HELPER);
  });

const problems = [];
if (result.status !== 0) {
  problems.push(`the suite exited ${result.status}; a missing symlink must skip a test, never break one`);
}
if (failures !== 0) problems.push(`${failures} test(s) failed under forced symlink unavailability`);
for (const file of bypasses) {
  problems.push(
    `${file} creates a symlink without importing ${HELPER}. ` +
      "Route it through requireFileSymlink/requireDirSymlink, or add it to EXEMPT with the reason."
  );
}
if (gaps !== EXPECTED_SKIPS) {
  problems.push(
    `expected ${EXPECTED_SKIPS} COVERAGE GAP diagnostics, saw ${gaps}. ` +
      "A symlink test was added without tests/helpers/symlink-capability.mjs, or one was removed. " +
      "Update EXPECTED_SKIPS here in the same change, so the count stays a decision rather than a drift."
  );
}

if (problems.length > 0) {
  console.error("check-symlink-coverage FAILED:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\n--- test output ---\n");
  console.error(output);
  process.exit(1);
}

console.log(
  `check-symlink-coverage PASS: ${gaps} skip(s), each reported as a coverage gap, no failures; ` +
    "every symlink-creating test file routes through the capability helper."
);
