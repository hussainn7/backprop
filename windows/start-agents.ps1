# Run the Backprop agents on this PC against the MacBook's server.
# Opens the SSH tunnel, waits until the MacBook's own mc-agents is stopped (never two
# instances: they would double-login the bots and corrupt memory files), then runs the
# swarm, restarting it if it exits. Ctrl+C stops the agents and the tunnel.
param([string]$MacHost = 'hussain@10.0.0.151')
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$Swarm = Join-Path $Root 'agent-swarm'
$Log = Join-Path $Swarm 'logs\agents.log'
$Mirror = 'http://127.0.0.1:25580/state'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Global\BackpropAgents')
if (-not $mutex.WaitOne(0)) { Write-Host 'Backprop agents are already running on this PC.'; exit 1 }

function Say($msg) { $line = "$(Get-Date -Format s) [start-agents] $msg"; Write-Host $line; Add-Content $Log $line }

# A tunnel left over from a crashed run would hold the ports; replace it.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='ssh.exe'" |
    Where-Object { $_.CommandLine -match 'tunnel\.ps1|25580:127\.0\.0\.1:25580' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$tunnel = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'tunnel.ps1'), '-MacHost', $MacHost)
Say "tunnel started (pid $($tunnel.Id))"

# True once the mirror answers and says the MacBook's agents are offline. Each call is
# also a check-in, which makes the MacBook stop its failover agents.
function MacbookAgentsStopped {
    try {
        $s = Invoke-RestMethod $Mirror -Headers @{ 'X-Agents-Host' = $env:COMPUTERNAME } -TimeoutSec 10
        return -not $s.serverHostAgentsActive
    } catch { return $false }
}

try {
    while ($true) {
        $waited = 0
        while (-not (MacbookAgentsStopped)) {
            if ($waited % 60 -eq 0) { Say 'waiting for the tunnel / for the MacBook mc-agents to stop...' }
            Start-Sleep -Seconds 5; $waited += 5
        }
        Say 'starting agents'
        Push-Location $Swarm
        try {
            cmd /c "node --max-old-space-size=4096 --import tsx src/index.ts >> `"$Log`" 2>&1"
        } finally { Pop-Location }
        Say "agents exited ($LASTEXITCODE); restarting in 10 s"
        Start-Sleep -Seconds 10
    }
} finally {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
        Where-Object { $_.CommandLine -match '25580:127\.0\.0\.1:25580' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
}
