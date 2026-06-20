# P01-T08 Monotonicity Property Tests

## Property

Adding a normalized high-risk signal must never lower the derived risk tier. A score of `3` on any normalized signal must force `R3`.

## Normalized Signals Checked

- `security`
- `authorization`
- `data_migration`
- `external_side_effect`
- `public_api`
- `ui`
- `performance`
- `infrastructure`
- `irreversible_action`
- `scope_breadth`
- `novelty_uncertainty`
- `verification_quality`

## Evidence

The test `P01-T08 adding a high-risk signal never lowers the derived tier` iterates every normalized signal, appends a score-3 signal to an R1 baseline, and asserts both rank monotonicity and R3 escalation.

Raw output: `docs/next/evidence/P01-T08/core-p01-t08-test.log`

Result: PASS.
