#!/usr/bin/env node
// P13-T03 release checklist — fail-closed GA gate.
//
// Verifies that every precondition for a stable-channel v9 GA release is
// met before `dasbl` (or any operator using the checklist as a CI gate)
// approves the release record. The validator is intentionally read-only:
// it inspects on-disk artefacts and emits a JSON verdict.
//
// Preconditions enforced:
//   1. CHANGELOG has a `## [<releaseVersion>]` entry that declares either
//      `GA-approved` or `GA-pending`.
//   2. docs/next/ga/RELEASE-RECORD.md exists and links to every
//      companion document (MIGRATION-POLICY, ROLLBACK-POLICY, V8-HANDOFF,
//      STABLE-CHANNEL-APPROVAL).
//   3. docs/next/ga/MIGRATION-POLICY.md exists and references the
//      canonical `legion next migrate` CLI surface.
//   4. docs/next/ga/ROLLBACK-POLICY.md exists and references the
//      backup-manifest + restore procedure used by
//      `legion next migrate --rollback`.
//   5. docs/next/ga/V8-HANDOFF.md exists and pins the v8 maintenance
//      branch policy and the v8 line.
//   6. docs/next/ga/STABLE-CHANNEL-APPROVAL.md exists and pins the
//      sign-off gate (decision owner: dasbl).
//   7. Phase 13 ledger
//      (`.legion/project/changes/LEGION-NEXT/implementation/phase-13/
//      ledger.yaml`) lists P13-T01, P13-T02, and P13-T03 as DONE with
//      non-empty evidence paths.
//   8. P13-T02 threat-model.json exists and reports `ok: true` with zero
//      findings.
//   9. P13-T01 ab-comparison.json exists (fail-closed contract; v8 cells
//      may legitimately be `null`).
//  10. validate-next.mjs ran recently and the recorded gate outcomes are
//      all green (recorded in --validate-next-log if supplied).
//
// Failure modes (each emits a stable `code` so CI gates can grep without
// parsing free-form text):
//   * changelog_missing_ga_entry
//   * changelog_missing_ga_keyword
//   * changelog_missing
//   * release_record_missing
//   * release_record_missing_link:<doc>
//   * migration_policy_missing
//   * migration_policy_missing_cli_reference
//   * rollback_policy_missing
//   * rollback_policy_missing_manifest_reference
//   * v8_handoff_missing
//   * v8_handoff_missing_branch_reference
//   * stable_channel_approval_missing
//   * stable_channel_approval_missing_signoff
//   * ledger_missing_phase13
//   * ledger_task_not_done:<task-id>
//   * ledger_task_missing_evidence:<task-id>
//   * ledger_yaml_invalid
//   * threat_model_verdict_missing
//   * threat_model_verdict_invalid
//   * threat_model_verdict_not_verified
//   * threat_model_findings_present
//   * ab_comparison_missing
//   * validate_next_log_missing
//   * validate_next_gate_failed
//
// Usage:
//   node scripts/release/release-checklist.mjs \
//     --release-version 9.0.0 \
//     [--repository-root /path/to/legion-next] \
//     [--report /path/to/release-checklist.json] \
//     [--validate-next-log /path/to/validate-next.log]

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function ensureString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument --${name}.`);
  }
  return value;
}

function ensureSemver(value, name) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`--${name} must be a semver string (got: ${JSON.stringify(value)}).`);
  }
  return value;
}

function findLinksTo(text, target) {
  // Accept the standard Markdown forms: bare relative path or
  // `<relative-path>` or `(relative-path)`. We do not validate that the
  // link target resolves on disk; we only need to confirm the GA
  // decision record names every companion document.
  const normalised = text.replace(/\r\n/g, "\n");
  return normalised.includes(target);
}

function auditChangelog({ changelogPath, releaseVersion }) {
  const findings = [];
  if (!existsSync(changelogPath)) {
    findings.push({
      code: "changelog_missing",
      message: `CHANGELOG.md not found at ${changelogPath}.`
    });
    return findings;
  }
  const text = readFileSync(changelogPath, "utf8");
  // The GA entry must mention the release version. We accept either
  // "GA-approved" or "GA-pending" so the checklist can run before and
  // after final approval.
  const versionNeedle = `## [${releaseVersion}]`;
  if (!text.includes(versionNeedle)) {
    findings.push({
      code: "changelog_missing_ga_entry",
      message: `CHANGELOG.md is missing an entry for ${releaseVersion}; expected a \`## [${releaseVersion}]\` section.`
    });
    return findings;
  }
  if (!text.includes("GA-approved") && !text.includes("GA-pending")) {
    findings.push({
      code: "changelog_missing_ga_keyword",
      message: `CHANGELOG.md ${releaseVersion} entry is present but does not declare "GA-approved" or "GA-pending" status.`
    });
  }
  return findings;
}

