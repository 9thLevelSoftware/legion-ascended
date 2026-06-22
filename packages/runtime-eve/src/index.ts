/**
 * @legion/runtime-eve — ADR-004 `runtime-eve` adapter for Legion Next.
 *
 * The adapter implements the seven-method `RuntimeDriver` contract
 * declared in `@legion/core` against Vercel Eve's documented
 * public TypeScript surface (`defineAgent`, `defineTool`,
 * `defineSandbox`, `ctx.getSandbox`, `defineRemoteAgent`,
 * `defineEval`, approval predicates, and the session stream).
 *
 * The driver is intentionally thin: every Eve interaction goes
 * through the `EveTransport` boundary so the rest of the package
 * never imports the `eve` module directly. This keeps the
 * adapter testable in environments where the pinned `eve@0.11.7`
 * peer dependency is not installed.
 *
 * Public exports:
 *  - `RuntimeEveDriver` — the seven-method driver.
 *  - `RuntimeEveDriverError` — typed failure codes.
 *  - `EveTransport` (re-exported) — the transport boundary.
 *  - `FakeEveTransport` — in-memory transport for unit tests.
 *  - `RealEveTransport` — production transport that calls Eve's
 *    `defineAgent` / `ctx.*` helpers through a dynamic import.
 *  - `selectDriver` / `checkEveTransportVersion` — the fallback
 *    policy (runtime-local → runtime-eve → runtime-legacy-cli).
 */

export * from "./driver/runtime-eve-driver.js";
export * from "./transport/index.js";
export * from "./fallback/index.js";
