# P02-T06 Invalidation Impact Report

The impact analyzer walks the validated traceability graph downstream from a changed artifact.

## Requirement-Scoped Current Spec Change

Input:

- Changed artifact: `.legion/project/specs/req_alpha.md`
- Changed requirement IDs: `req_alpha`

Expected impact:

- Requirements: `req_alpha`
- Oracles: `orc_alpha-proof`
- Tasks: `ctr_alpha-task`
- Evidence: `evd_alpha-proof`
- Reviews: `rev_alpha-review`

The same current spec also contains `req_beta`, but the requirement filter prevents false invalidation of `ctr_beta-task`, `evd_beta-proof`, and `rev_beta-review`.

## Design Change

Input:

- Changed artifact: `.legion/project/changes/chg_traceability-matrix/design.md`

Expected impact:

- Tasks: `ctr_alpha-task`, `ctr_beta-task`
- Evidence: `evd_alpha-proof`, `evd_beta-proof`
- Reviews: `rev_alpha-review`, `rev_beta-review`

This proves design changes flow through task contracts to evidence and review records.
