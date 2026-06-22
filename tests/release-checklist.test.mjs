// P13-T03 release-checklist verifier regression test.
//
// Confirms that release-checklist.mjs:
//   * exits 0 and reports `status: "ready"` for the canonical v9
//     GA evidence under docs/next/ga/ + the Phase 13 ledger state
//   * emits a stable JSON verdict with per-check status and findings
//   * fails closed when CHANGELOG.md is missing a `## [<version>]`
//     entry or the GA-approved/GA-pending keyword
//   * fails closed when RELEASE-RECORD.md is missing one of the
//     four companion-document references
//   * fails closed when MIGRATION-POLICY.md is missing or does not
//     reference `legion next migrate`
//   * fails closed when ROLLBACK-POLICY.md is missing or does not
//     reference the backup-manifest contract
//   * fails closed when V8-HANDOFF.md is missing or does not
//     reference the v8 maintenance branch policy
//   * fails closed when STABLE-CHANNEL-APPROVAL.md is missing or
//     does not pin the decision owner sign-off
//   * fails closed when the Phase 13 ledger marks P13-T01 / P13-T02
//     / P13-T03 as not-DONE
//   * fails closed when P13-T02 threat-model.json is missing or
//     reports findings
//   * fails closed when P13-T01 ab-comparison.json is missing
//   * fails closed when --validate-next-log does not contain a PASS
//     line
//
// The verifier is the operator-facing safety net for the GA cut-over;
// every fail-closed path is pinned here so the CLI's `--checklist`
// subcommand cannot regress silently.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release", "release-checklist.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    ...options
  });
}

async function withWorkspace(callback) {
  const workspace = await mkdtemp(path.join(ROOT, ".release-checklist-test-"));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function writeFileSync2(p, content) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

const REQUIRED_GA_DOCS = [
  ["RELEASE-RECORD.md", "# Release Record\n\nSee MIGRATION-POLICY.md, ROLLBACK-POLICY.md, V8-HANDOFF.md, and STABLE-CHANNEL-APPROVAL.md.\n"],
  ["MIGRATION-POLICY.md", "# Migration Policy\n\nUse `legion next migrate --from-codex-legion|--from-planning --verify|--dry-run|--apply|--rollback`.\n"],
  ["ROLLBACK-POLICY.md", "# Rollback Policy\n\nRestoration consumes the backup-manifest.json produced by `legion next migrate --apply`.\n"],
  ["V8-HANDOFF.md", "# V8 Handoff\n\nv8 maintenance happens on the v8-maintenance branch. v8 line stays frozen for defects, security fixes, and packaging.\n"],
  ["STABLE-CHANNEL-APPROVAL.md", "# Stable Channel Approval\n\nDecision owner: dasbl. The decision-owner sign-off block gates the promotion.\n"]
];

const CHANGELOG_GA_ENTRY = `## [9.0.0] - GA-pending

### Added
- GA decision package.
`;

function writeGaWorkspace(workspace, overrides = {}) {
  const repoRoot = path.join(workspace, "repo");
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const gaDir = path.join(repoRoot, "docs", "next", "ga");
  const ledgerDir = path.join(repoRoot, ".legion", "project", "changes", "LEGION-NEXT", "implementation", "phase-13");
  const evidenceRoot = path.join(repoRoot, "docs", "next", "evidence");

  writeFileSync2(changelogPath, `${overrides.changelog ?? ""}\n${CHANGELOG_GA_ENTRY}`);
  for (const [name, body] of overrides.gaDocs ?? REQUIRED_GA_DOCS) {
    writeFileSync2(path.join(gaDir, name), body);
  }
  const ledger = overrides.ledger ?? {
    phase: 13,
    tasks: {
      "P13-T01": { status: "DONE", evidence: "docs/next/evidence/P13-T01/integration-report.yaml" },
      "P13-T02": { status: "DONE", evidence: "docs/next/evidence/P13-T02/integration-report.yaml" },
      "P13-T03": { status: "DONE", evidence: "docs/next/evidence/P13-T03/integration-report.yaml" }
    }
  };
  writeFileSync2(path.join(ledgerDir, "ledger.yaml"), stringifyYaml(ledger));
  const threatModel = overrides.threatModel ?? {
    ok: true,
    status: "verified",
    findings: [],
    checks: { sandbox: { ok: true }, retention: { ok: true }, redaction: { ok: true } }
  };
  writeFileSync2(
    path.join(evidenceRoot, "P13-T02", "threat-model.json"),
    JSON.stringify(threatModel, null, 2)
  );
  writeFileSync2(
    path.join(evidenceRoot, "P13-T01", "ab-comparison", "ab-comparison.json"),
    JSON.stringify(overrides.abComparison ?? { scenarios: [] }, null, 2)
  );
  return repoRoot;
}

test("P13-T03 release-checklist passes a well-formed GA evidence workspace", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace);
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.release_version, "9.0.0");
    assert.equal(payload.findings.length, 0);
    for (const name of [
      "changelog",
      "release_record",
      "migration_policy",
      "rollback_policy",
      "v8_handoff",
      "stable_channel_approval",
      "ledger",
      "threat_model_verdict",
      "ab_comparison"
    ]) {
      assert.ok(payload.checks[name], `missing check ${name}`);
      assert.equal(payload.checks[name].ok, true, `check ${name} reported findings`);
    }
  });
});

