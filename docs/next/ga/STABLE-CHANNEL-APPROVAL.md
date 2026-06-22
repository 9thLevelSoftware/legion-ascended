# Stable Channel Approval

## Status

Pending decision owner sign-off (Phase 13 GA cut-over).

Decision owner: `dasbl`

Required reviewers:

- Decision owner (`dasbl`) — final approval authority
- ADR review owner (`dasbl`) — verifies ADR supersession rules
- Migration owner (`dasbl`) — verifies rollback path is restorable
- Security owner (`dasbl`) — verifies threat-model validator passes
- Evaluation fixture owner (`dasbl`) — verifies A/B comparison is
  fail-closed

Review evidence: `docs/next/evidence/P13-T03/integration-report.yaml`,
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout)

## Purpose

Pins the sign-off gate that authorises the v9 GA release on the
stable release channel. The approval is fail-closed: the
`release-checklist.mjs` verifier must report `status: "ready"` with
zero findings before any reviewer can sign off. The decision owner
records the final approval here with a date, a checklist summary,
and any exceptions (which must be written into the Phase 13 ledger).

## Sign-Off Gate

```bash
node scripts/release/release-checklist.mjs \
  --release-version 9.0.0 \
  --repository-root /path/to/legion-next \
  --validate-next-log docs/next/evidence/P13-T03/validate-next.log \
  --report docs/next/evidence/P13-T03/release-checklist.json
```

The verifier prints a JSON verdict and exits non-zero on any
finding. The exit-zero / `status: "ready"` verdict is a precondition
for the sign-off block below. The Phase 13 ledger entry for P13-T03
must reference the verdict path.

## Required Preconditions

The checklist verifier enforces ten preconditions; each is documented
in `scripts/release/release-checklist.mjs` and the corresponding
companion document. Reviewers cross-reference the checklist verdict
with the underlying artefacts:

| # | Precondition | Companion document | Finding codes |
| --- | --- | --- | --- |
| 1 | CHANGELOG has a `## [9.0.0]` entry declaring `GA-approved` or `GA-pending` | `CHANGELOG.md` | `changelog_missing_ga_entry`, `changelog_missing_ga_keyword`, `changelog_missing` |
| 2 | `docs/next/ga/RELEASE-RECORD.md` exists and links to every companion document | `RELEASE-RECORD.md` | `release_record_missing`, `release_record_missing_link:<doc>` |
| 3 | `docs/next/ga/MIGRATION-POLICY.md` exists and references `legion next migrate` | `MIGRATION-POLICY.md` | `migration_policy_missing`, `migration_policy_missing_cli_reference` |
| 4 | `docs/next/ga/ROLLBACK-POLICY.md` exists and references the backup-manifest + restore procedure | `ROLLBACK-POLICY.md` | `rollback_policy_missing`, `rollback_policy_missing_manifest_reference` |
| 5 | `docs/next/ga/V8-HANDOFF.md` exists and pins the v8 maintenance branch policy and the v8 line | `V8-HANDOFF.md` | `v8_handoff_missing`, `v8_handoff_missing_branch_reference` |
| 6 | `docs/next/ga/STABLE-CHANNEL-APPROVAL.md` (this document) exists and pins the decision owner sign-off gate | `STABLE-CHANNEL-APPROVAL.md` | `stable_channel_approval_missing`, `stable_channel_approval_missing_signoff` |
| 7 | Phase 13 ledger lists P13-T01, P13-T02, P13-T03 as DONE with non-empty evidence paths | `.legion/project/changes/LEGION-NEXT/implementation/phase-13/ledger.yaml` | `ledger_task_not_done:<task>`, `ledger_task_missing_evidence:<task>`, `ledger_missing_phase13`, `ledger_yaml_invalid` |
| 8 | P13-T02 threat-model.json reports `ok: true` with zero findings | `docs/next/evidence/P13-T02/threat-model.json` | `threat_model_verdict_missing`, `threat_model_verdict_invalid`, `threat_model_verdict_not_verified`, `threat_model_findings_present` |
| 9 | P13-T01 ab-comparison.json exists (fail-closed contract) | `docs/next/evidence/P13-T01/ab-comparison/ab-comparison.json` | `ab_comparison_missing` |
| 10 | `validate-next` log reports `PASS` | `docs/next/evidence/P13-T03/validate-next.log` (or operator-supplied path) | `validate_next_log_missing`, `validate_next_gate_failed` |

