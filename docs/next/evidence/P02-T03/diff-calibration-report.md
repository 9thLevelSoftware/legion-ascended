# P02-T03 Diff Calibration And Stale-Edit Proof

Task: P02-T03 - Implement current-spec repository service

## Semantic Diff Calibration

`packages/artifacts/test/specs.test.mjs` contains `P02-T03 classifies semantic spec index diffs`.

The calibrated fixture verifies:

- `added`: a requirement ID exists only in the after index.
- `modified`: a requirement ID keeps its source path but changes content hash.
- `removed`: a requirement ID exists only in the before index.
- `moved`: a requirement ID keeps its content hash but changes source artifact path.

Result: PASS in `docs/next/evidence/P02-T03/current-spec-service-test.log`.

## Stale-Edit Proof

`packages/artifacts/test/specs.test.mjs` contains `P02-T03 blocks stale edits and supports rename and deprecate operations`.

The test creates revision 1, renames the capability to revision 2, then attempts an update with stale expected revision 1. The service returns `stale_spec_revision`, and a follow-up read proves the stale content did not replace the accepted current spec.

Result: PASS in `docs/next/evidence/P02-T03/current-spec-service-test.log`.

## Validation Diagnostics

`packages/artifacts/test/specs.test.mjs` contains `P02-T03 validation reports unresolved placeholders, contradictory status, and orphan trace IDs`.

The test verifies that active current truth cannot be represented by placeholder text, contradictory active/deprecated status, or trace IDs that do not resolve to requirements in the spec document.

Result: PASS in `docs/next/evidence/P02-T03/current-spec-service-test.log`.
