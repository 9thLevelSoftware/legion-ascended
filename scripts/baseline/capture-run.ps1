[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [Alias("Host")]
  [string]$HostName,

  [Parameter(Mandatory = $true)]
  [int]$Repeat,

  [Parameter(Mandatory = $true)]
  [string]$Output,

  [string]$Model = "unavailable",
  [string]$Adapter = "v8-command-surface",
  [string]$BaselineCommit = "855e975beec3bac6dc06db598081b6ac11ea8e14",
  [string]$FixtureRoot = "evals/fixtures/public",
  [string]$LegionSource = "C:/Users/dasbl/Documents/legion",
  [string]$CommandLine = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($Repeat -lt 1) {
  throw "Repeat must be 1 or greater."
}

$repoRoot = (Resolve-Path ".").Path
$scenarioName = $Scenario -replace "\.v\d+$", ""
$publicFixture = Join-Path $repoRoot (Join-Path $FixtureRoot $scenarioName)

if (-not (Test-Path -LiteralPath $publicFixture)) {
  throw "Public fixture not found: $publicFixture"
}

$safeScenario = $Scenario -replace "[^A-Za-z0-9_.-]", "-"
$safeHost = $HostName -replace "[^A-Za-z0-9_.-]", "-"
$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$runId = "p00-$safeScenario-$safeHost-r$Repeat-$stamp"
$runDirectory = Join-Path $repoRoot (Join-Path $Output $runId)
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

$workspace = Join-Path $runDirectory "workspace"
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
Copy-Item -LiteralPath $publicFixture -Destination (Join-Path $workspace "public-fixture") -Recurse -Force

$fixtureHashFile = Join-Path $runDirectory "fixture-hashes.sha256"
Get-ChildItem -LiteralPath (Join-Path $workspace "public-fixture") -Recurse -File |
  Sort-Object FullName |
  ForEach-Object {
    $contents = [System.IO.File]::ReadAllText($_.FullName)
    $normalized = $contents.Replace("`r`n", "`n").Replace("`r", "`n")
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $hashBytes = [System.Security.Cryptography.SHA256]::HashData($bytes)
    $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
    $relative = [System.IO.Path]::GetRelativePath($repoRoot, $_.FullName).Replace('\\', '/')
    "$hash  $relative"
  } |
  Set-Content -LiteralPath $fixtureHashFile -Encoding ascii

$gitBefore = Join-Path $runDirectory "git-before.txt"
$gitAfter = Join-Path $runDirectory "git-after.txt"
git status --short --branch 2>&1 | Set-Content -LiteralPath $gitBefore -Encoding ascii

$startedAt = Get-Date -Format o
$events = @()
$events += [ordered]@{ type = "run_started"; at = $startedAt; scenario = $Scenario; dry_run = [bool]$DryRun }

$rawTranscript = Join-Path $runDirectory "transcript.raw.log"
$redactedTranscript = Join-Path $runDirectory "transcript.redacted.log"
$terminalStatus = "dry-run"

if ($DryRun) {
  @(
    "P00-T05 dry-run calibration"
    "Scenario: $Scenario"
    "Host: $HostName"
    "Model: $Model"
    "LEGION_SECRET_CANARY_SHOULD_BE_REDACTED"
  ) | Set-Content -LiteralPath $rawTranscript -Encoding ascii
  $events += [ordered]@{ type = "dry_run_completed"; at = (Get-Date -Format o) }
}
else {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    throw "Non-dry-run capture requires -CommandLine with the approved v8 host invocation."
  }

  $events += [ordered]@{ type = "host_command_started"; at = (Get-Date -Format o); host = $HostName }
  $commandOutput = & pwsh -NoLogo -NoProfile -Command $CommandLine 2>&1
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  $commandOutput | Set-Content -LiteralPath $rawTranscript -Encoding utf8
  $terminalStatus = if ($exitCode -eq 0) { "passed" } else { "failed" }
  $events += [ordered]@{ type = "host_command_completed"; at = (Get-Date -Format o); exit_code = $exitCode }
}

pwsh -NoLogo -NoProfile -File (Join-Path $repoRoot "scripts/baseline/redact-output.ps1") -InputPath $rawTranscript -OutputPath $redactedTranscript
Remove-Item -LiteralPath $rawTranscript -Force

$endedAt = Get-Date -Format o
$events += [ordered]@{ type = "run_completed"; at = $endedAt; terminal_status = $terminalStatus }
git status --short --branch 2>&1 | Set-Content -LiteralPath $gitAfter -Encoding ascii

$manifest = [ordered]@{
  schema_version = 1
  run_id = $runId
  scenario_id = $Scenario
  host = $HostName
  model = $Model
  adapter = $Adapter
  repeat = $Repeat
  baseline_commit = $BaselineCommit
  fixture_hashes = "fixture-hashes.sha256"
  timestamps = [ordered]@{
    started_at = $startedAt
    ended_at = $endedAt
  }
  telemetry = [ordered]@{
    tokens = [ordered]@{ status = "unavailable"; value = $null; reason = "host did not expose telemetry" }
    cost = [ordered]@{ status = "unavailable"; value = $null; reason = "host did not expose telemetry" }
  }
  interventions = @()
  events = $events
  terminal_status = $terminalStatus
  artifacts = [ordered]@{
    transcript = "transcript.redacted.log"
    git_before = "git-before.txt"
    git_after = "git-after.txt"
    score = "score.json"
  }
}

$manifestPath = Join-Path $runDirectory "run-manifest.json"
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$schemaPath = Join-Path $repoRoot "evals/baseline/schema/run-manifest.schema.json"
if (Test-Path -LiteralPath $schemaPath) {
  $schema = Get-Content -LiteralPath $schemaPath -Raw
  $manifestJson = Get-Content -LiteralPath $manifestPath -Raw
  if (-not (Test-Json -Json $manifestJson -Schema $schema)) {
    throw "Run manifest failed schema validation: $manifestPath"
  }
}

Write-Output $runDirectory
