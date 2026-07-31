param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [string]$TaskName = "Fitz Codex Host"
)
$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$runner = (Resolve-Path -LiteralPath (Join-Path $resolvedRoot "scripts\windows\run-host.ps1")).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -RepoRoot `"$resolvedRoot`" -NodePath `"$nodePath`""
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Starts the Fitz Codex host at user logon" -Force | Out-Null
Write-Output "Installed scheduled task: $TaskName"
