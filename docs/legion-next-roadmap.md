# Legion Next Retooling Roadmap

## Purpose

This document is the execution index for the Legion Retooled repository. It does not restate the detailed phase contracts. The detailed task lists, read/write scopes, verification commands, evidence requirements, rollback rules, and handoff templates remain in the rebuild prompt package under:

`C:/Users/dasbl/Documents/legion/docs/rebuild`

Use this roadmap to find the correct source document, preserve phase ordering, identify required external references, and decide when the work is ready to move from roadmap review into implementation planning.

## Source Of Truth

| Surface | Path or URL | Use |
| --- | --- | --- |
| New implementation repository | `C:/Users/dasbl/Documents/Legion Retooled` | Primary work repository for the retooled implementation. |
| Original Legion local checkout | `C:/Users/dasbl/Documents/legion` | Local v8 reference for behavior, installer/package surface, tests, commands, adapters, skills, agents, and migration inputs. |
| Original Legion remote | `https://github.com/9thLevelSoftware/legion` | Public reference for the upstream source and repository state. |
| Rebuild package root | `C:/Users/dasbl/Documents/legion/docs/rebuild` | Phase execution package and supporting governance documents. |
| Phase package README | `C:/Users/dasbl/Documents/legion/docs/rebuild/README (1).md` | Phase index, package usage rules, and high-level execution instructions. |
| Overarching transformation plan | `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md` | Product architecture, workflow model, target repository shape, migration strategy, security boundaries, eval strategy, and v9 MVP/GA definitions. |
| Nested prompt package | `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-phase-prompts/legion-next-phase-prompts` | Packaged copy with `phase-manifest.json` and `00-overarching-transformation-plan.md`. |
| Phase manifest | `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-phase-prompts/legion-next-phase-prompts/phase-manifest.json` | Machine-readable phase list, task counts, wave counts, and declared dependencies. |
| Phase dependency map | `C:/Users/dasbl/Documents/legion/docs/rebuild/CROSS-PHASE-DEPENDENCY-MAP.md` | Hard ordering constraints and release cut lines. |
| Agent execution guide | `C:/Users/dasbl/Documents/legion/docs/rebuild/AGENT-EXECUTION-GUIDE.md` | Coordinator, worker, evidence, recovery, and completion hierarchy. |
| Package validation report | `C:/Users/dasbl/Documents/legion/docs/rebuild/VALIDATION-REPORT.md` | Validation status for the generated phase package. |
| Phase document template | `C:/Users/dasbl/Documents/legion/docs/rebuild/PHASE-DOCUMENT-TEMPLATE.md` | Required structure if a phase document must be revised or regenerated. |

## Document Normalization Notes

- The top-level rebuild README references `00-overarching-transformation-plan.md`, but the top-level rebuild directory currently contains `legion-next-transformation-plan.md`.
- The nested prompt package contains a `00-overarching-transformation-plan.md` file and `phase-manifest.json`.
- For top-level execution in this repository, treat `legion-next-transformation-plan.md` as the overarching plan unless a phase worker is explicitly operating inside the nested packaged prompt directory.
- Do not silently rename or rewrite the rebuild package during roadmap work. If path normalization becomes necessary, handle it as a tracked documentation-maintenance task with an impact note.

## Original V8 Reference Inventory

Before a phase uses the original Legion repository as evidence, reconcile against the current checkout and the remote ref being used. The local checkout reviewed for this roadmap was version `8.0.5`, with the remote repository at `https://github.com/9thLevelSoftware/legion`.

Required v8 reference surfaces:

| Surface | Path | Why it matters |
| --- | --- | --- |
| Package manifest | `C:/Users/dasbl/Documents/legion/package.json` | Package name, version, scripts, published file list, runtime prerequisites, and dependencies. |
| Root documentation | `C:/Users/dasbl/Documents/legion/README.md` | Current user-facing command, install, runtime, and workflow behavior. |
| Agent instructions | `C:/Users/dasbl/Documents/legion/AGENTS.md` | Current workflow rules, command model, agent/skill index, and authority matrix. |
| Commands | `C:/Users/dasbl/Documents/legion/commands` | Legacy command surface that must be frozen, measured, bridged, migrated, or retired according to phase policy. |
| Skills | `C:/Users/dasbl/Documents/legion/skills` | Legacy workflow implementation and extraction source for functional worker bundles. |
| Agents | `C:/Users/dasbl/Documents/legion/agents` | Persona inventory and disposition input for persona purge and compatibility decisions. |
| Adapters | `C:/Users/dasbl/Documents/legion/adapters` | Host/runtime support surface and migration input for host bridges. |
| Tests | `C:/Users/dasbl/Documents/legion/tests` | Existing behavioral and validation coverage for v8 freeze, migration, and compatibility baselines. |
| Runtime audit | `C:/Users/dasbl/Documents/legion/docs/runtime-audit.md` | Host support claims and vendor-doc evidence surface. Re-audit when support claims affect implementation. |
| CI and publish workflows | `C:/Users/dasbl/Documents/legion/.github/workflows` | Existing release and validation behavior; do not assume this is the future v9 gate model. |
| Installer | `C:/Users/dasbl/Documents/legion/bin/install.js` | Legacy installation behavior and package bridge input. |

