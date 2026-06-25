# Release Record

## Status

Pending decision owner sign-off (Phase 13 GA cut-over).

Decision owner: `dasbl`

Review evidence: `docs/next/evidence/P13-T03/integration-report.yaml`,
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout)

## Purpose

This document is the consolidated GA decision package for the v9
release. It points at every companion document, summarises the
fail-closed gates that gate the release, and records the
implementation evidence that supports the GA approval. The release
record is the single source of truth reviewers point at when they
sign off on the stable channel promotion.

## Release Identity

| Field | Value |
| --- | --- |
| Package | `legion-ascended` |
| Release version | `9.0.0` |
| Pre-release channel (cut-over) | `next` |
| Stable channel (post-approval) | `latest` |
| Implementation branch | `codex/p03-t02-board-task-repository` |
| Implementation base commit | `c0a751abf68c7952e1463c64c807c3d83102b967` |
| Implementation actor | `legionworker` |
| Independent reviewer | `otrlead` (P13-T04 closeout) |
| Decision owner | `dasbl` |

## Companion Documents

The GA decision package is the union of this record plus four
companion documents. Each companion document is authoritative for
its domain; the checklist verifier pins them all.

- [MIGRATION-POLICY.md](./MIGRATION-POLICY.md) — operator-facing
  v8 → v9 migration policy. Pins the `--verify|--dry-run|--apply|
  --rollback` matrix, the source class preservation rules, and the
  review gates that block destructive apply steps.
- [ROLLBACK-POLICY.md](./ROLLBACK-POLICY.md) — rollback triggers,
  procedure, and the backup-manifest contract. Defines the
  `rollback-policy.mjs` verifier and its fail-closed finding codes.
- [V8-HANDOFF.md](./V8-HANDOFF.md) — v8 / v9 coexistence rules,
  deprecation timeline, rollback triggers. Pins the v8 maintenance
  branch policy and the EOL milestones.
- [STABLE-CHANNEL-APPROVAL.md](./STABLE-CHANNEL-APPROVAL.md) — the
  sign-off gate that authorises the GA promotion. Contains the
  decision owner sign-off block plus the approval routing matrix.

## Fail-Closed Gates

The GA approval is gated by three fail-closed validators. Each
emits a JSON verdict that downstream reviewers can grep without
parsing free-form text.

### 1. Release Checklist (`scripts/release/release-checklist.mjs`)

The release checklist verifies the ten preconditions for the GA
decision: CHANGELOG entry, all four companion documents, the Phase
13 ledger state, the P13-T02 threat-model verdict, the P13-T01 A/B
comparison, and the validate-next log. The verdict must report
`status: "ready"` with zero findings.

```
node scripts/release/release-checklist.mjs \
  --release-version 9.0.0 \
  --validate-next-log docs/next/evidence/P13-T03/validate-next.log \
  --report docs/next/evidence/P13-T03/release-checklist.json
```

### 2. Rollback Policy Verifier (`scripts/release/rollback-policy.mjs`)

The rollback verifier confirms the backup-manifest written by the
most recent apply step is restorable. It re-hashes the backup
directory and fails closed on schema drift, hash mismatch, missing
backup directory, or read-only restore target. The verdict must
report `status: "restorable"` with zero findings.

```
node scripts/release/rollback-policy.mjs \
  --backup-manifest <backup-root>/backup-manifest.json \
  --source codex-legion \
  --report docs/next/evidence/P13-T03/rollback-policy.json
```

### 3. Threat-Model Validator (`scripts/baseline/threat-model.mjs`)

The threat-model validator (P13-T02) is the highest-level fail-closed
gate for the held-out security-sensitive contract. It composes
sandbox-guard + retention-audit + in-process redaction scan and
exits non-zero on any finding. The P13-T02 verdict is captured
once and referenced by the GA decision; re-running the validator is
optional for the GA gate.

```
node scripts/baseline/threat-model.mjs \
  --run-dir docs/next/evidence/P13-T02/runs/v9/p13-security-sensitive.v1-codex-cli-r1-20260622T163335Z \
  --output-root docs/next/evidence/P13-T02/runs \
  --report docs/next/evidence/P13-T02/threat-model.json
```

## Implementation Evidence

Phase 13 closed out three tasks before the GA decision:

| Task | Title | Evidence |
| --- | --- | --- |
| P13-T01 | Behavioral evals — release-grade workflow evals with v8/v9 A/B comparison on sealed scenarios (cost, duration, intervention, recovery, defects) | `docs/next/evidence/P13-T01/integration-report.yaml` |
| P13-T02 | Security hardening — threat model validation, sandbox boundary audit, secret handling review, and evidence retention policy | `docs/next/evidence/P13-T02/integration-report.yaml` |
| P13-T03 | GA release preparation — release checklist, migration policy, rollback policy, v8 handoff, and stable channel approval (this task) | `docs/next/evidence/P13-T03/integration-report.yaml` |

Phase 13 also depends on the Phase 12 closeout
(`docs/next/evidence/P12-CLOSEOUT/integration-report.yaml`) and the
Phase 11 portfolio projection
(`docs/next/evidence/P11-T02/integration-report.yaml`).

## P13-T03 Deliverables

This task (P13-T03) ships the following artefacts:

