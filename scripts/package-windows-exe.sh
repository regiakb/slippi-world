#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
BIN_PATH="$DIST_DIR/slippi-world-windows-x64.exe"
PKG_DIR="$DIST_DIR/SlippiWorld-windows-x64"
INSTALLER_BUILD_DIR="$DIST_DIR/windows-installer-build"
SFX_CONFIG="$DIST_DIR/windows-sfx-config.txt"
SFX_ARCHIVE="$DIST_DIR/windows-installer-payload.7z"
SETUP_EXE="$DIST_DIR/SlippiWorld-Setup.exe"
WIN_SFX_STUB="$DIST_DIR/tools/lzma-sdk/bin/7zSD.sfx"

mkdir -p "$DIST_DIR"
mkdir -p "$DIST_DIR/tools"
bun build --compile "$ROOT_DIR/src/index.ts" --target=bun-windows-x64 --outfile "$BIN_PATH"

if [ ! -f "$WIN_SFX_STUB" ]; then
  curl -L "https://www.7-zip.org/a/lzma2501.7z" -o "$DIST_DIR/tools/lzma-sdk.7z"
  7z x -y "$DIST_DIR/tools/lzma-sdk.7z" -o"$DIST_DIR/tools/lzma-sdk" >/dev/null
fi

# Windows portable bundle with tray launcher + assets
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"
cp "$BIN_PATH" "$PKG_DIR/slippi-world-windows-x64.exe"
cp "$ROOT_DIR/scripts/windows-tray-launcher.ps1" "$PKG_DIR/windows-tray-launcher.ps1"
cat > "$PKG_DIR/SlippiWorld.cmd" <<'EOF'
@echo off
setlocal
set SCRIPT_DIR=%~dp0
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%windows-tray-launcher.ps1"
exit /b 0
EOF
cp -r "$ROOT_DIR/frontend/assets" "$PKG_DIR/assets"

# Build ICO from PNG for Windows tray icon
python3 - "$PKG_DIR/assets/tray-icon.png" "$PKG_DIR/assets/tray-icon.ico" <<'PY'
from PIL import Image
import sys
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
img.save(dst, format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY

# Portable package for sharing
7z a -tzip "$DIST_DIR/SlippiWorld-windows-x64.zip" "$PKG_DIR" >/dev/null

# Build Windows installer .exe (7z SFX)
rm -rf "$INSTALLER_BUILD_DIR"
mkdir -p "$INSTALLER_BUILD_DIR/app"
cp -r "$PKG_DIR/." "$INSTALLER_BUILD_DIR/app/"
cat > "$INSTALLER_BUILD_DIR/install.bat" <<'EOF'
@echo off
setlocal
set SRC=%~dp0app
set TARGET=%LocalAppData%\SlippiWorld
if not exist "%TARGET%" mkdir "%TARGET%"
xcopy "%SRC%\*" "%TARGET%\" /E /I /Y >nul

REM Enable script execution for current user (no admin needed)
reg add "HKCU\Software\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell" /v ExecutionPolicy /t REG_SZ /d Bypass /f >nul 2>&1
reg add "HKCU\Software\Microsoft\PowerShellCore\ShellIds\Microsoft.PowerShell" /v ExecutionPolicy /t REG_SZ /d Bypass /f >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

start "" "%TARGET%\SlippiWorld.cmd"
exit /b 0
EOF

cat > "$INSTALLER_BUILD_DIR/install.ps1" <<'EOF'
$W = New-Object -ComObject WScript.Shell
$desktopDir = [Environment]::GetFolderPath("Desktop")
$startMenuPrograms = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
$target = Join-Path $env:LOCALAPPDATA "SlippiWorld\SlippiWorld.cmd"
$icon = Join-Path $env:LOCALAPPDATA "SlippiWorld\assets\tray-icon.ico"
$workDir = Join-Path $env:LOCALAPPDATA "SlippiWorld"

$desktopShortcutPath = Join-Path $desktopDir "Slippi World.lnk"
$desktopShortcut = $W.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $target
$desktopShortcut.IconLocation = $icon
$desktopShortcut.WorkingDirectory = $workDir
$desktopShortcut.Save()

$menuShortcutPath = Join-Path $startMenuPrograms "Slippi World.lnk"
$menuShortcut = $W.CreateShortcut($menuShortcutPath)
$menuShortcut.TargetPath = $target
$menuShortcut.IconLocation = $icon
$menuShortcut.WorkingDirectory = $workDir
$menuShortcut.Save()
EOF

7z a -t7z "$SFX_ARCHIVE" "$INSTALLER_BUILD_DIR/." >/dev/null
cat > "$SFX_CONFIG" <<'EOF'
;!@Install@!UTF-8!
Title="Slippi World Setup"
BeginPrompt="Install Slippi World?"
RunProgram="install.bat"
;!@InstallEnd@!
EOF
cat "$WIN_SFX_STUB" "$SFX_CONFIG" "$SFX_ARCHIVE" > "$SETUP_EXE"
chmod +x "$SETUP_EXE"

echo "Done: $BIN_PATH"
echo "Done: $DIST_DIR/SlippiWorld-windows-x64.zip"
echo "Done: $SETUP_EXE"
