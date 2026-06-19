# ADR-007: Board, Council, And Kanban Migration

## Status
Accepted

## Context
The transformation plan uses `board` for durable operational Kanban, task state, claims, events, and dispatcher control. v8 already has `/legion:board`, but that command convenes a governance board of directors for high-stakes deliberation using persona-based assessment, discussion, voting, resolution, and optional persistence under `.planning/board`.

Using `board` for both operational work control and governance deliberation would confuse CLI, API, database, and user-facing concepts. Phase 0 must choose names before v9 Kanban ships and must preserve v8 behavior during the transition.

## Decision
Reserve `board` for operational Kanban and work-control state. Reserve `council` for optional governance deliberation. The v9 board owns task lifecycle, workflow stage, claims, runs, events, approvals, dispatcher state, projections, and operational views. The v9 council is optional, read-only by default, and produces governance advice or decision records when explicitly invoked.

Naming rules:

| Name | Meaning |
| --- | --- |
| `board` | Operational Kanban, task graph projection, work-control state, claims, queues, dispatcher, and dashboard. |
| `council` | Optional governance deliberation, multi-perspective advisory review, vote, dissent, and decision record. |
| `task` | Smallest operational work item derived from a task contract or workflow action. |
| `change` | Reviewable unit of proposed behavior or policy change. |
| `run` | One version-pinned execution attempt for a task or change. |

Migration policy:

| Policy | Decision |
| --- | --- |
| v8 preservation | Do not delete, rename, or stop publishing v8 `/legion:*` commands during Milestone A. |
| Legacy aliases | Legacy slash commands may exist for one major v9 release as compatibility aliases. They must emit migration guidance and route to typed v9 commands. |
| Board collision | v8 `/legion:board` governance behavior is renamed to `legion council` in v9. `/legion:board` as a legacy alias may route to `legion council` with a deprecation warning, not to operational Kanban. |
| New board | `legion board` is the operational Kanban command and must never invoke governance deliberation. |
| Removal | Commands marked remove are not part of the v9 workflow surface. A legacy bridge may print guidance, but it must not create operational board events. |

Disposition for every current v8 `/legion:*` command:

| Current v8 command | Disposition | v9 target | Rationale |
| --- | --- | --- | --- |
| `/legion:advise` | Alias | `legion run --read-only-advice` | Advisory work becomes a read-only run profile with no write authority. |
| `/legion:agent` | Rename | `legion worker create` | Custom identities become worker bundle, skill, rubric, and domain-pack extension points. |
| `/legion:board` | Rename | `legion council` | The `board` name is reserved for operational Kanban. Governance deliberation moves to council. |
| `/legion:build` | Rename | `legion run task` or `legion run change` | Durable execution is a run over approved task contracts, not phase Markdown execution. |
| `/legion:explore` | Alias | `legion baseline` or `legion change create --explore` | Discovery becomes baseline and change-intake work before spec/oracle/design. |
| `/legion:learn` | Alias | `legion observe --record-learning` | Learning becomes observation/evidence metadata rather than free-form persona memory. |
| `/legion:map` | Rename | `legion baseline --refresh` | Codebase mapping becomes current-truth baseline refresh. |
| `/legion:milestone` | Rename | `legion release` and `legion archive` | Milestone lifecycle maps to release aggregation and archived evidence. |
| `/legion:plan` | Rename | `legion change plan` | Planning is one stage in the typed change pipeline after spec, oracle, and design as required. |
| `/legion:polish` | Alias | `legion run task --skill code-polish` | Polish remains an optional quality task, not a phase-completion shortcut. |
| `/legion:portfolio` | Alias | `legion board --portfolio` | Multi-project visibility becomes a board projection across projects. |
| `/legion:quick` | Alias | `legion change create --adhoc` followed by `legion run task` | Ad hoc work still gets a change or task record and risk classification. |
| `/legion:retro` | Alias | `legion archive --retrospective` | Retrospective output becomes archived evidence and observation metadata. |
| `/legion:review` | Keep | `legion review` | Review remains a first-class gate, with v9 typed evidence and risk rules. |
| `/legion:ship` | Rename | `legion release` then `legion observe` | Shipping becomes release plus observation workflow. |
| `/legion:start` | Alias | `legion init` plus first `legion change create` | Initialization splits project setup from change intake. |
| `/legion:status` | Alias | `legion board` | Status is a projection of operational board and change state. |
| `/legion:update` | Remove | Package manager or installer update path outside v9 workflow | Updating Legion is not project work-control state. The legacy bridge may print update guidance only. |
| `/legion:validate` | Rename | `legion doctor` | State and schema validation become a doctor command. |

## Consequences
Users and APIs get one meaning for board. Operational Kanban state can be modeled cleanly without colliding with governance deliberation records.

Existing v8 command names remain available in the v8 line. v9 compatibility aliases can reduce migration friction while making the target command visible.

Any documentation, CLI help, API route, schema, database table, or worker instruction using `board` for governance must be corrected before v9 Kanban ships. Governance deliberation uses `council`.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Keep `/legion:board` for governance and choose another Kanban name | The transformation plan and target architecture use board for operational work control. Renaming the new central surface would make the architecture less clear. | Revisit only before any v9 board API ships, with a full rename plan. |
| Use `council` for Kanban and keep board for governance | Council implies deliberation, not task operations, claims, queues, and dispatcher state. | No planned revisit. |
| Keep both meanings under `board` with subcommands | The ambiguity would leak into API naming, evidence, docs, and user mental models. | No planned revisit. |
| Delete legacy commands immediately | Milestone A forbids deleting, renaming, or stopping publication of v8 commands and personas. | Revisit only after v9 GA migration evidence and approved deprecation policy. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-007, provides a complete replacement command disposition table, and proves `board` and `council` cannot be confused in CLI, API, database, or documentation naming.
