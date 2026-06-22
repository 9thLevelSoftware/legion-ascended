# Rollback Policy

## Status

Accepted for Phase 13 GA on 2026-06-22.

Decision owner: `dasbl`

Review evidence: `docs/next/evidence/P13-T03/integration-report.yaml`,
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout)

## Purpose

Pins the conditions under which a v9 GA migration must be rolled back,
the procedure the operator follows, and the verification matrix that
proves the rollback restored the pre-migration state. The policy is
fail-closed: every rollback command is gated by a backup-manifest
verifier that fails closed on schema drift, hash mismatch, missing
backup directory, or read-only restore target.

## When To Roll Back

The decision owner records a rollback intent in the Phase 13 ledger
plus a decision record naming the failing gate. Common triggers:

| Trigger | Symptom | Decision owner action |
| --- | --- | --- |
| Post-apply validator flags `restore_target_writable` | `node scripts/release/rollback-policy.mjs` reports a non-empty findings list | Authorise immediate rollback; investigate the operator's filesystem |
| Held-out security-sensitive contract regresses | `legion next evals threat-model` reports findings on a sealed v9 run | Authorise rollback; re-open P13-T02 |
| v8 / v9 A/B comparison shows a regression beyond the fail-closed contract | `docs/next/evidence/P13-T01/ab-comparison/ab-comparison.json` lists a `v9` regression on a sealed scenario | Authorise rollback; re-open P13-T01 |
| Migration apply fails mid-flight | `legion next migrate --apply` prints a `failure` payload | The apply step auto-rolls back; confirm via the verifier |
| Adopt step fails | `legion next project validate` reports `parse_failed` | Roll back to the last good backup-manifest |

Rollback is reversible in the sense that the live `.legion/` tree is
restored to its pre-migration state, but the v9 project state
(`.legion/project/`) is **lost**. Operators who want to preserve v9
state across a rollback must snapshot `.legion/project/` before the
apply step.

## Backup Manifest Contract

Every apply step writes a backup-manifest under
`<backup-root>/backup-manifest.json`. The schema is enforced by
`@legion/legacy-bridge` and re-verified by
`scripts/release/rollback-policy.mjs`.

```jsonc
{
  "schemaVersion": "0.1.0",
  "kind": "codex-legion-migration-backup" | "planning-import-backup",
  "createdAt": "2026-06-22T12:00:00.000Z",
  "repositoryRoot": "/abs/path/to/repo",
  "backupPath": "/abs/path/to/.legion-backup-<runId>",
  "preMigrationHash": "sha256:<hex>",     // codex-legion-migration-backup
  "preImportHash":   "sha256:<hex>",     // planning-import-backup
  "sourceHash":      "sha256:<hex>",
  "existingLegionRoot": true
}
```

Field semantics:

- `schemaVersion` — must equal `"0.1.0"`. A different value means the
  manifest was written by a different migration engine and the
  rollback path is unsupported.
- `kind` — must match the `--from-<source>` flag the operator used
  during apply. Cross-source rollback is rejected as a usage error.
- `createdAt` — UTC ISO 8601 timestamp. The verifier rejects manifests
  older than 365 days.
- `repositoryRoot` — must equal the resolved `--repository-root` of
  the current invocation. Cross-repository rollback is rejected.
- `backupPath` — absolute path to the byte-for-byte copy of the
  pre-migration `.legion/` tree. The verifier confirms the directory
  exists.
- `preMigrationHash` / `preImportHash` — sha256-prefix-free hash of
  the pre-migration tree, computed by `@legion/legacy-bridge`'s
  `hashTree`. The verifier recomputes the hash from the live
  `backupPath` bytes and fails closed on drift.
- `sourceHash` — sha256-prefix-free hash of the staged source tree
  recorded by the verify step. The verifier does not recompute this;
  it is informational for the decision record.
- `existingLegionRoot` — `true` if the apply step found a pre-existing
  `.legion/` directory and backed it up. When `true`, the restore
  target is the backup; when `false`, the restore target is an empty
  `.legion/` directory (the post-migration tree is purely
  `.legion/legacy-protocol/` or `.legion/project/`).

