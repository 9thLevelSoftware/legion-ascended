---
{
  "schemaVersion": "0.1.0",
  "kind": "oracle-artifact",
  "revision": 1
}
---

# Oracle Artifact

## Identity

Use `orc_<slug>` for the oracle ID and store the artifact at `.legion/project/changes/<change-id>/oracle/<oracle-id>.yaml`.

## Ownership And Protection

Record the owner, protected project artifact paths, source artifact references, and requirement coverage that reviewers must inspect before accepting the oracle.

## Expected Behavior

List preconditions, postconditions, and the evidence that proves the oracle result without committing bulk operational logs.

## Execution

Use `command`, `runtime-driver`, or `manual-inspection` execution metadata. Command/runtime outputs should be referenced later through the evidence index by hash and retained artifact location.
