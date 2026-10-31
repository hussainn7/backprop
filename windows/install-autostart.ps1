# Start the agents (tunnel + swarm) hidden at login via Task Scheduler.
#   .\install-autostart.ps1            install / update
#   .\install-autostart.ps1 -Remove    uninstall
param([switch]$Remove)
$Name = 'BackpropAgents'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task $Name."
    exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'start-agents.ps1')`"")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Backprop Minecraft agents: SSH tunnel to the MacBook + agent swarm' -Force | Out-Null
Write-Host "Installed scheduled task $Name (runs at logon). Start now: Start-ScheduledTask $Name"
