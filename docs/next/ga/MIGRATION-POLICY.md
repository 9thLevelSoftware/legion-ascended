# Migration Policy

## Status

Accepted for Phase 13 GA on 2026-06-22.

Decision owner: `dasbl`

Review evidence: `docs/next/evidence/P13-T03/integration-report.yaml`,
`docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md` (P13-T04 closeout)

## Purpose

Pins the operator-facing migration path from a v8 install to a v9
project. The policy is intentionally explicit about which CLI surface
each source maps to, what user artefacts get preserved, and which
checks gate every destructive step. Phase 13 closes with the
canonical migration tooling under `@legion/legacy-bridge` and the CLI
adapter in `@legion/cli`; this document is the operator-facing
contract.

## Sources And Actions

`legion dev migrate` accepts exactly one `--from-*` source and
exactly one `--verify|--dry-run|--apply|--rollback` action. The CLI
rejects any other combination as a usage error so the operator cannot
accidentally cross-source apply or roll back with the wrong manifest.

| Source flag | Backing package | Backup kind |
| --- | --- | --- |
| `--from-planning` | `@legion/legacy-bridge/import-planning` | `planning-import-backup` |
| `--from-codex-legion` | `@legion/legacy-bridge/import-codex` | `codex-legion-migration-backup` |

| Action flag | Effect | Reversible |
| --- | --- | --- |
| `--verify` | Stages a dry-run report; source bytes untouched | n/a |
| `--dry-run` | Same as `--verify` (alias) | n/a |
| `--apply` | Writes staged bytes into the live `.legion/` tree; requires `--review-accepted` | yes (backup-manifest produced) |
| `--rollback` | Restores the live `.legion/` tree from the `--backup-manifest` path | n/a |

## Compatibility Verification

The `--verify` action is the canonical safety gate. It:

1. Stages a deterministic report under
   `.legion/migration/<source>-<runId>-report.json`.
2. Hashes the staged tree (LF-normalised UTF-8 bytes + POSIX paths,
   lowercase SHA-256) so the apply step can re-validate.
3. Hashes the live `.legion/` tree (sha256 prefix-free).
4. Records every file move (source path, target path, source class:
   `installer-manifest`, `manifest-native-artifact`, `prompt-file`,
   `bridge-skill`, `user-authored-or-customized`).
5. Fails closed on any unsupported symbolic link, missing manifest, or
   staged / live tree hash drift.

`--verify` does not modify the source bytes; running it twice produces
identical reports (modulo the run id). The verify step is exposed as
`legion dev migrate --verify ...` so operators can wire it into CI
before destructive changes.

## Source Class Preservation

| Source class | Treatment |
| --- | --- |
| `installer-manifest` | Recorded in the report; restored from the backup on rollback |
| `manifest-native-artifact` | Moved into `.legion/legacy-protocol/` (Codex source) or `.legion/project/` (planning source) |
| `prompt-file` | Left untouched on the host filesystem (Codex native surface) |
| `bridge-skill` | Moved into `.legion/legacy-protocol/skills/` and indexed by the v9 skill loader |
| `user-authored-or-customized` | Moved into `.legion/legacy-protocol/` and preserved verbatim |

User-authored or customised bytes are preserved **byte-for-byte**:
the migration does not normalise line endings, hash the bytes, or
rewrite the tree shape. The deterministic report hash captures the
pre-migration state so a tampered or drifted restore would fail the
post-apply validator.

## Review Gates

`--apply` is blocked until the operator passes `--review-accepted`.
The apply step:

1. Re-hashes the staged legacy-protocol tree and the live `.legion/`
   tree against the reviewed report (drift fails closed).
2. Writes the backup-manifest under `<backup-root>/backup-manifest.json`.
3. Removes the live `.legion/` tree.
4. Copies the staged legacy-protocol tree into `.legion/legacy-protocol/`.
5. On any failure mid-apply, automatically invokes rollback with the
   just-written backup-manifest.

The backup-manifest schema is `0.1.0` with `kind` of
`planning-import-backup` or `codex-legion-migration-backup`. The full
schema is enforced by `rollbackCodexLegionMigration` and
`rollbackPlanningImport` in `@legion/legacy-bridge` and re-verified
by `scripts/release/rollback-policy.mjs` for the GA gate.

