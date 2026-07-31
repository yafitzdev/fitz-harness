param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$serverPath = Join-Path $resolvedRoot "apps\host\dist\server.js"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Compiled host not found: $serverPath" }
$environmentPath = Join-Path $resolvedRoot ".env.host"
if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line.Trim().Length -eq 0 -or $line.TrimStart().StartsWith("#")) { continue }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid .env.host entry" }
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}
& $NodePath $serverPath
exit $LASTEXITCODE
