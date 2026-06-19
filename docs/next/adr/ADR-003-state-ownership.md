# ADR-003: State Ownership

## Status
Accepted

## Context
The transformation plan requires one authoritative source for each class of data. v8 stores project progress in `.planning/STATE.md`, `.planning/ROADMAP.md`, summaries, review Markdown, outcomes memory, Git commits, and host transcripts. That is workable for a prompt protocol, but it allows Markdown status and Git history to drift, makes leases and queues non-transactional, and leaves process loss or compaction as operational risks.

The v9 repository layout separates committed, reviewable intent from ignored operational data:

| Path | Role |
| --- | --- |
| `.legion/project` | Committed, reviewable intent: constitution, specs, changes, designs, task graphs, ADRs, decisions, and evidence indexes. |
| `.legion/var` | Ignored operational data: board database, task events, runs, leases, workspaces, caches, outbox, and non-committed runtime state. |
| Artifact store | Bulk logs, traces, screenshots, reports, and telemetry payloads with hashes referenced from committed evidence indexes. |
| Git | Code state, branches, commits, tags, and reviewable history. |

Existing `.planning/` projects are imported with a backup and then treated as read-only legacy inputs. Dual synchronization between `.planning/` and `.legion/` is forbidden.

## Decision
Each target domain state class has exactly one canonical source:

| State class | Canonical source | Notes |
| --- | --- | --- |
| Project | `.legion/project/constitution.md` and project metadata under `.legion/project` | Defines repository and policy boundary. |
| Change | `.legion/project/changes/<change-id>/change.yaml` | Root record for proposed work. |
| Requirement | `.legion/project/specs/**` for current truth and `.legion/project/changes/<change-id>/delta-specs/**` for proposed truth | Current and proposed requirements are versioned intent, not operational rows. |
| Decision | `.legion/project/adr/**` for architecture decisions and `.legion/project/changes/<change-id>/decisions.md` for scoped decisions | Supersession requires new committed revisions. |
| Oracle | `.legion/project/changes/<change-id>/oracle/**` | Protected acceptance criteria and expected evidence. |
| TaskContract | `.legion/project/changes/<change-id>/taskgraph.json` | Machine-validated contract graph, dependencies, scopes, and oracle references. |
| Task | `.legion/var/board.sqlite` append-only task events | Current task rows are projections rebuilt from task events. |
| TaskRun | `.legion/var/board.sqlite` `task_runs` plus immutable run manifests under `.legion/var/runs/<run-id>/manifest.json` | Records attempt, pinned versions, runtime driver, worker bundle, base commit, and idempotency key. |
| EvidenceBundle | Artifact store payloads, with accepted references in `.legion/project/changes/<change-id>/evidence-index.json` | Git contains hashes and verdicts, not necessarily bulk evidence. |
| ReviewDecision | `.legion/var/board.sqlite` review decision events until accepted, then accepted verdict reference in the change evidence index | The accepted reference is reviewable intent; the event stream is operational provenance. |
| Approval | `.legion/var/board.sqlite` approval events and approval records | Human authorization is operational state with audit fields, not a comment. |
| Release | `.legion/project/changes/<change-id>/release.md` for approved release intent, `.legion/var/board.sqlite` for release runs and observation events | Intent and operations are separated by state class. |
| Observation | Artifact store payloads and `.legion/var/board.sqlite` observation events | Accepted observation summaries can be referenced from evidence indexes. |
| Event | `.legion/var/board.sqlite` append-only event tables | Events are facts used to rebuild operational projections. |
| Code state | Git commits, branches, and tags | No board row or evidence file can substitute for Git state. |
| Worker bundle definitions | Versioned package/workspace files in the v9 source tree | Runtime selection references a versioned bundle, not a transcript. |
| Runtime session checkpoint | Runtime driver storage plus `.legion/var` run records | Driver checkpoints do not own Legion task state. |
| Outbox item | `.legion/var/board.sqlite` outbox table | Side effects are retried from outbox records with idempotency keys. |
| Derived projection | Rebuilt from the canonical source for that state class | Projections are cacheable and disposable. |
| Comment or discussion note | Non-authoritative coordination record in `.legion/var/board.sqlite` comments or external channel | Scope changes must revise committed intent and emit events. |

`.legion/project` is the only committed Legion project state path. `.legion/var` is ignored and must not be committed. `.legion/project` must not contain mutable leases, queue state, active claims, retry counters, runtime caches, or provider session state. `.legion/var` must not become the only copy of approved specs, ADRs, task contracts, release intent, or accepted evidence references.

Reconciliation behavior:

| Condition | Required behavior |
| --- | --- |
| Git evidence index references missing artifact payload | Mark evidence unavailable and block acceptance until restored or explicitly superseded. |
| Board projection disagrees with append-only events | Rebuild projection from events; projection loses. |
| Board task state disagrees with committed task contract | The task is invalidated or blocked; committed contract loses only after an approved contract revision. |
| Runtime driver says a session is active but board lease expired | Reconcile runtime session before redispatch; do not duplicate work blindly. |
| `.planning/` and `.legion/project` disagree after import | `.legion/project` wins after accepted migration; `.planning/` remains historical input. |
| Comment requests a scope change | Create a structured revise-change action; comments do not change scope by implication. |

## Consequences
Mutable operational data has a transactional owner, reviewable intent has a Git owner, code state remains owned by Git, and bulk evidence can be retained without forcing sensitive or large logs into the repository.

Workers and tools must treat current rows, dashboards, summaries, and chat messages as projections unless this ADR names them as canonical for a state class. This reduces convenience but prevents silent drift.

Migration tooling must preserve `.planning/` backups, import without mutating user-owned source during shadow mode, and avoid dual-write compatibility paths.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Store all Legion state in `.legion/project` | Git-tracked files cannot safely own leases, queues, retries, active claims, and concurrent task events. | Revisit only for committed intent classes or read-only projections. |
| Store all Legion state in `.legion/var` | Approved specs, ADRs, contracts, and evidence references would stop being reviewable and portable through Git. | No planned revisit; this violates the charter. |
| Keep `.planning/` and `.legion/` synchronized indefinitely | Dual sources invite drift and ambiguous ownership. | Revisit only for one-way import diagnostics during migration. |
| Treat runtime driver checkpoints as task database | A runtime session is one execution attempt. It is not the scheduler, board, or source of task truth. | Revisit only if a driver exposes a documented durable queue contract and an ADR assigns ownership. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-003, provides a complete replacement ownership matrix, and proves no mutable state class has two canonical writers.
