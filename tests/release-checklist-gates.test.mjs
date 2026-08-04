import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/**
 * The release checklist could report `ready` while GA-critical work was open.
 *
 * Nothing connected it to the task manifest, so P13-T04 — the GA sign-off task
 * itself — could be `todo` while the checklist declared the release ready. A
 * release declared ready over an open sign-off is a release declared ready by
 * the thing it was supposed to be waiting for.
 *
 * It also demanded `legion next migrate`, the P12 compatibility alias, while
 * MIGRATION-POLICY.md, ADR-009, docs/next/cli/README.md and the command's own
 * help all use `legion dev migrate`. The policy was right; the verifier was
 * wrong, and nobody had run it recently enough to notice.
 */

function runChecklist() {
  // The checklist exits non-zero when blocked, which is the point of a
  // fail-closed gate — so the verdict is read from stdout either way.
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/release/release-checklist.mjs", "--release-version", "9.0.0", "--repository-root", "."],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    );
  } catch (error) {
    assert.ok(error.stdout, `checklist produced no verdict: ${error.stderr ?? error.message}`);
    return JSON.parse(error.stdout);
  }
}

test("the migration policy check accepts the surface the CLI actually routes", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(!codes.includes("migration_policy_missing_cli_reference"), "the policy names legion dev migrate");
  assert.ok(!codes.includes("migration_policy_cli_surface_drift"), "the help text still names it too");
});

test("the checklist cannot report ready while GA-critical work is open", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);

  // P13-T04 is the GA sign-off, and the independent review is unsigned. Both
  // are the true state of this repository; if either is ever resolved, this
  // assertion should be updated rather than deleted.
  assert.equal(report.ok, false);
  assert.ok(codes.includes("ga_task_open"), "an open GA task must block");
  assert.ok(codes.includes("phase_13_review_unsigned"), "an unsigned review must block");
});

test("a prepared-but-unsigned review is distinguished from a missing one", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);
  // Writing the document must not be mistakable for signing it. Preparing the
  // artifact is mechanical; the verdict is a human's.
  assert.ok(!codes.includes("phase_13_review_missing"));
  assert.ok(codes.includes("phase_13_review_unsigned"));
});
