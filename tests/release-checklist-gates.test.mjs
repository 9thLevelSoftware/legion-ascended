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

test("the checklist still blocks on the one thing that is genuinely open", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);

  // This asserted `ga_task_open` and `phase_13_review_unsigned` while both were
  // the true state of this repository, with a note saying to update it when
  // either was resolved rather than delete it. Both are now resolved: P13-T04
  // is DONE and the phase-13 review is signed. What remains is the package
  // version, which is a release decision rather than work.
  //
  // The mechanism these used to cover is exercised on fixtures in
  // tests/release-checklist.test.mjs, where it can fail on demand. Asserting
  // the mechanism against the live repository only worked while the repository
  // happened to be in the failing state.
  assert.equal(report.ok, false);
  assert.deepEqual(codes, ["package_version_mismatch"]);
});

test("the phase-13 review is signed, and its verdict is read from its own section", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);

  // Neither missing nor unsigned. Writing the document must not be mistakable
  // for signing it, and the verdict is read from the `## Status` heading rather
  // than grepped for a keyword anywhere in the file — a FAIL verdict elsewhere
  // in the prose must not read as a pass, and explanatory text mentioning
  // PENDING must not read as unsigned.
  assert.ok(!codes.includes("phase_13_review_missing"));
  assert.ok(!codes.includes("phase_13_review_unsigned"));
  assert.ok(!codes.includes("phase_13_review_failed"));
  assert.ok(!codes.includes("phase_13_review_verdict_unreadable"));
});
