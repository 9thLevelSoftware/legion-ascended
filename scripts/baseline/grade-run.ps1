[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RunDirectory
)

$ErrorActionPreference = "Stop"

$resolvedRunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
$manifestPath = Join-Path $resolvedRunDirectory "run-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Run manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$requiredArtifacts = @($manifest.artifacts.transcript, $manifest.artifacts.git_before, $manifest.artifacts.git_after, $manifest.fixture_hashes)
foreach ($artifact in $requiredArtifacts) {
  $path = Join-Path $resolvedRunDirectory $artifact
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required run artifact missing: $path"
  }
}

$isGradeable = $manifest.terminal_status -in @("dry-run", "passed", "failed", "interrupted", "blocked")
$criticalFailure = -not $isGradeable
$artifactTraceability = if ($isGradeable) { 10 } else { 0 }
$deterministicTotal = if ($manifest.terminal_status -eq "dry-run") { $artifactTraceability } else { 0 }

$score = [ordered]@{
  schema_version = 1
  run_id = $manifest.run_id
  scenario_id = $manifest.scenario_id
  deterministic_total = $deterministicTotal
  judged_total = 0
  total = $deterministicTotal
  terminal_status = $manifest.terminal_status
  critical_failure = $criticalFailure
  dimensions = [ordered]@{
    build_integrity = "not_scored_by_scaffold"
    acceptance_behavior = "not_scored_by_scaffold"
    regression_control = "not_scored_by_scaffold"
    scope_discipline = "not_scored_by_scaffold"
    recovery_behavior = "not_scored_by_scaffold"
    duplicate_work_control = "not_scored_by_scaffold"
    artifact_traceability = $artifactTraceability
    maintainability = "judge_not_run"
    requirement_fidelity = "judge_not_run"
  }
}

$scorePath = Join-Path $resolvedRunDirectory "score.json"
$score | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $scorePath -Encoding utf8

$schemaPath = Join-Path (Resolve-Path ".").Path "evals/baseline/schema/score.schema.json"
if (Test-Path -LiteralPath $schemaPath) {
  $schema = Get-Content -LiteralPath $schemaPath -Raw
  $scoreJson = Get-Content -LiteralPath $scorePath -Raw
  if (-not (Test-Json -Json $scoreJson -Schema $schema)) {
    throw "Score failed schema validation: $scorePath"
  }
}

Write-Output $scorePath
