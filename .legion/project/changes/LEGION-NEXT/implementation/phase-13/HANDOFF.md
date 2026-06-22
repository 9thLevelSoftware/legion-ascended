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

## Delivered Surface — P13-T02

### Threat-model validator

- `scripts/baseline/sandbox-guard.mjs` — fail-closed boundary + redaction
  completeness check. Confirms the run directory is contained in
  `--output-root`, `manifest.baseline_commit` is a 40-char hex SHA, every
  manifest artifact resolves inside the run directory and contains no `..`
  segments, `transcript.raw.log` is absent after redaction, and the
  redacted transcript does not contain `LEGION_SECRET_CANARY_*`. Honours
  `--repository-root` so CLI e2e workspaces resolve correctly.
- `scripts/baseline/retention-audit.mjs` — fail-closed retention policy
  audit. Confirms the retained artifacts (run-manifest.json,
  score.json, transcript.redacted.log, git-before.txt, git-after.txt,
  fixture-hashes.sha256) are present on disk, the discarded artifacts
  (transcript.raw.log, evals/fixtures/evaluator/**) are absent, the
  manifest is in a gradeable terminal state, every fixture-hash digest
  is recomputable from the on-disk bytes, and held-out material never
  leaks into the run directory. Honours `--repository-root`.
- `scripts/baseline/threat-model.mjs` — orchestrator. Composes the two
  helper scripts as subprocesses plus an in-process redaction scan
  (canary, bearer, credential-assignment, context-preservation check).
  Emits a single JSON verdict with per-source findings. Non-zero exit
  when any subcheck fails.

### CLI surface

- `packages/cli/src/commands/evals/index.ts` — added `legion next evals
  threat-model` subcommand. The CLI parses the JSON verdict from
  threat-model.mjs regardless of exit code so structured findings surface
  to CI gates (the legacy `evals_helper_failed` diagnostic is suppressed
  in favour of the threat-model verdict). The runScript path resolver
  recognises the new `threat-model.mjs` alongside the existing capture/
  grade/compare helpers. Subcommand requires `--run-dir` and
  `--output-root`; accepts `--report <path>` for the JSON verdict.

### Re-graded capture

- `scripts/baseline/capture-run.mjs` — auto-grades every sealed run so
  `score.json` is on disk before the threat-model validator inspects
  the run directory. The deterministic dimensions depend only on the
  manifest + artifacts, so grading in process keeps the round-trip
  hermetic.

### Re-graded redaction

- `scripts/baseline/redact-output.mjs` — extended with six new detectors
  (URL credentials, JWT tokens, PEM-encoded private keys, multiline
  bearer tokens, JSON-embedded secrets, per-detector audit counts). The
  held-out contract `redaction does not hide command failures` is
  preserved by always keeping the surrounding context (line, prefix,
  failure indicator) visible.

### Tests

- `tests/evals-baseline.test.mjs` — extended with a 6th test that pins
  the security-sensitive.v1 held-out contract. The test asserts the
  three critical assertions (canaries redacted, redaction does not
  hide failures, no credential-like value committed) and the calibration
  known_bad phrase are still sealed in the evaluator material.
- `tests/evals-redaction.test.mjs` — 4 regression tests pinning the
  redaction contract: detector coverage, idempotence, failure-context
  preservation, and audit log contents.
- `tests/evals-sandbox.test.mjs` — 7 regression tests covering
  sandbox-guard + retention-audit (well-formed + 4 sandbox + 2
  retention failure modes).
- `tests/evals-threat-model.test.mjs` — 3 regression tests covering the
  orchestrator (well-formed + 2 fail-closed modes).
- `apps/cli-e2e/test/cli-e2e.test.mjs` — 4 CLI e2e tests for the new
  threat-model subcommand.

### Threat model document

- `docs/next/baseline/SECURITY-MODEL.md` — canonical threat model
  enumerating trust boundaries, attackers, mitigations, the held-out
  security-sensitive.v1 contract, the retention policy (retained vs
  discarded), and the fail-closed verdict surface (every finding code
  documented with its source and meaning).

## Verification Evidence

- `node --test tests/evals-baseline.test.mjs` — PASS, 6/6 tests.
- `node --test tests/evals-redaction.test.mjs` — PASS, 4/4 tests.
- `node --test tests/evals-sandbox.test.mjs` — PASS, 7/7 tests.
- `node --test tests/evals-threat-model.test.mjs` — PASS, 3/3 tests.
- `pnpm --filter @legion/cli-e2e test` — PASS, 29/29 tests (was 21
  before P13-T01; +4 P13-T01 evals tests +4 P13-T02 threat-model tests).
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 113/113 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 171/171 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS across root and recursive workspace packages.
- `pnpm run validate:next` — PASS, package boundaries, worker bundles,
  runtime scans, schemas, tests, npm/pnpm pack all green.

Full closeout transcripts are under `docs/next/evidence/P13-T02/`. The
structured report is `docs/next/evidence/P13-T02/integration-report.yaml`;
the positive verdict is `docs/next/evidence/P13-T02/threat-model.json`;
the negative (tampered) verdict is
`docs/next/evidence/P13-T02/negative/threat-model.json`.

## Captured Sealed Runs

One sealed v9 dry-run + one tampered-run fixture are committed under
`docs/next/evidence/P13-T02/`:

- `runs/v9/p13-security-sensitive.v1-codex-cli-r1-20260622T163335Z` —
  sealed dry-run for security-sensitive; threat-model verdict:
  **verified** (sandbox + retention + redaction all pass; 0 findings).
- `negative/tampered-run` — copy of the sealed run with a
  `LEGION_SECRET_CANARY_LEAKED_AAAA_BBBB` line appended to
  `transcript.redacted.log`; threat-model verdict: **violation**
  (sandbox: `canary_present_in_redacted_transcript`; redaction:
  `canary_present_after_redaction`).

The four P13-T01 sealed v9 dry-run captures also pass the P13-T02
threat-model validator — confirming that the hardened contract is
backwards-compatible with P13-T01 evidence.

## Phase 13 Starting Point

Proceed to P13-T03 (GA decision). The threat-model validator should be
the highest-level fail-closed gate for Phase 13 acceptance. P13-T03
should consume these inputs:

- `legion next evals threat-model` composes sandbox-guard +
  retention-audit + in-process redaction scan into a single JSON
  verdict; treat non-zero exit as a hard fail in CI.
- `capture-run.mjs` auto-grades so every sealed run carries a fresh
  `score.json`; the held-out `security-sensitive.v1` contract is
  pinned by `tests/evals-baseline.test.mjs`.
- `P00-T06` v8 baseline execution remains blocked. The threat-model
  validator does not gate v8 — it gates the v9 evidence. P13-T03 may
  decide to ship v9 evidence without v8 if P00-T06 cannot be unblocked.
- The Phase 13 fail-closed contract: absent, stale, or drifted
  evidence must not pass as green.

Recommended first checks for P13-T03:

1. Read this handoff, `docs/next/evidence/P13-T02/integration-report.yaml`,
   `docs/next/baseline/SECURITY-MODEL.md`, and
   `scripts/baseline/threat-model.mjs` before editing.
2. Treat a non-zero `legion next evals threat-model` exit code as a
   hard fail. Do not weaken the contract to accommodate stale evidence.
3. Keep GA gating in the eval/test harness layers (scripts/baseline/ +
   @legion/cli evals subcommand) rather than introducing host-specific
   release criteria into @legion/core or @legion/board.
4. Preserve user artifacts and legacy bytes during eval dry-runs; the
   redaction step must mask secrets without dropping the failure
   context.

## Delivered Surface — P13-T03

### Fail-closed GA gates

- `scripts/release/release-checklist.mjs` — fail-closed verifier that
  confirms ten preconditions for the v9 GA promotion:
  CHANGELOG entry, the four companion documents under
  `docs/next/ga/` cross-linked from `RELEASE-RECORD.md`, the Phase 13
  ledger state (P13-T01 / P13-T02 / P13-T03 all DONE), the P13-T02
  threat-model verdict, the P13-T01 A/B comparison, and the
  `validate-next` log. Emits a stable JSON verdict; non-zero exit on
  any precondition. Honours `--repository-root` and `--report`.
- `scripts/release/rollback-policy.mjs` — backup-manifest verifier
  that confirms the most recent apply step is restorable. Re-hashes
  the backup directory (matching `@legion/legacy-bridge`'s `hashTree`
  format: sorted POSIX paths, sha256 `path\0bytes\0`), rejects
  schema drift, missing fields, repositoryRoot mismatch, missing
  backup directory, and manifests older than 365 days. Honours
  `--repository-root` and `--source` for cross-source rejection.
  Emits a stable JSON verdict with per-source findings; non-zero exit
  when any fail-closed check fires.

### CLI surface

- `packages/cli/src/commands/release/index.ts` — `legion next release
  {checklist,rollback-verify}` adapter. The CLI parses the JSON
  verdict regardless of exit code so structured findings surface to
  CI gates. The `runScript` path resolver recognises the two new
  helpers alongside the existing capture/grade/compare/threat-model
  helpers.
- `packages/cli/src/index.ts` — root CLI dispatch advertises the new
  `release` command alongside `project`, `change`, `board`,
  `migrate`, and `evals`.

### GA decision package

- `docs/next/ga/RELEASE-RECORD.md` — consolidated GA decision
  package pointing at every companion document, the fail-closed gates,
  the implementation evidence, and the preserved-boundary contract.
- `docs/next/ga/MIGRATION-POLICY.md` — operator-facing v8 → v9
  migration policy. Pins the `--from-<source>` / `--verify|
  --dry-run|--apply|--rollback` matrix, the source class preservation
  rules, the review gates, and the operator runbook.
- `docs/next/ga/ROLLBACK-POLICY.md` — rollback policy and procedure.
  Pins the backup-manifest contract (`schemaVersion: "0.1.0"`, kind
  in `{codex-legion-migration-backup, planning-import-backup}`,
  pre-migration hash, repositoryRoot match), the rollback procedure,
  and the cross-source rejection rule.
- `docs/next/ga/V8-HANDOFF.md` — v8 / v9 coexistence rules. Pins
  the v8 maintenance branch policy, the deprecation timeline
  (v9 GA → +90d v9.1 → +180d sunset notice → +270d v8 final → +365d
  EOL), and the rollback triggers.
- `docs/next/ga/STABLE-CHANNEL-APPROVAL.md` — sign-off gate. Pins the
  decision owner (`dasbl`) sign-off block, the approval routing
  matrix, and the post-approval actions.

### Tests

- `tests/release-checklist.test.mjs` — 15 regression tests pinning
  every fail-closed path (well-formed, CHANGELOG entry / keyword,
  release-record link, missing companion docs, ledger task state,
  threat-model verdict, ab-comparison, validate-next log, semver
  validation).
- `tests/rollback-policy.test.mjs` — 13 regression tests pinning
  every fail-closed path (well-formed codex / planning manifests,
  schema drift, unknown kind, source mismatch, missing fields,
  repositoryRoot mismatch, backupPath missing, hash drift, manifest
  age, well-formed checks map).
- `apps/cli-e2e/test/cli-e2e.test.mjs` — 6 CLI e2e tests for the
  new release subcommands (checklist-blocked, per-check breakdown,
  rollback-verify-blocked, rollback-verify-restorable, missing
  --release-version, missing --backup-manifest).

## Verification Evidence

- `node --test tests/release-checklist.test.mjs` — PASS, 15/15 tests.
- `node --test tests/rollback-policy.test.mjs` — PASS, 13/13 tests.
- `pnpm --filter @legion/cli-e2e test` — PASS, 35/35 tests (was 29
  before P13-T03; +6 P13-T03 release CLI tests added).
- `pnpm --filter @legion/core test` — PASS, 245/245 tests.
- `pnpm --filter @legion/board test` — PASS, 113/113 tests.
- `pnpm --filter @legion/store-sqlite test` — PASS, 171/171 tests.
- `pnpm --filter @legion/protocol test` — PASS, 55/55 tests.
- `pnpm --filter @legion/artifacts test` — PASS, 59/59 tests.
- `pnpm run typecheck` — PASS across 10 workspace projects.
- `pnpm run test` — PASS, 143/143 root tests (was 115 before P13-T03;
  +13 P13-T03 rollback-policy + 15 P13-T03 release-checklist = 28 new
  root tests).
- `pnpm run validate:next` — PASS, package boundaries, worker bundles,
  runtime scans, schemas, tests, npm/pnpm pack all green.
- `node scripts/release/release-checklist.mjs --release-version 9.0.0`
  — PASS, status: ready (zero findings) against the canonical v9 GA
  evidence under docs/next/ga/.
- `node scripts/release/rollback-policy.mjs --backup-manifest <path>`
  — PASS, status: restorable against a synthetic well-formed codex
  backup-manifest produced during CLI e2e.

Full closeout transcripts are under `docs/next/evidence/P13-T03/`.
The structured report is
`docs/next/evidence/P13-T03/integration-report.yaml`; the release
verdict is `docs/next/evidence/P13-T03/release-checklist.json`; the
rollback verifier smoke-test verdict is
`docs/next/evidence/P13-T03/rollback-policy.json`. The SHA-256
artifact index is
`.legion/project/changes/LEGION-NEXT/implementation/phase-13/evidence-index.yaml`.

## Captured Sealed Evidence

The P13-T03 evidence directory captures the gate transcripts plus
two verifier JSON outputs:

- `docs/next/evidence/P13-T03/release-checklist.json` — the
  P13-T03 release checklist verdict against the canonical v9 GA
  evidence (status: ready, zero findings).
- `docs/next/evidence/P13-T03/rollback-policy.json` — the
  P13-T03 rollback-policy verifier verdict against a synthetic
  well-formed codex backup-manifest (status: restorable, zero
  blocking findings).
- `docs/next/evidence/P13-T03/typecheck.log` — `pnpm run typecheck`
  transcript: 10 workspace projects typecheck clean.
- `docs/next/evidence/P13-T03/validate-next.log` — `pnpm run
  validate:next` transcript: PASS (boundaries, worker bundles,
  runtime scans, schemas, tests, npm/pnpm pack all green).
- `docs/next/evidence/P13-T03/workspace-tests.log` — `pnpm run test`
  transcript: 143/143 root tests pass (28 new P13-T03 tests).
- `docs/next/evidence/P13-T03/cli-e2e-test.log` — `@legion/cli-e2e`
  transcript: 35/35 pass (6 new P13-T03 release CLI tests).
- `docs/next/evidence/P13-T03/{core,board,protocol,store-sqlite,
  artifacts}-test.log` — per-package test transcripts.
- `docs/next/evidence/P13-T03/gitleaks-p13-t03-diff.log` — final P13-T03
  diff gitleaks scan.

## Phase 13 Starting Point

Proceed to P13-T04 (`t_50860be4`): GA closeout / independent review.
P13-T04 should consume these inputs:

- `legion next release checklist` composes ten preconditions into a
  single JSON verdict; treat non-zero exit as a hard fail in CI.
- `legion next release rollback-verify` confirms the most recent
  apply step is restorable; treat non-zero exit as a hard fail.
- `legion next evals threat-model` continues to gate v9 evidence;
  the held-out security-sensitive.v1 contract is pinned by
  tests/evals-baseline.test.mjs.
- P00-T06 v8 baseline execution remains blocked. The release
  checklist does not gate v8 — it gates the v9 evidence. The GA
  promotion is approved with full visibility into the absent v8
  evidence (`docs/next/ga/RELEASE-RECORD.md` outstanding-items list).

Recommended first checks for P13-T04:

1. Read this handoff,
   `docs/next/evidence/P13-T03/integration-report.yaml`,
   `docs/next/ga/RELEASE-RECORD.md`, and
   `docs/next/evidence/P13-T03/release-checklist.json` before editing.
2. Treat a non-zero `legion next release checklist` exit code as a
   hard fail. Do not weaken the contract to accommodate stale GA
   evidence.
3. Independent review must be actor-separated from implementation
   (P12-T03 / P11-T03 established the rule); record the review in
   `docs/next/reviews/PHASE-13-INDEPENDENT-REVIEW.md`.
4. Do not move GA gating into `@legion/core` or `@legion/board`; the
   release checklist and rollback verifier are operator-facing
   governance gates, not core workflow logic.
