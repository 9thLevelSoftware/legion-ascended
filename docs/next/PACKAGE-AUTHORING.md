# Package Authoring

Phase 1 workspace packages are private until the public API stabilizes.

## Current Layers

| Package | Role | Allowed workspace imports |
| --- | --- | --- |
| `@legion/protocol` | Versioned workflow protocol contracts, schemas, events, and API payloads. | None |
| `@legion/core` | Pure workflow state machines and policy-free transition helpers. | `@legion/protocol` |

## Adding A Package

1. Place implementation code under `packages/<name>/src`.
2. Keep `private: true` unless an explicit release decision approves publication.
3. Export only package root APIs through `package.json` `exports`.
4. Add the package layer to `scripts/check-package-boundaries.mjs` before importing it from another package.
5. Run `pnpm run build`, `pnpm run typecheck`, `pnpm run check:boundaries`, and `pnpm run test`.

Protocol and core packages must not import legacy prompt assets, Eve, SQLite providers, host CLI adapters, dashboard code, filesystem/network APIs, clocks, randomness, or model/provider SDKs.
