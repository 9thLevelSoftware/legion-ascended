# P01-T08 Golden Case Report

## Source

- ADR: `docs/next/adr/ADR-006-risk-adaptive-gates.md`
- Test file: `packages/core/test/risk-gates.test.mjs`
- Raw output: `docs/next/evidence/P01-T08/core-p01-t08-test.log`

## Covered Cases

| ADR-006 example | Expected tier | Verified gates |
| --- | --- | --- |
| Fix typo in committed docs | R0 | Current task contract or small-change record, deterministic verification, evidence note |
| Refactor isolated internal utility with tests | R1 | Task contract, scoped implementer run, deterministic verification, evidence bundle/log, lightweight independent review |
| Add user-facing CLI command touching multiple modules | R3 by total score | Protected oracle, explicit human approval, R3 gate set |
| Add persistent board migration | R3 by destructive migration floor | Rollback or forward-fix evidence, protected oracle, R3 gate set |
| Rotate production credential | R3 by security, side-effect, scope, and infrastructure floors | Security/e2e evaluator, release observation plan, explicit human approval |

## Result

`pnpm --filter @legion/core test -- --test-name-pattern=P01-T08` passed. The focused test output records five P01-T08 tests passing, including the ADR-006 golden examples.
