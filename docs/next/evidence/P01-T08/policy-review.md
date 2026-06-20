# P01-T08 Policy Review Record

## Inputs Reviewed

- `docs/next/adr/ADR-006-risk-adaptive-gates.md`
- `packages/protocol/src/entities/common.ts`
- `packages/protocol/src/entities/task-contract.ts`
- `packages/protocol/src/entities/approval.ts`
- `packages/protocol/src/entities/oracle.ts`
- `packages/protocol/src/entities/task-run.ts`
- `packages/protocol/src/entities/release.ts`

The required `settings.json` input was searched in repository-local scopes and was not present, so it did not contribute policy data.

## Scope Review

The implementation stays inside `packages/core/src/risk/**` and `packages/core/src/gates/**` with a root core export in `packages/core/src/index.ts`. It imports only protocol types and does not import Eve, storage, SQLite, provider, runtime, network, clock, or random APIs.

## Policy Review

- Default policy data is versioned as `adr-006-risk-adaptive-gates@0.1.0`.
- Normalized signals are explicit and ordered deterministically.
- Tier derivation is pure: total score threshold plus hard floors plus authorized overrides.
- Gate derivation is pure policy data keyed by final tier plus explicit gate overrides.
- Lower-tier overrides require decision owner approval and cannot go below hard floors.
- Lower-tier overrides enforce every listed retained protection in the returned gate set.
- Custom policy data requires an approved policy artifact before it can affect decisions.
- Malformed JavaScript inputs and malformed approved policy data fail with explicit errors instead of TypeErrors or silent fallback gate weakening.
- Protocol-compatible `RiskProfile` reason strings are capped to the protocol limit before embedding in returned profiles.
- Repository/user free text is ignored by the derivation API unless represented as structured signals or an approved policy artifact.

Result: PASS.
