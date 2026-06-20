# P02-T02 Idempotency And Ownership Report

## Scope

This report summarizes the temporary Git repository proof captured in `golden-init-and-git-ownership.log`.

The proof initialized a fresh repository with `initProject`, ran `initProject` a second time against the same repository, and checked the resulting committed and ignored paths. It used the accepted P02-T01 path contract for the project manifest path: `.legion/project/project.json`.

## Results

| Check | Result |
| --- | --- |
| First initialization | `initialized` |
| Repeat initialization | `already_initialized` |
| Manifest bytes stable across repeat init | `true` |
| Constitution bytes stable across repeat init | `true` |
| `.legion/var` ignored by Git | `ignored` |
| `.legion/project/project.json` trackable by Git | `trackable` |

Golden initialized tree hashes:

| Path | SHA256 |
| --- | --- |
| `.gitignore` | `2fb415ed418f1b257f5ca8808ae2783a7bbfc8feedfd19194daf07cf024a1b0d` |
| `.legion/project/constitution.md` | `8ed4ffde7d1107c7b4c926965dc7b5bbcd06f7877e602f21e0b127d87b3d993f` |
| `.legion/project/project.json` | `a344353d113e70d8a7e1b1e3330449528ee13bec7c1c201da0dc9db87e60f8ff` |

## Path Decision

The Phase 2 P02-T02 task prose mentions `.legion/project/project.yaml`, but P02-T01 established `.legion/project/project.json` in `docs/next/artifacts/PATH-CONTRACT.md` and the artifacts API now exposes that canonical path. P02-T02 follows the accepted P02-T01 path contract so downstream services consume one typed manifest path instead of splitting YAML and JSON manifest conventions.

## Residual Risk

No P02-T02 evidence suggests unsafe overwrite behavior. The remaining risk is coordination only: P02-T03 and later tasks must use `PROJECT_ARTIFACT_PATHS.projectManifest` instead of copying the stale `.yaml` wording from the phase prose.