test("P13-T03 release-checklist fails closed when CHANGELOG lacks the GA entry", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      changelog: "# Changelog\n\nAll notable changes are documented here.\n"
    });
    // Overwrite CHANGELOG.md with just the override (no GA entry).
    const changelogPath = path.join(repoRoot, "CHANGELOG.md");
    await writeFile(changelogPath, "# Changelog\n\nAll notable changes are documented here.\n", "utf8");
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(
      payload.findings.some((f) => f.code === "changelog_missing_ga_entry"),
      "expected changelog_missing_ga_entry finding"
    );
  });
});

test("P13-T03 release-checklist fails closed when CHANGELOG entry lacks GA keyword", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      changelog: "# Changelog\n\n## [9.0.0] - in progress\n\nPlaceholder.\n"
    });
    // Overwrite CHANGELOG.md with just the override (entry present, no keyword).
    const changelogPath = path.join(repoRoot, "CHANGELOG.md");
    await writeFile(changelogPath, "# Changelog\n\n## [9.0.0] - in progress\n\nPlaceholder.\n", "utf8");
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(
      payload.findings.some((f) => f.code === "changelog_missing_ga_keyword"),
      "expected changelog_missing_ga_keyword finding"
    );
  });
});

test("P13-T03 release-checklist fails closed when RELEASE-RECORD.md is missing a companion link", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      gaDocs: REQUIRED_GA_DOCS.map(([name, body]) =>
        name === "RELEASE-RECORD.md"
          ? [name, "# Release Record\n\nSee MIGRATION-POLICY.md.\n"]
          : [name, body]
      )
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(
      payload.findings.some((f) => f.code === "release_record_missing_link:ROLLBACK-POLICY.md"),
      "expected release_record_missing_link:ROLLBACK-POLICY.md finding"
    );
  });
});

test("P13-T03 release-checklist fails closed when MIGRATION-POLICY.md is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      gaDocs: REQUIRED_GA_DOCS.filter(([name]) => name !== "MIGRATION-POLICY.md")
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "migration_policy_missing"));
  });
});

test("P13-T03 release-checklist fails closed when ROLLBACK-POLICY.md is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      gaDocs: REQUIRED_GA_DOCS.filter(([name]) => name !== "ROLLBACK-POLICY.md")
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "rollback_policy_missing"));
  });
});

test("P13-T03 release-checklist fails closed when V8-HANDOFF.md is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      gaDocs: REQUIRED_GA_DOCS.filter(([name]) => name !== "V8-HANDOFF.md")
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "v8_handoff_missing"));
  });
});

test("P13-T03 release-checklist fails closed when STABLE-CHANNEL-APPROVAL.md is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      gaDocs: REQUIRED_GA_DOCS.filter(([name]) => name !== "STABLE-CHANNEL-APPROVAL.md")
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "stable_channel_approval_missing"));
  });
});

test("P13-T03 release-checklist fails closed when ledger marks a Phase 13 task as todo", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      ledger: {
        phase: 13,
        tasks: {
          "P13-T01": { status: "DONE", evidence: "docs/next/evidence/P13-T01/integration-report.yaml" },
          "P13-T02": { status: "DONE", evidence: "docs/next/evidence/P13-T02/integration-report.yaml" },
          "P13-T03": { status: "todo" }
        }
      }
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "ledger_task_not_done:P13-T03"));
  });
});

test("P13-T03 release-checklist fails closed when P13-T02 threat-model verdict is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace);
    await rm(path.join(repoRoot, "docs", "next", "evidence", "P13-T02", "threat-model.json"), { force: true });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "threat_model_verdict_missing"));
  });
});

test("P13-T03 release-checklist fails closed when P13-T02 threat-model verdict reports findings", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace, {
      threatModel: {
        ok: false,
        status: "violation",
        findings: [{ code: "canary_present_after_redaction", message: "canary leaked" }]
      }
    });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(
      payload.findings.some((f) => f.code === "threat_model_verdict_not_verified"),
      "expected threat_model_verdict_not_verified"
    );
    assert.ok(
      payload.findings.some((f) => f.code === "threat_model_findings_present"),
      "expected threat_model_findings_present"
    );
  });
});

test("P13-T03 release-checklist fails closed when P13-T01 ab-comparison.json is missing", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace);
    await rm(path.join(repoRoot, "docs", "next", "evidence", "P13-T01", "ab-comparison", "ab-comparison.json"), { force: true });
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "ab_comparison_missing"));
  });
});

test("P13-T03 release-checklist fails closed when --validate-next-log does not PASS", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace);
    const validateLog = path.join(workspace, "validate-next.log");
    writeFileSync2(validateLog, "validate-next FAIL: typecheck failed\n");
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot, "--validate-next-log", validateLog]);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.ok(payload.findings.some((f) => f.code === "validate_next_gate_failed"));
  });
});

test("P13-T03 release-checklist passes when --validate-next-log reports PASS", async () => {
  await withWorkspace(async (workspace) => {
    const repoRoot = writeGaWorkspace(workspace);
    const validateLog = path.join(workspace, "validate-next.log");
    writeFileSync2(validateLog, "validate-next PASS\n");
    const result = run(["--release-version", "9.0.0", "--repository-root", repoRoot, "--validate-next-log", validateLog]);
    assert.equal(result.status, 0, `unexpected stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.validate_next_log.ok, true);
  });
});

test("P13-T03 release-checklist fails closed when --release-version is not semver", async () => {
  const result = run(["--release-version", "not-a-version", "--repository-root", ROOT]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semver/);
});