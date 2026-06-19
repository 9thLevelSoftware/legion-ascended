# V8 Maintenance Policy

## Status
Draft for P00-T01 review. Blocked on fresh v8 baseline validation as of 2026-06-19.

Decision owner: `dasbl`

Review evidence: [P00-T01 charter review](evidence/P00-T01/charter-review.log)

## Policy
The v8 line is frozen for defects, security fixes, host compatibility fixes, packaging correctness, and documentation corrections. New workflow architecture, durable runtime behavior, persona removal, control-plane implementation, migration tooling, and release automation belong to v9.

The v8 package remains the shipped compatibility baseline while Legion Next is developed in parallel. P00-T01 does not change runtime behavior, command behavior, installer behavior, adapters, skills, or personas.

## Permitted V8 Changes
- Security fixes.
- Broken installer or packaging fixes.
- Runtime compatibility fixes for already-supported surfaces.
- Documentation corrections that reflect shipped behavior.
- Test fixes that preserve existing behavior.

## V9-Only Changes
- Durable board or queue implementation.
- Eve runtime integration.
- Functional worker bundle runtime.
- Persona purge from default execution.
- New artifact model or migration engine.
- Dashboard, deployment, release observation, or rollback automation.

## Baseline Rule
Any v8 baseline tag must point to a clean, reproducibly tested commit. If a baseline correction is needed, create a superseding baseline tag and preserve the original.

The proposed P00-T01 baseline tag is `v8-baseline-20260619`, intended to target the current tested v8 baseline from `C:/Users/dasbl/Documents/legion`. The tag was not created because fresh-checkout validation failed before tagging. When validation passes, the tag remains local until the decision owner approves publication.

## Branch and Release Control
- Start v8 maintenance work from the accepted v8 baseline tag or the current v8 maintenance branch, never from Legion Next task branches.
- Keep v8 maintenance PRs scoped to permitted changes and label them `v8-maintenance` plus the affected surface.
- Run `npm ci`, `npm run validate`, `npm run release:check`, and `npm test` before accepting a v8 maintenance change.
- Publish v8 only as compatible patch maintenance unless the decision owner approves a separate compatibility decision.
- Do not move or rewrite a baseline tag. Use a superseding tag for corrections.

## Compatibility Boundary
- Do not delete, rename, or stop publishing v8 Markdown commands, skills, adapters, installers, or personas during Milestone A.
- Do not change default user-visible v8 behavior without a separately approved compatibility decision.
- Do not claim v9 quality, speed, portability, or durability improvements from v8 maintenance work.
- Do not add production dependencies to v8 for rewrite convenience.
