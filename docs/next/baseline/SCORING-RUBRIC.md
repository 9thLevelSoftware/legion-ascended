# Scoring Rubric

## Status

Accepted for P00-T04 review on 2026-06-19.

## Score Model

Each production benchmark run receives deterministic scores first. Judged scores are optional until deterministic artifacts are sealed. Missing telemetry is recorded as unavailable and never estimated.

| Dimension | Type | Weight | Passing rule |
| --- | --- | ---: | --- |
| Build integrity | Deterministic | 15 | Required install, lint, type, or test commands complete according to the scenario manifest. |
| Acceptance behavior | Deterministic | 25 | Held-out assertions pass for the user intent and edge cases. |
| Regression control | Deterministic | 15 | Existing behavior identified in the scenario remains intact. |
| Scope discipline | Deterministic | 10 | Changes stay within allowed paths and avoid unrelated rewrites. |
| Recovery behavior | Deterministic | 10 | Interrupted or failed attempts remain resumable and auditable. |
| Duplicate work control | Deterministic | 10 | Repeated dispatches do not duplicate edits, commits, or review artifacts. |
| Artifact traceability | Deterministic | 10 | Commits, logs, tests, evidence, and decisions link to the run manifest. |
| Maintainability | Judged | 3 | Independent judge rates code clarity, locality, and future change cost. |
| Requirement fidelity | Judged | 2 | Independent judge rates whether the solution matches the stated user intent. |

Total score is 100. A scenario fails regardless of numeric score when a critical held-out assertion fails, a protected file is weakened, a secret is exposed, or a run cannot be audited.

## Calibration

The rubric rejects compile-only and overbroad solution classes. `security-sensitive.v1` and `interrupted-resumed.v1` seed critical failures so the rubric can detect security weakening, ungradeable interruption, and duplicate-dispatch behavior.
