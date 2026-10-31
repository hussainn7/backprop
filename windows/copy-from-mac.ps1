# One-time (or re-sync) copy of the agents' state from the MacBook, then point .env at the tunnel.
# Copies agent-swarm/.env, memory-*.json and logs/api-usage.json. Run only while NO agents
# instance is running anywhere, or the memory files may be mid-write.
param([string]$MacHost = 'hussain@10.0.0.151', [string]$Remote = 'minecraft-server/agent-swarm')
$ErrorActionPreference = 'Stop'
$Swarm = Join-Path (Split-Path $PSScriptRoot -Parent) 'agent-swarm'
New-Item -ItemType Directory -Force (Join-Path $Swarm 'logs') | Out-Null

scp -o BatchMode=yes "${MacHost}:$Remote/.env" "${MacHost}:$Remote/memory-*.json" "$Swarm\"
if ($LASTEXITCODE) { throw 'scp of .env / memory files failed' }
scp -o BatchMode=yes "${MacHost}:$Remote/logs/api-usage.json" "$Swarm\logs\"
if ($LASTEXITCODE) { throw 'scp of logs/api-usage.json failed' }

# Remote-mode settings: bots reach the offline proxy and the mirror through the tunnel.
$set = [ordered]@{
    MC_HOST            = '127.0.0.1'
    MC_PORT            = '25567'
    SERVER_MIRROR_URL  = 'http://127.0.0.1:25580/state'
    PATHFINDER_TICK_MS = '20'
}
$envFile = Join-Path $Swarm '.env'
$lines = [Collections.Generic.List[string]](Get-Content $envFile)
foreach ($k in $set.Keys) {
    $i = $lines.FindIndex({ param($l) $l -match "^$k=" })
    if ($i -ge 0) { $lines[$i] = "$k=$($set[$k])" } else { $lines.Add("$k=$($set[$k])") }
}
[IO.File]::WriteAllText($envFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))

# Secrets never belong in .env; report names only.
$bad = $lines | Where-Object { $_ -match '^(ANTHROPIC_API_KEY|RCON_PASSWORD|OPENAI_API_KEY)=.+' } | ForEach-Object { ($_ -split '=')[0] }
if ($bad) { Write-Warning "Remove these from agent-swarm\.env (put the key in config\secrets.env): $($bad -join ', ')" }
Write-Host "Copied state from $MacHost and set remote-mode settings in $envFile"
