# P01-T09 Policy Review

## Reviewed Requirements

- Persisted protocol records must include a valid semantic `schemaVersion`.
- Reader/writer compatibility must be negotiated explicitly.
- Unsupported old or future versions must fail closed without a registered path.
- Migrations must be registered and applied in order.
- Migration failure must not partially mutate caller-owned input.
- Downcasts require explicit information-preservation evidence.
- Breaking schema changes require either a major protocol version or an explicit migration.
- Deprecated fields require a named removal version and compatibility fixture before removal.

## ADR Alignment

ADR-005 distinguishes pure replay from effectful re-execution. P01-T09 stays inside pure protocol compatibility utilities: migration registration, migration application, version negotiation, and report generation. It does not import storage, Eve, providers, worker runtime code, or side-effect dispatchers.

## Source Policy

The source policy is exported as `protocolEvolutionPolicyDocumentation` from `@legion/protocol`. The generated compatibility report includes that policy text for CI and release-note use.

Result: PASS. The policy is covered by `P01-T09 compatibility reports include matrix and evolution policy text`.