| Artefact | Description |
| --- | --- |
| `scripts/release/release-checklist.mjs` | Fail-closed GA gate; verifies the ten preconditions for the GA decision |
| `scripts/release/rollback-policy.mjs` | Backup-manifest verifier; confirms the most recent apply step is restorable |
| `packages/cli/src/commands/release/index.ts` | `legion next release {checklist,rollback-verify}` CLI adapter |
| `packages/cli/src/index.ts` | Root CLI dispatch advertises the new `release` command |
| `tests/release-checklist.test.mjs` | Verifier regression tests (well-formed + fail-closed paths) |
| `tests/rollback-policy.test.mjs` | Backup-manifest verifier regression tests (intact + drift + missing + cross-source) |
| `apps/cli-e2e/test/cli-e2e.test.mjs` | CLI e2e tests for the new release subcommands |
| `docs/next/ga/RELEASE-RECORD.md` | This document — consolidated GA decision package |
| `docs/next/ga/MIGRATION-POLICY.md` | Operator-facing migration policy |
| `docs/next/ga/ROLLBACK-POLICY.md` | Rollback policy and procedure |
| `docs/next/ga/V8-HANDOFF.md` | v8 / v9 coexistence rules and deprecation timeline |
| `docs/next/ga/STABLE-CHANNEL-APPROVAL.md` | Sign-off gate and approval routing |
| `.legion/project/changes/LEGION-NEXT/implementation/phase-13/ledger.yaml` | Phase 13 ledger (P13-T01, P13-T02, P13-T03 marked DONE) |
| `.legion/project/changes/LEGION-NEXT/implementation/phase-13/HANDOFF.md` | Phase 13 handoff (extended for GA cut-over) |
| `.legion/project/changes/LEGION-NEXT/implementation/phase-13/evidence-index.yaml` | SHA-256 evidence index (extended for P13-T03) |

## Preserved Boundaries

Phase 13 does not mutate the boundary contracts established in
earlier phases:

- Eval execution stays in `scripts/baseline/` + the `@legion/cli
  evals` subcommand. `@legion/core` and `@legion/board` remain
  provider-neutral.
- GA gating lives in `scripts/release/` + the `@legion/cli release`
  subcommand. The release checklist and rollback verifier do not
  touch `@legion/core` or `@legion/board`.
- The held-out security-sensitive contract remains in
  `evals/fixtures/evaluator/` and is hash-pinned by
  `tests/evals-baseline.test.mjs`.
- v8 evidence remains fail-closed: absent P00-T06 v8 runs surface as
  null cells in the A/B comparison rather than fabricated values.
- v8 maintenance stays on the `v8-maintenance` dist-tag and follows
  the policy in `docs/next/V8-MAINTENANCE-POLICY.md`.

## Outstanding Items

- **P00-T06 v8 baseline execution** remains blocked. The Phase 13
  fail-closed contract means the GA evidence is v9-only; the
  A/B comparison surfaces v8 cells as `null`. The decision owner
  can approve the GA promotion without v8 evidence because the
  fail-closed contract is recorded in the Phase 13 ledger.
- **Gitleaks pre-existing findings** — the P13-T02 diff scan
  (`docs/next/evidence/P13-T02/gitleaks-p13-t02-diff.log`) reported
  6 pre-existing findings in P03-T04 evidence and skills/agents
  docs. The P13-T03 diff contributes 0 new findings. The
  pre-existing findings are out of scope for P13-T03 and the
  decision owner is informed in the Phase 13 ledger.

## Reviewer Sign-Off

| Reviewer | Role | Status | Sign-off recorded in |
| --- | --- | --- | --- |
| `dasbl` | Decision owner | pending | `docs/next/ga/STABLE-CHANNEL-APPROVAL.md` sign-off block |
| `dasbl` | ADR review owner | pending | `docs/next/adr/` review trail |
| `dasbl` | Migration owner | pending | `docs/next/ga/MIGRATION-POLICY.md` review trail |
| `dasbl` | Security owner | pending | `docs/next/baseline/SECURITY-MODEL.md` review trail |
| `dasbl` | Evaluation fixture owner | pending | `docs/next/evidence/P13-T01/integration-report.yaml` review trail |
| `otrlead` | Independent reviewer | pending | `docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout) |

## Evidence

- `docs/next/REWRITE-CHARTER.md` — program boundary, v8 baseline
  context, GA approval rule (decision owner approves release
  record, migration policy, rollback policy, and v8 handoff)
- `docs/next/V8-MAINTENANCE-POLICY.md` — v8 maintenance contract
- `docs/next/baseline/SECURITY-MODEL.md` — held-out
  security-sensitive contract (P13-T02)
- `docs/next/evidence/P12-CLOSEOUT/integration-report.yaml` —
  Migration/Host Beta cut line evidence (P12-T03 closeout)
- `docs/next/evidence/P13-T01/integration-report.yaml` — Phase 13
  behavioural eval evidence (P13-T01 closeout)
- `docs/next/evidence/P13-T02/integration-report.yaml` — Phase 13
  security hardening evidence (P13-T02 closeout)
- `docs/next/evidence/P13-T03/integration-report.yaml` — Phase 13
  GA evidence (P13-T03 closeout)
- `docs/next/LEGION-ASCENDED-KANBAN-MANIFEST.md` — Phase 13 task
  table (P13-T01 through P13-T04)
- `.legion/project/changes/LEGION-NEXT/implementation/phase-13/ledger.yaml` —
  Phase 13 ledger
