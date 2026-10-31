# SSH tunnel to the MacBook, reconnecting forever. Forwards only to the MacBook's loopback:
#   127.0.0.1:25567 -> offline bot proxy    127.0.0.1:25580 -> server-state mirror
# Nothing here listens on the LAN (ssh -L binds 127.0.0.1 by default).
param([string]$MacHost = 'hussain@10.0.0.151')

$Log = Join-Path (Split-Path $PSScriptRoot -Parent) 'agent-swarm\logs\tunnel.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

while ($true) {
    Add-Content $Log "$(Get-Date -Format s) connecting to $MacHost"
    & ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
        -L 127.0.0.1:25567:127.0.0.1:25567 -L 127.0.0.1:25580:127.0.0.1:25580 $MacHost 2>&1 |
        ForEach-Object { Add-Content $Log "$(Get-Date -Format s) $_" }
    Add-Content $Log "$(Get-Date -Format s) tunnel exited ($LASTEXITCODE); retrying in 5 s"
    Start-Sleep -Seconds 5
}
