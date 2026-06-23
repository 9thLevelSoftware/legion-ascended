# V8 Handoff Policy

## Status

Accepted for Phase 13 GA on 2026-06-22.

Decision owner: `dasbl`

Review evidence: `docs/next/evidence/P13-T03/integration-report.yaml`,
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout)

## Purpose

Pins the coexistence rules between the v8 line and the v9 GA release.
The v8 line remains the shipped maintenance line until the v9 stable
channel is approved by the decision owner. This document captures what
stays in v8 maintenance, what moves to v9, and how the handoff is
gated.

## V8 Baseline Identity

- Repository: `C:/Users/dasbl/Documents/legion`
- Package: `@9thlevelsoftware/legion`
- Version: `8.0.5`
- Baseline tag: `v8-baseline-20260619`
- Baseline commit: `855e975beec3bac6dc06db598081b6ac11ea8e14`
- Tag object: `87ef9acc057cde8dd71bc25fc08bc536e9c8076c`

The v8 baseline tag stays local until the decision owner approves
publication. `docs/next/V8-MAINTENANCE-POLICY.md` is the authoritative
maintenance contract for the v8 line.

## V8 Maintenance Branch Policy

- Start v8 work from the accepted baseline tag or the current v8
  maintenance branch. **Never branch v8 work from a Legion Next task
  branch.**
- Label every v8 PR `v8-maintenance` plus the affected surface
  (`v8-maintenance` + `runtime`, `security`, `docs`, etc.).
- Run `npm ci`, `npm run validate`, `npm run release:check`, and
  `npm test` before accepting any v8 maintenance change.
- Publish v8 only as compatible patch maintenance unless the decision
  owner approves a separate compatibility decision.

## Permitted V8 Changes

The v8 line is frozen for defects, security fixes, host compatibility
fixes, packaging correctness, and documentation corrections. New
workflow architecture, durable runtime behavior, persona removal,
control-plane implementation, migration tooling, and release
automation belong to v9.

| Surface | V8 maintenance | V9 only |
| --- | --- | --- |
| Defect fixes | yes | yes |
| Security fixes | yes | yes |
| Host compatibility | yes | yes |
| Installer / packaging | yes | yes |
| Documentation corrections | yes | yes |
| Durable board / queue | no | yes |
| Eve runtime integration | no | yes |
| Functional worker bundles | no | yes |
| Persona purge from default execution | no | yes |
| New artifact model / migration engine | no | yes |
| Dashboard / release observation | no | yes |
| Rollback automation | no | yes |

## V9-Only Changes

The v9 line owns the rewrite work tracked in `docs/next/REWRITE-CHARTER.md`
and the Phase 13 GA decision package under `docs/next/ga/`. v9 changes
that touch v8 compatibility surfaces must follow the legacy-bridge
migration path (`legion dev migrate --from-codex-legion|--from-planning`).

## Coexistence Rules

During the GA cut-over window (sign-off of v9 GA through the next
minor v9 release) both lines ship in parallel:

1. **Default runtime**: v9 is the default for new installs; v8 stays
   on the stable maintenance channel for existing v8 users until v9
   GA evidence reaches the rollback-free bar.
2. **Adapter surface**: v9 keeps the v8 markdown command surface as
   legacy aliases (`/legion:advise` → `legion run --read-only-advice`,
   etc.) for one major v9 release. Legacy aliases emit migration
   guidance and route to typed v9 commands; see `ADR-007` for the
   full disposition table.
3. **Persona surface**: v9 keeps the 48 v8 personas mapped in
   `docs/next/migration/LEGACY-PERSONA-MAP.md` for one major v9
   release. Persona-first execution remains disabled by default in v9.
4. **Skill / agent surface**: v9 ships the v8 skill and agent surface
   as compatibility fixtures; new v9 work uses functional worker
   bundles (`ADR-002`).
5. **Evidence retention**: v9 retains v8 evidence fixtures (sealed
   Phase 0 corpus) as the A/B baseline for behavioural evals until
   P00-T06 v8 baseline execution is unblocked.
6. **Channels**: `next`, `alpha`, `beta`, `rc` are reserved for v9
   packages. `latest` defaults to v9 GA. v8 ships to a separate
   `v8-maintenance` dist-tag until sunset.

## Deprecation Timeline

| Milestone | Date (target) | Trigger | Effect |
| --- | --- | --- | --- |
| v9 GA approval | 2026-Q3 (TBD by decision owner) | `STABLE-CHANNEL-APPROVAL.md` sign-off + `release-checklist.mjs` `ready` verdict | v9 promoted to `latest`; v8 stays on `v8-maintenance` |
| v9.1 minor | +90 days after GA | v9 ships a minor release | v8 security fixes continue on `v8-maintenance` |
| v8 sunset notice | +180 days after GA | v9 adoption telemetry confirms >80% of v8 users have a v9 project | Public deprecation notice posted |
| v8 final release | +270 days after GA | Last v8 patch ships | v8 enters extended support only |
| v8 EOL | +365 days after GA | Decision owner signs the EOL record | v8 dist-tag archived; v9 is the only supported line |

The exact dates depend on adoption telemetry that v9 does not yet
collect. The decision owner can extend any milestone by recording a
written exception in the Phase 13 ledger.

## Rollback Triggers

If v9 GA fails any post-release gate, the rollback procedure in
`docs/next/ga/ROLLBACK-POLICY.md` applies. The decision owner can
invoke rollback by recording a `blocker` entry in the Phase 13 ledger
plus a decision record naming the failing gate and the corrective
work. v8 stays on `v8-maintenance` while v9 GA is rolled back.

## Evidence

- `docs/next/V8-MAINTENANCE-POLICY.md` — v8 maintenance contract
- `docs/next/migration/CODEX-LEGION-COLLISION.md` — Codex `.legion/`
  collision migration
- `docs/next/migration/LEGACY-PERSONA-MAP.md` — persona migration map
- `docs/next/adr/ADR-007-kanban-migration.md` — board / council
  naming and disposition table
- `docs/next/adr/ADR-002-functional-workers.md` — functional worker
  bundles
- `docs/next/evidence/P13-T02/SECURITY-MODEL.md` — held-out
  security-sensitive contract (v9 evidence gate)
- `docs/next/evidence/P13-T03/integration-report.yaml` — GA decision
  evidence (P13-T03 closeout)
