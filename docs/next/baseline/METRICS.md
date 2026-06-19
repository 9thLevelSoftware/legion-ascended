# Baseline Metrics

## Status

Accepted for P00-T05 review on 2026-06-19.

## Required Metrics

| Metric | Source | Required treatment |
| --- | --- | --- |
| Scenario success | `score.json` | Pass only when deterministic critical checks pass. |
| Quality score | `score.json` | Sum deterministic and judged dimensions after deterministic seal. |
| Escaped defects | evaluator assertions | Count held-out failures not detected by public checks. |
| Duration | run manifest timestamps | Separate harness overhead from agent duration. |
| Tokens | host telemetry | Record unavailable when the host does not expose values. |
| Cost | host telemetry | Record unavailable when the host does not expose values. |
| Human interventions | run manifest events | Count questions, approvals, resumes, and manual corrections. |
| Scope violations | Git snapshot and scenario manifest | Count forbidden path changes and unrelated rewrites. |
| Duplicate work | Git snapshot and event stream | Count repeated edits, duplicate commits, and repeated artifacts. |
| Recovery | run manifest terminal state | Grade interrupted and failed runs without deleting them. |

## Unavailable Telemetry

Token and cost values must be recorded as unavailable with a null value and reason. The harness never infers or backfills token or cost values from transcript length.
