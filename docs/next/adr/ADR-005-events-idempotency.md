# ADR-005: Events And Idempotency

## Status
Accepted

## Context
Legion Next needs durable recovery without claiming deterministic model replay. The transformation plan requires typed boundaries, append-only events, idempotent side effects, transactional operations, run manifests, outbox records, and explicit distinction between event replay and nondeterministic model re-execution.

v8 execution and review workflows already contain useful operational rules: verification-gated completion, no completion by retry exhaustion, structured result files, adapter-specific result collection, and state updates after work. Those rules become stronger in v9 when represented as events, task runs, approvals, outbox rows, and evidence references.

## Decision
Legion event delivery is at-least-once. Every event handler, projection builder, and outbox dispatcher must tolerate duplicate delivery. Exactly-once external side effects are not assumed.

Event and idempotency vocabulary:

| Term | Definition |
| --- | --- |
| Event ID | Stable unique identifier for one append-only fact. Format: `evt_<time-sortable-id>`. Event IDs are generated before commit and never reused. |
| Event type | Versioned protocol name such as `task.claimed.v1`, `run.started.v1`, `approval.granted.v1`, or `outbox.effect_succeeded.v1`. |
| Idempotency key | Stable key for a logical operation or external side effect. Format: `<project-id>:<change-id>:<task-id>:<run-id>:<effect-kind>:<target-hash>`. |
| Run attempt key | Stable key for one task attempt. Retries of the same logical attempt reuse the key; a deliberate new attempt receives a new attempt number. |
| Outbox item | Transactional record of a side effect to dispatch after state changes commit. |
| Replay | Rebuilding Legion projections from committed events without re-calling models or repeating external side effects. |
| Re-execution | Starting a new or resumed model/tool run from recorded inputs and manifests. It is nondeterministic unless the tool itself is deterministic. |

Outbox rules:

| Rule | Requirement |
| --- | --- |
| Transaction boundary | State change, event append, and outbox intent are written in one transaction. |
| No pre-commit side effects | A worker may not perform an external side effect before the outbox intent exists. |
| Stable key | Each outbox item stores an idempotency key derived from logical operation and target. |
| Dispatch | Dispatchers may retry at-least-once and must persist attempt count, result, provider reference, and terminal failure. |
| Success event | Successful side effects append `outbox.effect_succeeded.v1` with provider reference and artifact hash where available. |
| Failure event | Exhausted or permanent failures append `outbox.effect_failed.v1` and block or escalate by risk policy. |
| Poison handling | Repeated failure auto-blocks the task rather than thrashing. |
| Human gate | Side effects requiring approval cannot dispatch until a durable approval record exists. |

Side-effect classification:

| Class | Examples | Rule |
| --- | --- | --- |
| S0 pure computation | Risk scoring, schema validation, projection rebuild | No outbox required; deterministic inputs and outputs should be recorded when material. |
| S1 local idempotent write | Write a generated projection to a content-addressed path, rebuild a cache | Allowed when target path and content hash match the task contract. Duplicate writes must converge to same bytes. |
| S2 Git side effect | Commit, tag, branch, PR body draft | Requires idempotency by tree, parent, message, and change ID. Publishing tags or PRs also requires approval when policy says so. |
| S3 external reversible side effect | Create PR, post comment, create issue, trigger preview, send notification | Requires outbox dedupe by provider target and logical key. Approval required when external visibility or user impact is material. |
| S4 external destructive or hard-to-reverse side effect | Deploy production, delete resource, destructive migration, rotate credentials | Requires explicit human approval, dry-run or rollback evidence where practical, and outbox dedupe. Cannot be auto-dispatched by retry alone. |

Non-idempotent side effects are permitted only when they are approval-gated or deduplicated through an outbox rule:

| Side effect | Approval or dedupe rule |
| --- | --- |
| Git commit | Dedupe by tree hash, parent hash, author intent, and commit message. If matching commit already exists, record reference instead of creating another. |
| Git tag | Dedupe by tag name and target object. Moving a tag requires explicit approval. |
| Pull request creation | Dedupe by change ID, branch, base branch, and PR marker in body. If a matching PR exists, update through an approved outbox item rather than creating another. |
| External comment or notification | Dedupe by provider thread, logical message key, and content hash. |
| Deployment or migration | Requires human approval, dry-run or rollback evidence where practical, and a deployment idempotency key. |
| Runtime approval delivery | Dedupe by approval ID and run ID. Re-delivery must not create a second approval. |

Event replay differs from model re-execution. Event replay reprocesses stored facts to rebuild projections, evidence indexes, dashboards, and reconciliation state. It must not spawn workers, call model providers, create commits, post comments, deploy, or repeat outbox effects. Model re-execution starts a run from recorded inputs, manifests, and approved contracts; it may produce different output and therefore creates new run, event, and evidence records.

## Consequences
The system can recover from duplicate messages, process crashes, dispatcher retries, and projection corruption without pretending that model output is deterministic.

All effectful integrations become slightly slower to implement because they need idempotency keys, outbox records, provider references, and terminal failure handling. That complexity is required for safe retries.

Reviewers can distinguish "we replayed state" from "we reran the model." This prevents false reproducibility claims.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Assume exactly-once event delivery | Local crashes, retries, provider callbacks, and replacement workers make exactly-once unsafe without heavy distributed coordination. | Revisit only if a chosen store and dispatcher prove exactly-once semantics end to end, including external effects. |
| Let workers perform side effects directly | A crash after the side effect but before state update loses auditability and makes retry unsafe. | No planned revisit for material side effects. |
| Treat model replay as deterministic replay | The plan explicitly rejects deterministic LLM replay. Stored prompts and manifests support inspection and re-execution, not identical output guarantees. | Revisit only for deterministic tools, not model-generated work. |
| Use event IDs as idempotency keys | Event IDs identify facts, while idempotency keys identify logical operations that may be retried. Mixing them breaks dedupe. | No planned revisit. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-005, preserves replay versus re-execution terminology, and provides replacement rules for at-least-once delivery, outbox dispatch, approvals, and non-idempotent side effects.
