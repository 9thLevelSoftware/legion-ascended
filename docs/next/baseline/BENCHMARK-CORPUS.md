# Benchmark Corpus

## Status

Accepted for P00-T04 review on 2026-06-19.

## Purpose

The Phase 0 corpus defines the frozen v8 comparison workload for Legion Next. It measures accepted-code quality, recovery behavior, duplicate-work control, and evidence traceability rather than completion claims alone.

## Canonical Artifacts

- Corpus manifest: `evals/baseline/manifest.yaml`
- Alias manifest: `evals/baseline/corpus-manifest.yaml`
- Manifest schema: `evals/baseline/schema/manifest.schema.json`
- Alias schema: `evals/baseline/schema/corpus-manifest.schema.json`
- Oracle assertions schema: `evals/baseline/schema/oracle-assertions.schema.json`
- Scenario manifests: `evals/baseline/scenarios/*.json`
- Public inputs: `evals/fixtures/public/*/task.md`
- Evaluator-only assertions: `evals/fixtures/evaluator/*/assertions.yaml`
- Fixture hashes: `evals/baseline/fixture-hashes.sha256`
- Scoring rubric: `docs/next/baseline/SCORING-RUBRIC.md`

## Scenario Families

| Scenario ID | Family | Risk | Public input | Evaluator material |
| --- | --- | --- | --- | --- |
| `greenfield-feature.v1` | Greenfield feature | R2 | `evals/fixtures/public/greenfield-feature/task.md` | `evals/fixtures/evaluator/greenfield-feature/assertions.yaml` |
| `brownfield-feature.v1` | Brownfield feature | R2 | `evals/fixtures/public/brownfield-feature/task.md` | `evals/fixtures/evaluator/brownfield-feature/assertions.yaml` |
| `bug-fix.v1` | Bug fix | R2 | `evals/fixtures/public/bug-fix/task.md` | `evals/fixtures/evaluator/bug-fix/assertions.yaml` |
| `refactor.v1` | Refactor | R1 | `evals/fixtures/public/refactor/task.md` | `evals/fixtures/evaluator/refactor/assertions.yaml` |
| `api-change.v1` | API change | R3 | `evals/fixtures/public/api-change/task.md` | `evals/fixtures/evaluator/api-change/assertions.yaml` |
| `ui-flow.v1` | UI flow | R2 | `evals/fixtures/public/ui-flow/task.md` | `evals/fixtures/evaluator/ui-flow/assertions.yaml` |
| `security-sensitive.v1` | Security-sensitive change | R3 | `evals/fixtures/public/security-sensitive/task.md` | `evals/fixtures/evaluator/security-sensitive/assertions.yaml` |
| `interrupted-resumed.v1` | Interrupted/resumed long run | R3 | `evals/fixtures/public/interrupted-resumed/task.md` | `evals/fixtures/evaluator/interrupted-resumed/assertions.yaml` |

The `noop-calibration.v1` fixture is not part of the scored corpus. It exists only to verify the P00-T05 runner, grader, and redaction path.

## Current Repository State

Every scored scenario starts from the frozen v8 baseline:

- Source repository: `C:/Users/dasbl/Documents/legion`
- Baseline tag: `v8-baseline-20260619`
- Baseline commit: `855e975beec3bac6dc06db598081b6ac11ea8e14`
- Package version: `8.0.5`

P00-T06 must use LF-preserving checkouts with `core.autocrlf=false`, matching the accepted P00-T01 evidence.

## Public Versus Held-Out Inputs

Public inputs under `evals/fixtures/public` may be supplied to v8 workers. Evaluator material under `evals/fixtures/evaluator` is never included in worker context packets, prompts, or copied fixture workspaces. The harness records evaluator material hashes and paths until deterministic grading starts after a run is sealed.

## Fixture Governance

The corpus version is `legion-v8-baseline-corpus@1.0.0`. After P00-T04 acceptance, changes require a new corpus version, new fixture hashes, an impact note in the phase ledger, and invalidation of affected baseline runs. After the first P00-T06 production run for a scenario, public inputs and evaluator assertions are immutable for that corpus version.

## Provenance And License Review

All task packets and evaluator assertions in this corpus are synthetic Phase 0 fixtures authored for this repository on 2026-06-19. They contain no third-party source code, no customer data, no credentials, and no private service dependency. External redistribution is limited to the benchmark package and must preserve `evals/fixtures/PROVENANCE.md`.

## Manual Pilot Result

Each scenario was reviewed against the frozen v8 command surface, skills, agents, tests, and ADR decisions. The scenarios are scoped so they can be attempted from a clean v8 checkout without unavailable hosted services. The corpus includes deterministic assertions and judged dimensions so compile-only or documentation-only answers cannot pass when behavior is required.
