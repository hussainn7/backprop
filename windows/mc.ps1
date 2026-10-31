# Windows control script for the local-only Backprop server (the PC counterpart of ./mc).
#   .\mc.ps1 status | start | stop | restart [server|agents|alpha|bravo] | logs [server|alpha|bravo]
#   .\mc.ps1 console "<cmd>" ...     .\mc.ps1 budget
# Paper listens on 127.0.0.1:25565 only (offline mode, whitelist on); bots join it directly.
# Ten bots run as two squads of five, one Node process each (one thread cannot path-find
# for ten): alpha = Atlas (leader), Flora, Forge, Mason, Blade; Mission Control :3010
#           bravo = Nova (leader), Ivy, Anvil, Brick, Fang;     Mission Control :3011
# Each piece runs as a hidden PowerShell loop that restarts it if it exits.
param([Parameter(Position = 0)][string]$Cmd = 'status', [Parameter(Position = 1, ValueFromRemainingArguments)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$Server = Join-Path $Root 'server'
$Swarm = Join-Path $Root 'agent-swarm'
$Logs = Join-Path $Root 'logs'
$Squads = @{ alpha = 3010; bravo = 3011 } # squad -> Mission Control port
New-Item -ItemType Directory -Force $Logs | Out-Null

function Java {
    $j = Get-ChildItem 'C:\Program Files\Eclipse Adoptium\jdk-21*\bin\java.exe' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if (-not $j) { throw 'Java 21 not found: winget install EclipseAdoptium.Temurin.21.JDK' }
    $j.FullName
}
# Strip Minecraft colour codes (section sign + code), whatever encoding the console decoded it with.
function Rcon([string[]]$cmds) { & node (Join-Path $Swarm 'scripts\rcon.mjs') @cmds 2>$null | ForEach-Object { $_ -replace '[^\u0000-\u007F]+[0-9a-fk-or]', '' } | Where-Object { $_ -notmatch '^>' } }
function Pieces($names) {
    $out = @()
    foreach ($n in $names) { if ($n -eq 'agents') { $out += 'alpha', 'bravo' } else { $out += $n } }
    $out
}
function Loops($piece) {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match "mc\.ps1.*_run-$piece\b" }
}
function Children($piece) {
    $pattern = if ($piece -eq 'server') { 'paper\.jar' } else { "src/index\.ts --squad=$piece" }
    Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern }
}
function PortOpen($port) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); $true } catch { $false } finally { $c.Dispose() }
}
function LogName($piece) { if ($piece -eq 'server') { 'server' } else { "agents-$piece" } }
function Launch($piece) {
    if (Loops $piece) { Write-Host "$piece already running"; return }
    Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, "_run-$piece")
    Write-Host "$piece started (log: logs\$(LogName $piece).log)"
}
function Halt($piece) {
    Loops $piece | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($piece -eq 'server' -and (Children server)) {
        Rcon @('stop') | Out-Null # save the world before exiting
        for ($i = 0; $i -lt 60 -and (Children server); $i++) { Start-Sleep 1 }
    }
    Children $piece | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "$piece stopped"
}
# Best effort: a log viewer holding the file (e.g. tail -F) must never stop the bots.
function Log($piece, $msg) {
    try { Add-Content (Join-Path $Logs "$(LogName $piece).log") "$(Get-Date -Format s) [mc.ps1] $msg" -ErrorAction Stop } catch { }
}
function RunSquad($squad) {
    $env:SQUAD = $squad
    $env:DASHBOARD_PORT = "$($Squads[$squad])"
    $log = Join-Path $Logs "agents-$squad.log"
    while ($true) {
        while (-not (PortOpen 25565)) { Start-Sleep 5 } # wait for Paper
        Log $squad "starting squad $squad"
        Push-Location $Swarm
        # --squad is ignored by the agents; it marks the process so status/stop can find it.
        cmd /c "node --max-old-space-size=4096 --import tsx src/index.ts --squad=$squad >> `"$log`" 2>&1"
        Pop-Location
        Log $squad "squad $squad exited ($LASTEXITCODE); restarting in 10 s"
        Start-Sleep 10
    }
}

switch ($Cmd) {
    '_run-server' {
        $java = Java
        while ($true) {
            Log server 'starting Paper'
            Push-Location $Server
            cmd /c "`"$java`" -Xms4G -Xmx4G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -jar paper.jar --nogui < NUL >> `"$Logs\server.log`" 2>&1"
            Pop-Location
            Log server "Paper exited ($LASTEXITCODE); restarting in 10 s"
            Start-Sleep 10
        }
    }
    '_run-alpha' { RunSquad alpha }
    '_run-bravo' { RunSquad bravo }
    'start' { foreach ($p in 'server', 'alpha', 'bravo') { Launch $p } }
    'stop' { foreach ($p in 'alpha', 'bravo', 'server') { Halt $p } }
    'restart' {
        $pieces = if ($Rest) { Pieces $Rest } else { @('alpha', 'bravo', 'server') }
        foreach ($p in $pieces) { Halt $p }
        foreach ($p in 'server', 'alpha', 'bravo') { if ($pieces -contains $p) { Launch $p } } # server before agents
    }
    'status' {
        foreach ($p in 'server', 'alpha', 'bravo') { '{0,-8} {1}' -f $p, $(if (Children $p) { 'running' } elseif (Loops $p) { 'starting' } else { 'stopped' }) }
        if (PortOpen 25565) { Rcon @('tps', 'list') } else { '(server port closed)' }
    }
    'logs' { $p = if ($Rest) { $Rest[0] } else { 'alpha' }; Get-Content (Join-Path $Logs "$(LogName $p).log") -Tail 80 -Wait }
    'console' { Rcon $Rest }
    'budget' {
        foreach ($s in 'alpha', 'bravo') {
            $f = Join-Path $Swarm $(if ($s -eq 'alpha') { 'logs\api-usage.json' } else { "logs\api-usage-$s.json" })
            if (-not (Test-Path $f)) { "${s}: no API usage recorded yet"; continue }
            $d = Get-Content $f -Raw | ConvertFrom-Json
            '{0}: today {1} ${2:N4} over {3} calls ({4} errors); lifetime ${5:N4} over {6} calls; paused: {7}' -f $s, $d.day, $d.today.costUsd, $d.today.calls, $d.today.errors, $d.lifetime.costUsd, $d.lifetime.calls, $d.pausedReason
        }
    }
    default { Get-Content $PSCommandPath -TotalCount 8 | Select-Object -Skip 1 }
}
