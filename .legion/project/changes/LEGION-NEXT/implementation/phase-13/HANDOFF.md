# Phase 13 Handoff — Behavioral Evals, Security Hardening, and GA

## Status

IN PROGRESS.

P13-T01 (behavioral evals) is DONE. P13-T02 (security hardening) is the next
task. P13-T03 (GA decision) and P13-T04 (closeout) follow. Implementation
batch: P13-T01 on `codex/p03-t02-board-task-repository` after base
`c0a751abf68c7952e1463c64c807c3d83102b967`.

P13-T01 builds a release-grade behavioral eval workflow that compares v8
and v9 on sealed Phase 0 scenarios, records cost / duration / intervention
/ recovery / defect metrics, and exposes the pipeline through a new
`legion next evals` CLI subcommand. P00-T06 v8 baseline execution remains
blocked, so the comparison surfaces v8=null cells rather than fabricating
values; that fail-closed contract is the explicit Phase 13 acceptance rule.

## Delivered Surface — P13-T01

### Node-based eval harness

- `scripts/baseline/capture-run.mjs` — Node port of `capture-run.ps1`.
  Copies the public fixture into a sealed run directory, hashes files with
  lowercase SHA-256 over LF-normalized UTF-8 text + POSIX-relative paths,
  tokenizes the operator-supplied `--command` via a small POSIX shell
  parser and invokes it through `execFile` (no shell interpolation), runs
  the transcript through `redact-output.mjs`, and writes `run-manifest.json`
  that validates against `evals/baseline/schema/run-manifest.schema.json`.
  Accepts `--corpus-root` so CLI e2e workspaces do not need a corpus checkout.
- `scripts/baseline/grade-run.mjs` — Computes the seven deterministic rubric
  dimensions from the sealed `run-manifest.json` plus a sibling
  `run_id` collision scan, and writes `score.json` that validates against
  `evals/baseline/schema/score.schema.json`. Held-out evaluator assertions
  and judged dimensions remain out of scope here; the rubric marks them
  `not_scored_by_scaffold` / `judge_not_run` so a downstream grader can
  re-score after the deterministic seal.
- `scripts/baseline/redact-output.mjs` — Node port of `redact-output.ps1`.
  Masks `LEGION_SECRET_CANARY_*`, OpenAI-style API keys, bearer tokens,
  and common credential assignments. Exposed as both a CLI
  (`--input` / `--output`) and an importable `redactFile()` helper.
- `scripts/baseline/compare-runs.mjs` — v8/v9 A/B aggregator. Reads paired
  v8/v9 sealed run directories, computes aggregate and per-scenario rows
  for cost / duration / intervention / recovery / defects, and emits
  `ab-comparison.json` + `ab-comparison.md`. Missing v8 evidence surfaces
  as null cells (fail-closed) rather than being silently invented.

### CLI surface

- `packages/cli/src/commands/evals/index.ts` — `legion next evals` adapter.
  Subcommands: `capture` (seals a scenario into a run directory and writes
  `run-manifest.json`), `grade` (computes deterministic dimension scores
  for a sealed run directory), `compare` (aggregates v8 and v9 sealed run
  directories into an A/B report). The CLI resolves the v9 source root from
  the compiled location, so `--repository-root` can point at any e2e
  workspace.
- `packages/cli/src/index.ts` — Root CLI dispatch and help text now
  advertise `evals` alongside `project`, `change`, `board`, and `migrate`.

### Tests

- `apps/cli-e2e/test/cli-e2e.test.mjs` — Four new CLI e2e tests:
  `P13-T01 evals CLI capture dry-run seals a noop-calibration run with a
  valid manifest`, `P13-T01 evals CLI grade writes deterministic score.json
  with the seven rubric dimensions`, `P13-T01 evals CLI compare surfaces
  missing v8 evidence as null cells (fail-closed)`, `P13-T01 evals CLI
  capture without --dry-run requires --command`.
