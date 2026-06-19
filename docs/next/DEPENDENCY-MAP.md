# Dependency Map

## Phase 1 Critical Path

1. `P01-B001` creates the TypeScript workspace and package boundaries.
2. `P01-B002` defines workflow protocol schemas.
3. `P01-B004` defines event and idempotency fixtures.
4. `P01-B003` defines provider-neutral runtime contracts and a local fake driver.
5. `P01-B005` proves v8 workflow package compatibility remains intact.

Phase 1 can run schema and runtime-contract work in parallel only after `P01-B001` exists. No Phase 1 work may introduce dashboard, hosted app, chat-app, Eve-specific, or SQLite-specific core imports.

## Cross-Phase Dependencies

| Workstream | Starts after | Feeds | Notes |
| --- | --- | --- | --- |
| Protocol/core | Phase 0 conditional go | Phases 2, 3, 4, 5, 8, 13 | Must model workflow orchestration entities. |
| Artifact migration | Phase 1 schemas | Phases 3, 4, 8, 12 | Owns `.planning/` shadow import and rollback. |
| Transactional board | Phase 1 events and Phase 2 artifacts | Phases 5, 6, 8, 10, 13 | Uses `node:sqlite` locally behind interface. |
| Worker bundles | Phase 1 schemas and Phase 2 artifact model | Phases 5, 6, 7, 13 | Removes persona injection from default runtime. |
| Runtime drivers | Phase 1 RuntimeDriver, Phase 3 board, Phase 4 workers | Phases 6, 8, 10, 13 | Eve binding is Phase 5, not Phase 1. |
| CLI workflow UX | Protocol/core and enough board contracts | Phases 9, 12, 13 | Keeps CLI-first MVP before dashboard. |
| Dashboard/multi-project operations | Auth/API foundations after CLI MVP | Phase 13 | Not a Phase 1 product goal. |
| Behavioral evals | Stabilized workflow lifecycle and host bridges | GA | Live model metrics happen after deterministic system exists. |

## Parallelizable Work

- During Phase 1, protocol schemas and package/file-list compatibility tests can proceed in parallel after workspace setup.
- During Phase 2, migration fixture design can proceed alongside artifact schema validators once core schema names stabilize.
- During Phase 3, store fault tests and board API tests can proceed in parallel if they share only published store interfaces.
- Phase 4 persona extraction can run in domain slices after the worker manifest schema is frozen.

## Blocking Gates

| Gate | Blocks | Evidence |
| --- | --- | --- |
| Workflow product boundary | Phase 1 acceptance | `docs/next/PHASE-00-DECISION.md` condition `P00-GO-001` |
| v8 compatibility | Any Milestone A package release | `docs/next/baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md` |
| Store portability | Phase 3 board release | `docs/next/adr/ADR-008-local-store-selection.md` |
| Eve live proof | `runtime-eve` default binding | `docs/next/spikes/EVE-COMPATIBILITY.md` |
| Persona purge | GA default runtime | `docs/next/adr/ADR-002-functional-workers.md` |

## Phase 1 Starting State

Use the final Phase 0 completion commit on `legion-next/phase-00` as the Phase 1 base. The v8 reference remains `v8-baseline-20260619` at `855e975beec3bac6dc06db598081b6ac11ea8e14`.
