# Phase 13 Independent Review

## Status

PASS

> Signed by `dasbl` on 2026-08-04, as the decision owner named in
> `docs/next/ga/STABLE-CHANNEL-APPROVAL.md`.
>
> The scope, evidence inventory, mechanical check results and known gaps below
> were assembled from the committed artifacts and were recorded **before**
> sign-off. The gaps in "Known Gaps at This Cut Line" are accepted as
> documented, not overlooked.
>
> The reviewer is distinct from the implementation assignee. This verdict was
> not authored by the implementer.

## Scope

- Phase: P13 — Behavioral Evals, Security Hardening, and GA
- Implementation batch: P13-T01 through P13-T03, plus the P13-T04 GA sign-off
- Implementation assignee: `legionworker`
- Reviewer mode: decision-owner closeout sign-off
- Reviewer identity: `dasbl`
- Review date: 2026-08-04

The reviewer must not be `legionworker`. Every prior phase review records a
distinct reviewer, and a same-actor implementation/review pairing at the GA cut
line is the one place that distinction matters most.

## What Phase 13 Delivered

**P13-T01 — behavioral eval workflow.** A release-grade eval comparing v8 and v9
on sealed Phase 0 scenarios. The Phase 0 PowerShell capture/grade/redact
scaffolds were ported to Node (`capture-run.mjs`, `grade-run.mjs`,
`redact-output.mjs`) so the pipeline runs without pwsh, with `compare-runs.mjs`
aggregating the A/B comparison.

**P13-T02 — threat-model validator.** Three fail-closed subprocess-level checks
(sandbox-guard, retention-audit, in-process redaction scan) composed behind
`legion next evals threat-model`. `redact-output.mjs` was extended to cover URL
credentials, JWT tokens, PEM private keys, and JSON-embedded secrets.

**P13-T03 — GA cut-over package.** `scripts/release/release-checklist.mjs`
composing fail-closed preconditions into a single JSON verdict, wired as
`legion next release checklist`, plus the rollback policy verifier.

**P13-T04 — GA sign-off.** Open. This is the task this review feeds.

## Evidence Available for Review

- `docs/next/evidence/P13-T01/` — integration report, A/B comparison, per-package
  test logs, typecheck, workspace tests, `validate:next`, gitleaks diff scan
- `docs/next/evidence/P13-T02/` — integration report, threat model JSON,
  negative-case fixtures, per-package test logs, gitleaks diff scan
- `docs/next/evidence/P13-T03/` — integration report, release checklist JSON,
  rollback policy JSON, per-package test logs, `validate:next`, gitleaks scan
- `docs/next/ga/MIGRATION-POLICY.md`, `ROLLBACK-POLICY.md`, `RELEASE-RECORD.md`,
  `STABLE-CHANNEL-APPROVAL.md`
- `docs/next/LEGION-ASCENDED-KANBAN-MANIFEST.md` — phase 13 task ledger

## Mechanical Check Results

Reproduce with `node scripts/release/release-checklist.mjs --release-version 9.0.0 --repository-root .`

| Check | Result |
|-------|--------|
| `changelog` | pass |
| `release_record` | pass |
| `migration_policy` | pass |
| `rollback_policy` | pass |
| `v8_handoff` | pass |
| `stable_channel_approval` | pass |
| `ledger` | pass |
| `threat_model_verdict` | pass |
| `ab_comparison` | pass |
| `validate_next_log` | pass |
| `open_ga_work` | **fail** — P13-T04 open; this review unsigned |

`migration_policy` failed until the checklist was corrected: it demanded
`legion next migrate`, the P12 compatibility alias, while the policy, ADR-009,
`docs/next/cli/README.md`, and the command's own help text all use
`legion dev migrate`. The policy was right and the verifier was wrong.

## Known Gaps at This Cut Line

These are recorded so the reviewer does not have to rediscover them, and are not
a substitute for the reviewer's own assessment.

- **Eight ship gate families had no evidence producer.** `protected_oracle` now
  reads a dedicated `oracle-verification` evidence item.
  `approved_spec_and_oracle` remains unevaluable: it asks whether the spec and
  oracle were approved *before* gated execution, and no approval record,
  approver, or ordering timestamp exists to check.
- **Whole-change acceptance has no transition.** `createChangeBundle` writes
  `acceptance: "not_ready"` and nothing promotes it. An implementation was
  attempted and reverted: the change bundle is content-hash pinned in both the
  evidence index and the taskgraph, and recording acceptance in the taskgraph
  would make the plan record mutable. A sibling acceptance artifact is the
  proposed design and is an open decision.
- **`workflow:dogfood` asserts `blocked` as success** because of the above. It
  cannot honestly be flipped to `ready` while any R2+ change is structurally
  unshippable.
- **`package.json` reads `9.0.0-alpha.0`** against a `9.0.0` release identity.

## Reviewer Verdict

**PASS**, signed by `dasbl` as decision owner.

The phase 13 deliverables are present with their evidence: the behavioral eval
pipeline (P13-T01), the threat-model validator (P13-T02), and the GA cut-over
package (P13-T03), each with integration reports, per-package test logs,
`validate:next` transcripts and gitleaks diff scans under
`docs/next/evidence/`. Every mechanical check in the table above passes except
`open_ga_work`, which is this sign-off and the two items named below.

The gaps in "Known Gaps at This Cut Line" are accepted knowingly rather than
resolved. They are recorded above so that a later reader can see what this
verdict was given over, and none of them is silently carried.

## Conditions

Two items remain open and are **not** covered by this verdict. The release
checklist continues to report `blocked` until each is resolved on its own terms:

1. **`package.json` reads `9.0.0-alpha.0`** against a `9.0.0` release identity.
   Reconcile the version, or record why the prerelease tag stands.
2. **Whole-change acceptance has no transition**, so
   `whole_change_acceptance_evidence` is unevaluable and `workflow:dogfood`
   still asserts `blocked` as success. The sibling acceptance-artifact design is
   an open decision.

Signing this review does not make the release ready. It removes one of three
blockers.

## Closeout Notes

This review closes P13-T04. The GA decision package
(`RELEASE-RECORD.md`, `MIGRATION-POLICY.md`, `ROLLBACK-POLICY.md`,
`STABLE-CHANNEL-APPROVAL.md`) is complete and internally consistent as of this
date; `migration_policy` passes against the surface the CLI actually routes
after the verifier was corrected.

The eight ship-gate families noted above remain the largest structural gap
between this cut line and a release that can report `ready` on its own evidence
rather than on a documented exception.
