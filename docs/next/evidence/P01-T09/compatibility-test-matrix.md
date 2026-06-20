# P01-T09 Compatibility Test Matrix

## Scope

The compatibility matrix covers schema-version enforcement, reader/writer negotiation, explicit migration registration, migration idempotency, failed migration isolation, downcast safety, and generated release-note/CI report output.

## Matrix

| Case | Evidence | Result |
| --- | --- | --- |
| Persisted records without `schemaVersion` fail closed | `P01-T09 versioned records fail closed without a valid schemaVersion` | PASS |
| Canonical initial and synthetic next-version fixtures remain readable | `P01-T09 canonical compatibility fixtures remain readable` | PASS |
| Unknown future writer versions reject without a migration path | `P01-T09 protocol negotiation rejects unsupported old and future versions` | PASS |
| Unsupported old writer versions reject without a migration path | `P01-T09 protocol negotiation rejects unsupported old and future versions` | PASS |
| Synthetic `0.1.0` to `0.2.0` migration applies explicitly | `P01-T09 explicit migrations apply in order and are idempotent when repeated` | PASS |
| Reapplying migration to a target-version record is idempotent | `P01-T09 explicit migrations apply in order and are idempotent when repeated` | PASS |
| Failed migrations do not mutate caller-owned input | `P01-T09 migration failures do not partially mutate caller input` | PASS |
| Downcasts require information-preservation evidence | `P01-T09 downcasts require explicit information-preservation evidence` | PASS |
| Compatibility report includes matrix and evolution policy | `P01-T09 compatibility reports include matrix and evolution policy text` | PASS |

## Commands

- `pnpm --filter @legion/protocol test -- --test-name-pattern=P01-T09`
- `pnpm validate`

## Evidence

- Focused compatibility log: `docs/next/evidence/P01-T09/protocol-compatibility-test.log`
- Full validation log: `docs/next/evidence/P01-T09/full-validation.log`
- Generated compatibility report: `docs/next/evidence/P01-T09/compatibility-report.md`
