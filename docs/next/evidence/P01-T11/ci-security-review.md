# P01-T11 CI Security Review

Review date: 2026-06-20

## Scope

- `.github/workflows/ci.yml`
- `.github/workflows/protocol-compat.yml`

## Action Pinning

Action refs were resolved from the upstream action repositories with `git ls-remote --tags`.

| Action | Upstream tag checked | Pinned SHA |
| --- | --- | --- |
| `actions/checkout` | `v7.0.0` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` |
| `actions/setup-node` | `v6.4.0` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

## Review Results

| Control | Result | Evidence |
| --- | --- | --- |
| Repository token permissions are least-privilege. | PASS | Both workflows declare `permissions: contents: read`. |
| Workflows do not execute privileged fork events. | PASS | Both workflows use `pull_request`, `push`, and `workflow_dispatch`; neither uses `pull_request_target`. |
| Third-party workflow code is immutable. | PASS | All `uses:` references are pinned to full 40-character SHAs. |
| Checkout does not leave write credentials in the working copy. | PASS | `persist-credentials: false` is set on checkout. |
| Dependency installation is deterministic. | PASS | Both workflows enable Corepack and run `pnpm install --frozen-lockfile --strict-peer-dependencies`. |
| CI and local validation share the same Phase 1 gate order. | PASS | `ci.yml` runs `pnpm validate:next`, which is backed by `scripts/validate-next.mjs`. |

## Residual Risk

The workflow runner labels (`ubuntu-latest`, `macos-latest`, `windows-latest`) are intentionally floating hosted-runner images because P01-T11 requires a supported-platform matrix. Node and action code are pinned separately.
