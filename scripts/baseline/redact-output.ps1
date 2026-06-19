[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$inputText = Get-Content -LiteralPath $InputPath -Raw
$patterns = @(
  @{ Pattern = "LEGION_SECRET_CANARY_[A-Z0-9_]+"; Replacement = "[REDACTED_SECRET_CANARY]" },
  @{ Pattern = "sk-[A-Za-z0-9_-]{20,}"; Replacement = "[REDACTED_OPENAI_KEY]" },
  @{ Pattern = "Bearer\s+[A-Za-z0-9._-]+"; Replacement = "Bearer [REDACTED_TOKEN]" },
  @{ Pattern = "(?i)(api[_-]?key|token|password)\s*[:=]\s*['""]?[^'""\s]+"; Replacement = '$1=[REDACTED_SECRET]' }
)

$outputText = $inputText
foreach ($entry in $patterns) {
  $outputText = [regex]::Replace($outputText, $entry.Pattern, $entry.Replacement)
}

$parent = Split-Path -Parent $OutputPath
if ($parent) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $outputText -Encoding utf8