function auditReleaseRecord({ gaDir }) {
  const findings = [];
  const recordPath = path.join(gaDir, "RELEASE-RECORD.md");
  if (!existsSync(recordPath)) {
    findings.push({
      code: "release_record_missing",
      message: `Release record not found at ${recordPath}.`
    });
    return findings;
  }
  const text = readFileSync(recordPath, "utf8");
  const required = ["MIGRATION-POLICY.md", "ROLLBACK-POLICY.md", "V8-HANDOFF.md", "STABLE-CHANNEL-APPROVAL.md"];
  for (const requiredDoc of required) {
    if (!findLinksTo(text, requiredDoc)) {
      findings.push({
        code: `release_record_missing_link:${requiredDoc}`,
        message: `RELEASE-RECORD.md does not reference ${requiredDoc}; the GA decision package must point at every companion document.`
      });
    }
  }
  return findings;
}

function auditMigrationPolicy({ gaDir }) {
  const findings = [];
  const policyPath = path.join(gaDir, "MIGRATION-POLICY.md");
  if (!existsSync(policyPath)) {
    findings.push({
      code: "migration_policy_missing",
      message: `Migration policy not found at ${policyPath}.`
    });
    return findings;
  }
  const text = readFileSync(policyPath, "utf8");
  if (!text.includes("legion next migrate")) {
    findings.push({
      code: "migration_policy_missing_cli_reference",
      message: `MIGRATION-POLICY.md does not reference the canonical \`legion next migrate\` CLI surface.`
    });
  }
  return findings;
}

function auditRollbackPolicy({ gaDir }) {
  const findings = [];
  const policyPath = path.join(gaDir, "ROLLBACK-POLICY.md");
  if (!existsSync(policyPath)) {
    findings.push({
      code: "rollback_policy_missing",
      message: `Rollback policy not found at ${policyPath}.`
    });
    return findings;
  }
  const text = readFileSync(policyPath, "utf8");
  if (!text.includes("backup-manifest") && !text.includes("backupManifest")) {
    findings.push({
      code: "rollback_policy_missing_manifest_reference",
      message: `ROLLBACK-POLICY.md does not reference the backup-manifest consumed by \`legion next migrate --rollback\`.`
    });
  }
  return findings;
}

function auditV8Handoff({ gaDir }) {
  const findings = [];
  const docPath = path.join(gaDir, "V8-HANDOFF.md");
  if (!existsSync(docPath)) {
    findings.push({
      code: "v8_handoff_missing",
      message: `v8 handoff not found at ${docPath}.`
    });
    return findings;
  }
  const text = readFileSync(docPath, "utf8");
  if (!text.includes("v8-maintenance") && !text.includes("v8 maintenance") && !text.includes("v8 line")) {
    findings.push({
      code: "v8_handoff_missing_branch_reference",
      message: `V8-HANDOFF.md does not reference the v8 maintenance branch policy or the v8 line.`
    });
  }
  return findings;
}

