# Archive Semantics

P02-T07 adds an explicit archive transaction for accepted Legion changes. Archive is the only Phase 2 artifact service that merges proposed delta specs into current truth.

## Preconditions

`archiveAcceptedChange()` requires:

- the change bundle exists and validates;
- `change.status` is `accepted`;
- `change.acceptance.status` is `accepted`;
- current spec bases still match the recorded delta bases;
- traceability validation passes, including oracle, taskgraph, accepted evidence, and review provenance;
- the caller provides either a clean Git worktree or an explicit `outputBranch`.

If any precondition fails, the archive service returns typed diagnostics and does not write current specs or archive metadata.

## Preview

`planAcceptedChangeArchive()` performs the same validation without writing files. Its preview records:

- the before and after current-spec index hashes;
- the semantic requirement diff;
- each current-spec create/update operation, expected revision, next revision, and before/after artifact reference.

The executor stores the same preview in `.legion/project/changes/<change-id>/archive.json`, so a dry-run preview can be compared with the applied archive record.

## Apply

The executor applies add and modify deltas through the current-spec service, preserving compare-and-swap revision checks. Remove deltas archive the targeted requirement in place when it is the last requirement in a spec, or remove it from a multi-requirement spec.

After current truth writes complete, the service writes a revisioned archive record at:

`.legion/project/changes/<change-id>/archive.json`

The archive record retains references to the accepted proposal, delta specs, design, decision log, oracle artifacts, taskgraph, evidence index, and resulting current-spec revisions. Its `archiveHash` is computed over the archive record body excluding `archiveHash`, and reads recompute that value before returning success.

## Rollback And Retry

If a current-spec write or archive-record write fails, the service restores any touched files from pre-archive backups and removes new files created during the failed attempt. A recorded archive is idempotent: retry returns the existing verified archive record instead of replaying current-truth writes.
