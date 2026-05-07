param(
  [int]$Port = 7474
)

$ErrorActionPreference = "Stop"
$earlyLog = Join-Path $env:LOCALAPPDATA "SlippiWorld\launcher-debug.log"
$psLog = $env:SLIPPI_PS_LOG_PATH
if ([string]::IsNullOrWhiteSpace($psLog)) {
  $psLog = Join-Path $env:LOCALAPPDATA "SlippiWorld\powershell-spawn.log"
}
function Write-PSLog([string]$Message) {
  try {
    $pDir = Split-Path -Parent $psLog
    if (-not (Test-Path $pDir)) { New-Item -ItemType Directory -Path $pDir -Force | Out-Null }
    Add-Content -Path $psLog -Value ("[{0}] [powershell] {1}" -f (Get-Date).ToString("o"), $Message)
  } catch {}
}
Write-PSLog "PS script entry"
trap {
  $msg = $_.Exception.Message
  Write-PSLog ("FATAL: " + $msg)
  try { Write-Host ("[SlippiWorld tray] ERROR: " + $msg) -ForegroundColor Red } catch {}
  try { Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed } catch {}
  throw
}
try {
  $earlyDir = Split-Path -Parent $earlyLog
  if (-not (Test-Path $earlyDir)) { New-Item -ItemType Directory -Path $earlyDir -Force | Out-Null }
  Add-Content -Path $earlyLog -Value ("[{0}] [tray] PS script entry" -f (Get-Date).ToString("o"))
} catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Write-PSLog "Add-Type OK"
try { Add-Content -Path $earlyLog -Value ("[{0}] [tray] Add-Type OK" -f (Get-Date).ToString("o")) } catch {}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerExe = Join-Path $ScriptDir "slippi-world-windows-x64.exe"
$AssetsDir = Join-Path $ScriptDir "assets"
$IconIco = Join-Path $AssetsDir "tray-icon.ico"
$AppUrl = "http://localhost:$Port"
$LauncherCmd = Join-Path $ScriptDir "SlippiWorld.cmd"

$LogPath = $env:SLIPPI_LOG_PATH
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $env:LOCALAPPDATA "SlippiWorld\launcher-debug.log"
}
$LogDir = Split-Path -Parent $LogPath
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
function Write-DebugLog([string]$Message) {
  try {
    Add-Content -Path $LogPath -Value ("[{0}] [tray] {1}" -f (Get-Date).ToString("o"), $Message)
  } catch {}
}
Write-DebugLog "Tray launcher boot. ScriptDir=$ScriptDir Port=$Port"
Write-PSLog "Tray launcher boot"
Write-DebugLog "ServerExe=$ServerExe"
Write-DebugLog "AssetsDir=$AssetsDir"
Write-DebugLog "IconIco=$IconIco"

if (-not (Test-Path $ServerExe)) {
  Write-DebugLog "ERROR Missing server executable"
  [System.Windows.Forms.MessageBox]::Show("Missing server executable: $ServerExe", "Slippi World")
  exit 1
}

$env:NO_OPEN_BROWSER = "1"
$env:STATIC_ASSETS_DIR = $AssetsDir
$env:AUTO_START_COMMAND = $LauncherCmd

$server = Start-Process -FilePath $ServerExe -PassThru -WindowStyle Hidden
Write-DebugLog ("Server started. PID={0}" -f $server.Id)
Start-Sleep -Milliseconds 900
# When launched from the Startup folder shortcut, SLIPPI_AUTOSTART=1 is set so
# the app starts minimized to the system tray without popping the browser open.
if ($env:SLIPPI_AUTOSTART -eq "1") {
  Write-DebugLog "Autostart mode: skipping browser open"
} else {
  Start-Process $AppUrl | Out-Null
  Write-DebugLog ("Browser open attempted: {0}" -f $AppUrl)
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Slippi World"
$notify.Visible = $true
Write-DebugLog "NotifyIcon created and visible=true"
if (Test-Path $IconIco) {
  $notify.Icon = New-Object System.Drawing.Icon($IconIco)
  Write-DebugLog "Tray icon loaded from .ico"
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
  Write-DebugLog "Tray icon fallback to system icon"
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add("Open Slippi World")
$itemQuit = $menu.Items.Add("Quit")
$notify.ContextMenuStrip = $menu
Write-DebugLog "Context menu assigned"

$itemOpen.Add_Click({
  Write-DebugLog "Tray action: Open"
  Start-Process $AppUrl | Out-Null
}) | Out-Null

$stopServer = {
  Write-DebugLog "Stop requested"
  try {
    Invoke-WebRequest -Uri "$AppUrl/api/system/stop" -Method Post -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-DebugLog "Stop API call OK"
  } catch {}
  Start-Sleep -Milliseconds 200
  try {
    if (-not $server.HasExited) {
      $server.Kill()
      Write-DebugLog "Killed server process"
    }
  } catch {}
}

$itemQuit.Add_Click({
  Write-DebugLog "Tray action: Quit"
  & $stopServer
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}) | Out-Null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  try {
    if ($server.HasExited) {
      Write-DebugLog "Server exited. Closing tray loop."
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  } catch {}
}) | Out-Null
$timer.Start()
Write-DebugLog "Timer started"

[System.Windows.Forms.Application]::Run()

& $stopServer
$notify.Dispose()
Write-DebugLog "Tray launcher end"