## Rollback Procedure

1. **Locate the backup-manifest**. The apply step prints the path in
   its success payload. If the path is lost, list `<backup-root>/`
   for the most recent `backup-manifest.json`.
2. **Verify the manifest** before invoking rollback:
   ```
   node scripts/release/rollback-policy.mjs \
     --backup-manifest <path> \
     [--repository-root <repo>] \
     [--source codex-legion|planning] \
     [--report <verifier-report.json>]
   ```
   The verifier prints `restorable` when the manifest is intact and
   the restore target is writable, `blocked` otherwise. Each blocked
   verdict lists a stable `code` the operator can grep:
   - `manifest_present` — path missing
   - `manifest_readable` — JSON parse failure
   - `manifest_schema_version` — schemaVersion mismatch
   - `manifest_kind_known` — unknown `kind`
   - `manifest_kind_supported` — kind != `--source`
   - `manifest_required_fields` — missing or wrong-typed field
   - `manifest_created_at_recent` — older than 365 days or invalid
   - `manifest_repository_root_match` — repositoryRoot mismatch
   - `manifest_backup_path_absolute` — backupPath not absolute
   - `manifest_backup_path_present` — backupPath missing
   - `manifest_backup_hash_match` — backup bytes drifted
   - `restore_target_writable` — parent directory not writable
   - `restore_target_absent` — no live `.legion/` to restore over
   - `restore_target_missing_project` — planning-import target
     missing `.legion/project/`
3. **Invoke rollback**:
   ```
   legion next migrate --from-<source> --rollback --backup-manifest <path>
   ```
   The CLI confirms `status: "rolled_back"` and prints `restoredHash`.
4. **Confirm parity** by re-running the verifier:
   ```
   node scripts/release/rollback-policy.mjs --backup-manifest <path>
   ```
   The verifier recomputes the hash of the live `.legion/` tree and
   confirms it matches the manifest. Note: the verifier only confirms
   hash parity for the **backup directory**, not the live tree, since
   the live tree should match by construction. A post-rollback parity
   check should use `git status --porcelain` plus a directory listing
   to confirm the expected files are back.
5. **Record the rollback** in the Phase 13 ledger with the failing
   gate, the manifest path, the verifier verdict, and the decision
   owner's sign-off.

## Idempotence

The verifier and the rollback CLI are idempotent:

- Re-running the verifier on an intact manifest produces the same
  verdict (modulo timestamps). The verifier never modifies state.
- Re-running rollback on a tree that already matches the backup is a
  no-op (the CLI removes and copies the same bytes). The verifier
  confirms the manifest is still restorable.

## Cross-Source Rollback

Cross-source rollback is **rejected**. The verifier emits
`manifest_kind_supported` if the manifest kind does not match the
`--source` flag. The CLI also refuses to invoke rollback with a
manifest kind that does not match its `--from-<source>` flag. This
prevents an operator from rolling back a Codex migration with a
planning backup-manifest (or vice versa), which would silently drop
user artefacts.

## Evidence

- `packages/legacy-bridge/src/import-codex/index.ts` —
  `BackupManifest` schema, `applyCodexLegionMigration`, and
  `rollbackCodexLegionMigration`
- `packages/legacy-bridge/src/import-planning/index.ts` —
  `BackupManifest` schema, `applyPlanningImport`, and
  `rollbackPlanningImport`
- `packages/cli/src/commands/migrate/index.ts` — `legion next migrate`
  CLI adapter (verify / dry-run / apply / rollback)
- `apps/cli-e2e/test/cli-e2e.test.mjs` — CLI e2e coverage of
  verify / apply / rollback (Codex source)
- `scripts/release/rollback-policy.mjs` — backup-manifest verifier
  (fail-closed gate)
- `tests/rollback-policy.test.mjs` — verifier regression tests
- `docs/next/evidence/P13-T03/integration-report.yaml` — GA evidence
  (P13-T03 closeout)
- `docs/next/ga/MIGRATION-POLICY.md` — operator-facing migration
  policy (this rollback policy is its inverse)
- `docs/next/ga/RELEASE-RECORD.md` — GA decision package