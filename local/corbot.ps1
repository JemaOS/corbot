#Requires -Version 5.1
<#
Run Corbot on Windows: the bots work in a WSL 2 distribution of their own (Ubuntu 24.04), the same
way they work in an LXD container on Linux. Needs Windows 10 21H2 or newer, or Windows 11, with WSL 2.

  local\corbot up        create the distribution and set it up (screens, Chrome, Node, Hermes), then deploy
  local\corbot deploy    build the app and install or upgrade it in the distribution
  local\corbot model     choose the model the main bot runs on (Hermes' own setup)
  local\corbot status    what is running
  local\corbot logs      follow the app's and the main agent's logs
  local\corbot shell     a root shell in the distribution
  local\corbot stop | start
  local\corbot destroy   delete the distribution and everything the bots made

Settings (environment): CORBOT_NAME (corbot), CORBOT_PORT (8787), CORBOT_SCREENS (4), CORBOT_SCREEN_SIZE (1440x900),
CORBOT_IMAGE (an Ubuntu 24.04 WSL rootfs: a URL or a local .tar.gz). On first deploy also XAI_API_KEY,
COMPOSIO_API_KEY, ALLOWED_EMAILS, and KILOCODE_API_KEY with CORBOT_PROVIDER and CORBOT_MODEL.
#>
param(
  [Parameter(Position = 0)][string]$Command = ''
)
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'   # wsl.exe answers in UTF-8, not UTF-16

function Setting([string]$name, [string]$default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($v)) { return $default }
  return $v
}

$Name    = Setting 'CORBOT_NAME' 'corbot'
$Port    = Setting 'CORBOT_PORT' '8787'
$Screens = Setting 'CORBOT_SCREENS' '4'
$Size    = Setting 'CORBOT_SCREEN_SIZE' '1440x900'
$Image   = Setting 'CORBOT_IMAGE' 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
$Home_   = Join-Path $env:LOCALAPPDATA "Corbot\$Name"
$Helper  = '/root/corbot-wsl.sh'
$BoxPath = 'PATH=/root/.local/bin:/opt/corbot/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

# Run a command in the distribution, as root, without a shell in between. Stops on failure.
function Box {
  & wsl.exe -d $Name -u root --exec @args
  if ($LASTEXITCODE -ne 0) { throw "the command failed in the '$Name' distribution: $($args -join ' ')" }
}

function Test-Wsl {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is not installed. In an administrator PowerShell run:  wsl --install --no-distribution   then restart Windows.'
  }
  & wsl.exe --status | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'WSL 2 is not set up. In an administrator PowerShell run:  wsl --install --no-distribution   then restart Windows.'
  }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Corbot needs a 64-bit Intel/AMD PC: Chrome for Linux is not available for ARM.' }
  if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "CORBOT_NAME '$Name' may only contain letters, digits, dot, dash and underscore." }
}

function Test-Exists {
  $lines = & wsl.exe -l -q
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($l in $lines) {
    if ((("$l") -replace "`0", '').Trim() -eq $Name) { return $true }
  }
  return $false
}

function Assert-Exists {
  if (-not (Test-Exists)) { throw "There is no '$Name' distribution yet. Create it with:  local\corbot up" }
}

# This checkout, as the distribution sees it: C:\src\corbot -> /mnt/c/src/corbot
function Get-Source {
  $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  if ($root -notmatch '^([A-Za-z]):\\?(.*)$') {
    throw "Corbot must be on a local drive (C:\...), not at $root. Inside WSL or Linux, use local/corbot."
  }
  $rest = ($Matches[2] -replace '\\', '/').Trim('/')
  $src = '/mnt/' + $Matches[1].ToLower()
  if ($rest) { $src = "$src/$rest" }
  return $src
}

function New-Distro {
  New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
  $tar = $Image
  $downloaded = $false
  if (-not (Test-Path -LiteralPath $Image)) {
    $tar = Join-Path $env:TEMP 'corbot-rootfs.tar.gz'
    Write-Host '== downloading Ubuntu 24.04 (about 350 MB)'
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      & curl.exe -fL --retry 3 -o $tar $Image
      if ($LASTEXITCODE -ne 0) { throw "could not download $Image" }
    } else {
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -UseBasicParsing -Uri $Image -OutFile $tar
    }
    $downloaded = $true
  }
  Write-Host "== creating the '$Name' distribution"
  & wsl.exe --import $Name $Home_ $tar --version 2
  if ($LASTEXITCODE -ne 0) { throw 'wsl --import failed' }
  if ($downloaded) { Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue }
}

