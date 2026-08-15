$ErrorActionPreference = "Stop"
$resourcesRoot = $PSScriptRoot
$desktopExecutable = Join-Path (Split-Path -Parent $resourcesRoot) "Fitz Codex.exe"
$serverPath = Join-Path $resourcesRoot "host.asar\dist\server.js"

if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
  throw "Fitz Codex executable not found: $desktopExecutable"
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "Bundled Fitz host not found: $serverPath"
}

[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1", "Process")
[Environment]::SetEnvironmentVariable("FITZ_STARTUP_LAUNCHER", $PSCommandPath, "Process")
& $desktopExecutable $serverPath
exit $LASTEXITCODE
