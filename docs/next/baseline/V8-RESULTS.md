# V8 Results

## Status

DONE for P00-T06 on 2026-06-19 after scope correction.

## Scope

The v8 baseline is the deterministic workflow-compatibility reference for rebuilding Legion as a workflow orchestration tool. It is not a standalone application benchmark and does not require live model execution before Phase 1.

## Baseline Identity

- v8 tag: v8-baseline-20260619
- v8 commit: 855e975beec3bac6dc06db598081b6ac11ea8e14
- corpus manifest: evals/baseline/manifest.yaml
- fixture hash file: evals/baseline/fixture-hashes.sha256
- compatibility report: docs/next/baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md

## Deterministic Results

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline tag resolves to expected commit | PASS | docs/next/evidence/P00-T06/compatibility-baseline.log |
| Package dry-run records v8 file list | PASS | docs/next/evidence/P00-T06/npm-pack-dry-run.json |
| P00-T01 validation remains accepted baseline evidence | PASS | docs/next/evidence/P00-T01/fresh-checkout-validation.log |
| Scenario corpus remains sealed for future workflow evals | PASS | evals/baseline/manifest.yaml |

## Limitations

- No live model/runtime quality claims are made in Phase 0.
- Cost, tokens, duration, and human-intervention metrics remain unavailable until later live workflow evals.
- The prior live-run blocker is preserved as historical evidence and superseded by this workflow-compatibility baseline.

## Decision

Phase 1 may proceed from the frozen v8 reference because the workflow surface and package baseline are stable. Live model benchmarking is deferred to the evaluation phases after typed protocol/core and runtime-driver contracts exist.