function auditStableChannelApproval({ gaDir }) {
  const findings = [];
  const docPath = path.join(gaDir, "STABLE-CHANNEL-APPROVAL.md");
  if (!existsSync(docPath)) {
    findings.push({
      code: "stable_channel_approval_missing",
      message: `Stable-channel approval record not found at ${docPath}.`
    });
    return findings;
  }
  const text = readFileSync(docPath, "utf8");
  if (!text.includes("dasbl") || (!text.includes("Decision owner") && !text.includes("decision owner") && !text.includes("decision-owner"))) {
    findings.push({
      code: "stable_channel_approval_missing_signoff",
      message: `STABLE-CHANNEL-APPROVAL.md does not pin the decision owner (dasbl) sign-off gate.`
    });
  }
  return findings;
}

async function auditLedger({ ledgerPath }) {
  const findings = [];
  if (!existsSync(ledgerPath)) {
    findings.push({
      code: "ledger_missing_phase13",
      message: `Phase 13 ledger not found at ${ledgerPath}.`
    });
    return findings;
  }
  const text = await readFile(ledgerPath, "utf8");
  let ledger;
  try {
    ledger = parseYaml(text);
  } catch (error) {
    findings.push({
      code: "ledger_yaml_invalid",
      message: `Phase 13 ledger is not valid YAML: ${error?.message ?? error}`
    });
    return findings;
  }
  const tasks = ledger?.tasks ?? {};
  const required = ["P13-T01", "P13-T02", "P13-T03"];
  for (const taskId of required) {
    const entry = tasks[taskId];
    if (!entry || entry.status !== "DONE") {
      findings.push({
        code: `ledger_task_not_done:${taskId}`,
        message: `Phase 13 ledger marks ${taskId} as ${entry?.status ?? "missing"}; expected DONE before GA.`
      });
      continue;
    }
    if (typeof entry.evidence !== "string" || entry.evidence.length === 0) {
      findings.push({
        code: `ledger_task_missing_evidence:${taskId}`,
        message: `Phase 13 ledger has no \`evidence\` path for ${taskId}; the integration report is missing.`
      });
    }
  }
  return findings;
}

async function auditThreatModelVerdict({ evidenceRoot }) {
  const findings = [];
  const verdictPath = path.join(evidenceRoot, "P13-T02", "threat-model.json");
  if (!existsSync(verdictPath)) {
    findings.push({
      code: "threat_model_verdict_missing",
      message: `P13-T02 threat-model verdict not found at ${verdictPath}.`
    });
    return findings;
  }
  const text = await readFile(verdictPath, "utf8");
  let verdict;
  try {
    verdict = JSON.parse(text);
  } catch (error) {
    findings.push({
      code: "threat_model_verdict_invalid",
      message: `P13-T02 threat-model verdict is not valid JSON: ${error?.message ?? error}`
    });
    return findings;
  }
  if (verdict?.ok !== true) {
    findings.push({
      code: "threat_model_verdict_not_verified",
      message: `P13-T02 threat-model verdict reports ok !== true; the security-sensitive v9 evidence has not passed the fail-closed gate.`
    });
  }
  const findingList = verdict?.findings ?? verdict?.verdict?.findings ?? [];
  if (Array.isArray(findingList) && findingList.length > 0) {
    findings.push({
      code: "threat_model_findings_present",
      message: `P13-T02 threat-model verdict lists ${findingList.length} finding(s); the highest-level GA gate must report zero findings.`
    });
  }
  return findings;
}

async function auditAbComparison({ evidenceRoot }) {
  const findings = [];
  const abPath = path.join(evidenceRoot, "P13-T01", "ab-comparison", "ab-comparison.json");
  if (!existsSync(abPath)) {
    findings.push({
      code: "ab_comparison_missing",
      message: `P13-T01 A/B comparison JSON not found at ${abPath}; the v8/v9 fail-closed evidence is missing.`
    });
  }
  return findings;
}

