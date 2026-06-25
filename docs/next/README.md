# Legion Next

This directory contains governance, decisions, evidence, spikes, reviews, and handoffs for the Legion Next rewrite.

## P00-T01 Governance Outputs

- Rewrite charter: [REWRITE-CHARTER.md](REWRITE-CHARTER.md)
- V8 maintenance policy: [V8-MAINTENANCE-POLICY.md](V8-MAINTENANCE-POLICY.md)
- Governance changelog: [../../CHANGELOG.md](../../CHANGELOG.md)
- Review ownership: [../../.github/CODEOWNERS](../../.github/CODEOWNERS)
- P00-T01 evidence: [evidence/P00-T01/](evidence/P00-T01/)

P00-T01 freezes the v8 baseline at `C:/Users/dasbl/Documents/legion` `refs/remotes/origin/main` commit `855e975beec3bac6dc06db598081b6ac11ea8e14` with package version `8.0.5`. The local annotated baseline tag is `v8-baseline-20260619` (`87ef9acc057cde8dd71bc25fc08bc536e9c8076c`) and must not be pushed until the decision owner approves publication policy. Historical failed checkouts are preserved under [evidence/P00-T01/](evidence/P00-T01/); the accepted validation path uses LF-preserving checkouts with `core.autocrlf=false`.

Authoritative phase execution starts from:

- Roadmap: C:/Users/dasbl/Documents/Legion Retooled/docs/legion-next-roadmap.md
- Phase 0 contract: C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md
- Transformation plan: C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md
- Active Phase 0 ledger: .legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml
- Active Phase 0 evidence index: .legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml

The original v8 repository at C:/Users/dasbl/Documents/legion is a reference and baseline source. Do not mutate it from this repository except through an explicitly approved Phase 0 baseline task.

## Phase 0 Handoff Outputs

- Phase 0 decision: [PHASE-00-DECISION.md](PHASE-00-DECISION.md)
- Implementation backlog: [IMPLEMENTATION-BACKLOG.yaml](IMPLEMENTATION-BACKLOG.yaml)
- Dependency map: [DEPENDENCY-MAP.md](DEPENDENCY-MAP.md)
- Workflow compatibility baseline: [baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md](baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md)
- Storage decision: [adr/ADR-008-local-store-selection.md](adr/ADR-008-local-store-selection.md)
- Storage comparison: [spikes/STORAGE-COMPARISON.md](spikes/STORAGE-COMPARISON.md)
- Eve compatibility record: [spikes/EVE-COMPATIBILITY.md](spikes/EVE-COMPATIBILITY.md)
- Phase 0 pre-mortem: [reviews/PHASE-00-PREMORTEM.md](reviews/PHASE-00-PREMORTEM.md)
- Findings register: [reviews/PHASE-00-FINDINGS.yaml](reviews/PHASE-00-FINDINGS.yaml)

Phase 0 authorizes Phase 1 with a `CONDITIONAL GO`: build the TypeScript workspace and provider-neutral protocol/core for the workflow tool, preserve v8 workflow surfaces, keep Eve and live model benchmarking deferred to later runtime/eval phases, and do not start a standalone application or dashboard-first product in Phase 1.

## Phase 1 Workspace Bootstrap

Phase 1 starts from the dedicated `legion-next/phase-01` branch/worktree and targets Node 24 with pnpm 11.4.0.

Use these local commands for the v9 workspace:

```powershell
corepack enable
pnpm run bootstrap
pnpm run validate
```

The root package now publishes as `legion-ascended`, while the v8 prompt-package surface remains the frozen `@9thlevelsoftware/legion` reference line isolated by explicit package-content tests. Phase 1 Wave 1 must not add a dashboard, hosted service, chat UI, SQLite implementation, dispatcher loop, or Eve-specific runtime binding.
