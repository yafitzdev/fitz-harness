param([string]$TaskName = "Fitz Harness Host")
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Output "Scheduled task is not installed: $TaskName"; exit 0 }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed scheduled task: $TaskName"
