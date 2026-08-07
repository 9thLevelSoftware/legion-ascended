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
 *  2. exactly EXPECTED_SKIPS tests skip — a new symlink test that bypasses the
 *     shared helper, or a deleted one, moves this number and reddens here;
 *  3. every skip carries a COVERAGE GAP diagnostic naming what did not run.
 *
 * What it does not prove: that the guards themselves work. That is what the same
 * tests assert on Linux and macOS, where the links can actually be created.
 */
import { spawnSync } from "node:child_process";

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

const problems = [];
if (result.status !== 0) {
  problems.push(`the suite exited ${result.status}; a missing symlink must skip a test, never break one`);
}
if (failures !== 0) problems.push(`${failures} test(s) failed under forced symlink unavailability`);
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

console.log(`check-symlink-coverage PASS: ${gaps} skip(s), each reported as a coverage gap, no failures.`);