## Decision Owner Sign-Off

The decision owner (`dasbl`) fills in the block below once the
checklist verifier reports `status: "ready"` and every required
reviewer has signed off in the ledger. The block is the authoritative
record of the GA approval.

```
Stable-channel approval: GRANTED  /  DENIED  /  DEFERRED

Release version:        9.0.0
Release date (target):  YYYY-MM-DD
Checklist verdict:      docs/next/evidence/P13-T03/release-checklist.json
Checklist status:       ready (zero findings)
Threat-model verdict:   docs/next/evidence/P13-T02/threat-model.json (verified)
Rollback verifier:      docs/next/evidence/P13-T03/rollback-policy.json (restorable)
Migration policy:       docs/next/ga/MIGRATION-POLICY.md
Rollback policy:        docs/next/ga/ROLLBACK-POLICY.md
V8 handoff:             docs/next/ga/V8-HANDOFF.md
Release record:         docs/next/ga/RELEASE-RECORD.md
Phase 13 ledger:        .legion/project/changes/LEGION-NEXT/implementation/phase-13/ledger.yaml
Decision owner:         dasbl
Signature:              <signature-or-recorded-approval>
Date:                   YYYY-MM-DD
Exceptions (if any):    <written exceptions; otherwise "none">
```

A `DEFERRED` verdict blocks the GA cut-over until the underlying
findings are resolved. A `DENIED` verdict rolls the release back to
alpha or beta and re-opens the affected Phase 13 tasks.

## Approval Routing

| Reviewer | Role | Verifies | Sign-off recorded in |
| --- | --- | --- | --- |
| Decision owner | Final authority | Checklist verdict is `ready` and every companion artefact is intact | This document (decision owner sign-off block) |
| ADR review owner | Architecture | No outstanding ADRs supersede the Phase 13 ADRs | `docs/next/adr/` review comments |
| Migration owner | Migration path | `legion next migrate --verify` produces a clean report and the rollback verifier reports `restorable` | `docs/next/ga/MIGRATION-POLICY.md` review trail |
| Security owner | Security model | P13-T02 threat-model verdict is `verified` and the held-out security-sensitive contract is intact | `docs/next/baseline/SECURITY-MODEL.md` review trail |
| Evaluation fixture owner | Evaluation fixtures | P13-T01 ab-comparison.json exists and v9 evidence is fail-closed | `docs/next/evidence/P13-T01/integration-report.yaml` review trail |

Independent review (P13-T04) is performed by an actor separate from
the implementation actor (legionworker). Phase 12 established the
actor-separation rule for the Migration/Host Beta cut line; Phase 13
extends the rule to the GA decision. The independent reviewer writes
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` and either confirms
or blocks the GA decision.

## Post-Approval Actions

Once the sign-off block is complete:

1. The decision owner records the approval in the Phase 13 ledger
   (`P13-T03` entry, `decisions:` list) with a date and a SHA-256 of
   the verdict JSON.
2. The v9 package is promoted from `next` to `latest` on the npm
   registry. The release record is the canonical source for the
   promotion PR.
3. `docs/next/evidence/P13-T03/integration-report.yaml` is updated
   with the approval date and SHA-256 of this document.
4. The Phase 13 ledger is sealed: no further edits to P13-T01
   through P13-T03 without a written exception recorded in the
   ledger's `decisions:` list.

## Evidence

- `scripts/release/release-checklist.mjs` — fail-closed GA gate
- `scripts/release/rollback-policy.mjs` — backup-manifest verifier
- `docs/next/ga/RELEASE-RECORD.md` — consolidated GA decision package
- `docs/next/ga/MIGRATION-POLICY.md` — operator-facing migration policy
- `docs/next/ga/ROLLBACK-POLICY.md` — rollback policy and procedure
- `docs/next/ga/V8-HANDOFF.md` — v8 / v9 coexistence rules
- `docs/next/baseline/SECURITY-MODEL.md` — held-out security contract
- `docs/next/evidence/P13-T02/threat-model.json` — P13-T02 verdict
- `docs/next/evidence/P13-T03/integration-report.yaml` — P13-T03 evidence
- `.legion/project/changes/LEGION-NEXT/implementation/phase-13/ledger.yaml` — Phase 13 ledger