# ADR-009: Workflow-First CLI

## Status
Accepted

## Context
ADR-007 correctly reserved `board` for operational Kanban and moved governance deliberation to `council`. It also exposed typed v9 nouns such as `change`, `run`, and `board` as the visible command migration targets for many v8 slash commands.

That made the implementation architecture visible as the user workflow. The v8 compatibility baseline says the product workflow concepts that must survive are start, explore, map, plan, build, review, status, quick, advise, polish, learn, milestone, ship, retro, validate, and related governance. A typical user should not author worker bundle manifests, compute prompt hashes, or choose internal typed nouns before they can run the workflow.

## Decision
The canonical user-facing command surface is `legion <workflow>`.

The workflow commands are:

| Command | Purpose |
| --- | --- |
| `legion start` | Initialize a project through guided or flag-based setup. |
| `legion explore` | Produce a design discovery artifact before start or planning. |
| `legion map` | Generate, refresh, check, or query codebase context. |
| `legion plan <phase-or-change>` | Produce a typed plan and task graph from project intent. |
| `legion build` | Execute approved task contracts through the runtime driver. |
| `legion review` | Run deterministic verification and independent review gates. |
| `legion ship` | Run release readiness, promotion, and observation gates. |
| `legion retro` | Record retrospective evidence that feeds future planning. |
| `legion status` | Show current state and the next recommended workflow command. |
| `legion quick <task>` | Run a single ad-hoc task with a task record and risk classification. |
| `legion advise <topic>` | Run read-only advisory analysis. |
| `legion polish [target]` | Run scoped cleanup as an ad-hoc workflow. |
| `legion learn <lesson>` | Record project-specific operational learning. |
| `legion milestone` | Manage milestone status, summary, and archive. |
| `legion validate` | Validate committed Legion project state. |
| `legion doctor` | Validate state plus operational health, packaging, and runtime readiness. |
| `legion council` | Run the old governance board workflow under the non-conflicting name. |

Typed engine commands remain available under `legion dev`:

| Command | Purpose |
| --- | --- |
| `legion dev project` | Direct project artifact service operations. |
| `legion dev change` | Direct change bundle service operations. |
| `legion dev board` | Direct operational Kanban and event-store operations. |
| `legion dev migrate` | Direct legacy import, apply, and rollback operations. |
| `legion dev evals` | Release-grade sealed eval and A/B comparison operations. |
| `legion dev release` | GA checklist and rollback-policy verifier operations. |
| `legion dev worker` | Worker bundle validation and extension authoring tools. |

`legion next ...` remains a hidden compatibility alias to the matching `legion dev ...` command for one major v9 preview cycle. It must not appear in root help. `legion ascended ...` is not part of the command flow.

In this decision, worker bundle authoring is an internal developer workflow. Normal `legion plan`, `legion build`, and `legion review` users consume registered worker bundles indirectly through typed dispatch; they do not edit bundle manifests or compute prompt hashes.

## Consequences
The CLI preserves the original product mental model while retaining the v9 typed engine. Documentation, help text, examples, and release policy must stop presenting `legion next` as the primary command path.

ADR-007 remains authoritative for the board/council naming collision. This ADR supersedes only the user-facing command disposition table where it exposed typed nouns as the front-door UX.

## Review And Approval
- Approver: dasbl
- Date: 2026-06-22
- Supersession rule: Supersede only by a later accepted ADR that names ADR-009 and provides a full replacement command table for both workflow and dev surfaces.
