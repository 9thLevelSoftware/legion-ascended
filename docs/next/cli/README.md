# Legion CLI

The canonical CLI is workflow-first:

```powershell
legion start
legion plan 1
legion build
legion review
legion status
legion quick "fix the failing tests"
```

The CLI preserves the original Legion workflow verbs while routing them through the v9 typed control plane. Normal users should not need `project`, `change`, `board`, extension manifests, prompt hashes, or hidden compatibility aliases to begin work.

`legion build` executes the latest typed taskgraph through an executor adapter and records pending evidence. `legion review` submits structured review decisions, and `legion review --accept` is the default human approval boundary before `legion ship` reports readiness.

Advanced operator and developer commands live under `legion dev`:

```powershell
legion dev project status
legion dev change validate chg_example
legion dev board task list --input query.json
legion dev migrate --from-planning --dry-run --planning-root .planning --staging-root .legion/var/import
legion dev evals threat-model --run-dir runs/example --output-root runs
legion dev release checklist --release-version 9.0.0
```

## Project Commands

```powershell
legion --repository-root C:\path\to\repo dev project init --input project-init.json
legion --repository-root C:\path\to\repo dev project validate
legion --repository-root C:\path\to\repo dev project status
```

`project init` reads a JSON object compatible with `initProject` and writes only through `@legion/artifacts`.

## Change Commands

```powershell
legion --repository-root C:\path\to\repo dev change create --input change.json
legion --repository-root C:\path\to\repo dev change validate chg_example
legion --repository-root C:\path\to\repo dev change diff chg_example
legion --repository-root C:\path\to\repo dev change archive chg_example --archived-by dasbl --archived-at 2026-06-21T13:00:00.000Z --output-branch codex/archive
```

`change create` reads a JSON object compatible with `createChangeBundle`. `change archive` delegates to `archiveAcceptedChange`; it does not bypass accepted-state, traceability, evidence, or current-truth checks.

## Migration Commands

```powershell
legion --repository-root C:\path\to\target dev migrate --from-planning --dry-run --planning-root C:\path\to\source\.planning --staging-root C:\tmp\stage --run-id import-001 --project project-import.json
legion --repository-root C:\path\to\target dev migrate --from-planning --apply --staging-root C:\tmp\stage --backup-root C:\tmp\backups --review-accepted
legion --repository-root C:\path\to\target dev migrate --from-planning --rollback --backup-manifest C:\tmp\backups\...\backup-manifest.json
```

```powershell
legion --repository-root C:\path\to\repo dev migrate --from-codex-legion --dry-run --staging-root C:\tmp\stage --run-id codex-import-001
legion --repository-root C:\path\to\repo dev migrate --from-codex-legion --apply --staging-root C:\tmp\stage --backup-root C:\tmp\backups --review-accepted
legion --repository-root C:\path\to\repo dev migrate --from-codex-legion --rollback --backup-manifest C:\tmp\backups\...\backup-manifest.json
```

Migration commands call `@legion/legacy-bridge` services. Dry-run staging, apply review gates, backups, rollback validation, and destructive-operation preflights remain owned by that package.

## Output And Automation

Use `--json` for scripts and tests. Failed service results return nonzero exit codes and preserve the service diagnostics in the JSON payload.

Use `--no-color` for deterministic snapshots. The current implementation does not emit ANSI color, and this flag is accepted to lock the noninteractive contract.

## Dogfood Verification

Run the full workflow loop in a disposable temp workspace:

```powershell
pnpm workflow:dogfood
```

Run the same loop against a temp clone of a real repository without mutating the original:

```powershell
pnpm workflow:dogfood -- --target "C:\Users\dasbl\Documents\Asset Mapper" --executor fake
```

Use `--executor codex --live-codex` only for an explicit live Codex smoke run.
