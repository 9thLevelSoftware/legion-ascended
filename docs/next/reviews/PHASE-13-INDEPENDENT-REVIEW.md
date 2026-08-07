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

Last reproduced 2026-08-07. `open_ga_work` reported three findings when this
document was first assembled; one has since been cleared. `package.json` now
reads `9.0.0`, matching the release identity. The two that remain —
`ga_task_open` for P13-T04 and `phase_13_review_unsigned` for this file — are
the two halves of the sign-off itself, and neither can be cleared by anyone but
the reviewer. They are expected to be the last findings standing.

`migration_policy` failed until the checklist was corrected: it demanded
`legion next migrate`, the P12 compatibility alias, while the policy, ADR-009,
`docs/next/cli/README.md`, and the command's own help text all use
`legion dev migrate`. The policy was right and the verifier was wrong.

## Known Gaps at This Cut Line

These are recorded so the reviewer does not have to rediscover them, and are not
a substitute for the reviewer's own assessment.

**The gaps listed when this document was first assembled have since been closed.**
They are kept here, struck through, because the reviewer is judging a cut line
that moved after the document was drafted, and a list that silently changed under
them would be worse than one that shows its own history.

- ~~**Eight ship gate families had no evidence producer.**~~ Closed. All twenty
  gates now have one; ADR-011 records which command produces the evidence each
  gate reads. `approved_spec_and_oracle` reads the approval plane's ordering,
  which is the record that did not exist when this was written.
- ~~**Whole-change acceptance has no transition.**~~ Closed. The sibling
  acceptance artifact named here as "the proposed design and an open decision"
  was implemented; `legion acceptance` decides the change as a whole and gives
  every unmet verdict a way back, without making the taskgraph mutable.
- ~~**`workflow:dogfood` asserts `blocked` as success.**~~ Closed. The harness
  now drives a real R2 intake and asserts `legion ship` reports `ready` with
  seven satisfied gates, then asserts the block and the recovery.
- ~~**`package.json` reads `9.0.0-alpha.0`.**~~ Closed; it reads `9.0.0`.

Open at this cut line:

- **Phases 14-19 carry no phase ledger, evidence index, or independent review.**
  This is now a recorded decision rather than a gap: ADR-012 scopes those gates
  to phases 0-13 and states what governs work after them. The reviewer should
  judge whether that scoping is acceptable, since it is the process under which
  the gate-producer work above was delivered.
- **Protocol 0.3.0 has no consumer outside this repository's own tests.** The
  `attestation` and `release` entity kinds are exercised by the suite and the
  dogfood harness only. Entity schemas are strict, so a reader on 0.2.0 refuses a
  document using them — the compatibility story is designed but not field-tested.
- **Seven security-boundary tests cannot run on Windows without Developer Mode.**
  They require file symlinks, which need `SeCreateSymbolicLinkPrivilege`. The
  suite now fails rather than skipping when that privilege is absent, and
  `check:symlink-coverage` pins the count, but the assertions themselves are
  proven on Linux and macOS rather than on an unprivileged Windows box.

## Final Verdicts

Six axes, each `PASS` or `FAIL`, matching the block every prior phase review
carries. To be completed by the reviewer.

| Axis | Verdict |
|------|---------|
| Requirement coverage | _to be recorded_ |
| Architecture compliance | _to be recorded_ |
| Implementation quality | _to be recorded_ |
| Test and evidence sufficiency | _to be recorded_ |
| Operational handoff readiness | _to be recorded_ |
| Unresolved risk | _to be recorded_ |

## Reviewer Verdict

_To be completed. Record PASS or FAIL, the reasoning, and any conditions._

Recording `PASS` here means changing `## Status` at the top of this file from
`PENDING` to `PASS`, and marking `P13-T04` as `DONE` in
`docs/next/LEGION-ASCENDED-KANBAN-MANIFEST.md`. Those two edits are the whole
sign-off; the release checklist reports `ready` once both are made and reports
`blocked` while either is outstanding.

## Closeout Notes

_To be completed by the reviewer._
