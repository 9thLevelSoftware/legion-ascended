# Phase 0 Pre-Mortem

## Review Scope

This review challenges the Legion Next rewrite as a workflow-tool rebuild. The target is not a standalone application; it is a durable, typed workflow orchestration system for project start, planning, build waves, review, status routing, mapping, shipping, retrospectives, learning, validation, and runtime adapter integration.

Reviewed inputs:

- ADR-001 through ADR-008
- v8 workflow compatibility baseline
- storage comparison and `node:sqlite` spike
- Eve public-contract compatibility record
- runtime audit for existing v8 host surfaces
- transformation plan and cross-phase dependency map

## Critical Finding Disposition

No unresolved critical finding remains. The review found important risks that must stay visible in the backlog, but none prevents Phase 1 protocol/core work when the conditions in `docs/next/PHASE-00-DECISION.md` are followed.

## Architecture Failure Scenarios

| Scenario | Failure mode | Mitigation |
| --- | --- | --- |
| Product boundary drifts into standalone app/dashboard work | Phase 1 spends effort on UI/hosting instead of typed workflow contracts. | Phase 1 scope is limited to workspace, protocol schemas, provider-neutral core, validation, and package baseline checks. Dashboard remains Phase 11. |
| Runtime backend becomes source of truth | Eve or a host CLI owns task state, causing drift from Legion board events. | ADR-003 keeps board/task/event ownership in `.legion/var`; ADR-004 keeps runtime checkpoints as run metadata only. |
| Store transaction wraps external execution | A model, shell, network, or Git operation runs while a DB transaction is open. | ADR-008 requires short transactions and outbox/idempotency boundaries. |
| Projection corruption hides true state | Current rows disagree with event log. | ADR-003 and ADR-008 require rebuildable projections; event log wins. |
| V8 compatibility lost early | Commands, skills, adapters, or installer paths are removed before migration. | V8 compatibility baseline forbids deletion/rename during Milestone A. |

## Security Failure Scenarios

| Scenario | Failure mode | Mitigation |
| --- | --- | --- |
| Repository prompt injection changes authority | Untrusted docs, comments, logs, or fixtures override task contracts or approvals. | ADR-006 risk gates and Phase 1 schemas must distinguish requirements, comments, evidence, and untrusted payloads. |
| Secret leakage into evidence | Runtime output or logs retain tokens, env values, or auth headers. | P00-T05 redaction harness remains baseline; Phase 5 and Phase 13 add sandbox and telemetry leak tests. |
| Approval bypass | A worker treats model output or comment text as human approval. | ADR-005 requires durable approval records before gated outbox effects. |
| Sandbox escape or host filesystem access | Runtime driver exposes home directory, unrelated repos, or credentials. | Eve sandbox tests are deferred but mandatory before `runtime-eve` default binding. |

## Portability Failure Scenarios

| Scenario | Failure mode | Mitigation |
| --- | --- | --- |
| Node target mismatch | Eve needs Node `>=24` while v8 supports Node `>=18`. | Phase 1 targets Node 24+ for v9 packages; v8 maintenance remains separate. |
| Windows-only storage proof | Local spike passes on Windows but misses Linux/macOS behavior. | Phase 3 must add Linux/macOS/Windows CI cells before board release readiness. |
| Native dependency install failures | `better-sqlite3` or other native dependency breaks local installs. | ADR-008 selects `node:sqlite` first to avoid native package friction. |
| Host-specific command assumptions leak into core | Codex/Claude/Kilo/Gemini command shapes become protocol semantics. | Channel adapters own host syntax; protocol/core uses provider-neutral entities. |

## Migration Failure Scenarios

| Scenario | Failure mode | Mitigation |
| --- | --- | --- |
| `.planning/` and `.legion/` dual-write drift | Old and new state both mutate and disagree. | ADR-003 makes `.planning/` read-only historical input after import. |
| Persona extraction preserves personality prose | Functional workers inherit tone/biography instead of capabilities. | ADR-002 and Phase 4 backlog require extraction into role bundles, skills, rubrics, and domain packs only. |
| Evidence indexes reference missing payloads | Accepted evidence becomes unverifiable after cleanup. | ADR-003 blocks acceptance until payload is restored or superseded. |
| Rollback loses user-authored artifacts | Migration overwrites or deletes `.planning/` or v8 Legion files. | Phase 2 must use backups, shadow import, and rollback tests before cutover. |

## Accepted Risks

| Risk | Rationale | Owner | Revisit trigger |
| --- | --- | --- | --- |
| Live model/runtime metrics absent from Phase 0 | They are useful after typed workflow contracts exist, but not required to start protocol/core. | Eval owner | Before Phase 13 A/B proof or any quality/performance claim. |
| Eve public preview churn | Eve is optional until Phase 5 live compatibility proves the contract. | Runtime owner | Any Eve package upgrade or failed public-contract test. |
| Cross-OS storage evidence deferred | Phase 0 ran Windows-local proof only; Phase 3 owns full board release readiness. | Storage owner | Before merging board dispatcher implementation. |

## Sign-Off

- Decision owner: dasbl
- Review date: 2026-06-19
- Result: proceed to P00-T10 with `CONDITIONAL GO` recommendation for Phase 1.