## Roadmap Rules

1. Execute phases in numeric order unless the phase document and dependency map explicitly allow a bounded preparation task.
2. Before editing code in any phase, read the selected phase document in full and reconcile every path/API assumption against the current `Legion Retooled` checkout.
3. Use the original v8 repository as a reference and baseline source, not as the implementation workspace.
4. Do not copy prompt-only persona behavior into the v9 default path unless the relevant phase document requires a compatibility artifact.
5. Every phase must produce durable evidence outside chat memory: ledger entries, commits, command outputs, hashes, run manifests, review decisions, and handoff notes.
6. A worker self-report is never enough to advance a gate. Follow the deterministic verification and independent review requirements in the phase document.
7. Missing files, stale assumptions, unsafe scope expansion, and unverified claims are blockers, not reasons to improvise.
8. Keep this roadmap as an index. Detailed execution changes belong in the phase document or in the implementation plan derived from it.

## Phase Index

Read each phase document directly for task contracts, waves, preconditions, exact verification commands, evidence requirements, stop conditions, rollback, and handoff templates.

| Phase | Source document | Gate dependency source |
| --- | --- | --- |
| 0 | `C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md` | Phase document sections 3, 8, 10, 11; dependency map architecture-feasibility cut line. |
| 1 | `C:/Users/dasbl/Documents/legion/docs/rebuild/01-phase-typescript-workspace-and-protocol-core.md` | Phase 0 handoff plus phase document sections 3, 8, 10, 11. |
| 2 | `C:/Users/dasbl/Documents/legion/docs/rebuild/02-phase-artifact-model-and-project-migration.md` | Phase 1 handoff plus phase document sections 3, 8, 10, 11. |
| 3 | `C:/Users/dasbl/Documents/legion/docs/rebuild/03-phase-transactional-kanban-control-plane.md` | Phase 2 handoff, Phase 0 storage ADR, and phase document sections 3, 8, 10, 11. |
| 4 | `C:/Users/dasbl/Documents/legion/docs/rebuild/04-phase-functional-worker-bundles-and-persona-purge.md` | Phase 3 handoff, Phase 1/2 protocol and artifact services, and phase document sections 3, 8, 10, 11. |
| 5 | `C:/Users/dasbl/Documents/legion/docs/rebuild/05-phase-runtime-driver-and-eve-integration.md` | Phase 4 handoff, Phase 3 dispatcher/workspace seam, Phase 0 Eve ADR, and phase document sections 3, 8, 10, 11. |
| 6 | `C:/Users/dasbl/Documents/legion/docs/rebuild/06-phase-baseline-specification-and-oracle-pipeline.md` | Phase 5 handoff, Phase 4 worker bundles, Phase 2 traceability services, and phase document sections 3, 8, 10, 11. |
| 7 | `C:/Users/dasbl/Documents/legion/docs/rebuild/07-phase-planner-task-contracts-and-preflight.md` | Phase 6 handoff, Phase 3 board services, Phase 4 architect/planner bundles, and phase document sections 3, 8, 10, 11. |
| 8 | `C:/Users/dasbl/Documents/legion/docs/rebuild/08-phase-fresh-context-task-execution-and-per-task-review.md` | Phase 7 handoff plus required Phase 3/4/5/6 capabilities and phase document sections 3, 8, 10, 11. |
| 9 | `C:/Users/dasbl/Documents/legion/docs/rebuild/09-phase-merge-queue-and-whole-change-acceptance.md` | Phase 8 handoff plus required Phase 3/6/7 capabilities and phase document sections 3, 8, 10, 11. |
| 10 | `C:/Users/dasbl/Documents/legion/docs/rebuild/10-phase-release-observation-and-rollback.md` | Phase 9 handoff plus required Phase 2/4/5 capabilities and phase document sections 3, 8, 10, 11. |
| 11 | `C:/Users/dasbl/Documents/legion/docs/rebuild/11-phase-kanban-dashboard-and-multi-project-operations.md` | Phase 10 handoff plus required Phase 3/5/8/9 capabilities and phase document sections 3, 8, 10, 11. |
| 12 | `C:/Users/dasbl/Documents/legion/docs/rebuild/12-phase-host-bridges-and-v8-migration.md` | Phase 11 handoff, Phase 8 CLI-first workflow, Phase 2 migration services, Phase 4 legacy map, current v8 audit, and phase document sections 3, 8, 10, 11. |
| 13 | `C:/Users/dasbl/Documents/legion/docs/rebuild/13-phase-behavioral-evals-security-hardening-and-ga.md` | Certified Phases 0-12, frozen v8 corpus, supported model/runtime/host/provider matrix, security/release governance, and phase document sections 3, 8, 10, 11. |

