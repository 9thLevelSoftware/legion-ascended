# ADR-004: Runtime Driver

## Status
Accepted

## Context
v8 adapters bridge Legion commands to host CLI behavior. The adapter spec captures useful capability differences such as parallel execution, agent spawning, structured messaging, native task tracking, read-only agents, prompt limits, and known quirks. This portability is valuable, but v8 adapters also combine interaction surface, model selection, dispatch mechanics, result collection, and execution semantics in one Markdown layer.

The v9 architecture separates `ChannelAdapter`, `RuntimeDriver`, `ModelPolicy`, `SandboxDriver`, `ScmDriver`, `Store`, `ArtifactStore`, and `DeploymentDriver`. Eve is the planned first production runtime driver because it provides durable sessions, sandboxing, subagents, and step checkpoints. The plan also states that Eve is public preview and must not become the core product boundary.

P00-T08 has not yet validated Eve public-contract compatibility. This ADR can choose the first driver direction, but it cannot claim compatibility proof or bind production defaults before that spike records evidence.

## Decision
Eve is selected as the first runtime driver for Legion Next. The core remains provider-neutral. Core domain types, protocol entities, board records, policy records, task contracts, approvals, evidence indexes, and worker bundle manifests must not import Eve types or rely on private Eve internals.

The minimum `RuntimeDriver` lifecycle is:

| Method | Core meaning |
| --- | --- |
| `start(runRequest)` | Create one version-pinned execution attempt for an approved task contract. |
| `resume(runId, checkpointRef)` | Continue a paused or interrupted run after reconciling board state and idempotency records. |
| `cancel(runId, reason)` | Request termination and record the result without deleting run history. |
| `inspect(runId)` | Return provider-neutral status, checkpoint, sandbox, and artifact references. |
| `stream(runId)` | Emit provider-neutral run events for progress, tool calls, approvals, artifacts, and terminal state. |
| `approve(approvalRef)` | Deliver a durable human authorization to a paused run when policy permits. |
| `artifact(runId, artifactRef)` | Fetch or register provider-neutral artifact metadata. |

Core owns task state, risk policy, approval policy, event schemas, idempotency keys, outbox, evidence indexing, and completion semantics. A driver owns provider session creation, provider checkpointing, sandbox execution within its documented contract, and provider-specific transport. The driver must translate provider details into Legion protocol events before they enter the store.

Runtime implementations:

| Driver | Role |
| --- | --- |
| `runtime-eve` | First production implementation after P00-T08 validates public contracts, version pinning, fallback behavior, and threat-model boundaries. |
| `runtime-local` | Deterministic tests, development, and fallback environments where Eve is unavailable. |
| `runtime-legacy-cli` | Transitional compatibility path with reduced guarantees for v8-like flows. |

P00-T08 must validate all of the following before any production default binds to Eve: public API/client contract, exact version pinning, run start/resume/cancel/inspect/stream behavior, approval delivery, artifact handoff, failure modes, fallback to local or legacy driver, and behavior when Eve is unavailable or changes API shape. If P00-T08 fails, the default remains unbound and the phase reports the runtime blocker.

## Consequences
Legion Next can target Eve first without making Eve the product. Provider churn, outage, or public-preview changes are contained in `runtime-eve` and its compatibility tests.

Driver-neutral core tests can run against `runtime-local`. This supports deterministic CI, contract tests, and replay of Legion events without calling Eve.

The runtime boundary adds upfront interface discipline. Driver capabilities must be explicit, and any missing capability must either block the run, choose an approved fallback, or downgrade only through a recorded policy decision.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Eve-only core | Public-preview API churn or outage would become a core product failure, and core entities would inherit provider-specific types. | Revisit only for an Eve-specific edition, not the provider-neutral core. |
| Keep host CLI adapters as the runtime | Host CLIs differ in structured messaging, read-only enforcement, task tracking, and parallelism. Their limits should not define v9 correctness. | Revisit only for transitional legacy mode with reduced guarantees. |
| Build a custom runtime before trying Eve | This increases scope before testing the planned first driver and delays evidence. | Revisit only if P00-T08 shows Eve cannot satisfy public contracts. |
| Bind defaults in this ADR | P00-T08 compatibility proof has not happened. Binding defaults now would be an evidence-free claim. | Revisit after P00-T08 records public-contract and fallback evidence. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-004, records driver compatibility evidence, and proves core domain types remain provider-neutral.
