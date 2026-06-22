# Runtime fallback policy

P05-T02 certifies `runtime-eve` as the primary external durable runtime driver candidate.

Precedence when no explicit override is set:

1. `runtime-eve` — use when the pinned Eve peer dependency is installed and the adapter passes the public-contract checks.
2. `runtime-local` — deterministic in-memory fallback for tests, local development, and Eve-unavailable environments.
3. `runtime-legacy-cli` — transitional compatibility path with reduced guarantees.

Explicit `preferredDriver` overrides always win when the requested driver is registered and available. If the preferred driver is unavailable, the selector returns a structured failure rather than silently downgrading.

Verification sources:

- `packages/core/src/runtime/selector.ts`
- `packages/core/test/runtime-selector.test.mjs`
- `packages/runtime-eve/src/fallback/select.ts`
- `packages/runtime-eve/test/public-contract.test.mjs`
