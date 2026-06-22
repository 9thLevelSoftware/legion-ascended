# Legion Ascended — Kanban Board Manifest

## Board
- **Slug:** legion-ascended
- **Name:** Legion Ascended Rebuild
- **Workdir:** /Users/christopherwilloughby/legion-ascended
- **Created:** 2026-06-21

## Model Routing

| Role | Profile | Model | Provider | Notes |
| --- | --- | --- | --- | --- |
| Coordinator | default | MiMo 2.5 Pro | xiaomi | Orchestrator, not on kanban |
| Worker (implementation) | legionworker | MiniMax-M3 | minimax | Primary for all implementation tasks |
| Worker fallback | legionworker | Kimi 2.7 Code | opencode-go | Auto-fallback on 429/503/529 |
| Reviewer (closeouts) | otrlead | GPT-5.5 | openai-codex | Phase closeout and review tasks |
| Decomposer | (default) | GPT-5.4-mini | openai-codex | Kanban auto-decompose |
| Compression | (default) | MiniMax-M3 | minimax | Context compression |
| Auxiliary vision | (default) | GPT-5.5 | openai-codex | Image analysis |

## Execution Policy
1. Tasks execute sequentially within each phase (dependency-gated).
2. Phases execute sequentially: Phase 3 → Phase 4 → ... → Phase 13.
3. Each completed phase produces a PR to `main` with:
   - All CI checks passing (typecheck, tests, boundaries, validate:next)
   - Independent review (GPT-5.5 via otrlead)
   - Evidence bundle in `docs/next/evidence/PXX-TYY/`
   - Ledger update in `.legion/project/changes/LEGION-NEXT/implementation/phase-XX/`
4. PRs auto-merge after CI green + review approval.
5. Next phase/task begins automatically after merge.

## Release Cut Lines
| Cut Line | Phase Boundary |
| --- | --- |
| Architecture feasibility | After Phase 0 ✓ |
| Typed foundation | After Phase 2 ✓ |
| Durable operational kernel | After Phase 5 ✓ |
| CLI-first MVP | After Phase 8 ✓ |
| Accepted change lifecycle | After Phase 9 ✓ |
| Production lifecycle | After Phase 10 |
| Operator/UI beta | After Phase 11 |
| Migration/host beta | After Phase 12 |
| General availability | After Phase 13 |

## V8 vs V9 Comparison Reference
When implementing, compare against original Legion (v8) at:
- **Repo:** /Users/christopherwilloughby/legion
- **Remote:** https://github.com/9thLevelSoftware/legion
- **Baseline:** v8-baseline-20260619 (commit 855e975b)
- **Version:** 8.0.5

## Task Graph

### Phase 3: Transactional Kanban Control Plane
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-03/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P03-T01 | (merged) | — | DONE | — |
| P03-T02 | t_32ee9643 | legionworker | DONE | — |
| P03-T03 | t_e7f1472b | legionworker | DONE | T02 |
| P03-T04 | t_b97b16c2 | legionworker | DONE | T02 |
| P03-T05 | t_9688ab59 | legionworker | DONE | T03 |
| P03-T06 | t_3087e572 | legionworker | DONE | T02 |
| P03-T07 | t_c30027ce | legionworker | DONE | T02 |
| P03-T08 | t_7a5019fa | legionworker | DONE | T02 |
| P03-T09 | t_8ffa8ee7 | legionworker | DONE | T03-T08 |
| P03-T10 | t_650927a3 | legionworker | DONE | T09 |
| P03-T11 | t_50c978e2 | **otrlead** | DONE | T10 |

### Phase 4: Functional Worker Bundles and Persona Purge
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-04/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P04-T01 | t_ad40aa58 | legionworker | DONE | P03-T11 |
| P04-T02 | t_2613b3e4 | legionworker | DONE | T01 |
| P04-T03 | t_644ab6c2 | legionworker | DONE | T01 |
| P04-T04 | t_992af897 | legionworker | DONE | T02,T03 |
| P04-T05 | t_ac36e4e9 | legionworker | DONE | T04 |
| P04-T06 | t_0debf216 | legionworker | DONE | T04 |
| P04-T07 | t_174d7346 | **otrlead** | DONE | T05,T06 |

