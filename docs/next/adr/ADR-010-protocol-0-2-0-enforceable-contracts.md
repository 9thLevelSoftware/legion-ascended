# ADR-010: Protocol 0.2.0 — Enforceable Task Contracts

## Status
Proposed — awaiting decision-owner approval.

Recorded retrospectively. The implementation landed in PRs #33, #34 and #35 before this record existed, which the charter does not permit for a breaking architecture decision. That sequencing error is noted here rather than hidden; approval of this ADR is what makes the protocol revision legitimate, and Phase C is the dependent work it gates.

## Context
The v9 workflow verbs recorded what an executor **claimed** rather than what it **did**. `legion build` set its evidence verdict from the executor's own JSON, never took a diff, and never compared reported files against `scope.write`. `TaskContract.verification[]` was rendered into the executor prompt as text and never executed. `legion ship` checked that an accepted review row existed.

Meanwhile `packages/core` already shipped a deterministic verification runner, the ADR-006 risk gates, fresh-context dispatch and a twelve-signal risk scorer. `packages/cli` imported one symbol from it. P14-B001 built the workflow surface; wiring it to those engines was never in its scope.

Connecting them exposed a protocol problem. The contracts could not express the facts the gates needed:

- No file, line or blast-radius limit existed anywhere in either the v8 or v9 line, so "keep the diff minimal" was a slogan with nothing to measure it against.
- `requirement.acceptance.criteria` was `string[]` — prose a reviewer reads, not something a runner can decide.
- Nothing in a contract said whether completion required the observed diff to be reconciled at all.

Enforcement therefore had nothing to enforce against. The protocol had to change before the gates could mean anything.

## Decision
Revise the protocol to 0.2.0. `0.1.0` remains in `SUPPORTED_PROTOCOL_VERSIONS`.

### Breaking entity changes

| Change | Rationale |
| --- | --- |
| `taskContract.scope.budget` is **required** — `{ maxFilesChanged, maxLinesChanged, maxNewFiles }` | A task that does not declare how large it may get cannot be reconciled against its actual diff. Required with no default: a contract without a declared blast radius must not validate. |
| `taskContract.completion.diffReconciliation` is **required** | Makes explicit that a self-report is insufficient for completion. |
| `requirement.acceptance.criteria` becomes objects carrying a discriminated `proof` — `executable` with command and expected exit code, or `manual` with a stated reason | Turns acceptance criteria from prose into something a runner decides. `manual` exists because some criteria genuinely cannot be scripted, but it must say why, so unscriptable criteria are a countable choice rather than the silent default. |

### New entities

`intake-session` and `exploration` support the structured `legion start` interview and its freeform pre-step. Both encode their invariants in schema rather than convention: an exploration's `status` is the literal `"exploratory"` so nothing can promote it to authoritative, and an intake answer marked `proposed-accepted` must cite the exploration it came from.

### Migration

A single `legionProtocol010To020` upcast, applied at read time inside `readJsonArtifact`.

It **fails safe rather than fabricating**. A migrated task contract receives the tightest budget that still permits its declared write scope; a migrated criterion becomes `manual`. Neither invents a command nor a wide radius, and both stamp `metadata.annotations` so a migrated value is distinguishable from an authored one. If a legacy task genuinely needed a wider radius, reconciliation blocks and a human authors a real budget — the correct direction to be wrong in.

Migrations declare `appliesToKinds`, and the read-time walk touches nothing else.

### Artifact envelopes are versioned independently

`TASKGRAPH_SCHEMA_VERSION` and the change-artifact manifest version are **not** the protocol version and do not move with it. Several envelopes embed a hash computed over their own fields, so rewriting `schemaVersion` on read invalidates that self-hash.

This is recorded as a decision because it was learned by breaking it: a first implementation upcast anything shaped `{kind, schemaVersion}`, which rewrote taskgraph envelopes and made every read fail `manifest_hash_mismatch` across seventeen tests.

## Consequences
Contracts can now express what enforcement needs, and `packages/core`'s existing engines have something to act on. Diff reconciliation, real verification execution and derived ship gates all became possible without further protocol work.

**`legion ship` cannot report ready for any R2 or R3 change until Phase D produces oracles and specs.** Most gates at those tiers have no producer, and an unevaluable required gate now blocks rather than passing quietly — a readiness verdict that contradicted its own report was worse than an honest refusal. R0 remains reachable, and an audited `risk.override` remains the path for gates that genuinely do not apply.

Existing `.legion/project` state stays readable, but legacy contracts carry deliberately restrictive budgets and unproven `manual` criteria. Some will block on first build. That is the migration surfacing real gaps rather than papering over them.

Every generated requirement Legion writes for itself — roadmap bullets, the `.planning` importer — now carries `manual` criteria with an explicit reason, making the unproven acceptance surface countable.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Make `scope.budget` optional with a default | A defaulted budget is a number nobody chose, and reconciliation against it would enforce an invented limit while appearing to enforce the author's. | Revisit only with evidence that authors reliably set budgets and the default is never load-bearing. |
| Ship the changed shape under 0.1.0 | The shape changed incompatibly; leaving the version fixed would make compatibility claims unfalsifiable and poison every downstream negotiation. | No planned revisit. |
| Have the migration synthesize executable criteria and realistic budgets | It would assert proofs that were never written and grant radii nobody approved — the precise failure the revision exists to remove. | No planned revisit. |
| Upcast every record carrying a `schemaVersion` | Artifact envelopes version independently and several embed a self-hash; a blanket walk corrupts them. Demonstrated by seventeen failing tests. | No planned revisit. |
| Defer the protocol change and enforce against existing contracts | There was nothing to enforce: no budget, no executable criteria, no reconciliation flag. | No planned revisit. |

## Evidence
- PR #33 — protocol revision, enforcement spine, typed brainstorm handoff.
- PR #34 — satisfiable planned contracts, blocking unevaluable ship gates.
- PR #35 — control artifacts withheld from implementation work; single guarded dispatch path.
- `Protocol compatibility` CI green on ubuntu, macOS and Windows across all three PRs.
- `packages/protocol/test/migrations-0-2-0.test.mjs` and `tests/protocol-upcast-on-read.test.mjs` cover fail-safe migration, idempotency, nested upcasting, and envelopes left untouched.

## Reversal Conditions
Revert to 0.1.0 only by a later accepted ADR that names ADR-010 and either supplies an alternative mechanism for declaring blast radius and executable acceptance, or demonstrates with recorded evidence that enforcement is more costly than the drift it prevents. A downcast migration must exist before any reversal, because 0.2.0 records budgets and proof modes that 0.1.0 cannot express.

## Review And Approval
- Approver: dasbl — **not yet given**
- Proposed: 2026-07-30
- Supersession rule: Supersede only by a later accepted ADR that names ADR-010, preserves the requirement that a task declare its blast radius and that acceptance criteria state how they are proven, and provides a migration path in both directions.
