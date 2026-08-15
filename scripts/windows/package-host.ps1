param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")))
$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$releaseRoot = Join-Path $resolvedRoot "release"
$stage = Join-Path $releaseRoot "host"
$archive = Join-Path $releaseRoot "Fitz-Codex-Host-win-x64.zip"
$desktopArchive = Join-Path $releaseRoot "Fitz-Codex-Host.asar"
$expectedParent = (Join-Path $resolvedRoot "release")
if (-not $stage.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe host package target" }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$legacyRelease = Join-Path $resolvedRoot "apps\host\release"
if (Test-Path -LiteralPath $legacyRelease) { Remove-Item -LiteralPath $legacyRelease -Recurse -Force }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Push-Location $resolvedRoot
try {
  # Release staging must never trust incremental build metadata: a stale .d.ts
  # can otherwise let mutually incompatible workspace packages ship together.
  pnpm exec tsc -b --force --pretty false
  if ($LASTEXITCODE -ne 0) { throw "Host build failed" }
  # Hoisted deployment contains real directories rather than pnpm junctions,
  # allowing Electron's ASAR resolver to load every dependency from one file.
  pnpm --config.node-linker=hoisted --filter @fitz/host deploy --prod $stage
  if ($LASTEXITCODE -ne 0) { throw "Host deployment failed" }
} finally { Pop-Location }
foreach ($generatedPath in @((Join-Path $stage "src"), (Join-Path $stage "release"))) { if (Test-Path -LiteralPath $generatedPath) { Remove-Item -LiteralPath $generatedPath -Recurse -Force } }
# Chat attachment parsing deliberately disables OCR. Keep the lightweight
# tesseract.js loader required by officeparser's module graph, but omit its
# unused 40+ MiB OCR core payload from the staged host.
foreach ($unusedOcrPackage in @("tesseract.js-core")) {
  $unusedOcrPath = Join-Path $stage ("node_modules\" + $unusedOcrPackage)
  if (Test-Path -LiteralPath $unusedOcrPath) {
    $resolvedUnusedOcrPath = (Resolve-Path -LiteralPath $unusedOcrPath).Path
    if (-not $resolvedUnusedOcrPath.StartsWith($stage, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe OCR package cleanup target" }
    Remove-Item -LiteralPath $resolvedUnusedOcrPath -Recurse -Force
  }
}
New-Item -ItemType Directory -Path (Join-Path $stage "runtime") -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node -ErrorAction Stop).Source -Destination (Join-Path $stage "runtime\node.exe")
Copy-Item -LiteralPath (Join-Path $resolvedRoot "scripts\windows\host-package-start.ps1") -Destination (Join-Path $stage "start-host.ps1")
Push-Location $resolvedRoot
try {
  node scripts/smoke-packaged-host.mjs
  if ($LASTEXITCODE -ne 0) { throw "Packaged host smoke test failed" }
} finally { Pop-Location }
$asarPackage = Get-ChildItem -LiteralPath (Join-Path $resolvedRoot "node_modules\.pnpm") -Directory -Filter "@electron+asar@*" | Select-Object -First 1
if ($null -eq $asarPackage) { throw "@electron/asar package was not found" }
$asarModule = Join-Path $asarPackage.FullName "node_modules\@electron\asar\lib\asar.js"
if (-not (Test-Path -LiteralPath $asarModule -PathType Leaf)) { throw "@electron/asar module was not found" }
Push-Location $resolvedRoot
try {
  node scripts/package-host-asar.mjs $stage $desktopArchive $asarModule
  if ($LASTEXITCODE -ne 0) { throw "Desktop host archive creation failed" }
} finally { Pop-Location }
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
$installerPackage = Get-ChildItem -LiteralPath (Join-Path $resolvedRoot "node_modules\.pnpm") -Directory -Filter "electron-winstaller@*" | Select-Object -First 1
if ($null -eq $installerPackage) { throw "electron-winstaller package was not found" }
$sevenZip = Join-Path $installerPackage.FullName "node_modules\electron-winstaller\vendor\7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw "7-Zip executable was not found" }
& $sevenZip a -tzip -mx=5 $archive (Join-Path $stage "*") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Host archive creation failed" }
Write-Output $archive