## Release Cut Lines

Use `C:/Users/dasbl/Documents/legion/docs/rebuild/CROSS-PHASE-DEPENDENCY-MAP.md` as the authoritative dependency map. Its cut lines should be reflected in implementation planning:

| Cut line | Phase boundary |
| --- | --- |
| Architecture feasibility | After Phase 0 |
| Typed foundation | After Phase 2 |
| Durable operational kernel | After Phase 5 |
| CLI-first MVP | After Phase 8 |
| Accepted change lifecycle | After Phase 9 |
| Production lifecycle | After Phase 10 |
| Operator/UI beta | After Phase 11 |
| Migration/host beta | After Phase 12 |
| General availability | After Phase 13 |

## Gate Model

Every phase follows this completion hierarchy from `AGENT-EXECUTION-GUIDE.md`:

```text
Task implementation
  -> deterministic verification
  -> independent task review
  -> task acceptance
  -> phase integration verification
  -> independent phase review
  -> phase handoff
  -> next phase
```

The implementation plan for each phase must name:

- the phase ledger path;
- the branch or worktree policy;
- the required predecessor evidence;
- the exact source phase document;
- task dispatch boundaries;
- deterministic verification commands;
- independent review criteria;
- phase integration evidence;
- handoff artifact path;
- blocker and change-control procedure.

## Evidence And Ledger Policy

Phase ledgers should live in the new implementation repository once the `.legion/` project state exists. Until Phase 0 establishes the final structure, use the bootstrap-equivalent path required by the Phase 0 document and record any deviation in the handoff.

Minimum evidence per accepted task:

- source phase document and task ID;
- base and head commit;
- run manifest or command transcript reference;
- deterministic verification output;
- review decision;
- accepted artifacts and hashes where applicable;
- blocker/change-control notes if any assumption changed.

Minimum evidence per accepted phase:

- complete phase ledger;
- integrated verification output;
- independent phase review;
- evidence bundle index;
- decisions and deviations;
- rollback/recovery note;
- next-phase handoff.

## Implementation Planning Handoff

When this roadmap is accepted, create a Phase 0 implementation plan from:

1. `C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md`
2. `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md`
3. `C:/Users/dasbl/Documents/legion/docs/rebuild/CROSS-PHASE-DEPENDENCY-MAP.md`
4. `C:/Users/dasbl/Documents/legion/docs/rebuild/AGENT-EXECUTION-GUIDE.md`
5. The original v8 reference surfaces listed in this roadmap.

The Phase 0 plan should not attempt to implement later phases. It should establish the rewrite charter, v8 freeze/baseline, ADR set, benchmark corpus, storage/Eve spikes, premortem, backlog, and go/no-go gate required before Phase 1 begins.

## Explicit Non-Goals For This Roadmap

- Do not duplicate the 151 task contracts into this file.
- Do not convert phase prompts into implementation tasks before Phase 0 planning.
- Do not scaffold the v9 workspace from this roadmap alone.
- Do not mutate the original v8 repository except through explicitly approved baseline or reference-capture tasks.
- Do not treat generated rebuild docs as infallible. Reconcile them against the current checkout before every edit.

## Roadmap Acceptance Checklist

- [ ] The source-document paths above resolve on the local machine.
- [ ] The top-level transformation-plan filename drift is understood.
- [ ] Phase 0 is accepted as the only immediate implementation-planning target.
- [ ] The original v8 repository is accepted as a reference/baseline input, not the new implementation workspace.
- [ ] Evidence, ledger, and independent-review gates are accepted as non-optional.
