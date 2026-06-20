# P01-T05 Lifecycle Schema Matrix

Task: P01-T05 - Define lifecycle entity schemas
Date: 2026-06-20

Primary source: `C:\Users\dasbl\Documents\legion\docs\rebuild\01-phase-typescript-workspace-and-protocol-core.md`, P01-T05.

Architecture references:

- `docs/next/adr/ADR-003-state-ownership.md`
- `docs/next/adr/ADR-004-runtime-driver.md`
- `docs/next/adr/ADR-005-events-idempotency.md`
- `docs/next/adr/ADR-006-risk-adaptive-gates.md`
- `docs/next/adr/ADR-008-local-store-selection.md`

| Entity | Source module | JSON Schema artifact | Fixture key | Main contract boundary |
| --- | --- | --- | --- | --- |
| TaskContract | `packages/protocol/src/entities/task-contract.ts` | `schemas/entities/task-contract.schema.json` | `taskContract` | Immutable intent, scope, risk, verification, completion, and blocked conditions. |
| Task | `packages/protocol/src/entities/task.ts` | `schemas/entities/task.schema.json` | `task` | Mutable operational queue state bound to a contract revision, without duplicating intent fields. |
| TaskRun | `packages/protocol/src/entities/task-run.ts` | `schemas/entities/task-run.schema.json` | `taskRun` | Immutable attempt manifest after start, including runtime, worker, model, inputs, repo, workspace, policy, and idempotency key. |
| EvidenceBundle | `packages/protocol/src/entities/evidence.ts` | `schemas/entities/evidence.schema.json` | `evidenceBundle` | Collected or unknown proof with retention and sensitivity classification, excluding raw secret storage. |
| ReviewDecision | `packages/protocol/src/entities/review.ts` | `schemas/entities/review.schema.json` | `reviewDecision` | Independent review verdicts and findings; blocking findings require evidence references. |
| Approval | `packages/protocol/src/entities/approval.ts` | `schemas/entities/approval.schema.json` | `approval` | Human or policy authorization for explicit scoped actions with idempotency keys. |
| Release | `packages/protocol/src/entities/release.ts` | `schemas/entities/release.schema.json` | `release` | Release intent, health gates, rollback plan, and forward-fix path. |
| Observation | `packages/protocol/src/entities/observation.ts` | `schemas/entities/observation.schema.json` | `observation` | Post-release health observation, rollback evidence, and forward-fix follow-up references. |

## JSON Schema Coverage Notes

- Task-run status variants require frozen manifests for started and terminal runs.
- Review finding severity variants require evidence references for blocking findings.
- Approval status variants require decision audit fields for granted, denied, and revoked approvals.
- Release and observation status variants structurally require forward-fix or rollback evidence references when those statuses are active.
- Task-contract write and forbidden scope disjointness remains a Zod runtime refinement, because the generated JSON Schema path arrays cannot express set disjointness without custom keywords.
