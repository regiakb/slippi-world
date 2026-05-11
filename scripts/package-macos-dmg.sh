#!/usr/bin/env bash
# Builds a .dmg on macOS only. For arm64/x64 .app zips from Linux or CI, use package-macos-zip.sh.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must be run on macOS (hdiutil required). Use ./scripts/package-macos-zip.sh for cross-builds." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/dmg-stage"
APP_NAME="SlippiWorld"

mkdir -p "$DIST_DIR"

if [[ "$(uname -m)" == "arm64" ]]; then
  BIN_PATH="$DIST_DIR/slippi-world-macos-arm64"
  bun build --compile "$ROOT_DIR/src/index.ts" --target=bun-darwin-arm64 --outfile "$BIN_PATH"
else
  BIN_PATH="$DIST_DIR/slippi-world-macos-x64"
  bun build --compile "$ROOT_DIR/src/index.ts" --target=bun-darwin-x64 --outfile "$BIN_PATH"
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/$APP_NAME.app/Contents/MacOS" "$STAGE_DIR/$APP_NAME.app/Contents/Resources"
cp "$BIN_PATH" "$STAGE_DIR/$APP_NAME.app/Contents/MacOS/slippi-world"
chmod +x "$STAGE_DIR/$APP_NAME.app/Contents/MacOS/slippi-world"
mkdir -p "$STAGE_DIR/$APP_NAME.app/Contents/MacOS/frontend"
cp -r "$ROOT_DIR/frontend/assets" "$STAGE_DIR/$APP_NAME.app/Contents/MacOS/frontend/assets"
cp "$ROOT_DIR/frontend/assets/logo-horizontal.png" "$STAGE_DIR/$APP_NAME.app/Contents/Resources/icon.png"

cat > "$STAGE_DIR/$APP_NAME.app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SlippiWorld</string>
  <key>CFBundleDisplayName</key><string>Slippi World</string>
  <key>CFBundleIdentifier</key><string>world.slippi.app</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>slippi-world</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
EOF

DMG_PATH="$DIST_DIR/SlippiWorld-macos.dmg"
rm -f "$DMG_PATH"
hdiutil create -volname "SlippiWorld" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"

echo "Done: $DMG_PATH"
