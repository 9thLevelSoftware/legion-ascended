# Legion Project Artifact Path Contract

P02-T01 establishes `@legion/artifacts` as the only supported low-level API for resolving, validating, hashing, revising, and atomically writing Git-tracked Legion project artifacts.

## Root

All committed Legion project artifacts live under `.legion/project` relative to the repository root. `.legion/var` remains operational state and is outside this contract.

The resolver persists only POSIX-style repository paths. Absolute paths, backslashes, `.` or `..` segments, duplicate separators, Unicode path segments, Windows alternate-data-stream separators (`:`), and uppercase path segments are rejected. The uppercase bootstrap path used by earlier Phase 0/1 governance records is historical input; new v9 artifact APIs emit lowercase protocol IDs.

## Canonical Layout

| Role | Canonical path |
| --- | --- |
| Project metadata | `.legion/project/project.json` |
| Constitution | `.legion/project/constitution.md` |
| Current specs | `.legion/project/specs/<requirement-id>.md` |
| Change proposal | `.legion/project/changes/<change-id>/change.yaml` |
| Delta specs | `.legion/project/changes/<change-id>/delta-specs/<requirement-id>.md` |
| Design | `.legion/project/changes/<change-id>/design.md` |
| Decision log | `.legion/project/changes/<change-id>/decisions.md` |
| Oracle | `.legion/project/changes/<change-id>/oracle/<oracle-id>.yaml` |
| Task graph | `.legion/project/changes/<change-id>/taskgraph.json` |
| Evidence index | `.legion/project/changes/<change-id>/evidence-index.json` |
| Archive record | `.legion/project/changes/<change-id>/archive.json` |
| ADRs | `.legion/project/adr/**` |

`<change-id>`, `<requirement-id>`, and `<oracle-id>` are protocol IDs from `@legion/protocol`, such as `chg_legion-next`, `req_workflow-contract`, and `orc_acceptance-proof`.

## Resolution And Validation

`resolveProjectArtifactPath` resolves a canonical repository path against the real repository root, then verifies that the nearest existing ancestor and any existing target remain beneath that root. Symlink escapes are rejected before reads or writes. Persisted artifact references must remain repository-relative protocol `ArtifactPath` values; absolute local paths are process-local only and never persisted.

JSON reads use caller-provided protocol schemas through `readJsonArtifact`. Invalid JSON, schema failures, missing files, and invalid paths return typed diagnostics with source paths and locations where available.

## Revisions And Atomic Writes

`writeRevisionedArtifact` requires the caller to pass the current protocol revision and expected revision. If they differ, the write fails before touching the target file. Updates to an existing artifact must also pass the superseded `ArtifactReference`; while holding the per-artifact write lock, the writer hashes the current target bytes and rejects the write if they no longer match that superseded reference. Successful writes return an existing protocol `ArtifactRevision` containing role, artifact reference, content hash, next revision, and optional superseded reference. Domain services in later Phase 2 tasks persist that metadata in their owning protocol records instead of creating a second durable metadata source.

Writes use a short-lived lock file and temp file in the target directory, write and fsync the temp file, optionally run a test/fault hook, atomically rename it over the target, and then best-effort fsync the parent directory where the platform allows it. An interrupted write before rename removes the temp file and leaves the prior target bytes readable.

## Local Serialization Policy

This package provides atomic file replacement, revision compare-and-swap checks, and fail-fast local serialization for same-artifact writes. The lock file is a filesystem safety guard, not a durable workflow queue primitive. Durable dispatch, leases, retries, and queue ownership belong to the Phase 3 board store named by ADR-003 and ADR-008.
