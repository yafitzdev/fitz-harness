param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")))
$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$releaseRoot = Join-Path $resolvedRoot "release"
$stage = Join-Path $releaseRoot "host"
$archive = Join-Path $releaseRoot "Fitz-Codex-Host-win-x64.zip"
$expectedParent = (Join-Path $resolvedRoot "release")
if (-not $stage.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe host package target" }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$legacyRelease = Join-Path $resolvedRoot "apps\host\release"
if (Test-Path -LiteralPath $legacyRelease) { Remove-Item -LiteralPath $legacyRelease -Recurse -Force }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Push-Location $resolvedRoot
try {
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Host build failed" }
  pnpm --filter @fitz/host deploy --prod $stage
  if ($LASTEXITCODE -ne 0) { throw "Host deployment failed" }
} finally { Pop-Location }
foreach ($generatedPath in @((Join-Path $stage "src"), (Join-Path $stage "release"))) { if (Test-Path -LiteralPath $generatedPath) { Remove-Item -LiteralPath $generatedPath -Recurse -Force } }
New-Item -ItemType Directory -Path (Join-Path $stage "runtime") -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node -ErrorAction Stop).Source -Destination (Join-Path $stage "runtime\node.exe")
Copy-Item -LiteralPath (Join-Path $resolvedRoot "scripts\windows\host-package-start.ps1") -Destination (Join-Path $stage "start-host.ps1")
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
$installerPackage = Get-ChildItem -LiteralPath (Join-Path $resolvedRoot "node_modules\.pnpm") -Directory -Filter "electron-winstaller@*" | Select-Object -First 1
if ($null -eq $installerPackage) { throw "electron-winstaller package was not found" }
$sevenZip = Join-Path $installerPackage.FullName "node_modules\electron-winstaller\vendor\7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw "7-Zip executable was not found" }
& $sevenZip a -tzip -mx=5 $archive (Join-Path $stage "*") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Host archive creation failed" }
Write-Output $archive
