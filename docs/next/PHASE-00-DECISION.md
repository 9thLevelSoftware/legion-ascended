# Phase 0 Decision

## Decision

`CONDITIONAL GO`

Phase 1 is authorized for TypeScript workspace and protocol/core work. The authorization is limited to rebuilding Legion as a workflow orchestration tool: durable project/change/task contracts, event schemas, provider-neutral runtime boundaries, package layout, validation, and compatibility checks.

Phase 1 is not authorized to build a standalone application, hosted service, dashboard-first product, chat UI, or Eve-specific app shell.

## Decision Date

2026-06-19

## Decision Owner

dasbl

## Phase 1 Base

- Source branch: `legion-next/phase-00`
- Baseline v8 tag: `v8-baseline-20260619`
- Baseline v8 commit: `855e975beec3bac6dc06db598081b6ac11ea8e14`
- Phase 1 start point: final Phase 0 completion commit on `legion-next/phase-00`

## Conditions

| ID | Condition | Owner | Verification |
| --- | --- | --- | --- |
| P00-GO-001 | Phase 1 must model Legion workflow entities, not standalone application entities. | protocol-owner | Schemas include Project, Change, TaskContract, TaskRun, Event, Evidence, Review, Approval, WorkerBundle, RuntimeDriver; no dashboard/chat-app domain package is introduced. |
| P00-GO-002 | v8 workflow command, skill, adapter, installer, and persona assets remain published during Milestone A. | compatibility-owner | Package file-list comparison against `docs/next/evidence/P00-T06/npm-pack-dry-run.json`. |
| P00-GO-003 | Core packages remain provider-neutral and do not import Eve, host CLI, or SQLite implementation types. | architecture-owner | Type/import scan in Phase 1 verification. |
| P00-GO-004 | Node 24+ is the v9 target; v8 Node 18+ compatibility remains in the v8 maintenance line. | platform-owner | Root package `engines` and CI matrix reflect Node 24+ for v9 packages. |
| P00-GO-005 | `node:sqlite` is the local store default only behind a provider-neutral interface. | storage-owner | Phase 1 contracts expose store capabilities without SQLite-specific types. |
| P00-GO-006 | Eve live execution is deferred to Phase 5 and cannot block Phase 1 unless the protocol would force Eve-specific types. | runtime-owner | RuntimeDriver interface has no Eve imports and has a local fake/test driver. |
| P00-GO-007 | Deferred live v8/v9 quality metrics cannot be used as evidence for performance, cost, or quality claims before eval phases. | eval-owner | Release notes and GA gates cite only deterministic Phase 0 baseline until live evals exist. |

## Accepted Phase 0 Outputs

- Rewrite charter and v8 maintenance policy.
- ADR-001 through ADR-008.
- v8 workflow compatibility baseline.
- Baseline corpus and deterministic harness scaffold.
- Local store selection and executable storage spike.
- Eve public-contract compatibility map.
- Phase 0 pre-mortem and findings register.
- Implementation backlog and dependency map.

## Dissent Or Reservations

No dissent recorded. The main reservation is that live model/runtime metrics and live Eve crash-resume proof are intentionally deferred; they are not Phase 1 prerequisites, but they remain blocking for the later phases that make runtime and quality claims.

## Next Action

Create `legion-next/phase-01` from the Phase 0 completion commit and execute Phase 1 with the above conditions as preflight checks.
