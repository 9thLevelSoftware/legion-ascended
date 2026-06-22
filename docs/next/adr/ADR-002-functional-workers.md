# ADR-002: Functional Workers

## Status
Accepted

## Context
Legion v8 ships 48 built-in agent personas plus skills that inject complete personality files into execution, review, board, advisory, and planning workflows. The agent registry and mandatory persona contract provide useful operational discipline: read before writing, act from evidence, keep diffs minimal, verify before reporting, and emit `BLOCKED` when high-impact gaps remain. Individual persona files also contain domain checklists, examples, tool expectations, review strengths, and artifact types.

The v8 persona mechanism also carries product risks that the v9 plan explicitly rejects: long biographies, tone instructions, motivational framing, duplicate generic workflow rules, memory claims, and domain-specific authority mixed with personality. Full persona injection consumes context and can create conflicting instructions. The target v9 architecture calls for small functional roles, concise worker instructions, policy files, skills, rubrics, and domain packs.

Phase 0 must not delete v8 personas or stop publishing them during Milestone A. The decision here is for the v9 default runtime and migration policy, not for immediate v8 mutation.

## Decision
Persona removal is the v9 default. Functional worker bundles replace persona-first routing for new durable workflows. Runtime routing selects a functional role from task properties, risk tier, artifact type, write authority, and required domain packs. It does not select a fictional identity.

The default worker set is explorer, specifier, oracle-author, architect, planner, implementer, task-reviewer, integration-evaluator, and release-controller. A fixer is an implementer run over an approved findings set. A debugger is a skill or mode loaded by the implementer, not a separate persona. A governance deliberation participant is a council role, not a board work-control task owner.

Knowledge retained from v8 personas is extracted into these artifact types:

| Retained artifact | Contents |
| --- | --- |
| Skill packs | Reusable methods, investigation steps, framework-specific checks, security techniques, QA capture procedures, design workflows, and command usage patterns. |
| Rubrics | Review criteria, severity definitions, evidence requirements, acceptance standards, risk scoring examples, and finding formats. |
| Domain packs | Domain terminology, typical files, tools, artifact types, languages, frameworks, test approaches, and examples for a bounded specialty. |
| Capability metadata | Required tools, read/write authority, sandbox expectations, approval needs, and model policy hints. |
| Policy | Authority boundaries, stop gates, escalation rules, and protected-oracle constraints. |

The following persona content is discarded from the v9 default runtime:

| Discarded content | Reason |
| --- | --- |
| Biography and identity fiction | It does not improve enforceable behavior and increases prompt size. |
| Tone and personality traits | Style is not a durable contract. Worker output format and rubrics carry what matters. |
| Motivational language and slogans | It is non-load-bearing and can obscure requirements. |
| Repeated generic workflow rules | Shared worker policy owns these once. |
| Memory claims inside persona text | Operational memory belongs in committed intent, event logs, evidence indexes, and explicit memory artifacts, not a persona narrative. |
| Conflicting authority claims | Authority is defined by worker policy, task contract, and risk gates. |

The compatibility map is temporary and migration-only. It maps legacy persona IDs to `{functional role, domain packs, rubrics, capability metadata}` so existing v8 plans, outcomes, and historical evidence can be imported without losing meaning. The full 48-row migration table lives in `docs/next/migration/LEGACY-PERSONA-MAP.md`. New v9 task dispatch cannot use the compatibility map as the primary router. The map may be packaged with a legacy bridge for one major release after v9 GA, then removed in v10 unless telemetry and support evidence justify an approved extension.

Persona retention and discard inventory sample:

| v8 surface | Retain as | Discard from default prompt |
| --- | --- | --- |
| `agents/engineering-security-engineer.md` | `task-reviewer` or `architect` with `security-threat-model`, `owasp-review`, `stride-review`, `secrets-handling`, and `auth-boundaries` domain packs plus a high-risk security rubric. | Security persona biography, paranoia framing, experience claims, tone rules, and repeated done criteria already covered by worker policy. |
| `agents/testing-qa-verification-specialist.md` | `task-reviewer` or `integration-evaluator` with evidence-quality rubric, visual/API/CLI verification pack, root-cause debugging skill, and regression-test checklist. | Character name, fantasy-reporting rhetoric, exaggerated quality-score guidance, and repeated generic validation rules. |
| `agents/project-manager-senior.md` | `planner` with task-contract decomposition rubric, dependency analysis, acceptance criteria authoring, and scope-control policy. | Project-manager identity story and coordination style prose. |
| `agents/design-ui-designer.md` | `specifier`, `architect`, or `task-reviewer` domain pack for design-system artifacts, accessibility, component consistency, and visual QA. | Creative identity framing and subjective style language not tied to reviewable criteria. |
| `skills/agent-registry/SKILL.md` | Capability metadata, task-type scoring concepts, domain catalog, and migration import aid. | Persona ranking as a production dispatch authority after v9 functional routing exists. |
| `skills/board-of-directors/SKILL.md` and `commands/board.md` | Optional `council` governance deliberation workflow with read-only council participants and signed decisions. | Use of `board` for governance naming in the v9 operational Kanban surface. |

## Consequences
Worker prompts become shorter, more deterministic, and easier to test. Domain expertise is retained as reviewable assets with explicit authority and evidence requirements instead of being mixed with tone and identity.

Migration work must include an extraction pass before removing any default persona behavior. Persona removal is blocked if a persona contains unique domain knowledge that has not been captured in a skill, rubric, domain pack, capability record, or policy artifact.

Existing v8 users keep the shipped personas while the v8 line remains the maintenance line. v9 users may opt into a legacy bridge during migration, but the durable runtime does not depend on legacy persona injection.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Keep full persona injection as v9 default | It keeps the context bloat, mixed authority, and conflicting instruction risks the rewrite is designed to remove. | Only revisit if parity evaluations prove functional bundles cannot preserve required outcomes after complete knowledge extraction. |
| Compress each persona into a shorter persona | Compression still routes by identity and keeps authority mixed with style. It is a smaller version of the same mechanism. | Revisit only as a bridge artifact for imported v8 plans, not as default dispatch. |
| Drop personas without extraction | This risks losing domain knowledge such as OWASP checklists, QA evidence methods, adapter quirks, and design review criteria. | No planned revisit; this is a stop condition. |
| Use the compatibility map as runtime router | It would preserve legacy names as the real control surface and delay functional routing. | Revisit only for legacy bridge telemetry, not core dispatch. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-002, includes extraction parity evidence, preserves the temporary-only compatibility-map rule, and records migration impact for v8 persona users.
