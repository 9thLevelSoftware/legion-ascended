# V8 Results

## Status

BLOCKED for P00-T06 on 2026-06-19.

## Baseline Identity

- v8 tag: v8-baseline-20260619
- v8 commit: 855e975beec3bac6dc06db598081b6ac11ea8e14
- corpus manifest: evals/baseline/manifest.yaml
- fixture hash file: evals/baseline/fixture-hashes.sha256

## Blockers

1. No approved P00-T06 run matrix of host, model, repeat count, timeout, intervention policy, and cost policy exists in accepted artifacts.
2. The v8 Codex adapter documents -p as the prompt flag, but installed Codex 0.135.0 uses -p for profile and requires codex exec [PROMPT] or stdin.
3. Live execution of the eight-scenario baseline would consume external model/runtime resources without decision-owner approval.

## Verification

- codex --version: codex-cli 0.135.0
- codex exec --help: inspected non-interactive prompt interface.
- git rev-parse v8-baseline-20260619: 855e975beec3bac6dc06db598081b6ac11ea8e14
- Repository search found no approved P00-T06 run matrix.

## Required Decision

Approve the run matrix and host command line for P00-T06, or revise the harness policy before attempting production baseline runs.
