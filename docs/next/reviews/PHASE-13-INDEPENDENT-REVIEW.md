# Phase 13 Independent Review

## Status

PENDING

> This document is prepared to signature-ready and is **not signed**. The scope,
> evidence inventory, and mechanical check results below were assembled from the
> committed artifacts. The verdict, the reviewer identity, and the closeout
> assessment are a human decision and are deliberately left blank.
>
> `scripts/release/release-checklist.mjs` fails while this file reads `PENDING`,
> so the release cannot report `ready` on the strength of an unsigned review.

## Scope

- Phase: P13 — Behavioral Evals, Security Hardening, and GA
- Implementation batch: P13-T01 through P13-T03, plus the P13-T04 GA sign-off
- Implementation assignee: `legionworker`
- Reviewer mode: _to be recorded by the reviewer_
- Reviewer identity: _to be recorded by the reviewer_
- Review date: _to be recorded by the reviewer_

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

_To be completed. Record PASS or FAIL, the reasoning, and any conditions._

## Closeout Notes

_To be completed by the reviewer._
