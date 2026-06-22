# V8 Measurement Harness

## Status

Accepted for P00-T05 review on 2026-06-19.

## Purpose

The P00-T05 harness captures comparable v8 run evidence without changing v8 prompts, commands, skills, adapters, personas, or default user-visible behavior. Full baseline execution remains P00-T06.

## Harness Files

- Runner: `scripts/baseline/capture-run.ps1`
- Grader: `scripts/baseline/grade-run.ps1`
- Redactor: `scripts/baseline/redact-output.ps1`
- Usage notes: `scripts/baseline/README.md`
- Manifest schema: `evals/baseline/schema/manifest.schema.json`
- Oracle assertions schema: `evals/baseline/schema/oracle-assertions.schema.json`
- Run manifest schema: `evals/baseline/schema/run-manifest.schema.json`
- Scenario schema: `evals/baseline/schema/scenario.schema.json`
- Score schema: `evals/baseline/schema/score.schema.json`
- Run template: `evals/baseline/run-manifest-template.yaml`

## Required Interface

```powershell
pwsh -File scripts/baseline/capture-run.ps1 `
  -Scenario bug-fix `
  -Host codex-cli `
  -Repeat 1 `
  -Model unavailable `
  -Output docs/next/evidence/P00-T05/calibration-runs `
  -DryRun
```

PowerShell parameters map to the required `--scenario`, `--host`, `--repeat`, and `--output` interface. `-DryRun` creates a sealed calibration manifest without invoking v8. P00-T06 must omit `-DryRun` and provide approved host invocation details through `-CommandLine`.

## Captured Evidence

Each run directory contains `run-manifest.json`, `transcript.redacted.log`, `fixture-hashes.sha256`, `git-before.txt`, `git-after.txt`, and `score.json` after grading.

## Redaction And Retention

Raw private reasoning is not captured by default. Transcripts are redacted before retention. Secret canaries, OpenAI-style API keys, bearer tokens, and common credential assignments are masked before transcripts are committed as evidence. Fixture hashes are canonicalized as lowercase SHA-256 digests over LF-normalized UTF-8 text with POSIX-relative paths.

## Non-Goals

This harness does not publish baseline metrics, aggregate v8 results, or claim v9 improvement. Those are P00-T06 and later responsibilities.
