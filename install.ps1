#Requires -Version 5.1
<#
Install Corbot on Windows in one step, on a PC that has nothing yet: double-click install.cmd.

Without downloading anything first, in PowerShell:

  irm https://raw.githubusercontent.com/JemaOS/corbot/main/install.ps1 -OutFile $env:TEMP\corbot-install.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\corbot-install.ps1

What it does:
  1. checks the PC (Windows 10 21H2 or newer, 64-bit Intel/AMD, free disk, free port)
  2. switches WSL 2 on if it is not there yet. Windows asks for permission once, and the PC has to
     restart; the installer carries on by itself after you sign in again
  3. creates the bots' own Ubuntu, builds the app inside it and starts it (local\corbot up)
  4. adds Corbot to the Start menu and the desktop, starts it with Windows, and opens it

Nothing else is needed on the PC: no Node.js, no Git, no Docker. Safe to run again: it then upgrades
the app and keeps your bots and their data.

Settings (environment): the ones of local\corbot.ps1 (CORBOT_NAME, CORBOT_PORT, CORBOT_SCREENS,
XAI_API_KEY, COMPOSIO_API_KEY, ...), plus CORBOT_DIR (where to put the source when this script is
run on its own, default %USERPROFILE%\corbot) and CORBOT_SOURCE (the source .zip to download).
#>
param(
  [switch]$Resume,      # run again by Windows after the restart that switching WSL on needs
  [switch]$EnableWsl    # the part that needs administrator rights; started by this script itself
)
$ErrorActionPreference = 'Stop'
$env:WSL_UTF8 = '1'

function Setting([string]$name, [string]$default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($v)) { return $default }
  return $v
}
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

$Name   = Setting 'CORBOT_NAME' 'corbot'
$Port   = Setting 'CORBOT_PORT' '8787'
$Source = Setting 'CORBOT_SOURCE' 'https://github.com/JemaOS/corbot/archive/refs/heads/main.zip'
$RunOnce = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'

# ---------- the part that runs as administrator: switch WSL 2 on ----------
if ($EnableWsl) {
  try {
    Write-Host 'Switching on the Windows Subsystem for Linux (WSL 2)...'
    $ok = $false
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
      & wsl.exe --install --no-distribution
      $ok = ($LASTEXITCODE -eq 0)
    }
    if (-not $ok) {
      # An older wsl.exe does not know --no-distribution: switch the two Windows features on directly.
      foreach ($feature in 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') {
        & dism.exe /online /enable-feature "/featurename:$feature" /all /norestart
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "Windows could not switch on $feature (dism exit $LASTEXITCODE)." }
      }
    }
    exit 0
  } catch {
    Write-Host "corbot: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
  }
}

function Test-WslReady {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $false }
  # Without WSL, wsl.exe is only a stub that may wait for a key press: do not call it then.
  if (-not (Get-Service -Name WslService, LxssManager -ErrorAction SilentlyContinue)) { return $false }
  & wsl.exe --status *> $null
  return ($LASTEXITCODE -eq 0)
}

function Test-PortBusy([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $client.Close() }
}

function Test-CorbotAnswers {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/api/health"
    return ($r.Content -match '"ok"')
  } catch { return $false }
}

# A shortcut that runs local\corbot.cmd with one command, without leaving a window open.
function New-CorbotShortcut([string]$path, [string]$root, [string]$command, [string]$description) {
  $set = ''
  if ($Name -ne 'corbot') { $set += "set CORBOT_NAME=$Name&& " }
  if ($Port -ne '8787') { $set += "set CORBOT_PORT=$Port&& " }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $env:ComSpec
  $link.Arguments = "/c `"$set`"$root\local\corbot.cmd`" $command`""
  $link.WorkingDirectory = $root
  $link.IconLocation = "$root\assets\icon.ico"
  $link.Description = $description
  $link.WindowStyle = 7   # minimized
  $link.Save()
}

