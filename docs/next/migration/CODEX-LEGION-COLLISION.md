# Codex `.legion/` Collision Migration

P02-T09 adds a reviewed bridge for repositories that already contain a v8 Codex Legion install under `.legion/`.

The current installer still writes v8 runtime protocol files to `.legion/` by default. The bridge does not change that behavior. It gives v9 initialization a safe migration path by moving legacy protocol bytes into `.legion/legacy-protocol/`, leaving `.legion/project/` reserved for v9 project artifacts and `.legion/var/` reserved for ignored operational state.

## Source Classes

The migration report classifies `.legion/**` files into two ownership groups:

- `generated-plugin-protocol`: files under installer-managed manifest paths such as `.legion/agents`, `.legion/commands/legion`, `.legion/skills`, `.legion/adapters`, and `.legion/manifest.json`.
- `user-authored-or-customized`: files not covered by the manifest, plus all files in partial installs that have no manifest.

Existing `.codex/prompts/**` files and `.agents/skills/legion/SKILL.md` are reported as native Codex surfaces and are left untouched. They are not moved into `.legion/legacy-protocol/`.

## API

Use `@legion/legacy-bridge`:

- `scanCodexLegionSource({ repositoryRoot })`
- `createCodexLegionMigrationDryRun({ repositoryRoot, stagingRoot, runId })`
- `applyCodexLegionMigration({ repositoryRoot, stagingRoot, backupRoot, reviewAccepted })`
- `rollbackCodexLegionMigration({ repositoryRoot, backupManifestPath })`

For deterministic dry-runs, pass stable `runId` and `createdAt` values. The dry-run writes `.legion/migration/codex-legion-migration-report.json` into the staging root and stages moved bytes under `.legion/legacy-protocol/`.

## Review Gates

Apply is blocked until `reviewAccepted: true` is supplied. Before applying, the service revalidates both the staged legacy-protocol tree hash and the live `.legion/` source tree hash against the reviewed report.

Apply creates a backup manifest before moving bytes. Rollback restores the exact pre-migration `.legion/` layout from that manifest.

## Initialization Rule

After migration, v9 project initialization accepts `.legion/legacy-protocol/` as a preserved legacy owner. Other visible `.legion/` entries still produce `migration_required` so accidental mixed ownership remains blocked.
