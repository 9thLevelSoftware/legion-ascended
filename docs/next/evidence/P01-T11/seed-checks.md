# P01-T11 Seed Checks

## Generated Protocol Drift

Command:

```text
node scripts\validate-next.mjs --check-generated-drift
```

Seed:

The generated `docs/next/protocol/**` files were left untracked before staging.

Expected result:

The drift checker must fail because CI must not pass when generated protocol artifacts are produced but not committed.

Observed result:

```text
Error: Generated protocol artifacts are untracked:
docs/next/protocol/README.md
docs/next/protocol/api.md
docs/next/protocol/events.md
docs/next/protocol/schemas.md
docs/next/protocol/state-machines.md
```

Result: PASS

## Forbidden Import Seed

Command:

```text
pnpm validate:next
```

Seed coverage:

- `tests/package-boundaries.test.mjs` rejects `@legion/protocol` importing `@legion/core`.
- `tests/package-boundaries.test.mjs` rejects deep workspace imports.
- `tests/package-boundaries.test.mjs` rejects provider/storage imports in protocol and core.
- `tests/package-boundaries.test.mjs` rejects workspace imports of legacy prompt assets.

Result: PASS

## Legacy Package-Content Seed

Command:

```text
pnpm validate:next
```

Seed coverage:

- `tests/legacy/legacy-package-contract.test.mjs` rejects missing approved v8 paths.
- `tests/legacy/legacy-package-contract.test.mjs` rejects protected checksum mutations.
- `tests/legacy/legacy-package-contract.test.mjs` rejects installer matrix path drift.

Result: PASS
