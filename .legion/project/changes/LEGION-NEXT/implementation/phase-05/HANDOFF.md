# Phase 5 Handoff — RuntimeDriver Contract and `runtime-local`

## Status

P05-T01 closes Phase 5's RuntimeDriver contract gate. The branch
`codex/p03-t02-board-task-repository` now carries a provider-neutral
TypeScript contract against ADR-004, a deterministic `runtime-local`
driver, and an import-boundary scan that fails closed on any Eve,
host-CLI, sqlite, or legacy-prompt-asset import inside
`packages/core/src/runtime/`.

P05-T02 certifies the external Eve adapter surface. The branch now
also carries a provider-neutral `@legion/runtime-eve` package, a
pinned Eve transport boundary, fallback-policy documentation,
subagent/sandbox/eval helpers, and synchronized selector precedence
in `@legion/core`.

P05-T03 (Fallback driver policy) can now build on the synchronized
precedence. P05-T04 (Phase 5 closeout) will aggregate the cross-driver
evidence and the independent review once Eve is wired in.

## What landed in this card

| Artifact | Purpose |
| --- | --- |
| `packages/core/src/runtime/contract.ts` | The provider-neutral `RuntimeDriver` TypeScript interface and its result types |
| `packages/core/src/runtime/local-driver.ts` | Deterministic in-memory `runtime-local` driver emitting protocol events, final-output state snapshots, and terminal `finishedAt` preservation |
| `packages/core/src/runtime/index.ts` | Public barrel re-exporting the canonical surface |
| `packages/core/test/runtime-driver.test.mjs` | 19 deterministic contract tests (start / resume / cancel / inspect / stream / approve / artifact + error paths, including final-output state and timestamp regressions) |
| `packages/core/test/runtime-e2e.test.mjs` | 5 end-to-end FakeRuntimeDriver lifecycle tests covering stream / approve / terminal artifact bundle flows |
| `scripts/scan-runtime-import-boundaries.mjs` | ADR-004 import-boundary scan |
| `tests/runtime-import-boundaries.test.mjs` | 10 fixture-driven regression tests pinning the rule catalog |
| `scripts/validate-next.mjs` + `tests/validate-next.test.mjs` | New `runtime-import-boundaries` step wired between `default-runtime-scan` and `schema-generation` |
| `packages/core/package.json` + `packages/core/tsconfig.json` | `@types/node` ^24.0.0 dev dep + `types: ["node"]` so `node:crypto` is available inside the local driver without leaking into `@legion/protocol` |

## Acceptance evidence

- `pnpm run typecheck` — green across all 9 workspace projects.
- `pnpm run test` — green across all workspace test suites
  (80 @legion/core, 54 @legion/protocol, 59 @legion/artifacts,
  130 @legion/store-sqlite, 34 @legion/legacy-bridge,
  10 apps/cli-e2e, 88 top-level).
- `node scripts/validate-next.mjs` — exits 0; the new
  `runtime-import-boundaries` step reports
  `RuntimeDriver import-boundary scan passed (5 runtime files, 10 core files)`.
- Full logs and SHA-256 checksums in
  `docs/next/evidence/P05-T01/` and
  `.legion/project/changes/LEGION-NEXT/implementation/phase-05/evidence-index.yaml`.
- GPT-5.5 closeout review added commit `1a44cef9b3c78b012630473e893ace6d8dc3a6af`, which fixes two runtime-local final-output edge cases: non-terminal `artifact(runId)` rejections now carry the current state snapshot, and terminal bundles preserve the terminal `finishedAt` instead of substituting artifact resolution time.

## Notes for downstream cards

- The contract is exported from `@legion/core`. Downstream cards
  should `import { RuntimeDriver, RuntimeLocalDriver,
  RUNTIME_DRIVER_METHODS, RuntimeStartRequest, RuntimeInspection,
  RuntimeStreamEvent } from "@legion/core"`.
- P05-T02 must build the Eve adapter against this exact contract
  shape and use `scripts/scan-runtime-import-boundaries.mjs` as its
  Eve-import-boundary regression guard. The current scan accepts only
  `@legion/protocol` and the local `./contract.js` module; Eve
  imports must come through a dedicated adapter package, not through
  `packages/core/src/runtime/`.
- P05-T03 must document the runtime-eve → runtime-local →
  runtime-legacy-cli precedence and the conditions under which each
  driver is invoked. The current branch now carries `runtime-eve`
  plus the abstract skeleton; P05-T03 will validate the selector and
  close out the remaining policy documentation.

## Known follow-ups

- The branch also carries a sibling `RuntimeDriverSkeleton` +
  `FakeRuntimeDriver` implementation authored by sargassoworker (a
  concurrent worker on the same scratch workspace). The skeleton
  throws `NotImplementedError` per method; the Fake is a second
  small in-memory driver. Both pass tests and the import-boundary
  scan. They are kept on the branch because they do not break the
  canonical `RuntimeLocalDriver` and they are useful scaffolding for
  future external drivers. P05-T02 can decide whether to retain,
  trim, or replace them.
