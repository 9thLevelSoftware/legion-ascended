# Planning Import

P02-T08 adds a read-only bridge from legacy `.planning/` project files into reviewed v9 project intent.

The importer does three separate things:

1. Scans `.planning/**`, hashes every source file, and classifies each file as direct mapping, derived context, uncertain narrative, operational-only, or unsupported.
2. Generates a dry-run staging tree with `.legion/project/project.json`, current spec artifacts derived from `PROJECT.md` requirements, and `.legion/project/migration/planning-import-report.json`.
3. Applies the staged tree only after explicit review, with a checksummed backup manifest that can roll back the exact pre-import `.legion` bytes.

Legacy `.planning/` files are never deleted or edited by the importer. `STATE.md`, roadmap completion tables, and phase summaries are preserved as source context only; mutable operational state is not accepted as current truth.

## API

Use `@legion/legacy-bridge`:

- `scanPlanningSource({ planningRoot })`
- `createPlanningImportDryRun({ repositoryRoot, planningRoot, stagingRoot, runId, project })`
- `applyPlanningImport({ repositoryRoot, stagingRoot, backupRoot, reviewAccepted, allowReplaceExistingProject })`
- `rollbackPlanningImport({ repositoryRoot, backupManifestPath })`

For deterministic dry-runs, pass stable `runId` and `project.createdAt` values. The report avoids absolute staging paths so identical sources and options produce identical staged bytes.

## Review Gates

Automatic apply is blocked until `reviewAccepted: true` is supplied. Stale `STATE.md` notices and contradictory plan-summary file mappings are surfaced in the report so a reviewer can decide whether to adjust mappings or stop the migration.

If `.legion/project` already exists, apply fails unless `allowReplaceExistingProject: true` is set after review. Repeated imports are therefore conflict-safe by default.