### Phase 5: Runtime Driver and Eve Integration
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-05/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P05-T01 | t_1c45d2fa | legionworker | DONE | P04-T07 |
| P05-T02 | t_06a1f415 | legionworker | DONE | T01 |
| P05-T03 | t_20beaed8 | legionworker | DONE | T01 |
| P05-T04 | t_1e2a51f0 | **otrlead** | DONE | T02,T03 |

### Phase 6: Baseline Specification and Oracle Pipeline
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-06/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P06-T01 | t_5008bcfb | legionworker | DONE | P05-T04 |
| P06-T02 | t_a924dd03 | legionworker | DONE | T01 |
| P06-T03 | t_b7f23936 | **otrlead** | DONE | T02 |

### Phase 7: Planner Task Contracts and Preflight
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-07/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P07-T01 | t_8c382c22 | legionworker | DONE | P06-T03 |
| P07-T02 | t_d731d488 | legionworker | DONE | T01 |
| P07-T03 | t_0c533e06 | **otrlead** | DONE | T02 |

### Phase 8: Fresh Context Task Execution and Per-Task Review
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead; CLI-first MVP cut line reached)
**Ledger:** `.legion/project/changes/LEGION-NEXT/implementation/phase-08/`

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P08-T01 | t_1111b940 | legionworker | DONE | P07-T03 |
| P08-T02 | t_9321f68b | legionworker | DONE | T01 |
| P08-T03 | t_be46700c | **otrlead** | DONE | T02 |

### Phase 9: Merge Queue and Whole Change Acceptance
**Status:** DONE (closeout reviewed by GPT-5.5 / otrlead; Accepted Change Lifecycle cut line reached)

| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P09-T01 | t_cf3bdb25 | legionworker | DONE | P08-T03 |
| P09-T02 | t_13698b40 | legionworker | DONE | T01 |
| P09-T03 | t_095363c6 | **otrlead** | DONE | T02 |

### Phase 10: Release Observation and Rollback
| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P10-T01 | t_ec8b37af | legionworker | DONE | P09-T03 |
| P10-T02 | t_4e06d5c7 | legionworker | todo | T01 |
| P10-T03 | t_b98d1428 | **otrlead** | todo | T02 |

### Phase 11: Kanban Dashboard and Multi-Project Operations
| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P11-T01 | t_249912d8 | legionworker | todo | P10-T03 |
| P11-T02 | t_86857911 | legionworker | todo | T01 |
| P11-T03 | t_d7c20b33 | **otrlead** | todo | T02 |

### Phase 12: Host Bridges and V8 Migration
| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P12-T01 | t_ca438233 | legionworker | todo | P11-T03 |
| P12-T02 | t_20172b35 | legionworker | todo | T01 |
| P12-T03 | t_0f093435 | **otrlead** | todo | T02 |

### Phase 13: Behavioral Evals, Security Hardening, and GA
| Task | ID | Assignee | Status | Dependencies |
| --- | --- | --- | --- | --- |
| P13-T01 | t_12f977b4 | legionworker | todo | P12-T03 |
| P13-T02 | t_6712c51d | legionworker | todo | T01 |
| P13-T03 | t_21e41997 | legionworker | todo | T02 |
| P13-T04 | t_50860be4 | **otrlead** | todo | T03 |

## Summary
- **Total tracked tasks:** 47 (P03-T01 plus 46 board-created tasks)
- **Completed through Phase 10:** 35 tasks (P03-T01 through P10-T01)
- **Remaining tasks:** 12 (8 worker tasks, 4 review/closeout tasks)
- **Current:** P10-T01 is DONE; P10-T02 is next (CLI wiring on top of release observation, dependency-gated on P10-T01)
- **Final:** P13-T04 (GA decision)
