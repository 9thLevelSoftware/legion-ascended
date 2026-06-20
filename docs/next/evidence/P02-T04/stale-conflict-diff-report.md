# P02-T04 Stale, Conflict, And Diff Report

## Scope

This report covers the P02-T04 change-bundle service behavior for proposed change artifacts under `.legion/project/changes/<change-id>/`.

## Conflict Handling

`packages/artifacts/test/changes.test.mjs` includes `P02-T04 rejects conflicting delta operations before writing a bundle`.

The regression creates two delta operations for the same requirement (`modify` and `remove`) in one change bundle. `createChangeBundle` returns `status: invalid` with diagnostic code `conflicting_delta_operations`, and `loadChangeBundle` confirms no `change.yaml` bundle was written.

## Stale Base Handling

`packages/artifacts/test/changes.test.mjs` includes `P02-T04 detects stale current-spec bases during change validation`.

The regression creates a change bundle against current spec revision 1, updates the current spec to revision 2, then runs `validateChangeBundle`. Validation returns `status: invalid` with diagnostic code `stale_change_base`.

## Semantic Diff Snapshot

`docs/next/evidence/P02-T04/sample-change-tree.json` records the deterministic public-API proof for a complete sample bundle.

The sample diff is:

```json
{
  "added": [],
  "modified": [
    "req_workflow-control"
  ],
  "removed": []
}
```

The same proof records `loadedMatchesCreated: true` and `validation: "PASS"` after writing and reloading the bundle.