- `tests/evals-baseline.test.mjs` — Root-level regression test that pins
  the sealed Phase 0 corpus against drift. Asserts all eight sealed
  scenario families are present, every scenario JSON lists the seven
  deterministic checks and two judged checks, every held-out evaluator
  assertion is hidden from workers, `fixture-hashes.sha256` covers every
  scenario / manifest / fixture, and a sample of digests are
  recomputable from on-disk bytes.

## Verification Evidence

- `node --test tests/evals-baseline.test.mjs` — PASS, 5/5 tests.
- `pnpm --filter @legion/cli-e2e test` — PASS, 25/25 tests (was 21 before).
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 113/113 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 171/171 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across root and recursive workspace packages.
- `pnpm run validate:next` — PASS, package boundaries, worker bundles,
  runtime scans, schemas, tests, npm/pnpm pack all green.

Full closeout transcripts are under `docs/next/evidence/P13-T01/`. The
structured report is `docs/next/evidence/P13-T01/integration-report.yaml`;
the A/B comparison outputs are
`docs/next/evidence/P13-T01/ab-comparison.{json,md}`; the SHA-256
artifact index is `.legion/project/changes/LEGION-NEXT/implementation/
phase-13/evidence-index.yaml`.

## Captured Sealed v9 Runs

Four sealed v9 dry-run captures are committed under
`docs/next/evidence/P13-T01/runs/v9/`:

- `p13-noop-calibration.v1-dry-run-r1-20260622T153040Z` — calibration
  fixture (R0). Score: 70/95.
- `p13-greenfield-feature.v1-dry-run-r1-20260622T153040Z` — greenfield
  scenario (R2). Score: 70/95.
- `p13-bug-fix.v1-dry-run-r1-20260622T153040Z` — bug-fix scenario (R2).
  Score: 70/95.
- `p13-security-sensitive.v1-dry-run-r1-20260622T153040Z` —
  security-sensitive scenario (R3). Score: 70/95.

All four score 70/95 with `acceptance_behavior = not_scored_by_scaffold`
(intentional for dry-runs). `deterministic_total` caps at 95 to leave
headroom for the judged dimensions and held-out oracle assertions, which
remain out of scope for the deterministic seal.

The `v8` directory under `docs/next/evidence/P13-T01/runs/` is intentionally
empty: P00-T06 v8 baseline execution remains blocked. The `compare`
aggregator surfaces v8 cells as `null` and the Markdown report uses `—`
in place of values, matching the Phase 13 fail-closed contract.

## Phase 13 Starting Point

Proceed to P13-T02 (`t_6712c51d`): Security hardening — threat model
validation, sandbox boundary audit, secret handling review, and evidence
retention policy.

P13-T02 should consume these inputs:

- `scripts/baseline/capture-run.mjs` and `redact-output.mjs` are the
  authoritative secret-redaction path; P13-T02 should extend (not replace)
  the redaction patterns.
- `evals/baseline/fixture-hashes.sha256` is hash-pinned by
  `tests/evals-baseline.test.mjs`; P13-T02 cannot change the canonical hash
  policy without also updating the regression test.
- `security-sensitive.v1` is sealed; P13-T02 must not weaken validation
  to hide secrets (the held-out assertion
  `reconfiguration does not hide command failures` enforces this).
- The Phase 13 fail-closed contract: absent, stale, or drifted evidence
  must not pass as green.

Recommended first checks for P13-T02:

1. Read this handoff, `docs/next/evidence/P13-T01/integration-report.yaml`,
   `scripts/baseline/redact-output.mjs`, `evals/fixtures/evaluator/
   security-sensitive/assertions.yaml`, and `tests/evals-baseline.test.mjs`
   before editing.
2. Treat missing held-out assertion coverage as a fail-closed diagnostic
   rather than green release evidence.
3. Keep security hardening in the eval/test harness layers (scripts/baseline/
   + @legion/cli evals subcommand) rather than introducing host-specific
   secrets into @legion/core or @legion/board.
4. Preserve user artifacts and legacy bytes during eval dry-runs; the
   redaction step must mask secrets without dropping the failure context.
