# P01-T06 Event And API Catalog Review

Task: P01-T06 - Define versioned command, API, and append-only event contracts
Date: 2026-06-20

Primary source: `C:\Users\dasbl\Documents\legion\docs\rebuild\01-phase-typescript-workspace-and-protocol-core.md`, P01-T06.

Architecture references:

- `docs/next/adr/ADR-005-events-idempotency.md`
- `docs/next/adr/ADR-007-kanban-migration.md`
- `C:\Users\dasbl\Documents\legion\docs\rebuild\legion-next-transformation-plan.md`

## Event Catalog Coverage

| Category | Event types | Source module | Generated docs |
| --- | --- | --- | --- |
| Project/change/artifact | `project.created.v1`, `change.proposed.v1`, `artifact_revision.recorded.v1` | `packages/protocol/src/events/envelope.ts` | `schemas/events/README.md` |
| Task lifecycle | `task.created.v1`, `task.linked.v1`, `task.claimed.v1`, `task.heartbeat_recorded.v1`, `task.blocked.v1`, `task.retry_scheduled.v1`, `task.completed.v1`, `task.invalidated.v1` | `packages/protocol/src/events/envelope.ts` | `schemas/events/README.md` |
| Run/input | `run.created.v1`, `run.started.v1`, `run.finished.v1`, `input.recorded.v1` | `packages/protocol/src/events/envelope.ts` | `schemas/events/README.md` |
| Approval/evidence/review | `approval.requested.v1`, `approval.granted.v1`, `approval.denied.v1`, `evidence.collected.v1`, `review.submitted.v1` | `packages/protocol/src/events/envelope.ts` | `schemas/events/README.md` |
| Integration/release/observation/migration | `integration.outbox_intent_recorded.v1`, `integration.effect_succeeded.v1`, `integration.effect_failed.v1`, `release.requested.v1`, `release.deployed.v1`, `release.rolled_back.v1`, `observation.recorded.v1`, `migration.applied.v1` | `packages/protocol/src/events/envelope.ts` | `schemas/events/README.md` |

## API Catalog Coverage

| Surface | Contract | Source module | Generated docs |
| --- | --- | --- | --- |
| Commands | Closed `API_COMMAND_TYPES` list, command envelope, command result union, and `COMMAND_CATALOG` success/rejection result metadata. | `packages/protocol/src/api/contracts.ts` | `schemas/api/README.md` |
| Queries | Closed `API_QUERY_TYPES` list, query request envelope, typed projection response union, and cursor pagination. | `packages/protocol/src/api/contracts.ts` | `schemas/api/README.md` |
| Compatibility aliases | Command names preserve ADR-007's distinction between operational `board`, governance `council`, v9 `run`, `review`, `release`, `observe`, `archive`, `doctor`, and legacy bridge intent. | `packages/protocol/src/api/contracts.ts` | `schemas/api/README.md` |

## Review Results

- Events are named as facts using past-tense versioned names and reject imperative payload keys through strict payload schemas.
- Event envelopes include event ID, type, version, aggregate reference, generation, sequence, correlation, causation, actor, timestamp, payload, and idempotency key fields.
- Duplicate recognition is explicit by event ID and idempotency key.
- Event ordering and replay-vs-reexecution semantics are documented in generated `schemas/events/README.md`.
- State-changing commands have cataloged success result types, rejection result types, and non-empty typed rejection code sets.
- Missing command catalog entries are reported as validation issues rather than uncaught runtime exceptions.
- `doctor.run.v1` rejects project, change, or task scoped targets whose ID prefix does not match the selected scope.
- `council.request.v1` requires at least one change or decision reference for deliberation.
- Query responses use typed projection rows and protocol cursor pagination without HTTP/path/status fields.
- Compatibility fixture `schemas/events/fixtures/compat-v0.0.json` normalizes to the current `0.1.0` envelope.
