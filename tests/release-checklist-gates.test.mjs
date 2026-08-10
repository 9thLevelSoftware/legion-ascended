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
        ["scripts/release/release-checklist.mjs", "--release-version", "9.0.1", "--repository-root", "."],
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

test("the checklist reports ready, and every condition it names is genuinely closed", () => {
  const report = runChecklist();
  const codes = report.findings.map((finding) => finding.code);

  // This assertion has inverted, and the inversion is the point of the test
  // rather than a loosening of it.
  //
  // It began as a list of what was open, with each entry deleted when the
  // repository actually resolved it rather than the assertion being relaxed:
  // `ga_task_open` and `phase_13_review_unsigned` went when P13-T04 was marked
  // DONE and the phase-13 review was signed; `whole_change_acceptance_unproven`
  // went the way its own producer said it would — "when acceptance lands and
  // the assertion flips to `ready`, this stops firing on its own" — because the
  // ship-gate series gave whole-change acceptance a producer and
  // `scripts/dogfood-workflow.mjs` now asserts `ready`; and
  // `package_version_mismatch` went when `package.json` was reconciled to the
  // 9.0.1 release identity.
  //
  // The list is empty, so what is left to assert is the whole verdict. It is
  // asserted as a whole deliberately: `deepEqual([], [])` would also pass
  // against a checklist that had stopped running, and the distance between
  // "nothing is open" and "nothing was checked" is the entire value of a
  // fail-closed gate.
  //
  // If this reddens, the repository has regressed out of a releasable state.
  // The finding it names says which condition, and the fix is to close that
  // condition — not to add it back to an expected-findings list.
  assert.deepEqual(codes, [], `the release checklist must stay clean, got ${JSON.stringify(report.findings)}`);
  assert.equal(report.ok, true);
  assert.equal(report.status, "ready");

  // Every check ran and passed, rather than the findings array merely being
  // empty. The mechanism itself is exercised on fixtures in
  // tests/release-checklist.test.mjs, where it can be made to fail on demand.
  const checks = Object.values(report.checks ?? {});
  assert.ok(checks.length > 0, "the verdict must carry its per-check breakdown");
  assert.deepEqual(
    checks.filter((check) => check.ok !== true).map((check) => check.name),
    [],
    "a ready verdict requires every named check to have passed, not merely to have produced no finding"
  );
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
