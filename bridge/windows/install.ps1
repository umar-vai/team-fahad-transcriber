# Installs (or updates) Team Fahad Bridge for the current Windows user. No administrator rights needed.
#   - copies the program to %LOCALAPPDATA%\TeamFahadBridge\app
#   - starts it at every sign-in (Startup folder, hidden) and right now
#   - puts a "Team Fahad Bridge" shortcut on the desktop that opens the setup page
# Settings and progress live in %APPDATA%\TeamFahadBridge and are never touched by an update.
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$source  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root    = Join-Path $env:LOCALAPPDATA "TeamFahadBridge"
$app     = Join-Path $root "app"
$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Team Fahad Bridge.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "Team Fahad Bridge.lnk"
$launcher = Join-Path $root "start-bridge.vbs"

function Stop-Bridge {
  # Stop a running bridge (and its supervisor) so files can be replaced.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.ExecutablePath -like "$root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

Stop-Bridge

if ($Uninstall) {
  Remove-Item $startup, $desktop -Force -ErrorAction SilentlyContinue
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Team Fahad Bridge was removed. Its settings are still in $env:APPDATA\TeamFahadBridge."
  exit 0
}

New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($item in @("node.exe", "package.json", "src", "ffmpeg")) {
  $from = Join-Path $source $item
  if (-not (Test-Path $from)) { throw "$item is missing from this folder. Extract the whole zip first." }
  $to = Join-Path $app $item
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
}

# Hidden launcher (no black window).
$node  = Join-Path $app "node.exe"
$entry = Join-Path $app "src\index.js"
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$app"
shell.Run """$node"" ""$entry""", 0, False
"@ | Set-Content -Path $launcher -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($startup)
$link.TargetPath = "wscript.exe"
$link.Arguments = "`"$launcher`""
$link.WorkingDirectory = $root
$link.Save()

# The desktop shortcut opens the local setup and status page.
$page = $shell.CreateShortcut($desktop)
$page.TargetPath = "http://127.0.0.1:47821"
$page.IconLocation = "shell32.dll,13"
$page.Save()

Start-Process wscript.exe -ArgumentList "`"$launcher`"" -WindowStyle Hidden
Start-Sleep -Seconds 3
Start-Process "http://127.0.0.1:47821"
Write-Host ""
Write-Host "Team Fahad Bridge is installed and running."
Write-Host "In the browser page that just opened: enter the pairing code, then choose the folder."
