# Protocol Compatibility Report

Current protocol version: `0.2.0`

Supported protocol versions: `0.1.0`, `0.2.0`

## Compatibility Matrix

| Migration | From | To | Kind | Preserved invariants |
| --- | --- | --- | --- | --- |
| `synthetic.v1-to-v2` | `0.1.0` | `0.2.0` | upcast | id, payload.count, payload.label |

## Evolution Policy

# Legion Protocol Evolution Policy

Every persisted protocol record must carry a valid `schemaVersion`. Readers must reject records without a version before schema parsing, migration, or projection replay.

Breaking schema changes require a major protocol version or an explicit migration with tests proving the preserved invariants. No reader may silently coerce records across versions.

Minor and patch changes may be read only when the reader supports the writer version directly or a registered ordered migration path exists.

Deprecated fields require a removal version, release-note entry, and compatibility test fixture before removal. Removing a field without a migration is a breaking change.

Downcasts are disabled unless the registered migration declares that it is information-preserving and lists the fields or invariants it preserves.

Migration failures must leave caller-owned input unchanged. Retry of an already-migrated record must be idempotent and apply no additional steps.