## Init-After-Migration

After a successful Codex `.legion/` migration, v9 project initialisation
accepts `.legion/legacy-protocol/` as a preserved legacy owner. Other
visible `.legion/` entries still produce `migration_required` so
accidental mixed ownership remains blocked.

After a successful planning import, `.legion/project/` becomes the
authoritative state and `.planning/` is treated as historical input.
Subsequent `legion dev project validate` runs read from
`.legion/project/` exclusively.

## Verification Matrix

| Gate | Verification command | Pass criterion |
| --- | --- | --- |
| Pre-apply dry-run | `legion dev migrate --from-codex-legion --verify --staging-root <staging> --run-id <id>` | exit 0 + `status: "dry_run"` |
| Apply | `legion dev migrate --from-codex-legion --apply --staging-root <staging> --backup-root <backup> --review-accepted` | exit 0 + `status: "applied"` + non-empty `backup.manifestPath` |
| Post-apply restore-readiness | `node scripts/release/rollback-policy.mjs --backup-manifest <manifest>` | exit 0 + `status: "restorable"` + zero findings |
| Rollback | `legion dev migrate --from-codex-legion --rollback --backup-manifest <manifest>` | exit 0 + `status: "rolled_back"` + `restoredHash` recorded |
| Post-rollback parity | `node scripts/release/rollback-policy.mjs --backup-manifest <manifest>` | exit 0 + hash recomputed from the live `.legion/` matches `preMigrationHash` / `preImportHash` |

The CLI e2e suite (`apps/cli-e2e/test/cli-e2e.test.mjs`) covers the
verify / apply / rollback round-trip and asserts the original source
bytes are restored after rollback.

## Operator Runbook

1. **Plan**: read the v8 baseline report
   (`docs/next/baseline/V8-BASELINE-REPORT.md`) and confirm the
   source baseline matches your checkout.
2. **Verify**: run `legion dev migrate --from-<source> --verify
   --staging-root <scratch> --run-id <unique>` and review the report
   under `.legion/migration/`.
3. **Apply**: run the apply command with `--review-accepted` and a
   fresh `--backup-root`. The backup-manifest path is printed in the
   success output.
4. **Confirm**: run `node scripts/release/rollback-policy.mjs
   --backup-manifest <printed-path>` to confirm the rollback path is
   restorable. The CLI prints `restorable` when the manifest is
   intact, the backup directory exists, and the tree hash matches.
5. **Adopt**: run `legion dev project validate` to confirm the v9
   project state is parseable.

## Failure Recovery

If any step fails:

- `--verify` failure: re-run with `--dry-run` to inspect the report,
  then fix the source tree and re-verify. The verify step never
  modifies source bytes.
- `--apply` failure: the apply step rolls back automatically. Inspect
  the `.legion/` tree; if it is missing or partial, run the rollback
  command with the backup-manifest the apply step printed.
- `--rollback` failure: the rollback writes a `failure` payload with
  a stable diagnostic code. The most common cause is a tampered or
  missing backup-manifest; run
  `scripts/release/rollback-policy.mjs --backup-manifest <path>` for a
  detailed diagnosis.

## Evidence

- `docs/next/migration/CODEX-LEGION-COLLISION.md` — source classes,
  bridge API, review gates, init-after-migration rule
- `docs/next/migration/LEGACY-PERSONA-MAP.md` — legacy persona map
- `docs/next/adr/ADR-007-kanban-migration.md` — `/legion:*` command
  disposition table (legacy alias strategy)
- `docs/next/evidence/P02-T10/completion-report.yaml` — planning
  import migration evidence (P02-T10 closeout)
- `docs/next/evidence/P12-T02/integration-report.yaml` — migration
  verify alias evidence (P12-T02 closeout)
- `docs/next/evidence/P13-T03/integration-report.yaml` — GA evidence
  (P13-T03 closeout)
- `packages/legacy-bridge/src/import-codex/index.ts` — Codex migration
  implementation (`BackupManifest` schema, `rollbackCodexLegionMigration`)
- `packages/legacy-bridge/src/import-planning/index.ts` — planning
  import implementation (`BackupManifest` schema, `rollbackPlanningImport`)
