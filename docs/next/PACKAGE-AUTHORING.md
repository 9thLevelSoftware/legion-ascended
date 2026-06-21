# Package Authoring

Phase 1 workspace packages are private until the public API stabilizes.

## Current Layers

| Package | Role | Allowed workspace imports |
| --- | --- | --- |
| `@legion/protocol` | Versioned workflow protocol contracts, schemas, events, and API payloads. | None |
| `@legion/core` | Pure workflow state machines and policy-free transition helpers. | `@legion/protocol` |
| `@legion/artifacts` | Git-tracked project artifact services, validation, hashing, revision writes, and archive/traceability helpers. | `@legion/protocol`, `@legion/core` |
| `@legion/legacy-bridge` | Read-only legacy import and migration tooling that stages reviewed v9 artifacts from old workflow sources. | `@legion/protocol`, `@legion/artifacts` |
| `@legion/cli` | Thin noninteractive `legion next ...` presentation layer over artifact and migration services. | `@legion/protocol`, `@legion/artifacts`, `@legion/legacy-bridge` |

## Adding A Package

1. Place implementation code under `packages/<name>/src`.
2. Keep `private: true` unless an explicit release decision approves publication.
3. Export only package root APIs through `package.json` `exports`.
4. Add the package layer to `scripts/check-package-boundaries.mjs` before importing it from another package.
5. Run `pnpm run build`, `pnpm run typecheck`, `pnpm run check:boundaries`, and `pnpm run test`.

Protocol and core packages must not import legacy prompt assets, Eve, SQLite providers, host CLI adapters, dashboard code, filesystem/network APIs, clocks, randomness, or model/provider SDKs.