function Push-Helper([string]$src) {
  & wsl.exe -d $Name -u root --exec test -f "$src/local/wsl.sh"
  if ($LASTEXITCODE -ne 0) {
    throw "The distribution cannot see this folder at $src. Windows drives must be mounted in WSL (the default)."
  }
  Box install -m 755 "$src/local/wsl.sh" $Helper
  Box sed -i 's/\r$//' $Helper
}

# systemd runs the screens, the agent and the app. It is switched on in /etc/wsl.conf, which WSL
# reads when the distribution starts.
function Start-Systemd {
  & wsl.exe -d $Name -u root --exec test -d /run/systemd/system
  if ($LASTEXITCODE -ne 0) {
    Box bash $Helper init
    & wsl.exe --terminate $Name | Out-Null
  }
  Box bash $Helper wait
}

# WSL stops a distribution nobody is attached to, services or not: keep one hidden process attached.
function Start-KeepAlive {
  & wsl.exe -d $Name -u root --exec pgrep -f '^corbot-keepalive' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Start-Process -FilePath wsl.exe -WindowStyle Hidden -ArgumentList @('-d', $Name, '-u', 'root', '--exec', 'bash', $Helper, 'keepalive')
  }
}

function Invoke-Provision {
  $src = Get-Source
  if (-not (Test-Exists)) { New-Distro }
  Push-Helper $src
  Start-Systemd
  Box env "CORBOT_SCREENS=$Screens" "CORBOT_SCREEN_SIZE=$Size" bash $Helper provision $src
}

function Invoke-Deploy {
  Assert-Exists
  $src = Get-Source
  Push-Helper $src
  Start-Systemd
  $vars = @(
    "PORT=$Port",
    "MAX_BOTS=$Screens",
    "XAI_API_KEY=$(Setting 'XAI_API_KEY' '')",
    "COMPOSIO_API_KEY=$(Setting 'COMPOSIO_API_KEY' '')",
    "ALLOWED_EMAILS=$(Setting 'ALLOWED_EMAILS' '')",
    "KILOCODE_API_KEY=$(Setting 'KILOCODE_API_KEY' '')",
    "CORBOT_MODEL=$(Setting 'CORBOT_MODEL' '')",
    "CORBOT_PROVIDER=$(Setting 'CORBOT_PROVIDER' '')"
  )
  Box env @vars bash $Helper deploy $src
  Start-KeepAlive
  Write-Host "open http://localhost:$Port"
}

function Show-Help {
  $text = Get-Content -LiteralPath $PSCommandPath
  $from = [Array]::IndexOf($text, '<#') + 1
  $to = [Array]::IndexOf($text, '#>') - 1
  $text[$from..$to] | ForEach-Object { Write-Host $_ }
}

try {
  switch ($Command) {
    'up' { Test-Wsl; Invoke-Provision; Invoke-Deploy }
    'deploy' { Test-Wsl; Invoke-Deploy }
    'model' {
      Test-Wsl; Assert-Exists; Start-Systemd
      Box env HOME=/root $BoxPath hermes model
      Box systemctl restart corbot-hermes
      Start-KeepAlive
    }
    'status' {
      Test-Wsl; Assert-Exists
      & wsl.exe -l -v
      Box env "SCREENS=$Screens" "PORT=$Port" bash $Helper status
      Start-KeepAlive
    }
    'logs' { Test-Wsl; Assert-Exists; & wsl.exe -d $Name -u root --exec bash $Helper logs }
    'shell' { Test-Wsl; Assert-Exists; & wsl.exe -d $Name -u root --cd /root --exec env HOME=/root $BoxPath bash -l }
    'stop' { Test-Wsl; Assert-Exists; & wsl.exe --terminate $Name }
    'start' {
      Test-Wsl; Assert-Exists; Start-Systemd; Start-KeepAlive
      Write-Host "open http://localhost:$Port"
    }
    'destroy' {
      Test-Wsl
      if (Test-Exists) { & wsl.exe --unregister $Name }
      Remove-Item -LiteralPath $Home_ -Recurse -Force -ErrorAction SilentlyContinue
    }
    default { Show-Help; exit 2 }
  }
} catch {
  Write-Host "corbot: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
