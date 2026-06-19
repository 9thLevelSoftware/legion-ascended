# Baseline Harness Scripts

These scripts are dependency-free PowerShell scaffolds for P00-T05 and P00-T06.

## Capture

```powershell
pwsh -File scripts/baseline/capture-run.ps1 `
  -Scenario bug-fix `
  -Host codex-cli `
  -Repeat 1 `
  -Model unavailable `
  -Output docs/next/evidence/P00-T05/calibration-runs `
  -DryRun
```

For production P00-T06 runs, omit `-DryRun` and provide `-CommandLine` with the approved v8 host invocation. The command is executed from the repository root and its output is written to the run transcript.

## Grade

```powershell
pwsh -File scripts/baseline/grade-run.ps1 -RunDirectory docs/next/evidence/P00-T05/calibration-runs/<run-id>
```

The grader records deterministic scaffold scores and validates the score JSON shape. Full hidden-assertion execution is a P00-T06 responsibility after run artifacts are sealed.

## Redact

```powershell
pwsh -File scripts/baseline/redact-output.ps1 -InputPath raw.log -OutputPath transcript.redacted.log
```

The redactor masks configured secret canaries, OpenAI-style API keys, bearer tokens, and common credential assignments.
