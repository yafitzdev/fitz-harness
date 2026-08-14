param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")))
$ErrorActionPreference = "Stop"
$version = "2026.7.0"
$expectedSha256 = "b11ee950a12b15604e6b0a0f30a226516adc7aec75de2e3c642b28e50ddef9ea"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$destinationDirectory = Join-Path $resolvedRoot "release\cloudflared"
$destination = Join-Path $destinationDirectory "cloudflared.exe"
$licenseDestination = Join-Path $destinationDirectory "LICENSE-cloudflared.txt"
$expectedParent = Join-Path $resolvedRoot "release"
if (-not $destination.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe cloudflared package target" }
function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}
function Ensure-CloudflaredLicense {
  if (-not (Test-Path -LiteralPath $licenseDestination -PathType Leaf)) {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cloudflare/cloudflared/$version/LICENSE" -OutFile $licenseDestination -UseBasicParsing
  }
}
New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
if (Test-Path -LiteralPath $destination -PathType Leaf) {
  $existingHash = Get-Sha256 $destination
  if ($existingHash -eq $expectedSha256) { Ensure-CloudflaredLicense; Write-Output $destination; exit 0 }
  Remove-Item -LiteralPath $destination -Force
}
$temporary = Join-Path $destinationDirectory "cloudflared.download"
if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
$url = "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe"
try {
  Invoke-WebRequest -Uri $url -OutFile $temporary -UseBasicParsing
  $actualHash = Get-Sha256 $temporary
  if ($actualHash -ne $expectedSha256) { throw "cloudflared checksum mismatch: expected $expectedSha256, received $actualHash" }
  Move-Item -LiteralPath $temporary -Destination $destination
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Ensure-CloudflaredLicense
Write-Output $destination
