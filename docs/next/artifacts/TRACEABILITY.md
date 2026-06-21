# Legion Traceability And Invalidation

P02-T06 adds a read-only traceability projection over committed Legion project artifacts. The validator does not create, update, or delete workflow state; it loads current specs, a change bundle, oracle artifacts, the task graph, and the evidence index, then emits a deterministic graph and diagnostics.

## Inputs

The validator reads these canonical artifacts through `@legion/artifacts` services:

| Artifact | Path |
| --- | --- |
| Current specs | `.legion/project/specs/<requirement-id>.md` |
| Change bundle | `.legion/project/changes/<change-id>/change.yaml` |
| Delta specs | `.legion/project/changes/<change-id>/delta-specs/<requirement-id>.md` |
| Design | `.legion/project/changes/<change-id>/design.md` |
| Decisions | `.legion/project/changes/<change-id>/decisions.md` |
| Oracles | `.legion/project/changes/<change-id>/oracle/<oracle-id>.yaml` |
| Task graph | `.legion/project/changes/<change-id>/taskgraph.json` |
| Evidence index | `.legion/project/changes/<change-id>/evidence-index.json` |

## Graph

`validateChangeTraceability()` returns a machine-readable `TraceabilityReport` containing:

- `summary`: counts for requirements, oracles, tasks, evidence, accepted evidence, and reviews.
- `graph.nodes`: `change`, `requirement`, `decision`, `oracle`, `task`, `evidence`, `review`, and `artifact` nodes with exact source paths.
- `graph.edges`: deterministic relation edges: `defines`, `covers`, `requires`, `verifies`, `records`, `depends_on`, and `accepts`.
- `diagnostics`: typed source-path diagnostics. An empty diagnostic list means the traceability graph is valid.

`renderTraceabilityReport()` produces the concise human report. Callers that need durable machine output should persist the JSON report bytes they receive from `validateChangeTraceability()` rather than re-parsing the human report.

## Validation Rules

The validator checks the Phase 2 required chains:

- Requirement to oracle: each targeted requirement must name acceptance oracle references, and each referenced oracle must exist.
- Oracle to requirement: each oracle coverage entry must point at a known current or proposed requirement.
- Requirement to task: each targeted requirement must be covered by at least one task contract.
- Oracle to task: each task must name an oracle that covers each requirement it claims.
- High-risk evidence: R2/R3 targeted requirements must have accepted evidence with review provenance.
- Trace integrity: duplicate trace references, cyclic `refines`/`supersedes` references, missing target entities, and cross-change paths produce diagnostics.
- Artifact freshness: taskgraph and evidence-index artifact inputs are compared against the current loaded artifact revisions. Stale input hashes or revisions produce `stale_revision_reference`.

## Invalidation

`analyzeTraceabilityImpact()` accepts a validated graph plus a changed artifact path. It walks downstream edges to name affected requirements, oracles, task contracts, evidence bundles, review IDs, and artifacts.

When `changedRequirementIds` is provided, the impact walk starts only from those requirement nodes as defined by the changed artifact. This allows a split current spec file to invalidate `req_alpha` without also invalidating unrelated `req_beta` chains in the same file.

The `packages/artifacts/src/invalidation` module re-exports the impact analyzer as the Phase 2 invalidation API surface. Later archive and board-store phases can persist invalidation facts, but P02-T06 remains side-effect free.
