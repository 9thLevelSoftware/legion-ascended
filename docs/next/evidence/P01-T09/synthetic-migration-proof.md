# P01-T09 Synthetic Migration Proof

## Fixtures

- Initial fixture: `packages/protocol/test/compatibility/fixtures/synthetic-v1.json`
- Synthetic next-version fixture: `packages/protocol/test/compatibility/fixtures/synthetic-v2.json`

## Migration

- ID: `synthetic.v1-to-v2`
- Direction: upcast
- From: `0.1.0`
- To: `0.2.0`
- Added field: `status: "active"`
- Preserved invariants: `id`, `payload.count`, `payload.label`

## Proof

The focused compatibility test reads both canonical fixtures from disk, registers the synthetic migration, applies it from `0.1.0` to `0.2.0`, and verifies:

- `schemaVersion` changes to `0.2.0`.
- `status` is added as the only synthetic next-version field.
- Preserved payload fields remain byte-for-byte equal to the source fixture.
- Caller-owned input remains equal to the original fixture after migration.
- Reapplying migration to an already-targeted record applies zero migrations and returns a deep-equal clone.
- A failing migration that mutates its private copy before throwing leaves caller-owned input unchanged.

Result: PASS in `docs/next/evidence/P01-T09/protocol-compatibility-test.log`.
