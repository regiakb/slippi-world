#!/usr/bin/env bash
# Build SlippiWorld.app bundles for macOS (arm64 + x64) and zip them.
# Runs on Linux, macOS, or CI — no hdiutil required. For a .dmg on Apple
# hardware, use package-macos-dmg.sh instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_NAME="SlippiWorld"

mkdir -p "$DIST_DIR"

INFO_PLIST="$DIST_DIR/macos-Info.plist.tmp"
cat > "$INFO_PLIST" <<'EOF'
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

make_zip() {
  local slug=$1
  local bun_target=$2
  local bin_path=$3
  local stage="$DIST_DIR/macos-stage-$slug"
  local zip_path="$DIST_DIR/SlippiWorld-macos-$slug.zip"

  echo "Building macOS $slug ($bun_target)..."
  bun build --compile "$ROOT_DIR/src/index.ts" --target="$bun_target" --outfile "$bin_path"

  rm -rf "$stage"
  mkdir -p "$stage/$APP_NAME.app/Contents/MacOS" "$stage/$APP_NAME.app/Contents/Resources"
  cp "$bin_path" "$stage/$APP_NAME.app/Contents/MacOS/slippi-world"
  chmod +x "$stage/$APP_NAME.app/Contents/MacOS/slippi-world"
  mkdir -p "$stage/$APP_NAME.app/Contents/MacOS/frontend"
  cp -r "$ROOT_DIR/frontend/assets" "$stage/$APP_NAME.app/Contents/MacOS/frontend/assets"
  cp "$ROOT_DIR/frontend/assets/logo-horizontal.png" "$stage/$APP_NAME.app/Contents/Resources/icon.png"
  cp "$INFO_PLIST" "$stage/$APP_NAME.app/Contents/Info.plist"

  rm -f "$zip_path"
  (cd "$stage" && 7z a -tzip "$zip_path" "$APP_NAME.app" >/dev/null)
  echo "Done: $zip_path"
}

make_zip arm64 bun-darwin-arm64 "$DIST_DIR/slippi-world-macos-arm64"
make_zip x64 bun-darwin-x64 "$DIST_DIR/slippi-world-macos-x64"

rm -f "$INFO_PLIST"