try {
  # ---------- 1. can this PC run it? ----------
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') {
    throw 'Corbot needs a 64-bit Intel/AMD PC: Chrome for Linux is not available for other processors.'
  }
  $build = [Environment]::OSVersion.Version.Build
  if ($build -lt 19044) { throw "Corbot needs Windows 10 21H2 or newer, or Windows 11 (this is build $build). Update Windows, then run this again." }
  if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "CORBOT_NAME '$Name' may only contain letters, digits, dot, dash and underscore." }

  # ---------- 2. the source: this folder, or a fresh download when the script runs on its own ----------
  $root = $PSScriptRoot
  if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root 'local\corbot.ps1'))) {
    $root = Setting 'CORBOT_DIR' (Join-Path $env:USERPROFILE 'corbot')
    if (-not (Test-Path -LiteralPath (Join-Path $root 'local\corbot.ps1'))) {
      Step "downloading Corbot to $root"
      $zip = Join-Path $env:TEMP 'corbot-source.zip'
      $tmp = Join-Path $env:TEMP ('corbot-source-' + [Guid]::NewGuid().ToString('N'))
      $ProgressPreference = 'SilentlyContinue'
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $zip
      Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
      if (-not $inner) { throw "the download from $Source holds no folder." }
      New-Item -ItemType Directory -Force -Path $root | Out-Null
      Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $root -Recurse -Force
      Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'install.ps1'))) { throw "$root does not hold a Corbot that has this installer. Move it away and run this again." }
  }
  $root = (Resolve-Path -LiteralPath $root).Path.TrimEnd('\')
  if ($root -notmatch '^[A-Za-z]:\\') { throw "Corbot must be on a local drive (C:\...), not at $root. Copy the folder to your PC and run this again." }
  $installCmd = Join-Path $root 'install.cmd'

  # ---------- 3. room, and a free port ----------
  $drive = Get-PSDrive -Name $env:LOCALAPPDATA.Substring(0, 1) -ErrorAction SilentlyContinue
  if ($drive -and $drive.Free -lt 12GB) {
    Write-Host ("note: only {0:N0} GB free on drive {1}:; a full install takes about 10 GB." -f ($drive.Free / 1GB), $drive.Name) -ForegroundColor Yellow
  }
  if (-not (Test-CorbotAnswers) -and (Test-PortBusy ([int]$Port))) {
    throw "Port $Port is already used by another program. Choose another one: in PowerShell run  `$env:CORBOT_PORT = '8788'  and then  .\install.cmd"
  }

  # ---------- 4. WSL 2 ----------
  if (-not (Test-WslReady)) {
    if ($Resume) {
      # The features are on since the restart; what may still be missing is the Linux kernel.
      Step 'finishing the WSL setup'
      & wsl.exe --update
      & wsl.exe --set-default-version 2 *> $null
      if (-not (Test-WslReady)) {
        throw "WSL 2 still does not start. Most often virtualization is switched off in the PC's BIOS/UEFI (Intel VT-x or AMD-V): switch it on, then run install.cmd again. You can also try, in an administrator PowerShell:  wsl --install --no-distribution"
      }
    } else {
      $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
      $sys = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
      if ($cpu -and $sys -and -not $cpu.VirtualizationFirmwareEnabled -and -not $sys.HypervisorPresent) {
        Write-Host "note: virtualization looks switched off in this PC's BIOS/UEFI (Intel VT-x or AMD-V). WSL 2 needs it; if the install fails after the restart, switch it on there." -ForegroundColor Yellow
      }
      Step 'switching WSL 2 on (Windows will ask for permission)'
      $args_ = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'install.ps1')`" -EnableWsl"
      $p = $null
      try { $p = Start-Process -FilePath powershell.exe -ArgumentList $args_ -Verb RunAs -Wait -PassThru } catch { }
      if (-not $p -or $p.ExitCode -ne 0) { throw 'WSL could not be switched on. Run install.cmd again and accept the Windows permission request.' }
    }
    # On a recent Windows the features may already be on, and WSL then works without a restart.
    if (-not $Resume -and -not (Test-WslReady)) {
      # Carry on by ourselves after the restart.
      New-Item -Path $RunOnce -Force | Out-Null
      Set-ItemProperty -Path $RunOnce -Name 'CorbotInstall' -Value "`"$env:ComSpec`" /c `"`"$installCmd`" -Resume`""
      Write-Host ''
      Write-Host 'Windows has to restart to finish switching WSL on.' -ForegroundColor Yellow
      Write-Host 'After you sign in again, this installer carries on by itself.'
      Read-Host 'Save your work, then press Enter to restart now (or close this window and restart later)'
      Restart-Computer -Force
      exit 0
    }
  }

  # ---------- 5. the bots' computer and the app ----------
  Step 'setting Corbot up (15 to 30 minutes the first time: it downloads Ubuntu, Chrome and Hermes)'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'local\corbot.ps1') up
  if ($LASTEXITCODE -ne 0) { throw 'the setup did not finish. The lines above say why; fix that and run install.cmd again (it carries on where it stopped).' }

  # ---------- 6. ways back in ----------
  $programs = [Environment]::GetFolderPath('Programs')
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startup = [Environment]::GetFolderPath('Startup')
  New-CorbotShortcut (Join-Path $programs 'Corbot.lnk') $root 'open' 'Your team of AI agents, each with its own screen'
  New-CorbotShortcut (Join-Path $desktop 'Corbot.lnk') $root 'open' 'Your team of AI agents, each with its own screen'
  # WSL stops with Windows: bring the bots back when you sign in.
  New-CorbotShortcut (Join-Path $startup 'Corbot (start the bots).lnk') $root 'start' 'Starts the Corbot bots when you sign in'

  if (-not (Setting 'CORBOT_NO_BROWSER' '')) { Start-Process "http://localhost:$Port" }
  Write-Host ''
  Write-Host "Corbot is installed: http://localhost:$Port" -ForegroundColor Green
  Write-Host '  - Sign in with your email address.'
  Write-Host '  - The bots need an AI model before they can answer. In the app, open the main bot''s details'
  Write-Host '    panel, then Engine, and paste an API key or sign in to a subscription.'
  Write-Host '  - To come back later: the Corbot icon on your desktop or in the Start menu.'
  Write-Host "  - To remove everything: $root\local\corbot.cmd destroy  (then delete the Corbot shortcuts)"
  exit 0
} catch {
  Write-Host ''
  Write-Host "corbot: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
