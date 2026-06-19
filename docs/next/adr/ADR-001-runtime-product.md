# ADR-001: Runtime Product

## Status
Accepted

## Context
Legion v8 is a Markdown prompt protocol interpreted by host coding CLIs. The v8 ROI analysis correctly described a typed orchestration core as a different product from the v8 prompt-pack architecture. Phase 0 deliberately creates that different v9 product boundary: the charter defines Legion Next as a controlled rewrite with typed contracts, durable work state, fresh worker contexts, independent review, and evidence-backed acceptance.

The transformation plan identifies the v8 limits that must not become v9 limits: conversation context cannot be the progress database, `STATE.md` and `ROADMAP.md` cannot be mutable operational storage, full persona injection cannot be the default worker mechanism, and host CLI adapter behavior cannot define the correctness guarantees of the whole system. The target architecture therefore separates interaction channels from a control plane, a transactional store, a runtime driver interface, functional worker bundles, isolated workspaces, and artifact stores.

The decision must preserve the v8 maintenance line. Phase 0 can write governance, ADRs, evidence, baseline fixtures, and spikes, but it must not delete v8 commands, skills, adapters, installers, or personas, and it must not change v8 default behavior.

## Decision
Legion Next is a typed runtime product, not a context-only prompt pack. The v9 control plane may use executable runtime dependencies when they satisfy an approved ADR, have exit criteria, remain behind typed interfaces, and are verified through recorded evidence. This explicitly permits production runtime dependencies for storage, protocol validation, runtime drivers, artifact indexing, CLI surfaces, and deterministic verification when they are load-bearing for durability or correctness.

The core product model is:

| Layer | Decision |
| --- | --- |
| Interaction surfaces | CLI, IDE bridges, web Kanban, GitHub, Slack, and other channels are clients of typed APIs and events. They are not the source of truth. |
| Control plane | Owns change service, spec service, board, policy, dispatcher, task graph, approval service, evidence index, and release service. |
| Runtime boundary | Runtime drivers implement start, resume, cancel, inspect, stream, approve, and artifact handoff without leaking provider types into core entities. |
| Durable storage | Operational state is persisted outside model conversation context in transactional stores and append-only events. |
| Git-tracked intent | Human-reviewable intent, specs, ADRs, contracts, and evidence indexes remain in Git under `.legion/project`. |
| Evidence | Bulk logs, traces, screenshots, and telemetry can live outside Git, with hash-addressed references committed to the evidence index. |

Context-only durability is rejected. A model transcript, chat memory, review comment, or compacted conversation may inform a worker, but it cannot be the canonical record of task state, approvals, leases, evidence, run provenance, or completion. A v9 run must be reconstructable from committed intent, transactional operational records, Git state, run manifests, artifact references, and append-only events.

Executable dependencies are allowed only under these constraints:

| Constraint | Requirement |
| --- | --- |
| Reversibility | A dependency can be replaced behind a typed interface or removed by an approved ADR revision. |
| Evidence | Selection requires spike evidence, version pinning, failure-mode notes, and verification commands where practical. |
| Portability | Core domain entities cannot depend on one host CLI, one model provider, one source forge, or one runtime driver. |
| Security | Dependencies that touch secrets, sandboxing, network egress, user files, or external systems require threat-model coverage before production default use. |
| Phase boundary | Phase 0 ADRs may approve direction but cannot claim quality, speed, durability, or provider compatibility until the relevant spike or verification task records evidence. |

## Consequences
Legion Next can build durable queues, transactional stores, event logs, runtime drivers, typed schemas, and evidence bundles rather than encoding all behavior as Markdown instructions. This is a necessary product change, not a v8 bug fix.

The v8 line remains compatible and maintenance-only until an approved v9 GA decision. v8 prompt-pack constraints remain valid for v8. v9 artifacts must not silently alter v8 commands or package behavior during Milestone A.

Downstream implementation work must treat runtime dependencies as architecture commitments, not conveniences. Storage, runtime, and artifact choices require spikes, review, versioning, rollback notes, and acceptance evidence before they become defaults.

Operational failure recovery improves because completion, approvals, and side effects are no longer implied by a transcript. The cost is higher implementation complexity and a stronger obligation to keep the interfaces small, typed, and independently testable.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Keep v9 as a zero-runtime-dependency prompt pack | This preserves the exact limits Phase 0 is meant to eliminate: no durable controller state, no typed event boundary, no transactional leases, and host CLI behavior defining correctness. | Only revisit if the rewrite goal changes back to prompt-pack compatibility rather than durable orchestration. |
| Use conversation context as the progress database | Compaction, replacement workers, model drift, and process loss can erase or distort state. It cannot provide authoritative approvals, leases, replayable events, or idempotency records. | No planned revisit; this violates the charter and transformation anti-goals. |
| Put all mutable state in Git-tracked Markdown | Git is excellent for intent and reviewable proof, but it is a poor lease manager, queue, outbox, or concurrent task database. | Revisit only for read-only projections or small committed intent artifacts, not operational state. |
| Bind the product to one runtime provider or CLI | It would recreate the adapter limitation in a new form and make outage or API churn a product correctness failure. | Revisit only for a scoped product edition, never for core domain types. |

## Review And Approval
- Approver: dasbl
- Date: 2026-06-19
- Supersession rule: Supersede only by a later accepted ADR that names ADR-001, preserves the v8 maintenance boundary, and records dependency, durability, portability, security, and rollback impact.
