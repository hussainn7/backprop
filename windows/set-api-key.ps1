# Store the Anthropic API key in config\secrets.env (git-ignored, readable by you only)
# without echoing it. Restart the agents afterwards.
$ErrorActionPreference = 'Stop'
$Dir = Join-Path (Split-Path $PSScriptRoot -Parent) 'config'
$File = Join-Path $Dir 'secrets.env'

$secure = Read-Host 'Paste Anthropic API key (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if (-not $key.StartsWith('sk-ant-')) { Write-Host 'That does not look like an Anthropic key (sk-ant-...). Nothing changed.'; exit 1 }

New-Item -ItemType Directory -Force $Dir | Out-Null
$lines = @()
if (Test-Path $File) { $lines = @(Get-Content $File | Where-Object { $_ -notmatch '^ANTHROPIC_API_KEY=' }) }
$lines += "ANTHROPIC_API_KEY=$key"
# UTF-8 without BOM, or dotenv reads the first key name with a BOM in front of it.
[IO.File]::WriteAllText($File, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
icacls $File /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Write-Host "Saved to $File (access: $env:USERNAME only). Restart the agents to use it."
