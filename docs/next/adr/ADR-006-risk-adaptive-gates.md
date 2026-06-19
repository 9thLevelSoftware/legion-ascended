# ADR-006: Risk Adaptive Gates

## Status
Accepted

## Context
The transformation plan rejects one fixed workflow for every task. It requires real-interface verification proportional to risk, independent oracle and review for material changes, typed boundaries, idempotent side effects, human approval by policy, and deterministic gates before acceptance.

The risk system must not become a subjective label that lets a worker skip protections. It must derive from explicit inputs, produce mandatory gates, allow escalation when uncertainty is high, and preserve constitution or charter protections.

## Decision
Legion Next uses deterministic risk tiers R0 through R3. Risk is computed from structured task metadata, scope, source changes, oracle requirements, side effects, and project policy. The computed tier is the maximum of hard floors and score thresholds.

Scoring inputs:

| Input | Score 0 | Score 1 | Score 2 | Score 3 |
| --- | --- | --- | --- | --- |
| Security, privacy, authorization | None | Internal-only low sensitivity | User data or permission-relevant | Auth, secrets, payment, regulated data, or privilege boundary |
| Persistent data or migration | None | Local cache only | User/project persistent state | Destructive migration or irreversible state change |
| External side effects | None | Local Git only | Reversible external effect | Production, public, financial, destructive, or hard-to-reverse effect |
| Public API or schema compatibility | None | Internal-only | User-visible API or schema | Breaking public API, package, or migration contract |
| Blast radius | One file or generated artifact | Isolated module | Multi-module or user-facing path | Cross-system, release, infra, or many dependents |
| Reversibility | Fully revertible | Revertible with minor cleanup | Requires migration or coordinated rollback | Hard to reverse or data-loss risk |
| Novelty and uncertainty | Known pattern | Minor unknowns | New integration or weak local knowledge | New architecture, provider, or high ambiguity |
| Existing verification quality | Strong targeted tests | Some coverage | Weak coverage | No executable oracle for material behavior |
| Deployment criticality | No deployment | Local/dev only | Preview/staging | Production or release-channel effect |

Tier calculation:

| Result | Rule |
| --- | --- |
| R0 | Total score 0 to 2 and no hard floor above R0. |
| R1 | Total score 3 to 5 or any single input at 2 without R2/R3 hard floor. |
| R2 | Total score 6 to 8, user-facing behavior, persistent project state, public schema, multi-file integration, or material review surface. |
| R3 | Total score 9 or greater, any input at 3, auth/security boundary, secrets, payment, destructive migration, public API break, production infrastructure, release promotion, or hard-to-reverse external side effect. |

Mandatory gates:

| Tier | Required gates |
| --- | --- |
| R0 | Current task contract or approved small-change record, deterministic verification, evidence note, optional review when policy allows. |
| R1 | Task contract, scoped implementer run, deterministic verification, evidence bundle or log, lightweight independent review. |
| R2 | Approved delta spec, protected oracle, task contract, deterministic verification, task-level independent review, integration or real-interface checks, whole-change acceptance evidence. |
| R3 | Independent baseline, approved spec and oracle, architecture or security review as applicable, protected acceptance tests, security or e2e evaluator, explicit human approval for gated actions, canary or observation plan for releases, rollback or forward-fix evidence where practical. |

Risk gates may increase protections but may not silently decrease constitution, charter, security, or task-contract protections. If the constitution requires review for a class of change, an R0 score cannot waive that review. If a task contract names a protected oracle, lower risk cannot remove it. Automatic classification can raise a tier. Lowering a tier requires an override record.

Override authority:

| Override | Authority | Audit requirement |
| --- | --- | --- |
| Raise tier | Policy engine, reviewer, security owner, migration owner, runtime owner, decision owner | Record reason and triggering input. |
| Lower tier | Decision owner `dasbl`, or delegated owner named in the constitution for that domain | Record original tier, new tier, reason, evidence, approver, date, and protections that remain. Cannot go below constitution or charter floors. |
| Waive a gate | Same authority as lowering tier, plus domain owner for waived gate | Record replacement evidence or accepted risk. Cannot waive protected oracle or explicit human approval for S4 effects without a new ADR or constitution revision. |

Deterministic examples:

| Example | Scores | Tier | Gates |
| --- | --- | --- | --- |
| Fix typo in committed docs | Security 0, data 0, side effect 0, API 0, blast 0, reversibility 0, novelty 0, tests 1, deploy 0, total 1 | R0 | Deterministic docs check and evidence note. |
| Refactor isolated internal utility with tests | Security 0, data 0, side effect 0, API 1, blast 1, reversibility 0, novelty 1, tests 1, deploy 0, total 4 | R1 | Task contract, tests, evidence, lightweight review. |
| Add user-facing CLI command touching multiple modules | Security 0, data 1, side effect 1, API 2, blast 2, reversibility 1, novelty 1, tests 2, deploy 1, total 11 with user-facing floor | R3 by total | R3 gates unless scoped policy override lowers no further than R2 with audit. |
| Add persistent board migration | Security 0, data 3, side effect 1, API 2, blast 2, reversibility 2, novelty 2, tests 2, deploy 1, total 15 | R3 | Migration oracle, dry-run, rollback or forward-fix evidence, review, approval. |
| Rotate production credential | Security 3, data 0, side effect 3, API 0, blast 3, reversibility 2, novelty 1, tests 2, deploy 3, total 17 | R3 | Security review, explicit approval, outbox, rollback or recovery evidence, observation. |

## Consequences
Workers can select workflow machinery from task facts instead of preference or confidence. Reviewers can challenge a tier by pointing to specific scoring inputs.

The system avoids forcing R3 process on every docs or metadata change, but it also prevents low-risk labels from weakening charter protections. Audit records make exceptions visible.

Some borderline work will score higher than a human might intuitively expect. That is acceptable because uncertainty, poor tests, and public side effects are real risk inputs.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Single mandatory workflow for all tasks | It over-processes low-risk work and encourages bypassing the system. | Revisit only if measured evidence shows adaptive gates are more costly than a fixed workflow. |
| Subjective low, medium, high labels | Subjective labels are hard to audit and easy to manipulate. | Revisit only with a better deterministic rubric. |
| Let implementers lower gates inline | This would allow the worker under review to weaken its own acceptance path. | No planned revisit. |
| Let risk gates override constitution protections | The constitution and charter are higher authority than a task classifier. | No planned revisit. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-006, provides deterministic replacement scoring, preserves audit requirements, and proves lower tiers cannot silently weaken constitution, charter, or protected-oracle protections.
