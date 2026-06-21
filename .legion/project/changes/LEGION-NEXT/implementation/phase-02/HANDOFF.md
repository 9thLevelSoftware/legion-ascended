# Phase 2 Handoff

Phase 2 now has implementation coverage for the Git-tracked artifact model, current specs, change bundles, support artifacts, traceability, archive, planning import, Codex `.legion` migration, and the first `legion next ...` CLI surface.

## Final Task

P02-T10 added the private `@legion/cli` package and `apps/cli-e2e` process-level tests. The root package `legion` binary remains the legacy installer entrypoint; the v9 command shape is implemented under the explicit `next` namespace for later packaging.

## CLI Surface

- `legion next project init|validate|status`
- `legion next change create|validate|diff|archive`
- `legion next migrate --from-planning --dry-run|--apply|--rollback`
- `legion next migrate --from-codex-legion --dry-run|--apply|--rollback`

The CLI is presentation-only. Project, change, archive, and migration mutations remain owned by `@legion/artifacts` and `@legion/legacy-bridge`.

## Evidence

- `docs/next/evidence/P02-T10/cli-e2e-test.log`
- `docs/next/evidence/P02-T10/help-snapshots.md`
- `docs/next/evidence/P02-T10/cli-fixture-hash-proof.json`
- `docs/next/evidence/P02-T10/full-validation.log`
- `docs/next/evidence/P02-T10/completion-report.yaml`

## Verification

- `pnpm --filter @legion/cli-e2e test`
- `pnpm run validate:next`

Both passed after the final package metadata cleanup.

## Review Notes

- `@legion/cli` intentionally does not publish a package bin yet. The current executable path is `node packages/cli/dist/index.js next ...`, which preserves the v8 root installer contract.
- Phase ledger `P02-T10.commit` records PR review follow-up commit `1f39d42c73b934a078df61dfea2b443335197b4b`.
- PR review follow-up hardens JSON input boundary errors, valueless flag parsing, subcommand help, and standalone CLI E2E build order.
