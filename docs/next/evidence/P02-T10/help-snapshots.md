# P02-T10 CLI Help Snapshots

Generated from `node packages/cli/dist/index.js next ... --help --no-color`.

## Root

```text
legion next <command>

Commands:
  project   Initialize, validate, and inspect v9 project artifacts.
  change    Create, validate, diff, and archive v9 change bundles.
  migrate   Dry-run, apply, and roll back legacy migration flows.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.
```

## Project

```text
legion next project <command>

Commands:
  init --input <file>       Initialize .legion/project from a JSON input object.
  validate                  Validate the project manifest and constitution.
  status                    Read project status and current-spec count.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
```

## Change

```text
legion next change <command>

Commands:
  create --input <file>     Create a change bundle from a JSON input object.
  validate <changeId>       Validate a persisted change bundle.
  diff <changeId>           Summarize proposed requirement changes.
  archive <changeId>        Archive an accepted change into current truth.

Archive options:
  --dry-run                 Plan archive without writing current truth.
  --archived-by <id>        Actor ID used for archive records.
  --archived-at <timestamp> UTC timestamp used for archive records.
  --output-branch <branch>  Branch metadata for archive records.
```

## Migrate

```text
legion next migrate --from-planning|--from-codex-legion --dry-run|--apply|--rollback

Planning dry-run:
  --from-planning --dry-run --planning-root <path> --staging-root <path> --run-id <id> --project <file>

Codex Legion dry-run:
  --from-codex-legion --dry-run --staging-root <path> --run-id <id>

Apply:
  --apply --staging-root <path> --backup-root <path> --review-accepted

Rollback:
  --rollback --backup-manifest <path>
```
