# Runtime fallback policy

P05 certifies the ADR-004 RuntimeDriver cut line for Legion Next. The default selector prefers the external Eve adapter when it is registered and available, keeps the deterministic local driver as the local/test fallback, and preserves a reduced-guarantee legacy CLI compatibility path while the runtime migration finishes.

## Default precedence

When no explicit override is set, selectors evaluate drivers in this order:

1. `runtime-eve` — preferred durable external runtime candidate, implemented in `@legion/runtime-eve` and certified against the public contract tests.
2. `runtime-local` — deterministic in-memory fallback for tests, local development, and Eve-unavailable environments.
3. `runtime-legacy-cli` — transitional compatibility driver with explicit reduced guarantees.

The canonical precedence is pinned in both:

- `packages/core/src/runtime/selector.ts`
- `packages/runtime-eve/src/fallback/select.ts`

## Explicit overrides

`preferredDriver` / requested-driver policy wins only when the requested driver is registered and available. A forced-but-unavailable driver returns a structured selection failure instead of silently falling through to a lower-precedence driver. This keeps rollback decisions audit-visible and prevents an operator from believing Eve was used when the selector actually downgraded.

## Driver guarantees

| Driver | Guarantee level | Notes |
| --- | --- | --- |
| `runtime-eve` | external durable runtime candidate | Uses the pinned Eve transport boundary in `packages/runtime-eve/src/transport/`; public-contract tests cover start, resume, cancel, inspect, stream, approve, artifact, subagent, sandbox, and eval helpers. |
| `runtime-local` | deterministic local/test runtime | Emits Legion protocol events in memory and supports final-output artifact bundles for terminal runs. |
| `runtime-legacy-cli` | reduced-guarantee compatibility runtime | Implements the seven-method RuntimeDriver surface for migration continuity but advertises reduced checkpoint resume fidelity, terminal stream shape, and artifact preservation guarantees. |

The legacy path must remain visibly reduced-guarantee; Phase 6+ code must not treat it as equivalent to Eve durability.

## Verification sources

- `packages/core/src/runtime/contract.ts`
- `packages/core/src/runtime/local-driver.ts`
- `packages/core/src/runtime/legacy-cli-driver.ts`
- `packages/core/src/runtime/selector.ts`
- `packages/core/test/runtime-driver.test.mjs`
- `packages/core/test/runtime-legacy-cli-driver.test.mjs`
- `packages/core/test/runtime-selector.test.mjs`
- `packages/runtime-eve/src/driver/runtime-eve-driver.ts`
- `packages/runtime-eve/src/fallback/select.ts`
- `packages/runtime-eve/test/public-contract.test.mjs`
- `scripts/scan-runtime-import-boundaries.mjs`
- `tests/runtime-import-boundaries.test.mjs`