async function auditValidateNextLog({ validateNextLog }) {
  if (typeof validateNextLog !== "string") return [];
  const findings = [];
  if (!existsSync(validateNextLog)) {
    findings.push({
      code: "validate_next_log_missing",
      message: `validate-next log not found at ${validateNextLog}; run \`pnpm run validate:next\` and pass the log with --validate-next-log.`
    });
    return findings;
  }
  const text = await readFile(validateNextLog, "utf8");
  // The validate-next.mjs script prints a final "validate-next PASS" or
  // "validate-next FAIL" line; we treat any other outcome as a failure.
  if (!/validate-next\s+PASS/i.test(text)) {
    findings.push({
      code: "validate_next_gate_failed",
      message: `validate-next log at ${validateNextLog} does not contain a PASS line; rerun \`pnpm run validate:next\`.`
    });
  }
  return findings;
}

function summarise(findings, name) {
  return {
    name,
    ok: findings.length === 0,
    findings
  };
}

async function audit({ releaseVersion, repositoryRoot, validateNextLog }) {
  const changelogPath = path.join(repositoryRoot, "CHANGELOG.md");
  const gaDir = path.join(repositoryRoot, "docs", "next", "ga");
  const ledgerPath = path.join(repositoryRoot, ".legion", "project", "changes", "LEGION-NEXT", "implementation", "phase-13", "ledger.yaml");
  const evidenceRoot = path.join(repositoryRoot, "docs", "next", "evidence");

  const changelog = auditChangelog({ changelogPath, releaseVersion });
  const releaseRecord = auditReleaseRecord({ gaDir });
  const migrationPolicy = auditMigrationPolicy({ gaDir });
  const rollbackPolicy = auditRollbackPolicy({ gaDir });
  const v8Handoff = auditV8Handoff({ gaDir });
  const stableChannelApproval = auditStableChannelApproval({ gaDir });
  const ledger = await auditLedger({ ledgerPath });
  const threatModel = await auditThreatModelVerdict({ evidenceRoot });
  const abComparison = await auditAbComparison({ evidenceRoot });
  const validateNext = await auditValidateNextLog({ validateNextLog });

  const findings = [
    ...changelog,
    ...releaseRecord,
    ...migrationPolicy,
    ...rollbackPolicy,
    ...v8Handoff,
    ...stableChannelApproval,
    ...ledger,
    ...threatModel,
    ...abComparison,
    ...validateNext
  ];

  const ok = findings.length === 0;
  return {
    ok,
    status: ok ? "ready" : "blocked",
    release_version: releaseVersion,
    repository_root: repositoryRoot,
    findings,
    checks: {
      changelog: summarise(changelog, "changelog"),
      release_record: summarise(releaseRecord, "release_record"),
      migration_policy: summarise(migrationPolicy, "migration_policy"),
      rollback_policy: summarise(rollbackPolicy, "rollback_policy"),
      v8_handoff: summarise(v8Handoff, "v8_handoff"),
      stable_channel_approval: summarise(stableChannelApproval, "stable_channel_approval"),
      ledger: summarise(ledger, "ledger"),
      threat_model_verdict: summarise(threatModel, "threat_model_verdict"),
      ab_comparison: summarise(abComparison, "ab_comparison"),
      validate_next_log: summarise(validateNext, "validate_next_log")
    }
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const releaseVersion = ensureSemver(ensureString(args["release-version"], "release-version"), "release-version");
  const repositoryRoot = path.resolve(typeof args["repository-root"] === "string" ? args["repository-root"] : DEFAULT_REPO_ROOT);
  const validateNextLog = typeof args["validate-next-log"] === "string" ? args["validate-next-log"] : undefined;
  const reportPath = typeof args.report === "string" ? args.report : undefined;

  const verdict = await audit({ releaseVersion, repositoryRoot, validateNextLog });

  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(verdict.ok ? 0 : 1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath !== undefined && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release-checklist failed: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { audit, parseArgs };