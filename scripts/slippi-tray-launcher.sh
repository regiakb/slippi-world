#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_BIN="$HERE/slippi-world"
APPDIR="$(cd "$HERE/../.." && pwd)"
ICON_PATH="$APPDIR/slippi-world.png"
STATIC_ASSETS_DIR="$APPDIR/frontend/assets"
PORT="${PORT:-7474}"
APP_URL="http://localhost:${PORT}"
TRAY_TITLE="Slippi World"

open_url() {
  (xdg-open "$APP_URL" >/dev/null 2>&1 || gio open "$APP_URL" >/dev/null 2>&1 || sensible-browser "$APP_URL" >/dev/null 2>&1 || true) &
}

stop_server() {
  curl -fsS -X POST "$APP_URL/api/system/stop" >/dev/null 2>&1 || true
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

NO_OPEN_BROWSER=1 STATIC_ASSETS_DIR="$STATIC_ASSETS_DIR" "$SERVER_BIN" &
SERVER_PID=$!

# When launched from the desktop autostart entry, SLIPPI_AUTOSTART=1 is set
# so the app starts minimized in the tray and does not open a browser window.
if [ "${SLIPPI_AUTOSTART:-0}" != "1" ]; then
  open_url
fi

cleanup() {
  stop_server
}
trap cleanup EXIT INT TERM

# Preferred path: real tray icon via AppIndicator (like Discord/Telegram).
if python3 - <<'PY' >/dev/null 2>&1
import gi
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3  # noqa: F401
except Exception:
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3  # noqa: F401
PY
then
  python3 - "$APP_URL" "$SERVER_PID" "$ICON_PATH" 2>/dev/null <<'PY'
import os
import signal
import subprocess
import sys
import urllib.request
import gi

try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator3, Gtk, GLib
except Exception:
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3, Gtk, GLib

app_url = sys.argv[1]
server_pid = int(sys.argv[2])
icon_path = sys.argv[3]

def open_app(_item=None):
    candidates = [
        ["xdg-open", app_url],
        ["gio", "open", app_url],
        ["sensible-browser", app_url],
    ]
    for cmd in candidates:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            pass

def stop_server():
    try:
        req = urllib.request.Request(f"{app_url}/api/system/stop", data=b"", method="POST")
        urllib.request.urlopen(req, timeout=1.2).read()
    except Exception:
        pass
    try:
        os.kill(server_pid, signal.SIGTERM)
    except Exception:
        pass

def quit_app(_item=None):
    stop_server()
    Gtk.main_quit()

def monitor_server():
    try:
        os.kill(server_pid, 0)
        return True
    except Exception:
        Gtk.main_quit()
        return False

indicator = AppIndicator3.Indicator.new(
    "slippi-world-indicator",
    icon_path if os.path.exists(icon_path) else "applications-games",
    AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
)
indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
indicator.set_title("Slippi World")

menu = Gtk.Menu()
item_open = Gtk.MenuItem(label="Open Slippi World")
item_open.connect("activate", open_app)
menu.append(item_open)

item_quit = Gtk.MenuItem(label="Quit")
item_quit.connect("activate", quit_app)
menu.append(item_quit)

menu.show_all()
indicator.set_menu(menu)

GLib.timeout_add_seconds(1, monitor_server)
Gtk.main()
PY
else
  # Fallback for systems without AppIndicator bindings
  if ! command -v zenity >/dev/null 2>&1; then
    wait "$SERVER_PID"
    exit $?
  fi
  coproc TRAY_PROC { zenity --notification --listen --icon-name="applications-games" --text="$TRAY_TITLE running on :$PORT"; }
  TRAY_PID=$!
  while kill -0 "$SERVER_PID" >/dev/null 2>&1; do
    if ! IFS= read -r event <&"${TRAY_PROC[0]}"; then
      sleep 0.2
      continue
    fi
    if [[ "$event" == "clicked" ]]; then
      action="$(zenity --list --title="$TRAY_TITLE" --column="Action" "Open app" "Stop and exit" --height=200 --width=280 2>/dev/null || true)"
      case "$action" in
        "Open app")
          open_url
          ;;
        "Stop and exit")
          stop_server
          break
          ;;
        *)
          ;;
      esac
    fi
  done
  if kill -0 "$TRAY_PID" >/dev/null 2>&1; then
    kill "$TRAY_PID" >/dev/null 2>&1 || true
  fi
fi

wait "$SERVER_PID" 2>/dev/null || true
