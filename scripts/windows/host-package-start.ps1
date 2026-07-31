$ErrorActionPreference = "Stop"
$packageRoot = $PSScriptRoot
$environmentPath = Join-Path $packageRoot ".env.host"
if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line.Trim().Length -eq 0 -or $line.TrimStart().StartsWith("#")) { continue }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid .env.host entry" }
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}
& (Join-Path $packageRoot "runtime\node.exe") (Join-Path $packageRoot "dist\server.js")
exit $LASTEXITCODE
