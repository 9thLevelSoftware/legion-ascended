# Legion Next CLI

P02-T10 introduces the private `@legion/cli` package as a thin command layer over the Phase 2 artifact and migration services.

The current public root binary remains the legacy installer entry point. The v9 surface is implemented under the explicit `next` namespace so later packaging can route `legion next ...` without changing existing default behavior.

## Project Commands

```powershell
node packages/cli/dist/index.js next --repository-root C:\path\to\repo project init --input project-init.json
node packages/cli/dist/index.js next --repository-root C:\path\to\repo project validate
node packages/cli/dist/index.js next --repository-root C:\path\to\repo project status
```

`project init` reads a JSON object compatible with `initProject` and writes only through `@legion/artifacts`.

## Change Commands

```powershell
node packages/cli/dist/index.js next --repository-root C:\path\to\repo change create --input change.json
node packages/cli/dist/index.js next --repository-root C:\path\to\repo change validate chg_example
node packages/cli/dist/index.js next --repository-root C:\path\to\repo change diff chg_example
node packages/cli/dist/index.js next --repository-root C:\path\to\repo change archive chg_example --archived-by dasbl --archived-at 2026-06-21T13:00:00.000Z --output-branch codex/archive
```

`change create` reads a JSON object compatible with `createChangeBundle`. `change archive` delegates to `archiveAcceptedChange`; it does not bypass accepted-state, traceability, evidence, or current-truth checks.

## Migration Commands

```powershell
node packages/cli/dist/index.js next --repository-root C:\path\to\target migrate --from-planning --dry-run --planning-root C:\path\to\source\.planning --staging-root C:\tmp\stage --run-id import-001 --project project-import.json
node packages/cli/dist/index.js next --repository-root C:\path\to\target migrate --from-planning --apply --staging-root C:\tmp\stage --backup-root C:\tmp\backups --review-accepted
node packages/cli/dist/index.js next --repository-root C:\path\to\target migrate --from-planning --rollback --backup-manifest C:\tmp\backups\...\backup-manifest.json
```

```powershell
node packages/cli/dist/index.js next --repository-root C:\path\to\repo migrate --from-codex-legion --dry-run --staging-root C:\tmp\stage --run-id codex-import-001
node packages/cli/dist/index.js next --repository-root C:\path\to\repo migrate --from-codex-legion --apply --staging-root C:\tmp\stage --backup-root C:\tmp\backups --review-accepted
node packages/cli/dist/index.js next --repository-root C:\path\to\repo migrate --from-codex-legion --rollback --backup-manifest C:\tmp\backups\...\backup-manifest.json
```

Migration commands call `@legion/legacy-bridge` services. Dry-run staging, apply review gates, backups, rollback validation, and destructive-operation preflights remain owned by that package.

## Output And Automation

Use `--json` for scripts and tests. Failed service results return nonzero exit codes and preserve the service diagnostics in the JSON payload.

Use `--no-color` for deterministic snapshots. The current implementation does not emit ANSI color, and this flag is accepted to lock the noninteractive contract.
