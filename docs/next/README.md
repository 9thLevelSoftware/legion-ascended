# Legion Next

This directory contains governance, decisions, evidence, spikes, reviews, and handoffs for the Legion Next rewrite.

## P00-T01 Governance Outputs

- Rewrite charter: [REWRITE-CHARTER.md](REWRITE-CHARTER.md)
- V8 maintenance policy: [V8-MAINTENANCE-POLICY.md](V8-MAINTENANCE-POLICY.md)
- Governance changelog: [../../CHANGELOG.md](../../CHANGELOG.md)
- Review ownership: [../../.github/CODEOWNERS](../../.github/CODEOWNERS)
- P00-T01 evidence: [evidence/P00-T01/](evidence/P00-T01/)

P00-T01 is blocked pending reproducible v8 baseline validation. The stale-local-main failure is preserved as historical evidence, and the corrected public-remote checkout reached `855e975beec3bac6dc06db598081b6ac11ea8e14` with package version `8.0.5`. That remote-main checkout still failed `npm run validate` on this Windows host before tag creation, so the proposed local baseline tag `v8-baseline-20260619` has not been created.

Authoritative phase execution starts from:

- Roadmap: C:/Users/dasbl/Documents/Legion Retooled/docs/legion-next-roadmap.md
- Phase 0 contract: C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md
- Transformation plan: C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md
- Active Phase 0 ledger: .legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml
- Active Phase 0 evidence index: .legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml

The original v8 repository at C:/Users/dasbl/Documents/legion is a reference and baseline source. Do not mutate it from this repository except through an explicitly approved Phase 0 baseline task.
