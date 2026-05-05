#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_NAME="SlippiWorld"
APP_DIR="$DIST_DIR/${APP_NAME}.AppDir"
APPIMAGE_TOOL="$DIST_DIR/tools/appimagetool.AppImage"
BIN_PATH="$DIST_DIR/slippi-world-linux-x64"

mkdir -p "$DIST_DIR/tools"

echo "Building Linux binary..."
bun build --compile "$ROOT_DIR/src/index.ts" --target=bun-linux-x64 --outfile "$BIN_PATH"

echo "Preparing AppDir..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/usr/bin" "$APP_DIR/usr/share/applications" "$APP_DIR/usr/share/icons/hicolor/256x256/apps"
cp "$BIN_PATH" "$APP_DIR/usr/bin/slippi-world"
chmod +x "$APP_DIR/usr/bin/slippi-world"
cp "$ROOT_DIR/scripts/slippi-tray-launcher.sh" "$APP_DIR/usr/bin/slippi-world-launcher"
chmod +x "$APP_DIR/usr/bin/slippi-world-launcher"
mkdir -p "$APP_DIR/frontend"
cp -r "$ROOT_DIR/frontend/assets" "$APP_DIR/frontend/assets"

cat > "$APP_DIR/usr/share/applications/slippi-world.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Slippi World
Comment=Local Slippi replay analytics dashboard
Exec=slippi-world
Icon=slippi-world
Terminal=false
Categories=Game;Utility;
EOF

cp "$ROOT_DIR/frontend/assets/tray-icon.png" "$APP_DIR/usr/share/icons/hicolor/256x256/apps/slippi-world.png"
cp "$APP_DIR/usr/share/applications/slippi-world.desktop" "$APP_DIR/slippi-world.desktop"
cp "$APP_DIR/usr/share/icons/hicolor/256x256/apps/slippi-world.png" "$APP_DIR/slippi-world.png"
cat > "$APP_DIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/slippi-world-launcher" "$@"
EOF
chmod +x "$APP_DIR/AppRun"

if [ ! -f "$APPIMAGE_TOOL" ]; then
  echo "Downloading appimagetool..."
  curl -L "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" -o "$APPIMAGE_TOOL"
  chmod +x "$APPIMAGE_TOOL"
fi

echo "Building AppImage..."
unset DISPLAY
ARCH=x86_64 "$APPIMAGE_TOOL" --appimage-extract-and-run "$APP_DIR" "$DIST_DIR/SlippiWorld-linux-x64.AppImage"
chmod +x "$DIST_DIR/SlippiWorld-linux-x64.AppImage"

echo "Done: $DIST_DIR/SlippiWorld-linux-x64.AppImage"
